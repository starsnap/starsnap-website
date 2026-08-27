import { NextResponse } from 'next/server';
import { parseSignupRequest } from '@/app/lib/auth-validation';
import {
  appendSessionCookie,
  authResponseHeaders,
  clientRateLimitScope,
  isStrictSameOrigin,
  readSmallJson,
} from '@/app/lib/auth-http';
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  signupAccount,
} from '@/db/auth-repository';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  const body = await readSmallJson(request, 8 * 1024);
  if (!body.ok) return NextResponse.json({ ok: false, message: body.message }, { status: body.status, headers });
  const parsed = parseSignupRequest(body.value);
  if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 422, headers });

  try {
    const result = await signupAccount({ ...parsed.value, clientScope: clientRateLimitScope(request) });
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') headers.set('Retry-After', String(result.retryAfter ?? 60));
      const status = result.code === 'RATE_LIMITED'
        ? 429
        : result.code === 'USERNAME_TAKEN' || result.code === 'EMAIL_TAKEN'
          ? 409
          : 422;
      return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status, headers });
    }
    appendSessionCookie(headers, request, result.token, AUTH_SESSION_MAX_AGE_SECONDS);
    return NextResponse.json(
      { authenticated: true, ...result.session },
      { status: 201, headers },
    );
  } catch (error) {
    console.error('Account signup failed', error);
    return NextResponse.json({ ok: false, message: '회원가입 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
