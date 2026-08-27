import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  EatBidAnnouncement,
  EatBidItemSpec,
} from '@/app/lib/eat-bid-types';

const successfulResultCodes = new Set(['0', '00', '0000']);

type JsonRecord = Record<string, unknown>;

export interface EatApiBidItemSpec extends EatBidItemSpec {
  rawPayload: JsonRecord;
}

export interface EatApiBidAnnouncement extends Omit<EatBidAnnouncement, 'specs'> {
  specs: EatApiBidItemSpec[];
  rawPayload: JsonRecord;
}

export interface EatApiBidPage {
  total: number;
  page: number;
  pageSize: number;
  items: EatApiBidAnnouncement[];
}

interface EatApiPageRequest {
  page: number;
  pageSize: number;
}

export type EatApiErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_XML'
  | 'UPSTREAM_ERROR';

export class EatApiError extends Error {
  constructor(
    public readonly code: EatApiErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EatApiError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim()
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : '';
}

function requiredInteger(value: unknown) {
  const normalized = stringValue(value);
  if (!/^\d+$/.test(normalized)) {
    throw new EatApiError('INVALID_XML', 'eAT 응답 페이지 정보가 올바르지 않습니다.');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EatApiError('INVALID_XML', 'eAT 응답 페이지 정보가 올바르지 않습니다.');
  }
  return parsed;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function itemSpecs(bidNo: string, item: JsonRecord) {
  const messageRoot = record(item.mesgSnItem);
  return asArray(messageRoot.mesgSnItemNo).flatMap((messageValue, messageIndex) => {
    const message = record(messageValue);
    const itemRoot = record(message.attrDItem);
    return asArray(itemRoot.attrDItemNo).map((attributeValue, itemIndex) => {
      const attribute = record(attributeValue);
      const messageOrder = messageIndex + 1;
      const itemOrder = itemIndex + 1;
      return {
        id: `${bidNo}:${messageOrder}:${itemOrder}`,
        messageOrder,
        itemOrder,
        orderingInstitutionName: stringValue(message.instNm),
        itemName: stringValue(message.mesgClsfNm),
        foodName: stringValue(attribute.foodNm),
        specification: stringValue(attribute.stdNm),
        unitName: stringValue(attribute.untNm),
        attributes: stringValue(attribute.attrInfo),
        quantity: stringValue(attribute.qty),
        rawPayload: attribute,
      } satisfies EatApiBidItemSpec;
    });
  });
}

function parseAnnouncement(value: unknown, index: number): EatApiBidAnnouncement {
  const item = record(value);
  const bidNo = stringValue(item.etnBidNo);
  if (!bidNo) {
    throw new EatApiError('INVALID_XML', `eAT 입찰공고 ${index + 1}번 항목에 입찰번호가 없습니다.`);
  }

  return {
    bidNo,
    bidName: stringValue(item.bidNm),
    statusName: stringValue(item.etnBidSttNm),
    announcementDate: stringValue(item.ancmDt),
    announcementTime: stringValue(item.ancmHh),
    purchasingOrganizationName: stringValue(item.purrNm),
    demandOrganizationName: stringValue(item.dmdOrganNm),
    bidStartDate: stringValue(item.bidBgngDt),
    bidEndDate: stringValue(item.bidEndDt),
    bidOpenDate: stringValue(item.bidOpenDt),
    bidOpenTime: stringValue(item.bidOpenHh),
    deliveryStartDate: stringValue(item.dogBgngYmd),
    deliveryEndDate: stringValue(item.dogEndYmd),
    deliveryAddress: stringValue(item.dogAddr),
    basePrice: stringValue(item.bgngPrc),
    itemName: stringValue(item.itemNm),
    specs: itemSpecs(bidNo, item),
    rawPayload: item,
  };
}

function upstreamErrorRoot(parsed: JsonRecord) {
  const alternate = record(parsed.OpenAPI_ServiceResponse);
  return record(alternate.cmmMsgHeader);
}

export function parseEatBidXml(xml: string, request?: EatApiPageRequest): EatApiBidPage {
  if (!xml.trim() || /<!DOCTYPE/i.test(xml)) {
    throw new EatApiError('INVALID_XML', 'eAT 응답 XML 형식이 올바르지 않습니다.');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new EatApiError('INVALID_XML', 'eAT 응답 XML을 해석할 수 없습니다.');
  }

  let parsed: JsonRecord;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: false,
      trimValues: true,
    });
    parsed = record(parser.parse(xml));
  } catch {
    throw new EatApiError('INVALID_XML', 'eAT 응답 XML을 해석할 수 없습니다.');
  }

  const response = record(parsed.response);
  const header = record(response.header);
  const resultCode = stringValue(header.resultCode);
  const resultMessage = stringValue(header.resultMsg);
  if (resultCode === '5' && resultMessage === 'NO_DATA_ERROR' && request) {
    return { total: 0, page: request.page, pageSize: request.pageSize, items: [] };
  }
  if (!successfulResultCodes.has(resultCode)) {
    const alternateHeader = upstreamErrorRoot(parsed);
    const alternateCode = stringValue(alternateHeader.returnReasonCode)
      || stringValue(alternateHeader.errMsg);
    throw new EatApiError(
      'UPSTREAM_ERROR',
      alternateCode
        ? 'eAT 인증 또는 이용 한도를 확인해 주세요.'
        : 'eAT 서비스가 조회 요청을 처리하지 못했습니다.',
    );
  }

  const body = record(response.body);
  const itemsRoot = record(body.items);
  const rawItems = asArray(itemsRoot.item);
  const total = requiredInteger(body.totalCount);
  // eAT returns the total page count here, even though the request parameter uses the same name.
  const providerPageCount = requiredInteger(body.pageNo);
  const pageSize = requiredInteger(body.numOfRows);
  const page = request?.page ?? 1;
  const pageOffset = (page - 1) * pageSize;
  const expectedPageCount = Math.max(Math.ceil(total / pageSize), 1);
  const expectedItemCount = Math.min(pageSize, Math.max(total - pageOffset, 0));
  if (
    page < 1
    || pageSize < 1
    || (request !== undefined && pageSize !== request.pageSize)
    || !Number.isSafeInteger(pageOffset)
    || providerPageCount !== expectedPageCount
    || page > providerPageCount
    || rawItems.length !== expectedItemCount
  ) {
    throw new EatApiError('INVALID_XML', 'eAT 응답 페이지 정보가 올바르지 않습니다.');
  }
  const items = rawItems.map(parseAnnouncement);
  if (new Set(items.map((item) => item.bidNo)).size !== items.length) {
    throw new EatApiError('INVALID_XML', 'eAT 응답에 중복된 입찰번호가 있습니다.');
  }
  return { total, page, pageSize, items };
}
