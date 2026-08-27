import type {
  BulkProductPriceRequest,
  BulkProductPriceRow,
  BulkProductPriceRowResult,
  BulkProductRequest,
  BulkProductRow,
  BulkProductRowError,
  BulkProductRowResult,
  ProductInput,
  ProductMutation,
  ProductPriceMutation,
  ProductPriceValues,
  ProductStatus,
  ProductStorageType,
  ProductUnit,
} from './erp-types';
import { isPriceMonth } from './price-month';
import { normalizeTenantCode } from './tenant-code';

type ParseResult =
  | { ok: true; value: ProductMutation }
  | { ok: false; message: string };

export type BulkProductParseResult =
  | { ok: true; value: BulkProductRequest }
  | { ok: false; message: string; rows: BulkProductRowResult[]; total: number; failed: number };

type ProductPriceParseResult =
  | { ok: true; value: ProductPriceMutation }
  | { ok: false; message: string };

export type BulkProductPriceParseResult =
  | { ok: true; value: BulkProductPriceRequest }
  | { ok: false; message: string; rows: BulkProductPriceRowResult[]; total: number; failed: number };

const units = new Set<ProductUnit>(['KG', 'G', 'EA', 'BOX', 'PACK', 'L', 'BAG']);
const storageTypes = new Set<ProductStorageType>(['AMBIENT', 'CHILLED', 'FROZEN']);
const statuses = new Set<ProductStatus>(['ACTIVE', 'INACTIVE']);
const productPriceFields = [
  ['schoolPriceKg', '학교가 kg단가'],
  ['schoolPriceSpec', '학교가 규격단가'],
  ['schoolPriceEach', '학교가 개당단가'],
  ['vendorPriceKg', '업체가 kg단가'],
  ['vendorPriceSpec', '업체가 규격단가'],
  ['vendorPriceEach', '업체가 개당단가'],
  ['purchasePriceKg', '매입가 kg단가'],
  ['purchasePriceSpec', '매입가 규격단가'],
  ['purchasePriceEach', '매입가 개당단가'],
] as const;

function isValidPrice(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 100_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function parseProductPriceValues(value: unknown): { value?: ProductPriceValues; errors: BulkProductRowError[] } {
  if (!isRecord(value)) {
    return { errors: [{ field: 'prices', code: 'INVALID_VALUE', message: '월별 단가를 입력해 주세요.' }] };
  }
  const errors: BulkProductRowError[] = [];
  for (const [field, label] of productPriceFields) {
    if (!isValidPrice(value[field])) {
      errors.push({ field, code: 'INVALID_VALUE', message: `${label}는 0~100,000,000원의 정수로 입력해 주세요.` });
    }
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    value: {
      schoolPriceKg: value.schoolPriceKg as number,
      schoolPriceSpec: value.schoolPriceSpec as number,
      schoolPriceEach: value.schoolPriceEach as number,
      vendorPriceKg: value.vendorPriceKg as number,
      vendorPriceSpec: value.vendorPriceSpec as number,
      vendorPriceEach: value.vendorPriceEach as number,
      purchasePriceKg: value.purchasePriceKg as number,
      purchasePriceSpec: value.purchasePriceSpec as number,
      purchasePriceEach: value.purchasePriceEach as number,
    },
  };
}

function parseProductInput(value: unknown): { ok: true; value: ProductInput } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: '상품 정보를 입력해 주세요.' };

  const sku = requiredText(value.sku, 30)?.toUpperCase();
  if (!sku || !/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(sku)) {
    return { ok: false, message: '상품 코드는 영문 대문자, 숫자, 하이픈으로 2~30자 입력해 주세요.' };
  }

  const name = requiredText(value.name, 100);
  const category = requiredText(value.category, 40);
  const specification = requiredText(value.specification, 80);
  const supplierName = requiredText(value.supplierName, 100);
  if (!name || !category || !specification || !supplierName) {
    return { ok: false, message: '상품명, 분류, 규격, 기본 공급업체를 모두 입력해 주세요.' };
  }

  if (typeof value.unit !== 'string' || !units.has(value.unit as ProductUnit)) {
    return { ok: false, message: '올바른 발주 단위를 선택해 주세요.' };
  }
  if (typeof value.storageType !== 'string' || !storageTypes.has(value.storageType as ProductStorageType)) {
    return { ok: false, message: '올바른 보관 방법을 선택해 주세요.' };
  }
  for (const [field, label] of productPriceFields) {
    if (!isValidPrice(value[field])) {
      return { ok: false, message: `${label}는 0~100,000,000원의 정수로 입력해 주세요.` };
    }
  }

  const allergens = typeof value.allergens === 'string' ? value.allergens.trim() : '';
  if (allergens.length > 120) {
    return { ok: false, message: '알레르기 정보는 120자 이하로 입력해 주세요.' };
  }

  return {
    ok: true,
    value: {
      sku,
      name,
      category,
      specification,
      unit: value.unit as ProductUnit,
      schoolPriceKg: value.schoolPriceKg as number,
      schoolPriceSpec: value.schoolPriceSpec as number,
      schoolPriceEach: value.schoolPriceEach as number,
      vendorPriceKg: value.vendorPriceKg as number,
      vendorPriceSpec: value.vendorPriceSpec as number,
      vendorPriceEach: value.vendorPriceEach as number,
      purchasePriceKg: value.purchasePriceKg as number,
      purchasePriceSpec: value.purchasePriceSpec as number,
      purchasePriceEach: value.purchasePriceEach as number,
      supplierName,
      storageType: value.storageType as ProductStorageType,
      allergens,
    },
  };
}

function productInputErrors(value: unknown): { value?: ProductInput; errors: BulkProductRowError[] } {
  if (!isRecord(value)) {
    return { errors: [{ field: 'product', code: 'INVALID_VALUE', message: '상품 정보를 입력해 주세요.' }] };
  }

  const errors: BulkProductRowError[] = [];
  const sku = requiredText(value.sku, 30)?.toUpperCase();
  if (!sku || !/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(sku)) {
    errors.push({ field: 'sku', code: 'INVALID_VALUE', message: '상품 코드는 영문 대문자, 숫자, 하이픈으로 2~30자 입력해 주세요.' });
  }

  const name = requiredText(value.name, 100);
  const category = requiredText(value.category, 40);
  const specification = requiredText(value.specification, 80);
  const supplierName = requiredText(value.supplierName, 100);
  if (!name) errors.push({ field: 'name', code: 'INVALID_VALUE', message: '상품명을 1~100자로 입력해 주세요.' });
  if (!category) errors.push({ field: 'category', code: 'INVALID_VALUE', message: '분류를 1~40자로 입력해 주세요.' });
  if (!specification) errors.push({ field: 'specification', code: 'INVALID_VALUE', message: '규격을 1~80자로 입력해 주세요.' });
  if (!supplierName) errors.push({ field: 'supplierName', code: 'INVALID_VALUE', message: '기본 공급업체를 1~100자로 입력해 주세요.' });

  const unit = typeof value.unit === 'string' && units.has(value.unit as ProductUnit)
    ? value.unit as ProductUnit
    : null;
  if (!unit) errors.push({ field: 'unit', code: 'INVALID_VALUE', message: '올바른 발주 단위를 선택해 주세요.' });

  const storageType = typeof value.storageType === 'string' && storageTypes.has(value.storageType as ProductStorageType)
    ? value.storageType as ProductStorageType
    : null;
  if (!storageType) errors.push({ field: 'storageType', code: 'INVALID_VALUE', message: '올바른 보관 방법을 선택해 주세요.' });

  for (const [field, label] of productPriceFields) {
    if (!isValidPrice(value[field])) {
      errors.push({ field, code: 'INVALID_VALUE', message: `${label}는 0~100,000,000원의 정수로 입력해 주세요.` });
    }
  }

  const allergens = typeof value.allergens === 'string' ? value.allergens.trim() : null;
  if (allergens === null) {
    errors.push({ field: 'allergens', code: 'INVALID_VALUE', message: '알레르기 정보는 텍스트로 입력해 주세요.' });
  } else if (allergens.length > 120) {
    errors.push({ field: 'allergens', code: 'INVALID_VALUE', message: '알레르기 정보는 120자 이하로 입력해 주세요.' });
  }

  if (errors.length > 0 || !sku || !name || !category || !specification || !supplierName || !unit || !storageType || allergens === null) {
    return { errors };
  }
  return {
    errors,
    value: {
      sku,
      name,
      category,
      specification,
      unit,
      schoolPriceKg: value.schoolPriceKg as number,
      schoolPriceSpec: value.schoolPriceSpec as number,
      schoolPriceEach: value.schoolPriceEach as number,
      vendorPriceKg: value.vendorPriceKg as number,
      vendorPriceSpec: value.vendorPriceSpec as number,
      vendorPriceEach: value.vendorPriceEach as number,
      purchasePriceKg: value.purchasePriceKg as number,
      purchasePriceSpec: value.purchasePriceSpec as number,
      purchasePriceEach: value.purchasePriceEach as number,
      supplierName,
      storageType,
      allergens,
    },
  };
}

function validationFailureRows(
  rows: Array<{ rowNumber: number; action: 'create' | 'update'; errors: BulkProductRowError[] }>,
) {
  const failed = rows.filter((row) => row.errors.length > 0);
  return {
    failed: failed.length,
    rows: failed.slice(0, 200).map<BulkProductRowResult>((row) => ({
      rowNumber: row.rowNumber,
      action: row.action,
      status: 'error',
      errors: row.errors,
    })),
  };
}

export function parseBulkProductRequest(value: unknown): BulkProductParseResult {
  const inputTotal = isRecord(value) && Array.isArray(value.rows) ? value.rows.length : 0;
  if (isRecord(value) && value.schemaVersion === 1) {
    return { ok: false, message: '이전 버전의 상품 엑셀 양식입니다. 최신 양식을 다시 다운로드해 주세요.', rows: [], total: inputTotal, failed: 0 };
  }
  if (!isRecord(value) || value.schemaVersion !== 2) {
    return { ok: false, message: '상품 일괄 요청 형식이 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  const tenant = normalizeTenantCode(value.tenant);
  if (!tenant) {
    return { ok: false, message: '상품 일괄 요청의 회사 코드가 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  if (!isRecord(value.source)) {
    return { ok: false, message: '원본 파일 정보가 필요합니다.', rows: [], total: inputTotal, failed: 0 };
  }
  const fileName = requiredText(value.source.fileName, 255);
  const fileSha256 = typeof value.source.fileSha256 === 'string' ? value.source.fileSha256.trim().toLowerCase() : '';
  if (!fileName || !/^[a-f0-9]{64}$/.test(fileSha256)) {
    return { ok: false, message: '파일 이름과 SHA-256 해시가 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 10_000) {
    return { ok: false, message: '일괄 처리 행은 1~10,000개여야 합니다.', rows: [], total: inputTotal, failed: 0 };
  }

  const candidates: Array<{
    rowNumber: number;
    action: 'create' | 'update';
    normalizedSku?: string;
    updateId?: string;
    row?: BulkProductRow;
    errors: BulkProductRowError[];
  }> = value.rows.map((raw, index) => {
    const record = isRecord(raw) ? raw : {};
    const rowNumber = typeof record.rowNumber === 'number' && Number.isInteger(record.rowNumber)
      && record.rowNumber >= 1 && record.rowNumber <= 1_048_576
      ? record.rowNumber
      : index + 2;
    const action = record.action === 'update' ? 'update' : 'create';
    const errors: BulkProductRowError[] = [];
    if (!isRecord(raw)) errors.push({ code: 'INVALID_VALUE', message: '행 데이터 형식이 올바르지 않습니다.' });
    if (record.rowNumber !== rowNumber) errors.push({ field: 'rowNumber', code: 'INVALID_VALUE', message: '엑셀 행 번호가 올바르지 않습니다.' });
    if (record.action !== 'create' && record.action !== 'update') {
      errors.push({ field: 'action', code: 'INVALID_VALUE', message: '작업은 create 또는 update여야 합니다.' });
    }
    const product = productInputErrors(record.product);
    errors.push(...product.errors);
    const normalizedSku = isRecord(record.product)
      ? requiredText(record.product.sku, 30)?.toUpperCase()
      : undefined;

    if (action === 'update') {
      const id = requiredText(record.id, 128);
      const expectedVersion = record.expectedVersion;
      if (!id) errors.push({ field: 'id', code: 'INVALID_VALUE', message: '수정할 상품 ID가 필요합니다.' });
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
        errors.push({ field: 'expectedVersion', code: 'INVALID_VALUE', message: '상품 버전 정보가 올바르지 않습니다.' });
      }
      return {
        rowNumber,
        action,
        normalizedSku,
        updateId: id ?? undefined,
        errors,
        row: errors.length === 0 && product.value && id && typeof expectedVersion === 'number'
          ? { rowNumber, action, id, expectedVersion, product: product.value }
          : undefined,
      };
    }
    return {
      rowNumber,
      action,
      normalizedSku,
      errors,
      row: errors.length === 0 && product.value ? { rowNumber, action, product: product.value } : undefined,
    };
  });

  const addDuplicateError = (
    groups: Map<string, number[]>,
    code: BulkProductRowError['code'],
    field: string,
    message: string,
  ) => {
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) candidates[index]?.errors.push({ field, code, message });
    }
  };
  const groupBy = (keyFor: (candidate: typeof candidates[number]) => string | undefined) => {
    const groups = new Map<string, number[]>();
    candidates.forEach((candidate, index) => {
      const key = keyFor(candidate);
      if (!key) return;
      const indexes = groups.get(key);
      if (indexes) indexes.push(index);
      else groups.set(key, [index]);
    });
    return groups;
  };
  addDuplicateError(groupBy((row) => String(row.rowNumber)), 'DUPLICATE_ROW_NUMBER', 'rowNumber', '파일 안에서 행 번호가 중복되었습니다.');
  addDuplicateError(groupBy((row) => row.normalizedSku), 'DUPLICATE_SKU_IN_FILE', 'sku', '파일 안에서 상품 코드가 중복되었습니다.');
  addDuplicateError(
    groupBy((row) => row.action === 'update' ? row.updateId : undefined),
    'DUPLICATE_PRODUCT_ID_IN_FILE',
    'id',
    '같은 상품을 파일에서 두 번 이상 수정할 수 없습니다.',
  );

  if (candidates.some((candidate) => candidate.errors.length > 0)) {
    const failure = validationFailureRows(candidates);
    return {
      ok: false,
      message: failure.failed > 200
        ? '일괄 요청의 행 오류를 확인해 주세요. 한 행도 적용되지 않았습니다. 오류 상세는 처음 200행만 표시합니다.'
        : '일괄 요청의 행 오류를 확인해 주세요. 한 행도 적용되지 않았습니다.',
      rows: failure.rows,
      total: candidates.length,
      failed: failure.failed,
    };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      tenant,
      source: { fileName, fileSha256 },
      rows: candidates.map((candidate) => candidate.row as BulkProductRow),
    },
  };
}

export function parseProductMutation(value: unknown): ParseResult {
  if (!isRecord(value) || value.module !== 'products') {
    return { ok: false, message: '상품 관리 요청 형식이 올바르지 않습니다.' };
  }
  const tenant = normalizeTenantCode(value.tenant);
  if (!tenant) return { ok: false, message: '상품 관리 요청의 회사 코드가 올바르지 않습니다.' };

  if (value.action === 'create') {
    const product = parseProductInput(value.product);
    return product.ok
      ? { ok: true, value: { tenant, module: 'products', action: 'create', product: product.value } }
      : product;
  }

  const id = requiredText(value.id, 128);
  if (!id) return { ok: false, message: '처리할 상품을 찾을 수 없습니다.' };
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, message: '상품 버전 정보가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.' };
  }

  if (value.action === 'update') {
    const product = parseProductInput(value.product);
    return product.ok
      ? { ok: true, value: { tenant, module: 'products', action: 'update', id, expectedVersion, product: product.value } }
      : product;
  }

  if (value.action === 'set-status' && typeof value.status === 'string' && statuses.has(value.status as ProductStatus)) {
    return {
      ok: true,
      value: { tenant, module: 'products', action: 'set-status', id, expectedVersion, status: value.status as ProductStatus },
    };
  }

  return { ok: false, message: '허용되지 않은 상품 관리 작업입니다.' };
}

export function parseProductPriceMutation(value: unknown): ProductPriceParseResult {
  if (
    !isRecord(value)
    || value.module !== 'product-prices'
    || value.action !== 'upsert'
  ) {
    return { ok: false, message: '월별 상품 단가 요청 형식이 올바르지 않습니다.' };
  }
  const tenant = normalizeTenantCode(value.tenant);
  if (!tenant) return { ok: false, message: '월별 상품 단가 요청의 회사 코드가 올바르지 않습니다.' };
  if (!isPriceMonth(value.priceMonth)) {
    return { ok: false, message: '단가 적용월은 YYYY-MM 형식이어야 합니다.' };
  }
  const productId = requiredText(value.productId, 128);
  if (!productId) return { ok: false, message: '단가를 저장할 상품 ID가 필요합니다.' };
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return { ok: false, message: '월별 단가 버전 정보가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.' };
  }
  const expectedSourceMonth = value.expectedSourceMonth;
  const expectedSourceVersion = value.expectedSourceVersion;
  if (
    (expectedSourceMonth !== null && !isPriceMonth(expectedSourceMonth))
    || typeof expectedSourceVersion !== 'number'
    || !Number.isInteger(expectedSourceVersion)
    || expectedSourceVersion < 1
    || (expectedVersion === 0 && expectedSourceMonth !== null && expectedSourceMonth >= value.priceMonth)
    || (expectedVersion > 0 && (
      expectedSourceMonth !== value.priceMonth
      || expectedSourceVersion !== expectedVersion
    ))
  ) {
    return { ok: false, message: '월별 단가 원본 버전 정보가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.' };
  }
  const prices = parseProductPriceValues(value.prices);
  if (!prices.value) return { ok: false, message: prices.errors[0]?.message ?? '월별 단가를 확인해 주세요.' };
  return {
    ok: true,
    value: {
      tenant,
      module: 'product-prices',
      action: 'upsert',
      productId,
      priceMonth: value.priceMonth,
      expectedVersion,
      expectedSourceMonth,
      expectedSourceVersion,
      prices: prices.value,
    },
  };
}

export function parseBulkProductPriceRequest(value: unknown): BulkProductPriceParseResult {
  const inputTotal = isRecord(value) && Array.isArray(value.rows) ? value.rows.length : 0;
  if (
    !isRecord(value)
    || value.schemaVersion !== 2
    || !isPriceMonth(value.priceMonth)
  ) {
    return { ok: false, message: '월별 상품 단가 일괄 요청 형식이 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  const tenant = normalizeTenantCode(value.tenant);
  if (!tenant) {
    return { ok: false, message: '월별 상품 단가 일괄 요청의 회사 코드가 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  const priceMonth = value.priceMonth;
  if (!isRecord(value.source)) {
    return { ok: false, message: '원본 파일 정보가 필요합니다.', rows: [], total: inputTotal, failed: 0 };
  }
  const fileName = requiredText(value.source.fileName, 255);
  const fileSha256 = typeof value.source.fileSha256 === 'string' ? value.source.fileSha256.trim().toLowerCase() : '';
  if (!fileName || !/^[a-f0-9]{64}$/.test(fileSha256)) {
    return { ok: false, message: '파일 이름과 SHA-256 해시가 올바르지 않습니다.', rows: [], total: inputTotal, failed: 0 };
  }
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 10_000) {
    return { ok: false, message: '월별 단가 일괄 처리 행은 1~10,000개여야 합니다.', rows: [], total: inputTotal, failed: 0 };
  }

  const candidates: Array<{ rowNumber: number; productId?: string; row?: BulkProductPriceRow; errors: BulkProductRowError[] }> =
    value.rows.map((raw, index) => {
      const record = isRecord(raw) ? raw : {};
      const rowNumber = typeof record.rowNumber === 'number' && Number.isInteger(record.rowNumber)
        && record.rowNumber >= 1 && record.rowNumber <= 1_048_576
        ? record.rowNumber
        : index + 2;
      const productId = requiredText(record.productId, 128) ?? undefined;
      const expectedVersion = record.expectedVersion;
      const expectedSourceMonth = record.expectedSourceMonth;
      const expectedSourceVersion = record.expectedSourceVersion;
      const prices = parseProductPriceValues(record.prices);
      const errors = [...prices.errors];
      if (!isRecord(raw)) errors.push({ code: 'INVALID_VALUE', message: '행 데이터 형식이 올바르지 않습니다.' });
      if (record.rowNumber !== rowNumber) {
        errors.push({ field: 'rowNumber', code: 'INVALID_VALUE', message: '엑셀 행 번호가 올바르지 않습니다.' });
      }
      if (!productId) errors.push({ field: 'productId', code: 'INVALID_VALUE', message: '상품 ID가 필요합니다.' });
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
        errors.push({ field: 'expectedVersion', code: 'INVALID_VALUE', message: '월별 단가 버전 정보가 올바르지 않습니다.' });
      }
      if (
        (expectedSourceMonth !== null && !isPriceMonth(expectedSourceMonth))
        || typeof expectedSourceVersion !== 'number'
        || !Number.isInteger(expectedSourceVersion)
        || expectedSourceVersion < 1
        || (typeof expectedVersion === 'number' && expectedVersion === 0
          && expectedSourceMonth !== null && isPriceMonth(expectedSourceMonth)
          && expectedSourceMonth >= priceMonth)
        || (typeof expectedVersion === 'number' && expectedVersion > 0 && (
          expectedSourceMonth !== priceMonth
          || expectedSourceVersion !== expectedVersion
        ))
      ) {
        errors.push({ field: 'expectedSourceVersion', code: 'INVALID_VALUE', message: '월별 단가 원본 버전 정보가 올바르지 않습니다.' });
      }
      return {
        rowNumber,
        productId,
        errors,
        row: errors.length === 0 && productId && prices.value
          && typeof expectedVersion === 'number' && typeof expectedSourceVersion === 'number'
          ? {
              rowNumber,
              productId,
              expectedVersion,
              expectedSourceMonth: expectedSourceMonth as BulkProductPriceRow['expectedSourceMonth'],
              expectedSourceVersion,
              prices: prices.value,
            }
          : undefined,
      };
    });

  const duplicateIndexes = (keyFor: (candidate: typeof candidates[number]) => string | undefined) => {
    const groups = new Map<string, number[]>();
    candidates.forEach((candidate, index) => {
      const key = keyFor(candidate);
      if (!key) return;
      const indexes = groups.get(key);
      if (indexes) indexes.push(index);
      else groups.set(key, [index]);
    });
    return [...groups.values()].filter((indexes) => indexes.length > 1).flat();
  };
  for (const index of duplicateIndexes((candidate) => String(candidate.rowNumber))) {
    candidates[index]?.errors.push({ field: 'rowNumber', code: 'DUPLICATE_ROW_NUMBER', message: '파일 안에서 행 번호가 중복되었습니다.' });
  }
  for (const index of duplicateIndexes((candidate) => candidate.productId)) {
    candidates[index]?.errors.push({ field: 'productId', code: 'DUPLICATE_PRODUCT_ID_IN_FILE', message: '같은 상품의 월별 단가를 파일에서 두 번 이상 수정할 수 없습니다.' });
  }

  const failed = candidates.filter((candidate) => candidate.errors.length > 0);
  if (failed.length > 0) {
    const rows = failed.slice(0, 200).map<BulkProductPriceRowResult>((candidate) => ({
      rowNumber: candidate.rowNumber,
      status: 'error',
      errors: candidate.errors,
    }));
    return {
      ok: false,
      message: failed.length > 200
        ? '월별 단가 일괄 요청의 행 오류를 확인해 주세요. 한 행도 적용되지 않았습니다. 오류 상세는 처음 200행만 표시합니다.'
        : '월별 단가 일괄 요청의 행 오류를 확인해 주세요. 한 행도 적용되지 않았습니다.',
      rows,
      total: candidates.length,
      failed: failed.length,
    };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      tenant,
      priceMonth,
      source: { fileName, fileSha256 },
      rows: candidates.map((candidate) => candidate.row as BulkProductPriceRow),
    },
  };
}
