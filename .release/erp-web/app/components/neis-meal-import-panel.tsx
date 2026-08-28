'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, RefreshCw, School, Utensils } from 'lucide-react';
import type { ErpData, SchoolBid, TenantCode } from '../lib/erp-types';
import type { NeisMealLookupResult, NeisMealRecord } from '../lib/neis-meal-types';

interface NeisMealImportPanelProps {
  tenant: TenantCode;
  tenantId: ErpData['tenant']['id'];
  schoolBids: SchoolBid[];
}
function koreaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function clampedDate(value: string, bid: SchoolBid) {
  if (value < bid.contractStart) return bid.contractStart;
  if (value > bid.contractEnd) return bid.contractEnd;
  return value;
}

function inclusiveDays(fromDate: string, toDate: string) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseLookupResult(value: unknown): NeisMealLookupResult | null {
  if (!isRecord(value) || value.source !== 'NEIS' || !Array.isArray(value.items)) return null;
  if (!isRecord(value.school) || typeof value.school.name !== 'string') return null;
  return value as unknown as NeisMealLookupResult;
}

function MealCard({ item }: { item: NeisMealRecord }) {
  return (
    <article className="rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--ss-text-muted)]">
            <CalendarDays aria-hidden="true" size={15} /> {item.serviceDate}
          </p>
          <h3 className="mt-1 text-base font-extrabold">{item.mealName}</h3>
          <p className="mt-1 text-xs text-[var(--ss-text-muted)]">{item.schoolName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {item.servings !== null && (
            <span className="status-badge status-neutral">{item.servings.toLocaleString('ko-KR')}식</span>
          )}
          {item.calories && <span className="status-badge status-info">{item.calories}</span>}
        </div>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label={`${item.serviceDate} ${item.mealName} 메뉴`}>
        {item.dishes.map((dish, index) => (
          <li key={`${dish}-${index}`} className="rounded-[var(--ss-radius-md)] bg-[var(--ss-surface-subtle)] px-3 py-2 text-sm font-semibold">
            {dish}
          </li>
        ))}
      </ul>
      {(item.originInfo || item.nutritionInfo) && (
        <details className="mt-4 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-bold">원산지·영양정보 보기</summary>
          <div className="mt-3 grid gap-3 text-xs leading-5 text-[var(--ss-text-muted)] lg:grid-cols-2">
            {item.originInfo && <p className="whitespace-pre-line"><strong className="text-[var(--ss-text)]">원산지</strong><br />{item.originInfo}</p>}
            {item.nutritionInfo && <p className="whitespace-pre-line"><strong className="text-[var(--ss-text)]">영양정보</strong><br />{item.nutritionInfo}</p>}
          </div>
        </details>
      )}
    </article>
  );
}

export function NeisMealImportPanel({ tenant, tenantId, schoolBids }: NeisMealImportPanelProps) {
  const eligibleBids = useMemo(
    () => schoolBids.filter((bid) => (
      bid.bidder.id === tenantId
      && bid.schoolId !== null
      && bid.status !== 'CLOSED'
    )),
    [schoolBids, tenantId],
  );
  const [selectedBidId, setSelectedBidId] = useState(eligibleBids[0]?.id ?? '');
  const today = koreaToday();
  const initialFromDate = eligibleBids[0] ? clampedDate(today, eligibleBids[0]) : today;
  const initialToDate = eligibleBids[0]
    ? clampedDate(addDays(initialFromDate, 6), eligibleBids[0])
    : addDays(initialFromDate, 6);
  const [fromDate, setFromDate] = useState(initialFromDate);
  const [toDate, setToDate] = useState(initialToDate);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NeisMealLookupResult | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  const selectedBid = eligibleBids.find((bid) => bid.id === selectedBidId) ?? eligibleBids[0];
  const selectedDays = inclusiveDays(fromDate, toDate);
  const rangeError = selectedBid && (
    fromDate < selectedBid.contractStart || toDate > selectedBid.contractEnd
  )
    ? `조회 기간은 계약 기간(${selectedBid.contractStart}~${selectedBid.contractEnd}) 안에서 선택해 주세요.`
    : selectedDays !== null && selectedDays < 1
      ? '조회 시작일은 종료일보다 늦을 수 없습니다.'
      : selectedDays !== null && selectedDays > 31
        ? '급식식단정보는 한 번에 최대 31일까지 조회할 수 있습니다.'
        : null;

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  function selectBid(bidId: string) {
    const bid = eligibleBids.find((item) => item.id === bidId);
    setSelectedBidId(bidId);
    if (bid) {
      const nextFrom = clampedDate(fromDate, bid);
      const nextTo = clampedDate(toDate, bid);
      setFromDate(nextFrom);
      setToDate(nextFrom > nextTo ? nextFrom : nextTo);
    }
    setResult(null);
    setError(null);
  }

  function changeFromDate(value: string) {
    setFromDate(value);
    setResult(null);
    setError(null);
  }

  function changeToDate(value: string) {
    setToDate(value);
    setResult(null);
    setError(null);
  }

  async function loadMeals() {
    if (!selectedBid) return;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parameters = new URLSearchParams({
        tenant,
        schoolBidId: selectedBid.id,
        fromDate,
        toDate,
      });
      const response = await fetch(`/api/erp/neis/meals?${parameters}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const decoded: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = isRecord(decoded) && typeof decoded.message === 'string'
          ? decoded.message
          : '급식식단정보를 불러오지 못했습니다.';
        throw new Error(message);
      }
      const parsed = parseLookupResult(decoded);
      if (!parsed) throw new Error('급식식단정보 응답 형식이 올바르지 않습니다.');
      if (activeRequestRef.current !== controller) return;
      setResult(parsed);
    } catch (loadError) {
      if (controller.signal.aborted || activeRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : '급식식단정보를 불러오지 못했습니다.');
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <section className="panel p-5" aria-labelledby="neis-meal-heading" aria-busy={loading}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="eyebrow">NEIS OPEN API</p>
          <h2 id="neis-meal-heading" className="mt-1 flex items-center gap-2 text-base font-extrabold">
            <Utensils aria-hidden="true" size={19} /> 급식식단정보 불러오기
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">
            낙찰 학교의 나이스 식단을 조회합니다. 조회 결과는 확인용이며 내부 확정 식단을 자동 변경하지 않습니다.
          </p>
        </div>
        <a
          href="https://open.neis.go.kr/portal/data/service/selectServicePage.do?infId=OPEN17320190722180924242823&infSeq=2"
          target="_blank"
          rel="noreferrer"
          className="text-xs font-bold text-[var(--color-blue)] underline-offset-4 hover:underline"
        >
          나이스 원본 안내
        </a>
      </div>

      {eligibleBids.length === 0 ? (
        <div className="mt-4 rounded-[var(--ss-radius-lg)] border border-dashed border-[var(--ss-border-strong)] bg-[var(--ss-surface-subtle)] p-5 text-sm text-[var(--ss-text-muted)]">
          <p className="flex items-center gap-2 font-bold text-[var(--ss-text)]"><School aria-hidden="true" size={18} /> 조회 가능한 계약 학교가 없습니다.</p>
          <p className="mt-2 leading-6">학교 입찰 관리에서 학교 마스터가 연결된 낙찰·계약 정보를 먼저 등록해 주세요.</p>
        </div>
      ) : (
        <>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(240px,1.4fr)_minmax(150px,0.7fr)_minmax(150px,0.7fr)_auto] xl:items-end"
            onSubmit={(event) => { event.preventDefault(); void loadMeals(); }}
          >
            <label className="grid gap-1.5 text-xs font-bold">
              계약 학교
              <select
                disabled={loading}
                value={selectedBid?.id ?? ''}
                onChange={(event) => selectBid(event.target.value)}
                className="min-h-11 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] px-3 text-sm outline-none focus:border-[var(--color-blue)] focus:ring-2 focus:ring-[var(--ss-focus-ring)]"
              >
                {eligibleBids.map((bid) => (
                  <option key={bid.id} value={bid.id}>{bid.schoolName} · {bid.bidNo}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-bold">
              시작일
              <input
                type="date"
                disabled={loading}
                required
                min={selectedBid?.contractStart}
                max={selectedBid?.contractEnd}
                value={fromDate}
                onChange={(event) => changeFromDate(event.target.value)}
                className="min-h-11 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] px-3 text-sm outline-none focus:border-[var(--color-blue)] focus:ring-2 focus:ring-[var(--ss-focus-ring)]"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold">
              종료일
              <input
                type="date"
                disabled={loading}
                required
                min={fromDate || selectedBid?.contractStart}
                max={selectedBid?.contractEnd}
                value={toDate}
                onChange={(event) => changeToDate(event.target.value)}
                className="min-h-11 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] px-3 text-sm outline-none focus:border-[var(--color-blue)] focus:ring-2 focus:ring-[var(--ss-focus-ring)]"
              />
            </label>
            <button
              type="submit"
              disabled={
                loading
                || !selectedBid
                || !fromDate
                || !toDate
                || Boolean(rangeError)
              }
              className="star-primary-button min-h-11 min-w-[144px] px-4 text-sm"
            >
              <RefreshCw aria-hidden="true" size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
              {loading ? '불러오는 중' : '식단 불러오기'}
            </button>
          </form>
          {selectedBid && (
            <p className="mt-2 text-[11px] text-[var(--ss-text-muted)]">
              조회 가능 계약 기간: {selectedBid.contractStart}~{selectedBid.contractEnd} · 한 번에 최대 31일
            </p>
          )}
        </>
      )}

      {(rangeError || error) && <p role="alert" className="mt-4 rounded-[var(--ss-radius-md)] border border-[var(--ss-danger-border)] bg-[var(--ss-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--ss-danger-strong)]">{rangeError ?? error}</p>}

      {result && (
        <div className="mt-5" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-extrabold">{result.school.name} · {result.fromDate}~{result.toDate}</p>
            <span className="status-badge status-neutral">총 {result.items.length}건</span>
          </div>
          {result.items.length === 0 ? (
            <p className="mt-3 rounded-[var(--ss-radius-lg)] bg-[var(--ss-surface-subtle)] px-4 py-8 text-center text-sm text-[var(--ss-text-muted)]">선택한 기간에 등록된 급식식단정보가 없습니다.</p>
          ) : (
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {result.items.map((item) => <MealCard key={`${item.serviceDate}-${item.mealCode}-${item.mealName}`} item={item} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
