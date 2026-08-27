import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let viteServer;
let EatApiError;
let fetchEatBidPage;
let formatEatDate;
let lookupEatBids;
let parseEatBidQuery;
let parseEatBidXml;

before(async () => {
  viteServer = await createServer({
    root: projectRoot,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': projectRoot } },
    server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: 'eat-bid-cloudflare-test-double',
      enforce: 'pre',
      resolveId(source) {
        return source === 'cloudflare:workers' ? '\0eat-bid-cloudflare-test-double' : null;
      },
      load(id) {
        return id === '\0eat-bid-cloudflare-test-double'
          ? 'export const env = {}; export function waitUntil() {}'
          : null;
      },
    }],
  });

  ({ EatApiError, parseEatBidXml } = await viteServer.ssrLoadModule('/db/eat-api-parser.ts'));
  ({ fetchEatBidPage } = await viteServer.ssrLoadModule('/db/eat-api-client.ts'));
  ({ formatEatDate } = await viteServer.ssrLoadModule('/app/lib/eat-date-format.ts'));
  ({ parseEatBidQuery } = await viteServer.ssrLoadModule('/app/lib/eat-bid-validation.ts'));
  ({ lookupEatBids } = await viteServer.ssrLoadModule('/db/eat-bid-service.ts'));
});

after(async () => {
  await viteServer?.close();
});

const successXml = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header>
  <body>
    <items>
      <item>
        <etnBidNo>BID-001</etnBidNo><bidNm>채소 공고</bidNm><etnBidSttNm>공고중</etnBidSttNm>
        <ancmDt>20260827</ancmDt><purrNm>서울교육청</purrNm><dmdOrganNm>한빛초등학교</dmdOrganNm>
        <bidBgngDt>20260827</bidBgngDt><bidEndDt>20260901</bidEndDt><bgngPrc>0010000</bgngPrc>
        <mesgSnItem>
          <mesgSnItemNo>
            <instNm>한빛초등학교</instNm><mesgClsfNm>감자</mesgClsfNm>
            <attrDItem>
              <attrDItemNo><foodNm>감자</foodNm><stdNm>국산</stdNm><untNm>kg</untNm><attrInfo>특</attrInfo><qty>0010</qty></attrDItemNo>
              <attrDItemNo><foodNm>양파</foodNm><stdNm>15kg</stdNm><untNm>망</untNm><qty>2</qty></attrDItemNo>
            </attrDItem>
          </mesgSnItemNo>
          <mesgSnItemNo>
            <instNm>한빛초등학교</instNm><mesgClsfNm>육류</mesgClsfNm>
            <attrDItem><attrDItemNo><foodNm>돼지고기</foodNm><stdNm>냉장</stdNm><untNm>kg</untNm><qty>8</qty></attrDItemNo></attrDItem>
          </mesgSnItemNo>
        </mesgSnItem>
      </item>
      <item><etnBidNo>BID-002</etnBidNo><bidNm>과일 공고</bidNm></item>
    </items>
    <numOfRows>0020</numOfRows><pageNo>0001</pageNo><totalCount>0002</totalCount>
  </body>
</response>`;

test('formats eAT date variants as YYYY-MM-DD without changing descriptive text', () => {
  assert.equal(formatEatDate('20260731'), '2026-07-31');
  assert.equal(formatEatDate('2026.08.20'), '2026-08-20');
  assert.equal(formatEatDate('2026-07-31 15:50:00.0'), '2026-07-31');
  assert.equal(formatEatDate('2026-07-31T15:50:00+09:00'), '2026-07-31');
  assert.equal(formatEatDate('2024-02-29'), '2024-02-29');
  assert.equal(formatEatDate('2026-02-29'), '2026-02-29');
  assert.equal(formatEatDate('2026-04-31'), '2026-04-31');
  assert.equal(formatEatDate('20260229'), '20260229');
  assert.equal(formatEatDate('2026.04.31'), '2026.04.31');
  assert.equal(formatEatDate('20260027'), '20260027');
  assert.equal(formatEatDate('2026.13.27'), '2026.13.27');
  assert.equal(formatEatDate('2026-08-27 예정'), '2026-08-27 예정');
  assert.equal(formatEatDate('현품설명서에 따름'), '현품설명서에 따름');
  assert.equal(formatEatDate(''), '-');
  assert.equal(formatEatDate('   '), '-');
});

test('parses repeated eAT announcement and item wrappers without losing leading zeroes', () => {
  const result = parseEatBidXml(successXml);
  assert.equal(result.total, 2);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 20);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].bidNo, 'BID-001');
  assert.equal(result.items[0].basePrice, '0010000');
  assert.equal(result.items[0].specs.length, 3);
  assert.equal(result.items[0].specs[0].quantity, '0010');
  assert.equal(result.items[0].specs[2].messageOrder, 2);
  assert.equal(result.items[1].specs.length, 0);
});

test('parses and preserves a zero-result eAT page', () => {
  const result = parseEatBidXml(`
    <response><header><resultCode>00</resultCode></header><body>
      <items/><numOfRows>20</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount>
    </body></response>
  `);
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
});

test('uses the requested page because eAT returns the total page count in pageNo', () => {
  const items = Array.from(
    { length: 5 },
    (_, index) => `<item><etnBidNo>BID-${index + 1}</etnBidNo></item>`,
  ).join('');
  const result = parseEatBidXml(`
    <response><header><resultCode>00</resultCode></header><body>
      <items>${items}</items><numOfRows>20</numOfRows><pageNo>20</pageNo><totalCount>385</totalCount>
    </body></response>
  `, { page: 20, pageSize: 20 });
  assert.equal(result.page, 20);
  assert.equal(result.pageSize, 20);
  assert.equal(result.total, 385);
  assert.equal(result.items.length, 5);
});

test('maps eAT NO_DATA_ERROR to an empty requested page only', () => {
  const result = parseEatBidXml(`
    <response><header><resultCode>5</resultCode><resultMsg>NO_DATA_ERROR</resultMsg></header></response>
  `, { page: 1, pageSize: 20 });
  assert.deepEqual(result, { total: 0, page: 1, pageSize: 20, items: [] });
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>5</resultCode><resultMsg>OTHER_ERROR</resultMsg></header></response>', { page: 1, pageSize: 20 }),
    (error) => error instanceof EatApiError && error.code === 'UPSTREAM_ERROR',
  );
});

test('rejects unsafe, malformed, and upstream-error XML', () => {
  assert.throws(
    () => parseEatBidXml('<!DOCTYPE response><response/>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
  assert.throws(
    () => parseEatBidXml('<response>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>22</resultCode></header></response>'),
    (error) => error instanceof EatApiError && error.code === 'UPSTREAM_ERROR',
  );
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>00</resultCode></header><body><items/><pageNo>0</pageNo><numOfRows>20</numOfRows><totalCount>0</totalCount></body></response>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
  for (const pagination of [
    '<pageNo>1</pageNo><numOfRows>20</numOfRows>',
    '<pageNo>1</pageNo><numOfRows>20</numOfRows><totalCount>NaN</totalCount>',
    '<pageNo>1.5</pageNo><numOfRows>20</numOfRows><totalCount>0</totalCount>',
    '<pageNo>1</pageNo><numOfRows>9007199254740992</numOfRows><totalCount>0</totalCount>',
  ]) {
    assert.throws(
      () => parseEatBidXml(`<response><header><resultCode>00</resultCode></header><body><items/>${pagination}</body></response>`),
      (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
    );
  }
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>00</resultCode></header><body><items><item><etnBidNo>DUP</etnBidNo></item><item><etnBidNo>DUP</etnBidNo></item></items><pageNo>1</pageNo><numOfRows>20</numOfRows><totalCount>2</totalCount></body></response>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>00</resultCode></header><body><items/><pageNo>1</pageNo><numOfRows>20</numOfRows><totalCount>10</totalCount></body></response>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
  assert.throws(
    () => parseEatBidXml('<response><header><resultCode>00</resultCode></header><body><items/><pageNo>2</pageNo><numOfRows>20</numOfRows><totalCount>20</totalCount></body></response>'),
    (error) => error instanceof EatApiError && error.code === 'INVALID_XML',
  );
});

test('normalizes raw and URL-encoded service keys exactly once', async () => {
  const query = {
    announcementStartDate: '2026-07-29',
    announcementEndDate: '2026-08-27',
    useOrganizationName: '교육청',
    demandOrganizationName: '',
    bidName: '',
    page: 1,
    pageSize: 20,
  };
  const rawServiceKey = 'sample+key/value==';

  for (const serviceKey of [rawServiceKey, 'sample%2Bkey%2Fvalue%3D%3D']) {
    await fetchEatBidPage(query, {
      serviceKey,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.searchParams.get('serviceKey'), rawServiceKey);
        assert.match(url.search, /serviceKey=sample%2Bkey%2Fvalue%3D%3D/);
        assert.doesNotMatch(url.search, /%252B|%252F|%253D/i);
        assert.equal(url.searchParams.get('ancmStsrDt'), '20260729');
        assert.equal(url.searchParams.get('ancmEndDt'), '20260827');
        assert.equal(url.searchParams.get('useOrganNm'), '교육청');
        assert.equal(url.searchParams.get('pageNo'), '1');
        assert.equal(url.searchParams.get('numOfRows'), '20');
        assert.equal(init.redirect, 'manual');
        assert.equal(Object.hasOwn(init, 'cache'), false);
        return new Response(successXml, { status: 200 });
      },
    });
  }

  await assert.rejects(
    fetchEatBidPage(query, { serviceKey: 'malformed%ZZ' }),
    (error) => error instanceof EatApiError && error.code === 'NOT_CONFIGURED',
  );
});

test('bounds streamed eAT bodies and keeps the timeout active until the body completes', async () => {
  const query = {
    announcementStartDate: '2026-08-01',
    announcementEndDate: '2026-08-27',
    useOrganizationName: '서울교육청',
    demandOrganizationName: '',
    bidName: '',
    page: 1,
    pageSize: 20,
  };
  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5_000_001));
      controller.close();
    },
  });
  await assert.rejects(
    fetchEatBidPage(query, {
      serviceKey: 'test-only-key',
      fetchImpl: async () => new Response(oversizedBody, { status: 200 }),
    }),
    (error) => error instanceof EatApiError && error.code === 'RESPONSE_TOO_LARGE',
  );

  let declaredOversizeCancelled = false;
  await assert.rejects(
    fetchEatBidPage(query, {
      serviceKey: 'test-only-key',
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { declaredOversizeCancelled = true; },
      }), { status: 200, headers: { 'Content-Length': '5000001' } }),
    }),
    (error) => error instanceof EatApiError && error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(declaredOversizeCancelled, true);

  let httpErrorCancelled = false;
  await assert.rejects(
    fetchEatBidPage(query, {
      serviceKey: 'test-only-key',
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { httpErrorCancelled = true; },
      }), { status: 503 }),
    }),
    (error) => error instanceof EatApiError && error.code === 'HTTP' && error.status === 503,
  );
  assert.equal(httpErrorCancelled, true);

  await assert.rejects(
    fetchEatBidPage(query, {
      serviceKey: 'test-only-key',
      timeoutMilliseconds: 20,
      fetchImpl: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      }), { status: 200 }),
    }),
    (error) => error instanceof EatApiError && error.code === 'TIMEOUT',
  );
});

test('normalizes valid search parameters and enforces the calendar three-month boundary', () => {
  const parameters = new URLSearchParams({
    announcementStartDate: '2026-01-31',
    announcementEndDate: '2026-04-30',
    useOrganizationName: '  서울   교육청  ',
    demandOrganizationName: ' 한빛초 ',
  });
  const parsed = parseEatBidQuery(parameters);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.query.useOrganizationName, '서울 교육청');
  assert.equal(parsed.query.page, 1);
  assert.equal(parsed.query.pageSize, 20);

  parameters.set('announcementEndDate', '2026-05-01');
  const tooLong = parseEatBidQuery(parameters);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, /최대 3개월/);
});

test('uses the database after one eAT cache miss', async () => {
  const query = {
    announcementStartDate: '2026-08-01',
    announcementEndDate: '2026-08-27',
    useOrganizationName: '서울교육청',
    demandOrganizationName: '',
    bidName: '',
    page: 1,
    pageSize: 20,
  };
  let cache = null;
  let fetchCount = 0;
  let touchCount = 0;
  const dependencies = {
    findCache: async () => cache,
    fetchPage: async () => {
      fetchCount += 1;
      return parseEatBidXml(successXml);
    },
    replaceCache: async (_query, value) => {
      const publicItems = structuredClone(value.items);
      for (const item of publicItems) {
        delete item.rawPayload;
        for (const spec of item.specs) delete spec.rawPayload;
      }
      cache = {
        queryHash: 'a'.repeat(64),
        fresh: true,
        fetchedAt: '2026-08-27T01:00:00.000Z',
        expiresAt: '2026-08-27T07:00:00.000Z',
        total: value.total,
        page: 1,
        pageSize: 20,
        items: publicItems,
      };
      return cache;
    },
    touchCache: async () => { touchCount += 1; return true; },
    withLock: async (_key, callback) => callback(),
    ttlMinutes: 360,
  };

  const first = await lookupEatBids(query, dependencies);
  const second = await lookupEatBids(query, dependencies);
  assert.equal(first.source, 'EAT');
  assert.equal(second.source, 'CACHE');
  assert.equal(fetchCount, 1);
  assert.equal(touchCount, 1);
});

test('returns expired DB data when the eAT refresh fails', async () => {
  const stale = {
    queryHash: 'b'.repeat(64),
    fresh: false,
    fetchedAt: '2026-08-26T01:00:00.000Z',
    expiresAt: '2026-08-26T07:00:00.000Z',
    total: 0,
    page: 1,
    pageSize: 20,
    items: [],
  };
  const result = await lookupEatBids({
    announcementStartDate: '2026-08-01',
    announcementEndDate: '2026-08-27',
    useOrganizationName: '서울교육청',
    demandOrganizationName: '',
    bidName: '',
    page: 1,
    pageSize: 20,
  }, {
    findCache: async () => stale,
    fetchPage: async () => { throw new EatApiError('NETWORK', 'test-only failure'); },
    touchCache: async () => true,
    withLock: async (_key, callback) => callback(),
  });

  assert.equal(result.source, 'STALE_CACHE');
  assert.match(result.warning, /이전에 DB에 저장/);
});

test('does not misreport a database write failure as an eAT stale fallback', async () => {
  const stale = {
    queryHash: 'c'.repeat(64),
    fresh: false,
    fetchedAt: '2026-08-26T01:00:00.000Z',
    expiresAt: '2026-08-26T07:00:00.000Z',
    total: 0,
    page: 1,
    pageSize: 20,
    items: [],
  };
  await assert.rejects(
    lookupEatBids({
      announcementStartDate: '2026-08-01',
      announcementEndDate: '2026-08-27',
      useOrganizationName: '서울교육청',
      demandOrganizationName: '',
      bidName: '',
      page: 1,
      pageSize: 20,
    }, {
      findCache: async () => stale,
      fetchPage: async () => parseEatBidXml(successXml),
      replaceCache: async () => { throw new Error('test-only database failure'); },
      withLock: async (_key, callback) => callback(),
    }),
    /test-only database failure/,
  );
});
