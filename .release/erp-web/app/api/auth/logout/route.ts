import { NextResponse } from 'next/server';
import {
  appendExpiredSessionCookies,
  authResponseHeaders,
  isStrictSameOrigin,
  sessionTokenFromRequest,
} from '@/app/lib/auth-http';
import { destroyAuthSession } from '@/db/auth-repository';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  try {
    await destroyAuthSession(sessionTokenFromRequest(request));
    appendExpiredSessionCookies(headers, request);
    return NextResponse.json({ ok: true, authenticated: false }, { status: 200, headers });
  } catch (error) {
    console.error('Account logout failed', error);
    return NextResponse.json({ ok: false, message: '로그아웃 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
