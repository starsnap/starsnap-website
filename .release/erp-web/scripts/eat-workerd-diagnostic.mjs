import { Miniflare } from 'miniflare';

const serviceKey = process.env.EAT_API_SERVICE_KEY?.trim();
if (!serviceKey) throw new Error('EAT_API_SERVICE_KEY is required.');

const workerSource = String.raw`
const endpoint = 'https://apis.data.go.kr/B552845/eaTPubServiceN3/eaTBidListN3';
const maximumResponseBytes = 2 * 1024 * 1024;

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
      url.searchParams.set('pageNo', '1');
      url.searchParams.set('numOfRows', '20');
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
        return Response.json({ ok: false, stage: 'http', status: response.status });
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
      return Response.json({
        ok: true,
        stage: 'complete',
        status: response.status,
        bytes,
        contentType: response.headers.get('content-type'),
        resultCode: valueOf('resultCode'),
        totalCount: valueOf('totalCount'),
        pageNo: valueOf('pageNo'),
        numOfRows: valueOf('numOfRows'),
        itemCount: (xml.match(/<item>/g) ?? []).length,
      });
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
`;

const miniflare = new Miniflare({
  bindings: { EAT_API_SERVICE_KEY: serviceKey },
  modules: true,
  script: workerSource,
});

try {
  const response = await miniflare.dispatchFetch('http://diagnostic.local/');
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok || !result.ok) process.exitCode = 1;
} finally {
  await miniflare.dispose();
}
