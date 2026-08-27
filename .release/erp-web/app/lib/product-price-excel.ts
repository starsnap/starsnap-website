'use client';

import type {
  BulkProductPriceRequest,
  BulkProductPriceRow,
  PriceMonth,
  Product,
  ProductPriceSnapshot,
  ProductPriceValues,
  TenantCode,
} from './erp-types';
import { normalizeTenantCode } from './tenant-code';

export type { BulkProductPriceRequest, BulkProductPriceRow } from './erp-types';

export const PRODUCT_PRICE_WORKBOOK_SHEET_NAME = '월별단가관리';
export const PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME = '안내';
export const PRODUCT_PRICE_WORKBOOK_MAX_ROWS = 10_000;
export const PRODUCT_PRICE_WORKBOOK_MAX_BYTES = 25 * 1024 * 1024;
export const PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION = 2;
const BULK_PRODUCT_PRICE_REQUEST_SCHEMA_VERSION = 2;

export const PRODUCT_PRICE_WORKBOOK_HEADERS = [
  '단가적용월',
  '상품ID',
  '단가버전',
  '원본단가월',
  '원본단가버전',
  '상품코드',
  '상품명',
  '학교가-kg단가(원)',
  '학교가-규격단가(원)',
  '학교가-개당단가(원)',
  '업체가-kg단가(원)',
  '업체가-규격단가(원)',
  '업체가-개당단가(원)',
  '매입가-kg단가(원)',
  '매입가-규격단가(원)',
  '매입가-개당단가(원)',
] as const;

export type ProductPriceWorkbookField =
  | 'file'
  | 'workbook'
  | 'sheet'
  | 'header'
  | 'priceMonth'
  | 'productId'
  | 'expectedVersion'
  | 'expectedSourceMonth'
  | 'expectedSourceVersion'
  | 'sku'
  | 'name'
  | keyof ProductPriceValues;

export interface ProductPriceWorkbookValidationError {
  rowNumber: number;
  field?: ProductPriceWorkbookField;
  message: string;
}

export interface ProductPriceWorkbookPreviewRow {
  rowNumber: number;
  priceMonth: string;
  productId: string;
  expectedVersion: number;
  expectedSourceMonth: string | null;
  expectedSourceVersion: number;
  sku: string;
  name: string;
  prices: ProductPriceValues;
  errors?: Array<{
    field?: ProductPriceWorkbookField;
    message: string;
  }>;
}

export interface ProductPriceWorkbookParseResult {
  rows: ProductPriceWorkbookPreviewRow[];
  request: BulkProductPriceRequest;
  source: BulkProductPriceRequest['source'];
  errors: ProductPriceWorkbookValidationError[];
  totalRows: number;
  createRows: number;
  updateRows: number;
}

export class ProductPriceWorkbookParseError extends Error {
  readonly errors: ProductPriceWorkbookValidationError[];

  constructor(message: string, errors?: ProductPriceWorkbookValidationError[]) {
    super(message);
    this.name = 'ProductPriceWorkbookParseError';
    this.errors = errors ?? [{ rowNumber: 0, field: 'workbook', message }];
  }
}

type XlsxModule = typeof import('xlsx');
type WorkBook = import('xlsx').WorkBook;
type CellObject = import('xlsx').CellObject;
type ProductPriceField = keyof ProductPriceValues;

const PRICE_COLUMNS: ReadonlyArray<{
  header: (typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number];
  field: ProductPriceField;
  label: string;
}> = [
  { header: '학교가-kg단가(원)', field: 'schoolPriceKg', label: '학교가 kg단가' },
  { header: '학교가-규격단가(원)', field: 'schoolPriceSpec', label: '학교가 규격단가' },
  { header: '학교가-개당단가(원)', field: 'schoolPriceEach', label: '학교가 개당단가' },
  { header: '업체가-kg단가(원)', field: 'vendorPriceKg', label: '업체가 kg단가' },
  { header: '업체가-규격단가(원)', field: 'vendorPriceSpec', label: '업체가 규격단가' },
  { header: '업체가-개당단가(원)', field: 'vendorPriceEach', label: '업체가 개당단가' },
  { header: '매입가-kg단가(원)', field: 'purchasePriceKg', label: '매입가 kg단가' },
  { header: '매입가-규격단가(원)', field: 'purchasePriceSpec', label: '매입가 규격단가' },
  { header: '매입가-개당단가(원)', field: 'purchasePriceEach', label: '매입가 개당단가' },
];

interface CandidateRow {
  rowNumber: number;
  priceMonth: PriceMonth;
  productId: string;
  expectedVersion: number;
  expectedSourceMonth: PriceMonth | null;
  expectedSourceVersion: number;
  sku: string;
  name: string;
  prices: ProductPriceValues;
}

const PRICE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const WORKBOOK_KIND = 'PRODUCT_PRICE';

const HEADER_FIELDS: Record<(typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number], ProductPriceWorkbookField> = {
  '단가적용월': 'priceMonth',
  '상품ID': 'productId',
  '단가버전': 'expectedVersion',
  '원본단가월': 'expectedSourceMonth',
  '원본단가버전': 'expectedSourceVersion',
  '상품코드': 'sku',
  '상품명': 'name',
  '학교가-kg단가(원)': 'schoolPriceKg',
  '학교가-규격단가(원)': 'schoolPriceSpec',
  '학교가-개당단가(원)': 'schoolPriceEach',
  '업체가-kg단가(원)': 'vendorPriceKg',
  '업체가-규격단가(원)': 'vendorPriceSpec',
  '업체가-개당단가(원)': 'vendorPriceEach',
  '매입가-kg단가(원)': 'purchasePriceKg',
  '매입가-규격단가(원)': 'purchasePriceSpec',
  '매입가-개당단가(원)': 'purchasePriceEach',
};

let xlsxPromise: Promise<XlsxModule> | undefined;

function ensureBrowser() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('월별 상품 단가 엑셀은 브라우저에서만 사용할 수 있습니다.');
  }
}

function loadXlsx() {
  if (import.meta.env.SSR) {
    return Promise.reject(new Error('월별 상품 단가 엑셀은 브라우저에서만 사용할 수 있습니다.')) as Promise<XlsxModule>;
  }
  ensureBrowser();
  xlsxPromise ??= import('xlsx');
  return xlsxPromise;
}

function isPriceMonth(value: unknown): value is PriceMonth {
  return typeof value === 'string' && PRICE_MONTH_PATTERN.test(value.trim());
}

function requirePriceMonth(value: PriceMonth) {
  const normalized = value.trim();
  if (!isPriceMonth(normalized)) throw new Error('단가 적용월은 YYYY-MM 형식이어야 합니다.');
  return normalized;
}

function safeSourceFileName(value: string) {
  const sanitized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  return sanitized || 'product-prices.xlsx';
}

function fileDateStamp(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function safeDownloadFileName(
  tenant: TenantCode,
  priceMonth: PriceMonth,
  part?: { index: number; total: number },
) {
  const partSuffix = part && part.total > 1 ? `-${part.index}of${part.total}` : '';
  return safeSourceFileName(
    `${tenant.toLowerCase()}-상품단가-${priceMonth}-일괄수정-${fileDateStamp()}${partSuffix}.xlsx`,
  );
}

function triggerDownload(bytes: ArrayBuffer, fileName: string) {
  ensureBrowser();
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } catch {
    throw new Error('브라우저가 파일 다운로드를 차단했습니다. 자동 다운로드를 허용한 뒤 다시 시도해 주세요.');
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function guideRows(tenant: TenantCode, priceMonth: PriceMonth) {
  return [
    ['StarSnap ERP 월별 상품 단가 일괄관리 안내'],
    ['파일종류', WORKBOOK_KIND],
    ['테넌트코드', tenant],
    ['스키마버전', String(PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION)],
    ['단가적용월', priceMonth],
    ['데이터시트', PRODUCT_PRICE_WORKBOOK_SHEET_NAME],
    ['최대행수', `${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행`],
    ['파일분할', `상품이 ${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}건을 초과할 때만 수정 목록이 나뉘어 내려받아집니다.`],
    ['수정가능', '학교가·업체가·매입가의 kg, 규격, 개당 단가 9개만 수정하세요.'],
    ['식별정보', '단가적용월, 상품ID, 단가버전, 원본단가월·버전, 상품코드, 상품명은 임의로 변경하지 마세요.'],
    ['단가버전', '0은 선택한 월의 정확한 단가 행이 없어 이전 단가를 이어받은 상태이며, 업로드 시 선택월 단가로 새로 저장됩니다.'],
    ['원본단가', '직접 저장된 단가는 원본월이 적용월과 같고 원본버전이 단가버전과 같습니다. 이어받기는 실제 원본월(기본 상품 단가면 빈칸)과 원본버전(기본 상품 버전)을 유지해야 합니다.'],
    ['가격', '9개 단가를 빈칸 없이 0~100,000,000원의 정수로 입력하세요.'],
    ['주의', '수식, 회사·적용월 정보, 시트명과 열 이름을 변경하면 업로드할 수 없습니다.'],
  ];
}

function createWorkbook(
  XLSX: XlsxModule,
  tenant: TenantCode,
  priceMonth: PriceMonth,
  rows: Array<Array<string | number>>,
) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: `StarSnap ERP ${priceMonth} 월별 상품 단가`,
    Subject: `${tenant} ${priceMonth} 상품 단가`,
    Author: 'StarSnap ERP',
    Company: 'StarSnap ERP',
    CreatedDate: new Date(),
  };
  workbook.Custprops = {
    MealOpsWorkbookKind: WORKBOOK_KIND,
    MealOpsTenant: tenant,
    MealOpsProductPriceSchemaVersion: String(PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION),
    MealOpsPriceMonth: priceMonth,
  };

  const dataSheet = XLSX.utils.aoa_to_sheet([[...PRODUCT_PRICE_WORKBOOK_HEADERS], ...rows]);
  dataSheet['!cols'] = [
    { wch: 14 },
    { wch: 38 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 22 },
    { wch: 26 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
  ];
  const lastColumn = XLSX.utils.encode_col(PRODUCT_PRICE_WORKBOOK_HEADERS.length - 1);
  dataSheet['!autofilter'] = { ref: `A1:${lastColumn}${Math.max(rows.length + 1, 1)}` };
  for (const { header } of PRICE_COLUMNS) {
    const columnIndex = PRODUCT_PRICE_WORKBOOK_HEADERS.indexOf(header);
    for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
      const cell = dataSheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    }
  }

  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows(tenant, priceMonth));
  guideSheet['!cols'] = [{ wch: 18 }, { wch: 92 }];
  XLSX.utils.book_append_sheet(workbook, dataSheet, PRODUCT_PRICE_WORKBOOK_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, guideSheet, PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME);
  return workbook;
}

function workbookBytes(
  XLSX: XlsxModule,
  tenant: TenantCode,
  priceMonth: PriceMonth,
  rows: Array<Array<string | number>>,
) {
  return XLSX.write(createWorkbook(XLSX, tenant, priceMonth, rows), {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
    bookSST: false,
  }) as ArrayBuffer;
}

interface ProductPriceSourceExpectation {
  expectedSourceMonth: PriceMonth | null;
  expectedSourceVersion: number;
}

function assertSnapshotValues(snapshot: ProductPriceSnapshot) {
  if (!Number.isSafeInteger(snapshot.priceVersion) || snapshot.priceVersion < 0) {
    throw new Error('상품 단가 버전을 확인할 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.');
  }
  if (!Number.isSafeInteger(snapshot.priceSourceVersion) || snapshot.priceSourceVersion < 1) {
    throw new Error('원본 단가 버전을 확인할 수 없습니다. 목록을 새로고침해 주세요.');
  }
  if (snapshot.priceSourceMonth !== null && !isPriceMonth(snapshot.priceSourceMonth)) {
    throw new Error('원본 단가 적용월을 확인할 수 없습니다. 목록을 새로고침해 주세요.');
  }
  if (snapshot.priceInherited && snapshot.priceVersion !== 0) {
    throw new Error('이어받은 단가의 버전 정보가 일치하지 않습니다. 목록을 새로고침해 주세요.');
  }
  if (
    !snapshot.priceInherited
    && (
      snapshot.priceVersion === 0
      || snapshot.priceSourceMonth !== snapshot.priceMonth
      || snapshot.priceSourceVersion !== snapshot.priceVersion
    )
  ) {
    throw new Error('선택월에 직접 저장된 단가의 원본 정보가 일치하지 않습니다. 목록을 새로고침해 주세요.');
  }
  for (const { field, label } of PRICE_COLUMNS) {
    const value = snapshot[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
      throw new Error(`${label}를 엑셀로 내보낼 수 없습니다. 월별 단가 데이터를 새로고침해 주세요.`);
    }
  }
}

function sourceExpectation(
  snapshot: ProductPriceSnapshot | undefined,
  priceMonth: PriceMonth,
  productVersion: number,
): ProductPriceSourceExpectation {
  if (!Number.isSafeInteger(productVersion) || productVersion < 1) {
    throw new Error('상품 버전을 확인할 수 없습니다. 목록을 새로고침해 주세요.');
  }
  if (!snapshot) return { expectedSourceMonth: null, expectedSourceVersion: productVersion };
  if (!snapshot.priceInherited) {
    return {
      expectedSourceMonth: priceMonth,
      expectedSourceVersion: snapshot.priceVersion,
    };
  }
  if (snapshot.priceSourceMonth === null && snapshot.priceSourceVersion !== productVersion) {
    throw new Error('기본 상품 단가의 원본 버전이 현재 상품 버전과 일치하지 않습니다. 목록을 새로고침해 주세요.');
  }
  if (snapshot.priceSourceMonth !== null && snapshot.priceSourceMonth >= priceMonth) {
    throw new Error('이어받은 월별 단가의 원본월이 선택월보다 이전이 아닙니다. 목록을 새로고침해 주세요.');
  }
  return {
    expectedSourceMonth: snapshot.priceSourceMonth,
    expectedSourceVersion: snapshot.priceSourceVersion,
  };
}

function snapshotMapForMonth(productPrices: readonly ProductPriceSnapshot[], priceMonth: PriceMonth) {
  const map = new Map<string, ProductPriceSnapshot>();
  for (const snapshot of productPrices) {
    if (snapshot.priceMonth !== priceMonth) {
      throw new Error('선택한 월과 다른 단가 데이터가 포함되어 있습니다. 목록을 새로고침해 주세요.');
    }
    if (map.has(snapshot.productId)) {
      throw new Error('같은 상품의 월별 단가가 중복되어 있습니다. 목록을 새로고침해 주세요.');
    }
    assertSnapshotValues(snapshot);
    map.set(snapshot.productId, snapshot);
  }
  return map;
}

export function productPriceWorkbookPartCount(productCount: number) {
  const normalizedCount = Number.isSafeInteger(productCount) && productCount > 0 ? productCount : 0;
  return Math.max(1, Math.ceil(normalizedCount / PRODUCT_PRICE_WORKBOOK_MAX_ROWS));
}

export async function downloadProductPriceWorkbook(
  tenant: TenantCode,
  priceMonth: PriceMonth,
  products: readonly Product[],
  productPrices: readonly ProductPriceSnapshot[],
  partNumber = 1,
): Promise<void> {
  const normalizedMonth = requirePriceMonth(priceMonth);
  const total = productPriceWorkbookPartCount(products.length);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > total) {
    throw new Error('다운로드할 월별 단가 목록 번호가 올바르지 않습니다.');
  }

  const pricesByProductId = snapshotMapForMonth(productPrices, normalizedMonth);
  const seenProductIds = new Set<string>();
  for (const product of products) {
    if (seenProductIds.has(product.id)) throw new Error('상품 목록에 중복된 상품ID가 있습니다.');
    seenProductIds.add(product.id);
  }

  const start = (partNumber - 1) * PRODUCT_PRICE_WORKBOOK_MAX_ROWS;
  const rows = products
    .slice(start, start + PRODUCT_PRICE_WORKBOOK_MAX_ROWS)
    .map((product): Array<string | number> => {
      const snapshot = pricesByProductId.get(product.id);
      const source = sourceExpectation(snapshot, normalizedMonth, product.version);
      const prices = PRICE_COLUMNS.map(({ field, label }) => {
        const value = snapshot?.[field] ?? product[field];
        if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
          throw new Error(`${label}를 엑셀로 내보낼 수 없습니다. 상품과 월별 단가 데이터를 새로고침해 주세요.`);
        }
        return value;
      });
      return [
        normalizedMonth,
        product.id,
        snapshot?.priceVersion ?? 0,
        source.expectedSourceMonth ?? '',
        source.expectedSourceVersion,
        product.sku,
        product.name,
        ...prices,
      ];
    });

  const XLSX = await loadXlsx();
  triggerDownload(
    workbookBytes(XLSX, tenant, normalizedMonth, rows),
    safeDownloadFileName(tenant, normalizedMonth, { index: partNumber, total }),
  );
}

function fatal(message: string, field: ProductPriceWorkbookField = 'workbook'): never {
  throw new ProductPriceWorkbookParseError(message, [{ rowNumber: 0, field, message }]);
}

function isBlank(value: unknown) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function asText(
  value: unknown,
  rowNumber: number,
  field: ProductPriceWorkbookField,
  label: string,
  maxLength: number,
  errors: ProductPriceWorkbookValidationError[],
) {
  if (typeof value !== 'string') {
    errors.push({ rowNumber, field, message: `${label}은(는) 텍스트로 입력해 주세요.` });
    return null;
  }
  const normalized = value.trim().normalize('NFC');
  if (!normalized || normalized.length > maxLength) {
    errors.push({ rowNumber, field, message: `${label}은(는) 1~${maxLength}자로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function parseNonNegativeInteger(
  value: unknown,
  rowNumber: number,
  field: ProductPriceWorkbookField,
  label: string,
  errors: ProductPriceWorkbookValidationError[],
) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < 0) {
    errors.push({ rowNumber, field, message: `${label}은(는) 0 이상의 정수로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function parsePositiveInteger(
  value: unknown,
  rowNumber: number,
  field: ProductPriceWorkbookField,
  label: string,
  errors: ProductPriceWorkbookValidationError[],
) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < 1) {
    errors.push({ rowNumber, field, message: `${label}은(는) 1 이상의 정수로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function parseNullablePriceMonth(
  value: unknown,
  rowNumber: number,
  field: ProductPriceWorkbookField,
  label: string,
  errors: ProductPriceWorkbookValidationError[],
) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || !isPriceMonth(value)) {
    errors.push({ rowNumber, field, message: `${label}은(는) 빈칸 또는 YYYY-MM 형식으로 입력해 주세요.` });
    return undefined;
  }
  return value.trim() as PriceMonth;
}

function parsePrice(
  value: unknown,
  rowNumber: number,
  field: ProductPriceField,
  label: string,
  errors: ProductPriceWorkbookValidationError[],
) {
  let normalized: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{1,3}(,\d{3})+$/.test(text) || /^\d+$/.test(text)) {
      normalized = Number(text.replaceAll(',', ''));
    }
  }
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < 0 || normalized > 100_000_000) {
    errors.push({
      rowNumber,
      field,
      message: `${label}(원)은 0~100,000,000의 정수로 입력해 주세요.`,
    });
    return null;
  }
  return normalized;
}

function schemaVersionValue(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function guideValue(XLSX: XlsxModule, workbook: WorkBook, label: string) {
  const guideSheet = workbook.Sheets[PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME];
  if (!guideSheet) fatal(`“${PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME}” 시트를 찾을 수 없습니다.`, 'sheet');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(guideSheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  return rows.find((row) => row[0] === label)?.[1];
}

function readWorkbookScope(XLSX: XlsxModule, workbook: WorkBook) {
  const props = workbook.Custprops as Record<string, unknown> | undefined;
  const customKind = props?.MealOpsWorkbookKind;
  const guideKind = guideValue(XLSX, workbook, '파일종류');
  if (customKind !== WORKBOOK_KIND || guideKind !== WORKBOOK_KIND) {
    fatal('월별 상품 단가용 파일이 아닙니다. 현재 화면에서 수정 목록을 다시 내려받아 주세요.', 'workbook');
  }

  const customTenant = props?.MealOpsTenant;
  const guideTenant = guideValue(XLSX, workbook, '테넌트코드');
  if (typeof customTenant !== 'string' || typeof guideTenant !== 'string') {
    fatal('파일의 회사 정보를 확인할 수 없습니다.', 'workbook');
  }
  const tenantFromProps = normalizeTenantCode(customTenant);
  const tenantFromGuide = normalizeTenantCode(guideTenant);
  if (!tenantFromProps || !tenantFromGuide || tenantFromProps !== tenantFromGuide) {
    fatal('파일 내부의 회사 정보가 일치하지 않습니다.', 'workbook');
  }

  const customVersion = schemaVersionValue(props?.MealOpsProductPriceSchemaVersion);
  const guideVersion = schemaVersionValue(guideValue(XLSX, workbook, '스키마버전'));
  if (!customVersion || !guideVersion || customVersion !== guideVersion) {
    fatal('파일 내부의 월별 단가 양식 버전이 일치하지 않습니다.', 'workbook');
  }
  if (customVersion !== PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION) {
    fatal(`이 파일은 이전 월별 단가 양식(버전 ${customVersion})입니다. 최신 양식을 다시 내려받아 주세요.`, 'workbook');
  }

  const customMonth = props?.MealOpsPriceMonth;
  const guideMonth = guideValue(XLSX, workbook, '단가적용월');
  if (!isPriceMonth(customMonth) || !isPriceMonth(guideMonth)) {
    fatal('파일의 단가 적용월을 확인할 수 없습니다.', 'workbook');
  }
  const priceMonthFromProps = customMonth.trim() as PriceMonth;
  const priceMonthFromGuide = guideMonth.trim() as PriceMonth;
  if (priceMonthFromProps !== priceMonthFromGuide) {
    fatal('파일 내부의 단가 적용월이 일치하지 않습니다.', 'workbook');
  }

  return { tenant: tenantFromProps, priceMonth: priceMonthFromProps };
}

function formulaErrors(XLSX: XlsxModule, workbook: WorkBook) {
  const errors: ProductPriceWorkbookValidationError[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const denseRows = sheet['!data'];
    if (!Array.isArray(denseRows)) continue;
    denseRows.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell: CellObject | undefined, columnIndex) => {
        if (!cell?.f && !cell?.F) return;
        errors.push({
          rowNumber: sheetName === PRODUCT_PRICE_WORKBOOK_SHEET_NAME ? rowIndex + 1 : 0,
          field: sheetName === PRODUCT_PRICE_WORKBOOK_SHEET_NAME && rowIndex > 0
            ? HEADER_FIELDS[PRODUCT_PRICE_WORKBOOK_HEADERS[columnIndex]]
            : 'workbook',
          message: `수식이 포함된 셀은 사용할 수 없습니다. (${sheetName}!${XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })})`,
        });
      });
    });
  }
  return errors;
}

function headerIndex(row: unknown[]) {
  const normalizedHeaders = row.map((value) => typeof value === 'string' ? value.trim() : '');
  const duplicateHeaders = normalizedHeaders.filter((header, index) => header && normalizedHeaders.indexOf(header) !== index);
  const missingHeaders = PRODUCT_PRICE_WORKBOOK_HEADERS.filter((header) => !normalizedHeaders.includes(header));
  const unexpectedHeaders = normalizedHeaders.filter((header) => header && !PRODUCT_PRICE_WORKBOOK_HEADERS.includes(header as (typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number]));
  if (duplicateHeaders.length || missingHeaders.length || unexpectedHeaders.length) {
    const messages = [
      duplicateHeaders.length ? `중복 열: ${[...new Set(duplicateHeaders)].join(', ')}` : '',
      missingHeaders.length ? `누락 열: ${missingHeaders.join(', ')}` : '',
      unexpectedHeaders.length ? `허용되지 않은 열: ${[...new Set(unexpectedHeaders)].join(', ')}` : '',
    ].filter(Boolean);
    fatal(`월별 단가 시트의 열 이름이 올바르지 않습니다. ${messages.join(' / ')}`, 'header');
  }
  return Object.fromEntries(
    PRODUCT_PRICE_WORKBOOK_HEADERS.map((header) => [header, normalizedHeaders.indexOf(header)]),
  ) as Record<(typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number], number>;
}

function parseCandidate(
  raw: unknown[],
  rowNumber: number,
  indexes: Record<(typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number], number>,
  expectedMonth: PriceMonth,
  errors: ProductPriceWorkbookValidationError[],
): CandidateRow | null {
  const value = (header: (typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number]) => raw[indexes[header]];
  const initialErrorCount = errors.length;
  const expectedColumnIndexes = new Set(Object.values(indexes));
  const unexpectedColumnIndex = raw.findIndex((cell, index) => !expectedColumnIndexes.has(index) && !isBlank(cell));
  if (unexpectedColumnIndex >= 0) {
    errors.push({ rowNumber, field: 'header', message: `${unexpectedColumnIndex + 1}번째 열에 허용되지 않은 값이 있습니다.` });
  }

  const rawMonth = asText(value('단가적용월'), rowNumber, 'priceMonth', '단가적용월', 7, errors);
  let priceMonth: PriceMonth | null = null;
  if (rawMonth) {
    if (!isPriceMonth(rawMonth)) {
      errors.push({ rowNumber, field: 'priceMonth', message: '단가적용월은 YYYY-MM 형식으로 입력해 주세요.' });
    } else {
      priceMonth = rawMonth;
      if (priceMonth !== expectedMonth) {
        errors.push({ rowNumber, field: 'priceMonth', message: `파일의 적용월(${expectedMonth})과 행의 적용월(${priceMonth})이 다릅니다.` });
      }
    }
  }

  const productId = asText(value('상품ID'), rowNumber, 'productId', '상품ID', 128, errors);
  const expectedVersion = parseNonNegativeInteger(value('단가버전'), rowNumber, 'expectedVersion', '단가버전', errors);
  const expectedSourceMonth = parseNullablePriceMonth(
    value('원본단가월'),
    rowNumber,
    'expectedSourceMonth',
    '원본단가월',
    errors,
  );
  const expectedSourceVersion = parsePositiveInteger(
    value('원본단가버전'),
    rowNumber,
    'expectedSourceVersion',
    '원본단가버전',
    errors,
  );
  const skuText = asText(value('상품코드'), rowNumber, 'sku', '상품코드', 30, errors);
  const sku = skuText?.toLocaleUpperCase('en-US') ?? null;
  if (sku && !/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(sku)) {
    errors.push({ rowNumber, field: 'sku', message: '상품코드는 영문 대문자, 숫자, 하이픈으로 2~30자 입력해 주세요.' });
  }
  const name = asText(value('상품명'), rowNumber, 'name', '상품명', 100, errors);
  const prices = Object.fromEntries(PRICE_COLUMNS.map(({ header, field, label }) => [
    field,
    parsePrice(value(header), rowNumber, field, label, errors),
  ])) as Record<ProductPriceField, number | null>;
  if (
    expectedVersion === 0
    && expectedSourceMonth
    && expectedSourceMonth >= expectedMonth
  ) {
    errors.push({
      rowNumber,
      field: 'expectedSourceMonth',
      message: '이어받은 월별 단가의 원본단가월은 선택한 적용월보다 이전이어야 합니다.',
    });
  }
  if (
    expectedVersion !== null
    && expectedSourceMonth !== undefined
    && expectedSourceVersion !== null
    && expectedVersion > 0
    && (expectedSourceMonth !== expectedMonth || expectedSourceVersion !== expectedVersion)
  ) {
    errors.push({
      rowNumber,
      field: 'expectedSourceVersion',
      message: '선택월에 직접 저장된 단가는 원본단가월이 적용월과, 원본단가버전이 단가버전과 같아야 합니다.',
    });
  }

  if (
    errors.length !== initialErrorCount
    || !priceMonth
    || !productId
    || expectedVersion === null
    || expectedSourceMonth === undefined
    || expectedSourceVersion === null
    || !sku
    || !name
    || PRICE_COLUMNS.some(({ field }) => prices[field] === null)
  ) return null;

  return {
    rowNumber,
    priceMonth,
    productId,
    expectedVersion,
    expectedSourceMonth,
    expectedSourceVersion,
    sku,
    name,
    prices: prices as ProductPriceValues,
  };
}

function previewText(value: unknown) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim().normalize('NFC') : String(value);
}

function previewInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

function previewRow(
  raw: unknown[],
  rowNumber: number,
  indexes: Record<(typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number], number>,
): ProductPriceWorkbookPreviewRow {
  const value = (header: (typeof PRODUCT_PRICE_WORKBOOK_HEADERS)[number]) => raw[indexes[header]];
  const prices = Object.fromEntries(PRICE_COLUMNS.map(({ header, field }) => {
    const rawPrice = value(header);
    return [field, typeof rawPrice === 'string' ? previewInteger(rawPrice.replaceAll(',', '')) : previewInteger(rawPrice)];
  })) as ProductPriceValues;
  return {
    rowNumber,
    priceMonth: previewText(value('단가적용월')),
    productId: previewText(value('상품ID')),
    expectedVersion: previewInteger(value('단가버전')),
    expectedSourceMonth: isBlank(value('원본단가월'))
      ? null
      : previewText(value('원본단가월')),
    expectedSourceVersion: previewInteger(value('원본단가버전')),
    sku: previewText(value('상품코드')).toLocaleUpperCase('en-US'),
    name: previewText(value('상품명')),
    prices,
  };
}

function validationErrorKey(error: ProductPriceWorkbookValidationError) {
  return `${error.rowNumber}\u0000${error.field ?? ''}\u0000${error.message}`;
}

function addErrorOnce(
  errors: ProductPriceWorkbookValidationError[],
  errorKeys: Set<string>,
  error: ProductPriceWorkbookValidationError,
) {
  const key = validationErrorKey(error);
  if (errorKeys.has(key)) return;
  errorKeys.add(key);
  errors.push(error);
}

function validateAgainstCurrentData(
  candidates: CandidateRow[],
  products: readonly Product[],
  productPrices: readonly ProductPriceSnapshot[],
  expectedMonth: PriceMonth,
  errors: ProductPriceWorkbookValidationError[],
) {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const pricesByProductId = snapshotMapForMonth(productPrices, expectedMonth);
  const rowsByProductId = new Map<string, CandidateRow[]>();
  const errorKeys = new Set(errors.map(validationErrorKey));

  for (const candidate of candidates) {
    const sameIdRows = rowsByProductId.get(candidate.productId) ?? [];
    sameIdRows.push(candidate);
    rowsByProductId.set(candidate.productId, sameIdRows);

    const product = productsById.get(candidate.productId);
    if (!product) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'productId', message: '현재 상품 목록에서 상품ID를 찾을 수 없습니다.' });
      continue;
    }
    if (product.sku.trim().toLocaleUpperCase('en-US') !== candidate.sku) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'sku', message: '상품코드가 현재 상품 정보와 다릅니다. 새 수정 목록을 다시 내려받아 주세요.' });
    }
    if (product.name.trim().normalize('NFC') !== candidate.name) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'name', message: '상품명이 현재 상품 정보와 다릅니다. 새 수정 목록을 다시 내려받아 주세요.' });
    }
    const currentSnapshot = pricesByProductId.get(candidate.productId);
    const currentVersion = currentSnapshot?.priceVersion ?? 0;
    if (currentVersion !== candidate.expectedVersion) {
      addErrorOnce(errors, errorKeys, {
        rowNumber: candidate.rowNumber,
        field: 'expectedVersion',
        message: `선택월 단가의 현재 버전(${currentVersion})과 파일의 버전(${candidate.expectedVersion})이 다릅니다. 새 수정 목록을 다시 내려받아 주세요.`,
      });
    }
    const currentSource = sourceExpectation(currentSnapshot, expectedMonth, product.version);
    if (currentSource.expectedSourceMonth !== candidate.expectedSourceMonth) {
      addErrorOnce(errors, errorKeys, {
        rowNumber: candidate.rowNumber,
        field: 'expectedSourceMonth',
        message: `원본 단가월이 현재 데이터(${currentSource.expectedSourceMonth ?? '없음'})와 파일(${candidate.expectedSourceMonth ?? '없음'})에서 다릅니다. 새 수정 목록을 다시 내려받아 주세요.`,
      });
    }
    if (currentSource.expectedSourceVersion !== candidate.expectedSourceVersion) {
      addErrorOnce(errors, errorKeys, {
        rowNumber: candidate.rowNumber,
        field: 'expectedSourceVersion',
        message: `원본 단가버전이 현재 데이터(${currentSource.expectedSourceVersion})와 파일(${candidate.expectedSourceVersion})에서 다릅니다. 새 수정 목록을 다시 내려받아 주세요.`,
      });
    }
  }

  for (const duplicateRows of rowsByProductId.values()) {
    if (duplicateRows.length < 2) continue;
    duplicateRows.forEach((row) => addErrorOnce(errors, errorKeys, {
      rowNumber: row.rowNumber,
      field: 'productId',
      message: '같은 상품ID가 파일에 두 번 이상 포함되어 있습니다.',
    }));
  }
}

async function sha256Hex(buffer: ArrayBuffer) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fatal('파일 무결성을 확인할 수 없는 브라우저입니다.', 'file');
  const digest = await subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function parseProductPriceWorkbook(
  file: File,
  activeTenant: TenantCode,
  activePriceMonth: PriceMonth,
  products: readonly Product[],
  productPrices: readonly ProductPriceSnapshot[],
): Promise<ProductPriceWorkbookParseResult> {
  ensureBrowser();
  const normalizedActiveMonth = requirePriceMonth(activePriceMonth);
  if (!(file instanceof File)) fatal('업로드할 XLSX 파일을 선택해 주세요.', 'file');
  if (!/\.xlsx$/i.test(file.name)) fatal('XLSX 확장자의 파일만 업로드할 수 있습니다.', 'file');
  if (file.size === 0) fatal('빈 파일은 업로드할 수 없습니다.', 'file');
  if (file.size > PRODUCT_PRICE_WORKBOOK_MAX_BYTES) {
    fatal(`파일 크기는 ${PRODUCT_PRICE_WORKBOOK_MAX_BYTES / (1024 * 1024)}MB 이하여야 합니다.`, 'file');
  }

  const buffer = await file.arrayBuffer();
  const [XLSX, fileSha256] = await Promise.all([loadXlsx(), sha256Hex(buffer)]);
  let workbook: WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      dense: true,
      sheetRows: PRODUCT_PRICE_WORKBOOK_MAX_ROWS + 2,
      cellFormula: true,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
      bookDeps: false,
      bookFiles: false,
      raw: true,
    });
  } catch {
    fatal('엑셀 파일을 읽을 수 없습니다. 손상되었거나 암호가 설정된 파일인지 확인해 주세요.', 'file');
  }

  const unexpectedSheets = workbook.SheetNames.filter(
    (name) => name !== PRODUCT_PRICE_WORKBOOK_SHEET_NAME && name !== PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME,
  );
  if (unexpectedSheets.length) fatal(`허용되지 않은 시트가 있습니다: ${unexpectedSheets.join(', ')}`, 'sheet');
  const sheet = workbook.Sheets[PRODUCT_PRICE_WORKBOOK_SHEET_NAME];
  if (!sheet) fatal(`“${PRODUCT_PRICE_WORKBOOK_SHEET_NAME}” 시트를 찾을 수 없습니다.`, 'sheet');
  const guideSheet = workbook.Sheets[PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME];
  if (!guideSheet) fatal(`“${PRODUCT_PRICE_WORKBOOK_GUIDE_SHEET_NAME}” 시트를 찾을 수 없습니다.`, 'sheet');
  const guideReference = typeof guideSheet['!fullref'] === 'string' ? guideSheet['!fullref'] : guideSheet['!ref'];
  if (guideReference) {
    const guideRange = XLSX.utils.decode_range(guideReference);
    if (guideRange.e.r > 50 || guideRange.e.c > 1) {
      fatal('안내 시트의 구조가 변경되었습니다. 수정 목록을 다시 내려받아 주세요.', 'sheet');
    }
  }

  const formulas = formulaErrors(XLSX, workbook);
  if (formulas.length) throw new ProductPriceWorkbookParseError('수식이 포함된 파일은 업로드할 수 없습니다.', formulas);

  const scope = readWorkbookScope(XLSX, workbook);
  if (scope.tenant !== activeTenant) fatal('다른 회사에서 내보낸 파일은 현재 회사에 적용할 수 없습니다.', 'workbook');
  if (scope.priceMonth !== normalizedActiveMonth) {
    fatal(`이 파일은 ${scope.priceMonth} 단가용입니다. 현재 선택한 ${normalizedActiveMonth}에는 적용할 수 없습니다.`, 'workbook');
  }

  const fullReference = typeof sheet['!fullref'] === 'string' ? sheet['!fullref'] : sheet['!ref'];
  if (fullReference) {
    const fullRange = XLSX.utils.decode_range(fullReference);
    if (fullRange.e.r > PRODUCT_PRICE_WORKBOOK_MAX_ROWS) {
      fatal(`단가 데이터는 헤더를 제외하고 ${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행까지만 입력할 수 있습니다.`, 'sheet');
    }
  }

  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  if (!rawRows.length) fatal('월별 단가 시트에 헤더가 없습니다.', 'header');
  const indexes = headerIndex(rawRows[0]);
  const dataRows = rawRows.slice(1)
    .map((row, index) => ({ raw: row, rowNumber: index + 2 }))
    .filter(({ raw }) => raw.some((value) => !isBlank(value)));
  if (dataRows.length === 0) fatal('수정할 월별 상품 단가 행을 입력해 주세요.', 'sheet');
  if (dataRows.length > PRODUCT_PRICE_WORKBOOK_MAX_ROWS) {
    fatal(`한 파일에는 월별 단가를 ${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행까지만 업로드할 수 있습니다.`, 'sheet');
  }

  const errors: ProductPriceWorkbookValidationError[] = [];
  const previewRows = dataRows.map(({ raw, rowNumber }) => previewRow(raw, rowNumber, indexes));
  const candidates = dataRows
    .map(({ raw, rowNumber }) => parseCandidate(raw, rowNumber, indexes, scope.priceMonth, errors))
    .filter((candidate): candidate is CandidateRow => candidate !== null);

  try {
    validateAgainstCurrentData(candidates, products, productPrices, scope.priceMonth, errors);
  } catch (error) {
    fatal(error instanceof Error ? error.message : '현재 월별 단가 데이터를 확인하지 못했습니다.', 'workbook');
  }

  const invalidRows = new Set(errors.map((error) => error.rowNumber));
  const validRows: BulkProductPriceRow[] = candidates
    .filter((candidate) => !invalidRows.has(candidate.rowNumber))
    .map((candidate) => ({
      rowNumber: candidate.rowNumber,
      productId: candidate.productId,
      expectedVersion: candidate.expectedVersion,
      expectedSourceMonth: candidate.expectedSourceMonth,
      expectedSourceVersion: candidate.expectedSourceVersion,
      prices: candidate.prices,
    }));

  const source = { fileName: safeSourceFileName(file.name), fileSha256 };
  const previewRowNumbers = new Set(previewRows.map((row) => row.rowNumber));
  const errorsByRow = new Map<number, ProductPriceWorkbookValidationError[]>();
  for (const error of errors) {
    if (!previewRowNumbers.has(error.rowNumber)) continue;
    const rowErrors = errorsByRow.get(error.rowNumber) ?? [];
    rowErrors.push(error);
    errorsByRow.set(error.rowNumber, rowErrors);
  }
  const rows: ProductPriceWorkbookPreviewRow[] = previewRows.map((row) => {
    const rowValidationErrors = (errorsByRow.get(row.rowNumber) ?? [])
      .map(({ field, message }) => ({ field, message }));
    return rowValidationErrors.length ? { ...row, errors: rowValidationErrors } : row;
  });

  return {
    rows,
    request: {
      schemaVersion: BULK_PRODUCT_PRICE_REQUEST_SCHEMA_VERSION,
      tenant: scope.tenant,
      priceMonth: scope.priceMonth,
      source,
      rows: validRows,
    },
    source,
    errors: errors
      .filter((error) => !previewRowNumbers.has(error.rowNumber))
      .sort((left, right) => left.rowNumber - right.rowNumber),
    totalRows: dataRows.length,
    createRows: previewRows.filter((row) => row.expectedVersion === 0).length,
    updateRows: previewRows.filter((row) => row.expectedVersion > 0).length,
  };
}
