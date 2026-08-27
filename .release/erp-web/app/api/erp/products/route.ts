import { NextResponse } from 'next/server';
import { readSmallJson } from '@/app/lib/auth-http';
import { authenticateRequest, isAllowedOrigin, authorizeTenant } from '@/app/lib/request-access';
import { parseProductMutation } from '@/app/lib/product-validation';
import { applyProductMutation } from '@/db/product-repository';

function corsHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    const parsed = parseProductMutation(body.value);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message }, { status: 422, headers: corsHeaders(request) });
    }

    const access = await authorizeTenant(request, parsed.value.tenant, true);
    if (!access.ok) {
      return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
    }

    const result = await applyProductMutation(parsed.value, idempotencyKey, access.identity.actor);
    return NextResponse.json(result.body, { status: result.status, headers: corsHeaders(request) });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ message: 'JSON 요청 본문이 올바르지 않습니다.' }, { status: 422, headers: corsHeaders(request) });
    }
    console.error('Product mutation failed', error);
    return NextResponse.json({ message: '상품 처리 중 오류가 발생했습니다.' }, { status: 500, headers: corsHeaders(request) });
  }
}
