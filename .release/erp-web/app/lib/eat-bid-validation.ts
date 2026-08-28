import type { EatBidQuery } from './eat-bid-types';
import {
  normalizeEatDeliveryRegionSelections,
  validateEatDeliveryRegionCodes,
} from './eat-delivery-region';

export type EatBidQueryFieldErrors = Partial<Record<
  | 'announcementStartDate'
  | 'announcementEndDate'
  | 'useOrganizationName'
  | 'demandOrganizationName'
  | 'bidName'
  | 'deliveryProvinceCode'
  | 'deliveryAreaCode'
  | 'deliveryRegionCodes',
  string
>>;

export type EatBidQueryParseResult =
  | { ok: true; query: EatBidQuery }
  | { ok: false; message: string };

function normalizeText(value: string | null) {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

function positiveInteger(value: string | null, fallback: number) {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function maximumEndDate(start: Date) {
  const targetMonth = start.getUTCMonth() + 3;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(start.getUTCDate(), lastDay),
  ));
}

export function validateEatBidQuery(query: EatBidQuery): EatBidQueryFieldErrors {
  const errors: EatBidQueryFieldErrors = {};
  const start = validDate(query.announcementStartDate);
  const end = validDate(query.announcementEndDate);
  if (!start) errors.announcementStartDate = '공고 시작일을 선택해 주세요.';
  if (!end) errors.announcementEndDate = '공고 종료일을 선택해 주세요.';
  if (start && end && start > end) {
    errors.announcementEndDate = '공고 종료일은 시작일보다 빠를 수 없습니다.';
  } else if (start && end && end > maximumEndDate(start)) {
    errors.announcementEndDate = 'eAT 조회 기간은 최대 3개월입니다.';
  }
  if (
    query.useOrganizationName.length < 2
    || query.useOrganizationName.length > 100
    || !/[\p{L}\p{N}]/u.test(query.useOrganizationName)
  ) {
    errors.useOrganizationName = '이용기관명을 2~100자로 입력해 주세요.';
  }
  if (
    query.demandOrganizationName.length > 100
    || (query.demandOrganizationName && !/[\p{L}\p{N}]/u.test(query.demandOrganizationName))
  ) {
    errors.demandOrganizationName = '수요기관·학교명은 문자 또는 숫자를 포함한 100자 이하여야 합니다.';
  }
  if (
    query.bidName.length > 100
    || (query.bidName && !/[\p{L}\p{N}]/u.test(query.bidName))
  ) {
    errors.bidName = '입찰공고명은 문자 또는 숫자를 포함한 100자 이하여야 합니다.';
  }
  if (query.deliveryRegionCodes?.length) {
    try {
      normalizeEatDeliveryRegionSelections(query.deliveryRegionCodes);
    } catch (error) {
      errors.deliveryRegionCodes = error instanceof Error
        ? error.message
        : '납품 지역을 다시 선택해 주세요.';
    }
  } else {
    const deliveryRegionErrors = validateEatDeliveryRegionCodes(
      query.deliveryProvinceCode,
      query.deliveryAreaCode,
    );
    if (deliveryRegionErrors.deliveryProvinceCode) {
      errors.deliveryProvinceCode = deliveryRegionErrors.deliveryProvinceCode;
    }
    if (deliveryRegionErrors.deliveryAreaCode) {
      errors.deliveryAreaCode = deliveryRegionErrors.deliveryAreaCode;
    }
  }
  return errors;
}

export function parseEatBidQuery(parameters: URLSearchParams): EatBidQueryParseResult {
  const announcementStartDate = normalizeText(parameters.get('announcementStartDate'));
  const announcementEndDate = normalizeText(parameters.get('announcementEndDate'));
  const useOrganizationName = normalizeText(parameters.get('useOrganizationName'));
  const demandOrganizationName = normalizeText(parameters.get('demandOrganizationName'));
  const bidName = normalizeText(parameters.get('bidName'));
  const deliveryProvinceCode = normalizeText(parameters.get('deliveryProvinceCode'));
  const deliveryAreaCode = normalizeText(parameters.get('deliveryAreaCode'));
  let deliveryRegionCodes: string[];
  try {
    deliveryRegionCodes = normalizeEatDeliveryRegionSelections(
      parameters.getAll('deliveryRegionCode'),
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '납품 지역을 다시 선택해 주세요.',
    };
  }
  const page = positiveInteger(parameters.get('page'), 1);
  const pageSize = positiveInteger(parameters.get('pageSize'), 20);
  if (page === null || page > 500 || pageSize === null || pageSize > 50) {
    return { ok: false, message: 'page는 1~500, pageSize는 1~50 사이의 정수여야 합니다.' };
  }
  const query: EatBidQuery = {
    announcementStartDate,
    announcementEndDate,
    useOrganizationName,
    demandOrganizationName,
    bidName,
    deliveryProvinceCode,
    deliveryAreaCode,
    deliveryRegionCodes,
    page,
    pageSize,
  };
  const fieldErrors = validateEatBidQuery(query);
  const firstError = fieldErrors.announcementStartDate
    ?? fieldErrors.announcementEndDate
    ?? fieldErrors.useOrganizationName
    ?? fieldErrors.demandOrganizationName
    ?? fieldErrors.bidName
    ?? fieldErrors.deliveryProvinceCode
    ?? fieldErrors.deliveryAreaCode
    ?? fieldErrors.deliveryRegionCodes;
  return firstError ? { ok: false, message: firstError } : { ok: true, query };
}
