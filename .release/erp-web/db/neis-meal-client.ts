import { env } from 'cloudflare:workers';
import type { NeisMealRecord } from '@/app/lib/neis-meal-types';

const neisMealEndpoint = 'https://open.neis.go.kr/hub/mealServiceDietInfo';
const maximumResponseBytes = 2_000_000;
const requestTimeoutMilliseconds = 10_000;

type NeisApiErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'HTTP'
  | 'NETWORK'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE';

interface NeisBindings {
  NEIS_API_KEY?: string;
  NEIS_PROXY_URL?: string;
}
export interface NeisMealRequest {
  officeCode: string;
  schoolCode: string;
  fromDate: string;
  toDate: string;
}

export class NeisApiError extends Error {
  constructor(
    public readonly code: NeisApiErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NeisApiError';
  }
}

function bindings() {
  return env as unknown as NeisBindings;
}

function apiKey(override?: string) {
  const value = (override ?? bindings().NEIS_API_KEY ?? '').trim();
  if (!value) {
    throw new NeisApiError('NOT_CONFIGURED', '나이스 급식식단정보 인증키가 서버에 설정되지 않았습니다.');
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new NeisApiError('NOT_CONFIGURED', '나이스 급식식단정보 인증키 형식이 올바르지 않습니다.');
  }
}

function proxyEndpoint(override?: string) {
  const value = (override ?? bindings().NEIS_PROXY_URL ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username
      || url.password
    ) throw new Error('unsafe proxy');
    return new URL('/meal-service-diet-info', url);
  } catch {
    throw new NeisApiError('NOT_CONFIGURED', '나이스 내부 프록시 주소가 올바르지 않습니다.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodedText(value: unknown) {
  return text(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function isoDate(value: unknown) {
  const compact = text(value);
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function servings(value: unknown) {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function resultCode(value: unknown) {
  if (!isRecord(value)) return null;
  const result = value.RESULT;
  if (!isRecord(result)) return null;
  return { code: text(result.CODE), message: text(result.MESSAGE) };
}

export function parseNeisMealResponse(payload: unknown) {
  if (!isRecord(payload)) {
    throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보 응답 형식이 올바르지 않습니다.');
  }

  const topLevelResult = resultCode(payload);
  if (topLevelResult?.code === 'INFO-200') return { total: 0, items: [] as NeisMealRecord[] };
  if (topLevelResult && topLevelResult.code !== 'INFO-000') {
    throw new NeisApiError('UPSTREAM_ERROR', topLevelResult.message || '나이스 급식식단정보 조회에 실패했습니다.');
  }

  const sections = payload.mealServiceDietInfo;
  if (!Array.isArray(sections)) {
    throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보 목록이 응답에 없습니다.');
  }

  let total = 0;
  let code = '';
  let message = '';
  let rows: unknown[] = [];
  for (const section of sections) {
    if (!isRecord(section)) continue;
    if (Array.isArray(section.head)) {
      for (const head of section.head) {
        if (!isRecord(head)) continue;
        const count = Number(head.list_total_count);
        if (Number.isSafeInteger(count) && count >= 0) total = count;
        const result = resultCode(head);
        if (result) ({ code, message } = result);
      }
    }
    if (Array.isArray(section.row)) rows = section.row;
  }
  if (code && code !== 'INFO-000') {
    if (code === 'INFO-200') return { total: 0, items: [] as NeisMealRecord[] };
    throw new NeisApiError('UPSTREAM_ERROR', message || '나이스 급식식단정보 조회에 실패했습니다.');
  }

  const items = rows.map<NeisMealRecord>((row) => {
    if (!isRecord(row)) {
      throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보 항목 형식이 올바르지 않습니다.');
    }
    const serviceDate = isoDate(row.MLSV_YMD);
    const schoolName = text(row.SCHUL_NM);
    const mealName = text(row.MMEAL_SC_NM);
    if (!serviceDate || !schoolName || !mealName) {
      throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보 필수 값이 누락되었습니다.');
    }
    const dishText = decodedText(row.DDISH_NM);
    return {
      serviceDate,
      mealCode: text(row.MMEAL_SC_CODE),
      mealName,
      schoolName,
      servings: servings(row.MLSV_FGR),
      dishes: dishText ? dishText.split('\n') : [],
      originInfo: decodedText(row.ORPLC_INFO),
      calories: text(row.CAL_INFO),
      nutritionInfo: decodedText(row.NTR_INFO),
      loadedAt: text(row.LOAD_DTM),
    };
  });

  if (total < items.length) total = items.length;
  return { total, items };
}

async function readBoundedJson(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new NeisApiError('RESPONSE_TOO_LARGE', '나이스 급식식단정보 응답이 허용 크기를 초과했습니다.');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumResponseBytes) {
    throw new NeisApiError('RESPONSE_TOO_LARGE', '나이스 급식식단정보 응답이 허용 크기를 초과했습니다.');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보 JSON을 해석하지 못했습니다.');
  }
}

export async function fetchNeisMeals(
  query: NeisMealRequest,
  options: {
    fetchImpl?: typeof fetch;
    key?: string;
    proxyUrl?: string;
    timeoutMilliseconds?: number;
  } = {},
) {
  const proxy = proxyEndpoint(options.proxyUrl);
  const url = proxy ?? new URL(neisMealEndpoint);
  if (!proxy) {
    url.searchParams.set('KEY', apiKey(options.key));
    url.searchParams.set('Type', 'json');
    url.searchParams.set('pIndex', '1');
    url.searchParams.set('pSize', '100');
    url.searchParams.set('ATPT_OFCDC_SC_CODE', query.officeCode);
    url.searchParams.set('SD_SCHUL_CODE', query.schoolCode);
    url.searchParams.set('MLSV_FROM_YMD', query.fromDate.replaceAll('-', ''));
    url.searchParams.set('MLSV_TO_YMD', query.toDate.replaceAll('-', ''));
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMilliseconds ?? (proxy ? 12_000 : requestTimeoutMilliseconds),
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(url, proxy ? {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      redirect: 'error',
      signal: controller.signal,
    } : {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new NeisApiError('HTTP', '나이스 급식식단정보 서비스가 정상 응답하지 않았습니다.', response.status);
    }
    const result = parseNeisMealResponse(await readBoundedJson(response));
    if (result.items.some((item) => (
      item.serviceDate < query.fromDate || item.serviceDate > query.toDate
    ))) {
      throw new NeisApiError('INVALID_RESPONSE', '나이스 급식식단정보가 요청 기간을 벗어났습니다.');
    }
    return result;
  } catch (error) {
    if (error instanceof NeisApiError) throw error;
    if (controller.signal.aborted) {
      throw new NeisApiError('TIMEOUT', '나이스 급식식단정보 조회 시간이 초과되었습니다.');
    }
    throw new NeisApiError('NETWORK', '나이스 급식식단정보 서비스에 연결할 수 없습니다.');
  } finally {
    clearTimeout(timeout);
  }
}
