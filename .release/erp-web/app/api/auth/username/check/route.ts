import { NextResponse } from 'next/server';
import { parseUsernameCheck } from '@/app/lib/auth-validation';
import {
  authResponseHeaders,
  clientRateLimitScope,
  isStrictSameOrigin,
  readSmallJson,
} from '@/app/lib/auth-http';
import { checkUsernameAvailability } from '@/db/auth-repository';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  const body = await readSmallJson(request, 2 * 1024);
  if (!body.ok) return NextResponse.json({ ok: false, message: body.message }, { status: body.status, headers });
  const parsed = parseUsernameCheck(body.value);
  if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 422, headers });

  try {
    const result = await checkUsernameAvailability(parsed.value.normalizedUsername, clientRateLimitScope(request));
    if (!result.ok) {
      headers.set('Retry-After', String(result.retryAfter ?? 60));
      return NextResponse.json({ ok: false, message: result.message }, { status: 429, headers });
    }
    return NextResponse.json({ ok: true, available: result.available }, { status: 200, headers });
  } catch (error) {
    console.error('Username availability check failed', error);
    return NextResponse.json({ ok: false, message: '아이디 중복 확인 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
