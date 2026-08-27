import { NextResponse } from 'next/server';
import {
  appendExpiredSessionCookies,
  authResponseHeaders,
  sessionTokenFromRequest,
} from '@/app/lib/auth-http';
import { readAuthSession } from '@/db/auth-repository';

export async function GET(request: Request) {
  const headers = authResponseHeaders();
  const token = sessionTokenFromRequest(request);
  if (!token) return NextResponse.json({ authenticated: false }, { status: 200, headers });
  try {
    const session = await readAuthSession(token);
    if (!session) {
      appendExpiredSessionCookies(headers, request);
      return NextResponse.json({ authenticated: false }, { status: 200, headers });
    }
    return NextResponse.json({ authenticated: true, ...session }, { status: 200, headers });
  } catch (error) {
    console.error('Auth session lookup failed', error);
    return NextResponse.json({ authenticated: false, message: '로그인 상태를 확인하지 못했습니다.' }, { status: 503, headers });
  }
}
