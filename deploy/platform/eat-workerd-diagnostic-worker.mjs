const endpoint = 'https://apis.data.go.kr/B552845/eaTPubServiceN3/eaTBidListN3';
const maximumResponseBytes = 2 * 1024 * 1024;
const successfulResultCodes = new Set(['0', '00', '0000']);
const requestedPage = 1;
const requestedPageSize = 20;

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9%+/=]{32,}/g, '[redacted]')
    .slice(0, 240);
}

export default {
  async fetch(_request, env) {
    let stage = 'key';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
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
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maximumResponseBytes) throw new Error('Response exceeded diagnostic limit.');
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }

      stage = 'inspect';
      const xml = chunks.join('');
      const valueOf = (tag) => xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'))?.[1] ?? null;
      const integerValueOf = (tag) => {
        const value = valueOf(tag);
        return value !== null && /^\d+$/.test(value) ? Number(value) : null;
      };
      const resultCode = valueOf('resultCode');
      const totalCount = integerValueOf('totalCount');
      const pageNo = integerValueOf('pageNo');
      const numOfRows = integerValueOf('numOfRows');
      const itemCount = (xml.match(/<item(?:\s[^>]*)?>/g) ?? []).length;
      const expectedPageCount = totalCount === null
        ? null
        : Math.max(Math.ceil(totalCount / requestedPageSize), 1);
      const expectedItemCount = totalCount === null
        ? null
        : Math.min(requestedPageSize, totalCount);
      const validBody =
        successfulResultCodes.has(resultCode) &&
        totalCount !== null &&
        totalCount > 0 &&
        pageNo === expectedPageCount &&
        numOfRows === requestedPageSize &&
        itemCount === expectedItemCount;
      const diagnostic = {
        ok: validBody,
        stage: validBody ? 'complete' : 'inspect',
        requestedPage,
        requestedPageSize,
        status: response.status,
        bytes,
        contentType: response.headers.get('content-type'),
        resultCode,
        totalCount,
        pageNo,
        numOfRows,
        itemCount,
      };
      return Response.json(diagnostic, { status: validBody ? 200 : 502 });
    } catch (error) {
      return Response.json({
        ok: false,
        stage,
        aborted: controller.signal.aborted,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: safeMessage(error),
      }, { status: 500 });
    } finally {
      clearTimeout(timeout);
    }
  },
};
