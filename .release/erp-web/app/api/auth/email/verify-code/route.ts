import { NextResponse } from 'next/server';
import { parseEmailCodeRequest } from '@/app/lib/auth-validation';
import {
  authResponseHeaders,
  clientRateLimitScope,
  isStrictSameOrigin,
  readSmallJson,
} from '@/app/lib/auth-http';
import { AuthConfigurationError, verifyEmailChallenge } from '@/db/auth-repository';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  const body = await readSmallJson(request, 2 * 1024);
  if (!body.ok) return NextResponse.json({ ok: false, message: body.message }, { status: body.status, headers });
  const parsed = parseEmailCodeRequest(body.value);
  if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 422, headers });

  try {
    const result = await verifyEmailChallenge({ ...parsed.value, clientScope: clientRateLimitScope(request) });
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') headers.set('Retry-After', String(result.retryAfter ?? 60));
      const status = result.code === 'RATE_LIMITED' ? 429 : result.code === 'CODE_EXPIRED' ? 410 : 422;
      return NextResponse.json({ ok: false, message: result.message }, { status, headers });
    }
    return NextResponse.json({
      ok: true,
      verificationToken: result.verificationToken,
      message: '이메일 인증이 완료되었습니다.',
    }, { status: 200, headers });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('Auth verification is unavailable', error.message);
      return NextResponse.json(
        { ok: false, message: '이메일 인증 서비스를 사용할 수 없습니다. 관리자에게 문의해 주세요.' },
        { status: 503, headers },
      );
    }
    console.error('Email code verification failed', error);
    return NextResponse.json({ ok: false, message: '이메일 인증 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
