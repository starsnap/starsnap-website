import { env } from 'cloudflare:workers';
import type {
  EatBidAnnouncement,
  EatBidLookupResponse,
  EatBidQuery,
} from '@/app/lib/eat-bid-types';
import {
  effectiveEatDeliveryRegionCodes,
  hasEatDeliveryRegionFilter,
  matchesEatDeliveryRegions,
} from '@/app/lib/eat-delivery-region';
import { fetchEatBidPage } from './eat-api-client';
import {
  eatBidQueryHash,
  findEatBidCache,
  normalizeEatBidQuery,
  replaceEatBidCache,
  replaceEatBidCacheBatch,
  touchEatBidCacheAccess,
  type EatBidCacheHit,
} from './eat-bid-repository';
import { withAdvisoryLock } from './postgres';

interface EatServiceBindings {
  EAT_CACHE_TTL_MINUTES?: string;
}

interface EatBidServiceDependencies {
  findCache: typeof findEatBidCache;
  fetchPage: typeof fetchEatBidPage;
  replaceCache: typeof replaceEatBidCache;
  replaceCacheBatch: typeof replaceEatBidCacheBatch;
  touchCache: typeof touchEatBidCacheAccess;
  withLock: typeof withAdvisoryLock;
  ttlMinutes: number;
}

const regionalScanPageSize = 50;
const regionalScanMaxItems = 1_000;
const regionalScanConcurrency = 2;

export class EatBidRegionLookupError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
    this.name = 'EatBidRegionLookupError';
  }
}

function configuredTtlMinutes() {
  const value = Number((env as unknown as EatServiceBindings).EAT_CACHE_TTL_MINUTES);
  return Number.isFinite(value) && value >= 5 && value <= 1_440 ? value : 360;
}

function isoTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('eAT 캐시 저장 시각이 올바르지 않습니다.');
  return parsed.toISOString();
}

function responseFromCache(
  query: EatBidQuery,
  cache: EatBidCacheHit,
  source: EatBidLookupResponse['source'],
): EatBidLookupResponse {
  return {
    query,
    source,
    cachedAt: isoTimestamp(cache.fetchedAt),
    expiresAt: isoTimestamp(cache.expiresAt),
    total: cache.total,
    page: cache.page,
    pageSize: cache.pageSize,
    items: cache.items,
    ...(source === 'STALE_CACHE'
      ? { warning: 'eAT 실시간 조회에 실패해 이전에 DB에 저장한 결과를 표시합니다.' }
      : {}),
  };
}

const defaultDependencies: EatBidServiceDependencies = {
  findCache: findEatBidCache,
  fetchPage: fetchEatBidPage,
  replaceCache: replaceEatBidCache,
  replaceCacheBatch: replaceEatBidCacheBatch,
  touchCache: touchEatBidCacheAccess,
  withLock: withAdvisoryLock,
  ttlMinutes: configuredTtlMinutes(),
};

async function touchCacheSafely(
  touchCache: EatBidServiceDependencies['touchCache'],
  queryHash: string,
) {
  try {
    await touchCache(queryHash);
  } catch (error) {
    console.warn('eAT cache access timestamp update failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function regionalScanLockKey(query: EatBidQuery) {
  const baseQueryHash = await eatBidQueryHash(upstreamPageQuery(query, 1));
  return `eat-bid-regional-scan:${baseQueryHash}`;
}

async function pageRefreshLockKey(query: EatBidQuery, queryHash: string) {
  return query.cacheScope === 'REGIONAL_SCAN_V1'
    ? regionalScanLockKey(query)
    : `eat-bid-refresh:${queryHash}`;
}

async function lookupEatBidPage(
  query: EatBidQuery,
  dependencies: EatBidServiceDependencies,
) {
  const initialCache = await dependencies.findCache(query);
  if (initialCache?.fresh) {
    await touchCacheSafely(dependencies.touchCache, initialCache.queryHash);
    return responseFromCache(query, initialCache, 'CACHE');
  }

  const queryHash = initialCache?.queryHash ?? await eatBidQueryHash(query);
  const refreshLockKey = await pageRefreshLockKey(query, queryHash);
  return dependencies.withLock(refreshLockKey, async () => {
    const refreshedCache = await dependencies.findCache(query);
    if (refreshedCache?.fresh) {
      await touchCacheSafely(dependencies.touchCache, refreshedCache.queryHash);
      return responseFromCache(query, refreshedCache, 'CACHE');
    }

    let upstream: Awaited<ReturnType<typeof fetchEatBidPage>>;
    try {
      upstream = await dependencies.fetchPage(query);
    } catch (error) {
      const staleCache = refreshedCache ?? initialCache;
      if (staleCache) {
        await touchCacheSafely(dependencies.touchCache, staleCache.queryHash);
        return responseFromCache(query, staleCache, 'STALE_CACHE');
      }
      throw error;
    }
    const stored = await dependencies.replaceCache(
      query,
      { total: upstream.total, items: upstream.items },
      dependencies.ttlMinutes,
    );
    return responseFromCache(query, stored, 'EAT');
  });
}

function upstreamPageQuery(query: EatBidQuery, page: number): EatBidQuery {
  return {
    ...query,
    deliveryProvinceCode: '',
    deliveryAreaCode: '',
    deliveryRegionCodes: [],
    cacheScope: 'REGIONAL_SCAN_V1',
    page,
    pageSize: regionalScanPageSize,
  };
}

function expectedPageItemCount(total: number, page: number) {
  if (total === 0) return 0;
  return page * regionalScanPageSize <= total
    ? regionalScanPageSize
    : total - ((page - 1) * regionalScanPageSize);
}

function assertRegionalScanPage(
  response: Pick<EatBidLookupResponse, 'total' | 'page' | 'pageSize' | 'items'>,
  page: number,
  total: number,
) {
  if (
    response.page !== page
    || response.pageSize !== regionalScanPageSize
    || response.total !== total
    || response.items.length !== expectedPageItemCount(total, page)
  ) {
    throw new EatBidRegionLookupError(
      'eAT 지역 검색 원본이 조회 중 변경되었습니다. 잠시 후 다시 검색해 주세요.',
      502,
    );
  }
}

function assertRegionalScanLimit(total: number) {
  if (total > regionalScanMaxItems) {
    throw new EatBidRegionLookupError(
      `지역 검색 대상이 ${regionalScanMaxItems.toLocaleString('ko-KR')}건을 초과합니다. 이용기관명, 수요기관·학교명 또는 공고명을 더 구체적으로 입력해 주세요.`,
      400,
    );
  }
}

interface RegionalAccumulator {
  bidNumbers: Set<string>;
  filteredTotal: number;
  items: EatBidAnnouncement[];
}

interface RegionalCacheSnapshot {
  allFresh: boolean;
  queryHashes: string[];
  response: EatBidLookupResponse;
}

class EatBidRegionCachePublishError extends Error {
  constructor(readonly originalError: unknown) {
    super('eAT 지역 캐시를 저장하지 못했습니다.');
    this.name = 'EatBidRegionCachePublishError';
  }
}

function createRegionalAccumulator(): RegionalAccumulator {
  return { bidNumbers: new Set(), filteredTotal: 0, items: [] };
}

function collectRegionalPage(
  query: EatBidQuery,
  response: Pick<EatBidLookupResponse, 'total' | 'page' | 'pageSize' | 'items'>,
  page: number,
  total: number,
  accumulator: RegionalAccumulator,
) {
  assertRegionalScanPage(response, page, total);
  const resultOffset = (query.page - 1) * query.pageSize;
  const resultEnd = resultOffset + query.pageSize;
  for (const item of response.items) {
    if (accumulator.bidNumbers.has(item.bidNo)) {
      throw new EatBidRegionLookupError(
        'eAT 지역 검색 원본에 중복 공고가 포함되었습니다. 잠시 후 다시 검색해 주세요.',
        502,
      );
    }
    accumulator.bidNumbers.add(item.bidNo);
    if (!matchesEatDeliveryRegions(
      item,
      effectiveEatDeliveryRegionCodes(query),
    )) continue;
    if (
      accumulator.filteredTotal >= resultOffset
      && accumulator.filteredTotal < resultEnd
    ) {
      accumulator.items.push(item);
    }
    accumulator.filteredTotal += 1;
  }
}

function regionalResponse(
  query: EatBidQuery,
  accumulator: RegionalAccumulator,
  source: EatBidLookupResponse['source'],
  cachedAt: string,
  expiresAt: string,
): EatBidLookupResponse {
  return {
    query,
    source,
    cachedAt,
    expiresAt,
    total: accumulator.filteredTotal,
    page: query.page,
    pageSize: query.pageSize,
    items: accumulator.items,
    ...(source === 'STALE_CACHE'
      ? { warning: 'eAT 실시간 조회에 실패해 동일 시점에 DB에 저장한 전체 결과를 표시합니다.' }
      : {}),
  };
}

function earlierTimestamp(current: string, candidate: string) {
  const normalized = isoTimestamp(candidate);
  return !current || normalized < current ? normalized : current;
}

async function readRegionalCacheSnapshot(
  query: EatBidQuery,
  dependencies: EatBidServiceDependencies,
): Promise<RegionalCacheSnapshot | null> {
  const first = await dependencies.findCache(upstreamPageQuery(query, 1));
  if (!first?.generationId) return null;
  assertRegionalScanLimit(first.total);
  const generationId = first.generationId;
  const generationFetchedAt = isoTimestamp(first.fetchedAt);
  const generationExpiresAt = isoTimestamp(first.expiresAt);
  const pageCount = Math.max(1, Math.ceil(first.total / regionalScanPageSize));
  const accumulator = createRegionalAccumulator();
  const queryHashes = [first.queryHash];
  let allFresh = first.fresh;
  let cachedAt = generationFetchedAt;
  let expiresAt = generationExpiresAt;
  try {
    collectRegionalPage(query, first, 1, first.total, accumulator);
  } catch (error) {
    if (error instanceof EatBidRegionLookupError && error.status === 502) return null;
    throw error;
  }

  for (let page = 2; page <= pageCount; page += regionalScanConcurrency) {
    const batch = Array.from(
      { length: Math.min(regionalScanConcurrency, pageCount - page + 1) },
      (_, offset) => page + offset,
    );
    const hits = await Promise.all(batch.map((pageNumber) => (
      dependencies.findCache(upstreamPageQuery(query, pageNumber))
    )));
    for (const [index, hit] of hits.entries()) {
      const pageNumber = batch[index];
      if (
        !hit
        || hit.generationId !== generationId
        || isoTimestamp(hit.fetchedAt) !== generationFetchedAt
        || isoTimestamp(hit.expiresAt) !== generationExpiresAt
      ) {
        return null;
      }
      try {
        collectRegionalPage(query, hit, pageNumber, first.total, accumulator);
      } catch (error) {
        if (error instanceof EatBidRegionLookupError && error.status === 502) return null;
        throw error;
      }
      queryHashes.push(hit.queryHash);
      allFresh = allFresh && hit.fresh;
      cachedAt = earlierTimestamp(cachedAt, hit.fetchedAt);
      expiresAt = earlierTimestamp(expiresAt, hit.expiresAt);
    }
  }

  return {
    allFresh,
    queryHashes,
    response: regionalResponse(
      query,
      accumulator,
      allFresh ? 'CACHE' : 'STALE_CACHE',
      cachedAt,
      expiresAt,
    ),
  };
}

async function touchRegionalSnapshot(
  snapshot: RegionalCacheSnapshot,
  dependencies: EatBidServiceDependencies,
) {
  await Promise.all(snapshot.queryHashes.map((queryHash) => (
    touchCacheSafely(dependencies.touchCache, queryHash)
  )));
}

async function refreshRegionalCacheSnapshot(
  query: EatBidQuery,
  dependencies: EatBidServiceDependencies,
) {
  const firstQuery = upstreamPageQuery(query, 1);
  const first = await dependencies.fetchPage(firstQuery);
  assertRegionalScanLimit(first.total);
  const pageCount = Math.max(1, Math.ceil(first.total / regionalScanPageSize));
  const pages: Array<Awaited<ReturnType<typeof fetchEatBidPage>> | null> = [first];
  for (let page = 2; page <= pageCount; page += regionalScanConcurrency) {
    const batch = Array.from(
      { length: Math.min(regionalScanConcurrency, pageCount - page + 1) },
      (_, offset) => page + offset,
    );
    pages.push(...await Promise.all(batch.map((pageNumber) => (
      dependencies.fetchPage(upstreamPageQuery(query, pageNumber))
    ))));
  }

  const validationBidNumbers = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (!page) continue;
    assertRegionalScanPage(page, index + 1, first.total);
    for (const item of page.items) {
      if (validationBidNumbers.has(item.bidNo)) {
        throw new EatBidRegionLookupError(
          'eAT 지역 검색 원본에 중복 공고가 포함되었습니다. 잠시 후 다시 검색해 주세요.',
          502,
        );
      }
      validationBidNumbers.add(item.bidNo);
    }
  }

  const generationId = globalThis.crypto.randomUUID();
  const entries = pages.map((page, index) => {
    if (!page) throw new Error('eAT 지역 캐시 저장 페이지가 비어 있습니다.');
    return {
      query: upstreamPageQuery(query, index + 1),
      value: { total: page.total, items: page.items },
    };
  });
  let storedPages: EatBidCacheHit[];
  try {
    storedPages = await dependencies.replaceCacheBatch(
      entries,
      dependencies.ttlMinutes,
      { generationId },
    );
  } catch (error) {
    throw new EatBidRegionCachePublishError(error);
  }
  if (storedPages.length !== pages.length) {
    throw new EatBidRegionCachePublishError(
      new Error('eAT 지역 캐시 페이지가 일부만 저장되었습니다.'),
    );
  }
  const generationFetchedAt = isoTimestamp(storedPages[0].fetchedAt);
  const generationExpiresAt = isoTimestamp(storedPages[0].expiresAt);

  const accumulator = createRegionalAccumulator();
  let cachedAt = '';
  let expiresAt = '';
  for (const [index, stored] of storedPages.entries()) {
    if (
      stored.generationId !== generationId
      || isoTimestamp(stored.fetchedAt) !== generationFetchedAt
      || isoTimestamp(stored.expiresAt) !== generationExpiresAt
    ) {
      throw new EatBidRegionCachePublishError(
        new Error('eAT 지역 캐시 세대가 저장 중 변경되었습니다.'),
      );
    }
    collectRegionalPage(query, stored, index + 1, first.total, accumulator);
    cachedAt = earlierTimestamp(cachedAt, stored.fetchedAt);
    expiresAt = earlierTimestamp(expiresAt, stored.expiresAt);
  }
  pages.fill(null);

  return regionalResponse(query, accumulator, 'EAT', cachedAt, expiresAt);
}

async function lookupRegionalEatBids(
  query: EatBidQuery,
  dependencies: EatBidServiceDependencies,
): Promise<EatBidLookupResponse> {
  const initialSnapshot = await readRegionalCacheSnapshot(query, dependencies);
  if (initialSnapshot?.allFresh) {
    await touchRegionalSnapshot(initialSnapshot, dependencies);
    return initialSnapshot.response;
  }

  const refreshLockKey = await regionalScanLockKey(query);
  return dependencies.withLock(refreshLockKey, async () => {
    const currentSnapshot = await readRegionalCacheSnapshot(query, dependencies);
    if (currentSnapshot?.allFresh) {
      await touchRegionalSnapshot(currentSnapshot, dependencies);
      return currentSnapshot.response;
    }

    try {
      return await refreshRegionalCacheSnapshot(query, dependencies);
    } catch (error) {
      if (error instanceof EatBidRegionCachePublishError) throw error.originalError;
      if (error instanceof EatBidRegionLookupError && error.status === 400) throw error;
      if (currentSnapshot) {
        await touchRegionalSnapshot(currentSnapshot, dependencies);
        return currentSnapshot.response;
      }
      throw error;
    }
  });
}

export async function lookupEatBids(
  input: EatBidQuery,
  dependencyOverrides: Partial<EatBidServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const query = normalizeEatBidQuery(input);
  return hasEatDeliveryRegionFilter(query)
    ? lookupRegionalEatBids(query, dependencies)
    : lookupEatBidPage(query, dependencies);
}
