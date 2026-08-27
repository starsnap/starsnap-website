import { NextResponse } from 'next/server';
import type { ErpAction } from '@/app/lib/erp-types';
import { readSmallJson } from '@/app/lib/auth-http';
import { authenticateRequest, authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { applyErpAction, fetchErpData } from '@/db/erp-repository';

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
  const code = normalizeTenantCode(new URL(request.url).searchParams.get('tenant'));
  if (!code) {
    return NextResponse.json(
      { message: 'tenant 회사 코드 형식이 올바르지 않습니다.' },
      { status: 400, headers: corsHeaders(request) },
    );
  }

  const access = await authorizeTenant(request, code);
  if (!access.ok) {
    return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
  }

  try {
    const data = await fetchErpData(code);
    if (!data) return NextResponse.json({ message: '회사를 찾을 수 없습니다.' }, { status: 404, headers: corsHeaders(request) });
    return NextResponse.json(data, { headers: corsHeaders(request) });
  } catch (error) {
    console.error('ERP data query failed', error);
    return NextResponse.json({ message: 'ERP 데이터를 불러오지 못했습니다.' }, { status: 500, headers: corsHeaders(request) });
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
    const action = body.value as Partial<ErpAction>;
    if (
      !normalizeTenantCode(action.tenant) ||
      !action.module || !['meals', 'purchasing', 'inventory', 'production', 'delivery', 'haccp'].includes(action.module) ||
      !action.id || !action.action || !['confirm', 'approve', 'acknowledge', 'complete', 'resolve'].includes(action.action)
    ) {
      return NextResponse.json({ message: '업무 처리 요청 형식이 올바르지 않습니다.' }, { status: 422, headers: corsHeaders(request) });
    }

    if (action.module === 'haccp' && action.action === 'resolve') {
      const verificationValue = action.evidence?.verificationValue?.trim();
      const correctiveAction = action.evidence?.correctiveAction?.trim();
      if (!verificationValue || !correctiveAction || verificationValue.length > 80 || correctiveAction.length > 500) {
        return NextResponse.json(
          { message: 'HACCP 종결에는 재측정값과 시정 조치 확인 내용이 필요합니다.' },
          { status: 422, headers: corsHeaders(request) },
        );
      }
    }

    action.tenant = normalizeTenantCode(action.tenant)!;
    const access = await authorizeTenant(request, action.tenant, true);
    if (!access.ok) {
      return NextResponse.json({ message: access.message }, { status: access.status, headers: corsHeaders(request) });
    }

    const result = await applyErpAction(action as ErpAction, idempotencyKey, access.identity.actor);
    return NextResponse.json(result.body, { status: result.status, headers: corsHeaders(request) });
  } catch (error) {
    console.error('ERP action failed', error);
    return NextResponse.json({ message: '업무 처리 중 오류가 발생했습니다.' }, { status: 500, headers: corsHeaders(request) });
  }
}
