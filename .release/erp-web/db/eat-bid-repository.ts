import type { PoolClient } from 'pg';
import type {
  EatBidAnnouncement,
  EatBidItemSpec,
  EatBidQuery,
} from '@/app/lib/eat-bid-types';
import { normalizeEatDeliveryRegionCodes } from '@/app/lib/eat-delivery-region';
import { ensureDatabase } from './bootstrap';
import { queryAll, queryOne, withTransaction } from './postgres';

export interface EatBidItemSpecCacheInput extends EatBidItemSpec {
  rawPayload?: Record<string, unknown>;
}

export interface EatBidAnnouncementCacheInput extends Omit<EatBidAnnouncement, 'specs'> {
  specs: readonly EatBidItemSpecCacheInput[];
  rawPayload?: Record<string, unknown>;
}

export interface EatBidCacheValueInput {
  total: number;
  items: readonly EatBidAnnouncementCacheInput[];
}

export interface EatBidCacheWriteOptions {
  fetchedAt?: string;
  generationId: string;
}

export interface EatBidCacheBatchEntry {
  query: EatBidQuery;
  value: EatBidCacheValueInput;
}

export interface EatBidCacheHit {
  queryHash: string;
  fresh: boolean;
  generationId: string | null;
  fetchedAt: string;
  expiresAt: string;
  total: number;
  page: number;
  pageSize: number;
  items: EatBidAnnouncement[];
}

interface EatBidCacheMetadataRow {
  fresh: boolean;
  generationId: string | null;
  fetchedAt: string;
  expiresAt: string;
  total: number;
  page: number;
  pageSize: number;
}

type EatBidAnnouncementRow = Omit<EatBidAnnouncement, 'specs'> & { position: number };
type EatBidItemSpecRow = EatBidItemSpec & { bidNo: string };

interface CacheTimingRow {
  fetchedAt: string;
  expiresAt: string;
}

interface PreparedAnnouncement {
  bid_no: string;
  bid_name: string;
  status_name: string;
  announcement_date: string;
  announcement_time: string;
  purchasing_organization_name: string;
  demand_organization_name: string;
  bid_start_date: string;
  bid_end_date: string;
  bid_open_date: string;
  bid_open_time: string;
  delivery_start_date: string;
  delivery_end_date: string;
  delivery_address: string;
  base_price_text: string;
  item_name: string;
  raw_payload: Record<string, unknown>;
}

interface PreparedItemSpec {
  spec_id: string;
  bid_no: string;
  message_order: number;
  item_order: number;
  inst_name: string;
  item_name: string;
  food_name: string;
  specification: string;
  unit_name: string;
  attributes: string;
  quantity_text: string;
  raw_payload: Record<string, unknown>;
}

const QUERY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CACHE_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_COMPACT_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_DASHED_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SENSITIVE_RAW_KEY_PATTERN = /(servicekey|authorization|apikey)/;
const REQUEST_URL_KEY_PATTERN = /^(full)?request(url|uri|href)$/;

function normalizeText(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function sourceText(value: string | null | undefined) {
  return (value ?? '').normalize('NFC');
}

function requiredText(value: string | null | undefined, label: string) {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`${label} 값이 비어 있습니다.`);
  return normalized;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 값은 1 이상의 정수여야 합니다.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 값은 0 이상의 정수여야 합니다.`);
  }
  return value;
}

function normalizeDate(value: string, label: string) {
  const input = value.trim();
  const matched = DATE_DASHED_PATTERN.exec(input) ?? DATE_COMPACT_PATTERN.exec(input);
  if (!matched) throw new Error(`${label} 형식은 YYYY-MM-DD 또는 YYYYMMDD여야 합니다.`);
  const [, year, month, day] = matched;
  const canonical = `${year}-${month}-${day}`;
  const parsed = new Date(`${canonical}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== canonical) {
    throw new Error(`${label} 값이 유효한 날짜가 아닙니다.`);
  }
  return canonical;
}

export function normalizeEatBidQuery(query: EatBidQuery): EatBidQuery {
  if (query.cacheScope && query.cacheScope !== 'REGIONAL_SCAN_V1') {
    throw new Error('eAT 내부 캐시 범위가 올바르지 않습니다.');
  }
  const deliveryRegion = normalizeEatDeliveryRegionCodes(
    query.deliveryProvinceCode,
    query.deliveryAreaCode,
  );
  const normalized: EatBidQuery = {
    announcementStartDate: normalizeDate(query.announcementStartDate, '공고 시작일'),
    announcementEndDate: normalizeDate(query.announcementEndDate, '공고 종료일'),
    useOrganizationName: requiredText(query.useOrganizationName, '이용기관명'),
    demandOrganizationName: normalizeText(query.demandOrganizationName),
    bidName: normalizeText(query.bidName),
    ...deliveryRegion,
    ...(query.cacheScope ? { cacheScope: query.cacheScope } : {}),
    page: positiveInteger(query.page, '페이지'),
    pageSize: positiveInteger(query.pageSize, '페이지 크기'),
  };
  if (normalized.announcementStartDate > normalized.announcementEndDate) {
    throw new Error('공고 시작일은 종료일보다 늦을 수 없습니다.');
  }
  return normalized;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function eatBidQueryHash(query: EatBidQuery) {
  const normalized = normalizeEatBidQuery(query);
  if (normalized.deliveryProvinceCode) {
    throw new Error('납품 지역 필터는 eAT 원본 페이지 캐시 키로 사용할 수 없습니다.');
  }
  const canonical = JSON.stringify({
    announcementStartDate: normalized.announcementStartDate,
    announcementEndDate: normalized.announcementEndDate,
    useOrganizationName: normalized.useOrganizationName,
    demandOrganizationName: normalized.demandOrganizationName,
    bidName: normalized.bidName,
    ...(normalized.cacheScope ? { cacheScope: normalized.cacheScope } : {}),
    page: normalized.page,
    pageSize: normalized.pageSize,
  });
  return sha256(canonical);
}

export async function eatBidSpecId(
  bidNo: string,
  messageOrder: number,
  itemOrder: number,
) {
  const canonical = JSON.stringify({
    bidNo: requiredText(bidNo, '입찰 공고번호'),
    messageOrder: nonNegativeInteger(messageOrder, '현품 메시지 순번'),
    itemOrder: nonNegativeInteger(itemOrder, '현품 항목 순번'),
  });
  return `eat-spec:${await sha256(canonical)}`;
}

function normalizedRawKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function redactServiceKeyInString(value: string) {
  return value.replace(
    /((?:serviceKey|service_key)(?:=|%3D))[^&#\s]*/gi,
    '$1[REDACTED]',
  );
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactServiceKeyInString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeJsonValue(item, seen))
        .filter((item) => item !== undefined);
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = normalizedRawKey(key);
      if (
        SENSITIVE_RAW_KEY_PATTERN.test(normalizedKey)
        || REQUEST_URL_KEY_PATTERN.test(normalizedKey)
      ) continue;
      const next = sanitizeJsonValue(item, seen);
      if (next !== undefined) sanitized[key] = next;
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

function sanitizeRawPayload(value: Record<string, unknown> | undefined) {
  const sanitized = sanitizeJsonValue(value ?? {}, new WeakSet());
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

async function prepareCacheValue(value: EatBidCacheValueInput) {
  const total = nonNegativeInteger(value.total, '전체 입찰 공고 수');
  if (value.items.length > total) {
    throw new Error('현재 페이지의 입찰 공고 수가 전체 공고 수보다 많습니다.');
  }
  const bidNumbers = new Set<string>();
  const announcements: PreparedAnnouncement[] = [];
  const itemSpecs: PreparedItemSpec[] = [];
  const publicItems: EatBidAnnouncement[] = [];

  for (const announcement of value.items) {
    const bidNo = requiredText(announcement.bidNo, '입찰 공고번호');
    if (bidNumbers.has(bidNo)) {
      throw new Error(`${bidNo} 입찰 공고가 같은 페이지에 중복되어 있습니다.`);
    }
    bidNumbers.add(bidNo);
    const positions = new Set<string>();
    const publicSpecs: EatBidItemSpec[] = [];
    for (const spec of announcement.specs) {
      const messageOrder = nonNegativeInteger(spec.messageOrder, '현품 메시지 순번');
      const itemOrder = nonNegativeInteger(spec.itemOrder, '현품 항목 순번');
      const position = `${messageOrder}:${itemOrder}`;
      if (positions.has(position)) {
        throw new Error(`${bidNo} 공고의 현품 순번 ${position}이 중복되어 있습니다.`);
      }
      positions.add(position);
      const specId = await eatBidSpecId(bidNo, messageOrder, itemOrder);
      const preparedSpec: PreparedItemSpec = {
        spec_id: specId,
        bid_no: bidNo,
        message_order: messageOrder,
        item_order: itemOrder,
        inst_name: sourceText(spec.orderingInstitutionName),
        item_name: sourceText(spec.itemName),
        food_name: sourceText(spec.foodName),
        specification: sourceText(spec.specification),
        unit_name: sourceText(spec.unitName),
        attributes: sourceText(spec.attributes),
        quantity_text: sourceText(spec.quantity),
        raw_payload: sanitizeRawPayload(spec.rawPayload),
      };
      itemSpecs.push(preparedSpec);
      publicSpecs.push({
        id: preparedSpec.spec_id,
        messageOrder: preparedSpec.message_order,
        itemOrder: preparedSpec.item_order,
        orderingInstitutionName: preparedSpec.inst_name,
        itemName: preparedSpec.item_name,
        foodName: preparedSpec.food_name,
        specification: preparedSpec.specification,
        unitName: preparedSpec.unit_name,
        attributes: preparedSpec.attributes,
        quantity: preparedSpec.quantity_text,
      });
    }

    const prepared: PreparedAnnouncement = {
      bid_no: bidNo,
      bid_name: sourceText(announcement.bidName),
      status_name: sourceText(announcement.statusName),
      announcement_date: sourceText(announcement.announcementDate),
      announcement_time: sourceText(announcement.announcementTime),
      purchasing_organization_name: sourceText(announcement.purchasingOrganizationName),
      demand_organization_name: sourceText(announcement.demandOrganizationName),
      bid_start_date: sourceText(announcement.bidStartDate),
      bid_end_date: sourceText(announcement.bidEndDate),
      bid_open_date: sourceText(announcement.bidOpenDate),
      bid_open_time: sourceText(announcement.bidOpenTime),
      delivery_start_date: sourceText(announcement.deliveryStartDate),
      delivery_end_date: sourceText(announcement.deliveryEndDate),
      delivery_address: sourceText(announcement.deliveryAddress),
      base_price_text: sourceText(announcement.basePrice),
      item_name: sourceText(announcement.itemName),
      raw_payload: sanitizeRawPayload(announcement.rawPayload),
    };
    announcements.push(prepared);
    publicItems.push({
      bidNo: prepared.bid_no,
      bidName: prepared.bid_name,
      statusName: prepared.status_name,
      announcementDate: prepared.announcement_date,
      announcementTime: prepared.announcement_time,
      purchasingOrganizationName: prepared.purchasing_organization_name,
      demandOrganizationName: prepared.demand_organization_name,
      bidStartDate: prepared.bid_start_date,
      bidEndDate: prepared.bid_end_date,
      bidOpenDate: prepared.bid_open_date,
      bidOpenTime: prepared.bid_open_time,
      deliveryStartDate: prepared.delivery_start_date,
      deliveryEndDate: prepared.delivery_end_date,
      deliveryAddress: prepared.delivery_address,
      basePrice: prepared.base_price_text,
      itemName: prepared.item_name,
      specs: publicSpecs,
    });
  }

  return { total, announcements, itemSpecs, publicItems };
}

async function readCacheItems(client: PoolClient, queryHash: string) {
  const announcements = await queryAll<EatBidAnnouncementRow>(
    `SELECT announcement.bid_no AS "bidNo", announcement.bid_name AS "bidName",
       announcement.status_name AS "statusName",
       announcement.announcement_date AS "announcementDate",
       announcement.announcement_time AS "announcementTime",
       announcement.purchasing_organization_name AS "purchasingOrganizationName",
       announcement.demand_organization_name AS "demandOrganizationName",
       announcement.bid_start_date AS "bidStartDate",
       announcement.bid_end_date AS "bidEndDate",
       announcement.bid_open_date AS "bidOpenDate",
       announcement.bid_open_time AS "bidOpenTime",
       announcement.delivery_start_date AS "deliveryStartDate",
       announcement.delivery_end_date AS "deliveryEndDate",
       announcement.delivery_address AS "deliveryAddress",
       announcement.base_price_text AS "basePrice", announcement.item_name AS "itemName",
       result.position
     FROM eat_bid_query_results result
     JOIN eat_bid_announcements announcement
       ON announcement.query_hash = result.query_hash
      AND announcement.bid_no = result.bid_no
     WHERE result.query_hash = $1
     ORDER BY result.position`,
    [queryHash],
    client,
  );
  if (announcements.length === 0) return [];
  const specs = await queryAll<EatBidItemSpecRow>(
    `SELECT spec.bid_no AS "bidNo", spec.spec_id AS id,
       spec.message_order AS "messageOrder", spec.item_order AS "itemOrder",
       spec.inst_name AS "orderingInstitutionName", spec.item_name AS "itemName",
       spec.food_name AS "foodName", spec.specification, spec.unit_name AS "unitName",
       spec.attributes, spec.quantity_text AS quantity
     FROM eat_bid_item_specs spec
     WHERE spec.query_hash = $1
     ORDER BY spec.bid_no, spec.message_order, spec.item_order`,
    [queryHash],
    client,
  );
  const specsByBid = new Map<string, EatBidItemSpec[]>();
  for (const spec of specs) {
    const { bidNo, ...item } = spec;
    const bidSpecs = specsByBid.get(bidNo) ?? [];
    bidSpecs.push(item);
    specsByBid.set(bidNo, bidSpecs);
  }
  return announcements.map((announcement): EatBidAnnouncement => ({
    bidNo: announcement.bidNo,
    bidName: announcement.bidName,
    statusName: announcement.statusName,
    announcementDate: announcement.announcementDate,
    announcementTime: announcement.announcementTime,
    purchasingOrganizationName: announcement.purchasingOrganizationName,
    demandOrganizationName: announcement.demandOrganizationName,
    bidStartDate: announcement.bidStartDate,
    bidEndDate: announcement.bidEndDate,
    bidOpenDate: announcement.bidOpenDate,
    bidOpenTime: announcement.bidOpenTime,
    deliveryStartDate: announcement.deliveryStartDate,
    deliveryEndDate: announcement.deliveryEndDate,
    deliveryAddress: announcement.deliveryAddress,
    basePrice: announcement.basePrice,
    itemName: announcement.itemName,
    specs: specsByBid.get(announcement.bidNo) ?? [],
  }));
}

export async function findEatBidCache(query: EatBidQuery): Promise<EatBidCacheHit | null> {
  const normalized = normalizeEatBidQuery(query);
  const queryHash = await eatBidQueryHash(normalized);
  await ensureDatabase();
  return withTransaction(async (client) => {
    const metadata = await queryOne<EatBidCacheMetadataRow>(
      `SELECT expires_at > clock_timestamp() AS fresh,
         normalized_filters->>'cacheGeneration' AS "generationId",
         fetched_at::text AS "fetchedAt", expires_at::text AS "expiresAt",
         total_count AS total, page, page_size AS "pageSize"
       FROM eat_bid_query_cache
       WHERE query_hash = $1`,
      [queryHash],
      client,
    );
    if (!metadata) return null;
    const items = await readCacheItems(client, queryHash);
    return { queryHash, ...metadata, items };
  }, 'REPEATABLE READ');
}

interface PreparedCachePage {
  normalized: EatBidQuery;
  queryHash: string;
  prepared: Awaited<ReturnType<typeof prepareCacheValue>>;
}

interface NormalizedCacheWriteOptions {
  requestedFetchedAt: string | null;
  generationId: string | null;
}

function validateCacheTtlMinutes(ttlMinutes: number) {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error('eAT 캐시 TTL은 0보다 큰 분 단위 값이어야 합니다.');
  }
}

function normalizeCacheWriteOptions(
  writeOptions?: EatBidCacheWriteOptions,
): NormalizedCacheWriteOptions {
  if (!writeOptions) {
    return { requestedFetchedAt: null, generationId: null };
  }
  const parsedFetchedAt = writeOptions.fetchedAt
    ? new Date(writeOptions.fetchedAt)
    : null;
  if (
    (parsedFetchedAt && Number.isNaN(parsedFetchedAt.valueOf()))
    || !CACHE_GENERATION_PATTERN.test(writeOptions.generationId)
  ) {
    throw new Error('eAT 지역 캐시 세대 정보가 올바르지 않습니다.');
  }
  return {
    requestedFetchedAt: parsedFetchedAt?.toISOString() ?? null,
    generationId: writeOptions.generationId,
  };
}

async function prepareCachePage(
  query: EatBidQuery,
  value: EatBidCacheValueInput,
): Promise<PreparedCachePage> {
  const normalized = normalizeEatBidQuery(query);
  const queryHash = await eatBidQueryHash(normalized);
  const prepared = await prepareCacheValue(value);
  return { normalized, queryHash, prepared };
}

async function cacheTiming(
  client: PoolClient,
  ttlMinutes: number,
  requestedFetchedAt: string | null,
) {
  const timing = await queryOne<CacheTimingRow>(
    `SELECT moment::text AS "fetchedAt",
       (moment + ($1::double precision * interval '1 minute'))::text AS "expiresAt"
     FROM (SELECT COALESCE($2::timestamptz, clock_timestamp()) AS moment) timing`,
    [ttlMinutes, requestedFetchedAt],
    client,
  );
  if (!timing) throw new Error('eAT 캐시 저장 시간을 생성하지 못했습니다.');
  return timing;
}

async function writePreparedCachePage(
  client: PoolClient,
  page: PreparedCachePage,
  timing: CacheTimingRow,
  generationId: string | null,
): Promise<EatBidCacheHit> {
  const { normalized, queryHash, prepared } = page;
  const normalizedFilters = {
    useOrganizationName: normalized.useOrganizationName,
    demandOrganizationName: normalized.demandOrganizationName,
    bidName: normalized.bidName,
    cacheScope: normalized.cacheScope ?? null,
    cacheGeneration: generationId,
  };

  await client.query(
    `INSERT INTO eat_bid_query_cache (
       query_hash, normalized_filters, start_date, end_date, page, page_size,
       total_count, fetched_at, expires_at, last_accessed_at
     ) VALUES ($1, $2::jsonb, $3::date, $4::date, $5, $6, $7,
       $8::timestamptz, $9::timestamptz, $8::timestamptz)
     ON CONFLICT (query_hash) DO UPDATE SET
       normalized_filters = EXCLUDED.normalized_filters,
       start_date = EXCLUDED.start_date,
       end_date = EXCLUDED.end_date,
       page = EXCLUDED.page,
       page_size = EXCLUDED.page_size,
       total_count = EXCLUDED.total_count,
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at,
       last_accessed_at = EXCLUDED.last_accessed_at`,
    [queryHash, JSON.stringify(normalizedFilters), normalized.announcementStartDate,
      normalized.announcementEndDate, normalized.page, normalized.pageSize,
      prepared.total, timing.fetchedAt, timing.expiresAt],
  );

  await client.query(
    'DELETE FROM eat_bid_announcements WHERE query_hash = $1',
    [queryHash],
  );

  const bidNumbers = prepared.announcements.map((announcement) => announcement.bid_no);
  if (bidNumbers.length > 0) {
    await client.query(
      `INSERT INTO eat_bid_announcements (
         query_hash, bid_no, bid_name, status_name, announcement_date,
         announcement_time, purchasing_organization_name,
         demand_organization_name, bid_start_date, bid_end_date, bid_open_date,
         bid_open_time, delivery_start_date, delivery_end_date, delivery_address,
         base_price_text, item_name, raw_payload, fetched_at, updated_at
       )
       SELECT $2, incoming.bid_no, incoming.bid_name, incoming.status_name,
         incoming.announcement_date, incoming.announcement_time,
         incoming.purchasing_organization_name, incoming.demand_organization_name,
         incoming.bid_start_date, incoming.bid_end_date, incoming.bid_open_date,
         incoming.bid_open_time, incoming.delivery_start_date, incoming.delivery_end_date,
         incoming.delivery_address, incoming.base_price_text, incoming.item_name,
         incoming.raw_payload, $3::timestamptz, $3::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         bid_no text, bid_name text, status_name text, announcement_date text,
         announcement_time text, purchasing_organization_name text,
         demand_organization_name text, bid_start_date text, bid_end_date text,
         bid_open_date text, bid_open_time text, delivery_start_date text,
         delivery_end_date text, delivery_address text, base_price_text text,
         item_name text, raw_payload jsonb
       )`,
      [JSON.stringify(prepared.announcements), queryHash, timing.fetchedAt],
    );
    if (prepared.itemSpecs.length > 0) {
      await client.query(
        `INSERT INTO eat_bid_item_specs (
           query_hash, spec_id, bid_no, message_order, item_order, inst_name,
           item_name, food_name, specification, unit_name, attributes,
           quantity_text, raw_payload
         )
         SELECT $2, incoming.spec_id, incoming.bid_no, incoming.message_order,
           incoming.item_order, incoming.inst_name, incoming.item_name,
           incoming.food_name, incoming.specification, incoming.unit_name,
           incoming.attributes, incoming.quantity_text, incoming.raw_payload
         FROM jsonb_to_recordset($1::jsonb) AS incoming(
           spec_id text, bid_no text, message_order integer, item_order integer,
           inst_name text, item_name text, food_name text, specification text,
           unit_name text, attributes text, quantity_text text, raw_payload jsonb
         )`,
        [JSON.stringify(prepared.itemSpecs), queryHash],
      );
    }
    await client.query(
      `INSERT INTO eat_bid_query_results (query_hash, bid_no, position)
       SELECT $1, bid_no, (ordinality - 1)::integer
       FROM unnest($2::text[]) WITH ORDINALITY AS result(bid_no, ordinality)`,
      [queryHash, bidNumbers],
    );
  }
  return {
    queryHash,
    fresh: true,
    generationId,
    fetchedAt: timing.fetchedAt,
    expiresAt: timing.expiresAt,
    total: prepared.total,
    page: normalized.page,
    pageSize: normalized.pageSize,
    items: prepared.publicItems,
  };
}

export async function replaceEatBidCache(
  query: EatBidQuery,
  value: EatBidCacheValueInput,
  ttlMinutes: number,
  writeOptions?: EatBidCacheWriteOptions,
): Promise<EatBidCacheHit> {
  validateCacheTtlMinutes(ttlMinutes);
  const page = await prepareCachePage(query, value);
  const options = normalizeCacheWriteOptions(writeOptions);
  await ensureDatabase();
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`eat-bid-query:${page.queryHash}`],
    );
    const timing = await cacheTiming(client, ttlMinutes, options.requestedFetchedAt);
    return writePreparedCachePage(client, page, timing, options.generationId);
  });
}

export async function replaceEatBidCacheBatch(
  entries: readonly EatBidCacheBatchEntry[],
  ttlMinutes: number,
  writeOptions: EatBidCacheWriteOptions,
): Promise<EatBidCacheHit[]> {
  validateCacheTtlMinutes(ttlMinutes);
  if (entries.length === 0) {
    throw new Error('eAT 캐시 배치에는 하나 이상의 페이지가 필요합니다.');
  }
  const options = normalizeCacheWriteOptions(writeOptions);
  const pages = await Promise.all(entries.map(({ query, value }) => (
    prepareCachePage(query, value)
  )));
  const queryHashes = pages.map((page) => page.queryHash).sort();
  if (new Set(queryHashes).size !== queryHashes.length) {
    throw new Error('eAT 캐시 배치에 같은 조회 페이지가 중복되어 있습니다.');
  }

  await ensureDatabase();
  return withTransaction(async (client) => {
    for (const queryHash of queryHashes) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`eat-bid-query:${queryHash}`],
      );
    }
    const timing = await cacheTiming(client, ttlMinutes, options.requestedFetchedAt);
    const stored: EatBidCacheHit[] = [];
    for (const page of pages) {
      stored.push(await writePreparedCachePage(
        client,
        page,
        timing,
        options.generationId,
      ));
    }
    return stored;
  });
}

export async function touchEatBidCacheAccess(queryOrHash: EatBidQuery | string) {
  const queryHash = typeof queryOrHash === 'string'
    ? queryOrHash
    : await eatBidQueryHash(queryOrHash);
  if (!QUERY_HASH_PATTERN.test(queryHash)) {
    throw new Error('유효한 eAT 조회 캐시 해시가 아닙니다.');
  }
  await ensureDatabase();
  const touched = await queryOne<{ queryHash: string }>(
    `UPDATE eat_bid_query_cache
     SET last_accessed_at = GREATEST(last_accessed_at, clock_timestamp())
     WHERE query_hash = $1
     RETURNING query_hash AS "queryHash"`,
    [queryHash],
  );
  return Boolean(touched);
}
