import { env } from 'cloudflare:workers';
import type { EatBidQuery } from '@/app/lib/eat-bid-types';
import { EatApiError, parseEatBidXml } from './eat-api-parser';

const eatBidEndpoint = 'https://apis.data.go.kr/B552845/eaTPubServiceN3/eaTBidListN3';
const maximumResponseBytes = 5_000_000;
const requestTimeoutMilliseconds = 10_000;

interface EatBindings {
  EAT_API_SERVICE_KEY?: string;
}

function bindings() {
  return env as unknown as EatBindings;
}

function apiServiceKey(override?: string) {
  const value = (override ?? bindings().EAT_API_SERVICE_KEY ?? '').trim();
  if (!value) {
    throw new EatApiError('NOT_CONFIGURED', 'eAT 현품 조회 인증키가 서버에 설정되지 않았습니다.');
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EatApiError('NOT_CONFIGURED', 'eAT 현품 조회 인증키 형식이 올바르지 않습니다.');
  }
}

function compactDate(value: string) {
  return value.replaceAll('-', '');
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The original safe, typed error is more useful than a transport cleanup failure.
  }
}

async function readBoundedResponseText(response: Response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const contentLength = Number(declaredLength);
    if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
      await cancelResponseBody(response);
      throw new EatApiError('RESPONSE_TOO_LARGE', 'eAT 현품 조회 응답이 허용 크기를 초과했습니다.');
    }
  }
  if (!response.body) {
    throw new EatApiError('INVALID_XML', 'eAT 현품 조회 응답 본문이 없습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new EatApiError('RESPONSE_TOO_LARGE', 'eAT 현품 조회 응답이 허용 크기를 초과했습니다.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

export async function fetchEatBidPage(
  query: EatBidQuery,
  options: {
    fetchImpl?: typeof fetch;
    serviceKey?: string;
    timeoutMilliseconds?: number;
  } = {},
) {
  const url = new URL(eatBidEndpoint);
  url.searchParams.set('serviceKey', apiServiceKey(options.serviceKey));
  url.searchParams.set('pageNo', String(query.page));
  url.searchParams.set('numOfRows', String(query.pageSize));
  url.searchParams.set('ancmStsrDt', compactDate(query.announcementStartDate));
  url.searchParams.set('ancmEndDt', compactDate(query.announcementEndDate));
  url.searchParams.set('useOrganNm', query.useOrganizationName);
  if (query.demandOrganizationName) {
    url.searchParams.set('dmdOrganNm', query.demandOrganizationName);
  }
  if (query.bidName) url.searchParams.set('bidNm', query.bidName);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMilliseconds ?? requestTimeoutMilliseconds,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      cache: 'no-store',
      headers: { Accept: 'application/xml, text/xml;q=0.9' },
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new EatApiError('HTTP', 'eAT 현품 조회 서비스가 정상 응답하지 않았습니다.', response.status);
    }
    const xml = await readBoundedResponseText(response);
    const parsed = parseEatBidXml(xml, { page: query.page, pageSize: query.pageSize });
    if (parsed.page !== query.page || parsed.pageSize !== query.pageSize) {
      throw new EatApiError('INVALID_XML', 'eAT 응답 페이지가 요청한 페이지와 일치하지 않습니다.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof EatApiError) throw error;
    if (controller.signal.aborted) {
      throw new EatApiError('TIMEOUT', 'eAT 현품 조회 시간이 초과되었습니다.');
    }
    throw new EatApiError('NETWORK', 'eAT 현품 조회 서비스에 연결할 수 없습니다.');
  } finally {
    clearTimeout(timeout);
  }
}

export { EatApiError } from './eat-api-parser';
export type {
  EatApiBidAnnouncement,
  EatApiBidItemSpec,
  EatApiBidPage,
  EatApiErrorCode,
} from './eat-api-parser';
