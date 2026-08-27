import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { ensureDatabase } from '@/db/bootstrap';
import { processNextProductEmbeddingJobs } from '@/db/product-embedding-queue';

const headers = { 'Cache-Control': 'no-store' };
const MAX_BATCH_SIZE = 128;

interface DrainBindings {
  ERP_EMBEDDING_WORKER_TOKEN?: string;
}

function configuredToken() {
  const token = (env as unknown as DrainBindings).ERP_EMBEDDING_WORKER_TOKEN?.trim() ?? '';
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
  const authorization = request.headers.get('authorization') ?? '';
  return constantTimeEqual(authorization, `Bearer ${token}`);
}

function clampLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const token = configuredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, message: '상품 벡터화 worker token이 설정되지 않았습니다.' },
      { status: 503, headers },
    );
  }
  if (!authorized(request, token)) {
    return NextResponse.json({ ok: false, message: '인증이 필요합니다.' }, { status: 401, headers });
  }

  try {
    const decoded = await request.json() as unknown;
    if (!isRecord(decoded)) {
      return NextResponse.json(
        { ok: false, message: 'JSON 요청 본문은 객체여야 합니다.' },
        { status: 422, headers },
      );
    }
    const body = decoded;
    const workerId = typeof body.workerId === 'string' ? body.workerId.normalize('NFKC').trim() : '';
    if (!workerId || workerId.length > 128) {
      return NextResponse.json(
        { ok: false, message: 'workerId는 1~128자의 문자열이어야 합니다.' },
        { status: 422, headers },
      );
    }

    await ensureDatabase();
    const result = await processNextProductEmbeddingJobs(clampLimit(body.limit), workerId);
    return NextResponse.json({ ok: true, ...result }, { status: 200, headers });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, message: 'JSON 요청 본문이 올바르지 않습니다.' },
        { status: 422, headers },
      );
    }
    console.error('Product embedding drain failed', error);
    return NextResponse.json(
      { ok: false, message: '상품 벡터화 작업을 처리하지 못했습니다.' },
      { status: 500, headers },
    );
  }
}
