import { NextResponse } from 'next/server';
import type { BulkProductPriceMutationResult } from '@/app/lib/erp-types';
import { parseBulkProductPriceRequest } from '@/app/lib/product-validation';
import { authenticateRequest, authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import {
  applyBulkProductPriceMutation,
  createBulkProductPriceFingerprint,
} from '@/db/product-price-repository';

const MAX_JSON_BODY_BYTES = 48 * 1024 * 1024;
const MAX_JSON_BODY_MESSAGE = '요청 본문은 48MiB 이하여야 합니다.';

async function readLimitedBody(request: Request) {
  if (!request.body) return { ok: true as const, text: '' };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      await reader.cancel('request body limit exceeded');
      return { ok: false as const };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true as const, text };
}

function failureBody(message: string, total = 0): BulkProductPriceMutationResult {
  return {
    ok: false,
    message,
    summary: { total, created: 0, updated: 0, failed: 0, notApplied: total },
    rowDetails: { included: 0, total, omitted: total, truncated: total > 0 },
    rows: [],
  };
}

function corsHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

export async function OPTIONS(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(failureBody('허용되지 않은 출처입니다.'), { status: 403, headers: corsHeaders(request) });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  let knownTotal = 0;
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(failureBody('허용되지 않은 출처입니다.'), { status: 403, headers: corsHeaders(request) });
  }
  const authentication = await authenticateRequest(request);
  if (!authentication.ok) {
    return NextResponse.json(
      failureBody(authentication.message),
      { status: authentication.status, headers: corsHeaders(request) },
    );
  }
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(failureBody('8~128자의 Idempotency-Key가 필요합니다.'), { status: 400, headers: corsHeaders(request) });
  }
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return NextResponse.json(failureBody('Content-Type은 application/json이어야 합니다.'), { status: 415, headers: corsHeaders(request) });
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) {
    return NextResponse.json(failureBody(MAX_JSON_BODY_MESSAGE), { status: 413, headers: corsHeaders(request) });
  }

  try {
    const raw = await readLimitedBody(request);
    if (!raw.ok) {
      return NextResponse.json(failureBody(MAX_JSON_BODY_MESSAGE), { status: 413, headers: corsHeaders(request) });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.text);
    } finally {
      raw.text = '';
    }
    if (typeof decoded === 'object' && decoded !== null && 'rows' in decoded && Array.isArray(decoded.rows)) {
      knownTotal = decoded.rows.length;
    }
    const parsed = parseBulkProductPriceRequest(decoded);
    decoded = undefined;
    if (!parsed.ok) {
      const body: BulkProductPriceMutationResult = {
        ok: false,
        message: parsed.message,
        summary: {
          total: parsed.total,
          created: 0,
          updated: 0,
          failed: parsed.failed,
          notApplied: Math.max(0, parsed.total - parsed.failed),
        },
        rowDetails: {
          included: parsed.rows.length,
          total: parsed.total,
          omitted: Math.max(0, parsed.total - parsed.rows.length),
          truncated: parsed.rows.length < parsed.total,
        },
        rows: parsed.rows,
      };
      return NextResponse.json(body, { status: 422, headers: corsHeaders(request) });
    }
    const access = await authorizeTenant(request, parsed.value.tenant, true);
    if (!access.ok) {
      return NextResponse.json(
        failureBody(access.message, parsed.value.rows.length),
        { status: access.status, headers: corsHeaders(request) },
      );
    }
    const fingerprint = await createBulkProductPriceFingerprint(parsed.value);
    const result = await applyBulkProductPriceMutation(
      parsed.value,
      idempotencyKey,
      access.identity.actor,
      fingerprint,
    );
    const headers = corsHeaders(request);
    if (result.status === 425) headers.set('Retry-After', '2');
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(failureBody('JSON 요청 본문이 올바르지 않습니다.'), { status: 422, headers: corsHeaders(request) });
    }
    console.error('Bulk product price mutation failed', error);
    return NextResponse.json(
      failureBody('월별 상품 단가 일괄 처리 중 오류가 발생했습니다.', knownTotal),
      { status: 500, headers: corsHeaders(request) },
    );
  }
}
