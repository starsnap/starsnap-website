import type { PoolClient, QueryResultRow } from 'pg';
import { getPool, queryOne, withTransaction } from './postgres';
import { PRODUCT_SEARCH_DIMENSION, PRODUCT_SEARCH_MODEL } from './product-embedding-client';
import { backfillProductSearchEmbeddings } from './product-search';

const MAX_BATCH_SIZE = 128;
const LEASE_MINUTES = 10;
const LEASE_HEARTBEAT_MS = 60_000;
const MAX_ERROR_LENGTH = 1_000;

export interface ProductEmbeddingJobTarget {
  productId: string;
  targetVersion: number;
}

interface ClaimedProductEmbeddingJob extends QueryResultRow {
  tenantId: string;
  productId: string;
  targetVersion: number;
  attemptCount: number;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface QueueStatsRow extends QueryResultRow {
  pending: number;
  processing: number;
  retrying: number;
  failed: number;
  completed: number;
  total: number;
  oldestQueuedAt: string | null;
}

export interface ProductEmbeddingQueueStats {
  pending: number;
  processing: number;
  retrying: number;
  failed: number;
  completed: number;
  total: number;
  outstanding: number;
  oldestQueuedAt: string | null;
}

export interface ProductEmbeddingDrainResult {
  claimed: number;
  vectorized: number;
  completed: number;
  requeued: number;
  retrying: number;
  exhausted: number;
}

function normalizedTargets(targets: readonly ProductEmbeddingJobTarget[]) {
  const versionsByProduct = new Map<string, number>();
  for (const target of targets) {
    if (!target.productId || target.productId.length > 200) {
      throw new Error('상품 벡터화 작업의 상품 ID가 올바르지 않습니다.');
    }
    if (!Number.isInteger(target.targetVersion) || target.targetVersion < 1) {
      throw new Error('상품 벡터화 작업의 상품 버전이 올바르지 않습니다.');
    }
    versionsByProduct.set(
      target.productId,
      Math.max(versionsByProduct.get(target.productId) ?? 0, target.targetVersion),
    );
  }
  return [...versionsByProduct].map(([productId, targetVersion]) => ({ productId, targetVersion }));
}

/**
 * Coalesces product changes into one durable job per tenant/product. This must
 * be called with the same transaction client that mutates the products and
 * commits the idempotency response.
 */
export async function enqueueProductEmbeddingJobs(
  client: PoolClient,
  tenantId: string,
  targets: readonly ProductEmbeddingJobTarget[],
) {
  const normalized = normalizedTargets(targets);
  if (normalized.length === 0) return 0;

  const queued = await queryOne<CountRow>(
    `WITH requested AS (
       SELECT product_id, max(target_version)::integer AS target_version
       FROM jsonb_to_recordset($1::jsonb) AS source(product_id text, target_version integer)
       GROUP BY product_id
     ), current_products AS (
       SELECT product.tenant_id, product.id AS product_id, product.version AS target_version
       FROM requested
       JOIN products AS product
         ON product.tenant_id = $2
        AND product.id = requested.product_id
        AND product.version >= requested.target_version
     ), upserted AS (
       INSERT INTO product_embedding_jobs (
         tenant_id, product_id, target_version, status, attempt_count,
         available_at, lease_owner, lease_token, lease_expires_at,
         last_error, completed_at, created_at, updated_at
       )
       SELECT tenant_id, product_id, target_version, 'PENDING', 0,
         clock_timestamp(), NULL, NULL, NULL, NULL, NULL,
         clock_timestamp(), clock_timestamp()
       FROM current_products
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET
         target_version = GREATEST(product_embedding_jobs.target_version, EXCLUDED.target_version),
         status = CASE
           WHEN EXCLUDED.target_version <= product_embedding_jobs.target_version
             THEN product_embedding_jobs.status
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN 'PROCESSING'
           ELSE 'PENDING'
         END,
         attempt_count = CASE
           WHEN EXCLUDED.target_version <= product_embedding_jobs.target_version
             OR (
               product_embedding_jobs.status = 'PROCESSING'
               AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             ) THEN product_embedding_jobs.attempt_count
           ELSE 0
         END,
         available_at = CASE
           WHEN EXCLUDED.target_version <= product_embedding_jobs.target_version
             OR (
               product_embedding_jobs.status = 'PROCESSING'
               AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             ) THEN product_embedding_jobs.available_at
           ELSE clock_timestamp()
         END,
         lease_owner = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version
             AND NOT (
               product_embedding_jobs.status = 'PROCESSING'
               AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             ) THEN NULL
           ELSE product_embedding_jobs.lease_owner
         END,
         lease_token = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version
             AND NOT (
               product_embedding_jobs.status = 'PROCESSING'
               AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             ) THEN NULL
           ELSE product_embedding_jobs.lease_token
         END,
         lease_expires_at = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version
             AND NOT (
               product_embedding_jobs.status = 'PROCESSING'
               AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             ) THEN NULL
           ELSE product_embedding_jobs.lease_expires_at
         END,
         last_error = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version THEN NULL
           ELSE product_embedding_jobs.last_error
         END,
         completed_at = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version THEN NULL
           ELSE product_embedding_jobs.completed_at
         END,
         updated_at = CASE
           WHEN EXCLUDED.target_version > product_embedding_jobs.target_version
             THEN clock_timestamp()
           ELSE product_embedding_jobs.updated_at
         END
       RETURNING 1
     )
     SELECT count(*)::integer AS count FROM upserted`,
    [JSON.stringify(normalized.map((target) => ({
      product_id: target.productId,
      target_version: target.targetVersion,
    }))), tenantId],
    client,
  );
  return Number(queued?.count ?? 0);
}

/** Enqueues every missing or product-version-stale vector without GPU work. */
export async function enqueueStaleProductEmbeddingJobs(client: PoolClient) {
  const queued = await queryOne<CountRow>(
    `WITH stale_products AS (
       SELECT product.tenant_id, product.id AS product_id, product.version AS target_version
       FROM products AS product
       LEFT JOIN erp_embeddings AS embedding
         ON embedding.tenant_id = product.tenant_id
        AND embedding.entity_type = 'product'
        AND embedding.entity_id = product.id
        AND embedding.model = $1
        AND embedding.dimension = $2
        AND embedding.metadata ->> 'productVersion' = product.version::text
       WHERE embedding.id IS NULL
     ), upserted AS (
       INSERT INTO product_embedding_jobs (
         tenant_id, product_id, target_version, status, attempt_count,
         available_at, lease_owner, lease_token, lease_expires_at,
         last_error, completed_at, created_at, updated_at
       )
       SELECT tenant_id, product_id, target_version, 'PENDING', 0,
         clock_timestamp(), NULL, NULL, NULL, NULL, NULL,
         clock_timestamp(), clock_timestamp()
       FROM stale_products
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET
         target_version = GREATEST(product_embedding_jobs.target_version, EXCLUDED.target_version),
         status = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN 'PROCESSING'
           WHEN product_embedding_jobs.status = 'PROCESSING'
             THEN 'PENDING'
           WHEN product_embedding_jobs.status = 'COMPLETED'
             OR EXCLUDED.target_version > product_embedding_jobs.target_version
             THEN 'PENDING'
           ELSE product_embedding_jobs.status
         END,
         attempt_count = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN product_embedding_jobs.attempt_count
           WHEN product_embedding_jobs.status = 'COMPLETED'
             OR EXCLUDED.target_version > product_embedding_jobs.target_version
             THEN 0
           ELSE product_embedding_jobs.attempt_count
         END,
         available_at = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN product_embedding_jobs.available_at
           WHEN product_embedding_jobs.status IN ('PROCESSING', 'COMPLETED')
             OR EXCLUDED.target_version > product_embedding_jobs.target_version
             THEN clock_timestamp()
           ELSE product_embedding_jobs.available_at
         END,
         lease_owner = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN product_embedding_jobs.lease_owner
           ELSE NULL
         END,
         lease_token = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN product_embedding_jobs.lease_token
           ELSE NULL
         END,
         lease_expires_at = CASE
           WHEN product_embedding_jobs.status = 'PROCESSING'
             AND product_embedding_jobs.lease_expires_at > clock_timestamp()
             THEN product_embedding_jobs.lease_expires_at
           ELSE NULL
         END,
         last_error = CASE
           WHEN product_embedding_jobs.status = 'COMPLETED'
             OR EXCLUDED.target_version > product_embedding_jobs.target_version
             THEN NULL
           ELSE product_embedding_jobs.last_error
         END,
         completed_at = NULL,
         updated_at = clock_timestamp()
       RETURNING 1
     )
     SELECT count(*)::integer AS count FROM upserted`,
    [PRODUCT_SEARCH_MODEL, PRODUCT_SEARCH_DIMENSION],
    client,
  );
  return Number(queued?.count ?? 0);
}

async function claimProductEmbeddingJobs(limit: number, workerId: string, leaseToken: string) {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedProductEmbeddingJob>(
      `WITH candidates AS (
         SELECT tenant_id, product_id
         FROM product_embedding_jobs
         WHERE (status IN ('PENDING', 'RETRY') AND available_at <= clock_timestamp())
            OR (status = 'PROCESSING' AND lease_expires_at <= clock_timestamp())
         ORDER BY available_at NULLS FIRST, updated_at, tenant_id, product_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE product_embedding_jobs AS job
       SET status = 'PROCESSING',
         attempt_count = job.attempt_count + 1,
         lease_owner = $2,
         lease_token = $3,
         lease_expires_at = clock_timestamp() + make_interval(mins => $4),
         last_error = NULL,
         completed_at = NULL,
         updated_at = clock_timestamp()
       FROM candidates
       WHERE job.tenant_id = candidates.tenant_id
         AND job.product_id = candidates.product_id
       RETURNING job.tenant_id AS "tenantId", job.product_id AS "productId",
         job.target_version AS "targetVersion", job.attempt_count AS "attemptCount"`,
      [limit, workerId, leaseToken, LEASE_MINUTES],
    );
    return result.rows;
  });
}

async function renewProductEmbeddingLease(leaseToken: string, workerId: string) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE product_embedding_jobs
       SET lease_expires_at = clock_timestamp() + make_interval(mins => $3)
       WHERE lease_token = $1 AND lease_owner = $2 AND status = 'PROCESSING'`,
      [leaseToken, workerId, LEASE_MINUTES],
    );
    return result.rowCount ?? 0;
  });
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '상품 벡터화 중 알 수 없는 오류가 발생했습니다.';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

async function markProductEmbeddingJobsForRetry(
  leaseToken: string,
  workerId: string,
  error: unknown,
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE product_embedding_jobs
       SET status = 'RETRY',
         available_at = clock_timestamp() + make_interval(
           secs => LEAST(300, (2 * power(2, LEAST(attempt_count - 1, 8)))::integer)
         ),
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = $3,
         updated_at = clock_timestamp()
       WHERE lease_token = $1 AND lease_owner = $2 AND status = 'PROCESSING'
       RETURNING product_id`,
      [leaseToken, workerId, safeErrorMessage(error)],
    );
    return {
      retrying: result.rowCount ?? 0,
      exhausted: 0,
    };
  });
}

async function finishProductEmbeddingJobs(leaseToken: string, workerId: string) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE product_embedding_jobs AS job
       SET target_version = product.version,
         status = 'COMPLETED',
         available_at = NULL,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = NULL,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
       FROM products AS product
       JOIN erp_embeddings AS embedding
         ON embedding.tenant_id = product.tenant_id
        AND embedding.entity_type = 'product'
        AND embedding.entity_id = product.id
        AND embedding.model = $3
        AND embedding.dimension = $4
        AND embedding.metadata ->> 'productVersion' = product.version::text
       WHERE job.tenant_id = product.tenant_id
         AND job.product_id = product.id
         AND job.lease_token = $1
         AND job.lease_owner = $2
         AND job.status = 'PROCESSING'
         AND product.version >= job.target_version
       RETURNING job.product_id`,
      [leaseToken, workerId, PRODUCT_SEARCH_MODEL, PRODUCT_SEARCH_DIMENSION],
    );
    const requeued = await client.query(
      `UPDATE product_embedding_jobs AS job
       SET target_version = GREATEST(job.target_version, product.version),
         status = 'PENDING',
         available_at = clock_timestamp(),
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = NULL,
         updated_at = clock_timestamp()
       FROM products AS product
       WHERE job.tenant_id = product.tenant_id
         AND job.product_id = product.id
         AND job.lease_token = $1
         AND job.lease_owner = $2
         AND job.status = 'PROCESSING'
       RETURNING job.product_id`,
      [leaseToken, workerId],
    );
    return { completed: completed.rowCount ?? 0, requeued: requeued.rowCount ?? 0 };
  });
}

/**
 * Claims a short-lived batch, releases all database locks, performs GPU work,
 * and then finalizes only jobs still owned by this lease token.
 */
export async function processNextProductEmbeddingJobs(limit: number, workerId: string) {
  const normalizedLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(MAX_BATCH_SIZE, limit))
    : MAX_BATCH_SIZE;
  const normalizedWorkerId = workerId.normalize('NFKC').trim();
  if (!normalizedWorkerId || normalizedWorkerId.length > 128) {
    throw new Error('상품 벡터화 worker ID는 1~128자여야 합니다.');
  }

  const leaseToken = crypto.randomUUID();
  const claimed = await claimProductEmbeddingJobs(normalizedLimit, normalizedWorkerId, leaseToken);
  if (claimed.length === 0) {
    return {
      claimed: 0, vectorized: 0, completed: 0, requeued: 0, retrying: 0, exhausted: 0,
    } satisfies ProductEmbeddingDrainResult;
  }

  const productIds = claimed.map((job) => job.productId);
  let vectorized = 0;
  let embeddingError: unknown;
  let leaseLost = false;
  let heartbeatChain = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatChain = heartbeatChain
      .then(async () => {
        const renewed = await renewProductEmbeddingLease(leaseToken, normalizedWorkerId);
        if (renewed !== claimed.length) {
          leaseLost = true;
          throw new Error(`상품 벡터화 lease 갱신 행 수가 일치하지 않습니다. (${renewed}/${claimed.length})`);
        }
      })
      .catch((error) => {
        // A later heartbeat can recover from a transient DB failure. Completion
        // remains fenced by the lease token even if ownership was actually lost.
        console.error('Product embedding lease heartbeat failed', error);
      });
  }, LEASE_HEARTBEAT_MS);
  const embeddingPool = getPool();
  try {
    // Deliberately not wrapped in a database transaction: Ollama may take
    // minutes, while the durable lease keeps the work recoverable.
    vectorized = await backfillProductSearchEmbeddings(embeddingPool, null, productIds, {
      leaseToken,
      leaseOwner: normalizedWorkerId,
    });
  } catch (error) {
    embeddingError = error;
  } finally {
    clearInterval(heartbeat);
    await heartbeatChain;
    await embeddingPool.end();
  }

  if (embeddingError) {
    const retry = await markProductEmbeddingJobsForRetry(leaseToken, normalizedWorkerId, embeddingError);
    return {
      claimed: claimed.length,
      vectorized: 0,
      completed: 0,
      requeued: 0,
      retrying: retry.retrying,
      exhausted: retry.exhausted,
    } satisfies ProductEmbeddingDrainResult;
  }

  const finished = await finishProductEmbeddingJobs(leaseToken, normalizedWorkerId);
  if (leaseLost) {
    console.warn('Product embedding lease was partially lost; owned jobs were fenced and finalized.', {
      claimed: claimed.length,
      completed: finished.completed,
      requeued: finished.requeued,
    });
  }
  return {
    claimed: claimed.length,
    vectorized,
    completed: finished.completed,
    requeued: finished.requeued,
    retrying: 0,
    exhausted: 0,
  } satisfies ProductEmbeddingDrainResult;
}

export async function getProductEmbeddingQueueStats(tenantId: string | null = null) {
  const row = await queryOne<QueueStatsRow>(
    `SELECT
       count(*) FILTER (WHERE status = 'PENDING')::integer AS pending,
       count(*) FILTER (WHERE status = 'PROCESSING')::integer AS processing,
       count(*) FILTER (
         WHERE status = 'RETRY' AND available_at IS NOT NULL
       )::integer AS retrying,
       count(*) FILTER (
         WHERE status = 'RETRY' AND available_at IS NULL
       )::integer AS failed,
       count(*) FILTER (WHERE status = 'COMPLETED')::integer AS completed,
       count(*)::integer AS total,
       min(available_at) FILTER (
         WHERE status IN ('PENDING', 'RETRY') AND available_at IS NOT NULL
       )::text AS "oldestQueuedAt"
     FROM product_embedding_jobs
     WHERE ($1::text IS NULL OR tenant_id = $1)`,
    [tenantId],
  );
  const stats = {
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    retrying: Number(row?.retrying ?? 0),
    failed: Number(row?.failed ?? 0),
    completed: Number(row?.completed ?? 0),
    total: Number(row?.total ?? 0),
    oldestQueuedAt: row?.oldestQueuedAt ?? null,
  };
  return {
    ...stats,
    outstanding: stats.pending + stats.processing + stats.retrying + stats.failed,
  } satisfies ProductEmbeddingQueueStats;
}
