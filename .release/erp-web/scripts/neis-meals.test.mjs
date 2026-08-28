import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let viteServer;
let NeisApiError;
let fetchNeisMeals;
let internalNeisHealth;
let lookupNeisMealsForBidder;
let NeisMealLookupError;
let parseNeisMealQuery;
let parseNeisMealResponse;

before(async () => {
  viteServer = await createServer({
    root: projectRoot,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': projectRoot } },
    server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: 'neis-cloudflare-test-double',
      enforce: 'pre',
      resolveId(source) {
        return source === 'cloudflare:workers' ? '\0neis-cloudflare-test-double' : null;
      },
      load(id) {
        return id === '\0neis-cloudflare-test-double'
          ? `export const env = { ERP_EMBEDDING_WORKER_TOKEN: '${'t'.repeat(32)}' }; export function waitUntil() {}`
          : null;
      },
    }],
  });
  ({ NeisApiError, fetchNeisMeals, parseNeisMealResponse } = await viteServer.ssrLoadModule('/db/neis-meal-client.ts'));
  ({ NeisMealLookupError, lookupNeisMealsForBidder } = await viteServer.ssrLoadModule('/db/neis-meal-service.ts'));
  ({ POST: internalNeisHealth } = await viteServer.ssrLoadModule('/app/api/internal/neis/health/route.ts'));
  ({ parseNeisMealQuery } = await viteServer.ssrLoadModule('/app/lib/neis-meal-validation.ts'));
});
after(async () => {
  await viteServer?.close();
});

const successPayload = {
  mealServiceDietInfo: [
    { head: [{ list_total_count: 1 }, { RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다.' } }] },
    {
      row: [{
        ATPT_OFCDC_SC_NM: '서울특별시교육청',
        SD_SCHUL_CODE: '7010001',
        SCHUL_NM: '별빛초등학교',
        MMEAL_SC_CODE: '2',
        MMEAL_SC_NM: '중식',
        MLSV_YMD: '20260828',
        MLSV_FGR: '755.00',
        DDISH_NM: '현미밥<br/>미역국 (5.6.)<br/>배추김치 (9.)',
        ORPLC_INFO: '쌀 : 국내산<br/>소고기 : 국내산',
        CAL_INFO: '612.3 Kcal',
        NTR_INFO: '탄수화물(g) : 91.2<br/>단백질(g) : 24.8',
        LOAD_DTM: '20260827',
      }],
    },
  ],
};

test('normalizes NEIS meal rows without rendering upstream HTML', () => {
  const result = parseNeisMealResponse(successPayload);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].serviceDate, '2026-08-28');
  assert.equal(result.items[0].servings, 755);
  assert.deepEqual(result.items[0].dishes, ['현미밥', '미역국 (5.6.)', '배추김치 (9.)']);
  assert.equal(result.items[0].originInfo, '쌀 : 국내산\n소고기 : 국내산');
  assert.equal(result.items[0].nutritionInfo, '탄수화물(g) : 91.2\n단백질(g) : 24.8');
});

test('maps the documented no-data response to an empty result', () => {
  assert.deepEqual(
    parseNeisMealResponse({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } }),
    { total: 0, items: [] },
  );
});

test('rejects malformed and upstream-error responses', () => {
  assert.throws(
    () => parseNeisMealResponse({}),
    (error) => error instanceof NeisApiError && error.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => parseNeisMealResponse({ RESULT: { CODE: 'ERROR-300', MESSAGE: '인증키 오류' } }),
    (error) => error instanceof NeisApiError && error.code === 'UPSTREAM_ERROR',
  );
  assert.throws(
    () => parseNeisMealResponse({
      mealServiceDietInfo: [
        { head: [{ list_total_count: 1 }, { RESULT: { CODE: 'INFO-000', MESSAGE: '정상' } }] },
        { row: [{ ...successPayload.mealServiceDietInfo[1].row[0], MLSV_YMD: '20260230' }] },
      ],
    }),
    (error) => error instanceof NeisApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('normalizes raw and encoded secrets once and sends them only to the HTTPS NEIS endpoint', async () => {
  const rawSecret = 'test+only/neis==';
  for (const configuredSecret of [rawSecret, 'test%2Bonly%2Fneis%3D%3D']) {
    const result = await fetchNeisMeals({
      officeCode: 'B10',
      schoolCode: '7010001',
      fromDate: '2026-08-28',
      toDate: '2026-08-31',
    }, {
      key: configuredSecret,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://open.neis.go.kr');
        assert.equal(url.pathname, '/hub/mealServiceDietInfo');
        assert.equal(url.searchParams.get('KEY'), rawSecret);
        assert.doesNotMatch(url.search, /%252B|%252F|%253D/i);
        assert.equal(url.searchParams.get('Type'), 'json');
        assert.equal(url.searchParams.get('pSize'), '100');
        assert.equal(url.searchParams.get('ATPT_OFCDC_SC_CODE'), 'B10');
        assert.equal(url.searchParams.get('SD_SCHUL_CODE'), '7010001');
        assert.equal(url.searchParams.get('MLSV_FROM_YMD'), '20260828');
        assert.equal(url.searchParams.get('MLSV_TO_YMD'), '20260831');
        assert.equal(init?.redirect, 'manual');
        assert.equal(init?.referrerPolicy, 'no-referrer');
        assert.equal(init?.headers?.['Accept-Encoding'], 'identity');
        return Response.json(successPayload);
      },
    });
    assert.equal(result.items.length, 1);
  }
});

test('requires the server-side key and validates date ranges before lookup', async () => {
  await assert.rejects(
    fetchNeisMeals({
      officeCode: 'B10',
      schoolCode: '7010001',
      fromDate: '2026-08-28',
      toDate: '2026-08-31',
    }),
    (error) => error instanceof NeisApiError && error.code === 'NOT_CONFIGURED',
  );

  const valid = parseNeisMealQuery(new URLSearchParams({
    schoolBidId: 'bid:2026-001',
    fromDate: '2026-08-01',
    toDate: '2026-08-31',
  }));
  assert.equal(valid.ok, true);
  assert.match(
    parseNeisMealQuery(new URLSearchParams({
      schoolBidId: 'bid:2026-001',
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    })).message,
    /최대 31일/,
  );
  assert.match(
    parseNeisMealQuery(new URLSearchParams({
      schoolBidId: '../unsafe',
      fromDate: '2026-08-01',
      toDate: '2026-08-02',
    })).message,
    /계약 학교/,
  );
});

test('protects the internal NEIS health endpoint with the existing worker bearer token', async () => {
  const response = await internalNeisHealth(new Request('http://localhost/api/internal/neis/health', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, message: '인증이 필요합니다.' });
});

test('enforces an owned qualifying contract and its date boundaries before upstream lookup', async () => {
  const school = {
    bidId: 'bid-2026-001',
    schoolId: 'school-001',
    schoolName: '별빛초등학교',
    officeCode: 'B10',
    schoolCode: '7010001',
    contractStart: '2026-03-01',
    contractEnd: '2027-02-28',
  };
  let requestedSchool = null;
  const dependencies = {
    findSchool: async (tenantId, schoolBidId) => {
      requestedSchool = { tenantId, schoolBidId };
      return schoolBidId === school.bidId ? school : undefined;
    },
    fetchMeals: async (query) => ({ total: 0, items: [], query }),
  };

  const result = await lookupNeisMealsForBidder({
    bidderTenantId: 'tenant-bidder',
    schoolBidId: school.bidId,
    fromDate: '2026-08-01',
    toDate: '2026-08-31',
  }, dependencies);
  assert.deepEqual(requestedSchool, { tenantId: 'tenant-bidder', schoolBidId: school.bidId });
  assert.equal(result.school.name, school.schoolName);

  await assert.rejects(
    lookupNeisMealsForBidder({
      bidderTenantId: 'tenant-bidder',
      schoolBidId: 'foreign-or-closed-bid',
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    }, dependencies),
    (error) => error instanceof NeisMealLookupError && error.status === 404,
  );
  await assert.rejects(
    lookupNeisMealsForBidder({
      bidderTenantId: 'tenant-bidder',
      schoolBidId: school.bidId,
      fromDate: '2027-02-01',
      toDate: '2027-03-01',
    }, dependencies),
    (error) => error instanceof NeisMealLookupError && error.status === 400,
  );
});
