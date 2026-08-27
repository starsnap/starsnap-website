import { NextResponse } from 'next/server';
import { authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { ensureDatabase } from '@/db/bootstrap';
import { getProductEmbeddingQueueStats } from '@/db/product-embedding-queue';
import { queryOne } from '@/db/postgres';
import { PRODUCT_SEARCH_DIMENSION, PRODUCT_SEARCH_MODEL } from '@/db/product-search';

interface TenantVectorizationProbe {
  tenantId: string;
  totalProducts: number;
  readyProducts: number;
  staleProducts: number;
}

function responseHeaders(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(
      { message: '허용되지 않은 출처입니다.' },
      { status: 403, headers: responseHeaders(request) },
    );
  }

  const tenant = normalizeTenantCode(new URL(request.url).searchParams.get('tenant'));
  if (!tenant) {
    return NextResponse.json(
      { message: 'tenant 회사 코드 형식이 올바르지 않습니다.' },
      { status: 400, headers: responseHeaders(request) },
    );
  }
  const access = await authorizeTenant(request, tenant);
  if (!access.ok) {
    return NextResponse.json(
      { message: access.message },
      { status: access.status, headers: responseHeaders(request) },
    );
  }

  try {
    await ensureDatabase();
    const probe = await queryOne<TenantVectorizationProbe>(
      `SELECT t.id AS "tenantId",
         count(p.id)::integer AS "totalProducts",
         count(e.id)::integer AS "readyProducts",
         (count(p.id) - count(e.id))::integer AS "staleProducts"
       FROM tenants t
       LEFT JOIN products p ON p.tenant_id = t.id
       LEFT JOIN erp_embeddings e
         ON e.tenant_id = p.tenant_id
        AND e.entity_type = 'product'
        AND e.entity_id = p.id
        AND e.model = $2
        AND e.dimension = $3
        AND e.metadata ->> 'productVersion' = p.version::text
       WHERE t.code = $1 AND t.status = 'ACTIVE'
       GROUP BY t.id`,
      [tenant, PRODUCT_SEARCH_MODEL, PRODUCT_SEARCH_DIMENSION],
    );
    if (!probe) {
      return NextResponse.json(
        { message: '회사를 찾을 수 없습니다.' },
        { status: 404, headers: responseHeaders(request) },
      );
    }

    const jobs = await getProductEmbeddingQueueStats(probe.tenantId);
    const totalProducts = Number(probe.totalProducts);
    const readyProducts = Number(probe.readyProducts);
    const staleProducts = Number(probe.staleProducts);
    const complete = staleProducts === 0 && readyProducts === totalProducts && jobs.outstanding === 0;
    const status = complete ? 'READY' : jobs.retrying > 0 ? 'RETRYING' : 'PROCESSING';
    return NextResponse.json({
      ok: true,
      tenant,
      model: PRODUCT_SEARCH_MODEL,
      dimension: PRODUCT_SEARCH_DIMENSION,
      status,
      totalProducts,
      readyProducts,
      staleProducts,
      jobs,
      complete,
    }, { status: 200, headers: responseHeaders(request) });
  } catch (error) {
    console.error('Product vectorization status failed', error);
    return NextResponse.json(
      { message: '상품 벡터화 상태를 확인하지 못했습니다.' },
      { status: 500, headers: responseHeaders(request) },
    );
  }
}
