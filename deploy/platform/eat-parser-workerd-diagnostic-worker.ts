import { EatApiError, parseEatBidXml } from './db/eat-api-parser';

const endpoint = 'https://apis.data.go.kr/B552845/eaTPubServiceN3/eaTBidListN3';
const maximumResponseBytes = 2 * 1024 * 1024;
const requestedPage = 1;
const requestedPageSize = 20;

interface DiagnosticBindings {
  EAT_API_SERVICE_KEY: string;
}

export default {
  async fetch(_request: Request, env: DiagnosticBindings) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let stage = 'key';
    try {
      const key = decodeURIComponent(env.EAT_API_SERVICE_KEY.trim());
      const url = new URL(endpoint);
      url.searchParams.set('serviceKey', key);
      url.searchParams.set('pageNo', String(requestedPage));
      url.searchParams.set('numOfRows', String(requestedPageSize));
      url.searchParams.set('ancmStsrDt', '20260729');
      url.searchParams.set('ancmEndDt', '20260827');
      url.searchParams.set('useOrganNm', '교육청');

      stage = 'fetch';
      const response = await fetch(url, {
        headers: { Accept: 'application/xml, text/xml;q=0.9' },
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return Response.json({ ok: false, stage: 'http', status: response.status }, { status: 502 });
      }

      stage = 'body';
      if (!response.body) throw new Error('Response body is missing.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maximumResponseBytes) {
            await reader.cancel();
            throw new Error('Response exceeded diagnostic limit.');
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }

      stage = 'parse';
      const parsed = parseEatBidXml(chunks.join(''), {
        page: requestedPage,
        pageSize: requestedPageSize,
      });
      const validResult =
        parsed.total > 0 &&
        parsed.page === requestedPage &&
        parsed.pageSize === requestedPageSize &&
        parsed.items.length === Math.min(requestedPageSize, parsed.total);
      return Response.json({
        ok: validResult,
        stage: validResult ? 'complete' : 'parse-result',
        status: response.status,
        bytes,
        total: parsed.total,
        page: parsed.page,
        pageSize: parsed.pageSize,
        itemCount: parsed.items.length,
      }, { status: validResult ? 200 : 502 });
    } catch (error) {
      return Response.json({
        ok: false,
        stage,
        aborted: controller.signal.aborted,
        typed: error instanceof EatApiError,
        code: error instanceof EatApiError ? error.code : null,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, { status: 500 });
    } finally {
      clearTimeout(timeout);
    }
  },
};
