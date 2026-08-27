import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERRUPTED_SYNC_MESSAGE,
  assertCompleteNeisPage,
  buildAdministrativeAreaMatcher,
  executeSchoolSyncPipeline,
  finalizeSchoolSync,
  markSchoolSyncFailed,
  parseNeisPage,
  payloadSha256,
  recoverInterruptedSchoolSyncRuns,
  toSchoolRecord,
} from './sync-neis-schools.mjs';

function payload(total, rows) {
  return {
    schoolInfo: [
      {
        head: [
          { list_total_count: total },
          { RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다.' } },
        ],
      },
      { row: rows },
    ],
  };
}

function schoolRow(overrides = {}) {
  return {
    ATPT_OFCDC_SC_CODE: 'K10',
    ATPT_OFCDC_SC_NM: '강원특별자치도교육청',
    SD_SCHUL_CODE: 'K100000001',
    SCHUL_NM: '한빛초등학교',
    ENG_SCHUL_NM: 'Hanbit Elementary School',
    SCHUL_KND_SC_NM: '초등학교',
    LCTN_SC_NM: '강원특별자치도',
    JU_ORG_NM: '강원특별자치도춘천교육지원청',
    FOND_SC_NM: '공립',
    ORG_RDNZC: '24200',
    ORG_RDNMA: '강원특별자치도 춘천시 중앙로 1',
    ORG_RDNDA: '',
    ORG_TELNO: '033-000-0000',
    ORG_FAXNO: '',
    HMPG_ADRES: 'https://example.edu',
    COEDU_SC_NM: '남여공학',
    DGHT_SC_NM: '주간',
    FOND_YMD: '19830301',
    FOAS_MEMRD: '0501',
    LOAD_DTM: '20260423',
    ...overrides,
  };
}

test('parses a normal NEIS response envelope', () => {
  const rows = [schoolRow()];
  assert.deepEqual(parseNeisPage(payload(12_668, rows)), { total: 12_668, rows });
});

test('rejects the five-row unauthenticated sample response', () => {
  assert.throws(
    () => assertCompleteNeisPage({ total: 12_668, rows: Array(5).fill({}) }, 1, 1_000),
    /sample rows.*NEIS_API_KEY/,
  );
});

test('maps current integrated province names and only safe old aliases', () => {
  const match = buildAdministrativeAreaMatcher([
    { code: '51110', full_name: '강원특별자치도 춘천시' },
    { code: '52180', full_name: '전북특별자치도 정읍시' },
    { code: '12110', full_name: '전남광주통합특별시 목포시' },
    { code: '12330', full_name: '전남광주통합특별시 광산구' },
  ]);
  assert.deepEqual(match('강원특별자치도 춘천시 중앙로 1'), {
    areaCode: '51110',
    mappingStatus: 'MAPPED',
  });
  assert.deepEqual(match('강원도 춘천시 중앙로 1'), {
    areaCode: '51110',
    mappingStatus: 'MAPPED',
  });
  assert.deepEqual(match('전라북도 정읍시 충정로 1'), {
    areaCode: '52180',
    mappingStatus: 'MAPPED',
  });
  assert.deepEqual(match('전남광주통합특별시 목포시 영산로 1'), {
    areaCode: '12110',
    mappingStatus: 'MAPPED',
  });
  assert.deepEqual(match('전라남도 목포시 영산로 1'), {
    areaCode: '12110',
    mappingStatus: 'MAPPED',
  });
  assert.deepEqual(match('광주광역시 광산구 광산로 1'), {
    areaCode: '12330',
    mappingStatus: 'MAPPED',
  });
});

test('uses the longest full administrative path', () => {
  const match = buildAdministrativeAreaMatcher([
    { code: '41110', full_name: '경기도 수원시' },
    { code: '41115', full_name: '경기도 수원시 팔달구' },
  ]);
  assert.deepEqual(match('경기도 수원시 팔달구 효원로 1'), {
    areaCode: '41115',
    mappingStatus: 'MAPPED',
  });
});

test('does not guess from a district-only or unknown address', () => {
  const match = buildAdministrativeAreaMatcher([
    { code: '11110', full_name: '서울특별시 종로구' },
  ]);
  assert.deepEqual(match('종로구 세종대로 1'), {
    areaCode: null,
    mappingStatus: 'UNMAPPED',
  });
  assert.deepEqual(match('주소 미상'), {
    areaCode: null,
    mappingStatus: 'UNMAPPED',
  });
});

test('marks an ambiguous equal-length full path for review', () => {
  const match = buildAdministrativeAreaMatcher([
    { code: '11110', full_name: '서울특별시 종로구' },
    { code: '99999', full_name: '서울특별시 종로구' },
  ]);
  assert.deepEqual(match('서울특별시 종로구 세종대로 1'), {
    areaCode: null,
    mappingStatus: 'REVIEW_REQUIRED',
  });
});

test('creates a stable school id and stores a deterministic full-payload hash', () => {
  const match = buildAdministrativeAreaMatcher([
    { code: '51110', full_name: '강원특별자치도 춘천시' },
  ]);
  const row = schoolRow();
  const record = toSchoolRecord(row, 'school-sync-test', match);
  assert.equal(record.id, 'school:NEIS_SCHOOL_INFO:K10:K100000001');
  assert.equal(record.source_updated_at, '20260423');
  assert.equal(record.source_payload.ATPT_OFCDC_SC_CODE, 'K10');
  assert.match(record.source_payload._PAYLOAD_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(record.source_payload._PAYLOAD_SHA256, payloadSha256(row));
});

test('failure finalization only updates the run record and never schools', async () => {
  const calls = [];
  const executor = {
    query(sql, values) {
      calls.push({ sql, values });
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
  };
  await markSchoolSyncFailed(executor, 'school-sync-test', {
    expectedCount: 12_668,
    processedCount: 1_000,
    mappedCount: 998,
  }, 'network failure');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE school_sync_runs/);
  assert.doesNotMatch(calls[0].sql, /UPDATE schools/);
  assert.equal(calls[0].values[4], 'network failure');
});

test('successful finalization waits for the second miss before deactivation', async () => {
  const calls = [];
  const responses = [
    { rows: [{ status: 'RUNNING' }] },
    { rows: [{ count: 2, mapped: 2 }] },
    {
      rows: [
        { id: 'first-miss', active: true, missing_sync_count: 0 },
        { id: 'second-miss', active: true, missing_sync_count: 1 },
      ],
    },
    { rows: [], rowCount: 2 },
    { rows: [], rowCount: 2 },
    { rows: [], rowCount: 1 },
  ];
  const executor = {
    query(sql, values) {
      calls.push({ sql, values });
      return Promise.resolve(responses.shift());
    },
  };
  const result = await finalizeSchoolSync(executor, {
    runId: 'school-sync-test',
    expectedCount: 2,
    processedCount: 2,
    mappedCount: 2,
    sourceDataVersion: '20260423',
  });
  assert.deepEqual(result, { unseenCount: 2, deactivatedCount: 1 });
  assert.match(calls[3].sql, /missing_sync_count = 0/);
  assert.match(calls[4].sql, /missing_sync_count \+ 1 >= 2 THEN FALSE/);
  assert.equal(calls[5].values[5], 1);
});

test('pipeline downloads and validates every page before one publication transaction starts', async () => {
  const events = [];
  const rows = [1, 2, 3, 4].map((number) => schoolRow({
    SD_SCHUL_CODE: `K10000000${number}`,
  }));
  const pages = [
    { total: 4, rows: rows.slice(0, 2) },
    { total: 4, rows: rows.slice(2) },
  ];
  const metrics = {
    runId: 'school-sync-atomic-test',
    expectedCount: null,
    processedCount: 0,
    mappedCount: 0,
    sourceDataVersion: null,
  };

  const result = await executeSchoolSyncPipeline({
    metrics,
    pageSize: 2,
    fetchPage: async (pageIndex) => {
      events.push(`fetch-${pageIndex}`);
      return pages[pageIndex - 1];
    },
    matchArea: () => ({ areaCode: '51110', mappingStatus: 'MAPPED' }),
    withPublicationTransaction: async (callback) => {
      events.push('transaction-begin');
      const value = await callback({});
      events.push('transaction-commit');
      return value;
    },
    upsertPage: async (_executor, records) => {
      events.push(`upsert-${records.at(0).source_school_code}`);
    },
    finalize: async () => {
      events.push('finalize');
      return { unseenCount: 0, deactivatedCount: 0 };
    },
    minimumExpectedCount: 1,
    maximumExpectedCount: 10,
  });

  assert.deepEqual(events, [
    'fetch-1',
    'fetch-2',
    'transaction-begin',
    'upsert-K100000001',
    'upsert-K100000003',
    'finalize',
    'transaction-commit',
  ]);
  assert.equal(result.snapshot.uniqueCount, 4);
  assert.equal(result.snapshot.metrics.processedCount, 4);
});

test('pipeline never starts publication when a downloaded page is incomplete', async () => {
  let publicationStarted = false;
  const metrics = {
    runId: 'school-sync-invalid-download-test',
    expectedCount: null,
    processedCount: 0,
    mappedCount: 0,
    sourceDataVersion: null,
  };
  const firstRows = [1, 2].map((number) => schoolRow({
    SD_SCHUL_CODE: `K10000000${number}`,
  }));

  await assert.rejects(() => executeSchoolSyncPipeline({
    metrics,
    pageSize: 2,
    fetchPage: async (pageIndex) => (pageIndex === 1
      ? { total: 4, rows: firstRows }
      : { total: 4, rows: [schoolRow({ SD_SCHUL_CODE: 'K100000003' })] }),
    matchArea: () => ({ areaCode: '51110', mappingStatus: 'MAPPED' }),
    withPublicationTransaction: async () => {
      publicationStarted = true;
    },
    minimumExpectedCount: 1,
    maximumExpectedCount: 10,
  }), /page 2 is incomplete/);
  assert.equal(publicationStarted, false);
});

test('a later publication page failure rolls back the single snapshot transaction', async () => {
  const rows = [1, 2, 3, 4].map((number) => schoolRow({
    SD_SCHUL_CODE: `K10000000${number}`,
  }));
  const committedSchoolCodes = [];
  let finalizeCalled = false;
  let transactionCount = 0;

  await assert.rejects(() => executeSchoolSyncPipeline({
    metrics: {
      runId: 'school-sync-rollback-test',
      expectedCount: null,
      processedCount: 0,
      mappedCount: 0,
      sourceDataVersion: null,
    },
    pageSize: 2,
    fetchPage: async (pageIndex) => ({
      total: 4,
      rows: pageIndex === 1 ? rows.slice(0, 2) : rows.slice(2),
    }),
    matchArea: () => ({ areaCode: '51110', mappingStatus: 'MAPPED' }),
    withPublicationTransaction: async (callback) => {
      transactionCount += 1;
      const workingSchoolCodes = [...committedSchoolCodes];
      const result = await callback({ workingSchoolCodes });
      committedSchoolCodes.splice(0, committedSchoolCodes.length, ...workingSchoolCodes);
      return result;
    },
    upsertPage: async (executor, records) => {
      executor.workingSchoolCodes.push(...records.map((record) => record.source_school_code));
      if (executor.workingSchoolCodes.length > 2) throw new Error('simulated page write failure');
    },
    finalize: async () => {
      finalizeCalled = true;
      return { unseenCount: 0, deactivatedCount: 0 };
    },
    minimumExpectedCount: 1,
    maximumExpectedCount: 10,
  }), /simulated page write failure/);
  assert.equal(transactionCount, 1);
  assert.deepEqual(committedSchoolCodes, []);
  assert.equal(finalizeCalled, false);
});

test('orphan recovery fails only prior running NEIS runs and excludes the current run', async () => {
  const rows = [
    { id: 'prior-running', source: 'NEIS_SCHOOL_INFO', status: 'RUNNING' },
    { id: 'current-running', source: 'NEIS_SCHOOL_INFO', status: 'RUNNING' },
    { id: 'prior-complete', source: 'NEIS_SCHOOL_INFO', status: 'COMPLETED' },
    { id: 'other-running', source: 'OTHER_SOURCE', status: 'RUNNING' },
  ];
  const executor = {
    query(sql, values) {
      const [source, currentRunId, message] = values;
      assert.match(sql, /status = 'FAILED'/);
      assert.match(sql, /status = 'RUNNING' AND id <> \$2/);
      assert.equal(message, INTERRUPTED_SYNC_MESSAGE);
      assert.ok(message.length <= 200);
      const recovered = rows.filter((row) => (
        row.source === source && row.status === 'RUNNING' && row.id !== currentRunId
      ));
      for (const row of recovered) {
        row.status = 'FAILED';
        row.errorMessage = message;
        row.completed = true;
      }
      return Promise.resolve({ rowCount: recovered.length, rows: recovered.map(({ id }) => ({ id })) });
    },
  };

  const result = await recoverInterruptedSchoolSyncRuns(executor, 'current-running');
  assert.deepEqual(result, {
    recoveredCount: 1,
    recoveredRunIds: ['prior-running'],
  });
  assert.equal(rows.find((row) => row.id === 'prior-running').status, 'FAILED');
  assert.equal(rows.find((row) => row.id === 'current-running').status, 'RUNNING');
  assert.equal(rows.find((row) => row.id === 'prior-complete').status, 'COMPLETED');
  assert.equal(rows.find((row) => row.id === 'other-running').status, 'RUNNING');
});
