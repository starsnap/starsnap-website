import { env } from 'cloudflare:workers';
import type {
  EatBidLookupResponse,
  EatBidQuery,
} from '@/app/lib/eat-bid-types';
import { fetchEatBidPage } from './eat-api-client';
import {
  eatBidQueryHash,
  findEatBidCache,
  normalizeEatBidQuery,
  replaceEatBidCache,
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
  touchCache: typeof touchEatBidCacheAccess;
  withLock: typeof withAdvisoryLock;
  ttlMinutes: number;
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

export async function lookupEatBids(
  input: EatBidQuery,
  dependencyOverrides: Partial<EatBidServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const query = normalizeEatBidQuery(input);
  const initialCache = await dependencies.findCache(query);
  if (initialCache?.fresh) {
    await touchCacheSafely(dependencies.touchCache, initialCache.queryHash);
    return responseFromCache(query, initialCache, 'CACHE');
  }

  const queryHash = initialCache?.queryHash ?? await eatBidQueryHash(query);
  return dependencies.withLock(`eat-bid-refresh:${queryHash}`, async () => {
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
