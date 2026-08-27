import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck2,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Package,
  ShoppingBag,
  Thermometer,
  TrendingUp,
  Truck,
  Users,
  Utensils,
} from 'lucide-react';
import type { AuthRole } from '../lib/auth-types';
import type {
  BulkProductPriceMutationResult,
  BulkProductPriceRequest,
  BulkProductMutationResult,
  BulkProductRequest,
  ErpAction,
  ErpData,
  ModuleId,
  NetworkMutation,
  NetworkMutationResult,
  ProductMutation,
  ProductMutationResult,
  ProductPriceMutation,
  ProductPriceMutationResult,
  ProductPriceSnapshot,
  PriceMonth,
} from '../lib/erp-types';
import { ModuleLoadingSkeleton } from './loading-skeletons';
import {
  ChannelOrdersView,
  NetworkDashboardSummary,
  PartnersView,
  SchoolBidsView,
  type NetworkViewProps,
} from './network-views';
import { ProductManagement } from './product-management';

export interface NoticeMessage {
  title: string;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface ModuleViewProps {
  activeModule: ModuleId;
  data: ErpData;
  selectedTenant: ErpData['tenant']['code'];
  priceMonth: PriceMonth;
  productPrices: ProductPriceSnapshot[];
  priceLoading: boolean;
  priceLoadError: string | null;
  loading: boolean;
  pendingAction: string | null;
  searchQuery: string;
  siteFilter: string;
  membershipRole: AuthRole;
  onAction: (module: ErpAction['module'], id: string, action: ErpAction['action']) => void;
  onNavigate: (module: ModuleId) => void;
  onNetworkMutate: (mutation: NetworkMutation) => Promise<NetworkMutationResult>;
  onProductMutate: (mutation: ProductMutation) => Promise<ProductMutationResult>;
  onProductBulkMutate: (request: BulkProductRequest, idempotencyKey: string) => Promise<BulkProductMutationResult>;
  onProductPriceMonthChange: (priceMonth: PriceMonth) => Promise<void>;
  onProductPriceMutate: (mutation: ProductPriceMutation) => Promise<ProductPriceMutationResult>;
  onProductPriceBulkMutate: (request: BulkProductPriceRequest, idempotencyKey: string) => Promise<BulkProductPriceMutationResult>;
  onNotice: (notice: NoticeMessage) => void;
}

const won = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ko-KR');

function matches<T extends { siteName?: string }>(rows: T[], query: string, siteFilter: string) {
  const normalized = query.trim().toLocaleLowerCase('ko-KR');
  return rows.filter((row) => {
    const siteMatches = siteFilter === 'ALL' || row.siteName === siteFilter;
    const queryMatches = !normalized || JSON.stringify(row).toLocaleLowerCase('ko-KR').includes(normalized);
    return siteMatches && queryMatches;
  });
}

function StatusBadge({ status }: { status: string }) {
  const tone = ['완료', '확정', '적합', '승인', '시정완료'].includes(status)
    ? 'success'
    : ['승인대기', '검토중', '마감대기', '부분입고'].includes(status)
      ? 'warning'
      : ['부족', '지연', '시정필요'].includes(status)
        ? 'danger'
        : ['작업중', '배송중'].includes(status)
          ? 'info'
          : 'neutral';
  return <span className={`status-badge status-${tone}`}>{status}</span>;
}

function PrimaryAction({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="star-primary-button px-3 text-xs"
    >
      {disabled ? '처리 중' : children}
    </button>
  );
}

function TablePanel({ title, description, count, children }: { title: string; description: string; count: number; children: ReactNode }) {
  return (
    <section className="panel overflow-hidden p-0">
      <div className="flex flex-col gap-2 border-b border-[var(--color-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-extrabold">{title}</h2>
          <p className="mt-1 text-xs text-[var(--color-muted-ink)]">{description}</p>
        </div>
        <span className="status-badge status-neutral w-fit">총 {count}건</span>
      </div>
      <p className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-2 text-[11px] font-medium text-[var(--ss-text-muted)] lg:hidden">표를 좌우로 밀어 전체 정보를 확인하세요.</p>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function EmptyRow({ columns, hasSourceRows }: { columns: number; hasSourceRows: boolean }) {
  const message = hasSourceRows
    ? '현재 검색 또는 사업장 조건에 맞는 항목이 없습니다.'
    : '아직 등록된 항목이 없습니다.';
  return <tr><td colSpan={columns} className="px-5 py-16 text-center text-sm text-[var(--ss-text-muted)]">{message}</td></tr>;
}

function Dashboard({ data, onNavigate }: Pick<ModuleViewProps, 'data' | 'onNavigate'>) {
  const { metrics } = data;
  const metricCards = [
    { label: '조회 계획 식수', value: number.format(metrics.totalServings), unit: '식', detail: `${data.sites.length}개 운영 사업장 합계`, icon: Users, tone: 'navy' },
    { label: '승인 대기 발주', value: number.format(metrics.pendingOrders), unit: '건', detail: '납기 전 승인 필요', icon: ShoppingBag, tone: 'amber' },
    { label: '재고 주의 품목', value: number.format(metrics.inventoryAlerts), unit: '개', detail: '부족 · 유통기한 임박', icon: Package, tone: 'rose' },
    { label: '배송 완료', value: `${metrics.completedDeliveries}/${metrics.totalDeliveries}`, unit: '곳', detail: `미완료 ${Math.max(0, metrics.totalDeliveries - metrics.completedDeliveries)}곳`, icon: Truck, tone: 'blue' },
  ];
  const workflow = [
    { label: '식단 확정', current: data.mealPlans.filter((item) => item.status === '확정').length, total: data.mealPlans.length, module: 'meals' as ModuleId },
    { label: '발주 승인', current: data.purchaseOrders.filter((item) => ['승인', '발주완료', '부분입고'].includes(item.status)).length, total: data.purchaseOrders.length, module: 'purchasing' as ModuleId },
    { label: '생산 완료', current: data.productionOrders.filter((item) => item.status === '완료').length, total: data.productionOrders.length, module: 'production' as ModuleId },
    { label: '배송 완료', current: metrics.completedDeliveries, total: metrics.totalDeliveries, module: 'delivery' as ModuleId },
  ];
  const foodCostRates = data.settlements
    .filter((item) => item.salesAmount > 0)
    .map((item) => (item.ingredientCost / item.salesAmount) * 100);
  const averageFoodCost = foodCostRates.length
    ? Math.round(foodCostRates.reduce((sum, rate) => sum + rate, 0) / foodCostRates.length)
    : null;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((metric) => {
          const Icon = metric.icon;
          return (
            <article key={metric.label} className={`metric-card metric-${metric.tone}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-[var(--ss-text-subtle)]">{metric.label}</p>
                <span className="metric-icon grid h-9 w-9 place-items-center rounded-[var(--ss-radius-sm)]"><Icon size={18} /></span>
              </div>
              <p className="mt-4 flex items-baseline gap-1.5"><strong className="text-3xl font-bold tracking-tight">{metric.value}</strong><span className="text-sm font-medium text-[var(--ss-text-subtle)]">{metric.unit}</span></p>
              <p className="mt-2 text-xs font-medium text-[var(--ss-text-muted)]">{metric.detail}</p>
            </article>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">DAILY FLOW</p><h2>오늘의 운영 흐름</h2></div>
            <span className="flex items-center gap-1 text-xs font-bold text-[var(--color-muted-ink)]"><Clock3 size={14} /> 2분 전 갱신</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {workflow.map((item, index) => {
              const percent = item.total ? Math.round((item.current / item.total) * 100) : 0;
              return (
                <button key={item.label} type="button" onClick={() => onNavigate(item.module)} className="group rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:border-[var(--ss-border-strong)] hover:shadow-[var(--ss-shadow-md)]">
                  <div className="flex items-center justify-between">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--ss-brand-soft)] text-xs font-bold text-[var(--ss-on-brand)]">{index + 1}</span>
                    <ArrowRight size={16} className="text-[var(--ss-text-muted)] transition group-hover:translate-x-1" />
                  </div>
                  <p className="mt-4 text-sm font-semibold">{item.label}</p>
                  <p className="mt-2 text-xl font-bold">{item.current}/{item.total}</p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--ss-surface-subtle)]"><span className="block h-full rounded-full bg-[var(--ss-brand)]" style={{ width: `${percent}%` }} /></div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">COST CONTROL</p><h2>월간 식재료 원가율</h2></div>
            <TrendingUp size={20} className="text-emerald-600" />
          </div>
          <div className="rounded-[var(--ss-radius-md)] bg-[var(--ss-surface-subtle)] p-5 text-center">
            <p className="text-xs font-medium text-[var(--ss-text-subtle)]">8월 평균 원가율</p>
            <p className="mt-2 text-4xl font-bold">{averageFoodCost === null ? <span aria-label="산출 불가">—</span> : <>{averageFoodCost}<span className="text-xl">%</span></>}</p>
            <p className="mt-2 text-xs font-semibold text-[var(--ss-success)]">목표 45% 이하</p>
          </div>
          <div className="mt-4 space-y-3">
            {data.settlements.slice(0, 3).map((item) => {
              const rate = item.salesAmount > 0 ? Math.round((item.ingredientCost / item.salesAmount) * 100) : null;
              return (
                <div key={item.id}>
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="truncate font-bold">{item.siteName}</span><span className="font-black">{rate === null ? <span aria-label="산출 불가">—</span> : `${rate}%`}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-[var(--ss-surface-subtle)]">{rate === null ? null : <span className="block h-full rounded-full bg-[var(--ss-brand)]" style={{ width: `${Math.min(rate, 100)}%` }} />}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          { title: '발주 승인 필요', detail: `${metrics.pendingOrders}건이 결재를 기다리고 있습니다.`, module: 'purchasing' as ModuleId, icon: ShoppingBag },
          { title: '재고 위험 알림', detail: `${metrics.inventoryAlerts}개 품목의 수량 또는 기한을 확인하세요.`, module: 'inventory' as ModuleId, icon: AlertTriangle },
          { title: '위생 시정조치', detail: `${metrics.openHaccpIssues}건이 확인자 처리를 기다리고 있습니다.`, module: 'haccp' as ModuleId, icon: Thermometer },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.title} type="button" onClick={() => onNavigate(item.module)} className="flex min-h-[108px] items-center gap-4 rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 text-left shadow-[var(--ss-shadow-sm)] transition hover:-translate-y-0.5 hover:border-[var(--ss-border-strong)] hover:shadow-[var(--ss-shadow-md)]">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--ss-radius-md)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]"><Icon size={21} /></span>
              <span className="min-w-0 flex-1"><strong className="block text-sm">{item.title}</strong><span className="mt-1 block text-xs leading-5 text-[var(--color-muted-ink)]">{item.detail}</span></span>
              <ArrowRight size={17} className="shrink-0 text-[var(--ss-text-muted)]" />
            </button>
          );
        })}
      </section>
    </div>
  );
}

function MealPlansView({ data, searchQuery, siteFilter, pendingAction, membershipRole, onAction }: ModuleViewProps) {
  const rows = matches(data.mealPlans, searchQuery, siteFilter);
  return (
    <TablePanel title="식단 및 식수 계획" description="끼니별 식단, 식수, 알레르기와 승인 상태를 관리합니다." count={rows.length}>
      <table className="erp-table min-w-[940px]">
        <thead><tr><th>급식일</th><th>급식소</th><th>끼니</th><th>메뉴 구성</th><th className="text-right">예정 식수</th><th>알레르기</th><th>상태</th><th className="text-right">처리</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow columns={8} hasSourceRows={data.mealPlans.length > 0} /> : rows.map((item) => (
            <tr key={item.id}>
              <td className="font-bold">{item.serviceDate}</td><td>{item.siteName}</td><td>{item.mealType}</td>
              <td><span className="block max-w-[320px] truncate font-semibold">{item.menuName}</span></td>
              <td className="text-right font-black">{number.format(item.plannedServings)}식</td><td>{item.allergens}</td><td><StatusBadge status={item.status} /></td>
              <td className="text-right">{['작성중', '승인대기'].includes(item.status) && (membershipRole === 'viewer'
                ? <span className="text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</span>
                : <PrimaryAction disabled={pendingAction === item.id} onClick={() => onAction('meals', item.id, 'confirm')}>식단 확정</PrimaryAction>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TablePanel>
  );
}

function PurchasingView({ data, searchQuery, siteFilter, pendingAction, membershipRole, onAction }: ModuleViewProps) {
  const rows = matches(data.purchaseOrders, searchQuery, siteFilter);
  const total = rows.reduce((sum, item) => sum + item.totalAmount, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="조회 발주 금액" value={won.format(total)} icon={<CircleDollarSign size={19} />} />
        <SummaryCard label="승인 대기" value={`${rows.filter((item) => item.status === '승인대기').length}건`} icon={<Clock3 size={19} />} />
        <SummaryCard label="입고 진행" value={`${rows.filter((item) => item.status === '부분입고').length}건`} icon={<Package size={19} />} />
      </div>
      <TablePanel title="구매 발주서" description="납기, 공급업체, 승인과 입고 상태를 한 번에 확인합니다." count={rows.length}>
        <table className="erp-table min-w-[900px]">
          <thead><tr><th>발주번호</th><th>사업장</th><th>공급업체</th><th>납기일</th><th className="text-right">품목</th><th className="text-right">발주금액</th><th>상태</th><th className="text-right">처리</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={8} hasSourceRows={data.purchaseOrders.length > 0} /> : rows.map((item) => (
              <tr key={item.id}>
                <td className="font-bold text-[var(--color-blue)]">{item.orderNo}</td><td>{item.siteName}</td><td className="font-semibold">{item.supplierName}</td><td>{item.deliveryDate}</td>
                <td className="text-right">{item.itemCount}개</td><td className="text-right font-black">{won.format(item.totalAmount)}</td><td><StatusBadge status={item.status} /></td>
                <td className="text-right">{item.status === '승인대기' && (membershipRole === 'viewer'
                  ? <span className="text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</span>
                  : <PrimaryAction disabled={pendingAction === item.id} onClick={() => onAction('purchasing', item.id, 'approve')}>발주 승인</PrimaryAction>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablePanel>
    </div>
  );
}

function InventoryView({ data, searchQuery, siteFilter }: ModuleViewProps) {
  const rows = matches(data.inventoryLots, searchQuery, siteFilter);
  return (
    <TablePanel title="로트별 재고 현황" description="FEFO 기준으로 유통기한과 수량 위험을 우선 표시합니다." count={rows.length}>
      <table className="erp-table min-w-[900px]">
        <thead><tr><th>식재료</th><th>사업장</th><th>로트번호</th><th>보관위치</th><th className="text-right">현재고</th><th>유통기한</th><th>상태</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow columns={7} hasSourceRows={data.inventoryLots.length > 0} /> : rows.map((item) => (
            <tr key={item.id}>
              <td className="font-extrabold">{item.ingredientName}</td><td>{item.siteName}</td><td className="font-mono text-xs">{item.lotNo}</td><td>{item.location}</td>
              <td className="text-right text-base font-black">{number.format(item.quantity)} <span className="text-xs text-slate-500">{item.unit}</span></td><td>{item.expiresAt}</td><td><StatusBadge status={item.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TablePanel>
  );
}

function ProductionView({ data, searchQuery, siteFilter }: ModuleViewProps) {
  const rows = matches(data.productionOrders, searchQuery, siteFilter);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_320px]">
      <TablePanel title="오늘의 생산지시" description="계획 대비 생산량과 조리 중심온도를 확인합니다." count={rows.length}>
        <table className="erp-table min-w-[760px]">
          <thead><tr><th>메뉴</th><th>사업장</th><th>급식일</th><th className="text-right">계획</th><th className="text-right">실적</th><th>중심온도</th><th>상태</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={7} hasSourceRows={data.productionOrders.length > 0} /> : rows.map((item) => (
              <tr key={item.id}>
                <td className="font-extrabold">{item.menuName}</td><td>{item.siteName}</td><td>{item.serviceDate}</td><td className="text-right">{number.format(item.plannedQuantity)}식</td>
                <td className="text-right font-black">{item.actualQuantity === null ? '—' : `${number.format(item.actualQuantity)}식`}</td>
                <td>{item.coreTemperature === null ? '미측정' : `${item.coreTemperature}°C`}</td><td><StatusBadge status={item.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablePanel>
      <section className="panel">
        <p className="eyebrow">PRODUCTION CHECK</p><h2 className="mt-1 text-base font-extrabold">마감 조건</h2>
        <ul className="mt-4 space-y-3">
          {['계획·실제 생산량 입력', '사용 로트·투입량 기록', '폐기량 및 사유 기록', '조리 중심온도 적합'].map((label, index) => (
            <li key={label} className="flex items-start gap-3 text-sm"><CheckCircle2 size={18} className={index < 3 ? 'text-emerald-600' : 'text-amber-600'} /><span className="font-semibold">{label}</span></li>
          ))}
        </ul>
        <div className="mt-5 rounded-xl bg-amber-50 p-4 text-xs font-semibold leading-5 text-amber-900">필수 위생점검이 끝나지 않은 생산 건은 마감할 수 없습니다.</div>
      </section>
    </div>
  );
}

function DeliveryView({ data, searchQuery, siteFilter, pendingAction, membershipRole, onAction }: ModuleViewProps) {
  const rows = matches(data.deliveries, searchQuery, siteFilter);
  return (
    <TablePanel title="배송 배차 및 인수 현황" description="차량, 도착예정, 온도와 인수완료를 관리합니다." count={rows.length}>
      <table className="erp-table min-w-[940px]">
        <thead><tr><th>배송번호</th><th>납품처</th><th>도착예정</th><th>기사·차량</th><th className="text-right">식수</th><th>배송온도</th><th>상태</th><th className="text-right">처리</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow columns={8} hasSourceRows={data.deliveries.length > 0} /> : rows.map((item) => (
            <tr key={item.id}>
              <td className="font-bold text-[var(--color-blue)]">{item.deliveryNo}</td><td className="font-extrabold">{item.siteName}</td>
              <td>{new Date(item.scheduledAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</td><td><span className="block font-semibold">{item.driverName}</span><span className="text-xs text-slate-500">{item.vehicleNo}</span></td>
              <td className="text-right font-black">{number.format(item.servings)}식</td><td>{item.temperature === null ? '미측정' : `${item.temperature}°C`}</td><td><StatusBadge status={item.status} /></td>
              <td className="text-right">{item.status === '배송중' && (membershipRole === 'viewer'
                ? <span className="text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</span>
                : <PrimaryAction disabled={pendingAction === item.id} onClick={() => onAction('delivery', item.id, 'complete')}>인수 완료</PrimaryAction>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TablePanel>
  );
}

function SettlementView({ data, searchQuery, siteFilter }: ModuleViewProps) {
  const rows = matches(data.settlements, searchQuery, siteFilter);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="총 매출" value={won.format(rows.reduce((sum, item) => sum + item.salesAmount, 0))} icon={<CircleDollarSign size={19} />} />
        <SummaryCard label="식재료비" value={won.format(rows.reduce((sum, item) => sum + item.ingredientCost, 0))} icon={<ShoppingBag size={19} />} />
        <SummaryCard label="총 실제 식수" value={`${number.format(rows.reduce((sum, item) => sum + item.actualServings, 0))}식`} icon={<Utensils size={19} />} />
      </div>
      <TablePanel title="월 정산 현황" description="실제 식수 기준 매출과 식재료 원가율을 검토합니다." count={rows.length}>
        <table className="erp-table min-w-[820px]">
          <thead><tr><th>정산월</th><th>급식소</th><th className="text-right">실제 식수</th><th className="text-right">매출</th><th className="text-right">식재료비</th><th className="text-right">원가율</th><th>상태</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={7} hasSourceRows={data.settlements.length > 0} /> : rows.map((item) => {
              const rate = item.salesAmount > 0 ? Math.round((item.ingredientCost / item.salesAmount) * 100) : null;
              return (
                <tr key={item.id}><td className="font-bold">{item.settlementMonth}</td><td className="font-extrabold">{item.siteName}</td><td className="text-right">{number.format(item.actualServings)}식</td><td className="text-right font-bold">{won.format(item.salesAmount)}</td><td className="text-right">{won.format(item.ingredientCost)}</td><td className="text-right font-black">{rate === null ? <span aria-label="산출 불가">—</span> : `${rate}%`}</td><td><StatusBadge status={item.status} /></td></tr>
              );
            })}
          </tbody>
        </table>
      </TablePanel>
    </div>
  );
}

function HaccpView({ data, searchQuery, siteFilter, pendingAction, membershipRole, onAction }: ModuleViewProps) {
  const rows = matches(data.haccpChecks, searchQuery, siteFilter);
  const completionRate = rows.length
    ? Math.round((rows.filter((item) => item.status !== '시정필요').length / rows.length) * 100)
    : null;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_330px]">
      <TablePanel title="일일 위생점검" description="점검값, 적합 여부와 시정조치 완료까지 기록합니다." count={rows.length}>
        <table className="erp-table min-w-[940px]">
          <thead><tr><th>점검일</th><th>구분</th><th>점검항목</th><th>사업장</th><th>측정값</th><th>담당자</th><th>상태</th><th className="text-right">처리</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow columns={8} hasSourceRows={data.haccpChecks.length > 0} /> : rows.map((item) => (
              <tr key={item.id}>
                <td>{item.checkDate}</td><td className="font-bold">{item.category}</td><td><span className="block font-extrabold">{item.itemName}</span>{item.correctiveAction && <span className="mt-1 block max-w-[280px] truncate text-xs text-amber-700">{item.correctiveAction}</span>}</td>
                <td>{item.siteName}</td><td className="font-black">{item.measuredValue}</td><td>{item.assigneeName}</td><td><StatusBadge status={item.status} /></td>
                <td className="text-right">{item.status === '시정필요' && (membershipRole === 'viewer'
                  ? <span className="text-xs font-semibold text-[var(--ss-text-muted)]">조회 전용</span>
                  : <PrimaryAction disabled={pendingAction === item.id} onClick={() => onAction('haccp', item.id, 'resolve')}>시정 확인</PrimaryAction>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablePanel>
      <section className="panel">
        <p className="eyebrow">HACCP RECORD</p><h2 className="mt-1 text-base font-extrabold">오늘의 점검률</h2>
        <div className="mt-5 grid place-items-center rounded-[var(--ss-radius-lg)] bg-[var(--ss-emphasis)] py-8 text-[var(--ss-on-emphasis)]">
          <CalendarCheck2 size={28} className="text-[var(--ss-brand)]" />
          <p className="mt-3 text-4xl font-bold">{completionRate === null ? <span aria-label="산출 불가">—</span> : `${completionRate}%`}</p>
          <p className="mt-1 text-xs font-medium text-[var(--ss-neutral-300)]">필수 기록 완료</p>
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-red-900"><AlertTriangle size={19} className="shrink-0" /><p className="text-xs font-semibold leading-5">시정필요 건은 조치내용과 확인자 기록 없이는 마감할 수 없습니다.</p></div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <article className="flex min-h-[96px] items-center gap-4 rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)]">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--ss-radius-md)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]">{icon}</span>
      <div className="min-w-0"><p className="text-xs font-medium text-[var(--ss-text-subtle)]">{label}</p><p className="mt-1 truncate text-lg font-bold">{value}</p></div>
    </article>
  );
}

export function ModuleView(props: ModuleViewProps) {
  if (props.loading) {
    return <ModuleLoadingSkeleton activeModule={props.activeModule} />;
  }

  const networkProps: NetworkViewProps = {
    data: props.data,
    role: props.membershipRole,
    pendingAction: props.pendingAction,
    searchQuery: props.searchQuery,
    onNavigate: props.onNavigate,
    onMutate: props.onNetworkMutate,
  };

  switch (props.activeModule) {
    case 'partners': return <PartnersView {...networkProps} />;
    case 'bids': return <SchoolBidsView {...networkProps} />;
    case 'channel-orders': return <ChannelOrdersView {...networkProps} />;
    case 'products': return (
      <ProductManagement
        tenant={props.selectedTenant}
        readOnly={props.membershipRole === 'viewer'}
        products={props.data.products}
        priceMonth={props.priceMonth}
        productPrices={props.productPrices}
        priceLoading={props.priceLoading}
        priceLoadError={props.priceLoadError}
        onMutate={props.onProductMutate}
        onBulkMutate={props.onProductBulkMutate}
        onPriceMonthChange={props.onProductPriceMonthChange}
        onPriceMutate={props.onProductPriceMutate}
        onPriceBulkMutate={props.onProductPriceBulkMutate}
        onNotice={props.onNotice}
      />
    );
    case 'meals': return <MealPlansView {...props} />;
    case 'purchasing': return <PurchasingView {...props} />;
    case 'inventory': return <InventoryView {...props} />;
    case 'production': return <ProductionView {...props} />;
    case 'delivery': return <DeliveryView {...props} />;
    case 'settlement': return <SettlementView {...props} />;
    case 'haccp': return <HaccpView {...props} />;
    default: return props.data.tenant.organizationType === 'BIDDER' ? (
      <div className="space-y-8">
        <NetworkDashboardSummary data={props.data} onNavigate={props.onNavigate} />
        <Dashboard data={props.data} onNavigate={props.onNavigate} />
      </div>
    ) : <NetworkDashboardSummary data={props.data} onNavigate={props.onNavigate} />;
  }
}
