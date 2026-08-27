import type {
  ChannelOrderStatus,
  NetworkMutation,
  PartnerRelationshipStatus,
} from './erp-types';
import {
  isBidAreaCode,
  maxBidAreaSelections,
  uniqueBidAreaCodes,
} from './bid-regions';
import { normalizeTenantCode } from './tenant-code';

export type NetworkMutationParseResult =
  | { ok: true; value: NetworkMutation }
  | { ok: false; message: string };

const partnerStatuses = new Set<PartnerRelationshipStatus>(['ACTIVE', 'INACTIVE']);
const transitionStatuses = new Set<ChannelOrderStatus>([
  'ACCEPTED',
  'REJECTED',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
]);
const MAX_DATABASE_INTEGER = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, minLength: number, maxLength: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= minLength && normalized.length <= maxLength
    ? normalized
    : null;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === undefined) return { ok: true as const, value: undefined };
  if (typeof value !== 'string') return { ok: false as const };
  const normalized = value.trim();
  if (normalized.length > maxLength) return { ok: false as const };
  return { ok: true as const, value: normalized || undefined };
}

function isDatabaseInteger(value: unknown, minimum: number, maximum = MAX_DATABASE_INTEGER): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function invalid(message: string): NetworkMutationParseResult {
  return { ok: false, message };
}

export function parseNetworkMutation(value: unknown): NetworkMutationParseResult {
  if (!isRecord(value)) return invalid('유통 네트워크 요청 형식이 올바르지 않습니다.');

  const tenant = normalizeTenantCode(value.tenant);
  if (!tenant) return invalid('유통 네트워크 요청의 회사 코드가 올바르지 않습니다.');

  if (value.module === 'partners' && value.action === 'connect') {
    const partnerCode = normalizeTenantCode(value.partnerCode);
    if (!partnerCode) return invalid('연결할 업체 코드를 확인해 주세요.');
    if (partnerCode === tenant) return invalid('현재 업체를 거래처로 연결할 수 없습니다.');
    if (value.areaCodes !== undefined && (
      !Array.isArray(value.areaCodes)
      || value.areaCodes.length > maxBidAreaSelections
      || value.areaCodes.some((areaCode) => !isBidAreaCode(areaCode))
    )) return invalid('담당 권역은 지원하는 시·군·구 또는 행정구로 선택해 주세요.');
    const areaCodes = Array.isArray(value.areaCodes)
      ? uniqueBidAreaCodes(value.areaCodes)
      : undefined;
    return {
      ok: true,
      value: {
        tenant,
        module: 'partners',
        action: 'connect',
        partnerCode,
        ...(areaCodes ? { areaCodes } : {}),
      },
    };
  }

  if (value.module === 'partners' && value.action === 'set-status') {
    const id = requiredText(value.id, 1, 128);
    if (!id) return invalid('변경할 업체 관계를 찾을 수 없습니다.');
    if (typeof value.status !== 'string' || !partnerStatuses.has(value.status as PartnerRelationshipStatus)) {
      return invalid('업체 관계 상태가 올바르지 않습니다.');
    }
    return {
      ok: true,
      value: {
        tenant,
        module: 'partners',
        action: 'set-status',
        id,
        status: value.status as PartnerRelationshipStatus,
      },
    };
  }

  if (value.module === 'bids' && value.action === 'create') {
    if (!isRecord(value.bid)) return invalid('학교 낙찰 계약 정보를 입력해 주세요.');
    const bidNo = requiredText(value.bid.bidNo, 2, 80);
    const schoolId = requiredText(value.bid.schoolId, 1, 160);
    const title = requiredText(value.bid.title, 2, 160);
    if (!bidNo || !schoolId || !title) {
      return invalid('공고번호, 공식 학교와 계약명을 입력해 주세요.');
    }
    if (!isIsoDate(value.bid.awardedAt)
      || !isIsoDate(value.bid.contractStart)
      || !isIsoDate(value.bid.contractEnd)) {
      return invalid('낙찰일과 계약 기간은 유효한 YYYY-MM-DD 형식으로 입력해 주세요.');
    }
    if (value.bid.contractStart > value.bid.contractEnd) {
      return invalid('계약 종료일은 계약 시작일보다 빠를 수 없습니다.');
    }
    if (!isDatabaseInteger(value.bid.contractAmount, 0)) {
      return invalid('계약 금액은 0~2,147,483,647원의 정수로 입력해 주세요.');
    }
    return {
      ok: true,
      value: {
        tenant,
        module: 'bids',
        action: 'create',
        bid: {
          bidNo,
          schoolId,
          title,
          awardedAt: value.bid.awardedAt,
          contractStart: value.bid.contractStart,
          contractEnd: value.bid.contractEnd,
          contractAmount: value.bid.contractAmount,
        },
      },
    };
  }

  if (value.module === 'bid-target-areas' && value.action === 'set') {
    if (
      !Array.isArray(value.areaCodes)
      || value.areaCodes.length > maxBidAreaSelections
      || value.areaCodes.some((areaCode) => !isBidAreaCode(areaCode))
    ) return invalid('관심 입찰 지역은 지원하는 시·군·구 또는 행정구로 선택해 주세요.');
    return {
      ok: true,
      value: {
        tenant,
        module: 'bid-target-areas',
        action: 'set',
        areaCodes: uniqueBidAreaCodes(value.areaCodes),
      },
    };
  }

  if (value.module === 'channel-orders' && value.action === 'create') {
    if (!isRecord(value.order)) return invalid('발주 정보를 입력해 주세요.');
    const partnerCode = normalizeTenantCode(value.order.partnerCode);
    if (!partnerCode) return invalid('발주 대상 업체 코드를 확인해 주세요.');
    if (partnerCode === tenant) return invalid('현재 업체에 발주할 수 없습니다.');
    const schoolBidId = optionalText(value.order.schoolBidId, 128);
    if (!schoolBidId.ok) return invalid('학교 낙찰 계약 정보가 올바르지 않습니다.');
    if (!isIsoDate(value.order.deliveryDate)) {
      return invalid('납품 예정일은 유효한 YYYY-MM-DD 형식으로 입력해 주세요.');
    }
    if (!isDatabaseInteger(value.order.totalAmount, 0)) {
      return invalid('발주 금액은 0~2,147,483,647원의 정수로 입력해 주세요.');
    }
    if (!isDatabaseInteger(value.order.itemCount, 1, 10_000)) {
      return invalid('발주 품목 수는 1~10,000개의 정수로 입력해 주세요.');
    }
    const note = optionalText(value.order.note, 500);
    if (!note.ok) return invalid('발주 메모는 500자 이하로 입력해 주세요.');
    return {
      ok: true,
      value: {
        tenant,
        module: 'channel-orders',
        action: 'create',
        order: {
          partnerCode,
          ...(schoolBidId.value ? { schoolBidId: schoolBidId.value } : {}),
          deliveryDate: value.order.deliveryDate,
          totalAmount: value.order.totalAmount,
          itemCount: value.order.itemCount,
          ...(note.value ? { note: note.value } : {}),
        },
      },
    };
  }

  if (value.module === 'channel-orders' && value.action === 'transition') {
    const id = requiredText(value.id, 1, 128);
    if (!id) return invalid('처리할 발주를 찾을 수 없습니다.');
    if (typeof value.status !== 'string' || !transitionStatuses.has(value.status as ChannelOrderStatus)) {
      return invalid('변경할 발주 상태가 올바르지 않습니다.');
    }
    return {
      ok: true,
      value: {
        tenant,
        module: 'channel-orders',
        action: 'transition',
        id,
        status: value.status as ChannelOrderStatus,
      },
    };
  }

  return invalid('허용되지 않은 유통 네트워크 작업입니다.');
}
