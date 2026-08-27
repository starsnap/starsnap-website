'use client';

import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type {
  BulkProductPriceMutationResult,
  BulkProductPriceRequest,
  PriceMonth,
  Product,
  ProductPriceSnapshot,
  TenantCode,
} from '../lib/erp-types';
import {
  downloadProductPriceWorkbook,
  parseProductPriceWorkbook,
  productPriceWorkbookPartCount,
  PRODUCT_PRICE_WORKBOOK_MAX_BYTES,
  PRODUCT_PRICE_WORKBOOK_MAX_ROWS,
  PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION,
  ProductPriceWorkbookParseError,
  type ProductPriceWorkbookParseResult,
  type ProductPriceWorkbookPreviewRow,
} from '../lib/product-price-excel';
import { AccessibleModal } from './accessible-modal';

export interface ProductPriceImportModalProps {
  open: boolean;
  tenant: TenantCode;
  priceMonth: PriceMonth;
  products: readonly Product[];
  productPrices: readonly ProductPriceSnapshot[];
  onClose: () => void;
  onBulkMutate: (
    request: BulkProductPriceRequest,
    idempotencyKey: string,
  ) => Promise<BulkProductPriceMutationResult>;
}

interface ResultError {
  rowNumber: number;
  field?: string;
  message: string;
}

type ImportStep = 'file' | 'preview' | 'confirm' | 'result';
type BusyTask = 'download' | 'parse' | 'submit';

const stepLabels: Array<{ id: ImportStep; label: string }> = [
  { id: 'file', label: '파일 선택' },
  { id: 'preview', label: '미리보기' },
  { id: 'confirm', label: '확인' },
  { id: 'result', label: '결과' },
];

const previewRowLimit = 20;
const previewErrorRowLimit = 10;
const resultErrorLimit = 20;
const maxFileSizeMb = PRODUCT_PRICE_WORKBOOK_MAX_BYTES / (1024 * 1024);

const previewPriceGroups = [
  {
    label: '학교가',
    fields: [
      { field: 'schoolPriceKg', label: 'kg' },
      { field: 'schoolPriceSpec', label: '규격' },
      { field: 'schoolPriceEach', label: '개당' },
    ],
  },
  {
    label: '업체가',
    fields: [
      { field: 'vendorPriceKg', label: 'kg' },
      { field: 'vendorPriceSpec', label: '규격' },
      { field: 'vendorPriceEach', label: '개당' },
    ],
  },
  {
    label: '매입가',
    fields: [
      { field: 'purchasePriceKg', label: 'kg' },
      { field: 'purchasePriceSpec', label: '규격' },
      { field: 'purchasePriceEach', label: '개당' },
    ],
  },
] as const;

function formatPriceMonth(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? `${Number(match[1])}년 ${Number(match[2])}월` : value;
}

function rowErrors(row: ProductPriceWorkbookPreviewRow) {
  return (row.errors ?? []).map((error) => error.message).filter(Boolean);
}

function normalizeWorkbook(value: ProductPriceWorkbookParseResult) {
  if (!value || !value.request || !Array.isArray(value.request.rows) || !Array.isArray(value.rows)) {
    throw new Error('엑셀 파일에서 월별 상품 단가 행을 읽지 못했습니다.');
  }
  return value;
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

export function ProductPriceImportModal({
  open,
  tenant,
  priceMonth,
  products,
  productPrices,
  onClose,
  onBulkMutate,
}: ProductPriceImportModalProps) {
  const [step, setStep] = useState<ImportStep>('file');
  const [file, setFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<ProductPriceWorkbookParseResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busyTask, setBusyTask] = useState<BusyTask | null>(null);
  const [result, setResult] = useState<BulkProductPriceMutationResult | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => workbook?.rows ?? [], [workbook]);
  const requestRows = useMemo(() => workbook?.request.rows ?? [], [workbook]);
  const updateWorkbookParts = productPriceWorkbookPartCount(products.length);
  const busy = busyTask !== null;
  const scopeMatches = !workbook
    || workbook.request.tenant === tenant && workbook.request.priceMonth === priceMonth;
  const selectedMonthLabel = formatPriceMonth(priceMonth);
  const currentPriceSummary = useMemo(() => {
    let exact = 0;
    let inherited = 0;
    const pricesByProductId = new Map(
      productPrices
        .filter((price) => price.priceMonth === priceMonth)
        .map((price) => [price.productId, price]),
    );
    for (const product of products) {
      const price = pricesByProductId.get(product.id);
      if (!price) {
        inherited += 1;
        continue;
      }
      if (price.priceVersion > 0 && !price.priceInherited) exact += 1;
      else inherited += 1;
    }
    return { exact, inherited };
  }, [priceMonth, productPrices, products]);

  const workbookSummary = useMemo(() => {
    const errorSamples: ResultError[] = (workbook?.errors ?? []).slice(0, 5);
    const sampledRows = rows.slice(0, previewRowLimit);
    const sampledRowNumbers = new Set(sampledRows.map((row) => row.rowNumber));
    let errorCount = workbook?.errors.length ?? 0;
    let sampledErrorRows = 0;
    let createCount = 0;
    let updateCount = 0;

    for (const row of rows) {
      if (row.expectedVersion === 0) createCount += 1;
      else updateCount += 1;
      const messages = rowErrors(row);
      errorCount += messages.length;
      for (const message of messages) {
        if (errorSamples.length >= 5) break;
        errorSamples.push({ rowNumber: row.rowNumber, message });
      }
      if (messages.length > 0 && sampledErrorRows < previewErrorRowLimit) {
        sampledErrorRows += 1;
        if (!sampledRowNumbers.has(row.rowNumber)) {
          sampledRows.push(row);
          sampledRowNumbers.add(row.rowNumber);
        }
      }
    }

    sampledRows.sort((left, right) => left.rowNumber - right.rowNumber);
    if (!scopeMatches) {
      errorCount += 1;
      errorSamples.unshift({ rowNumber: 0, message: '파일을 읽은 뒤 회사 또는 단가 적용월이 바뀌었습니다. 현재 목록을 다시 내려받아 주세요.' });
    }
    return { createCount, updateCount, errorCount, errorSamples, visibleRows: sampledRows };
  }, [rows, scopeMatches, workbook?.errors]);

  const resultErrorSummary = useMemo(() => {
    const samples: ResultError[] = [];
    let messageCount = 0;
    let detailedFailureRows = 0;
    for (const row of result?.rows ?? []) {
      if (row.status !== 'error' && row.status !== 'not_applied') continue;
      if (row.status === 'error') detailedFailureRows += 1;
      const nextErrors = row.errors?.length
        ? row.errors.map((error) => ({ rowNumber: row.rowNumber, field: error.field, message: error.message }))
        : [{ rowNumber: row.rowNumber, message: '서버 검증에 실패했습니다.' }];
      messageCount += nextErrors.length;
      if (samples.length < resultErrorLimit) {
        samples.push(...nextErrors.slice(0, resultErrorLimit - samples.length));
      }
    }
    return {
      failedRows: result?.summary.failed ?? detailedFailureRows,
      notAppliedRows: result?.summary.notApplied ?? 0,
      messageCount,
      samples,
    };
  }, [result]);
  const { createCount, updateCount, errorCount, errorSamples, visibleRows } = workbookSummary;

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      if (step === 'preview' && errorCount > 0) errorSummaryRef.current?.focus();
      else stageHeadingRef.current?.focus();
    });
  }, [errorCount, open, step]);

  const reset = () => {
    setStep('file');
    setFile(null);
    setWorkbook(null);
    setFileError(null);
    setResult(null);
    setIdempotencyKey(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const requestClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const focusRow = (rowNumber: number) => {
    window.requestAnimationFrame(() => {
      const breakpoint = window.matchMedia('(min-width: 1024px)').matches ? 'desktop' : 'mobile';
      const row = document.getElementById(`product-price-import-row-${rowNumber}-${breakpoint}`);
      if (row) row.focus();
      else errorSummaryRef.current?.focus();
    });
  };

  const downloadPart = async (partNumber = 1) => {
    if (busy || products.length === 0) return;
    setFileError(null);
    setBusyTask('download');
    try {
      await waitForNextPaint();
      await downloadProductPriceWorkbook(tenant, priceMonth, products, productPrices, partNumber);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : '월별 단가 수정 목록을 준비하지 못했습니다.');
    } finally {
      setBusyTask(null);
    }
  };

  const parseFile = async (nextFile: File) => {
    setIdempotencyKey(null);
    if (!/\.xlsx$/i.test(nextFile.name)) {
      setFile(null);
      setWorkbook(null);
      setFileError('Excel .xlsx 파일만 선택할 수 있습니다.');
      return;
    }
    if (nextFile.size > PRODUCT_PRICE_WORKBOOK_MAX_BYTES) {
      setFile(null);
      setWorkbook(null);
      setFileError(`파일 크기는 ${maxFileSizeMb}MB 이하여야 합니다.`);
      return;
    }

    setBusyTask('parse');
    setFile(nextFile);
    setFileError(null);
    setResult(null);
    try {
      await waitForNextPaint();
      const parsed = normalizeWorkbook(
        await parseProductPriceWorkbook(nextFile, tenant, priceMonth, products, productPrices),
      );
      if (parsed.request.tenant !== tenant || parsed.request.priceMonth !== priceMonth) {
        throw new Error('선택한 회사·단가 적용월과 일치하는 파일만 업로드할 수 있습니다.');
      }
      if (parsed.totalRows > PRODUCT_PRICE_WORKBOOK_MAX_ROWS) {
        throw new Error(`한 번에 최대 ${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행까지만 적용할 수 있습니다.`);
      }
      setWorkbook(parsed);
      setIdempotencyKey(crypto.randomUUID());
      setStep('preview');
    } catch (error) {
      setWorkbook(null);
      if (error instanceof ProductPriceWorkbookParseError) {
        const details = error.errors
          .slice(0, 3)
          .map((item) => `${item.rowNumber > 0 ? `${item.rowNumber}행 · ` : ''}${item.message}`)
          .join(' ');
        setFileError(details && !details.includes(error.message) ? `${error.message} ${details}` : error.message);
      } else {
        setFileError(error instanceof Error ? error.message : '엑셀 파일을 확인하는 중 오류가 발생했습니다.');
      }
    } finally {
      setBusyTask(null);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) void parseFile(nextFile);
  };

  const submit = async () => {
    if (!workbook || !scopeMatches || errorCount > 0 || requestRows.length === 0 || requestRows.length !== rows.length) return;
    const requestKey = idempotencyKey ?? crypto.randomUUID();
    if (!idempotencyKey) setIdempotencyKey(requestKey);
    setBusyTask('submit');
    try {
      await waitForNextPaint();
      const response = await onBulkMutate(workbook.request, requestKey);
      setResult(response);
      setStep('result');
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '월별 단가 일괄 처리 중 알 수 없는 오류가 발생했습니다.',
        summary: { total: requestRows.length, created: 0, updated: 0, failed: 0, notApplied: requestRows.length },
        rowDetails: { included: 0, total: requestRows.length, omitted: requestRows.length, truncated: requestRows.length > 0 },
        rows: [],
      });
      setStep('result');
    } finally {
      setBusyTask(null);
    }
  };

  const renderRowDetails = (row: ProductPriceWorkbookPreviewRow) => {
    const messages = rowErrors(row);
    return (
      <>
        <span className="font-mono text-xs font-bold text-[var(--color-blue)]">{row.sku}</span>
        <span className="mt-1 block font-extrabold">{row.name || row.productId || `엑셀 ${row.rowNumber}행`}</span>
        <span className="mt-1 block text-xs text-slate-600">{row.priceMonth} · 단가버전 {row.expectedVersion}</span>
        <span className="mt-1 block text-xs text-slate-600">원본 {row.expectedSourceMonth ?? '기본단가'} · 원본버전 {row.expectedSourceVersion}</span>
        <span className="mt-2 grid gap-1 text-[11px] leading-5 text-slate-700 sm:grid-cols-3">
          {previewPriceGroups.map((group) => (
            <span key={group.label} className="rounded-md bg-slate-100 px-2 py-1">
              <strong className="block text-slate-900">{group.label}</strong>
              {group.fields.map(({ field, label }) => `${label} ${row.prices[field].toLocaleString('ko-KR')}원`).join(' · ')}
            </span>
          ))}
        </span>
        {messages.length > 0 ? <p className="mt-2 text-xs font-semibold leading-5 text-red-800">{messages.join(' ')}</p> : null}
      </>
    );
  };

  const title = step === 'result' ? '월별 단가 일괄 처리 결과' : '월별 상품 단가 Excel 수정';
  const description = step === 'file'
    ? `${selectedMonthLabel} 상품 단가를 한 파일에 최대 ${PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}건까지 수정합니다.`
    : `${selectedMonthLabel} 단가를 서버에서 다시 검증하며, 한 행이라도 실패하면 저장하지 않습니다.`;
  const busyMessage = busyTask === 'download'
    ? '선택월의 전체 상품 단가 파일을 생성하는 중입니다.'
    : busyTask === 'parse'
      ? '엑셀 파일을 읽고 10,000행까지 검증하는 중입니다.'
      : '월별 상품 단가를 서버에 일괄 적용하는 중입니다. 창을 닫지 마세요.';

  return (
    <AccessibleModal
      open={open}
      title={title}
      description={description}
      busy={busy}
      dismissOnBackdrop={!busy}
      fallbackFocusSelector="#product-price-import-button"
      onRequestClose={requestClose}
      size="large"
    >
      <div className="flex min-h-0 flex-1 flex-col" aria-busy={busy || undefined}>
        <div className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-3 sm:px-6">
          <ol aria-label="월별 단가 엑셀 가져오기 단계" className="grid grid-cols-4 gap-2">
            {stepLabels.map((item, index) => {
              const currentIndex = stepLabels.findIndex((stepItem) => stepItem.id === step);
              const complete = index < currentIndex || step === 'result' && Boolean(result?.ok) && index < 3;
              const current = item.id === step;
              return (
                <li key={item.id} aria-current={current ? 'step' : undefined} className={`min-w-0 rounded-[var(--ss-radius-sm)] px-2 py-1.5 text-center text-xs font-semibold ${current ? 'bg-[var(--ss-brand)] text-[var(--ss-on-brand)]' : complete ? 'bg-[var(--ss-success-soft)] text-[var(--ss-success)]' : 'text-[var(--ss-text-muted)]'}`}>
                  <span aria-hidden="true">{index + 1}. </span>{item.label}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 px-5 py-5 sm:px-6">
          <h3 ref={stageHeadingRef} tabIndex={-1} className="text-base font-semibold outline-none">
            {step === 'file' ? '1. 수정 목록 내려받기·선택' : step === 'preview' ? '2. 미리보기와 오류 확인' : step === 'confirm' ? '3. 적용 내용 확인' : '4. 처리 결과'}
          </h3>
          {busy ? <p role="status" aria-live="polite" className="mt-4 flex items-center gap-2 rounded-xl bg-blue-50 p-4 text-sm font-semibold text-blue-950"><LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={18} />{busyMessage}</p> : null}

          {step === 'file' ? (
            <div className="mt-4 space-y-5">
              <div className="rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] p-4 text-sm leading-6 text-[var(--ss-text-subtle)]">
                <p><span className="font-extrabold">적용 회사</span> · {tenant}</p>
                <p><span className="font-extrabold">단가 적용월</span> · {selectedMonthLabel}</p>
                <p className="mt-1 text-xs text-[var(--color-muted-ink)]">선택월 직접 저장 {currentPriceSummary.exact.toLocaleString('ko-KR')}건 · 이전 단가 이어받기 {currentPriceSummary.inherited.toLocaleString('ko-KR')}건</p>
                <p className="mt-1 text-xs text-[var(--color-muted-ink)]">상품ID·단가버전·원본단가월·원본단가버전·상품코드·상품명은 변경하지 말고 9개 단가 열만 수정하세요.</p>
              </div>

              {products.length === 0 ? (
                <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-950">내보낼 상품이 없습니다. 상품을 먼저 등록해 주세요.</div>
              ) : updateWorkbookParts === 1 ? (
                <button type="button" disabled={busy} onClick={() => void downloadPart()} className="star-secondary-button w-full px-4 text-sm"><Download aria-hidden="true" size={17} /> {selectedMonthLabel} 수정용 전체 목록</button>
              ) : (
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm font-extrabold text-blue-950">수정 목록이 {updateWorkbookParts}개 파일로 나뉩니다.</p>
                  <p className="mt-1 text-xs leading-5 text-blue-900">브라우저 다운로드 차단을 방지하도록 각 파일을 따로 내려받으세요.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Array.from({ length: updateWorkbookParts }, (_, index) => {
                      const partNumber = index + 1;
                      const firstRow = index * PRODUCT_PRICE_WORKBOOK_MAX_ROWS + 1;
                      const lastRow = Math.min(products.length, partNumber * PRODUCT_PRICE_WORKBOOK_MAX_ROWS);
                      return (
                        <button key={partNumber} type="button" disabled={busy} onClick={() => void downloadPart(partNumber)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-blue-300 bg-white px-4 text-sm font-extrabold text-blue-900 hover:bg-blue-100 disabled:opacity-55">
                          <Download aria-hidden="true" size={16} /> 수정 목록 {partNumber}/{updateWorkbookParts} (상품 {firstRow}~{lastRow})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <input ref={fileInputRef} id="product-price-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-hidden="true" tabIndex={-1} onClick={(event) => { event.currentTarget.value = ''; }} onChange={handleFileChange} className="sr-only" />
              <div className="rounded-[var(--ss-radius-lg)] border-2 border-dashed border-[var(--ss-border-strong)] bg-[var(--ss-surface)] p-6 text-center">
                <FileSpreadsheet aria-hidden="true" className="mx-auto text-[var(--color-blue)]" size={36} />
                <p className="mt-3 font-extrabold">Excel .xlsx 파일을 선택하세요</p>
                <p className="mt-1 text-xs text-[var(--color-muted-ink)]">월별 단가 양식 v{PRODUCT_PRICE_WORKBOOK_SCHEMA_VERSION} · {selectedMonthLabel} · 최대 {PRODUCT_PRICE_WORKBOOK_MAX_ROWS.toLocaleString('ko-KR')}행 · {maxFileSizeMb}MB 이하</p>
                <button data-modal-initial-focus type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} className="star-primary-button mt-4 px-5 text-sm"><Upload aria-hidden="true" size={17} /> 파일 선택</button>
                {file ? <p className="mt-3 text-sm font-bold text-slate-700">선택됨 · {file.name}</p> : null}
              </div>
              {fileError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800"><AlertCircle aria-hidden="true" className="mr-2 inline" size={17} />{fileError}</div> : null}
            </div>
          ) : null}

          {step === 'preview' ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-blue-50 p-3"><p className="text-xs font-bold text-blue-700">선택월 신규 저장</p><p className="mt-1 text-xl font-black text-blue-900">{createCount.toLocaleString('ko-KR')}건</p></div>
                <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs font-bold text-emerald-700">선택월 수정</p><p className="mt-1 text-xl font-black text-emerald-900">{updateCount.toLocaleString('ko-KR')}건</p></div>
                <div className={`rounded-xl p-3 ${errorCount ? 'bg-red-50' : 'bg-slate-100'}`}><p className={`text-xs font-bold ${errorCount ? 'text-red-700' : 'text-slate-600'}`}>오류</p><p className={`mt-1 text-xl font-black ${errorCount ? 'text-red-900' : 'text-slate-900'}`}>{errorCount.toLocaleString('ko-KR')}건</p></div>
              </div>
              {errorCount > 0 ? (
                <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 outline-none">
                  <p className="font-extrabold text-red-900">적용 전에 {errorCount.toLocaleString('ko-KR')}개 오류를 수정해 주세요.</p>
                  <ul className="mt-2 space-y-1 text-sm text-red-800">
                    {errorSamples.slice(0, 5).map((error, index) => <li key={`${error.rowNumber}-${index}`}>{error.rowNumber > 0 ? <button type="button" onClick={() => focusRow(error.rowNumber)} className="text-left underline decoration-red-400 underline-offset-2">{error.rowNumber}행 · {error.message}</button> : <span>{error.message}</span>}</li>)}
                  </ul>
                </div>
              ) : <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-900"><CheckCircle2 aria-hidden="true" className="mr-2 inline" size={17} />{selectedMonthLabel} 단가 {rows.length.toLocaleString('ko-KR')}개 행을 적용할 수 있습니다.</p>}

              <div className="space-y-3 lg:hidden" aria-label="월별 상품 단가 가져오기 행 미리보기">
                {visibleRows.map((row) => <article key={row.rowNumber} id={`product-price-import-row-${row.rowNumber}-mobile`} tabIndex={-1} className={`rounded-xl border p-4 outline-none ${rowErrors(row).length ? 'border-red-200 bg-red-50' : 'border-[var(--color-border)] bg-white'}`}><p className="text-xs font-bold text-[var(--color-muted-ink)]">{row.rowNumber}행 · {row.expectedVersion === 0 ? '선택월 신규 저장' : '선택월 수정'}</p>{renderRowDetails(row)}</article>)}
              </div>
              <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-border)] lg:block">
                <table className="erp-table min-w-[1080px]">
                  <caption className="sr-only">월별 상품 단가 엑셀 미리보기</caption>
                  <thead><tr><th scope="col">행</th><th scope="col">적용</th><th scope="col">상품·단가</th><th scope="col">상품ID</th><th scope="col">검증</th></tr></thead>
                  <tbody>{visibleRows.map((row) => <tr key={row.rowNumber} id={`product-price-import-row-${row.rowNumber}-desktop`} tabIndex={-1} className={rowErrors(row).length ? 'bg-red-50' : undefined}><td>{row.rowNumber}</td><td>{row.expectedVersion === 0 ? '신규' : '수정'}</td><td>{renderRowDetails(row)}</td><td><span className="block max-w-[180px] truncate font-mono text-xs">{row.productId}</span></td><td>{rowErrors(row).length ? <span className="font-semibold text-red-800">오류 {rowErrors(row).length}건</span> : <span className="font-semibold text-emerald-700">통과</span>}</td></tr>)}</tbody>
                </table>
              </div>
              {rows.length > visibleRows.length ? <p className="rounded-xl bg-slate-100 px-4 py-3 text-xs leading-5 text-slate-700">브라우저 성능 보호를 위해 전체 {rows.length.toLocaleString('ko-KR')}행 중 처음 {Math.min(rows.length, previewRowLimit).toLocaleString('ko-KR')}행과 오류 표본만 표시합니다. 적용 시에는 모든 행을 처리합니다.</p> : null}
            </div>
          ) : null}

          {step === 'confirm' ? (
            <div className="mt-4 space-y-4">
              <div className="rounded-[var(--ss-radius-lg)] bg-[var(--ss-emphasis)] p-5 text-[var(--ss-on-emphasis)]"><p className="text-xs font-medium tracking-wide text-[var(--ss-neutral-300)]">MONTHLY PRICE BULK UPDATE</p><p className="mt-2 text-lg font-semibold">{tenant} 회사의 {selectedMonthLabel} 단가 {rows.length.toLocaleString('ko-KR')}개 행을 적용합니다.</p><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-[var(--ss-neutral-300)]">선택월 신규 저장</dt><dd className="mt-1 text-xl font-bold">{createCount.toLocaleString('ko-KR')}건</dd></div><div><dt className="text-[var(--ss-neutral-300)]">선택월 수정</dt><dd className="mt-1 text-xl font-bold">{updateCount.toLocaleString('ko-KR')}건</dd></div></dl></div>
              {!scopeMatches ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-900"><AlertCircle aria-hidden="true" className="mr-2 inline" size={17} />파일을 읽은 뒤 회사 또는 단가 적용월이 바뀌었습니다. 현재 목록을 다시 내려받아 주세요.</div> : null}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><AlertCircle aria-hidden="true" className="mr-2 inline" size={17} />서버가 회사 경계, 적용월, 상품ID, 현재 단가 버전, 이어받은 원본 월·버전과 9개 가격을 다시 확인합니다. 한 행이라도 실패하면 이 파일의 변경은 저장되지 않습니다.</div>
            </div>
          ) : null}

          {step === 'result' && result ? (
            <div className="mt-4 space-y-4">
              <div role={result.ok ? 'status' : 'alert'} className={`rounded-2xl p-5 ${result.ok ? 'bg-emerald-50 text-emerald-950' : 'bg-red-50 text-red-950'}`}>
                {result.ok ? <CheckCircle2 aria-hidden="true" className="inline" size={22} /> : <AlertCircle aria-hidden="true" className="inline" size={22} />}
                <p className="mt-2 text-lg font-black">{result.ok ? '월별 단가 일괄 처리가 완료되었습니다.' : '월별 단가를 일괄 처리하지 못했습니다.'}</p>
                <p className="mt-1 text-sm leading-6">{result.message}</p>
                {result.ok ? <p className="mt-3 text-sm font-bold">선택월 신규 저장 {result.summary.created.toLocaleString('ko-KR')}건 · 수정 {result.summary.updated.toLocaleString('ko-KR')}건</p> : null}
              </div>
              {resultErrorSummary.failedRows > 0 || resultErrorSummary.notAppliedRows > 0 ? <div className="rounded-xl border border-red-200 bg-white p-4"><p className="font-extrabold text-red-900">일괄 처리 실패 {resultErrorSummary.failedRows.toLocaleString('ko-KR')}행{resultErrorSummary.notAppliedRows > 0 ? ` · 함께 미적용 ${resultErrorSummary.notAppliedRows.toLocaleString('ko-KR')}행` : ''}</p>{resultErrorSummary.samples.length > 0 ? <ul className="mt-2 space-y-2 text-sm text-red-800">{resultErrorSummary.samples.map((error, index) => <li key={`${error.rowNumber}-${index}`}>{error.rowNumber}행{error.field ? ` · ${error.field}` : ''} · {error.message}</li>)}</ul> : null}{resultErrorSummary.messageCount > resultErrorSummary.samples.length ? <p className="mt-3 text-xs font-semibold text-red-700">오류 메시지는 처음 {resultErrorSummary.samples.length.toLocaleString('ko-KR')}건만 표시합니다.</p> : null}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="sticky bottom-0 flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          {step === 'file' ? <button type="button" disabled={busy} onClick={requestClose} className="star-secondary-button px-5 text-sm">취소</button> : null}
          {step === 'preview' ? <><button type="button" disabled={busy} onClick={() => setStep('file')} className="star-secondary-button px-5 text-sm">파일 바꾸기</button><button type="button" disabled={busy || errorCount > 0 || requestRows.length === 0 || requestRows.length !== rows.length} onClick={() => setStep('confirm')} className="star-primary-button px-5 text-sm">{errorCount || requestRows.length !== rows.length ? '오류를 수정해 주세요' : `${rows.length.toLocaleString('ko-KR')}건 적용 확인`}</button></> : null}
          {step === 'confirm' ? <><button type="button" disabled={busy} onClick={() => setStep('preview')} className="star-secondary-button px-5 text-sm">미리보기로</button><button type="button" disabled={busy || !scopeMatches} onClick={() => void submit()} className="star-primary-button px-5 text-sm">{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : null} {selectedMonthLabel} 단가 일괄 적용</button></> : null}
          {step === 'result' ? <><button type="button" onClick={reset} className="star-secondary-button px-5 text-sm">다른 파일 선택</button>{!result?.ok ? <button type="button" onClick={() => setStep('confirm')} className="star-secondary-button px-5 text-sm text-[var(--ss-info)]">같은 파일 다시 시도</button> : null}<button type="button" data-modal-initial-focus onClick={requestClose} className="star-primary-button px-5 text-sm">목록으로 돌아가기</button></> : null}
        </div>
      </div>
    </AccessibleModal>
  );
}
