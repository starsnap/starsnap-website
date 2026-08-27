import { NextResponse } from 'next/server';
import { parseLoginRequest } from '@/app/lib/auth-validation';
import {
  appendSessionCookie,
  authResponseHeaders,
  clientRateLimitScope,
  isStrictSameOrigin,
  readSmallJson,
} from '@/app/lib/auth-http';
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  loginAccount,
} from '@/db/auth-repository';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  const body = await readSmallJson(request, 4 * 1024);
  if (!body.ok) return NextResponse.json({ ok: false, message: body.message }, { status: body.status, headers });
  const parsed = parseLoginRequest(body.value);
  if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 422, headers });

  try {
    const result = await loginAccount({ ...parsed.value, clientScope: clientRateLimitScope(request) });
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') headers.set('Retry-After', String(result.retryAfter ?? 60));
      return NextResponse.json(
        { ok: false, message: result.message },
        { status: result.code === 'RATE_LIMITED' ? 429 : 401, headers },
      );
    }
    appendSessionCookie(headers, request, result.token, AUTH_SESSION_MAX_AGE_SECONDS);
    return NextResponse.json({ authenticated: true, ...result.session }, { status: 200, headers });
  } catch (error) {
    console.error('Account login failed', error);
    return NextResponse.json({ ok: false, message: '로그인 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
