'use client';

import type {
  BulkProductRequest,
  BulkProductRow,
  Product,
  ProductInput,
  ProductStorageType,
  ProductUnit,
  TenantCode,
} from './erp-types';
import { normalizeTenantCode } from './tenant-code';

export type { BulkProductRequest, BulkProductRow } from './erp-types';

export const PRODUCT_WORKBOOK_SHEET_NAME = '상품일괄관리';
export const PRODUCT_WORKBOOK_GUIDE_SHEET_NAME = '안내';
export const PRODUCT_WORKBOOK_MAX_ROWS = 10_000;
export const PRODUCT_WORKBOOK_MAX_BYTES = 25 * 1024 * 1024;
export const PRODUCT_WORKBOOK_SCHEMA_VERSION = 2;

export const PRODUCT_WORKBOOK_HEADERS = [
  '작업',
  '상품ID',
  '버전',
  '상품코드',
  '상품명',
  '분류',
  '규격',
  '재고단위',
  '기본학교가-kg단가(원)',
  '기본학교가-규격단가(원)',
  '기본학교가-개당단가(원)',
  '기본업체가-kg단가(원)',
  '기본업체가-규격단가(원)',
  '기본업체가-개당단가(원)',
  '기본매입가-kg단가(원)',
  '기본매입가-규격단가(원)',
  '기본매입가-개당단가(원)',
  '기본공급업체',
  '보관방법',
  '알레르기정보',
] as const;

export type ProductWorkbookField =
  | 'file'
  | 'workbook'
  | 'sheet'
  | 'header'
  | 'action'
  | 'id'
  | 'expectedVersion'
  | keyof ProductInput;

export interface ProductWorkbookValidationError {
  rowNumber: number;
  field?: ProductWorkbookField;
  message: string;
}

export type ProductWorkbookPreviewRow = BulkProductRow & {
  errors?: Array<{
    field?: ProductWorkbookField;
    message: string;
  }>;
};

export interface ProductWorkbookParseResult {
  rows: ProductWorkbookPreviewRow[];
  request: BulkProductRequest;
  source: BulkProductRequest['source'];
  errors: ProductWorkbookValidationError[];
  totalRows: number;
  createRows: number;
  updateRows: number;
}

export class ProductWorkbookParseError extends Error {
  readonly errors: ProductWorkbookValidationError[];

  constructor(message: string, errors?: ProductWorkbookValidationError[]) {
    super(message);
    this.name = 'ProductWorkbookParseError';
    this.errors = errors ?? [{ rowNumber: 0, field: 'workbook', message }];
  }
}

type XlsxModule = typeof import('xlsx');
type WorkBook = import('xlsx').WorkBook;
type CellObject = import('xlsx').CellObject;

type WorkbookAction = 'create' | 'update';
type ProductPriceField =
  | 'schoolPriceKg'
  | 'schoolPriceSpec'
  | 'schoolPriceEach'
  | 'vendorPriceKg'
  | 'vendorPriceSpec'
  | 'vendorPriceEach'
  | 'purchasePriceKg'
  | 'purchasePriceSpec'
  | 'purchasePriceEach';

const PRICE_COLUMNS: ReadonlyArray<{
  header: (typeof PRODUCT_WORKBOOK_HEADERS)[number];
  field: ProductPriceField;
  label: string;
}> = [
  { header: '기본학교가-kg단가(원)', field: 'schoolPriceKg', label: '기본 학교가 kg단가' },
  { header: '기본학교가-규격단가(원)', field: 'schoolPriceSpec', label: '기본 학교가 규격단가' },
  { header: '기본학교가-개당단가(원)', field: 'schoolPriceEach', label: '기본 학교가 개당단가' },
  { header: '기본업체가-kg단가(원)', field: 'vendorPriceKg', label: '기본 업체가 kg단가' },
  { header: '기본업체가-규격단가(원)', field: 'vendorPriceSpec', label: '기본 업체가 규격단가' },
  { header: '기본업체가-개당단가(원)', field: 'vendorPriceEach', label: '기본 업체가 개당단가' },
  { header: '기본매입가-kg단가(원)', field: 'purchasePriceKg', label: '기본 매입가 kg단가' },
  { header: '기본매입가-규격단가(원)', field: 'purchasePriceSpec', label: '기본 매입가 규격단가' },
  { header: '기본매입가-개당단가(원)', field: 'purchasePriceEach', label: '기본 매입가 개당단가' },
];

interface CandidateRow {
  rowNumber: number;
  action: WorkbookAction;
  id?: string;
  expectedVersion?: number;
  product: ProductInput;
}

const HEADER_FIELDS: Record<(typeof PRODUCT_WORKBOOK_HEADERS)[number], ProductWorkbookField> = {
  '작업': 'action',
  '상품ID': 'id',
  '버전': 'expectedVersion',
  '상품코드': 'sku',
  '상품명': 'name',
  '분류': 'category',
  '규격': 'specification',
  '재고단위': 'unit',
  '기본학교가-kg단가(원)': 'schoolPriceKg',
  '기본학교가-규격단가(원)': 'schoolPriceSpec',
  '기본학교가-개당단가(원)': 'schoolPriceEach',
  '기본업체가-kg단가(원)': 'vendorPriceKg',
  '기본업체가-규격단가(원)': 'vendorPriceSpec',
  '기본업체가-개당단가(원)': 'vendorPriceEach',
  '기본매입가-kg단가(원)': 'purchasePriceKg',
  '기본매입가-규격단가(원)': 'purchasePriceSpec',
  '기본매입가-개당단가(원)': 'purchasePriceEach',
  '기본공급업체': 'supplierName',
  '보관방법': 'storageType',
  '알레르기정보': 'allergens',
};

const LEGACY_PRICE_HEADER_ALIASES: Record<string, (typeof PRODUCT_WORKBOOK_HEADERS)[number]> = {
  '학교가-kg단가(원)': '기본학교가-kg단가(원)',
  '학교가-규격단가(원)': '기본학교가-규격단가(원)',
  '학교가-개당단가(원)': '기본학교가-개당단가(원)',
  '업체가-kg단가(원)': '기본업체가-kg단가(원)',
  '업체가-규격단가(원)': '기본업체가-규격단가(원)',
  '업체가-개당단가(원)': '기본업체가-개당단가(원)',
  '매입가-kg단가(원)': '기본매입가-kg단가(원)',
  '매입가-규격단가(원)': '기본매입가-규격단가(원)',
  '매입가-개당단가(원)': '기본매입가-개당단가(원)',
};

const UNIT_LABELS: Record<ProductUnit, string> = {
  KG: 'kg',
  G: 'g',
  EA: '개',
  BOX: '박스',
  PACK: '팩',
  L: 'L',
  BAG: '봉',
};

const UNIT_ALIASES = new Map<string, ProductUnit>([
  ['KG', 'KG'],
  ['킬로그램', 'KG'],
  ['G', 'G'],
  ['그램', 'G'],
  ['EA', 'EA'],
  ['개', 'EA'],
  ['BOX', 'BOX'],
  ['박스', 'BOX'],
  ['PACK', 'PACK'],
  ['팩', 'PACK'],
  ['L', 'L'],
  ['리터', 'L'],
  ['BAG', 'BAG'],
  ['봉', 'BAG'],
]);

const STORAGE_LABELS: Record<ProductStorageType, string> = {
  AMBIENT: '상온',
  CHILLED: '냉장',
  FROZEN: '냉동',
};

const STORAGE_ALIASES = new Map<string, ProductStorageType>([
  ['AMBIENT', 'AMBIENT'],
  ['상온', 'AMBIENT'],
  ['CHILLED', 'CHILLED'],
  ['냉장', 'CHILLED'],
  ['FROZEN', 'FROZEN'],
  ['냉동', 'FROZEN'],
]);

let xlsxPromise: Promise<XlsxModule> | undefined;

function ensureBrowser() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('엑셀 일괄관리는 브라우저에서만 사용할 수 있습니다.');
  }
}

function loadXlsx() {
  if (import.meta.env.SSR) {
    return Promise.reject(new Error('엑셀 일괄관리는 브라우저에서만 사용할 수 있습니다.')) as Promise<XlsxModule>;
  }
  ensureBrowser();
  xlsxPromise ??= import('xlsx');
  return xlsxPromise;
}

function normalizeAlias(value: string) {
  return value.trim().toLocaleUpperCase('en-US');
}

function safeSourceFileName(value: string) {
  const sanitized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  return sanitized || 'products.xlsx';
}

function fileDateStamp(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function safeDownloadFileName(
  tenant: TenantCode,
  kind: '등록양식' | '일괄수정',
  part?: { index: number; total: number },
) {
  const partSuffix = part && part.total > 1 ? `-${part.index}of${part.total}` : '';
  return safeSourceFileName(`${tenant.toLowerCase()}-상품-${kind}-${fileDateStamp()}${partSuffix}.xlsx`);
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

function guideRows(tenant: TenantCode) {
  return [
    ['StarSnap ERP 상품 일괄관리 안내'],
    ['테넌트코드', tenant],
    ['스키마버전', String(PRODUCT_WORKBOOK_SCHEMA_VERSION)],
    ['데이터시트', PRODUCT_WORKBOOK_SHEET_NAME],
    ['최대행수', `${PRODUCT_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행`],
    ['파일분할', `수정용 목록이 ${PRODUCT_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}건을 초과할 때만 ${PRODUCT_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}건씩 나뉘며, 화면에서 각 XLSX 파일을 따로 내려받습니다.`],
    ['작업', '신규 상품은 “등록”, 기존 상품은 “수정”으로 입력합니다.'],
    ['수정', '상품ID와 버전을 임의로 변경하지 마세요.'],
    ['기본 가격', '월별 단가가 없는 기간에 적용할 학교가, 업체가, 매입가의 kg단가, 규격단가, 개당단가를 원 단위 숫자로 입력합니다. 선택월 실제 단가는 월별 단가 엑셀에서 수정합니다. 빈 가격 칸은 허용되지 않습니다.'],
    ['단위', 'kg, g, 개, 박스, 팩, L, 봉 또는 KG, G, EA, BOX, PACK, L, BAG'],
    ['보관방법', '상온, 냉장, 냉동 또는 AMBIENT, CHILLED, FROZEN'],
    ['주의', '수식, 테넌트 정보, 시트명과 열 이름을 변경하면 업로드할 수 없습니다.'],
  ];
}

function createWorkbook(
  XLSX: XlsxModule,
  tenant: TenantCode,
  rows: Array<Array<string | number>>,
) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: 'StarSnap ERP 상품 일괄관리',
    Subject: `${tenant} 상품 기준정보`,
    Author: 'StarSnap ERP',
    Company: 'StarSnap ERP',
    CreatedDate: new Date(),
  };
  workbook.Custprops = {
    MealOpsTenant: tenant,
    MealOpsSchemaVersion: String(PRODUCT_WORKBOOK_SCHEMA_VERSION),
  };

  const dataSheet = XLSX.utils.aoa_to_sheet([[...PRODUCT_WORKBOOK_HEADERS], ...rows]);
  dataSheet['!cols'] = [
    { wch: 10 },
    { wch: 38 },
    { wch: 10 },
    { wch: 22 },
    { wch: 24 },
    { wch: 16 },
    { wch: 22 },
    { wch: 14 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
    { wch: 21 },
    { wch: 23 },
    { wch: 21 },
    { wch: 24 },
    { wch: 14 },
    { wch: 28 },
  ];
  const lastColumn = XLSX.utils.encode_col(PRODUCT_WORKBOOK_HEADERS.length - 1);
  dataSheet['!autofilter'] = { ref: `A1:${lastColumn}${Math.max(rows.length + 1, 1)}` };
  for (const { header } of PRICE_COLUMNS) {
    const columnIndex = PRODUCT_WORKBOOK_HEADERS.indexOf(header);
    for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
      const cell = dataSheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    }
  }

  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows(tenant));
  guideSheet['!cols'] = [{ wch: 18 }, { wch: 82 }];

  XLSX.utils.book_append_sheet(workbook, dataSheet, PRODUCT_WORKBOOK_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, guideSheet, PRODUCT_WORKBOOK_GUIDE_SHEET_NAME);
  return workbook;
}

async function writeAndDownload(
  tenant: TenantCode,
  rows: Array<Array<string | number>>,
  kind: '등록양식' | '일괄수정',
) {
  const XLSX = await loadXlsx();
  const workbook = createWorkbook(XLSX, tenant, rows);
  const bytes = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
    bookSST: false,
  }) as ArrayBuffer;
  triggerDownload(bytes, safeDownloadFileName(tenant, kind));
}

function workbookBytes(XLSX: XlsxModule, tenant: TenantCode, rows: Array<Array<string | number>>) {
  return XLSX.write(createWorkbook(XLSX, tenant, rows), {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
    bookSST: false,
  }) as ArrayBuffer;
}

export async function downloadCreateTemplate(tenant: TenantCode): Promise<void> {
  await writeAndDownload(tenant, [], '등록양식');
}

export function productUpdateWorkbookPartCount(productCount: number) {
  const normalizedCount = Number.isSafeInteger(productCount) && productCount > 0 ? productCount : 0;
  return Math.max(1, Math.ceil(normalizedCount / PRODUCT_WORKBOOK_MAX_ROWS));
}

export async function downloadUpdateWorkbook(
  tenant: TenantCode,
  products: readonly Product[],
  partNumber = 1,
): Promise<void> {
  const total = productUpdateWorkbookPartCount(products.length);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > total) {
    throw new Error('다운로드할 수정 목록 번호가 올바르지 않습니다.');
  }
  const start = (partNumber - 1) * PRODUCT_WORKBOOK_MAX_ROWS;
  const rows = products
    .slice(start, start + PRODUCT_WORKBOOK_MAX_ROWS)
    .map((product): Array<string | number> => [
    '수정',
    product.id,
    product.version,
    product.sku,
    product.name,
    product.category,
    product.specification,
    UNIT_LABELS[product.unit],
    ...PRICE_COLUMNS.map(({ field }) => product[field]),
    product.supplierName,
    STORAGE_LABELS[product.storageType],
    product.allergens,
  ]);

  const XLSX = await loadXlsx();
  triggerDownload(
    workbookBytes(XLSX, tenant, rows),
    safeDownloadFileName(tenant, '일괄수정', { index: partNumber, total }),
  );
}

function fatal(message: string, field: ProductWorkbookField = 'workbook'): never {
  throw new ProductWorkbookParseError(message, [{ rowNumber: 0, field, message }]);
}

function isBlank(value: unknown) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function asText(value: unknown, rowNumber: number, field: ProductWorkbookField, label: string, maxLength: number, errors: ProductWorkbookValidationError[]) {
  if (typeof value !== 'string') {
    errors.push({ rowNumber, field, message: `${label}은(는) 텍스트로 입력해 주세요.` });
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    errors.push({ rowNumber, field, message: `${label}은(는) 1~${maxLength}자로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function optionalText(value: unknown, rowNumber: number, field: ProductWorkbookField, label: string, maxLength: number, errors: ProductWorkbookValidationError[]) {
  if (isBlank(value)) return '';
  if (typeof value !== 'string') {
    errors.push({ rowNumber, field, message: `${label}은(는) 텍스트로 입력해 주세요.` });
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    errors.push({ rowNumber, field, message: `${label}은(는) ${maxLength}자 이하로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function parsePositiveInteger(value: unknown, rowNumber: number, field: ProductWorkbookField, label: string, errors: ProductWorkbookValidationError[]) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < 1) {
    errors.push({ rowNumber, field, message: `${label}은(는) 1 이상의 정수로 입력해 주세요.` });
    return null;
  }
  return normalized;
}

function parsePrice(
  value: unknown,
  rowNumber: number,
  field: ProductPriceField,
  label: string,
  errors: ProductWorkbookValidationError[],
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

function readSchemaVersion(XLSX: XlsxModule, workbook: WorkBook) {
  const customVersion = schemaVersionValue(
    (workbook.Custprops as Record<string, unknown> | undefined)?.MealOpsSchemaVersion,
  );
  const guideSheet = workbook.Sheets[PRODUCT_WORKBOOK_GUIDE_SHEET_NAME];
  let guideVersion: number | undefined;
  if (guideSheet) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(guideSheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    guideVersion = schemaVersionValue(rows.find((row) => row[0] === '스키마버전')?.[1]);
  }

  if (customVersion && guideVersion && customVersion !== guideVersion) {
    fatal('파일 내부의 엑셀 양식 버전이 서로 다릅니다. 현재 회사에서 파일을 다시 내려받아 주세요.', 'workbook');
  }
  const version = customVersion ?? guideVersion;
  if (!version) {
    fatal('엑셀 양식 버전을 확인할 수 없습니다. 현재 회사에서 등록 템플릿이나 수정용 목록을 다시 내려받아 주세요.', 'workbook');
  }
  if (version !== PRODUCT_WORKBOOK_SCHEMA_VERSION) {
    fatal(`이 파일은 이전 상품 엑셀 양식(버전 ${version})입니다. 기본 단가와 월별 단가가 구분된 최신 양식을 다시 내려받아 주세요.`, 'workbook');
  }
}

function parseAction(value: unknown, rowNumber: number, errors: ProductWorkbookValidationError[]) {
  if (typeof value !== 'string') {
    errors.push({ rowNumber, field: 'action', message: '작업은 “등록” 또는 “수정”으로 입력해 주세요.' });
    return null;
  }
  const normalized = value.trim();
  if (normalized === '등록') return 'create' as const;
  if (normalized === '수정') return 'update' as const;
  errors.push({ rowNumber, field: 'action', message: '작업은 “등록” 또는 “수정”으로 입력해 주세요.' });
  return null;
}

function parseUnit(value: unknown, rowNumber: number, errors: ProductWorkbookValidationError[]) {
  if (typeof value === 'string') {
    const unit = UNIT_ALIASES.get(normalizeAlias(value));
    if (unit) return unit;
  }
  errors.push({ rowNumber, field: 'unit', message: '재고단위는 kg, g, 개, 박스, 팩, L, 봉 중 하나로 입력해 주세요.' });
  return null;
}

function parseStorageType(value: unknown, rowNumber: number, errors: ProductWorkbookValidationError[]) {
  if (typeof value === 'string') {
    const storageType = STORAGE_ALIASES.get(normalizeAlias(value));
    if (storageType) return storageType;
  }
  errors.push({ rowNumber, field: 'storageType', message: '보관방법은 상온, 냉장, 냉동 중 하나로 입력해 주세요.' });
  return null;
}

function validationErrorKey(error: ProductWorkbookValidationError) {
  return `${error.rowNumber}\u0000${error.field ?? ''}\u0000${error.message}`;
}

function addErrorOnce(
  errors: ProductWorkbookValidationError[],
  errorKeys: Set<string>,
  error: ProductWorkbookValidationError,
) {
  const key = validationErrorKey(error);
  if (errorKeys.has(key)) return;
  errorKeys.add(key);
  errors.push(error);
}

function readTenant(XLSX: XlsxModule, workbook: WorkBook) {
  const customTenant = (workbook.Custprops as Record<string, unknown> | undefined)?.MealOpsTenant;
  let tenantFromCustomProperties: TenantCode | undefined;
  if (typeof customTenant === 'string') {
    const normalized = normalizeTenantCode(customTenant);
    if (!normalized) fatal('템플릿의 회사 정보가 올바르지 않습니다.', 'workbook');
    tenantFromCustomProperties = normalized;
  }

  let tenantFromGuide: TenantCode | undefined;
  const guideSheet = workbook.Sheets[PRODUCT_WORKBOOK_GUIDE_SHEET_NAME];
  if (guideSheet) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(guideSheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const tenantRow = rows.find((row) => row[0] === '테넌트코드');
    const guideTenant = tenantRow?.[1];
    if (typeof guideTenant === 'string') {
      const normalized = normalizeTenantCode(guideTenant);
      if (!normalized) fatal('안내 시트의 회사 정보가 올바르지 않습니다.', 'workbook');
      tenantFromGuide = normalized;
    }
  }

  if (tenantFromCustomProperties && tenantFromGuide && tenantFromCustomProperties !== tenantFromGuide) {
    fatal('파일 내부의 회사 정보가 서로 다릅니다. 현재 회사에서 파일을 다시 내보내 주세요.', 'workbook');
  }
  return tenantFromCustomProperties ?? tenantFromGuide;
}

function formulaErrors(XLSX: XlsxModule, workbook: WorkBook) {
  const errors: ProductWorkbookValidationError[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const denseRows = sheet['!data'];
    if (Array.isArray(denseRows)) {
      denseRows.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) return;
        row.forEach((cell: CellObject | undefined, columnIndex) => {
          if (!cell?.f && !cell?.F) return;
          errors.push({
            rowNumber: sheetName === PRODUCT_WORKBOOK_SHEET_NAME ? rowIndex + 1 : 0,
            field: sheetName === PRODUCT_WORKBOOK_SHEET_NAME && rowIndex > 0
              ? HEADER_FIELDS[PRODUCT_WORKBOOK_HEADERS[columnIndex]]
              : 'workbook',
            message: `수식이 포함된 셀은 사용할 수 없습니다. (${sheetName}!${XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })})`,
          });
        });
      });
    }
  }
  return errors;
}

function headerIndex(row: unknown[]) {
  const normalizedHeaders = row.map((value) => {
    const header = typeof value === 'string' ? value.trim() : '';
    return LEGACY_PRICE_HEADER_ALIASES[header] ?? header;
  });
  const duplicateHeaders = normalizedHeaders.filter((header, index) => header && normalizedHeaders.indexOf(header) !== index);
  const missingHeaders = PRODUCT_WORKBOOK_HEADERS.filter((header) => !normalizedHeaders.includes(header));
  const unexpectedHeaders = normalizedHeaders.filter((header) => header && !PRODUCT_WORKBOOK_HEADERS.includes(header as (typeof PRODUCT_WORKBOOK_HEADERS)[number]));

  if (duplicateHeaders.length || missingHeaders.length || unexpectedHeaders.length) {
    const messages = [
      duplicateHeaders.length ? `중복 열: ${[...new Set(duplicateHeaders)].join(', ')}` : '',
      missingHeaders.length ? `누락 열: ${missingHeaders.join(', ')}` : '',
      unexpectedHeaders.length ? `허용되지 않은 열: ${[...new Set(unexpectedHeaders)].join(', ')}` : '',
    ].filter(Boolean);
    fatal(`상품 시트의 열 이름이 올바르지 않습니다. ${messages.join(' / ')}`, 'header');
  }

  return Object.fromEntries(PRODUCT_WORKBOOK_HEADERS.map((header) => [header, normalizedHeaders.indexOf(header)])) as Record<(typeof PRODUCT_WORKBOOK_HEADERS)[number], number>;
}

function parseCandidate(
  raw: unknown[],
  rowNumber: number,
  indexes: Record<(typeof PRODUCT_WORKBOOK_HEADERS)[number], number>,
  errors: ProductWorkbookValidationError[],
): CandidateRow | null {
  const value = (header: (typeof PRODUCT_WORKBOOK_HEADERS)[number]) => raw[indexes[header]];
  const initialErrorCount = errors.length;
  const expectedColumnIndexes = new Set(Object.values(indexes));
  const unexpectedColumnIndex = raw.findIndex((cell, index) => !expectedColumnIndexes.has(index) && !isBlank(cell));
  if (unexpectedColumnIndex >= 0) {
    errors.push({
      rowNumber,
      field: 'header',
      message: `${unexpectedColumnIndex + 1}번째 열에 허용되지 않은 값이 있습니다. 제공된 열만 사용해 주세요.`,
    });
  }
  const action = parseAction(value('작업'), rowNumber, errors);
  const skuText = asText(value('상품코드'), rowNumber, 'sku', '상품코드', 30, errors);
  const sku = skuText?.toLocaleUpperCase('en-US') ?? null;
  if (sku && !/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(sku)) {
    errors.push({ rowNumber, field: 'sku', message: '상품코드는 영문 대문자, 숫자, 하이픈으로 2~30자 입력해 주세요.' });
  }
  const name = asText(value('상품명'), rowNumber, 'name', '상품명', 100, errors);
  const category = asText(value('분류'), rowNumber, 'category', '분류', 40, errors);
  const specification = asText(value('규격'), rowNumber, 'specification', '규격', 80, errors);
  const unit = parseUnit(value('재고단위'), rowNumber, errors);
  const prices = Object.fromEntries(PRICE_COLUMNS.map(({ header, field, label }) => [
    field,
    parsePrice(value(header), rowNumber, field, label, errors),
  ])) as Record<ProductPriceField, number | null>;
  const supplierName = asText(value('기본공급업체'), rowNumber, 'supplierName', '기본공급업체', 100, errors);
  const storageType = parseStorageType(value('보관방법'), rowNumber, errors);
  const allergens = optionalText(value('알레르기정보'), rowNumber, 'allergens', '알레르기정보', 120, errors);

  let id: string | undefined;
  let expectedVersion: number | undefined;
  if (action === 'create') {
    if (!isBlank(value('상품ID'))) errors.push({ rowNumber, field: 'id', message: '등록 행의 상품ID는 비워 두세요.' });
    if (!isBlank(value('버전'))) errors.push({ rowNumber, field: 'expectedVersion', message: '등록 행의 버전은 비워 두세요.' });
  } else if (action === 'update') {
    id = asText(value('상품ID'), rowNumber, 'id', '상품ID', 128, errors) ?? undefined;
    expectedVersion = parsePositiveInteger(value('버전'), rowNumber, 'expectedVersion', '버전', errors) ?? undefined;
  }

  if (
    errors.length !== initialErrorCount
    || !action
    || !sku
    || !name
    || !category
    || !specification
    || !unit
    || PRICE_COLUMNS.some(({ field }) => prices[field] === null)
    || !supplierName
    || !storageType
    || allergens === null
  ) return null;

  const product: ProductInput = {
    sku,
    name,
    category,
    specification,
    unit,
    ...(prices as Record<ProductPriceField, number>),
    supplierName,
    storageType,
    allergens,
  };

  return { rowNumber, action, id, expectedVersion, product };
}

function previewText(value: unknown) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value);
}

function previewInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

function previewUnit(value: unknown): ProductUnit {
  return typeof value === 'string' ? UNIT_ALIASES.get(normalizeAlias(value)) ?? 'KG' : 'KG';
}

function previewStorageType(value: unknown): ProductStorageType {
  return typeof value === 'string' ? STORAGE_ALIASES.get(normalizeAlias(value)) ?? 'CHILLED' : 'CHILLED';
}

function previewRow(
  raw: unknown[],
  rowNumber: number,
  indexes: Record<(typeof PRODUCT_WORKBOOK_HEADERS)[number], number>,
): BulkProductRow {
  const value = (header: (typeof PRODUCT_WORKBOOK_HEADERS)[number]) => raw[indexes[header]];
  const action = previewText(value('작업')) === '수정' ? 'update' : 'create';
  const prices = Object.fromEntries(PRICE_COLUMNS.map(({ header, field }) => {
    const rawPrice = value(header);
    return [
      field,
      typeof rawPrice === 'string'
        ? previewInteger(rawPrice.replaceAll(',', ''))
        : previewInteger(rawPrice),
    ];
  })) as Record<ProductPriceField, number>;
  const product: ProductInput = {
    sku: previewText(value('상품코드')).toLocaleUpperCase('en-US'),
    name: previewText(value('상품명')),
    category: previewText(value('분류')),
    specification: previewText(value('규격')),
    unit: previewUnit(value('재고단위')),
    ...prices,
    supplierName: previewText(value('기본공급업체')),
    storageType: previewStorageType(value('보관방법')),
    allergens: previewText(value('알레르기정보')),
  };

  return action === 'create'
    ? { rowNumber, action, product }
    : {
        rowNumber,
        action,
        id: previewText(value('상품ID')),
        expectedVersion: previewInteger(value('버전')),
        product,
      };
}

function validateAgainstProducts(
  candidates: CandidateRow[],
  products: readonly Product[],
  errors: ProductWorkbookValidationError[],
) {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const productsBySku = new Map(products.map((product) => [product.sku.toLocaleUpperCase('en-US'), product]));
  const updateRowsById = new Map<string, CandidateRow[]>();
  const rowsBySku = new Map<string, CandidateRow[]>();
  const errorKeys = new Set(errors.map(validationErrorKey));

  for (const candidate of candidates) {
    const skuRows = rowsBySku.get(candidate.product.sku) ?? [];
    skuRows.push(candidate);
    rowsBySku.set(candidate.product.sku, skuRows);

    if (candidate.action === 'create') {
      if (productsBySku.has(candidate.product.sku)) {
        addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'sku', message: '현재 상품 목록에 이미 사용 중인 상품코드입니다.' });
      }
      continue;
    }

    if (!candidate.id || !candidate.expectedVersion) continue;
    const idRows = updateRowsById.get(candidate.id) ?? [];
    idRows.push(candidate);
    updateRowsById.set(candidate.id, idRows);

    const current = productsById.get(candidate.id);
    if (!current) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'id', message: '현재 상품 목록에서 상품ID를 찾을 수 없습니다.' });
      continue;
    }
    if (current.version !== candidate.expectedVersion) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'expectedVersion', message: `현재 버전(${current.version})과 파일의 버전(${candidate.expectedVersion})이 다릅니다. 새 파일을 다시 내보내 주세요.` });
    }
    const skuOwner = productsBySku.get(candidate.product.sku);
    if (skuOwner && skuOwner.id !== candidate.id) {
      addErrorOnce(errors, errorKeys, { rowNumber: candidate.rowNumber, field: 'sku', message: '다른 상품이 이미 사용 중인 상품코드입니다.' });
    }
  }

  for (const duplicateRows of updateRowsById.values()) {
    if (duplicateRows.length < 2) continue;
    duplicateRows.forEach((row) => addErrorOnce(errors, errorKeys, {
      rowNumber: row.rowNumber,
      field: 'id',
      message: '같은 상품ID가 파일에 두 번 이상 포함되어 있습니다.',
    }));
  }

  for (const duplicateRows of rowsBySku.values()) {
    if (duplicateRows.length < 2) continue;
    duplicateRows.forEach((row) => addErrorOnce(errors, errorKeys, {
      rowNumber: row.rowNumber,
      field: 'sku',
      message: '같은 상품코드가 파일에 두 번 이상 포함되어 있습니다.',
    }));
  }
}

async function sha256Hex(buffer: ArrayBuffer) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fatal('파일 무결성을 확인할 수 없는 브라우저입니다.', 'file');
  const digest = await subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function parseProductWorkbook(
  file: File,
  activeTenant: TenantCode,
  products: readonly Product[],
): Promise<ProductWorkbookParseResult> {
  ensureBrowser();
  if (!(file instanceof File)) fatal('업로드할 XLSX 파일을 선택해 주세요.', 'file');
  if (!/\.xlsx$/i.test(file.name)) fatal('XLSX 확장자의 파일만 업로드할 수 있습니다.', 'file');
  if (file.size === 0) fatal('빈 파일은 업로드할 수 없습니다.', 'file');
  if (file.size > PRODUCT_WORKBOOK_MAX_BYTES) {
    fatal(`파일 크기는 ${PRODUCT_WORKBOOK_MAX_BYTES / (1024 * 1024)}MB 이하여야 합니다.`, 'file');
  }

  const buffer = await file.arrayBuffer();
  const [XLSX, fileSha256] = await Promise.all([loadXlsx(), sha256Hex(buffer)]);
  let workbook: WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      dense: true,
      sheets: [PRODUCT_WORKBOOK_SHEET_NAME, PRODUCT_WORKBOOK_GUIDE_SHEET_NAME],
      sheetRows: PRODUCT_WORKBOOK_MAX_ROWS + 2,
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

  const unexpectedSheets = workbook.SheetNames.filter((name) => name !== PRODUCT_WORKBOOK_SHEET_NAME && name !== PRODUCT_WORKBOOK_GUIDE_SHEET_NAME);
  if (unexpectedSheets.length) {
    fatal(`허용되지 않은 시트가 있습니다: ${unexpectedSheets.join(', ')}`, 'sheet');
  }
  const sheet = workbook.Sheets[PRODUCT_WORKBOOK_SHEET_NAME];
  if (!sheet) fatal(`“${PRODUCT_WORKBOOK_SHEET_NAME}” 시트를 찾을 수 없습니다.`, 'sheet');
  const guideSheet = workbook.Sheets[PRODUCT_WORKBOOK_GUIDE_SHEET_NAME];
  const guideReference = guideSheet && (typeof guideSheet['!fullref'] === 'string' ? guideSheet['!fullref'] : guideSheet['!ref']);
  if (guideReference) {
    const guideRange = XLSX.utils.decode_range(guideReference);
    if (guideRange.e.r > 50 || guideRange.e.c > 1) {
      fatal('안내 시트의 구조가 변경되었습니다. 현재 회사에서 파일을 다시 내보내 주세요.', 'sheet');
    }
  }

  const formulas = formulaErrors(XLSX, workbook);
  if (formulas.length) {
    throw new ProductWorkbookParseError('수식이 포함된 파일은 업로드할 수 없습니다.', formulas);
  }

  readSchemaVersion(XLSX, workbook);
  const tenant = readTenant(XLSX, workbook);
  if (!tenant) {
    fatal('템플릿의 회사 정보를 확인할 수 없습니다. 현재 회사에서 파일을 다시 내보내 주세요.', 'workbook');
  }
  if (tenant !== activeTenant) {
    fatal('다른 회사에서 내보낸 파일은 현재 회사에 적용할 수 없습니다.', 'workbook');
  }
  const fullReference = typeof sheet['!fullref'] === 'string' ? sheet['!fullref'] : sheet['!ref'];
  if (fullReference) {
    const fullRange = XLSX.utils.decode_range(fullReference);
    if (fullRange.e.r > PRODUCT_WORKBOOK_MAX_ROWS) {
      fatal(`상품 데이터는 헤더를 제외하고 ${PRODUCT_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행까지만 입력할 수 있습니다.`, 'sheet');
    }
  }

  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  if (!rawRows.length) fatal('상품 시트에 헤더가 없습니다.', 'header');
  const indexes = headerIndex(rawRows[0]);
  const dataRows = rawRows.slice(1)
    .map((row, index) => ({ raw: row, rowNumber: index + 2 }))
    .filter(({ raw }) => raw.some((value) => !isBlank(value)));

  if (dataRows.length > PRODUCT_WORKBOOK_MAX_ROWS) {
    fatal(`한 파일에는 상품을 ${PRODUCT_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행까지만 업로드할 수 있습니다.`, 'sheet');
  }

  const errors: ProductWorkbookValidationError[] = [];
  const previewRows = dataRows.map(({ raw, rowNumber }) => previewRow(raw, rowNumber, indexes));
  const candidates = dataRows
    .map(({ raw, rowNumber }) => parseCandidate(raw, rowNumber, indexes, errors))
    .filter((candidate): candidate is CandidateRow => candidate !== null);

  if (dataRows.length === 0) fatal('등록하거나 수정할 상품 행을 입력해 주세요.', 'sheet');

  validateAgainstProducts(candidates, products, errors);
  const invalidRows = new Set(errors.map((error) => error.rowNumber));
  const validRows: BulkProductRow[] = candidates
    .filter((candidate) => !invalidRows.has(candidate.rowNumber))
    .map((candidate) => candidate.action === 'create'
      ? { rowNumber: candidate.rowNumber, action: 'create', product: candidate.product }
      : {
          rowNumber: candidate.rowNumber,
          action: 'update',
          id: candidate.id as string,
          expectedVersion: candidate.expectedVersion as number,
          product: candidate.product,
        });

  const source = {
    fileName: safeSourceFileName(file.name),
    fileSha256,
  };
  const previewRowNumbers = new Set(previewRows.map((row) => row.rowNumber));
  const errorsByRow = new Map<number, ProductWorkbookValidationError[]>();
  for (const error of errors) {
    if (!previewRowNumbers.has(error.rowNumber)) continue;
    const rowErrors = errorsByRow.get(error.rowNumber) ?? [];
    rowErrors.push(error);
    errorsByRow.set(error.rowNumber, rowErrors);
  }
  const rows: ProductWorkbookPreviewRow[] = previewRows.map((row) => {
    const rowValidationErrors = (errorsByRow.get(row.rowNumber) ?? [])
      .map(({ field, message }) => ({ field, message }));
    return rowValidationErrors.length ? { ...row, errors: rowValidationErrors } : row;
  });

  return {
    rows,
    request: {
      schemaVersion: PRODUCT_WORKBOOK_SCHEMA_VERSION,
      tenant,
      source,
      rows: validRows,
    },
    source,
    errors: errors
      .filter((error) => !previewRowNumbers.has(error.rowNumber))
      .sort((left, right) => left.rowNumber - right.rowNumber),
    totalRows: dataRows.length,
    createRows: previewRows.filter((row) => row.action === 'create').length,
    updateRows: previewRows.filter((row) => row.action === 'update').length,
  };
}
