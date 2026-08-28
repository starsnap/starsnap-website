'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { ChevronLeft, ChevronRight, Database, Search } from 'lucide-react';
import {
  bidAreaOption,
  bidAreasForProvince,
  bidProvinceOptions,
  isBidAreaCode,
  isBidProvinceCode,
  type BidProvinceCode,
} from '../lib/bid-regions';
import type {
  EatBidAnnouncement,
  EatBidItemSpec,
  EatBidLookupResponse,
  EatBidLookupSource,
  EatBidQuery,
} from '../lib/eat-bid-types';
import {
  validateEatBidQuery,
  type EatBidQueryFieldErrors,
} from '../lib/eat-bid-validation';
import { formatEatDate } from '../lib/eat-date-format';
import {
  effectiveEatDeliveryRegionCodes,
  normalizeEatDeliveryRegionSelections,
  validateEatDeliveryRegionCodes,
} from '../lib/eat-delivery-region';
import type { TenantCode } from '../lib/erp-types';

const pageSize = 20;
const sourceLabels: Record<EatBidLookupSource, string> = {
  CACHE: 'DB 저장 데이터',
  EAT: 'eAT 새 조회 · DB 저장 완료',
  STALE_CACHE: '이전 DB 저장 데이터',
};

function koreaDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== 'string') throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, minimum = 0) {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  }
  return Number(value);
}

function parseSpec(value: unknown): EatBidItemSpec {
  if (!isRecord(value)) throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  return {
    id: requiredString(value, 'id'),
    messageOrder: requiredInteger(value, 'messageOrder', 1),
    itemOrder: requiredInteger(value, 'itemOrder', 1),
    orderingInstitutionName: requiredString(value, 'orderingInstitutionName'),
    itemName: requiredString(value, 'itemName'),
    foodName: requiredString(value, 'foodName'),
    specification: requiredString(value, 'specification'),
    unitName: requiredString(value, 'unitName'),
    attributes: requiredString(value, 'attributes'),
    quantity: requiredString(value, 'quantity'),
  };
}

function parseAnnouncement(value: unknown): EatBidAnnouncement {
  if (!isRecord(value) || !Array.isArray(value.specs)) {
    throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  }
  return {
    bidNo: requiredString(value, 'bidNo'),
    bidName: requiredString(value, 'bidName'),
    statusName: requiredString(value, 'statusName'),
    announcementDate: requiredString(value, 'announcementDate'),
    announcementTime: requiredString(value, 'announcementTime'),
    purchasingOrganizationName: requiredString(value, 'purchasingOrganizationName'),
    demandOrganizationName: requiredString(value, 'demandOrganizationName'),
    bidStartDate: requiredString(value, 'bidStartDate'),
    bidEndDate: requiredString(value, 'bidEndDate'),
    bidOpenDate: requiredString(value, 'bidOpenDate'),
    bidOpenTime: requiredString(value, 'bidOpenTime'),
    deliveryStartDate: requiredString(value, 'deliveryStartDate'),
    deliveryEndDate: requiredString(value, 'deliveryEndDate'),
    deliveryAddress: requiredString(value, 'deliveryAddress'),
    basePrice: requiredString(value, 'basePrice'),
    itemName: requiredString(value, 'itemName'),
    specs: value.specs.map(parseSpec),
  };
}

function parseQuery(value: unknown): EatBidQuery {
  if (!isRecord(value)) throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  const deliveryProvinceCode = requiredString(value, 'deliveryProvinceCode');
  const deliveryAreaCode = requiredString(value, 'deliveryAreaCode');
  const deliveryRegionErrors = validateEatDeliveryRegionCodes(
    deliveryProvinceCode,
    deliveryAreaCode,
  );
  if (deliveryRegionErrors.deliveryProvinceCode || deliveryRegionErrors.deliveryAreaCode) {
    throw new Error('eAT 현품 조회 응답 지역 형식이 올바르지 않습니다.');
  }
  let deliveryRegionCodes: string[];
  try {
    deliveryRegionCodes = Array.isArray(value.deliveryRegionCodes)
      ? normalizeEatDeliveryRegionSelections(value.deliveryRegionCodes)
      : effectiveEatDeliveryRegionCodes({
        deliveryProvinceCode,
        deliveryAreaCode,
        deliveryRegionCodes: [],
      });
  } catch {
    throw new Error('eAT 현품 조회 응답 지역 형식이 올바르지 않습니다.');
  }
  return {
    announcementStartDate: requiredString(value, 'announcementStartDate'),
    announcementEndDate: requiredString(value, 'announcementEndDate'),
    useOrganizationName: requiredString(value, 'useOrganizationName'),
    demandOrganizationName: requiredString(value, 'demandOrganizationName'),
    bidName: requiredString(value, 'bidName'),
    deliveryProvinceCode,
    deliveryAreaCode,
    deliveryRegionCodes,
    page: requiredInteger(value, 'page', 1),
    pageSize: requiredInteger(value, 'pageSize', 1),
  };
}

function parseLookupResponse(value: unknown): EatBidLookupResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  }
  const source = value.source;
  if (source !== 'CACHE' && source !== 'EAT' && source !== 'STALE_CACHE') {
    throw new Error('eAT 현품 조회 응답 출처가 올바르지 않습니다.');
  }
  const warning = value.warning;
  if (warning !== undefined && typeof warning !== 'string') {
    throw new Error('eAT 현품 조회 응답 형식이 올바르지 않습니다.');
  }
  const result = {
    query: parseQuery(value.query),
    source,
    cachedAt: requiredString(value, 'cachedAt'),
    expiresAt: requiredString(value, 'expiresAt'),
    total: requiredInteger(value, 'total'),
    page: requiredInteger(value, 'page', 1),
    pageSize: requiredInteger(value, 'pageSize', 1),
    items: value.items.map(parseAnnouncement),
    ...(warning ? { warning } : {}),
  } satisfies EatBidLookupResponse;
  if (
    result.items.length > result.pageSize
    || result.total < result.items.length
    || result.page !== result.query.page
    || result.pageSize !== result.query.pageSize
  ) {
    throw new Error('eAT 현품 조회 응답 건수가 올바르지 않습니다.');
  }
  return result;
}

function sameSearchCriteria(left: EatBidQuery, right: EatBidQuery) {
  return left.announcementStartDate === right.announcementStartDate
    && left.announcementEndDate === right.announcementEndDate
    && left.useOrganizationName === right.useOrganizationName
    && left.demandOrganizationName === right.demandOrganizationName
    && left.bidName === right.bidName
    && effectiveEatDeliveryRegionCodes(left).join('|')
      === effectiveEatDeliveryRegionCodes(right).join('|')
    && left.pageSize === right.pageSize;
}

function deliveryRegionSummary(codes: readonly string[]) {
  if (codes.length === 0) return '전국';
  const labels = codes.map((code) => {
    if (isBidProvinceCode(code)) {
      const province = bidProvinceOptions.find((option) => option.code === code);
      return province ? `${province.shortLabel} 전체` : code;
    }
    return isBidAreaCode(code) ? bidAreaOption(code)?.fullName ?? code : code;
  });
  return labels.length <= 3
    ? labels.join(' · ')
    : `${labels.slice(0, 3).join(' · ')} 외 ${labels.length - 3}개 지역`;
}

function displayDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function displayPrice(value: string) {
  const normalized = value.replaceAll(',', '').trim();
  if (!/^\d+$/.test(normalized)) return value || '-';
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) ? `${amount.toLocaleString('ko-KR')}원` : value;
}

function ItemSpecCard({ spec }: { spec: EatBidItemSpec }) {
  return (
    <li className="rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_minmax(5rem,.7fr)_minmax(4rem,.5fr)]">
        <div className="min-w-0"><p className="text-[11px] font-semibold text-[var(--ss-text-muted)]">품목명</p><p className="mt-1 break-words text-sm font-extrabold">{spec.itemName || '-'}</p></div>
        <div className="min-w-0"><p className="text-[11px] font-semibold text-[var(--ss-text-muted)]">식품명 · 규격</p><p className="mt-1 break-words text-sm font-semibold">{spec.foodName || '-'}{spec.specification ? ` · ${spec.specification}` : ''}</p></div>
        <div className="min-w-0"><p className="text-[11px] font-semibold text-[var(--ss-text-muted)]">수량</p><p className="mt-1 break-words text-sm font-bold">{spec.quantity || '-'} {spec.unitName}</p></div>
        <div className="min-w-0"><p className="text-[11px] font-semibold text-[var(--ss-text-muted)]">발주기관</p><p className="mt-1 break-words text-sm">{spec.orderingInstitutionName || '-'}</p></div>
      </div>
      {spec.attributes ? <p className="mt-3 break-words border-t border-[var(--ss-border)] pt-3 text-xs leading-5 text-[var(--ss-text-subtle)]">속성: {spec.attributes}</p> : null}
    </li>
  );
}

function AnnouncementCard({ item }: { item: EatBidAnnouncement }) {
  return (
    <article className="rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)] sm:p-5">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-all text-xs font-bold text-[var(--ss-info)]">입찰번호 {item.bidNo}</p>
          <h3 className="mt-1 break-words text-base font-extrabold leading-6">{item.bidName || '공고명 없음'}</h3>
          <p className="mt-2 break-words text-sm text-[var(--ss-text-subtle)]">{item.demandOrganizationName || item.purchasingOrganizationName || '기관명 없음'}</p>
        </div>
        <span className="self-start rounded-full border border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-2.5 py-1 text-xs font-bold text-[var(--ss-info-strong)]">{item.statusName || '상태 미제공'}</span>
      </div>

      <dl className="mt-4 grid gap-3 border-y border-[var(--ss-border)] py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs font-semibold text-[var(--ss-text-muted)]">공고일</dt><dd className="mt-1 font-bold">{formatEatDate(item.announcementDate)}</dd></div>
        <div><dt className="text-xs font-semibold text-[var(--ss-text-muted)]">입찰 기간</dt><dd className="mt-1 font-bold">{formatEatDate(item.bidStartDate)} ~ {formatEatDate(item.bidEndDate)}</dd></div>
        <div><dt className="text-xs font-semibold text-[var(--ss-text-muted)]">납품 기간</dt><dd className="mt-1 font-bold">{formatEatDate(item.deliveryStartDate)} ~ {formatEatDate(item.deliveryEndDate)}</dd></div>
        <div><dt className="text-xs font-semibold text-[var(--ss-text-muted)]">기초금액</dt><dd className="mt-1 font-bold">{displayPrice(item.basePrice)}</dd></div>
      </dl>
      {item.deliveryAddress ? <p className="mt-3 break-words text-xs leading-5 text-[var(--ss-text-subtle)]">납품장소: {item.deliveryAddress}</p> : null}

      <details className="mt-4 rounded-[var(--ss-radius-md)] bg-[var(--ss-surface-subtle)]">
        <summary className="min-h-11 cursor-pointer select-none px-4 py-3 text-sm font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ss-info)]">
          현품 {item.specs.length.toLocaleString('ko-KR')}개 보기
        </summary>
        <div className="border-t border-[var(--ss-border)] p-3 sm:p-4">
          {item.specs.length > 0 ? (
            <ul className="space-y-2">{item.specs.map((spec) => <ItemSpecCard key={spec.id} spec={spec} />)}</ul>
          ) : (
            <p className="py-4 text-center text-sm font-semibold text-[var(--ss-text-muted)]">이 공고 응답에는 현품설명서가 포함되지 않았습니다.</p>
          )}
        </div>
      </details>
    </article>
  );
}

export function EatItemSearch({ tenant }: { tenant: TenantCode }) {
  const generatedId = useId();
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const [announcementStartDate, setAnnouncementStartDate] = useState(() => koreaDate(29));
  const [announcementEndDate, setAnnouncementEndDate] = useState(() => koreaDate());
  const [useOrganizationName, setUseOrganizationName] = useState('');
  const [demandOrganizationName, setDemandOrganizationName] = useState('');
  const [bidName, setBidName] = useState('');
  const [deliveryProvinceCode, setDeliveryProvinceCode] = useState<BidProvinceCode | ''>('');
  const [deliveryRegionCodes, setDeliveryRegionCodes] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<EatBidQueryFieldErrors>({});
  const [activeQuery, setActiveQuery] = useState<EatBidQuery | null>(null);
  const [result, setResult] = useState<EatBidLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const deliveryProvince = deliveryProvinceCode
    ? bidProvinceOptions.find((option) => option.code === deliveryProvinceCode)
    : null;
  const deliveryAreaOptions = deliveryProvinceCode
    ? bidAreasForProvince(deliveryProvinceCode)
    : [];
  const selectedProvinceAll = deliveryProvinceCode
    ? deliveryRegionCodes.includes(deliveryProvinceCode)
    : false;
  const selectedAreaCount = deliveryProvinceCode
    ? selectedProvinceAll
      ? deliveryAreaOptions.length
      : deliveryAreaOptions.filter((area) => deliveryRegionCodes.includes(area.code)).length
    : 0;

  useEffect(() => () => activeController.current?.abort(), []);

  async function runSearch(query: EatBidQuery) {
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setActiveQuery(query);
    setResult((current) => (
      current && sameSearchCriteria(current.query, query) ? current : null
    ));
    setLoading(true);
    setRequestError(null);

    const parameters = new URLSearchParams({
      tenant,
      announcementStartDate: query.announcementStartDate,
      announcementEndDate: query.announcementEndDate,
      useOrganizationName: query.useOrganizationName,
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    if (query.demandOrganizationName) parameters.set('demandOrganizationName', query.demandOrganizationName);
    if (query.bidName) parameters.set('bidName', query.bidName);
    for (const code of effectiveEatDeliveryRegionCodes(query)) {
      parameters.append('deliveryRegionCode', code);
    }

    try {
      const response = await fetch(`/api/erp/eat/bids?${parameters.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const decoded: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = isRecord(decoded) && typeof decoded.message === 'string'
          ? decoded.message
          : `eAT 현품 조회 API ${response.status}`;
        throw new Error(message);
      }
      const parsed = parseLookupResponse(decoded);
      if (sequence === requestSequence.current) {
        setResult(parsed);
        setActiveQuery(parsed.query);
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setRequestError(error instanceof Error ? error.message : 'eAT 현품을 조회하지 못했습니다.');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query: EatBidQuery = {
      announcementStartDate,
      announcementEndDate,
      useOrganizationName: useOrganizationName.normalize('NFKC').trim().replace(/\s+/g, ' '),
      demandOrganizationName: demandOrganizationName.normalize('NFKC').trim().replace(/\s+/g, ' '),
      bidName: bidName.normalize('NFKC').trim().replace(/\s+/g, ' '),
      deliveryProvinceCode: '',
      deliveryAreaCode: '',
      deliveryRegionCodes: normalizeEatDeliveryRegionSelections(deliveryRegionCodes),
      page: 1,
      pageSize,
    };
    const errors = validateEatBidQuery(query);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void runSearch(query);
  }

  const uncappedTotalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const totalPages = Math.min(500, uncappedTotalPages);
  const paginationCapped = uncappedTotalPages > totalPages;
  const sourceTone = result?.source === 'STALE_CACHE'
    ? 'border-[var(--ss-warning-border)] bg-[var(--ss-warning-soft)] text-[var(--ss-warning-strong)]'
    : 'border-[var(--ss-success-border)] bg-[var(--ss-success-soft)] text-[var(--ss-success-strong)]';

  return (
    <section className="panel" aria-labelledby={`${generatedId}-title`} aria-busy={loading}>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">eAT PUBLIC PROCUREMENT</p>
          <h2 id={`${generatedId}-title`} className="mt-1 text-lg font-extrabold">eAT 입찰 현품 조회</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--ss-text-muted)]">공고 기간과 기관, 납품지역을 지정해 현품설명서를 조회합니다. 같은 조건은 DB 저장 데이터를 먼저 사용하고, 저장된 결과가 없을 때만 eAT에 요청합니다.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ss-text-subtle)]">
          <Database aria-hidden="true" className="size-4" />
          조회 결과 자동 저장
        </div>
      </div>

      <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <label htmlFor={`${generatedId}-start`} className="block text-sm font-semibold">공고 시작일 <span aria-hidden="true" className="text-[var(--ss-danger)]">*</span></label>
            <input id={`${generatedId}-start`} type="date" value={announcementStartDate} disabled={loading} required aria-required="true" aria-invalid={Boolean(fieldErrors.announcementStartDate)} aria-describedby={fieldErrors.announcementStartDate ? `${generatedId}-start-error` : undefined} onChange={(event) => { setAnnouncementStartDate(event.target.value); setFieldErrors((current) => ({ ...current, announcementStartDate: undefined, announcementEndDate: undefined })); }} className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm" />
            {fieldErrors.announcementStartDate ? <p id={`${generatedId}-start-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.announcementStartDate}</p> : null}
          </div>
          <div className="min-w-0">
            <label htmlFor={`${generatedId}-end`} className="block text-sm font-semibold">공고 종료일 <span aria-hidden="true" className="text-[var(--ss-danger)]">*</span></label>
            <input id={`${generatedId}-end`} type="date" value={announcementEndDate} disabled={loading} required aria-required="true" aria-invalid={Boolean(fieldErrors.announcementEndDate)} aria-describedby={fieldErrors.announcementEndDate ? `${generatedId}-end-error` : undefined} onChange={(event) => { setAnnouncementEndDate(event.target.value); setFieldErrors((current) => ({ ...current, announcementStartDate: undefined, announcementEndDate: undefined })); }} className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm" />
            {fieldErrors.announcementEndDate ? <p id={`${generatedId}-end-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.announcementEndDate}</p> : null}
          </div>
          <div className="min-w-0 sm:col-span-2 xl:col-span-1">
            <label htmlFor={`${generatedId}-use-organ`} className="block text-sm font-semibold">이용기관명 <span aria-hidden="true" className="text-[var(--ss-danger)]">*</span></label>
            <input id={`${generatedId}-use-organ`} type="search" value={useOrganizationName} maxLength={100} disabled={loading} required aria-required="true" aria-invalid={Boolean(fieldErrors.useOrganizationName)} aria-describedby={`${generatedId}-use-help${fieldErrors.useOrganizationName ? ` ${generatedId}-use-error` : ''}`} placeholder="예: 서울특별시교육청" onChange={(event) => { setUseOrganizationName(event.target.value); setFieldErrors((current) => ({ ...current, useOrganizationName: undefined })); }} className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm" />
            <p id={`${generatedId}-use-help`} className="mt-1.5 text-xs leading-5 text-[var(--ss-text-muted)]">eAT 공식 조회 필수 조건입니다.</p>
            {fieldErrors.useOrganizationName ? <p id={`${generatedId}-use-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.useOrganizationName}</p> : null}
          </div>
          <div className="min-w-0">
            <label htmlFor={`${generatedId}-demand-organ`} className="block text-sm font-semibold">수요기관·학교명 <span className="text-xs font-medium text-[var(--ss-text-muted)]">선택</span></label>
            <input id={`${generatedId}-demand-organ`} type="search" value={demandOrganizationName} maxLength={100} disabled={loading} aria-invalid={Boolean(fieldErrors.demandOrganizationName)} aria-describedby={fieldErrors.demandOrganizationName ? `${generatedId}-demand-error` : undefined} placeholder="예: 한빛초등학교" onChange={(event) => { setDemandOrganizationName(event.target.value); setFieldErrors((current) => ({ ...current, demandOrganizationName: undefined })); }} className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm" />
            {fieldErrors.demandOrganizationName ? <p id={`${generatedId}-demand-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.demandOrganizationName}</p> : null}
          </div>
        </div>
        <fieldset className="min-w-0 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] p-3 sm:p-4">
          <legend className="text-sm font-semibold">납품 지역 <span className="text-xs font-medium text-[var(--ss-text-muted)]">선택</span></legend>
          <div className="mt-1.5 flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end">
            <div className="min-w-0 lg:w-80 lg:shrink-0">
              <label htmlFor={`${generatedId}-delivery-province`} className="block text-xs font-semibold text-[var(--ss-text-subtle)]">시·도 탐색</label>
              <select
                id={`${generatedId}-delivery-province`}
                value={deliveryProvinceCode}
                disabled={loading}
                aria-invalid={Boolean(fieldErrors.deliveryRegionCodes)}
                aria-describedby={`${generatedId}-delivery-help${fieldErrors.deliveryRegionCodes ? ` ${generatedId}-delivery-region-error` : ''}`}
                onChange={(event) => {
                  const nextCode = event.target.value;
                  setDeliveryProvinceCode(isBidProvinceCode(nextCode) ? nextCode : '');
                  setFieldErrors((current) => ({
                    ...current,
                    deliveryProvinceCode: undefined,
                    deliveryAreaCode: undefined,
                    deliveryRegionCodes: undefined,
                  }));
                }}
                className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm"
              >
                <option value="">시·도를 선택해 주세요</option>
                {bidProvinceOptions.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 break-words text-xs font-semibold text-[var(--ss-text-subtle)]">
                선택 지역: <span className="font-extrabold text-[var(--ss-text)]">{deliveryRegionSummary(deliveryRegionCodes)}</span>
              </p>
              {deliveryRegionCodes.length > 0 ? (
                <button type="button" disabled={loading} onClick={() => { setDeliveryRegionCodes([]); setFieldErrors((current) => ({ ...current, deliveryRegionCodes: undefined })); }} className="star-secondary-button min-h-11 w-full shrink-0 px-3 text-xs sm:w-auto">전체 해제</button>
              ) : null}
            </div>
          </div>
          {deliveryProvinceCode ? (
            <div className="mt-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-extrabold">{deliveryProvince?.label} 행정구 · {selectedAreaCount}/{deliveryAreaOptions.length}개 선택</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    const provinceCode = deliveryProvinceCode;
                    const areaCodes = deliveryAreaOptions.map((area) => area.code);
                    const areaCodeSet = new Set<string>(areaCodes);
                    setDeliveryRegionCodes((current) => normalizeEatDeliveryRegionSelections(
                      selectedProvinceAll
                        ? current.filter((code) => code !== provinceCode && !areaCodeSet.has(code))
                        : [...current.filter((code) => code !== provinceCode && !areaCodeSet.has(code)), provinceCode],
                    ));
                    setFieldErrors((current) => ({ ...current, deliveryRegionCodes: undefined }));
                  }}
                  className="star-secondary-button min-h-11 w-full px-3 text-xs sm:w-auto"
                >
                  현재 시·도 {selectedProvinceAll ? '전체 해제' : '전체 선택'}
                </button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {deliveryAreaOptions.map((area) => {
                  const checked = selectedProvinceAll || deliveryRegionCodes.includes(area.code);
                  return (
                    <label key={area.code} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--ss-radius-md)] border px-3 py-2 text-sm font-semibold ${checked ? 'border-[var(--ss-border-strong)] bg-[var(--ss-brand-soft)]' : 'border-[var(--ss-border)] bg-[var(--ss-surface)]'} ${loading ? 'cursor-not-allowed opacity-60' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={loading}
                        onChange={() => {
                          const provinceCode = deliveryProvinceCode;
                          const areaCodes = deliveryAreaOptions.map((option) => option.code);
                          setDeliveryRegionCodes((current) => {
                            const next = new Set(current);
                            if (next.delete(provinceCode)) {
                              areaCodes.forEach((code) => next.add(code));
                            }
                            if (next.has(area.code)) next.delete(area.code);
                            else next.add(area.code);
                            return normalizeEatDeliveryRegionSelections([...next]);
                          });
                          setFieldErrors((current) => ({ ...current, deliveryRegionCodes: undefined }));
                        }}
                        className="size-4 shrink-0 accent-[var(--ss-brand)]"
                      />
                      <span className="min-w-0 break-words">{area.localName}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="mt-3 rounded-[var(--ss-radius-md)] border border-dashed border-[var(--ss-border-strong)] bg-[var(--ss-surface)] px-3 py-4 text-sm font-semibold text-[var(--ss-text-muted)]">시·도를 선택하면 여러 행정구를 한 번에 선택할 수 있습니다. 선택하지 않으면 전국을 조회합니다.</p>
          )}
          <p id={`${generatedId}-delivery-help`} className="mt-2 text-xs leading-5 text-[var(--ss-text-muted)]">시·도를 바꿔도 기존 선택은 유지됩니다. 선택한 지역 중 하나라도 납품장소와 일치하는 공고를 조회하며, 첫 지역 조회는 전체 결과를 확인하므로 조금 더 걸릴 수 있습니다.</p>
          {fieldErrors.deliveryRegionCodes ? <p id={`${generatedId}-delivery-region-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.deliveryRegionCodes}</p> : null}
        </fieldset>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <label htmlFor={`${generatedId}-bid-name`} className="block text-sm font-semibold">입찰공고명 <span className="text-xs font-medium text-[var(--ss-text-muted)]">선택</span></label>
            <input id={`${generatedId}-bid-name`} type="search" value={bidName} maxLength={100} disabled={loading} aria-invalid={Boolean(fieldErrors.bidName)} aria-describedby={fieldErrors.bidName ? `${generatedId}-bid-error` : undefined} placeholder="예: 2026학년도 학교급식 식재료" onChange={(event) => { setBidName(event.target.value); setFieldErrors((current) => ({ ...current, bidName: undefined })); }} className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm" />
            {fieldErrors.bidName ? <p id={`${generatedId}-bid-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{fieldErrors.bidName}</p> : null}
          </div>
          <button type="submit" disabled={loading} className="star-primary-button min-h-11 w-full px-5 text-sm sm:w-auto">
            <Search aria-hidden="true" className="mr-2 inline size-4" />
            {loading ? '현품 조회 중' : '현품 조회'}
          </button>
        </div>
      </form>

      {loading ? (
        <div role="status" aria-live="polite" className="mt-5 space-y-3">
          <span className="sr-only">eAT 현품을 조회하고 있습니다.</span>
          {[0, 1].map((item) => <div key={item} aria-hidden="true" className="h-28 animate-pulse rounded-[var(--ss-radius-lg)] bg-[var(--ss-surface-subtle)]" />)}
        </div>
      ) : null}

      {requestError ? (
        <div role="alert" className="mt-5 flex min-w-0 flex-col gap-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-danger-border)] bg-[var(--ss-danger-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 break-words text-sm font-semibold text-[var(--ss-danger-strong)]">{requestError}</p>
          <button type="button" disabled={!activeQuery || loading} onClick={() => activeQuery && void runSearch(activeQuery)} className="star-secondary-button min-h-11 w-full shrink-0 px-4 text-sm sm:w-auto">다시 시도</button>
        </div>
      ) : null}

      {result ? (
        <div className="mt-5">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${sourceTone}`}>{sourceLabels[result.source]}</span>
              <p role="status" aria-live="polite" className="text-sm font-semibold text-[var(--ss-text-subtle)]">총 {result.total.toLocaleString('ko-KR')}건 · {result.page}/{totalPages}페이지{paginationCapped ? ' · 500페이지까지 이동 가능' : ''}</p>
            </div>
            <p className="text-xs text-[var(--ss-text-muted)]">저장 시각 {displayDateTime(result.cachedAt)}</p>
          </div>
          {result.warning ? <p role="alert" className="mt-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-warning-border)] bg-[var(--ss-warning-soft)] px-3 py-2.5 text-sm font-semibold text-[var(--ss-warning-strong)]">{result.warning}</p> : null}

          {result.items.length > 0 ? (
            <div className="mt-4 space-y-3">{result.items.map((item) => <AnnouncementCard key={item.bidNo} item={item} />)}</div>
          ) : (
            <div className="mt-4 rounded-[var(--ss-radius-lg)] border border-dashed border-[var(--ss-border-strong)] px-4 py-12 text-center">
              <p className="text-sm font-bold">조건에 맞는 eAT 입찰공고가 없습니다.</p>
              <p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">기관명, 납품지역 또는 공고 기간을 바꿔 다시 조회해 주세요. 0건 결과도 DB에 저장됩니다.</p>
            </div>
          )}

          {totalPages > 1 ? (
            <nav aria-label="eAT 현품 조회 페이지" className="mt-4 flex items-center justify-center gap-2">
              <button type="button" disabled={loading || result.page <= 1} onClick={() => void runSearch({ ...result.query, page: result.page - 1 })} className="star-secondary-button min-h-11 px-3 text-sm"><ChevronLeft aria-hidden="true" className="mr-1 inline size-4" />이전</button>
              <span className="min-w-20 text-center text-sm font-bold">{result.page} / {totalPages}</span>
              <button type="button" disabled={loading || result.page >= totalPages} onClick={() => void runSearch({ ...result.query, page: result.page + 1 })} className="star-secondary-button min-h-11 px-3 text-sm">다음<ChevronRight aria-hidden="true" className="ml-1 inline size-4" /></button>
            </nav>
          ) : null}
        </div>
      ) : !loading && !requestError ? (
        <div className="mt-5 rounded-[var(--ss-radius-lg)] border border-dashed border-[var(--ss-border-strong)] px-4 py-10 text-center text-sm font-semibold text-[var(--ss-text-muted)]">조건을 입력한 뒤 현품 조회를 눌러 주세요.</div>
      ) : null}
    </section>
  );
}
