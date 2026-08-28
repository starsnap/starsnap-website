import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { fetchNeisMeals, NeisApiError } from '@/db/neis-meal-client';

const headers = { 'Cache-Control': 'no-store, max-age=0' };

interface InternalBindings {
  ERP_EMBEDDING_WORKER_TOKEN?: string;
}

function configuredToken() {
  const token = (env as unknown as InternalBindings).ERP_EMBEDDING_WORKER_TOKEN?.trim() ?? '';
  return token.length >= 32 ? token : '';
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function authorized(request: Request, token: string) {
  return constantTimeEqual(request.headers.get('authorization') ?? '', `Bearer ${token}`);
}

export async function POST(request: Request) {
  const token = configuredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, message: '내부 검증 토큰이 설정되지 않았습니다.' },
      { status: 503, headers },
    );
  }
  if (!authorized(request, token)) {
    return NextResponse.json({ ok: false, message: '인증이 필요합니다.' }, { status: 401, headers });
  }

  const year = String(new Date().getUTCFullYear());
  try {
    const result = await fetchNeisMeals({
      officeCode: 'K10',
      schoolCode: '7840018',
      fromDate: `${year}-01-01`,
      toDate: `${year}-01-31`,
    });
    return NextResponse.json(
      { ok: true, source: 'NEIS', total: result.total },
      { status: 200, headers },
    );
  } catch (error) {
    if (error instanceof NeisApiError) {
      console.error('Internal NEIS health failed', {
        code: error.code,
        status: error.status ?? null,
      });
      return NextResponse.json(
        { ok: false, message: '나이스 급식식단정보 연결을 확인하지 못했습니다.' },
        { status: error.code === 'TIMEOUT' ? 504 : 502, headers },
      );
    }
    console.error('Internal NEIS health failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      { ok: false, message: '나이스 내부 검증을 완료하지 못했습니다.' },
      { status: 500, headers },
    );
  }
}
