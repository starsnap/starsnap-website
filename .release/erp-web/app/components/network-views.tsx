'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Gavel,
  Handshake,
  Network,
  ShoppingCart,
} from 'lucide-react';
import type { AuthRole } from '../lib/auth-types';
import {
  bidAreaLabel,
  bidAreaOption,
  bidAreaSummary,
  bidAreasForProvince,
  bidProvinceOptions,
  uniqueBidAreaCodes,
  type BidAreaCode,
  type BidProvinceCode,
} from '../lib/bid-regions';
import type {
  ChannelOrder,
  ChannelOrderStatus,
  ErpData,
  ModuleId,
  NetworkMutation,
  NetworkMutationResult,
  OrganizationType,
  PartnerRelationship,
  PartnerRelationshipStatus,
  SchoolBidStatus,
} from '../lib/erp-types';
import {
  SchoolSearchCombobox,
  type SchoolSearchOption,
} from './school-search-combobox';
import { EatItemSearch } from './eat-item-search';

export interface NetworkViewProps {
  data: ErpData;
  role: AuthRole;
  pendingAction: string | null;
  searchQuery: string;
  onNavigate: (module: ModuleId) => void;
  onMutate: (mutation: NetworkMutation) => Promise<NetworkMutationResult>;
}

type Feedback = { tone: 'success' | 'error'; message: string } | null;

const won = new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: 'KRW',
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat('ko-KR');

const organizationLabels: Record<OrganizationType, string> = {
  BRAND: '브랜드',
  DEALER: '대리점',
  BIDDER: '입찰업체',
};

const relationshipLabels: Record<PartnerRelationship['type'], string> = {
  BRAND_DEALER: '브랜드 · 대리점',
  DEALER_BIDDER: '대리점 · 입찰업체',
};

const partnerStatusLabels: Record<PartnerRelationshipStatus, string> = {
  ACTIVE: '거래 중',
  INACTIVE: '거래 중지',
};

const bidStatusLabels: Record<SchoolBidStatus, string> = {
  AWARDED: '낙찰',
  ACTIVE: '계약 진행',
  CLOSED: '계약 종료',
};

const orderStatusLabels: Record<ChannelOrderStatus, string> = {
  REQUESTED: '요청',
  ACCEPTED: '접수',
  SHIPPED: '출고',
  COMPLETED: '완료',
  REJECTED: '거절',
  CANCELLED: '취소',
};

function includesSearch(value: unknown, query: string) {
  const normalized = query.trim().toLocaleLowerCase('ko-KR');
  return !normalized || JSON.stringify(value).toLocaleLowerCase('ko-KR').includes(normalized);
}

function StatusBadge({ tone, children }: { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`status-badge status-${tone}`}>{children}</span>;
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  const isError = feedback.tone === 'error';
  return (
    <p
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={`rounded-[var(--ss-radius-md)] border px-3 py-2.5 text-sm font-semibold leading-5 ${
        isError
          ? 'border-[var(--ss-danger-border)] bg-[var(--ss-danger-soft)] text-[var(--ss-danger-strong)]'
          : 'border-[var(--ss-success-border)] bg-[var(--ss-success-soft)] text-[var(--ss-success-strong)]'
      }`}
    >
      {feedback.message}
    </p>
  );
}

function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="rounded-[var(--ss-radius-md)] border border-[var(--ss-info-border)] bg-[var(--ss-info-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--ss-info-strong)]">
      {children}
    </div>
  );
}

function EmptyRow({
  columns,
  sourceCount,
  searchQuery,
  emptyMessage,
}: {
  columns: number;
  sourceCount: number;
  searchQuery: string;
  emptyMessage?: string;
}) {
  const message = sourceCount > 0 && searchQuery.trim()
    ? '현재 검색어와 일치하는 항목이 없습니다.'
    : emptyMessage ?? '아직 등록된 항목이 없습니다.';
  return <tr><td colSpan={columns} className="px-5 py-16 text-center text-sm text-[var(--ss-text-muted)]">{message}</td></tr>;
}

function exactBidAreaSummary(codes: readonly BidAreaCode[]) {
  return uniqueBidAreaCodes(codes).map(bidAreaLabel).join(' · ');
}

function compactBidAreaSummary(codes: readonly BidAreaCode[]) {
  return bidAreaSummary(uniqueBidAreaCodes(codes));
}

function toggleAreaCode(current: BidAreaCode[], code: BidAreaCode) {
  const next = new Set<BidAreaCode>(current);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  return uniqueBidAreaCodes([...next]);
}

function AreaMultiPicker({
  id,
  legend,
  description,
  selected,
  disabled,
  error,
  onChange,
}: {
  id: string;
  legend: string;
  description: string;
  selected: BidAreaCode[];
  disabled: boolean;
  error?: string | null;
  onChange: (next: BidAreaCode[]) => void;
}) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const selectedCodes = uniqueBidAreaCodes(selected);
  const [provinceCode, setProvinceCode] = useState<BidProvinceCode | ''>(() => (
    selectedCodes[0] ? bidAreaOption(selectedCodes[0])?.provinceCode ?? '' : ''
  ));
  const provinceAreas = provinceCode ? bidAreasForProvince(provinceCode) : [];
  const selectedInProvince = provinceAreas.filter((area) => selectedCodes.includes(area.code));
  const allInProvinceSelected = provinceAreas.length > 0 && selectedInProvince.length === provinceAreas.length;
  const selectedSummary = compactBidAreaSummary(selectedCodes);

  const toggleCurrentProvince = () => {
    if (!provinceCode) return;
    const provinceAreaCodes = new Set(provinceAreas.map((area) => area.code));
    const next = allInProvinceSelected
      ? selectedCodes.filter((code) => !provinceAreaCodes.has(code))
      : uniqueBidAreaCodes([...selectedCodes, ...provinceAreas.map((area) => area.code)]);
    onChange(next);
  };

  return (
    <fieldset
      disabled={disabled}
      aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ''}`}
      aria-invalid={Boolean(error) || undefined}
      className={disabled ? 'opacity-70' : undefined}
    >
      <legend className="text-sm font-semibold">{legend}</legend>
      <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-[var(--ss-text-muted)]">{description}</p>
      <label htmlFor={`${id}-province`} className="mt-3 block text-xs font-semibold text-[var(--ss-text-soft)]">시·도</label>
      <select
        id={`${id}-province`}
        value={provinceCode}
        onChange={(event) => setProvinceCode(event.target.value as BidProvinceCode | '')}
        className="star-control mt-1.5 min-h-11 w-full px-3 text-sm sm:max-w-sm"
      >
        <option value="">시·도 선택</option>
        {bidProvinceOptions.map((province) => <option key={province.code} value={province.code}>{province.label}</option>)}
      </select>

      {provinceCode ? (
        <div className="mt-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-semibold text-[var(--ss-text-soft)]">시·군·구 선택 · {selectedInProvince.length}/{provinceAreas.length}</p>
            <button
              type="button"
              onClick={toggleCurrentProvince}
              className="star-secondary-button min-h-11 shrink-0 px-3 text-xs"
            >
              {allInProvinceSelected ? '현재 시·도 전체 해제' : '현재 시·도 전체 선택'}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
            {provinceAreas.map((area) => {
              const inputId = `${id}-area-${area.code}`;
              return (
                <label
                  key={area.code}
                  htmlFor={inputId}
                  className={`flex min-h-11 items-center gap-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 py-2 text-sm font-semibold transition has-[:checked]:border-[var(--ss-brand)] has-[:checked]:bg-[var(--ss-brand-soft)] ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:border-[var(--ss-border-strong)]'}`}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={selectedCodes.includes(area.code)}
                    onChange={() => onChange(toggleAreaCode(selectedCodes, area.code))}
                    aria-label={area.fullName}
                    className="h-4 w-4 accent-[var(--ss-brand)]"
                  />
                  <span>{area.localName}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-[var(--ss-radius-md)] bg-[var(--ss-surface-subtle)] px-3 py-3 text-xs font-medium text-[var(--ss-text-muted)]">시·도를 선택하면 해당 시·군·구가 표시됩니다.</p>
      )}
      <p role="status" aria-live="polite" className="mt-3 text-xs font-semibold text-[var(--ss-text-subtle)]">
        선택 {selectedCodes.length}곳
      </p>
      {selectedSummary ? <p className="mt-1 break-words text-xs leading-5 text-[var(--ss-text-muted)]">{selectedSummary}</p> : null}
      {error ? <p id={errorId} role="alert" className="mt-2 text-xs font-semibold text-[var(--ss-danger)]">{error}</p> : null}
    </fieldset>
  );
}

function TablePanel({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="panel overflow-hidden p-0">
      <div className="flex flex-col gap-2 border-b border-[var(--ss-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-extrabold">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">{description}</p>
        </div>
        <span className="status-badge status-neutral w-fit">총 {number.format(count)}건</span>
      </div>
      <p className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-2 text-[11px] font-medium text-[var(--ss-text-muted)] lg:hidden">
        표를 좌우로 밀어 전체 정보를 확인하세요.
      </p>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function organizationFlow(type: OrganizationType) {
  return [
    { type: 'BRAND' as const, label: '브랜드' },
    { type: 'DEALER' as const, label: '대리점' },
    { type: 'BIDDER' as const, label: '입찰업체' },
    { type: null, label: '학교' },
  ].map((item) => ({ ...item, current: item.type === type }));
}

export function NetworkDashboardSummary({ data, onNavigate }: Pick<NetworkViewProps, 'data' | 'onNavigate'>) {
  const { networkMetrics } = data;
  const type = data.tenant.organizationType;
  const partnerLabel = type === 'BRAND' ? '활성 대리점' : type === 'DEALER' ? '활성 거래처' : '활성 대리점';
  const cards = [
    { label: partnerLabel, value: `${number.format(networkMetrics.activePartners)}곳`, detail: '현재 주문 가능한 거래 관계', icon: Handshake, module: 'partners' as ModuleId },
    ...(type === 'BRAND' ? [] : [{ label: '진행 학교 계약', value: `${number.format(networkMetrics.openBids)}건`, detail: '낙찰 또는 계약 진행 상태', icon: Gavel, module: 'bids' as ModuleId }]),
    ...(type === 'BIDDER' ? [] : [{ label: '받은 발주', value: `${number.format(networkMetrics.incomingOrders)}건`, detail: '공급 처리가 필요한 주문', icon: ArrowDownLeft, module: 'channel-orders' as ModuleId }]),
    ...(type === 'BRAND' ? [] : [{ label: '보낸 발주', value: `${number.format(networkMetrics.outgoingOrders)}건`, detail: '상위 거래처에 요청한 주문', icon: ArrowUpRight, module: 'channel-orders' as ModuleId }]),
  ];
  const flow = organizationFlow(type);

  return (
    <section aria-labelledby="network-summary-title" className="space-y-4">
      <div className="flex flex-col gap-1">
        <p className="eyebrow">SUPPLY NETWORK</p>
        <h2 id="network-summary-title" className="text-lg font-extrabold">{organizationLabels[type]} 거래망 요약</h2>
        <p className="text-sm leading-6 text-[var(--ss-text-muted)]">회사 유형에 맞는 거래 관계와 주문 흐름만 표시합니다.</p>
      </div>
      <div className={`grid gap-3 sm:grid-cols-2 ${type === 'BIDDER' ? 'xl:grid-cols-3' : 'xl:grid-cols-4'}`}>
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => onNavigate(card.module)}
              className="group min-h-[116px] rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 text-left shadow-[var(--ss-shadow-sm)] transition hover:-translate-y-0.5 hover:border-[var(--ss-border-strong)] hover:shadow-[var(--ss-shadow-md)]"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-[var(--ss-radius-md)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]"><Icon aria-hidden="true" size={19} /></span>
                <ArrowRight aria-hidden="true" size={17} className="text-[var(--ss-text-muted)] transition group-hover:translate-x-1" />
              </span>
              <span className="mt-3 block text-xs font-semibold text-[var(--ss-text-subtle)]">{card.label}</span>
              <strong className="mt-1 block text-2xl tracking-tight">{card.value}</strong>
              <span className="mt-1 block text-xs leading-5 text-[var(--ss-text-muted)]">{card.detail}</span>
            </button>
          );
        })}
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">ORDER FLOW</p><h3>브랜드에서 학교까지 이어지는 공급 흐름</h3></div>
          <Network aria-hidden="true" size={20} className="text-[var(--ss-brand)]" />
        </div>
        <ol className="grid gap-2 sm:grid-cols-7 sm:items-center" aria-label="공급 단계">
          {flow.map((item, index) => (
            <li key={item.label} className={index < flow.length - 1 ? 'contents' : undefined}>
              <span className={`flex min-h-11 items-center justify-center rounded-[var(--ss-radius-md)] border px-3 text-sm font-bold ${
                item.current
                  ? 'border-[var(--ss-brand)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]'
                  : 'border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] text-[var(--ss-text-subtle)]'
              }`} aria-current={item.current ? 'step' : undefined}>
                {item.label}{item.current ? ' (현재 회사)' : ''}
              </span>
              {index < flow.length - 1 ? <ArrowRight aria-hidden="true" size={17} className="mx-auto rotate-90 text-[var(--ss-text-muted)] sm:rotate-0" /> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function canManageRelationship(data: ErpData, role: AuthRole, relationship: PartnerRelationship) {
  if (role !== 'admin') return false;
  return (data.tenant.organizationType === 'BRAND' && relationship.type === 'BRAND_DEALER')
    || (data.tenant.organizationType === 'DEALER' && relationship.type === 'DEALER_BIDDER');
}

function PartnerForm({ data, role, pendingAction, onMutate }: Pick<NetworkViewProps, 'data' | 'role' | 'pendingAction' | 'onMutate'>) {
  const [partnerCode, setPartnerCode] = useState('');
  const [areaCodes, setAreaCodes] = useState<BidAreaCode[]>([]);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const type = data.tenant.organizationType;
  const busy = pendingAction === 'partner-connect';

  if (role !== 'admin') {
    return (
      <ReadOnlyNotice>
        {role === 'viewer'
          ? '현재 계정은 조회 전용입니다. 업체 연결과 거래 상태는 관리자만 변경할 수 있습니다.'
          : '업체 연결과 거래 상태 변경은 관리자 권한이 필요합니다.'}
      </ReadOnlyNotice>
    );
  }
  if (type === 'BIDDER') {
    return <ReadOnlyNotice>대리점 연결은 거래를 시작한 대리점 관리자가 등록합니다. 연결이 필요하면 해당 대리점에 요청하세요.</ReadOnlyNotice>;
  }

  const partnerTypeLabel = type === 'BRAND' ? '대리점' : '입찰업체';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setAreaError(null);
    const normalizedCode = partnerCode.trim().toUpperCase();
    if (!normalizedCode) {
      setFeedback({ tone: 'error', message: `${partnerTypeLabel} 회사 코드를 입력해 주세요.` });
      return;
    }
    if (type === 'BRAND' && areaCodes.length === 0) {
      const message = '대리점이 담당할 상세 지역을 하나 이상 선택해 주세요.';
      setAreaError(message);
      setFeedback({ tone: 'error', message });
      return;
    }
    try {
      const result = await onMutate({
        tenant: data.tenant.code,
        module: 'partners',
        action: 'connect',
        partnerCode: normalizedCode,
        ...(type === 'BRAND' ? { areaCodes } : {}),
      });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
      if (result.ok) {
        setPartnerCode('');
        setAreaCodes([]);
        setAreaError(null);
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '업체 연결 요청을 처리하지 못했습니다.' });
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-4" aria-labelledby="partner-form-title">
      <div>
        <p className="eyebrow">PARTNER SETUP</p>
        <h2 id="partner-form-title" className="mt-1 text-base font-extrabold">{partnerTypeLabel} 연결</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">상대 회사가 가입할 때 발급받은 회사 코드로 연결합니다.</p>
      </div>
      <div>
        <label htmlFor="network-partner-code" className="mb-1.5 block text-sm font-semibold">{partnerTypeLabel} 회사 코드</label>
        <input
          id="network-partner-code"
          value={partnerCode}
          onChange={(event) => setPartnerCode(event.target.value.toUpperCase())}
          className="star-control w-full px-3 text-sm uppercase"
          autoComplete="off"
          placeholder={type === 'BRAND' ? '예: SAEBOM' : '예: HANBIT'}
          disabled={busy}
          required
        />
      </div>
      {type === 'BRAND' ? (
        <div className="space-y-2">
          <AreaMultiPicker
            id="network-partner-areas"
            legend="담당 지역"
            description="시·도를 고른 뒤 이 대리점이 학교 발주를 공급할 수 있는 시·군·구를 모두 선택하세요. 다른 시·도로 이동해도 기존 선택은 유지됩니다."
            selected={areaCodes}
            disabled={busy}
            error={areaError}
            onChange={(next) => {
              setAreaCodes(next);
              setAreaError(null);
              setFeedback(null);
            }}
          />
          <p className="text-xs leading-5 text-[var(--ss-text-muted)]">활성 상태의 대리점은 한 브랜드에만 지정될 수 있습니다.</p>
        </div>
      ) : null}
      <FeedbackMessage feedback={feedback} />
      <button type="submit" disabled={busy} className="star-primary-button w-full px-4 text-sm">
        {busy ? '연결 중' : `${partnerTypeLabel} 연결`}
      </button>
    </form>
  );
}

function BidderTargetAreaForm({
  data,
  role,
  pendingAction,
  onMutate,
}: Pick<NetworkViewProps, 'data' | 'role' | 'pendingAction' | 'onMutate'>) {
  const [draftAreaCodes, setDraftAreaCodes] = useState<BidAreaCode[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busy = pendingAction === 'bid-target-areas-set';
  const readOnly = role === 'viewer';
  const areaCodes = draftAreaCodes ?? data.bidderTargetAreaCodes;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || busy) return;
    setFeedback(null);
    try {
      const result = await onMutate({
        tenant: data.tenant.code,
        module: 'bid-target-areas',
        action: 'set',
        areaCodes,
      });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
      if (result.ok) setDraftAreaCodes(null);
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '관심지역을 저장하지 못했습니다.' });
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-4" aria-labelledby="bidder-target-areas-title">
      <div>
        <p className="eyebrow">BIDDING AREA</p>
        <h2 id="bidder-target-areas-title" className="mt-1 text-base font-extrabold">입찰 관심지역</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">선택한 지역을 담당하는 연결 대리점만 목록에 표시합니다.</p>
      </div>
      {readOnly ? (
        <ReadOnlyNotice>현재 계정은 조회 전용입니다. 관심지역 변경은 운영자 또는 관리자에게 요청하세요.</ReadOnlyNotice>
      ) : null}
      <AreaMultiPicker
        id="bidder-target-areas"
        legend="학교 입찰 예정 지역"
        description="시·도를 고른 뒤 여러 시·군·구를 선택할 수 있습니다. 다른 시·도로 이동해도 기존 선택은 유지되며, 선택하지 않으면 대리점 목록이 표시되지 않습니다."
        selected={areaCodes}
        disabled={readOnly || busy}
        onChange={(next) => {
          setDraftAreaCodes(next);
          setFeedback(null);
        }}
      />
      {!readOnly ? (
        <>
          <FeedbackMessage feedback={feedback} />
          <button type="submit" disabled={busy} className="star-primary-button w-full px-4 text-sm">
            {busy ? '저장 중' : '관심지역 저장'}
          </button>
        </>
      ) : null}
      <ReadOnlyNotice>대리점 연결은 해당 대리점 관리자가 등록합니다. 새 연결이 필요하면 대리점에 요청하세요.</ReadOnlyNotice>
    </form>
  );
}

export function PartnersView({ data, role, pendingAction, searchQuery, onMutate }: NetworkViewProps) {
  const isBidder = data.tenant.organizationType === 'BIDDER';
  const dealerRelationships = data.partners.filter((item) => item.partner.organizationType === 'DEALER');
  const areaFilteredRows = isBidder
    ? dealerRelationships.filter((item) => item.areaCodes.some((code) => data.bidderTargetAreaCodes.includes(code)))
    : data.partners;
  const rows = areaFilteredRows.filter((item) => includesSearch({
    ...item,
    areaLabel: exactBidAreaSummary(item.areaCodes),
  }, searchQuery));
  const [feedback, setFeedback] = useState<Feedback>(null);
  const targetAreaSummary = compactBidAreaSummary(data.bidderTargetAreaCodes);
  const emptyMessage = !isBidder
    ? undefined
    : data.bidderTargetAreaCodes.length === 0
      ? '입찰 관심지역을 선택해 저장하면 해당 지역을 담당하는 연결 대리점이 표시됩니다.'
      : dealerRelationships.length === 0
        ? '연결된 대리점이 없습니다. 거래할 대리점에 연결 등록을 요청해 주세요.'
        : `설정한 관심지역(${targetAreaSummary})을 담당하는 연결 대리점이 없습니다. 대리점에 담당 지역과 연결 상태 확인을 요청해 주세요.`;

  async function setStatus(item: PartnerRelationship) {
    setFeedback(null);
    const status: PartnerRelationshipStatus = item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      const result = await onMutate({ tenant: data.tenant.code, module: 'partners', action: 'set-status', id: item.id, status });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '거래 상태를 변경하지 못했습니다.' });
    }
  }

  return (
    <div className={`grid gap-4 ${isBidder ? '' : 'xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start'}`}>
      {isBidder ? <BidderTargetAreaForm key={data.tenant.code} data={data} role={role} pendingAction={pendingAction} onMutate={onMutate} /> : null}
      <div className="space-y-3">
        <FeedbackMessage feedback={feedback} />
        <TablePanel
          title={isBidder ? '관심지역 연결 대리점' : '연결 업체'}
          description={isBidder
            ? '설정한 입찰 관심지역과 담당 지역이 겹치는 연결 대리점만 표시합니다.'
            : '브랜드·대리점·입찰업체 사이의 승인된 거래 관계를 확인합니다.'}
          count={rows.length}
        >
          <table className="erp-table min-w-[820px]">
            <thead><tr><th>업체</th><th>업체 유형</th><th>관계</th><th>담당 지역</th><th>상태</th><th className="text-right">관리</th></tr></thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={6}
                  sourceCount={areaFilteredRows.length}
                  searchQuery={searchQuery}
                  emptyMessage={emptyMessage}
                />
              ) : rows.map((item) => {
                const manageable = canManageRelationship(data, role, item);
                const busy = pendingAction === item.id;
                return (
                  <tr key={`${item.type}-${item.id}`}>
                    <td><span className="block font-extrabold">{item.partner.name}</span><span className="mt-1 block font-mono text-xs text-[var(--ss-text-muted)]">{item.partner.code}</span></td>
                    <td>{organizationLabels[item.partner.organizationType]}</td>
                    <td>{relationshipLabels[item.type]}</td>
                    <td>
                      {item.areaCodes.length > 0 ? compactBidAreaSummary(item.areaCodes) : (
                        <span className="block">
                          <span className="block font-bold text-[var(--ss-warning-strong)]">상세 지역 미설정</span>
                          {item.region ? <span className="mt-1 block text-xs text-[var(--ss-text-muted)]">기존 입력: {item.region}</span> : null}
                        </span>
                      )}
                    </td>
                    <td><StatusBadge tone={item.status === 'ACTIVE' ? 'success' : 'neutral'}>{partnerStatusLabels[item.status]}</StatusBadge></td>
                    <td className="text-right">
                      {manageable ? (
                        <button type="button" disabled={busy} onClick={() => void setStatus(item)} className="star-secondary-button px-3 text-xs">
                          {busy ? '처리 중' : item.status === 'ACTIVE' ? '거래 중지' : '거래 재개'}
                        </button>
                      ) : <span className="text-xs font-medium text-[var(--ss-text-muted)]">조회 전용</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TablePanel>
      </div>
      {!isBidder ? <PartnerForm key={data.tenant.code} data={data} role={role} pendingAction={pendingAction} onMutate={onMutate} /> : null}
    </div>
  );
}

function BidForm({ data, pendingAction, onMutate }: Pick<NetworkViewProps, 'data' | 'pendingAction' | 'onMutate'>) {
  const [bidNo, setBidNo] = useState('');
  const [selectedSchool, setSelectedSchool] = useState<SchoolSearchOption | null>(null);
  const [schoolError, setSchoolError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [awardedAt, setAwardedAt] = useState('');
  const [contractStart, setContractStart] = useState('');
  const [contractEnd, setContractEnd] = useState('');
  const [contractAmount, setContractAmount] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busy = pendingAction === 'bid-create';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setSchoolError(null);
    if (!selectedSchool) {
      const message = '교육부 공식 학교정보에서 학교를 검색해 선택해 주세요.';
      setSchoolError(message);
      setFeedback({ tone: 'error', message });
      return;
    }
    if (![bidNo, title, awardedAt, contractStart, contractEnd, contractAmount].every((value) => value.trim())) {
      setFeedback({ tone: 'error', message: '모든 입찰 계약 정보를 입력해 주세요.' });
      return;
    }
    if (contractStart > contractEnd) {
      setFeedback({ tone: 'error', message: '계약 종료일은 시작일보다 빠를 수 없습니다.' });
      return;
    }
    const amount = Number(contractAmount);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setFeedback({ tone: 'error', message: '계약금액은 0원 이상의 정수로 입력해 주세요.' });
      return;
    }
    try {
      const result = await onMutate({
        tenant: data.tenant.code,
        module: 'bids',
        action: 'create',
        bid: {
          bidNo: bidNo.trim(),
          schoolId: selectedSchool.id,
          title: title.trim(),
          awardedAt,
          contractStart,
          contractEnd,
          contractAmount: amount,
        },
      });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
      if (result.ok) {
        setBidNo('');
        setSelectedSchool(null);
        setSchoolError(null);
        setTitle('');
        setAwardedAt('');
        setContractStart('');
        setContractEnd('');
        setContractAmount('');
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '입찰 계약을 등록하지 못했습니다.' });
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-4" aria-labelledby="bid-form-title">
      <div><p className="eyebrow">SCHOOL CONTRACT</p><h2 id="bid-form-title" className="mt-1 text-base font-extrabold">학교 낙찰 계약 등록</h2><p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">낙찰이 확정된 학교 계약만 등록하세요.</p></div>
      <label className="block text-sm font-semibold">입찰번호<input value={bidNo} onChange={(event) => setBidNo(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" placeholder="예: 2026-동부-001" disabled={busy} required /></label>
      <SchoolSearchCombobox
        tenant={data.tenant.code}
        value={selectedSchool}
        disabled={busy}
        error={schoolError}
        onChange={(school) => {
          setSelectedSchool(school);
          setSchoolError(null);
          setFeedback(null);
        }}
      />
      <label className="block text-sm font-semibold">계약명<input value={title} onChange={(event) => setTitle(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" placeholder="예: 2026학년도 급식 식재료 납품" disabled={busy} required /></label>
      <p className="text-xs leading-5 text-[var(--ss-text-muted)]">학교 주소의 시·도·시군구·일반구가 자동 적용되며, 발주할 때 이 지역을 담당하는 활성 대리점만 선택할 수 있습니다.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-semibold">낙찰일<input type="date" value={awardedAt} onChange={(event) => setAwardedAt(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" disabled={busy} required /></label>
        <label className="text-sm font-semibold">계약 시작일<input type="date" value={contractStart} onChange={(event) => setContractStart(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" disabled={busy} required /></label>
        <label className="text-sm font-semibold">계약 종료일<input type="date" value={contractEnd} onChange={(event) => setContractEnd(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" disabled={busy} required /></label>
      </div>
      <label className="block text-sm font-semibold">계약금액 (원)<input type="number" min="0" step="1" inputMode="numeric" value={contractAmount} onChange={(event) => setContractAmount(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" placeholder="0" disabled={busy} required /></label>
      <FeedbackMessage feedback={feedback} />
      <button type="submit" disabled={busy} className="star-primary-button w-full px-4 text-sm">{busy ? '등록 중' : '낙찰 계약 등록'}</button>
    </form>
  );
}

export function SchoolBidsView({ data, role, pendingAction, searchQuery, onMutate }: NetworkViewProps) {
  const rows = data.schoolBids.filter((item) => includesSearch(item, searchQuery));
  const canCreate = data.tenant.organizationType === 'BIDDER' && role !== 'viewer';
  const sideContent = canCreate
    ? <BidForm key={data.tenant.code} data={data} pendingAction={pendingAction} onMutate={onMutate} />
    : (
      <ReadOnlyNotice>
        {role === 'viewer'
          ? '현재 계정은 조회 전용입니다. 입찰 계약 등록은 운영자 또는 관리자에게 요청하세요.'
          : data.tenant.organizationType === 'DEALER'
            ? '연결된 입찰업체가 등록한 학교 낙찰 계약을 조회할 수 있습니다.'
            : '학교 낙찰 계약은 입찰업체에서 등록합니다.'}
      </ReadOnlyNotice>
    );

  return (
    <div className="space-y-4">
      {data.tenant.organizationType === 'BIDDER' ? <EatItemSearch key={data.tenant.code} tenant={data.tenant.code} /> : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_430px] xl:items-start">
        <TablePanel title="학교 낙찰 계약" description="입찰업체가 낙찰받은 학교와 계약기간·금액을 확인합니다." count={rows.length}>
          <table className="erp-table min-w-[940px]">
          <thead><tr><th>입찰번호</th><th>학교</th><th>계약명</th><th>지역</th><th>계약기간</th><th className="text-right">계약금액</th><th>입찰업체</th><th>상태</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={8} sourceCount={data.schoolBids.length} searchQuery={searchQuery} /> : rows.map((item) => (
              <tr key={item.id}>
                <td className="font-bold text-[var(--ss-info)]">{item.bidNo}</td>
                <td>
                  <span className="block font-extrabold">{item.schoolName}</span>
                  {item.schoolAddress ? <span className="mt-1 block max-w-[280px] text-xs leading-5 text-[var(--ss-text-muted)]">{item.schoolAddress}</span> : null}
                  {!item.schoolId ? <span className="mt-1 block text-xs font-semibold text-[var(--ss-warning-strong)]">기존 수기 등록</span> : null}
                </td>
                <td><span className="block max-w-[260px] truncate">{item.title}</span></td>
                <td>
                  {item.areaCode ? bidAreaLabel(item.areaCode) : (
                    <span className="block">
                      <span className="block font-bold text-[var(--ss-warning-strong)]">상세 지역 미설정</span>
                      {item.region ? <span className="mt-1 block text-xs text-[var(--ss-text-muted)]">기존 입력: {item.region}</span> : null}
                    </span>
                  )}
                </td>
                <td><span className="block whitespace-nowrap">{item.contractStart}</span><span className="block whitespace-nowrap text-xs text-[var(--ss-text-muted)]">~ {item.contractEnd}</span></td>
                <td className="text-right font-black">{won.format(item.contractAmount)}</td>
                <td>{item.bidder.name}</td>
                <td><StatusBadge tone={item.status === 'CLOSED' ? 'neutral' : item.status === 'ACTIVE' ? 'success' : 'info'}>{bidStatusLabels[item.status]}</StatusBadge></td>
              </tr>
            ))}
          </tbody>
          </table>
        </TablePanel>
        {sideContent}
      </div>
    </div>
  );
}

function OrderForm({ data, pendingAction, onMutate }: Pick<NetworkViewProps, 'data' | 'pendingAction' | 'onMutate'>) {
  const type = data.tenant.organizationType;
  const [partnerCode, setPartnerCode] = useState('');
  const [schoolBidId, setSchoolBidId] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [itemCount, setItemCount] = useState('1');
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busy = pendingAction === 'channel-order-create';
  const targetType: OrganizationType = type === 'BIDDER' ? 'DEALER' : 'BRAND';
  const activePartnerOptions = data.partners.filter((item) => item.status === 'ACTIVE' && item.partner.organizationType === targetType);
  const bidOptions = data.schoolBids.filter((item) => item.status === 'AWARDED' || item.status === 'ACTIVE');
  const selectedBid = type === 'BIDDER' ? bidOptions.find((item) => item.id === schoolBidId) : undefined;
  const selectedAreaCode = selectedBid?.areaCode ?? null;
  const selectedAreaLabel = selectedAreaCode ? bidAreaLabel(selectedAreaCode) : null;
  const partnerOptions = type === 'BIDDER'
    ? selectedAreaCode
      ? activePartnerOptions.filter((item) => item.areaCodes.includes(selectedAreaCode))
      : []
    : activePartnerOptions;
  const partnerOptionKey = partnerOptions.map((item) => `${item.type}:${item.id}:${item.partner.code}`).join('|');
  const [previousPartnerOptionKey, setPreviousPartnerOptionKey] = useState(partnerOptionKey);
  if (previousPartnerOptionKey !== partnerOptionKey) {
    setPreviousPartnerOptionKey(partnerOptionKey);
    if (partnerCode && !partnerOptions.some((item) => item.partner.code === partnerCode)) {
      setPartnerCode('');
      setFeedback({
        tone: 'error',
        message: type === 'BIDDER'
          ? '선택한 대리점이 현재 계약의 상세 지역 조건에서 제외되어 선택을 초기화했습니다.'
          : '선택한 브랜드가 더 이상 활성 연결 상태가 아니어서 선택을 초기화했습니다.',
      });
    }
  }
  const partnerHelp = type !== 'BIDDER'
    ? activePartnerOptions.length > 0
      ? `활성 연결 브랜드 ${number.format(activePartnerOptions.length)}곳 중 선택합니다.`
      : '현재 주문 가능한 활성 연결 브랜드가 없습니다.'
    : !schoolBidId
      ? '먼저 학교 낙찰 계약을 선택해 주세요.'
      : !selectedBid
        ? '선택한 학교 계약을 확인할 수 없습니다. 계약을 다시 선택해 주세요.'
        : !selectedBid.areaCode
          ? '선택한 학교 계약에 상세 지역 정보가 없습니다. 학교 입찰 정보를 확인해 주세요.'
          : partnerOptions.length === 0
            ? `${selectedAreaLabel} 지역을 담당하는 활성 연결 대리점이 없습니다.`
            : `${selectedAreaLabel} 지역 담당 활성 연결 대리점 ${number.format(partnerOptions.length)}곳 중 선택합니다.`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (type === 'BIDDER' && !schoolBidId) {
      setFeedback({ tone: 'error', message: '발주에 사용할 학교 낙찰 계약을 선택해 주세요.' });
      return;
    }
    if (type === 'BIDDER' && (!selectedBid || !selectedBid.areaCode)) {
      setFeedback({ tone: 'error', message: '선택한 학교 낙찰 계약의 상세 지역 정보를 확인해 주세요.' });
      return;
    }
    if (partnerCode && !partnerOptions.some((item) => item.partner.code === partnerCode)) {
      setPartnerCode('');
      setFeedback({ tone: 'error', message: `현재 ${type === 'BIDDER' ? '계약 지역을 담당하는 대리점' : '활성 연결 브랜드'}을 다시 선택해 주세요.` });
      return;
    }
    if (!partnerCode || !deliveryDate || !totalAmount || !itemCount) {
      setFeedback({ tone: 'error', message: '발주 대상, 납기일, 금액과 품목 수를 입력해 주세요.' });
      return;
    }
    const amount = Number(totalAmount);
    const count = Number(itemCount);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setFeedback({ tone: 'error', message: '발주금액은 0원 이상의 정수로 입력해 주세요.' });
      return;
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      setFeedback({ tone: 'error', message: '품목 수는 1개 이상의 정수로 입력해 주세요.' });
      return;
    }
    try {
      const result = await onMutate({
        tenant: data.tenant.code,
        module: 'channel-orders',
        action: 'create',
        order: {
          partnerCode,
          ...(type === 'BIDDER' ? { schoolBidId } : {}),
          deliveryDate,
          totalAmount: amount,
          itemCount: count,
          note: note.trim(),
        },
      });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
      if (result.ok) {
        setSchoolBidId('');
        if (type === 'BIDDER') setPartnerCode('');
        setDeliveryDate('');
        setTotalAmount('');
        setItemCount('1');
        setNote('');
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '발주 요청을 등록하지 못했습니다.' });
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-4" aria-labelledby="order-form-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NEW ORDER</p><h2 id="order-form-title">{type === 'BIDDER' ? '대리점 발주 요청' : '브랜드 발주 요청'}</h2><p className="mt-1 text-xs leading-5 text-[var(--ss-text-muted)]">활성 거래 관계가 있는 업체만 선택할 수 있습니다.</p></div>
        <ShoppingCart aria-hidden="true" size={20} className="text-[var(--ss-brand)]" />
      </div>
      {type === 'DEALER' && activePartnerOptions.length === 0 ? <ReadOnlyNotice>현재 주문 가능한 브랜드 연결이 없습니다. 먼저 업체 관계를 확인하세요.</ReadOnlyNotice> : null}
      {type === 'BIDDER' && bidOptions.length === 0 ? <ReadOnlyNotice>발주 가능한 학교 낙찰 계약이 없습니다. 학교 입찰 관리에서 계약을 먼저 등록해 주세요.</ReadOnlyNotice> : null}
      {type === 'BIDDER' && bidOptions.length > 0 && !schoolBidId ? <ReadOnlyNotice>학교 낙찰 계약을 선택하면 계약 지역을 담당하는 활성 대리점만 표시됩니다.</ReadOnlyNotice> : null}
      {type === 'BIDDER' && selectedBid && !selectedBid.areaCode ? <ReadOnlyNotice>선택한 계약은 상세 지역 정보가 없어 대리점을 찾을 수 없습니다. 학교 입찰 정보를 확인해 주세요.</ReadOnlyNotice> : null}
      {type === 'BIDDER' && selectedBid?.areaCode && partnerOptions.length === 0 ? <ReadOnlyNotice>{selectedAreaLabel} 지역을 담당하는 활성 연결 대리점이 없습니다. 거래 관계에서 관심지역과 대리점 담당 지역을 확인해 주세요.</ReadOnlyNotice> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {type === 'BIDDER' ? (
          <div className="min-w-0">
            <label htmlFor="network-order-school-bid" className="block text-sm font-semibold">학교 낙찰 계약</label>
            <select
              id="network-order-school-bid"
              value={schoolBidId}
              onChange={(event) => {
                setSchoolBidId(event.target.value);
                setPartnerCode('');
                setFeedback(null);
              }}
              className="star-control mt-1.5 min-h-11 w-full min-w-0 px-3 text-sm"
              aria-describedby="network-order-school-bid-help"
              disabled={busy || bidOptions.length === 0}
              required
            >
              <option value="">계약 선택</option>
              {bidOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.schoolName} · {item.bidNo} · {item.areaCode ? bidAreaLabel(item.areaCode) : '상세 지역 미설정'}
                </option>
              ))}
            </select>
            <p id="network-order-school-bid-help" className="mt-1.5 text-xs leading-5 text-[var(--ss-text-muted)]">계약을 바꾸면 기존 대리점 선택이 초기화됩니다.</p>
          </div>
        ) : null}
        {type === 'BIDDER' ? (
          <div>
            <span id="network-order-contract-region-label" className="block text-sm font-semibold">계약 상세 지역</span>
            <div
              id="network-order-contract-region"
              role="status"
              aria-live="polite"
              aria-labelledby="network-order-contract-region-label"
              className="mt-1.5 flex min-h-11 items-center rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 text-sm font-bold text-[var(--ss-text-subtle)]"
            >
              {selectedAreaLabel ?? (schoolBidId ? '상세 지역 미설정' : '계약을 먼저 선택하세요')}
            </div>
          </div>
        ) : null}
        <div>
          <label htmlFor="network-order-partner" className="block text-sm font-semibold">{type === 'BIDDER' ? '지역 담당 대리점' : '발주 대상 브랜드'}</label>
          <select
            id="network-order-partner"
            value={partnerCode}
            onChange={(event) => setPartnerCode(event.target.value)}
            className="star-control mt-1.5 w-full px-3 text-sm"
            aria-describedby="network-order-partner-help"
            disabled={busy || partnerOptions.length === 0 || (type === 'BIDDER' && !selectedBid?.areaCode)}
            required
          >
            <option value="">업체 선택</option>
            {partnerOptions.map((item) => (
              <option key={`${item.type}-${item.id}`} value={item.partner.code}>
                {item.partner.name} ({item.partner.code}){item.areaCodes.length > 0 ? ` · ${compactBidAreaSummary(item.areaCodes)}` : ' · 상세 지역 미설정'}
              </option>
            ))}
          </select>
          <p id="network-order-partner-help" className="mt-1.5 text-xs leading-5 text-[var(--ss-text-muted)]">{partnerHelp}</p>
        </div>
        <label className="text-sm font-semibold">납기일<input type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" disabled={busy} required /></label>
        <label className="text-sm font-semibold">발주금액 (원)<input type="number" min="0" step="1" inputMode="numeric" value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" placeholder="0" disabled={busy} required /></label>
        <label className="text-sm font-semibold">품목 수<input type="number" min="1" step="1" inputMode="numeric" value={itemCount} onChange={(event) => setItemCount(event.target.value)} className="star-control mt-1.5 w-full px-3 text-sm" disabled={busy} required /></label>
      </div>
      <label className="block text-sm font-semibold">요청 메모 (선택)<textarea value={note} onChange={(event) => setNote(event.target.value)} className="star-control mt-1.5 min-h-24 w-full resize-y px-3 py-2.5 text-sm" maxLength={500} placeholder="납품 시간, 포장 등 필요한 요청을 입력하세요." disabled={busy} /></label>
      <FeedbackMessage feedback={feedback} />
      <div className="flex justify-end"><button type="submit" disabled={busy || partnerOptions.length === 0 || (type === 'BIDDER' && (!selectedBid?.areaCode || bidOptions.length === 0))} className="star-primary-button w-full px-5 text-sm sm:w-auto">{busy ? '발주 요청 중' : '발주 요청'}</button></div>
    </form>
  );
}

function transitionOptions(order: ChannelOrder, tenantId: string): ChannelOrderStatus[] {
  const isBuyer = order.buyer.id === tenantId;
  const isSupplier = order.supplier.id === tenantId;
  if (order.status === 'REQUESTED') {
    return [...(isSupplier ? ['ACCEPTED', 'REJECTED'] as ChannelOrderStatus[] : []), ...(isBuyer ? ['CANCELLED'] as ChannelOrderStatus[] : [])];
  }
  if (order.status === 'ACCEPTED') {
    return [...(isSupplier ? ['SHIPPED'] as ChannelOrderStatus[] : []), ...(isBuyer ? ['CANCELLED'] as ChannelOrderStatus[] : [])];
  }
  if (order.status === 'SHIPPED' && isBuyer) return ['COMPLETED'];
  return [];
}

function orderStatusTone(status: ChannelOrderStatus): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'REQUESTED') return 'warning';
  if (status === 'ACCEPTED' || status === 'SHIPPED') return 'info';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function ChannelOrdersView({ data, role, pendingAction, searchQuery, onMutate }: NetworkViewProps) {
  const rows = data.channelOrders.filter((item) => includesSearch(item, searchQuery));
  const [feedback, setFeedback] = useState<Feedback>(null);
  const canCreate = role !== 'viewer' && data.tenant.organizationType !== 'BRAND';

  async function transition(order: ChannelOrder, status: ChannelOrderStatus) {
    setFeedback(null);
    try {
      const result = await onMutate({ tenant: data.tenant.code, module: 'channel-orders', action: 'transition', id: order.id, status });
      setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '발주 상태를 변경하지 못했습니다.' });
    }
  }

  return (
    <div className="space-y-4">
      {canCreate ? <OrderForm key={data.tenant.code} data={data} pendingAction={pendingAction} onMutate={onMutate} /> : (
        <ReadOnlyNotice>
          {role === 'viewer'
            ? '현재 계정은 조회 전용입니다. 발주 등록과 상태 변경은 운영자 또는 관리자에게 요청하세요.'
            : '브랜드 업체는 대리점에서 받은 발주를 접수·출고 처리합니다.'}
        </ReadOnlyNotice>
      )}
      <FeedbackMessage feedback={feedback} />
      <TablePanel title="회사 간 발주" description="입찰업체→대리점, 대리점→브랜드 주문을 하나의 흐름으로 추적합니다." count={rows.length}>
        <table className="erp-table min-w-[1120px]">
          <thead><tr><th>발주번호</th><th>구분</th><th>요청업체 → 공급업체</th><th>학교 계약</th><th>납기일</th><th className="text-right">품목</th><th className="text-right">발주금액</th><th>상태</th><th className="text-right">처리</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={9} sourceCount={data.channelOrders.length} searchQuery={searchQuery} /> : rows.map((item) => {
              const actions = role === 'viewer' ? [] : transitionOptions(item, data.tenant.id);
              const busy = pendingAction === item.id;
              return (
                <tr key={item.id}>
                  <td className="font-bold text-[var(--ss-info)]">{item.orderNo}</td>
                  <td>{item.direction === 'BIDDER_TO_DEALER' ? '입찰업체 → 대리점' : '대리점 → 브랜드'}</td>
                  <td><span className="font-semibold">{item.buyer.name}</span><ArrowRight aria-hidden="true" size={14} className="mx-2 inline text-[var(--ss-text-muted)]" /><span className="font-extrabold">{item.supplier.name}</span></td>
                  <td>{item.schoolName ? <><span className="block font-semibold">{item.schoolName}</span><span className="mt-1 block text-xs text-[var(--ss-text-muted)]">{item.schoolBidNo}</span></> : '해당 없음'}</td>
                  <td>{item.deliveryDate}</td>
                  <td className="text-right">{number.format(item.itemCount)}개</td>
                  <td className="text-right font-black">{won.format(item.totalAmount)}</td>
                  <td><StatusBadge tone={orderStatusTone(item.status)}>{orderStatusLabels[item.status]}</StatusBadge></td>
                  <td className="text-right">
                    {actions.length > 0 ? (
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        {actions.map((status) => (
                          <button
                            key={status}
                            type="button"
                            disabled={busy}
                            onClick={() => void transition(item, status)}
                            className={`${status === 'ACCEPTED' || status === 'SHIPPED' || status === 'COMPLETED' ? 'star-primary-button' : 'star-secondary-button'} px-3 text-xs`}
                          >
                            {busy ? '처리 중' : orderStatusLabels[status]}
                          </button>
                        ))}
                      </span>
                    ) : <span className="text-xs font-medium text-[var(--ss-text-muted)]">처리 없음</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TablePanel>
    </div>
  );
}
