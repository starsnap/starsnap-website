import { NextResponse } from 'next/server';
import { readSmallJson } from '@/app/lib/auth-http';
import { currentPriceMonth, isPriceMonth } from '@/app/lib/price-month';
import { parseProductPriceMutation } from '@/app/lib/product-validation';
import { authenticateRequest, authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { applyProductPriceMutation, fetchProductPriceSnapshots } from '@/db/product-price-repository';

function corsHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
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
  const priceMonth = search.get('priceMonth') ?? currentPriceMonth();
  if (!tenant) {
    return NextResponse.json(
      { message: 'tenant 회사 코드 형식이 올바르지 않습니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  if (!isPriceMonth(priceMonth)) {
    return NextResponse.json(
      { message: 'priceMonth는 YYYY-MM 형식이어야 합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  const access = await authorizeTenant(request, tenant);
  if (!access.ok) {
    return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
  }

  try {
    const result = await fetchProductPriceSnapshots(tenant, priceMonth);
    if (!result) {
      return NextResponse.json({ message: '회사를 찾을 수 없습니다.' }, { status: 404, headers: corsHeaders(request) });
    }
    return NextResponse.json(result, { headers: corsHeaders(request) });
  } catch (error) {
    console.error('Product price snapshot query failed', error);
    return NextResponse.json({ message: '월별 상품 단가를 불러오지 못했습니다.' }, { status: 500, headers: corsHeaders(request) });
  }
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ message: '허용되지 않은 출처입니다.' }, { status: 403, headers: corsHeaders(request) });
  }
  const authentication = await authenticateRequest(request);
  if (!authentication.ok) {
    return NextResponse.json(
      { message: authentication.message },
      { status: authentication.status, headers: corsHeaders(request) },
    );
  }
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { message: '8~128자의 Idempotency-Key가 필요합니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }
  try {
    const body = await readSmallJson(request, 16 * 1024);
    if (!body.ok) {
      return NextResponse.json({ message: body.message }, { status: body.status, headers: corsHeaders(request) });
    }
    const parsed = parseProductPriceMutation(body.value);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message }, { status: 422, headers: corsHeaders(request) });
    }
    const access = await authorizeTenant(request, parsed.value.tenant, true);
    if (!access.ok) {
      return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
    }
    const result = await applyProductPriceMutation(parsed.value, idempotencyKey, access.identity.actor);
    const headers = corsHeaders(request);
    if (result.status === 425) headers.set('Retry-After', '2');
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ message: 'JSON 요청 본문이 올바르지 않습니다.' }, { status: 422, headers: corsHeaders(request) });
    }
    console.error('Product price mutation failed', error);
    return NextResponse.json({ message: '월별 상품 단가 처리 중 오류가 발생했습니다.' }, { status: 500, headers: corsHeaders(request) });
  }
}
