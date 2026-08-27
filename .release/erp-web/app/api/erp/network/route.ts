import { NextResponse } from 'next/server';
import { readSmallJson } from '@/app/lib/auth-http';
import { withHubServerLog } from '@/app/lib/hub-server-log';
import { parseNetworkMutation } from '@/app/lib/network-validation';
import { authenticateRequest, authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { applyNetworkMutation } from '@/db/network-repository';

function responseHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  return NextResponse.json(
    { ok: false, message },
    { status, headers: responseHeaders(request) },
  );
}

export async function OPTIONS(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');
  return new NextResponse(null, { status: 204, headers: responseHeaders(request) });
}

async function handlePost(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');

  const authentication = await authenticateRequest(request);
  if (!authentication.ok) return failure(request, authentication.status, authentication.message);

  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return failure(request, 400, '8~128자의 Idempotency-Key가 필요합니다.');
  }

  try {
    const body = await readSmallJson(request, 32 * 1024);
    if (!body.ok) return failure(request, body.status, body.message);

    const parsed = parseNetworkMutation(body.value);
    if (!parsed.ok) return failure(request, 422, parsed.message);

    const access = await authorizeTenant(request, parsed.value.tenant, true);
    if (!access.ok) return failure(request, access.status, access.message);

    const result = await applyNetworkMutation(parsed.value, idempotencyKey, {
      actor: access.identity.actor,
      role: access.identity.role,
      tenantId: access.identity.tenantId,
    });
    return NextResponse.json(result.body, {
      status: result.status,
      headers: responseHeaders(request),
    });
  } catch (error) {
    console.error('Network mutation failed', error);
    return failure(request, 500, '유통 네트워크 처리 중 오류가 발생했습니다.');
  }
}

export const POST = withHubServerLog(handlePost);
