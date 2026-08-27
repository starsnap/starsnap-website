import { NextResponse } from 'next/server';
import { ensureDatabase } from '@/db/bootstrap';
import {
  PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX,
  PRODUCT_EMBEDDING_RUNTIME_MODEL,
} from '@/db/product-embedding-client';
import { getProductEmbeddingQueueStats } from '@/db/product-embedding-queue';
import { latestPostgresSchemaVersion } from '@/db/postgres-migrations';
import { queryOne } from '@/db/postgres';
import { PRODUCT_SEARCH_DIMENSION, PRODUCT_SEARCH_MODEL } from '@/db/product-search';

const headers = { 'Cache-Control': 'no-store' };

interface HealthProbe {
  ok: number;
  vectorVersion: string | null;
  trigramVersion: string | null;
  schemaVersion: number | null;
  totalProducts: number;
  indexedProducts: number;
  staleProducts: number;
}

export async function GET() {
  try {
    await ensureDatabase();
    const [probe, queue] = await Promise.all([
      queryOne<HealthProbe>(
        `SELECT 1 AS ok,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS "vectorVersion",
           (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm') AS "trigramVersion",
           (SELECT max(version) FROM schema_migrations) AS "schemaVersion",
           (SELECT count(*)::integer FROM products) AS "totalProducts",
           (SELECT count(*)::integer
              FROM products p
              JOIN erp_embeddings e
                ON e.tenant_id = p.tenant_id
               AND e.entity_type = 'product'
               AND e.entity_id = p.id
               AND e.model = $1
               AND e.dimension = $2
               AND e.metadata ->> 'productVersion' = p.version::text) AS "indexedProducts",
           (SELECT count(*)::integer
              FROM products p
              LEFT JOIN erp_embeddings e
                ON e.tenant_id = p.tenant_id
               AND e.entity_type = 'product'
               AND e.entity_id = p.id
               AND e.model = $1
               AND e.dimension = $2
               AND e.metadata ->> 'productVersion' = p.version::text
             WHERE e.id IS NULL) AS "staleProducts"`,
        [PRODUCT_SEARCH_MODEL, PRODUCT_SEARCH_DIMENSION],
      ),
      getProductEmbeddingQueueStats(),
    ]);
    if (
      !probe
      || Number(probe.ok) !== 1
      || !probe.vectorVersion
      || !probe.trigramVersion
      || Number(probe.schemaVersion) !== latestPostgresSchemaVersion
    ) {
      throw new Error('PostgreSQL 상품 유사 검색 상태 점검에 실패했습니다.');
    }

    const totalProducts = Number(probe.totalProducts);
    const indexedProducts = Number(probe.indexedProducts);
    const staleProducts = Number(probe.staleProducts);
    const complete = staleProducts === 0 && indexedProducts === totalProducts && queue.outstanding === 0;
    const vectorStatus = queue.retrying > 0 || queue.failed > 0
      ? 'DEGRADED'
      : complete ? 'READY' : 'PROCESSING';

    return NextResponse.json({
      ok: true,
      database: 'postgresql',
      schemaVersion: Number(probe.schemaVersion),
      vector: { available: true, version: probe.vectorVersion },
      productSearch: {
        trigram: { available: true, version: probe.trigramVersion },
        vector: {
          available: vectorStatus !== 'DEGRADED',
          status: vectorStatus,
          runtimeChecked: false,
          model: PRODUCT_SEARCH_MODEL,
          dimension: PRODUCT_SEARCH_DIMENSION,
          provider: 'ollama',
          runtimeModel: PRODUCT_EMBEDDING_RUNTIME_MODEL,
          modelDigest: PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX,
          indexedProducts,
          totalProducts,
          staleProducts,
          queue,
          complete,
        },
      },
    }, { status: 200, headers });
  } catch (error) {
    console.error('Health check failed', error);
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
