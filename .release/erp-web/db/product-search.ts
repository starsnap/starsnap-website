import type { QueryResultRow } from 'pg';
import type {
  Product,
  ProductSearchItem,
  ProductSearchMode,
  ProductSearchResponse,
  ProductStatus,
  TenantCode,
} from '@/app/lib/erp-types';
import { queryAll, queryOne, type SqlExecutor, withTransaction } from './postgres';
import {
  createProductEmbeddings,
  createProductQueryEmbedding,
  ProductEmbeddingUnavailableError,
  PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX,
  PRODUCT_EMBEDDING_RUNTIME_MODEL,
  PRODUCT_SEARCH_DIMENSION,
  PRODUCT_SEARCH_MODEL,
} from './product-embedding-client';

export { PRODUCT_SEARCH_DIMENSION, PRODUCT_SEARCH_MODEL } from './product-embedding-client';

interface ProductEmbeddingSource extends QueryResultRow {
  tenantId: string;
  productId: string;
  sku: string;
  name: string;
  category: string;
  specification: string;
  supplierName: string;
  allergens: string;
  version: number;
  embeddingId: string | null;
  existingContentHash: string | null;
  existingDimension: number | null;
}

interface TenantRow extends QueryResultRow {
  id: string;
}

interface ProductSearchRow extends QueryResultRow {
  productId: string | null;
  sku: string | null;
  name: string | null;
  category: string | null;
  specification: string | null;
  unit: Product['unit'] | null;
  schoolPriceKg: number | null;
  schoolPriceSpec: number | null;
  schoolPriceEach: number | null;
  vendorPriceKg: number | null;
  vendorPriceSpec: number | null;
  vendorPriceEach: number | null;
  purchasePriceKg: number | null;
  purchasePriceSpec: number | null;
  purchasePriceEach: number | null;
  supplierName: string | null;
  storageType: Product['storageType'] | null;
  allergens: string | null;
  status: Product['status'] | null;
  version: number | null;
  updatedAt: string | null;
  score: number | string | null;
  trigramScore: number | string | null;
  vectorScore: number | string | null;
  reason: ProductSearchItem['reason'] | null;
  total: number | string;
}

export interface ProductSearchInput {
  tenant: TenantCode;
  query: string;
  mode: ProductSearchMode;
  category: string | null;
  status: ProductStatus | null;
  page: number;
  pageSize: number;
}

function normalizeSearchText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeLexicalSearchText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function fnv1a(value: string, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createProductEmbeddingText(product: Pick<
  ProductEmbeddingSource,
  'sku' | 'name' | 'category' | 'specification' | 'supplierName' | 'allergens'
>) {
  return [
    `상품명: ${normalizeSearchText(product.name)}`,
    `상품코드: ${normalizeSearchText(product.sku)}`,
    `식품분류: ${normalizeSearchText(product.category)}`,
    `규격: ${normalizeSearchText(product.specification)}`,
    `공급업체: ${normalizeSearchText(product.supplierName)}`,
    product.allergens ? `알레르기: ${normalizeSearchText(product.allergens)}` : '',
  ].filter(Boolean).join('\n');
}

function vectorLiteral(vector: readonly number[]) {
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`;
}

function searchableContentHash(product: ProductEmbeddingSource) {
  const content = [
    product.sku,
    product.name,
    product.category,
    product.specification,
    product.supplierName,
    product.allergens,
  ].map(normalizeSearchText).join('\u001f');
  return [fnv1a(content), fnv1a(content, 0x9e3779b9)]
    .map((hash) => hash.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Refreshes missing or product-version-stale vectors with one read and
 * chunked set-based upserts. When productIds are supplied, only those changed
 * products are inspected. A 10,000-row refresh uses 21 database requests,
 * never one request per product.
 */
export interface ProductEmbeddingWriteFence {
  leaseToken: string;
  leaseOwner: string;
}

export async function backfillProductSearchEmbeddings(
  executor: SqlExecutor,
  tenantId: string | null,
  productIds: readonly string[] | null,
  writeFence: ProductEmbeddingWriteFence,
) {
  const targetProductIds = productIds ? [...new Set(productIds)] : null;
  if (targetProductIds?.length === 0) return 0;
  const sources = await queryAll<ProductEmbeddingSource>(
    `SELECT p.tenant_id AS "tenantId", p.id AS "productId", p.sku, p.name,
       p.category, p.specification, p.supplier_name AS "supplierName",
       p.allergens, p.version, e.id AS "embeddingId",
       e.content_hash AS "existingContentHash", e.dimension AS "existingDimension"
     FROM products p
     LEFT JOIN erp_embeddings e
       ON e.tenant_id = p.tenant_id
      AND e.entity_type = 'product'
      AND e.entity_id = p.id
      AND e.model = $2
     WHERE ($1::text IS NULL OR p.tenant_id = $1)
       AND ($4::text[] IS NULL OR p.id = ANY($4::text[]))
       AND (
         e.id IS NULL
         OR e.dimension <> $3
         OR e.metadata ->> 'productVersion' IS DISTINCT FROM p.version::text
       )
     ORDER BY p.tenant_id, p.id`,
    [tenantId, PRODUCT_SEARCH_MODEL, PRODUCT_SEARCH_DIMENSION, targetProductIds],
    executor,
  );

  const chunkSize = 500;
  const prepared = sources.map((product) => ({
    ...product,
    contentHash: searchableContentHash(product),
  }));
  const reusable = prepared.filter((product) =>
    product.embeddingId
    && product.existingDimension === PRODUCT_SEARCH_DIMENSION
    && product.existingContentHash === product.contentHash);
  const requiresEmbedding = prepared.filter((product) =>
    !product.embeddingId
    || product.existingDimension !== PRODUCT_SEARCH_DIMENSION
    || product.existingContentHash !== product.contentHash);
  let persistedCount = 0;

  for (let offset = 0; offset < reusable.length; offset += chunkSize) {
    const now = new Date().toISOString();
    const payload = reusable.slice(offset, offset + chunkSize).map((product) => ({
      tenant_id: product.tenantId,
      entity_id: product.productId,
      content_hash: product.contentHash,
      product_version: product.version,
    }));
    const result = await executor.query(
      `WITH source AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS decoded(
           tenant_id text, entity_id text, content_hash text, product_version integer
         )
       ), guarded_source AS MATERIALIZED (
         SELECT source.*
         FROM source
         JOIN product_embedding_jobs AS job
           ON job.tenant_id = source.tenant_id
          AND job.product_id = source.entity_id
          AND job.status = 'PROCESSING'
          AND job.lease_token = $6
          AND job.lease_owner = $7
          AND job.target_version <= source.product_version
         FOR UPDATE OF job
       )
       UPDATE erp_embeddings AS embedding
       SET metadata = embedding.metadata || jsonb_build_object(
         'productVersion', source.product_version,
         'generator', 'ollama',
         'runtimeModel', $4::text,
         'modelDigest', $5::text,
         'searchFields', jsonb_build_array('name','sku','category','specification','supplierName','allergens')
       ), updated_at = $3
       FROM guarded_source AS source
       WHERE embedding.tenant_id = source.tenant_id
         AND embedding.entity_type = 'product'
         AND embedding.entity_id = source.entity_id
         AND embedding.model = $2
         AND embedding.dimension = ${PRODUCT_SEARCH_DIMENSION}
         AND embedding.content_hash = source.content_hash
         AND CASE
           WHEN embedding.metadata ->> 'productVersion' ~ '^[0-9]+$'
             THEN (embedding.metadata ->> 'productVersion')::integer
           ELSE 0
         END <= source.product_version`,
      [
        JSON.stringify(payload),
        PRODUCT_SEARCH_MODEL,
        now,
        PRODUCT_EMBEDDING_RUNTIME_MODEL,
        PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX,
        writeFence.leaseToken,
        writeFence.leaseOwner,
      ],
    );
    persistedCount += result.rowCount ?? 0;
  }

  for (let offset = 0; offset < requiresEmbedding.length; offset += chunkSize) {
    const now = new Date().toISOString();
    const productBatch = requiresEmbedding.slice(offset, offset + chunkSize);
    const vectors = await createProductEmbeddings(productBatch.map(createProductEmbeddingText));
    const payload = productBatch.map((product, index) => ({
      id: `product-search:bge-m3-fp16:${product.tenantId}:${product.productId}`,
      tenant_id: product.tenantId,
      entity_id: product.productId,
      content_hash: product.contentHash,
      product_version: product.version,
      embedding: vectorLiteral(vectors[index]!),
    }));
    const result = await executor.query(
      `WITH source AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS decoded(
           id text, tenant_id text, entity_id text, content_hash text,
           product_version integer, embedding text
         )
       ), guarded_source AS MATERIALIZED (
         SELECT source.*
         FROM source
         JOIN product_embedding_jobs AS job
           ON job.tenant_id = source.tenant_id
          AND job.product_id = source.entity_id
          AND job.status = 'PROCESSING'
          AND job.lease_token = $7
          AND job.lease_owner = $8
          AND job.target_version <= source.product_version
         FOR UPDATE OF job
       )
       INSERT INTO erp_embeddings (
         id, tenant_id, entity_type, entity_id, model, dimension,
         content_hash, metadata, embedding, created_at, updated_at
       )
       SELECT source.id, source.tenant_id, 'product', source.entity_id, $2, $3,
         source.content_hash,
         jsonb_build_object(
           'productVersion', source.product_version,
           'generator', 'ollama',
           'runtimeModel', $5::text,
           'modelDigest', $6::text,
           'searchFields', jsonb_build_array('name','sku','category','specification','supplierName','allergens')
         ),
         source.embedding::vector, $4, $4
       FROM guarded_source AS source
       ON CONFLICT (tenant_id, entity_type, entity_id, model) DO UPDATE SET
          dimension = EXCLUDED.dimension,
          content_hash = EXCLUDED.content_hash,
          metadata = EXCLUDED.metadata,
          embedding = EXCLUDED.embedding,
          updated_at = EXCLUDED.updated_at
        WHERE CASE
          WHEN erp_embeddings.metadata ->> 'productVersion' ~ '^[0-9]+$'
            THEN (erp_embeddings.metadata ->> 'productVersion')::integer
          ELSE 0
        END <= (EXCLUDED.metadata ->> 'productVersion')::integer`,
      [
        JSON.stringify(payload),
        PRODUCT_SEARCH_MODEL,
        PRODUCT_SEARCH_DIMENSION,
        now,
        PRODUCT_EMBEDDING_RUNTIME_MODEL,
        PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX,
        writeFence.leaseToken,
        writeFence.leaseOwner,
      ],
    );
    persistedCount += result.rowCount ?? 0;
  }

  return persistedCount;
}

function boundedScore(value: number | string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, Number(parsed.toFixed(4))));
}

export async function searchProducts(input: ProductSearchInput): Promise<ProductSearchResponse | null> {
  const normalizedQuery = normalizeSearchText(input.query);
  const lexicalQuery = normalizeLexicalSearchText(input.query);
  if (!normalizedQuery) throw new Error('Product search query must not be empty.');

  let executionMode: ProductSearchMode = input.mode;
  let vectorStatus: ProductSearchResponse['vectorStatus'] = 'NOT_REQUESTED';
  let queryEmbedding: string | null = null;
  if (input.mode !== 'TRIGRAM') {
    try {
      queryEmbedding = vectorLiteral(await createProductQueryEmbedding(normalizedQuery));
      vectorStatus = 'USED';
    } catch (error) {
      if (!(error instanceof ProductEmbeddingUnavailableError) || input.mode === 'VECTOR') throw error;
      executionMode = 'TRIGRAM';
      vectorStatus = 'UNAVAILABLE';
    }
  }

  const executeSearch = () => withTransaction(async (client) => {
    const tenant = await queryOne<TenantRow>(
      `SELECT id FROM tenants WHERE code = $1 AND status = 'ACTIVE'`,
      [input.tenant],
      client,
    );
    if (!tenant) return null;

    const offset = (input.page - 1) * input.pageSize;
    const rows = await queryAll<ProductSearchRow>(
      `WITH scored AS (
         SELECT p.id AS product_id, p.sku, p.name, p.category, p.specification, p.unit,
           p.school_price_kg, p.school_price_spec, p.school_price_each,
           p.vendor_price_kg, p.vendor_price_spec, p.vendor_price_each,
           p.purchase_price_kg, p.purchase_price_spec, p.purchase_price_each,
           p.supplier_name, p.storage_type, p.allergens, p.status, p.version, p.updated_at,
           CASE WHEN lower(p.sku) = $2 THEN 1 ELSE 0 END AS exact_sku,
           CASE WHEN lower(p.name) = $2 THEN 1 ELSE 0 END AS exact_name,
           CASE
             WHEN lower(p.name) LIKE $9 ESCAPE '\\' THEN 0.97
             WHEN lower(p.sku) LIKE $9 ESCAPE '\\' THEN 0.95
             WHEN lower(p.category) LIKE $9 ESCAPE '\\'
               OR lower(p.specification) LIKE $9 ESCAPE '\\'
               OR lower(p.supplier_name) LIKE $9 ESCAPE '\\'
               OR lower(p.allergens) LIKE $9 ESCAPE '\\' THEN 0.84
             ELSE 0
           END AS contains_score,
           CASE WHEN $3 IN ('SMART', 'TRIGRAM') THEN GREATEST(
             similarity(lower(p.name), $2),
             word_similarity($2, lower(p.name)),
             strict_word_similarity($2, lower(p.name))
           ) ELSE 0 END AS trigram_score,
           CASE WHEN $3 IN ('SMART', 'VECTOR') AND e.embedding IS NOT NULL THEN GREATEST(0, LEAST(1,
             1 - (e.embedding::vector(${PRODUCT_SEARCH_DIMENSION}) <=> $6::vector(${PRODUCT_SEARCH_DIMENSION}))
           )) ELSE 0 END AS vector_score
         FROM products p
         LEFT JOIN erp_embeddings e
           ON e.tenant_id = p.tenant_id
          AND e.entity_type = 'product'
          AND e.entity_id = p.id
          AND e.model = '${PRODUCT_SEARCH_MODEL}'
          AND e.dimension = ${PRODUCT_SEARCH_DIMENSION}
          AND e.metadata ->> 'productVersion' = p.version::text
         WHERE p.tenant_id = $1
           AND ($4::text IS NULL OR p.category = $4)
           AND ($5::text IS NULL OR p.status = $5)
       ), ranked AS (
         SELECT scored.*,
           CASE $3::text
             WHEN 'TRIGRAM' THEN GREATEST(exact_sku, exact_name, contains_score, trigram_score)
             WHEN 'VECTOR' THEN GREATEST(exact_sku, exact_name, contains_score, vector_score)
             ELSE GREATEST(
               exact_sku, exact_name, contains_score,
               trigram_score * 0.98,
               vector_score * 0.92,
               LEAST(0.96, trigram_score * 0.65 + vector_score * 0.45)
             )
           END AS score
         FROM scored
       ), matched AS MATERIALIZED (
         SELECT * FROM ranked
         WHERE exact_sku = 1 OR exact_name = 1 OR contains_score > 0
           OR ($3 IN ('SMART', 'TRIGRAM') AND trigram_score >= 0.20)
           OR ($3 IN ('SMART', 'VECTOR') AND vector_score >= 0.24)
       ), totals AS (
         SELECT count(*)::integer AS total FROM matched
       ), page_rows AS (
         SELECT matched.*,
           CASE
             WHEN exact_sku = 1 THEN 'EXACT_SKU'
             WHEN exact_name = 1 THEN 'EXACT_NAME'
             WHEN contains_score > 0 THEN 'CONTAINS'
             WHEN $3 = 'VECTOR' THEN 'VECTOR_SIMILAR'
             WHEN $3 = 'TRIGRAM' THEN 'NAME_TRIGRAM'
             WHEN trigram_score >= vector_score THEN 'NAME_TRIGRAM'
             ELSE 'VECTOR_SIMILAR'
           END AS reason
         FROM matched
         ORDER BY score DESC, trigram_score DESC, vector_score DESC, product_id
         LIMIT $7 OFFSET $8
       )
       SELECT page_rows.product_id AS "productId", page_rows.sku, page_rows.name,
         page_rows.category, page_rows.specification, page_rows.unit,
         page_rows.school_price_kg AS "schoolPriceKg",
         page_rows.school_price_spec AS "schoolPriceSpec",
         page_rows.school_price_each AS "schoolPriceEach",
         page_rows.vendor_price_kg AS "vendorPriceKg",
         page_rows.vendor_price_spec AS "vendorPriceSpec",
         page_rows.vendor_price_each AS "vendorPriceEach",
         page_rows.purchase_price_kg AS "purchasePriceKg",
         page_rows.purchase_price_spec AS "purchasePriceSpec",
         page_rows.purchase_price_each AS "purchasePriceEach",
         page_rows.supplier_name AS "supplierName",
         page_rows.storage_type AS "storageType",
         page_rows.allergens, page_rows.status, page_rows.version,
         page_rows.updated_at AS "updatedAt",
         page_rows.score::double precision AS score,
         page_rows.trigram_score::double precision AS "trigramScore",
         page_rows.vector_score::double precision AS "vectorScore",
         page_rows.reason, totals.total
       FROM totals
       LEFT JOIN page_rows ON TRUE
       ORDER BY page_rows.score DESC, page_rows.trigram_score DESC,
         page_rows.vector_score DESC, page_rows.product_id`,
      [
        tenant.id,
        lexicalQuery,
        executionMode,
        input.category,
        input.status,
        queryEmbedding,
        input.pageSize,
        offset,
        containsPattern(lexicalQuery),
      ],
      client,
    );

    const items = rows.flatMap((row): ProductSearchItem[] => {
      if (!row.productId || !row.reason) return [];
      const product: Product = {
        id: row.productId,
        sku: row.sku!,
        name: row.name!,
        category: row.category!,
        specification: row.specification!,
        unit: row.unit!,
        schoolPriceKg: row.schoolPriceKg!,
        schoolPriceSpec: row.schoolPriceSpec!,
        schoolPriceEach: row.schoolPriceEach!,
        vendorPriceKg: row.vendorPriceKg!,
        vendorPriceSpec: row.vendorPriceSpec!,
        vendorPriceEach: row.vendorPriceEach!,
        purchasePriceKg: row.purchasePriceKg!,
        purchasePriceSpec: row.purchasePriceSpec!,
        purchasePriceEach: row.purchasePriceEach!,
        supplierName: row.supplierName!,
        storageType: row.storageType!,
        allergens: row.allergens!,
        status: row.status!,
        version: row.version!,
        updatedAt: row.updatedAt!,
      };
      return [{
        productId: row.productId,
        product,
        score: boundedScore(row.score ?? 0),
        trigramScore: boundedScore(row.trigramScore ?? 0),
        vectorScore: boundedScore(row.vectorScore ?? 0),
        reason: row.reason,
      }];
    });

    return {
      tenant: input.tenant,
      query: input.query.trim(),
      mode: input.mode,
      executionMode,
      vectorStatus,
      total: Number(rows[0]?.total ?? 0),
      page: input.page,
      pageSize: input.pageSize,
      model: PRODUCT_SEARCH_MODEL,
      items,
    };
  }, 'REPEATABLE READ');

  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await executeSearch();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
      if (code !== '40001' || attempt === maximumAttempts) throw error;
      const retryDelayMs = attempt * 12 + Math.floor(Math.random() * 13);
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error('Product search retry loop completed unexpectedly.');
}
