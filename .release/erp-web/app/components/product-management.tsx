'use client';

import {
  CalendarDays,
  CircleDollarSign,
  PackageOpen,
  FileSpreadsheet,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Search,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  BulkProductPriceMutationResult,
  BulkProductPriceRequest,
  BulkProductMutationResult as BulkProductResponse,
  BulkProductRequest,
  Product,
  ProductInput,
  ProductMutation,
  ProductMutationResult,
  ProductPriceMutation,
  ProductPriceMutationResult,
  ProductPriceSnapshot,
  ProductPriceValues,
  ProductSearchItem,
  ProductSearchMode,
  ProductSearchReason,
  ProductSearchResponse,
  PriceMonth,
  TenantCode,
} from '../lib/erp-types';
import { currentPriceMonth, formatPriceMonth, isPriceMonth } from '../lib/price-month';
import { AccessibleModal } from './accessible-modal';
import { ProductResultsSkeleton, SkeletonBlock } from './loading-skeletons';
import { ProductImportModal } from './product-import-modal';
import { ProductPriceImportModal } from './product-price-import-modal';

interface ProductManagementProps {
  tenant: TenantCode;
  readOnly: boolean;
  products: Product[];
  priceMonth: PriceMonth;
  productPrices: ProductPriceSnapshot[];
  priceLoading: boolean;
  priceLoadError: string | null;
  onMutate: (mutation: ProductMutation) => Promise<ProductMutationResult>;
  onBulkMutate: (request: BulkProductRequest, idempotencyKey: string) => Promise<BulkProductResponse>;
  onPriceMonthChange: (priceMonth: PriceMonth) => Promise<void>;
  onPriceMutate: (mutation: ProductPriceMutation) => Promise<ProductPriceMutationResult>;
  onPriceBulkMutate: (request: BulkProductPriceRequest, idempotencyKey: string) => Promise<BulkProductPriceMutationResult>;
  onNotice: (notice: { title: string; message: string; tone: 'success' | 'error' | 'info' }) => void;
}

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
type ProductFormValues = Omit<ProductInput, ProductPriceField> & Record<ProductPriceField, string>;
type ProductFormField = keyof ProductFormValues;
type ProductFormErrors = Partial<Record<ProductFormField, string>>;
type ProductPriceFormValues = Record<ProductPriceField, string>;
type ProductPriceFormErrors = Partial<Record<ProductPriceField, string>>;

const priceGroups = [
  {
    id: 'school',
    label: '학교가',
    description: '학교 공급 기준',
    className: 'border-[var(--ss-info-border)] bg-[var(--ss-info-soft)]',
    headingClassName: 'text-[var(--ss-info-strong)]',
    fields: [
      { field: 'schoolPriceKg', label: 'kg단가' },
      { field: 'schoolPriceSpec', label: '규격단가' },
      { field: 'schoolPriceEach', label: '개당단가' },
    ],
  },
  {
    id: 'vendor',
    label: '업체가',
    description: '업체 공급 기준',
    className: 'border-[var(--ss-success-border)] bg-[var(--ss-success-soft)]',
    headingClassName: 'text-[var(--ss-success-strong)]',
    fields: [
      { field: 'vendorPriceKg', label: 'kg단가' },
      { field: 'vendorPriceSpec', label: '규격단가' },
      { field: 'vendorPriceEach', label: '개당단가' },
    ],
  },
  {
    id: 'purchase',
    label: '매입가',
    description: '매입 원가 기준',
    className: 'border-[var(--ss-warning-border)] bg-[var(--ss-warning-soft)]',
    headingClassName: 'text-[var(--ss-warning-strong)]',
    fields: [
      { field: 'purchasePriceKg', label: 'kg단가' },
      { field: 'purchasePriceSpec', label: '규격단가' },
      { field: 'purchasePriceEach', label: '개당단가' },
    ],
  },
] as const;

const priceFields = priceGroups.flatMap((group) => group.fields.map(({ field }) => field));
const priceFieldSet = new Set<ProductFormField>(priceFields);
const priceFieldLabels = Object.fromEntries(priceGroups.flatMap((group) => group.fields.map(({ field, label }) => [field, `${group.label} ${label}`]))) as Record<ProductPriceField, string>;

const units: Array<{ value: ProductInput['unit']; label: string }> = [
  { value: 'KG', label: 'kg' },
  { value: 'G', label: 'g' },
  { value: 'EA', label: '개' },
  { value: 'BOX', label: '박스' },
  { value: 'PACK', label: '팩' },
  { value: 'L', label: 'L' },
  { value: 'BAG', label: '봉' },
];

const storageTypes: Array<{ value: ProductInput['storageType']; label: string }> = [
  { value: 'AMBIENT', label: '상온' },
  { value: 'CHILLED', label: '냉장' },
  { value: 'FROZEN', label: '냉동' },
];

const emptyForm: ProductFormValues = {
  sku: '',
  name: '',
  category: '',
  specification: '',
  unit: 'KG',
  schoolPriceKg: '',
  schoolPriceSpec: '',
  schoolPriceEach: '',
  vendorPriceKg: '',
  vendorPriceSpec: '',
  vendorPriceEach: '',
  purchasePriceKg: '',
  purchasePriceSpec: '',
  purchasePriceEach: '',
  supplierName: '',
  storageType: 'CHILLED',
  allergens: '',
};

const fieldOrder: ProductFormField[] = [
  'sku',
  'name',
  'category',
  'specification',
  'unit',
  ...priceFields,
  'supplierName',
  'storageType',
  'allergens',
];

const inputClassName = 'star-control w-full px-3 text-sm transition placeholder:text-[var(--ss-text-muted)] disabled:cursor-not-allowed disabled:bg-[var(--ss-surface-subtle)] disabled:opacity-70';
const fieldLabelClassName = 'mb-1.5 block text-sm font-semibold text-[var(--ss-text)]';
const numberFormatter = new Intl.NumberFormat('ko-KR');
const dateFormatter = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });
const productsPerPage = 50;
const productSearchModes: Array<{ value: ProductSearchMode; label: string; description: string }> = [
  { value: 'SMART', label: '통합 검색', description: '정확 일치·오타 보정·유사 결과를 한 번에 검색합니다.' },
];
const productSearchReasons = new Set<ProductSearchReason>([
  'EXACT_SKU',
  'EXACT_NAME',
  'CONTAINS',
  'NAME_TRIGRAM',
  'VECTOR_SIMILAR',
]);
const productUnits = new Set<Product['unit']>(['KG', 'G', 'EA', 'BOX', 'PACK', 'L', 'BAG']);
const productStorageTypes = new Set<Product['storageType']>(['AMBIENT', 'CHILLED', 'FROZEN']);
const productStatuses = new Set<Product['status']>(['ACTIVE', 'INACTIVE']);
const productSearchReasonLabels: Record<ProductSearchReason, string> = {
  EXACT_SKU: '상품코드 정확히 일치',
  EXACT_NAME: '상품명 정확히 일치',
  CONTAINS: '상품 정보에 검색어 포함',
  NAME_TRIGRAM: '상품명이 유사함',
  VECTOR_SIMILAR: '표기 벡터가 유사함',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSearchProduct(value: unknown): value is Product {
  if (!isRecord(value)) return false;
  const stringFields = ['id', 'sku', 'name', 'category', 'specification', 'supplierName', 'allergens', 'updatedAt'];
  const priceFieldsToCheck = [
    'schoolPriceKg', 'schoolPriceSpec', 'schoolPriceEach',
    'vendorPriceKg', 'vendorPriceSpec', 'vendorPriceEach',
    'purchasePriceKg', 'purchasePriceSpec', 'purchasePriceEach',
  ];
  return stringFields.every((field) => typeof value[field] === 'string')
    && priceFieldsToCheck.every((field) => Number.isInteger(value[field]) && Number(value[field]) >= 0)
    && typeof value.unit === 'string'
    && productUnits.has(value.unit as Product['unit'])
    && typeof value.storageType === 'string'
    && productStorageTypes.has(value.storageType as Product['storageType'])
    && typeof value.status === 'string'
    && productStatuses.has(value.status as Product['status'])
    && Number.isInteger(value.version)
    && Number(value.version) >= 1;
}

function parseProductSearchResponse(value: unknown, tenant: TenantCode): ProductSearchResponse {
  if (
    !isRecord(value)
    || value.tenant !== tenant
    || typeof value.query !== 'string'
    || !['SMART', 'TRIGRAM', 'VECTOR'].includes(String(value.mode))
    || !['SMART', 'TRIGRAM', 'VECTOR'].includes(String(value.executionMode))
    || !['USED', 'NOT_REQUESTED', 'UNAVAILABLE'].includes(String(value.vectorStatus))
    || !Number.isInteger(value.total)
    || (value.total as number) < 0
    || !Number.isInteger(value.page)
    || (value.page as number) < 1
    || value.pageSize !== productsPerPage
    || typeof value.model !== 'string'
    || !Array.isArray(value.items)
  ) throw new Error('상품 검색 응답 형식이 올바르지 않습니다.');

  const items = value.items.map((item): ProductSearchItem => {
    if (
      !isRecord(item)
      || typeof item.productId !== 'string'
      || !isSearchProduct(item.product)
      || item.product.id !== item.productId
      || typeof item.score !== 'number'
      || !Number.isFinite(item.score)
      || item.score < 0
      || item.score > 1
      || typeof item.trigramScore !== 'number'
      || !Number.isFinite(item.trigramScore)
      || typeof item.vectorScore !== 'number'
      || !Number.isFinite(item.vectorScore)
      || !productSearchReasons.has(item.reason as ProductSearchReason)
    ) throw new Error('상품 검색 결과에 올바르지 않은 값이 있습니다.');
    return item as unknown as ProductSearchItem;
  });
  return { ...value, items } as unknown as ProductSearchResponse;
}

function snapshotForProduct(
  product: Product,
  priceMonth: PriceMonth,
  snapshots: ReadonlyMap<string, ProductPriceSnapshot>,
): ProductPriceSnapshot {
  return snapshots.get(product.id) ?? {
    productId: product.id,
    schoolPriceKg: product.schoolPriceKg,
    schoolPriceSpec: product.schoolPriceSpec,
    schoolPriceEach: product.schoolPriceEach,
    vendorPriceKg: product.vendorPriceKg,
    vendorPriceSpec: product.vendorPriceSpec,
    vendorPriceEach: product.vendorPriceEach,
    purchasePriceKg: product.purchasePriceKg,
    purchasePriceSpec: product.purchasePriceSpec,
    purchasePriceEach: product.purchasePriceEach,
    priceMonth,
    priceSourceMonth: null,
    priceSourceVersion: product.version,
    priceInherited: true,
    priceVersion: 0,
    updatedAt: product.updatedAt,
  };
}

function productWithMonthlyPrice(product: Product, price: ProductPriceSnapshot): Product {
  return {
    ...product,
    schoolPriceKg: price.schoolPriceKg,
    schoolPriceSpec: price.schoolPriceSpec,
    schoolPriceEach: price.schoolPriceEach,
    vendorPriceKg: price.vendorPriceKg,
    vendorPriceSpec: price.vendorPriceSpec,
    vendorPriceEach: price.vendorPriceEach,
    purchasePriceKg: price.purchasePriceKg,
    purchasePriceSpec: price.purchasePriceSpec,
    purchasePriceEach: price.purchasePriceEach,
  };
}

function storageLabel(storageType: Product['storageType']) {
  return storageTypes.find((item) => item.value === storageType)?.label ?? storageType;
}

function unitLabel(unit: Product['unit']) {
  return units.find((item) => item.value === unit)?.label ?? unit;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function ProductPriceGroupValues({
  product,
  group,
  showHeading = true,
}: {
  product: Product;
  group: (typeof priceGroups)[number];
  showHeading?: boolean;
}) {
  return (
    <div className={`min-w-[150px] rounded-[var(--ss-radius-md)] border px-3 py-2.5 ${group.className}`}>
      {showHeading ? <p className={`text-xs font-bold ${group.headingClassName}`}>{group.label}</p> : null}
      <dl className={showHeading ? 'mt-1.5 space-y-1' : 'space-y-1'}>
        {group.fields.map(({ field, label }) => (
          <div key={field} className="flex items-baseline justify-between gap-3 text-xs">
            <dt className="font-medium text-[var(--ss-text-subtle)]">{label}</dt>
            <dd className="whitespace-nowrap font-bold tabular-nums text-[var(--ss-text)]">{numberFormatter.format(product[field])}원</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formValuesFromProduct(product?: Product): ProductFormValues {
  if (!product) return { ...emptyForm };
  return {
    sku: product.sku,
    name: product.name,
    category: product.category,
    specification: product.specification,
    unit: product.unit,
    schoolPriceKg: String(product.schoolPriceKg),
    schoolPriceSpec: String(product.schoolPriceSpec),
    schoolPriceEach: String(product.schoolPriceEach),
    vendorPriceKg: String(product.vendorPriceKg),
    vendorPriceSpec: String(product.vendorPriceSpec),
    vendorPriceEach: String(product.vendorPriceEach),
    purchasePriceKg: String(product.purchasePriceKg),
    purchasePriceSpec: String(product.purchasePriceSpec),
    purchasePriceEach: String(product.purchasePriceEach),
    supplierName: product.supplierName,
    storageType: product.storageType,
    allergens: product.allergens,
  };
}

function fieldError(
  field: ProductFormField,
  values: ProductFormValues,
  products: Product[],
  editingId?: string,
) {
  const text = typeof values[field] === 'string' ? values[field].trim() : values[field];
  if (field === 'sku') {
    if (!text) return '상품 코드를 입력해 주세요.';
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,29}$/.test(String(text))) return '영문, 숫자, 하이픈으로 2~30자 입력해 주세요.';
    if (products.some((item) => item.id !== editingId && item.sku.toLocaleLowerCase() === String(text).toLocaleLowerCase())) return '이미 사용 중인 상품 코드입니다.';
  }
  if (field === 'name' && (!text || String(text).length > 100)) return '상품명을 1~100자로 입력해 주세요.';
  if (field === 'category' && (!text || String(text).length > 40)) return '분류를 1~40자로 입력해 주세요.';
  if (field === 'specification' && (!text || String(text).length > 80)) return '규격을 1~80자로 입력해 주세요.';
  if (field === 'supplierName' && (!text || String(text).length > 100)) return '기본 공급업체를 1~100자로 입력해 주세요.';
  if (field === 'allergens' && String(text).length > 120) return '알레르기 정보는 120자 이하로 입력해 주세요.';
  if (priceFieldSet.has(field)) {
    const priceLabel = priceFieldLabels[field as ProductPriceField];
    if (!text) return `${priceLabel}를 입력해 주세요.`;
    const price = Number(text);
    if (!Number.isFinite(price) || price < 0 || price > 100_000_000) return `${priceLabel}는 0~100,000,000원으로 입력해 주세요.`;
    if (!Number.isInteger(price)) return `${priceLabel}는 원 단위 정수로 입력해 주세요.`;
  }
  return undefined;
}

function ProductForm({
  tenant,
  products,
  product,
  onMutate,
  onNotice,
  onClose,
  onBusyChange,
}: Pick<ProductManagementProps, 'tenant' | 'products' | 'onMutate' | 'onNotice'> & {
  product?: Product;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [values, setValues] = useState<ProductFormValues>(() => formValuesFromProduct(product));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const validateField = (field: ProductFormField) => fieldError(field, values, products, product?.id);

  const updateField = <K extends ProductFormField>(field: K, value: ProductFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
    if (formError) setFormError(null);
  };

  const handleBlur = (field: ProductFormField) => {
    const error = validateField(field);
    setErrors((current) => ({ ...current, [field]: error }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = Object.fromEntries(
      fieldOrder.map((field) => [field, validateField(field)]).filter(([, error]) => Boolean(error)),
    ) as ProductFormErrors;
    setErrors(nextErrors);
    const firstInvalid = fieldOrder.find((field) => nextErrors[field]);
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }

    const productInput: ProductInput = {
      sku: values.sku.trim().toUpperCase(),
      name: values.name.trim(),
      category: values.category.trim(),
      specification: values.specification.trim(),
      unit: values.unit,
      schoolPriceKg: Number(values.schoolPriceKg),
      schoolPriceSpec: Number(values.schoolPriceSpec),
      schoolPriceEach: Number(values.schoolPriceEach),
      vendorPriceKg: Number(values.vendorPriceKg),
      vendorPriceSpec: Number(values.vendorPriceSpec),
      vendorPriceEach: Number(values.vendorPriceEach),
      purchasePriceKg: Number(values.purchasePriceKg),
      purchasePriceSpec: Number(values.purchasePriceSpec),
      purchasePriceEach: Number(values.purchasePriceEach),
      supplierName: values.supplierName.trim(),
      storageType: values.storageType,
      allergens: values.allergens.trim(),
    };
    const mutation: ProductMutation = product
      ? { tenant, module: 'products', action: 'update', id: product.id, expectedVersion: product.version, product: productInput }
      : { tenant, module: 'products', action: 'create', product: productInput };

    setBusy(true);
    onBusyChange(true);
    setFormError(null);
    let shouldClose = false;
    let successNotice: { title: string; message: string; tone: 'success' } | null = null;
    try {
      const result = await onMutate(mutation);
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
      successNotice = {
        title: product ? '상품 수정 완료' : '상품 등록 완료',
        message: result.message,
        tone: 'success',
      };
      shouldClose = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '상품을 저장하는 중 알 수 없는 오류가 발생했습니다.';
      setFormError(message);
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (shouldClose) {
        onClose();
        const queuedNotice = successNotice;
        if (queuedNotice) window.requestAnimationFrame(() => onNotice(queuedNotice));
      }
    }
  };

  const errorFor = (field: ProductFormField) => errors[field]
    ? <p id={`product-${field}-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{errors[field]}</p>
    : null;

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} aria-busy={busy || undefined}>
      <div className="space-y-6 px-5 py-5 sm:px-6">
        {formError ? (
          <div role="alert" className="rounded-[var(--ss-radius-md)] border border-[var(--ss-danger-border)] bg-[var(--ss-danger-soft)] px-4 py-3 text-sm font-medium leading-6 text-[var(--ss-danger-strong)]">
            <p className="font-bold">상품을 저장하지 못했습니다.</p>
            <p>{formError}</p>
          </div>
        ) : null}

        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">상품 기본 정보</legend>
          <div>
            <label htmlFor="product-sku" className={fieldLabelClassName}>상품 코드 <span className="text-[var(--ss-danger)]">필수</span></label>
            <input
              id="product-sku"
              name="sku"
              data-modal-initial-focus
              value={values.sku}
              onChange={(event) => updateField('sku', event.target.value)}
              onBlur={() => handleBlur('sku')}
              aria-invalid={Boolean(errors.sku)}
              aria-describedby={errors.sku ? 'product-sku-error' : 'product-sku-help'}
              autoCapitalize="characters"
              autoComplete="off"
              required
              maxLength={30}
              placeholder="예: ING-CHICKEN-01"
              className={inputClassName}
            />
            <p id="product-sku-help" className="mt-1.5 text-xs text-[var(--color-muted-ink)]">영문, 숫자, 하이픈으로 2~30자 입력합니다.</p>
            {errorFor('sku')}
          </div>
          <div>
            <label htmlFor="product-name" className={fieldLabelClassName}>상품명 <span className="text-[var(--ss-danger)]">필수</span></label>
            <input id="product-name" name="name" required maxLength={100} value={values.name} onChange={(event) => updateField('name', event.target.value)} onBlur={() => handleBlur('name')} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'product-name-error' : undefined} className={inputClassName} />
            {errorFor('name')}
          </div>
          <div>
            <label htmlFor="product-category" className={fieldLabelClassName}>분류 <span className="text-[var(--ss-danger)]">필수</span></label>
            <input id="product-category" name="category" required maxLength={40} value={values.category} onChange={(event) => updateField('category', event.target.value)} onBlur={() => handleBlur('category')} aria-invalid={Boolean(errors.category)} aria-describedby={errors.category ? 'product-category-error' : undefined} placeholder="예: 축산물" className={inputClassName} />
            {errorFor('category')}
          </div>
          <div>
            <label htmlFor="product-specification" className={fieldLabelClassName}>규격 <span className="text-[var(--ss-danger)]">필수</span></label>
            <input id="product-specification" name="specification" required maxLength={80} value={values.specification} onChange={(event) => updateField('specification', event.target.value)} onBlur={() => handleBlur('specification')} aria-invalid={Boolean(errors.specification)} aria-describedby={errors.specification ? 'product-specification-error' : undefined} placeholder="예: 10kg/박스" className={inputClassName} />
            {errorFor('specification')}
          </div>
          <div>
            <label htmlFor="product-unit" className={fieldLabelClassName}>재고 단위 <span className="text-[var(--ss-danger)]">필수</span></label>
            <select id="product-unit" name="unit" required value={values.unit} onChange={(event) => updateField('unit', event.target.value as ProductInput['unit'])} className={inputClassName}>
              {units.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
            </select>
          </div>
          <section aria-labelledby="product-price-title" className="sm:col-span-2">
            <div>
              <h3 id="product-price-title" className={fieldLabelClassName}>상품 기본 단가 <span className="text-[var(--ss-danger)]">모두 필수</span></h3>
              <p className="mb-3 text-xs leading-5 text-[var(--ss-text-subtle)]">월별 단가가 아직 없는 기간에만 적용할 학교가·업체가·매입가의 kg, 규격, 개당 기본값입니다. 선택월의 실제 단가는 별도 월별 단가 메뉴에서 수정합니다.</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {priceGroups.map((group) => (
                <div key={group.id} role="group" aria-labelledby={`product-price-group-${group.id}`} className={`rounded-[var(--ss-radius-lg)] border p-4 ${group.className}`}>
                  <div className="mb-3">
                    <h4 id={`product-price-group-${group.id}`} className={`font-bold ${group.headingClassName}`}>{group.label}</h4>
                    <p className="mt-0.5 text-xs text-[var(--ss-text-subtle)]">{group.description}</p>
                  </div>
                  <div className="space-y-3">
                    {group.fields.map(({ field, label }) => (
                      <div key={field}>
                        <label htmlFor={`product-${field}`} className="mb-1 block text-xs font-semibold text-[var(--ss-text-soft)]">{label}</label>
                        <div className="relative">
                          <input
                            id={`product-${field}`}
                            name={field}
                            type="number"
                            min="0"
                            max="100000000"
                            step="1"
                            inputMode="numeric"
                            required
                            value={values[field]}
                            onChange={(event) => updateField(field, event.target.value)}
                            onBlur={() => handleBlur(field)}
                            aria-invalid={Boolean(errors[field])}
                            aria-describedby={errors[field] ? `product-${field}-error` : undefined}
                            className={`${inputClassName} pr-10 text-right tabular-nums`}
                          />
                          <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-[var(--ss-text-muted)]">원</span>
                        </div>
                        {errorFor(field)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <div>
            <label htmlFor="product-supplier" className={fieldLabelClassName}>기본 공급업체 <span className="text-[var(--ss-danger)]">필수</span></label>
            <input id="product-supplier" name="supplierName" required maxLength={100} value={values.supplierName} onChange={(event) => updateField('supplierName', event.target.value)} onBlur={() => handleBlur('supplierName')} aria-invalid={Boolean(errors.supplierName)} aria-describedby={errors.supplierName ? 'product-supplierName-error' : undefined} className={inputClassName} />
            {errorFor('supplierName')}
          </div>
          <div>
            <label htmlFor="product-storage" className={fieldLabelClassName}>보관 방법 <span className="text-[var(--ss-danger)]">필수</span></label>
            <select id="product-storage" name="storageType" required value={values.storageType} onChange={(event) => updateField('storageType', event.target.value as ProductInput['storageType'])} className={inputClassName}>
              {storageTypes.map((storage) => <option key={storage.value} value={storage.value}>{storage.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="product-allergens" className={fieldLabelClassName}>알레르기 정보 <span className="font-medium text-[var(--color-muted-ink)]">선택</span></label>
            <input id="product-allergens" name="allergens" maxLength={120} value={values.allergens} onChange={(event) => updateField('allergens', event.target.value)} onBlur={() => handleBlur('allergens')} aria-invalid={Boolean(errors.allergens)} aria-describedby={errors.allergens ? 'product-allergens-error' : undefined} placeholder="예: 대두, 우유 (없으면 비워두세요)" className={inputClassName} />
            {errorFor('allergens')}
          </div>
        </fieldset>
      </div>

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" disabled={busy} onClick={onClose} className="star-secondary-button px-5 text-sm">취소</button>
        <button type="submit" disabled={busy} className="star-primary-button px-5 text-sm">
          {busy ? '저장 중…' : product ? '변경사항 저장' : '상품 등록'}
        </button>
      </div>
    </form>
  );
}

function ProductPriceForm({
  tenant,
  product,
  productPrice,
  priceMonth,
  onMutate,
  onNotice,
  onClose,
  onBusyChange,
}: {
  tenant: TenantCode;
  product: Product;
  productPrice: ProductPriceSnapshot;
  priceMonth: PriceMonth;
  onMutate: (mutation: ProductPriceMutation) => Promise<ProductPriceMutationResult>;
  onNotice: ProductManagementProps['onNotice'];
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [values, setValues] = useState<ProductPriceFormValues>(() => Object.fromEntries(
    priceFields.map((field) => [field, String(productPrice[field])]),
  ) as ProductPriceFormValues);
  const [errors, setErrors] = useState<ProductPriceFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const validatePrice = (field: ProductPriceField) => {
    const text = values[field].trim();
    const label = priceFieldLabels[field];
    if (!text) return `${label}를 입력해 주세요.`;
    const price = Number(text);
    if (!Number.isFinite(price) || price < 0 || price > 100_000_000) return `${label}는 0~100,000,000원으로 입력해 주세요.`;
    if (!Number.isInteger(price)) return `${label}는 원 단위 정수로 입력해 주세요.`;
    return undefined;
  };

  const updatePrice = (field: ProductPriceField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
    if (formError) setFormError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = Object.fromEntries(
      priceFields.map((field) => [field, validatePrice(field)]).filter(([, error]) => Boolean(error)),
    ) as ProductPriceFormErrors;
    setErrors(nextErrors);
    const firstInvalid = priceFields.find((field) => nextErrors[field]);
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }

    const prices = Object.fromEntries(
      priceFields.map((field) => [field, Number(values[field])]),
    ) as ProductPriceValues;
    setBusy(true);
    onBusyChange(true);
    setFormError(null);
    try {
      const result = await onMutate({
        tenant,
        module: 'product-prices',
        action: 'upsert',
        productId: product.id,
        priceMonth,
        expectedVersion: productPrice.priceVersion,
        expectedSourceMonth: productPrice.priceSourceMonth,
        expectedSourceVersion: productPrice.priceSourceVersion,
        prices,
      });
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
      onClose();
      window.requestAnimationFrame(() => onNotice({
        title: '월별 단가 저장 완료',
        message: result.message,
        tone: 'success',
      }));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '월별 단가를 저장하는 중 오류가 발생했습니다.');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} aria-busy={busy || undefined}>
      <div className="space-y-5 px-5 py-5 sm:px-6">
        <div className="rounded-[var(--ss-radius-md)] border border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-4 py-3 text-sm leading-6 text-[var(--ss-info-strong)]">
          <p className="font-bold">{formatPriceMonth(priceMonth)} · {product.name}</p>
          <p className="text-xs font-medium text-[var(--ss-info-strong)]">
            {productPrice.priceInherited
              ? productPrice.priceSourceMonth
                ? `${formatPriceMonth(productPrice.priceSourceMonth)} 단가를 이어받아 표시 중입니다. 저장하면 선택월 단가 1판이 생성됩니다.`
                : '선택월 단가가 없어 상품 기본 단가를 표시 중입니다. 저장하면 선택월 단가 1판이 생성됩니다.'
              : `선택월 단가 버전 ${productPrice.priceVersion}을 수정합니다.`}
          </p>
        </div>
        {formError ? <p role="alert" className="rounded-[var(--ss-radius-md)] border border-[var(--ss-danger-border)] bg-[var(--ss-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--ss-danger-strong)]">{formError}</p> : null}
        <fieldset disabled={busy} className="grid gap-3 lg:grid-cols-3">
          <legend className="sr-only">학교가, 업체가, 매입가 월별 단가</legend>
          {priceGroups.map((group, groupIndex) => (
            <div key={group.id} role="group" aria-labelledby={`monthly-price-group-${group.id}`} className={`rounded-[var(--ss-radius-lg)] border p-4 ${group.className}`}>
              <h3 id={`monthly-price-group-${group.id}`} className={`font-bold ${group.headingClassName}`}>{group.label}</h3>
              <p className="mt-0.5 text-xs text-[var(--ss-text-subtle)]">{group.description}</p>
              <div className="mt-3 space-y-3">
                {group.fields.map(({ field, label }, fieldIndex) => (
                  <div key={field}>
                    <label htmlFor={`monthly-${field}`} className="mb-1 block text-xs font-semibold text-[var(--ss-text-soft)]">{label}</label>
                    <div className="relative">
                      <input
                        id={`monthly-${field}`}
                        name={field}
                        data-modal-initial-focus={groupIndex === 0 && fieldIndex === 0 ? true : undefined}
                        type="number"
                        min="0"
                        max="100000000"
                        step="1"
                        inputMode="numeric"
                        required
                        value={values[field]}
                        onChange={(event) => updatePrice(field, event.target.value)}
                        onBlur={() => setErrors((current) => ({ ...current, [field]: validatePrice(field) }))}
                        aria-invalid={Boolean(errors[field])}
                        aria-describedby={errors[field] ? `monthly-${field}-error` : undefined}
                        className={`${inputClassName} pr-10 text-right tabular-nums`}
                      />
                      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-[var(--ss-text-muted)]">원</span>
                    </div>
                    {errors[field] ? <p id={`monthly-${field}-error`} role="alert" className="mt-1.5 text-xs font-semibold text-[var(--ss-danger)]">{errors[field]}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" disabled={busy} onClick={onClose} className="star-secondary-button px-5 text-sm">취소</button>
        <button type="submit" disabled={busy} className="star-primary-button px-5 text-sm">
          {busy ? '저장 중…' : `${formatPriceMonth(priceMonth)} 단가 저장`}
        </button>
      </div>
    </form>
  );
}

function ProductManagementContent({
  tenant,
  readOnly,
  products,
  priceMonth,
  productPrices,
  priceLoading,
  priceLoadError,
  onMutate,
  onBulkMutate,
  onPriceMonthChange,
  onPriceMutate,
  onPriceBulkMutate,
  onNotice,
}: ProductManagementProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('ALL');
  const [status, setStatus] = useState<'ALL' | Product['status']>('ALL');
  const [editingProduct, setEditingProduct] = useState<Product | 'create' | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [statusProduct, setStatusProduct] = useState<Product | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [priceImportOpen, setPriceImportOpen] = useState(false);
  const [priceEditingProduct, setPriceEditingProduct] = useState<Product | null>(null);
  const [priceEditorBusy, setPriceEditorBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [searchMode, setSearchMode] = useState<ProductSearchMode>('SMART');
  const [searchResultState, setSearchResultState] = useState<{
    signature: string;
    response: ProductSearchResponse;
  } | null>(null);
  const [searchLoadingSignature, setSearchLoadingSignature] = useState<string | null>(null);
  const [searchErrorState, setSearchErrorState] = useState<{ signature: string; message: string } | null>(null);
  const [searchRetryRevision, setSearchRetryRevision] = useState(0);
  const searchRequestSequence = useRef(0);

  const priceByProductId = useMemo(
    () => new Map(productPrices.map((price) => [price.productId, price])),
    [productPrices],
  );
  const exactPriceCount = useMemo(
    () => products.reduce((count, product) => {
      const price = priceByProductId.get(product.id);
      return count + (price && !price.priceInherited && price.priceMonth === priceMonth ? 1 : 0);
    }, 0),
    [priceByProductId, priceMonth, products],
  );
  const inheritedPriceCount = Math.max(0, products.length - exactPriceCount);
  const priceDataAvailable = productPrices.length === products.length;
  const priceEditable = !readOnly && priceDataAvailable && !priceLoading && priceLoadError === null;
  const monthControlsBusy = priceLoading || priceEditorBusy || importOpen || priceImportOpen || editingProduct !== null || statusProduct !== null;

  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'ko-KR')),
    [products],
  );
  const productCatalogRevision = useMemo(() => {
    let versionTotal = 0;
    let newestUpdate = '';
    for (const product of products) {
      versionTotal += product.version;
      if (product.updatedAt > newestUpdate) newestUpdate = product.updatedAt;
    }
    return `${products.length}:${versionTotal}:${newestUpdate}`;
  }, [products]);

  const trimmedQuery = query.trim();
  const searchSignature = `${tenant}\u0000${trimmedQuery}\u0000${searchMode}\u0000${category}\u0000${status}\u0000${page}\u0000${productCatalogRevision}`;
  const searchLoading = Boolean(trimmedQuery && searchLoadingSignature === searchSignature);
  const searchError = searchErrorState?.signature === searchSignature ? searchErrorState.message : null;

  useEffect(() => {
    const sequence = ++searchRequestSequence.current;
    if (!trimmedQuery) return undefined;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoadingSignature(searchSignature);
      setSearchErrorState(null);
      const parameters = new URLSearchParams({
        tenant,
        q: trimmedQuery,
        mode: searchMode,
        category,
        status,
        page: String(page),
        pageSize: String(productsPerPage),
      });
      void (async () => {
        try {
          const response = await fetch(`/api/erp/products/search?${parameters.toString()}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          const decoded: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const message = isRecord(decoded) && typeof decoded.message === 'string'
              ? decoded.message
              : `상품 검색 API ${response.status}`;
            throw new Error(message);
          }
          const parsed = parseProductSearchResponse(decoded, tenant);
          if (sequence === searchRequestSequence.current) {
            const lastPage = Math.max(1, Math.ceil(parsed.total / parsed.pageSize));
            if (page > lastPage) {
              setPage(lastPage);
              return;
            }
            setSearchResultState({ signature: searchSignature, response: parsed });
          }
        } catch (error) {
          if (controller.signal.aborted || sequence !== searchRequestSequence.current) return;
          setSearchErrorState({
            signature: searchSignature,
            message: error instanceof Error ? error.message : '상품 유사 검색을 완료하지 못했습니다.',
          });
        } finally {
          if (sequence === searchRequestSequence.current) {
            setSearchLoadingSignature((current) => current === searchSignature ? null : current);
          }
        }
      })();
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [category, page, searchMode, searchRetryRevision, searchSignature, status, tenant, trimmedQuery]);

  const localFilteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ko-KR');
    return products.filter((product) => {
      const matchesQuery = !normalized || [product.sku, product.name, product.category, product.specification, product.supplierName, product.allergens]
        .some((value) => value.toLocaleLowerCase('ko-KR').includes(normalized));
      return matchesQuery
        && (category === 'ALL' || product.category === category)
        && (status === 'ALL' || product.status === status);
    });
  }, [category, products, query, status]);
  const productById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );
  const activeSearchResponse = searchResultState?.signature === searchSignature
    ? searchResultState.response
    : null;
  const searchPending = Boolean(trimmedQuery && !activeSearchResponse && !searchError);
  const searchItemByProductId = useMemo(
    () => new Map((activeSearchResponse?.items ?? []).map((item) => [item.productId, item])),
    [activeSearchResponse],
  );
  const rankedProducts = useMemo(
    () => (activeSearchResponse?.items ?? []).map((item) => {
      const currentProduct = productById.get(item.productId);
      return currentProduct && currentProduct.version >= item.product.version
        ? currentProduct
        : item.product;
    }),
    [activeSearchResponse, productById],
  );
  const resultCount = trimmedQuery && activeSearchResponse
    ? activeSearchResponse.total
    : localFilteredProducts.length;
  const pageCount = Math.max(1, Math.ceil(resultCount / productsPerPage));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * productsPerPage;
  const visibleProducts = trimmedQuery && activeSearchResponse
    ? rankedProducts
    : localFilteredProducts.slice(pageStart, pageStart + productsPerPage);

  const closeEditor = () => {
    setEditingProduct(null);
    setEditorBusy(false);
  };
  const closePriceEditor = () => {
    setPriceEditingProduct(null);
    setPriceEditorBusy(false);
  };
  const intendedStatus = statusProduct?.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

  const changeStatus = async () => {
    if (!statusProduct) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const result = await onMutate({
        tenant,
        module: 'products',
        action: 'set-status',
        id: statusProduct.id,
        expectedVersion: statusProduct.version,
        status: intendedStatus,
      });
      if (!result.ok) {
        setStatusError(result.message);
        return;
      }
      const successNotice = {
        title: intendedStatus === 'ACTIVE' ? '상품 활성화 완료' : '상품 사용 중지 완료',
        message: result.message,
        tone: 'success' as const,
      };
      setStatusProduct(null);
      window.requestAnimationFrame(() => onNotice(successNotice));
    } catch (error) {
      const message = error instanceof Error ? error.message : '상품 상태를 변경하는 중 알 수 없는 오류가 발생했습니다.';
      setStatusError(message);
    } finally {
      setStatusBusy(false);
    }
  };

  const renderStatus = (product: Product) => (
    <span className={`status-badge ${product.status === 'ACTIVE' ? 'status-success' : 'status-neutral'}`}>
      {product.status === 'ACTIVE' ? '사용 중' : '사용 중지'}
    </span>
  );
  const renderSearchMatch = (product: Product) => {
    const item = searchItemByProductId.get(product.id);
    if (!trimmedQuery || !activeSearchResponse || !item) return null;
    return (
      <span className="mt-1.5 inline-flex max-w-full rounded-full border border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-2 py-1 text-[10px] font-bold text-[var(--ss-info-strong)]">
        {productSearchReasonLabels[item.reason]} · 검색 적합도 {Math.round(item.score * 100)}점
      </span>
    );
  };
  const priceSnapshot = (product: Product) => snapshotForProduct(product, priceMonth, priceByProductId);
  const displayProduct = (product: Product) => productWithMonthlyPrice(product, priceSnapshot(product));

  return (
    <section aria-labelledby="product-management-title" aria-busy={priceLoading || searchPending || searchLoading || undefined} className="space-y-4">
      <div className="panel p-0">
        <div className="flex flex-col gap-4 border-b border-[var(--color-border)] p-5 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div>
            <p className="eyebrow">PRODUCT MASTER</p>
            <h2 id="product-management-title" className="mt-1 text-xl font-bold tracking-tight">상품·식자재 관리</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--ss-text-subtle)]">발주와 재고에 사용하는 식자재 상품 기준정보를 관리합니다.</p>
          </div>
          {readOnly ? (
            <span className="status-badge status-neutral w-fit">조회 전용 권한</span>
          ) : <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <button id="product-price-import-button" type="button" aria-haspopup="dialog" onClick={() => setPriceImportOpen(true)} disabled={!priceEditable} className="star-secondary-button shrink-0 border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-4 text-sm text-[var(--ss-info-strong)]">
              <CircleDollarSign aria-hidden="true" size={18} /> 월별 단가 엑셀
            </button>
            <button id="product-import-button" type="button" aria-haspopup="dialog" onClick={() => setImportOpen(true)} className="star-secondary-button shrink-0 px-4 text-sm">
              <FileSpreadsheet aria-hidden="true" size={18} /> 상품 기본정보 엑셀
            </button>
            <button type="button" onClick={() => { setEditorBusy(false); setEditingProduct('create'); }} className="star-primary-button shrink-0 px-4 text-sm">
              <Plus aria-hidden="true" size={18} /> 상품 등록
            </button>
          </div>}
        </div>

        <div className="flex flex-col gap-3 border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-4 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div>
              <label htmlFor="product-price-month" className="mb-1.5 block text-xs font-semibold text-[var(--ss-text-subtle)]">단가 기준월</label>
              <div className="relative">
                <CalendarDays aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ss-text-muted)]" size={17} />
                <input
                  id="product-price-month"
                  type="month"
                  value={priceMonth}
                  disabled={monthControlsBusy}
                  onChange={(event) => {
                    if (isPriceMonth(event.target.value)) void onPriceMonthChange(event.target.value);
                  }}
                  className={`${inputClassName} min-w-[190px] pl-10`}
                />
              </div>
            </div>
            {priceMonth !== currentPriceMonth() ? (
              <button type="button" disabled={monthControlsBusy} onClick={() => void onPriceMonthChange(currentPriceMonth())} className="star-secondary-button px-4 text-sm">이번 달</button>
            ) : null}
          </div>
          <div role="status" aria-live="polite" className="text-sm font-medium text-[var(--ss-text-subtle)]">
            <strong className="text-[var(--color-ink)]">{formatPriceMonth(priceMonth)}</strong>
            {priceDataAvailable ? <>{' · '}직접 등록 {exactPriceCount.toLocaleString('ko-KR')}건{' · '}이전·기본 단가 적용 {inheritedPriceCount.toLocaleString('ko-KR')}건</> : null}
            {priceLoading ? (
              <span className="ml-2 inline-flex items-center align-middle">
                <span className="sr-only">월별 단가를 불러오고 있습니다.</span>
                <SkeletonBlock className="h-3 w-24" />
              </span>
            ) : null}
          </div>
        </div>

        {priceLoadError ? (
          <div role="alert" className="flex flex-col gap-3 border-b border-red-200 bg-red-50 px-5 py-4 text-sm font-semibold text-red-900 sm:flex-row sm:items-center sm:justify-between">
            <p>{priceLoadError} {priceDataAvailable ? '마지막으로 확인한 단가는 참고용으로 유지하며 수정·내보내기하지 않습니다.' : '확인되지 않은 단가는 표시·수정·내보내기하지 않습니다.'}</p>
            <button type="button" disabled={priceLoading} onClick={() => void onPriceMonthChange(priceMonth)} className="min-h-11 shrink-0 rounded-xl border border-red-300 bg-white px-4 font-extrabold text-red-800 hover:bg-red-100 disabled:opacity-50">다시 불러오기</button>
          </div>
        ) : null}

        <div className="grid gap-3 p-5 md:grid-cols-[minmax(220px,1fr)_200px_160px]">
          <div>
            <label htmlFor="product-search" className="mb-1.5 block text-xs font-semibold text-[var(--ss-text-subtle)]">상품 검색</label>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ss-text-muted)]" size={17} />
              <input id="product-search" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="오타가 있어도 상품명·코드 검색" className={`${inputClassName} pl-10`} />
            </div>
          </div>
          <div>
            <label htmlFor="product-category-filter" className="mb-1.5 block text-xs font-semibold text-[var(--ss-text-subtle)]">분류</label>
            <select id="product-category-filter" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }} className={inputClassName}>
              <option value="ALL">전체 분류</option>
              {categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="product-status-filter" className="mb-1.5 block text-xs font-semibold text-[var(--ss-text-subtle)]">사용 상태</label>
            <select id="product-status-filter" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }} className={inputClassName}>
              <option value="ALL">전체 상태</option>
              <option value="ACTIVE">사용 중</option>
              <option value="INACTIVE">사용 중지</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <p id="product-search-mode-label" className="mb-1.5 text-xs font-semibold text-[var(--ss-text-subtle)]">검색 방식</p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="product-search-mode-label">
              {productSearchModes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={searchMode === option.value}
                  aria-describedby="product-search-mode-description"
                  title={option.description}
                  onClick={() => {
                    if (searchMode === option.value) return;
                    setSearchMode(option.value);
                    setPage(1);
                  }}
                  className={`min-h-11 rounded-[var(--ss-radius-md)] border px-3 text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ss-focus)] ${searchMode === option.value
                    ? 'border-[var(--ss-brand-active)] bg-[var(--ss-brand)] text-[var(--ss-on-brand)] shadow-[var(--ss-shadow-sm)]'
                    : 'border-[var(--ss-border)] bg-[var(--ss-surface)] text-[var(--ss-text-soft)] hover:border-[var(--ss-border-strong)] hover:bg-[var(--ss-surface-subtle)]'}`}
                >
                  {option.label}{option.value !== 'SMART' ? <span className="ml-1 text-[10px] opacity-75">· {option.value === 'TRIGRAM' ? '트라이그램' : 'pgvector'}</span> : null}
                </button>
              ))}
            </div>
            <p id="product-search-mode-description" className="mt-2 text-xs leading-5 text-[var(--ss-text-muted)]">
              {productSearchModes.find((option) => option.value === searchMode)?.description} 외부 AI 서비스로 상품 정보를 전송하지 않습니다.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-1">
        <p
          role={!searchPending && !searchError ? 'status' : undefined}
          aria-live={!searchPending && !searchError ? 'polite' : undefined}
          aria-atomic={!searchPending && !searchError ? 'true' : undefined}
          className="text-sm font-medium text-[var(--ss-text-subtle)]"
        >
          {searchPending ? (
            <span className="inline-flex items-center">
              <SkeletonBlock className="h-4 w-44" />
            </span>
          ) : (
            <>검색 결과 {resultCount.toLocaleString('ko-KR')}건 · 전체 {products.length.toLocaleString('ko-KR')}건{resultCount > 0 ? ` · ${pageStart + 1}~${pageStart + visibleProducts.length}건 표시` : ''}</>
          )}
          {trimmedQuery && searchLoading && activeSearchResponse ? (
            <span className="ml-2 inline-flex items-center align-middle">
              <span className="sr-only">검색 결과를 새로 고치고 있습니다.</span>
              <SkeletonBlock className="h-3 w-20" />
            </span>
          ) : null}
        </p>
        {(query || category !== 'ALL' || status !== 'ALL' || searchMode !== 'SMART') ? (
          <button type="button" onClick={() => { setQuery(''); setCategory('ALL'); setStatus('ALL'); setSearchMode('SMART'); setPage(1); }} className="min-h-11 shrink-0 rounded-[var(--ss-radius-md)] px-3 text-sm font-semibold text-[var(--ss-info)] hover:bg-[var(--ss-info-soft)]">필터 초기화</button>
        ) : null}
      </div>

      {searchError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-warning-border)] bg-[var(--ss-warning-soft)] px-4 py-3 text-sm font-semibold text-[var(--ss-warning-strong)] sm:flex-row sm:items-center sm:justify-between">
          <p>{searchError} {activeSearchResponse ? '마지막 검색 결과를 유지합니다.' : '현재 화면에서는 정확히 포함된 상품만 임시로 표시합니다.'}</p>
          <button
            type="button"
            onClick={() => {
              setSearchErrorState(null);
              setSearchLoadingSignature(searchSignature);
              setSearchRetryRevision((current) => current + 1);
            }}
            className="star-secondary-button shrink-0 px-4 text-sm"
          >
            다시 검색
          </button>
        </div>
      ) : null}

      {searchPending ? (
        <ProductResultsSkeleton />
      ) : resultCount === 0 ? (
        <div className="panel grid min-h-[280px] place-items-center text-center">
          <div>
            <PackageOpen aria-hidden="true" className="mx-auto text-slate-400" size={42} />
            <h3 className="mt-4 text-base font-semibold">{searchError && products.length > 0 ? '임시 검색 결과가 없습니다.' : products.length === 0 ? '등록된 상품이 없습니다.' : '조건에 맞는 상품이 없습니다.'}</h3>
            <p className="mt-2 text-sm text-[var(--ss-text-subtle)]">{searchError && products.length > 0 ? '검색을 다시 시도하거나 정확한 상품명으로 찾아보세요.' : products.length === 0 ? '첫 상품을 등록해 발주와 재고 기준정보를 만드세요.' : '검색어나 필터 조건을 변경해 보세요.'}</p>
            {products.length === 0 && !readOnly ? <button type="button" onClick={() => { setEditorBusy(false); setEditingProduct('create'); }} className="star-primary-button mt-5 px-5 text-sm">첫 상품 등록</button> : null}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:hidden">
            {visibleProducts.map((product) => (
              <article key={product.id} className="rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-semibold text-[var(--ss-info)]">{product.sku}</p>
                    <h3 className="mt-1 text-base font-bold">{product.name}</h3>
                    {renderSearchMatch(product)}
                    <p className="mt-1 text-sm text-[var(--ss-text-subtle)]">{product.specification}</p>
                  </div>
                  {renderStatus(product)}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-[var(--ss-border)] py-4 text-sm">
                  <div><dt className="text-xs font-medium text-[var(--ss-text-subtle)]">분류</dt><dd className="mt-1 font-semibold">{product.category}</dd></div>
                  <div><dt className="text-xs font-medium text-[var(--ss-text-subtle)]">보관</dt><dd className="mt-1 font-semibold">{storageLabel(product.storageType)}</dd></div>
                  <div><dt className="text-xs font-medium text-[var(--ss-text-subtle)]">공급업체</dt><dd className="mt-1 truncate font-semibold">{product.supplierName}</dd></div>
                  <div><dt className="text-xs font-medium text-[var(--ss-text-subtle)]">재고 단위</dt><dd className="mt-1 font-semibold">{unitLabel(product.unit)}</dd></div>
                </dl>
                {priceDataAvailable ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {priceGroups.map((group) => <ProductPriceGroupValues key={group.id} product={displayProduct(product)} group={group} />)}
                  </div>
                ) : priceLoading ? (
                  <div aria-hidden="true" className="mt-3 grid gap-2 sm:grid-cols-3">
                    {priceGroups.map((group) => <SkeletonBlock key={group.id} className="h-[106px] w-full rounded-[var(--ss-radius-md)]" />)}
                  </div>
                ) : <p className="mt-3 rounded-[var(--ss-radius-md)] bg-[var(--ss-surface-subtle)] px-3 py-4 text-center text-sm font-medium text-[var(--ss-text-subtle)]">월별 단가 조회 불가</p>}
                {priceDataAvailable && priceSnapshot(product).priceInherited ? (
                  <p className="mt-2 text-xs font-bold text-blue-800">
                    {priceSnapshot(product).priceSourceMonth
                      ? `${formatPriceMonth(priceSnapshot(product).priceSourceMonth as PriceMonth)} 단가 이어받음`
                      : '상품 기본 단가 적용 중'}
                  </p>
                ) : null}
                {product.allergens ? <p className="mt-3 text-xs font-semibold text-amber-800">알레르기 · {product.allergens}</p> : null}
                {readOnly ? <p className="mt-4 text-right text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</p> : <div className="mt-4 grid grid-cols-3 gap-2">
                  <button type="button" disabled={!priceEditable} aria-label={`${product.name} ${formatPriceMonth(priceMonth)} 단가 편집`} onClick={() => { setPriceEditorBusy(false); setPriceEditingProduct(product); }} className="star-secondary-button border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-2 text-sm text-[var(--ss-info-strong)]"><CircleDollarSign aria-hidden="true" size={16} /> 단가</button>
                  <button type="button" aria-label={`${product.name} 상품 편집`} onClick={() => { setEditorBusy(false); setEditingProduct(product); }} className="star-secondary-button flex-1 px-2 text-sm"><Pencil aria-hidden="true" size={16} /> 편집</button>
                  <button type="button" aria-label={`${product.name} ${product.status === 'ACTIVE' ? '사용 중지' : '활성화'}`} onClick={() => { setStatusError(null); setStatusProduct(product); }} className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border text-sm font-extrabold ${product.status === 'ACTIVE' ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100' : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`}>
                    {product.status === 'ACTIVE' ? <PowerOff aria-hidden="true" size={16} /> : <Power aria-hidden="true" size={16} />}
                    {product.status === 'ACTIVE' ? '사용 중지' : '활성화'}
                  </button>
                </div>}
              </article>
            ))}
          </div>

          <div className="panel hidden overflow-hidden p-0 lg:block">
            <div className="overflow-x-auto">
              <table className="erp-table min-w-[1320px]">
                <caption className="sr-only">상품·식자재 기준정보 검색 결과</caption>
                <thead>
                  <tr><th scope="col">상품</th><th scope="col">분류</th><th scope="col">규격·단위</th><th scope="col">학교가 · {formatPriceMonth(priceMonth)}</th><th scope="col">업체가 · {formatPriceMonth(priceMonth)}</th><th scope="col">매입가 · {formatPriceMonth(priceMonth)}</th><th scope="col" className="hidden 2xl:table-cell">기본 공급업체</th><th scope="col">보관</th><th scope="col">상태</th><th scope="col" className="text-right">관리</th></tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <span className="block font-extrabold">{product.name}</span>
                        <span className="mt-1 block font-mono text-xs text-[var(--color-blue)]">{product.sku}</span>
                        {renderSearchMatch(product)}
                        {priceDataAvailable && priceSnapshot(product).priceInherited ? <span className="mt-1 block text-[10px] font-bold text-blue-800">{priceSnapshot(product).priceSourceMonth ? `${formatPriceMonth(priceSnapshot(product).priceSourceMonth as PriceMonth)} 이어받음` : '기본 단가'}</span> : null}
                      </td>
                      <td>{product.category}</td>
                      <td><span className="block font-semibold">{product.specification}</span><span className="mt-1 block text-xs text-slate-500">단위 {unitLabel(product.unit)}</span></td>
                      {priceGroups.map((group) => <td key={group.id}>{priceDataAvailable ? <ProductPriceGroupValues product={displayProduct(product)} group={group} showHeading={false} /> : priceLoading ? <SkeletonBlock className="h-12 w-24" /> : <span className="font-bold text-slate-500">조회 불가</span>}</td>)}
                      <td className="hidden 2xl:table-cell"><span className="block max-w-[180px] truncate">{product.supplierName}</span></td>
                      <td>{storageLabel(product.storageType)}</td>
                      <td>{renderStatus(product)}<span className="mt-1 block text-[10px] text-slate-500">{formatUpdatedAt(product.updatedAt)}</span></td>
                      <td className="text-right">
                        {readOnly ? <span className="text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</span> : <div className="inline-flex gap-2">
                          <button type="button" disabled={!priceEditable} aria-label={`${product.name} ${formatPriceMonth(priceMonth)} 단가 편집`} title="월별 단가" onClick={() => { setPriceEditorBusy(false); setPriceEditingProduct(product); }} className="star-icon-button border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] text-[var(--ss-info-strong)]"><CircleDollarSign aria-hidden="true" size={17} /></button>
                          <button type="button" aria-label={`${product.name} 상품 편집`} title="편집" onClick={() => { setEditorBusy(false); setEditingProduct(product); }} className="star-icon-button"><Pencil aria-hidden="true" size={17} /></button>
                          <button type="button" aria-label={`${product.name} ${product.status === 'ACTIVE' ? '사용 중지' : '활성화'}`} title={product.status === 'ACTIVE' ? '사용 중지' : '활성화'} onClick={() => { setStatusError(null); setStatusProduct(product); }} className={`grid h-11 w-11 place-items-center rounded-xl border ${product.status === 'ACTIVE' ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}>
                            {product.status === 'ACTIVE' ? <PowerOff aria-hidden="true" size={17} /> : <Power aria-hidden="true" size={17} />}
                          </button>
                        </div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {resultCount > productsPerPage ? (
            <nav aria-label="상품 목록 페이지" className="flex items-center justify-center gap-3 rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] px-4 py-3">
              <button type="button" disabled={currentPage === 1} onClick={() => setPage(Math.max(1, currentPage - 1))} className="star-secondary-button px-4 text-sm">이전</button>
              <p className="min-w-24 text-center text-sm font-semibold text-[var(--ss-text-soft)]">{currentPage} / {pageCount} 페이지</p>
              <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(Math.min(pageCount, currentPage + 1))} className="star-secondary-button px-4 text-sm">다음</button>
            </nav>
          ) : null}
        </>
      )}

      <AccessibleModal
        open={editingProduct !== null}
        title={editingProduct === 'create' ? '상품 등록' : '상품 정보 수정'}
        description={editingProduct === 'create' ? '발주와 재고에 사용할 상품 기준정보를 입력합니다.' : '변경된 정보는 이후 발주와 재고 업무에 적용됩니다.'}
        busy={editorBusy}
        dismissOnBackdrop={false}
        fallbackFocusSelector="#erp-main-content"
        onRequestClose={closeEditor}
        size="large"
      >
        {editingProduct ? (
          <ProductForm
            key={editingProduct === 'create' ? `create-${tenant}` : editingProduct.id}
            tenant={tenant}
            products={products}
            product={editingProduct === 'create' ? undefined : editingProduct}
            onMutate={onMutate}
            onNotice={onNotice}
            onClose={closeEditor}
            onBusyChange={setEditorBusy}
          />
        ) : null}
      </AccessibleModal>

      <AccessibleModal
        open={priceEditingProduct !== null}
        title={`${formatPriceMonth(priceMonth)} 월별 단가 수정`}
        description={priceEditingProduct ? `${priceEditingProduct.name} (${priceEditingProduct.sku})의 학교가·업체가·매입가 9개 단가를 관리합니다.` : undefined}
        busy={priceEditorBusy}
        dismissOnBackdrop={false}
        fallbackFocusSelector="#erp-main-content"
        onRequestClose={closePriceEditor}
        size="large"
      >
        {priceEditingProduct ? (
          <ProductPriceForm
            key={`${priceEditingProduct.id}-${priceMonth}-${priceSnapshot(priceEditingProduct).priceVersion}`}
            tenant={tenant}
            product={priceEditingProduct}
            productPrice={priceSnapshot(priceEditingProduct)}
            priceMonth={priceMonth}
            onMutate={onPriceMutate}
            onNotice={onNotice}
            onClose={closePriceEditor}
            onBusyChange={setPriceEditorBusy}
          />
        ) : null}
      </AccessibleModal>

      <AccessibleModal
        open={statusProduct !== null}
        title={intendedStatus === 'ACTIVE' ? '상품을 활성화할까요?' : '상품 사용을 중지할까요?'}
        description={statusProduct ? `${statusProduct.name} (${statusProduct.sku})의 사용 상태를 변경합니다.` : undefined}
        busy={statusBusy}
        dismissOnBackdrop={false}
        fallbackFocusSelector="#erp-main-content"
        onRequestClose={() => { setStatusProduct(null); setStatusError(null); }}
        size="small"
      >
        <div className="px-5 py-5 sm:px-6">
          <p className="text-sm leading-6 text-slate-700">
            {intendedStatus === 'ACTIVE'
              ? '활성화하면 새 발주와 재고 업무에서 이 상품을 다시 선택할 수 있습니다.'
              : '사용 중지 후에는 새 발주와 재고 업무에서 선택할 수 없지만 기존 업무 기록은 유지됩니다.'}
          </p>
          {statusError ? <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{statusError}</p> : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button data-modal-initial-focus type="button" disabled={statusBusy} onClick={() => { setStatusProduct(null); setStatusError(null); }} className="star-secondary-button px-5 text-sm">취소</button>
          <button type="button" disabled={statusBusy} onClick={() => void changeStatus()} className={`min-h-11 rounded-xl px-5 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-45 ${intendedStatus === 'ACTIVE' ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-red-700 hover:bg-red-800'}`}>
            {statusBusy ? '처리 중…' : intendedStatus === 'ACTIVE' ? '활성화' : '사용 중지'}
          </button>
        </div>
      </AccessibleModal>

      <ProductImportModal
        open={importOpen}
        tenant={tenant}
        products={products}
        onClose={() => setImportOpen(false)}
        onBulkMutate={onBulkMutate}
      />
      <ProductPriceImportModal
        open={priceImportOpen}
        tenant={tenant}
        priceMonth={priceMonth}
        products={products}
        productPrices={productPrices}
        onClose={() => setPriceImportOpen(false)}
        onBulkMutate={onPriceBulkMutate}
      />
    </section>
  );
}

export function ProductManagement(props: ProductManagementProps) {
  return <ProductManagementContent key={props.tenant} {...props} />;
}
