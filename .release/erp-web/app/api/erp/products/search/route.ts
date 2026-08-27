import { NextResponse } from 'next/server';
import type { ProductSearchMode, ProductStatus } from '@/app/lib/erp-types';
import { authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { ensureDatabase } from '@/db/bootstrap';
import { searchProducts } from '@/db/product-search';
import { ProductEmbeddingUnavailableError } from '@/db/product-embedding-client';

const searchModes = new Set<ProductSearchMode>(['SMART', 'TRIGRAM', 'VECTOR']);
const productStatuses = new Set<ProductStatus>(['ACTIVE', 'INACTIVE']);

function corsHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function positiveInteger(value: string | null, fallback: number) {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function OPTIONS(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ message: '허용되지 않은 출처입니다.' }, { status: 403, headers: corsHeaders(request) });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ message: '허용되지 않은 출처입니다.' }, { status: 403, headers: corsHeaders(request) });
  }

  const search = new URL(request.url).searchParams;
  const tenant = normalizeTenantCode(search.get('tenant'));
  const query = search.get('q')?.normalize('NFKC').trim() ?? '';
  const mode = (search.get('mode')?.toUpperCase() ?? 'SMART') as ProductSearchMode;
  const categoryValue = search.get('category')?.trim() ?? '';
  const category = !categoryValue || categoryValue === 'ALL' ? null : categoryValue;
  const statusValue = search.get('status')?.toUpperCase() ?? 'ALL';
  const page = positiveInteger(search.get('page'), 1);
  const pageSize = positiveInteger(search.get('pageSize'), 50);

  if (!tenant) {
    return NextResponse.json(
      { message: 'tenant 회사 코드 형식이 올바르지 않습니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (!query || query.length > 100 || !/[\p{L}\p{N}]/u.test(query)) {
    return NextResponse.json(
      { message: 'q는 문자 또는 숫자를 포함한 1~100자의 검색어여야 합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (!searchModes.has(mode)) {
    return NextResponse.json(
      { message: 'mode는 SMART, TRIGRAM, VECTOR 중 하나여야 합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (category && category.length > 80) {
    return NextResponse.json(
      { message: 'category는 80자 이하여야 합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (statusValue !== 'ALL' && !productStatuses.has(statusValue as ProductStatus)) {
    return NextResponse.json(
      { message: 'status는 ALL, ACTIVE, INACTIVE 중 하나여야 합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (page === null || pageSize === null || pageSize > 100 || (page - 1) * pageSize > 10_000) {
    return NextResponse.json(
      { message: 'page는 양의 정수, pageSize는 1~100이어야 하며 최대 10,000건까지 조회할 수 있습니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }

  const access = await authorizeTenant(request, tenant);
  if (!access.ok) {
    return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
  }

  try {
    await ensureDatabase();
    const result = await searchProducts({
      tenant,
      query,
      mode,
      category,
      status: statusValue === 'ALL' ? null : statusValue as ProductStatus,
      page,
      pageSize,
    });
    if (!result) {
      return NextResponse.json({ message: '회사를 찾을 수 없습니다.' }, { status: 404, headers: corsHeaders(request) });
    }
    return NextResponse.json(result, { headers: corsHeaders(request) });
  } catch (error) {
    if (error instanceof ProductEmbeddingUnavailableError) {
      return NextResponse.json(
        { message: '로컬 GPU 의미 검색 서비스를 사용할 수 없습니다. 트라이그램 검색을 이용해 주세요.' },
        { status: 503, headers: corsHeaders(request) },
      );
    }
    console.error('Product similarity search failed', error);
    return NextResponse.json(
      { message: '상품 유사 검색을 완료하지 못했습니다.' },
      { status: 500, headers: corsHeaders(request) },
    );
  }
}
