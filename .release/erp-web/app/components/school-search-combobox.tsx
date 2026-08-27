'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  bidProvinceOptions,
  isBidAreaCode,
  isBidProvinceCode,
  type BidAreaCode,
  type BidProvinceCode,
} from '../lib/bid-regions';
import type { TenantCode } from '../lib/erp-types';

export interface SchoolSearchOption {
  id: string;
  schoolCode: string;
  name: string;
  schoolLevel: string;
  foundationType: string;
  roadAddress: string;
  provinceCode: string;
  areaCode: BidAreaCode;
  areaLabel: string;
}

export interface SchoolSearchComboboxProps {
  tenant: TenantCode;
  value: SchoolSearchOption | null;
  disabled?: boolean;
  error?: string | null;
  onChange: (option: SchoolSearchOption | null) => void;
}

interface SchoolSearchResponse {
  items: SchoolSearchOption[];
  total: number;
  limit: number;
}

interface SearchResultState extends SchoolSearchResponse {
  signature: string;
}

const minimumQueryLength = 2;
const maximumResults = 20;
const provinceCodeSet = new Set<string>(bidProvinceOptions.map((province) => province.code));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSchoolSearchOption(value: unknown): SchoolSearchOption {
  if (!isRecord(value)) throw new Error('학교 검색 결과 형식이 올바르지 않습니다.');

  if (
    typeof value.id !== 'string'
    || typeof value.schoolCode !== 'string'
    || typeof value.name !== 'string'
    || typeof value.schoolLevel !== 'string'
    || typeof value.foundationType !== 'string'
    || typeof value.roadAddress !== 'string'
    || typeof value.provinceCode !== 'string'
    || typeof value.areaCode !== 'string'
    || typeof value.areaLabel !== 'string'
  ) {
    throw new Error('학교 검색 결과 형식이 올바르지 않습니다.');
  }
  if (
    value.id.trim().length === 0
    || value.schoolCode.trim().length === 0
    || value.name.trim().length === 0
    || value.areaLabel.trim().length === 0
    || !provinceCodeSet.has(value.provinceCode)
    || !isBidAreaCode(value.areaCode)
  ) {
    throw new Error('학교 검색 결과에 유효하지 않은 값이 있습니다.');
  }

  return {
    id: value.id,
    schoolCode: value.schoolCode,
    name: value.name,
    schoolLevel: value.schoolLevel,
    foundationType: value.foundationType,
    roadAddress: value.roadAddress,
    provinceCode: value.provinceCode,
    areaCode: value.areaCode,
    areaLabel: value.areaLabel,
  };
}

function parseSchoolSearchResponse(value: unknown): SchoolSearchResponse {
  if (
    !isRecord(value)
    || !Array.isArray(value.items)
    || !Number.isInteger(value.total)
    || Number(value.total) < 0
    || !Number.isInteger(value.limit)
    || Number(value.limit) < 1
    || Number(value.limit) > maximumResults
    || value.items.length > Number(value.limit)
  ) {
    throw new Error('학교 검색 응답 형식이 올바르지 않습니다.');
  }

  const items = value.items.map(parseSchoolSearchOption);
  if (Number(value.total) < items.length) {
    throw new Error('학교 검색 응답 건수가 올바르지 않습니다.');
  }
  return { items, total: Number(value.total), limit: Number(value.limit) };
}

function schoolMetadata(school: SchoolSearchOption) {
  return [
    school.schoolLevel,
    school.foundationType,
  ].filter(Boolean).join(' · ');
}

function schoolAddress(school: SchoolSearchOption) {
  return school.roadAddress || school.areaLabel;
}

export function SchoolSearchCombobox({
  tenant,
  value,
  disabled = false,
  error = null,
  onChange,
}: SchoolSearchComboboxProps) {
  const generatedId = useId();
  const inputId = `${generatedId}-input`;
  const helpId = `${generatedId}-help`;
  const fieldErrorId = `${generatedId}-field-error`;
  const popupId = `${generatedId}-popup`;
  const listboxId = `${generatedId}-listbox`;
  const resultStatusId = `${generatedId}-result-status`;

  const inputRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);
  const [query, setQuery] = useState('');
  const [provinceCode, setProvinceCode] = useState<BidProvinceCode | ''>('');
  const [isChanging, setIsChanging] = useState(false);
  const [selectionBeingChanged, setSelectionBeingChanged] = useState<SchoolSearchOption | null>(null);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [resultState, setResultState] = useState<SearchResultState | null>(null);
  const [loadingSignature, setLoadingSignature] = useState<string | null>(null);
  const [requestErrorState, setRequestErrorState] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);

  const summaryValue = value ?? (isChanging ? selectionBeingChanged : null);
  const searchVisible = value === null || isChanging;
  const trimmedQuery = query.trim();
  const queryReady = trimmedQuery.length >= minimumQueryLength;
  const searchSignature = `${tenant}\u0000${trimmedQuery}\u0000${provinceCode}\u0000${retryRevision}`;
  const activeResult = resultState?.signature === searchSignature ? resultState : null;
  const requestError = requestErrorState?.signature === searchSignature
    ? requestErrorState.message
    : null;
  const loading = loadingSignature === searchSignature;
  const pending = queryReady && activeResult === null && requestError === null;
  const items = useMemo(() => activeResult?.items ?? [], [activeResult]);
  const popupVisible = searchVisible && !disabled && open && queryReady;
  const selectedMetadata = summaryValue ? schoolMetadata(summaryValue) : '';
  const inputDescribedBy = [helpId, error ? fieldErrorId : null]
    .filter(Boolean)
    .join(' ');

  const optionIds = useMemo(
    () => items.map((school, index) => `${generatedId}-option-${school.schoolCode}-${index}`),
    [generatedId, items],
  );
  const activeDescendant = popupVisible && highlightedIndex >= 0
    ? optionIds[highlightedIndex]
    : undefined;

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (!searchVisible || disabled || !queryReady) return undefined;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoadingSignature(searchSignature);
      setRequestErrorState(null);
      const parameters = new URLSearchParams({ tenant, q: trimmedQuery });
      if (provinceCode) parameters.set('provinceCode', provinceCode);

      void (async () => {
        try {
          const response = await fetch(`/api/erp/schools/search?${parameters.toString()}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          const decoded: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const message = isRecord(decoded) && typeof decoded.message === 'string'
              ? decoded.message
              : `학교 검색 API ${response.status}`;
            throw new Error(message);
          }
          const parsed = parseSchoolSearchResponse(decoded);
          if (sequence === requestSequence.current) {
            setResultState({ signature: searchSignature, ...parsed });
          }
        } catch (searchError) {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          setRequestErrorState({
            signature: searchSignature,
            message: searchError instanceof Error
              ? searchError.message
              : '학교 정보를 불러오지 못했습니다.',
          });
        } finally {
          if (sequence === requestSequence.current) {
            setLoadingSignature((current) => current === searchSignature ? null : current);
          }
        }
      })();
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    disabled,
    provinceCode,
    queryReady,
    searchSignature,
    searchVisible,
    tenant,
    trimmedQuery,
  ]);

  useEffect(() => {
    if (highlightedIndex < 0) return;
    document.getElementById(optionIds[highlightedIndex] ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, optionIds]);

  function startChanging() {
    if (disabled || !value) return;
    setSelectionBeingChanged(value);
    setIsChanging(true);
    onChange(null);
    setQuery('');
    setProvinceCode(isBidProvinceCode(value.provinceCode) ? value.provinceCode : '');
    setHighlightedIndex(-1);
    setOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelChanging() {
    if (selectionBeingChanged) onChange(selectionBeingChanged);
    setSelectionBeingChanged(null);
    setIsChanging(false);
    setQuery('');
    setHighlightedIndex(-1);
    setOpen(false);
  }

  function selectSchool(school: SchoolSearchOption) {
    if (disabled) return;
    onChange(school);
    setSelectionBeingChanged(null);
    setIsChanging(false);
    setQuery('');
    setHighlightedIndex(-1);
    setOpen(false);
  }

  function retrySearch() {
    if (disabled) return;
    setHighlightedIndex(-1);
    setOpen(true);
    setRetryRevision((revision) => revision + 1);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!popupVisible) {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && queryReady) {
        event.preventDefault();
        setOpen(true);
        if (items.length > 0) {
          setHighlightedIndex(event.key === 'ArrowDown' ? 0 : items.length - 1);
        }
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setHighlightedIndex(-1);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setHighlightedIndex(-1);
      return;
    }
    if (items.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((current) => current < 0 ? 0 : (current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((current) => current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightedIndex(items.length - 1);
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      selectSchool(items[highlightedIndex]);
    }
  }

  return (
    <div className="w-full min-w-0">
      {summaryValue ? (
        <div className="rounded-[var(--ss-radius-lg)] border border-[var(--ss-success-border)] bg-[var(--ss-success-soft)] p-4">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[var(--ss-success-strong)]">{isChanging ? '변경 전 학교' : '선택한 학교'}</p>
              <p className="mt-1 break-words text-base font-bold text-[var(--ss-text)]">{summaryValue.name}</p>
              {selectedMetadata ? <p className="mt-1 break-words text-xs text-[var(--ss-text-subtle)]">{selectedMetadata}</p> : null}
              <p className="mt-2 break-words text-sm font-semibold text-[var(--ss-text-soft)]">{summaryValue.areaLabel}</p>
              <p className="mt-1 break-words text-sm leading-5 text-[var(--ss-text-subtle)]">{schoolAddress(summaryValue)}</p>
              <p className="mt-2 break-all text-xs text-[var(--ss-text-muted)]">교육부 학교코드 {summaryValue.schoolCode}</p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={isChanging ? cancelChanging : startChanging}
              className="star-secondary-button w-full shrink-0 px-4 text-sm sm:w-auto"
            >
              {isChanging ? '변경 취소' : '다른 학교 선택'}
            </button>
          </div>
        </div>
      ) : null}

      {searchVisible ? (
        <div className={summaryValue ? 'mt-4' : ''}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
            <div className="min-w-0">
              <label htmlFor={`${generatedId}-province`} className="mb-1.5 block text-sm font-semibold text-[var(--ss-text)]">
                시·도
              </label>
              <select
                id={`${generatedId}-province`}
                value={provinceCode}
                disabled={disabled}
                onChange={(event) => {
                  const nextProvinceCode = event.target.value;
                  setProvinceCode(isBidProvinceCode(nextProvinceCode) ? nextProvinceCode : '');
                  setHighlightedIndex(-1);
                  setOpen(true);
                }}
                className="star-control min-h-11 w-full min-w-0 px-3 text-sm disabled:cursor-not-allowed disabled:bg-[var(--ss-surface-subtle)]"
              >
                <option value="">전국</option>
                {bidProvinceOptions.map((province) => (
                  <option key={province.code} value={province.code}>{province.label}</option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-[var(--ss-text)]">
                학교 검색
              </label>
              <input
                ref={inputRef}
                id={inputId}
                type="search"
                value={query}
                disabled={disabled}
                role="combobox"
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={popupVisible}
                aria-controls={popupVisible ? listboxId : undefined}
                aria-activedescendant={activeDescendant}
                aria-describedby={inputDescribedBy || undefined}
                aria-invalid={Boolean(error)}
                placeholder="예: 한빛초등학교, 종로구"
                onFocus={() => {
                  if (queryReady) setOpen(true);
                }}
                onBlur={() => {
                  window.setTimeout(() => {
                    if (!document.getElementById(popupId)?.contains(document.activeElement)) {
                      setOpen(false);
                      setHighlightedIndex(-1);
                    }
                  }, 0);
                }}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(-1);
                  setOpen(true);
                }}
                onKeyDown={handleKeyDown}
                className="star-control min-h-11 w-full min-w-0 px-3 text-sm placeholder:text-[var(--ss-text-muted)] disabled:cursor-not-allowed disabled:bg-[var(--ss-surface-subtle)]"
              />
            </div>
          </div>

          <p id={helpId} className="mt-2 text-xs leading-5 text-[var(--ss-text-subtle)]">
            교육부 공식 학교정보의 학교명 또는 주소를 2자 이상 입력하세요. 목록에 없는 이름은 직접 입력할 수 없습니다.
          </p>

          {popupVisible ? (
            <div
              id={popupId}
              className="mt-2 min-w-0 overflow-hidden rounded-[var(--ss-radius-lg)] border border-[var(--ss-border-strong)] bg-[var(--ss-surface)] shadow-[var(--ss-shadow-md)]"
            >
              {activeResult && items.length > 0 ? (
                <p id={resultStatusId} role="status" aria-live="polite" className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ss-text-subtle)]">
                  {activeResult.total.toLocaleString('ko-KR')}개 중 {items.length.toLocaleString('ko-KR')}개 표시
                  {activeResult.total > activeResult.limit ? ` · 상위 ${activeResult.limit}개` : ''}
                </p>
              ) : null}
              <ul
                id={listboxId}
                role="listbox"
                aria-label="학교 검색 결과"
                aria-busy={loading || pending}
                aria-describedby={activeResult && items.length > 0 ? resultStatusId : undefined}
                className={items.length > 0
                  ? 'max-h-72 min-w-0 overflow-y-auto overscroll-contain p-1'
                  : 'm-0 h-0 list-none overflow-hidden p-0'}
              >
                {items.map((school, index) => {
                  const metadata = schoolMetadata(school);
                  const highlighted = highlightedIndex === index;
                  return (
                    <li key={school.schoolCode} role="presentation" className="min-w-0">
                      <button
                        id={optionIds[index]}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={highlighted}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => selectSchool(school)}
                        className={`min-h-11 w-full min-w-0 rounded-[var(--ss-radius-md)] px-3 py-3 text-left transition ${
                          highlighted
                            ? 'bg-[var(--ss-brand-soft)] text-[var(--ss-text)]'
                            : 'bg-[var(--ss-surface)] text-[var(--ss-text)] hover:bg-[var(--ss-surface-hover)]'
                        }`}
                      >
                        <span className="block break-words text-sm font-bold">{school.name}</span>
                        {metadata ? <span className="mt-1 block break-words text-xs text-[var(--ss-text-subtle)]">{metadata}</span> : null}
                        <span className="mt-1 block break-words text-xs font-semibold text-[var(--ss-text-soft)]">{school.areaLabel}</span>
                        <span className="mt-1 block break-words text-xs leading-5 text-[var(--ss-text-subtle)]">{schoolAddress(school)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {items.length === 0 ? (
                <div className="px-4 py-4">
                  {requestError ? (
                    <div role="alert" className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="min-w-0 break-words text-sm font-semibold text-[var(--ss-danger)]">{requestError}</p>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={retrySearch}
                        className="star-secondary-button w-full shrink-0 px-4 text-sm sm:w-auto"
                      >
                        다시 시도
                      </button>
                    </div>
                  ) : activeResult ? (
                    <p role="status" aria-live="polite" className="text-sm font-semibold text-[var(--ss-text-subtle)]">
                      조건에 맞는 학교가 없습니다. 학교명이나 지역을 다시 확인해 주세요.
                    </p>
                  ) : (
                    <p role="status" aria-live="polite" className="text-sm font-semibold text-[var(--ss-text-subtle)]">
                      {loading ? '학교 정보를 찾는 중입니다…' : pending ? '검색을 준비하고 있습니다…' : '검색어를 입력해 주세요.'}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p id={fieldErrorId} role="alert" className="mt-2 text-xs font-semibold text-[var(--ss-danger)]">{error}</p> : null}
    </div>
  );
}
