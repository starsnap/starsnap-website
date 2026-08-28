import { NextResponse } from 'next/server';
import { withHubServerLog } from '@/app/lib/hub-server-log';
import { parseNeisMealQuery } from '@/app/lib/neis-meal-validation';
import { authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { NeisApiError } from '@/db/neis-meal-client';
import { lookupNeisMealsForBidder, NeisMealLookupError } from '@/db/neis-meal-service';

function responseHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function failure(request: Request, status: number, message: string) {
  return NextResponse.json({ message }, { status, headers: responseHeaders(request) });
}

function upstreamFailure(request: Request, error: NeisApiError) {
  if (error.code === 'NOT_CONFIGURED') {
    return failure(request, 503, '나이스 급식식단정보 인증키가 서버에 설정되지 않았습니다.');
  }
  if (error.code === 'TIMEOUT') {
    return failure(request, 504, '나이스 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (error.code === 'UPSTREAM_ERROR') {
    return failure(request, 502, '나이스 인증 상태 또는 조회 조건을 확인해 주세요.');
  }
  return failure(request, 502, '나이스 급식식단정보를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
}

export async function OPTIONS(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');
  return new NextResponse(null, { status: 204, headers: responseHeaders(request) });
}

async function handleGet(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');

  const parameters = new URL(request.url).searchParams;
  const tenant = normalizeTenantCode(parameters.get('tenant'));
  if (!tenant) return failure(request, 400, 'tenant 회사 코드 형식이 올바르지 않습니다.');
  const parsed = parseNeisMealQuery(parameters);
  if (!parsed.ok) return failure(request, 400, parsed.message);

  const access = await authorizeTenant(request, tenant);
  if (!access.ok) return failure(request, access.status, access.message);

  try {
    const result = await lookupNeisMealsForBidder({
      bidderTenantId: access.identity.tenantId,
      ...parsed.query,
    });
    return NextResponse.json(result, { headers: responseHeaders(request) });
  } catch (error) {
    if (error instanceof NeisMealLookupError) {
      return failure(request, error.status, error.message);
    }
    if (error instanceof NeisApiError) {
      console.error('NEIS meal lookup upstream failure', {
        code: error.code,
        status: error.status ?? null,
      });
      return upstreamFailure(request, error);
    }
    console.error('NEIS meal lookup failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return failure(request, 500, '급식식단정보 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

export const GET = withHubServerLog(handleGet);
