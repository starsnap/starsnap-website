import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export const NEIS_SOURCE = 'NEIS_SCHOOL_INFO';
export const NEIS_ENDPOINT = 'https://open.neis.go.kr/hub/schoolInfo';
export const MIN_EXPECTED_SCHOOL_COUNT = 10_000;
export const MAX_EXPECTED_SCHOOL_COUNT = 25_000;
export const INTERRUPTED_SYNC_MESSAGE =
  '이전 NEIS 학교 동기화가 비정상 종료되어 새 실행 전에 FAILED로 복구되었습니다.';

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_RETRIES = 3;
const LOCK_KEY = 'starsnap-erp:schools:neis-school-info';
const REQUIRED_SCHEMA_VERSION = 14;

const SCHOOL_COLUMNS = new Map([
  ['id', 'text'],
  ['source', 'text'],
  ['source_office_code', 'text'],
  ['source_school_code', 'text'],
  ['name', 'text'],
  ['english_name', 'text'],
  ['school_kind', 'text'],
  ['education_office_name', 'text'],
  ['jurisdiction_org_name', 'text'],
  ['foundation_type', 'text'],
  ['location_name', 'text'],
  ['postal_code', 'text'],
  ['road_address', 'text'],
  ['road_detail_address', 'text'],
  ['phone', 'text'],
  ['fax', 'text'],
  ['homepage', 'text'],
  ['coeducation_type', 'text'],
  ['day_night_type', 'text'],
  ['foundation_date', 'text'],
  ['anniversary_date', 'text'],
  ['source_updated_at', 'text'],
  ['source_payload', 'jsonb'],
  ['area_code', 'text'],
  ['mapping_status', 'text'],
  ['active', 'boolean'],
  ['missing_sync_count', 'integer'],
  ['last_seen_run_id', 'text'],
  ['created_at', 'timestamp with time zone'],
  ['updated_at', 'timestamp with time zone'],
]);

const RUN_COLUMNS = new Map([
  ['id', 'text'],
  ['source', 'text'],
  ['source_data_version', 'text'],
  ['status', 'text'],
  ['expected_count', 'integer'],
  ['processed_count', 'integer'],
  ['mapped_count', 'integer'],
  ['deactivated_count', 'integer'],
  ['error_message', 'text'],
  ['started_at', 'timestamp with time zone'],
  ['completed_at', 'timestamp with time zone'],
]);

// These aliases only represent one-to-one province renames. The matcher never
// falls back to a bare city/district name, which could silently select the
// wrong region when names repeat across provinces.
const SAFE_PROVINCE_ALIASES = new Map([
  ['강원특별자치도', ['강원도']],
  ['전북특별자치도', ['전라북도']],
]);
const FORMER_GWANGJU_DISTRICTS = new Set(['동구', '서구', '남구', '북구', '광산구']);

function safeProvinceAliases(province, localName) {
  if (province === '전남광주통합특별시') {
    return [FORMER_GWANGJU_DISTRICTS.has(localName) ? '광주광역시' : '전라남도'];
  }
  return SAFE_PROVINCE_ALIASES.get(province) ?? [];
}

function boundedInteger(environment, name, fallback, minimum, maximum) {
  const configured = environment[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function configuredApiKey(environment) {
  const configured = environment.NEIS_API_KEY?.trim();
  if (!configured) {
    throw new Error('NEIS_API_KEY is required for a complete nationwide school sync.');
  }

  // data.go.kr exposes both encoded and decoded service-key forms. URLSearchParams
  // needs the decoded form; decode once only when percent escapes are present.
  let apiKey = configured;
  if (/%[0-9a-f]{2}/i.test(configured)) {
    try {
      apiKey = decodeURIComponent(configured);
    } catch {
      throw new Error('NEIS_API_KEY contains invalid percent encoding.');
    }
  }
  if (/\s/.test(apiKey)) throw new Error('NEIS_API_KEY must not contain whitespace.');
  return apiKey;
}

function poolConfig(environment) {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for the school sync.');
  return {
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 60_000,
    statement_timeout: 60_000,
    keepAlive: true,
    ssl: environment.PGSSL === 'require'
      ? { rejectUnauthorized: true, ca: environment.PGSSL_CA?.replaceAll('\\n', '\n') }
      : environment.PGSSL === 'insecure'
        ? { rejectUnauthorized: false }
        : undefined,
  };
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function optionalText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function requiredText(row, key) {
  const normalized = normalizeText(row?.[key]);
  if (!normalized) throw new Error(`NEIS row is missing required field ${key}.`);
  return normalized;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function payloadSha256(payload) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(payload))).digest('hex');
}

function neisResult(payload, head = []) {
  const topLevel = payload?.RESULT;
  if (topLevel && typeof topLevel === 'object') return topLevel;
  for (const entry of head) {
    if (entry?.RESULT && typeof entry.RESULT === 'object') return entry.RESULT;
  }
  return null;
}

export function parseNeisPage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('NEIS returned an invalid JSON document.');
  }

  const sections = payload.schoolInfo;
  const head = Array.isArray(sections)
    ? sections.find((section) => Array.isArray(section?.head))?.head ?? []
    : [];
  const result = neisResult(payload, head);
  if (result?.CODE && result.CODE !== 'INFO-000') {
    const message = normalizeText(result.MESSAGE).slice(0, 240) || 'unknown API error';
    throw new Error(`NEIS API rejected the request (${result.CODE}): ${message}`);
  }
  if (!Array.isArray(sections)) {
    throw new Error('NEIS response is missing the schoolInfo result set.');
  }

  const totalValue = head.find((entry) => entry?.list_total_count !== undefined)
    ?.list_total_count;
  const total = Number(totalValue);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('NEIS response is missing a valid list_total_count.');
  }
  const rows = sections.find((section) => Array.isArray(section?.row))?.row ?? [];
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('NEIS response contains an invalid school row set.');
  }
  return { total, rows };
}

export function assertCompleteNeisPage({ total, rows }, pageIndex, pageSize) {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error('NEIS page index must be positive.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error('NEIS page size must be between 1 and 1000.');
  }
  const offset = (pageIndex - 1) * pageSize;
  const expectedRows = Math.max(0, Math.min(pageSize, total - offset));
  if (rows.length === expectedRows) return;

  if (expectedRows > 5 && rows.length <= 5) {
    throw new Error(
      `NEIS returned only ${rows.length} sample rows for page ${pageIndex}; `
      + 'an authenticated full-data NEIS_API_KEY is required.',
    );
  }
  throw new Error(
    `NEIS page ${pageIndex} is incomplete: expected ${expectedRows} rows but received ${rows.length}.`,
  );
}

function addressHasPrefix(address, prefix) {
  return address === prefix || address.startsWith(`${prefix} `);
}

function chooseLongestMatch(address, candidates) {
  const matching = candidates.filter((candidate) => addressHasPrefix(address, candidate.prefix));
  if (matching.length === 0) return null;
  const longestLength = Math.max(...matching.map((candidate) => candidate.prefix.length));
  const longest = matching.filter((candidate) => candidate.prefix.length === longestLength);
  const codes = [...new Set(longest.map((candidate) => candidate.code))];
  if (codes.length !== 1) return { areaCode: null, mappingStatus: 'REVIEW_REQUIRED' };
  return { areaCode: codes[0], mappingStatus: 'MAPPED' };
}

export function buildAdministrativeAreaMatcher(areaRows) {
  if (!Array.isArray(areaRows) || areaRows.length === 0) {
    throw new Error('No active selectable administrative areas are available for school mapping.');
  }

  const current = [];
  const aliases = [];
  const codes = new Set();
  for (const row of areaRows) {
    const code = normalizeText(row?.code);
    const fullName = normalizeText(row?.full_name ?? row?.fullName);
    if (!code || !fullName) throw new Error('Administrative area rows require code and full_name.');
    if (codes.has(code)) throw new Error(`Administrative area code ${code} is duplicated.`);
    codes.add(code);
    current.push({ code, prefix: fullName });

    const [province, ...rest] = fullName.split(' ');
    for (const alias of safeProvinceAliases(province, rest[0])) {
      aliases.push({ code, prefix: [alias, ...rest].join(' ') });
    }
  }

  return (roadAddress) => {
    const address = normalizeText(roadAddress);
    if (!address) return { areaCode: null, mappingStatus: 'UNMAPPED' };
    // Current official names always win. Safe historical aliases are considered
    // only when no current full-name path matched at all.
    return chooseLongestMatch(address, current)
      ?? chooseLongestMatch(address, aliases)
      ?? { areaCode: null, mappingStatus: 'UNMAPPED' };
  };
}

export function toSchoolRecord(row, runId, matchArea) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('NEIS school row must be an object.');
  }
  const officeCode = requiredText(row, 'ATPT_OFCDC_SC_CODE').toUpperCase();
  const schoolCode = requiredText(row, 'SD_SCHUL_CODE').toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(officeCode)) throw new Error('NEIS office code has an invalid format.');
  if (!/^[A-Z0-9]{2,32}$/.test(schoolCode)) throw new Error('NEIS school code has an invalid format.');

  const roadAddress = requiredText(row, 'ORG_RDNMA');
  const mapping = matchArea(roadAddress);
  if (!['MAPPED', 'UNMAPPED', 'REVIEW_REQUIRED'].includes(mapping.mappingStatus)) {
    throw new Error('Administrative area matcher returned an invalid mapping status.');
  }
  if ((mapping.mappingStatus === 'MAPPED') !== Boolean(mapping.areaCode)) {
    throw new Error('Administrative area matcher returned an inconsistent area code.');
  }

  const sourcePayload = canonicalValue(row);
  const sourcePayloadHash = payloadSha256(sourcePayload);
  return {
    id: `school:${encodeURIComponent(NEIS_SOURCE)}:${encodeURIComponent(officeCode)}:${encodeURIComponent(schoolCode)}`,
    source: NEIS_SOURCE,
    source_office_code: officeCode,
    source_school_code: schoolCode,
    name: requiredText(row, 'SCHUL_NM'),
    english_name: optionalText(row.ENG_SCHUL_NM),
    school_kind: requiredText(row, 'SCHUL_KND_SC_NM'),
    education_office_name: optionalText(row.ATPT_OFCDC_SC_NM),
    jurisdiction_org_name: optionalText(row.JU_ORG_NM),
    foundation_type: optionalText(row.FOND_SC_NM),
    location_name: optionalText(row.LCTN_SC_NM),
    postal_code: optionalText(row.ORG_RDNZC),
    road_address: roadAddress,
    road_detail_address: optionalText(row.ORG_RDNDA),
    phone: optionalText(row.ORG_TELNO),
    fax: optionalText(row.ORG_FAXNO),
    homepage: optionalText(row.HMPG_ADRES),
    coeducation_type: optionalText(row.COEDU_SC_NM),
    day_night_type: optionalText(row.DGHT_SC_NM),
    foundation_date: optionalText(row.FOND_YMD),
    anniversary_date: optionalText(row.FOAS_MEMRD),
    source_updated_at: optionalText(row.LOAD_DTM),
    source_payload: {
      ...sourcePayload,
      _PAYLOAD_SHA256: sourcePayloadHash,
    },
    area_code: mapping.areaCode,
    mapping_status: mapping.mappingStatus,
    last_seen_run_id: runId,
  };
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 10_000);
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function fetchNeisPage({
  apiKey,
  pageIndex,
  pageSize,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  retries = DEFAULT_REQUEST_RETRIES,
}) {
  const endpoint = new URL(NEIS_ENDPOINT);
  endpoint.searchParams.set('KEY', apiKey);
  endpoint.searchParams.set('Type', 'json');
  endpoint.searchParams.set('pIndex', String(pageIndex));
  endpoint.searchParams.set('pSize', String(pageSize));

  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`NEIS request failed with HTTP ${response.status}.`);
        if (response.status === 429 || response.status >= 500) {
          lastError = error;
          if (attempt <= retries) {
            await sleep(retryDelay(response, attempt));
            continue;
          }
        }
        throw error;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('NEIS returned malformed JSON.', { cause: error });
      }
      return parseNeisPage(payload);
    } catch (error) {
      lastError = error;
      const retryable = error?.name === 'AbortError' || error instanceof TypeError;
      if (!retryable || attempt > retries) break;
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError?.name === 'AbortError') {
    throw new Error(`NEIS request timed out after ${timeoutMs}ms.`);
  }
  throw lastError ?? new Error('NEIS request failed.');
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function verifyColumns(rows, tableName, expectedColumns) {
  const actual = new Map(
    rows.filter((row) => row.table_name === tableName)
      .map((row) => [row.column_name, row.data_type]),
  );
  const problems = [];
  for (const [name, expectedType] of expectedColumns) {
    if (!actual.has(name)) problems.push(`missing ${name}`);
    else if (actual.get(name) !== expectedType) {
      problems.push(`${name} is ${actual.get(name)}, expected ${expectedType}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Database table ${tableName} does not match schema v14: ${problems.join('; ')}.`);
  }
}

export async function validateSchoolSyncSchema(executor) {
  const version = await executor.query('SELECT MAX(version)::integer AS version FROM schema_migrations');
  if ((version.rows[0]?.version ?? 0) < REQUIRED_SCHEMA_VERSION) {
    throw new Error(`PostgreSQL schema v${REQUIRED_SCHEMA_VERSION} or later is required for school sync.`);
  }
  const columns = await executor.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [['school_sync_runs', 'schools']],
  );
  verifyColumns(columns.rows, 'school_sync_runs', RUN_COLUMNS);
  verifyColumns(columns.rows, 'schools', SCHOOL_COLUMNS);
}

async function acquireSyncLock(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      throw new Error('Another NEIS school sync is already running.');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseSyncLock(client) {
  if (!client) return;
  try {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]);
  } finally {
    client.release();
  }
}

async function loadAreaMatcher(executor) {
  const result = await executor.query(
    `SELECT code, full_name
     FROM administrative_areas
     WHERE active = TRUE AND selectable = TRUE
     ORDER BY char_length(full_name) DESC, code`,
  );
  return buildAdministrativeAreaMatcher(result.rows);
}

async function createSyncRun(executor, runId) {
  await executor.query(
    `INSERT INTO school_sync_runs
       (id, source, status, expected_count, processed_count, mapped_count,
        deactivated_count, started_at)
     VALUES ($1, $2, 'RUNNING', NULL, 0, 0, 0, clock_timestamp())`,
    [runId, NEIS_SOURCE],
  );
}

export async function recoverInterruptedSchoolSyncRuns(executor, currentRunId) {
  const result = await executor.query(
    `UPDATE school_sync_runs
     SET status = 'FAILED', deactivated_count = 0, error_message = $3,
         completed_at = clock_timestamp()
     WHERE source = $1 AND status = 'RUNNING' AND id <> $2
     RETURNING id`,
    [NEIS_SOURCE, currentRunId, INTERRUPTED_SYNC_MESSAGE],
  );
  return {
    recoveredCount: result.rowCount ?? result.rows.length,
    recoveredRunIds: result.rows.map((row) => row.id),
  };
}

export async function upsertSchoolPage(executor, records, metrics) {
  if (records.length === 0) return;
  await executor.query(
    `INSERT INTO schools (
       id, source, source_office_code, source_school_code, name, english_name,
       school_kind, education_office_name, jurisdiction_org_name, foundation_type,
       location_name, postal_code, road_address, road_detail_address, phone, fax,
       homepage, coeducation_type, day_night_type, foundation_date, anniversary_date,
       source_updated_at, source_payload, area_code, mapping_status, active,
       missing_sync_count, last_seen_run_id, created_at, updated_at
     )
     SELECT
       item.id, item.source, item.source_office_code, item.source_school_code,
       item.name, item.english_name, item.school_kind, item.education_office_name,
       item.jurisdiction_org_name, item.foundation_type, item.location_name,
       item.postal_code, item.road_address, item.road_detail_address, item.phone,
       item.fax, item.homepage, item.coeducation_type, item.day_night_type,
       item.foundation_date, item.anniversary_date, item.source_updated_at,
       item.source_payload, item.area_code, item.mapping_status, FALSE, 0,
       item.last_seen_run_id, clock_timestamp(), clock_timestamp()
     FROM jsonb_to_recordset($1::jsonb) AS item(
       id TEXT, source TEXT, source_office_code TEXT, source_school_code TEXT,
       name TEXT, english_name TEXT, school_kind TEXT, education_office_name TEXT,
       jurisdiction_org_name TEXT, foundation_type TEXT, location_name TEXT,
       postal_code TEXT, road_address TEXT, road_detail_address TEXT, phone TEXT,
       fax TEXT, homepage TEXT, coeducation_type TEXT, day_night_type TEXT,
       foundation_date TEXT, anniversary_date TEXT, source_updated_at TEXT,
       source_payload JSONB, area_code TEXT, mapping_status TEXT,
       last_seen_run_id TEXT
     )
     ON CONFLICT (source, source_office_code, source_school_code) DO UPDATE SET
       name = EXCLUDED.name,
       english_name = EXCLUDED.english_name,
       school_kind = EXCLUDED.school_kind,
       education_office_name = EXCLUDED.education_office_name,
       jurisdiction_org_name = EXCLUDED.jurisdiction_org_name,
       foundation_type = EXCLUDED.foundation_type,
       location_name = EXCLUDED.location_name,
       postal_code = EXCLUDED.postal_code,
       road_address = EXCLUDED.road_address,
       road_detail_address = EXCLUDED.road_detail_address,
       phone = EXCLUDED.phone,
       fax = EXCLUDED.fax,
       homepage = EXCLUDED.homepage,
       coeducation_type = EXCLUDED.coeducation_type,
       day_night_type = EXCLUDED.day_night_type,
       foundation_date = EXCLUDED.foundation_date,
       anniversary_date = EXCLUDED.anniversary_date,
       source_updated_at = EXCLUDED.source_updated_at,
       source_payload = EXCLUDED.source_payload,
       area_code = EXCLUDED.area_code,
       mapping_status = EXCLUDED.mapping_status,
       last_seen_run_id = EXCLUDED.last_seen_run_id,
       updated_at = clock_timestamp()`,
    [JSON.stringify(records)],
  );
  await executor.query(
    `UPDATE school_sync_runs
     SET expected_count = $2, processed_count = $3, mapped_count = $4
     WHERE id = $1 AND status = 'RUNNING'`,
    [metrics.runId, metrics.expectedCount, metrics.processedCount, metrics.mappedCount],
  );
}

export async function markSchoolSyncFailed(executor, runId, metrics, errorMessage) {
  // Deliberately touches only the run record. In particular, a failed or partial
  // run never deactivates schools that were not present in downloaded pages.
  return executor.query(
    `UPDATE school_sync_runs
     SET status = 'FAILED', expected_count = $2, processed_count = $3,
         mapped_count = $4, deactivated_count = 0, error_message = $5,
         completed_at = clock_timestamp()
     WHERE id = $1 AND status = 'RUNNING'`,
    [runId, metrics.expectedCount, metrics.processedCount, metrics.mappedCount, errorMessage],
  );
}

export async function finalizeSchoolSync(executor, metrics) {
  const run = await executor.query(
    `SELECT status FROM school_sync_runs WHERE id = $1 FOR UPDATE`,
    [metrics.runId],
  );
  if (run.rows[0]?.status !== 'RUNNING') throw new Error('School sync run is not in RUNNING state.');

  const actual = await executor.query(
    `SELECT count(*)::integer AS count,
            count(*) FILTER (WHERE mapping_status = 'MAPPED')::integer AS mapped
     FROM schools
     WHERE source = $1 AND last_seen_run_id = $2`,
    [NEIS_SOURCE, metrics.runId],
  );
  const storedCount = actual.rows[0]?.count ?? 0;
  const storedMapped = actual.rows[0]?.mapped ?? 0;
  if (storedCount !== metrics.expectedCount || storedCount !== metrics.processedCount) {
    throw new Error(
      `Refusing school sync finalization: expected ${metrics.expectedCount}, `
      + `processed ${metrics.processedCount}, stored ${storedCount}.`,
    );
  }
  if (storedMapped !== metrics.mappedCount) {
    throw new Error(
      `Refusing school sync finalization: mapped count is ${storedMapped}, expected ${metrics.mappedCount}.`,
    );
  }

  const unseen = await executor.query(
    `SELECT id, active, missing_sync_count
     FROM schools
     WHERE source = $1 AND last_seen_run_id <> $2
     FOR UPDATE`,
    [NEIS_SOURCE, metrics.runId],
  );
  const deactivatedCount = unseen.rows.filter(
    (school) => school.active && school.missing_sync_count + 1 >= 2,
  ).length;
  await executor.query(
    `UPDATE schools
     SET active = TRUE, missing_sync_count = 0, updated_at = clock_timestamp()
     WHERE source = $1 AND last_seen_run_id = $2`,
    [NEIS_SOURCE, metrics.runId],
  );
  await executor.query(
    `UPDATE schools
     SET missing_sync_count = missing_sync_count + 1,
         active = CASE WHEN missing_sync_count + 1 >= 2 THEN FALSE ELSE active END,
         updated_at = clock_timestamp()
     WHERE source = $1 AND last_seen_run_id <> $2`,
    [NEIS_SOURCE, metrics.runId],
  );
  await executor.query(
    `UPDATE school_sync_runs
     SET source_data_version = $2, status = 'COMPLETED', expected_count = $3,
         processed_count = $4, mapped_count = $5, deactivated_count = $6,
         error_message = NULL, completed_at = clock_timestamp()
     WHERE id = $1 AND status = 'RUNNING'`,
    [
      metrics.runId,
      metrics.sourceDataVersion,
      metrics.expectedCount,
      metrics.processedCount,
      metrics.mappedCount,
      deactivatedCount,
    ],
  );
  return { unseenCount: unseen.rows.length, deactivatedCount };
}

function redactError(error, apiKey) {
  let message = error instanceof Error ? error.message : String(error);
  const variants = [apiKey, encodeURIComponent(apiKey)].filter(Boolean);
  for (const secret of variants) message = message.replaceAll(secret, '[REDACTED]');
  return normalizeText(message).slice(0, 2_000) || 'Unknown school sync error.';
}

function logEvent(event, detail = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'neis-school-sync',
    event,
    ...detail,
  }));
}

export async function downloadNeisSchoolSnapshot({
  metrics,
  pageSize,
  fetchPage,
  matchArea,
  logger = () => undefined,
  minimumExpectedCount = MIN_EXPECTED_SCHOOL_COUNT,
  maximumExpectedCount = MAX_EXPECTED_SCHOOL_COUNT,
}) {
  if (!metrics?.runId) throw new Error('School sync metrics require a runId.');
  if (minimumExpectedCount < 1 || maximumExpectedCount < minimumExpectedCount) {
    throw new Error('School sync count bounds are invalid.');
  }

  metrics.expectedCount = null;
  metrics.processedCount = 0;
  metrics.mappedCount = 0;
  metrics.sourceDataVersion = null;
  const pages = [];
  const seenSchoolCodes = new Set();
  let pageIndex = 1;
  let totalPages = 1;
  logger('download-started', { runId: metrics.runId, pageSize });

  while (pageIndex <= totalPages) {
    const page = await fetchPage(pageIndex);
    if (pageIndex === 1) {
      if (page.total < minimumExpectedCount) {
        throw new Error(
          `NEIS reported only ${page.total} schools; refusing an incomplete nationwide sync.`,
        );
      }
      if (page.total > maximumExpectedCount) {
        throw new Error(
          `NEIS reported ${page.total} schools, above the ${maximumExpectedCount} row memory safety limit.`,
        );
      }
      metrics.expectedCount = page.total;
      totalPages = Math.ceil(page.total / pageSize);
    } else if (page.total !== metrics.expectedCount) {
      throw new Error(
        `NEIS total changed during sync from ${metrics.expectedCount} to ${page.total}.`,
      );
    }
    assertCompleteNeisPage(page, pageIndex, pageSize);

    const records = page.rows.map((row) => {
      const record = toSchoolRecord(row, metrics.runId, matchArea);
      if (seenSchoolCodes.has(record.source_school_code)) {
        throw new Error(`NEIS school code ${record.source_school_code} appeared more than once.`);
      }
      seenSchoolCodes.add(record.source_school_code);
      if (
        record.source_updated_at
        && (!metrics.sourceDataVersion
          || record.source_updated_at.localeCompare(metrics.sourceDataVersion) > 0)
      ) {
        metrics.sourceDataVersion = record.source_updated_at;
      }
      return record;
    });
    pages.push(records);
    metrics.processedCount += records.length;
    metrics.mappedCount += records.filter((record) => record.mapping_status === 'MAPPED').length;
    logger('download-page-completed', {
      runId: metrics.runId,
      pageIndex,
      totalPages,
      downloadedCount: metrics.processedCount,
      mappedCount: metrics.mappedCount,
    });
    pageIndex += 1;
  }

  if (
    metrics.processedCount !== metrics.expectedCount
    || seenSchoolCodes.size !== metrics.expectedCount
  ) {
    throw new Error(
      `NEIS count mismatch: expected ${metrics.expectedCount}, processed ${metrics.processedCount}, `
      + `unique ${seenSchoolCodes.size}.`,
    );
  }
  logger('download-completed', {
    runId: metrics.runId,
    pageCount: pages.length,
    downloadedCount: metrics.processedCount,
    uniqueCount: seenSchoolCodes.size,
  });
  return { pages, metrics, uniqueCount: seenSchoolCodes.size };
}

export async function publishNeisSchoolSnapshot(
  executor,
  snapshot,
  {
    logger = () => undefined,
    upsertPage = upsertSchoolPage,
    finalize = finalizeSchoolSync,
  } = {},
) {
  const { pages, metrics, uniqueCount } = snapshot;
  const bufferedCount = pages.reduce((sum, records) => sum + records.length, 0);
  if (
    bufferedCount !== metrics.expectedCount
    || uniqueCount !== metrics.expectedCount
    || metrics.processedCount !== metrics.expectedCount
  ) {
    throw new Error('Refusing to publish a school snapshot that did not pass full count validation.');
  }

  logger('publish-started', {
    runId: metrics.runId,
    pageCount: pages.length,
    expectedCount: metrics.expectedCount,
  });
  let publishedCount = 0;
  let publishedMappedCount = 0;
  for (const [index, records] of pages.entries()) {
    publishedCount += records.length;
    publishedMappedCount += records.filter(
      (record) => record.mapping_status === 'MAPPED',
    ).length;
    await upsertPage(executor, records, {
      ...metrics,
      processedCount: publishedCount,
      mappedCount: publishedMappedCount,
    });
    logger('publish-page-completed', {
      runId: metrics.runId,
      pageIndex: index + 1,
      totalPages: pages.length,
      publishedCount,
      mappedCount: publishedMappedCount,
    });
  }
  const finalization = await finalize(executor, metrics);
  logger('publish-completed', {
    runId: metrics.runId,
    publishedCount,
    mappedCount: publishedMappedCount,
  });
  return finalization;
}

export async function executeSchoolSyncPipeline({
  metrics,
  pageSize,
  fetchPage,
  matchArea,
  withPublicationTransaction,
  logger = () => undefined,
  minimumExpectedCount = MIN_EXPECTED_SCHOOL_COUNT,
  maximumExpectedCount = MAX_EXPECTED_SCHOOL_COUNT,
  upsertPage = upsertSchoolPage,
  finalize = finalizeSchoolSync,
}) {
  const snapshot = await downloadNeisSchoolSnapshot({
    metrics,
    pageSize,
    fetchPage,
    matchArea,
    logger,
    minimumExpectedCount,
    maximumExpectedCount,
  });
  const finalization = await withPublicationTransaction((executor) => (
    publishNeisSchoolSnapshot(executor, snapshot, { logger, upsertPage, finalize })
  ));
  return { snapshot, finalization };
}

export async function runSchoolSync({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  logger = logEvent,
} = {}) {
  const apiKey = configuredApiKey(environment);
  const pageSize = boundedInteger(environment, 'NEIS_PAGE_SIZE', DEFAULT_PAGE_SIZE, 100, 1_000);
  const timeoutMs = boundedInteger(
    environment,
    'NEIS_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    1_000,
    120_000,
  );
  const retries = boundedInteger(
    environment,
    'NEIS_REQUEST_RETRIES',
    DEFAULT_REQUEST_RETRIES,
    0,
    5,
  );
  const pool = new Pool(poolConfig(environment));
  pool.on('error', (error) => logger('database-idle-error', { message: redactError(error, apiKey) }));

  const runId = `school-sync-${randomUUID()}`;
  const metrics = {
    runId,
    expectedCount: null,
    processedCount: 0,
    mappedCount: 0,
    sourceDataVersion: null,
  };
  let lockClient;
  let runCreated = false;

  try {
    lockClient = await acquireSyncLock(pool);
    await validateSchoolSyncSchema(pool);
    const recovery = await recoverInterruptedSchoolSyncRuns(pool, runId);
    if (recovery.recoveredCount > 0) {
      logger('interrupted-runs-recovered', {
        recoveredCount: recovery.recoveredCount,
      });
    }
    await createSyncRun(pool, runId);
    runCreated = true;
    logger('sync-started', { runId, pageSize });
    const matchArea = await loadAreaMatcher(pool);
    const { finalization } = await executeSchoolSyncPipeline({
      metrics,
      pageSize,
      fetchPage: (pageIndex) => fetchNeisPage({
        apiKey,
        pageIndex,
        pageSize,
        fetchImpl,
        timeoutMs,
        retries,
      }),
      matchArea,
      withPublicationTransaction: (callback) => withTransaction(pool, callback),
      logger,
    });
    logger('sync-completed', {
      runId,
      expectedCount: metrics.expectedCount,
      processedCount: metrics.processedCount,
      mappedCount: metrics.mappedCount,
      unmappedCount: metrics.processedCount - metrics.mappedCount,
      deactivatedCount: finalization.deactivatedCount,
      unseenCount: finalization.unseenCount,
      sourceDataVersion: metrics.sourceDataVersion,
    });
    return { ...metrics, ...finalization };
  } catch (error) {
    const message = redactError(error, apiKey);
    if (runCreated) {
      try {
        await markSchoolSyncFailed(pool, runId, metrics, message);
      } catch (failureUpdateError) {
        logger('failure-record-update-failed', {
          runId,
          message: redactError(failureUpdateError, apiKey),
        });
      }
    }
    logger('sync-failed', {
      runId,
      processedCount: metrics.processedCount,
      mappedCount: metrics.mappedCount,
      message,
    });
    throw new Error(message, { cause: error });
  } finally {
    await releaseSyncLock(lockClient).catch((error) => {
      logger('lock-release-failed', { runId, message: redactError(error, apiKey) });
    });
    await pool.end();
  }
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runSchoolSync().catch((error) => {
    console.error(`School sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
