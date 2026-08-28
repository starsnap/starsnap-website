'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Bell,
  Building2,
  Calculator,
  CalendarDays,
  ChefHat,
  Download,
  Gavel,
  Handshake,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageSearch,
  RotateCw,
  ShieldCheck,
  ShoppingCart,
  Split,
  Truck,
  Warehouse,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AuthSession } from '../lib/auth-types';
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
  OrganizationType,
  Product,
  ProductMutation,
  ProductMutationResult,
  ProductPriceMutation,
  ProductPriceMutationResult,
  ProductPriceSnapshot,
  ProductPriceValues,
  PriceMonth,
  TenantCode,
} from '../lib/erp-types';
import { moduleIdsForOrganization } from '../lib/organization-modules';
import { currentPriceMonth, isPriceMonth } from '../lib/price-month';
import { ModuleView, type NoticeMessage } from './module-views';
import { AccessibleModal, lockBodyScroll, unlockBodyScroll } from './accessible-modal';
import { NoticeModal } from './notice-modal';
import { ModuleSearchCombobox } from './module-search-combobox';
import { WorkflowActionModal } from './workflow-action-modal';
import { StarSnapBrandIcon } from './starsnap-brand-icon';

interface ModuleDefinition {
  id: ModuleId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

const moduleCatalog: Record<ModuleId, ModuleDefinition> = {
  dashboard: { id: 'dashboard', label: '통합 대시보드', shortLabel: '대시보드', icon: LayoutDashboard },
  partners: { id: 'partners', label: '거래 관계 관리', shortLabel: '거래 관계', icon: Handshake },
  bids: { id: 'bids', label: '학교 입찰 관리', shortLabel: '학교 입찰', icon: Gavel },
  'channel-orders': { id: 'channel-orders', label: '유통 발주 관리', shortLabel: '유통 발주', icon: Split },
  products: { id: 'products', label: '상품·식자재 관리', shortLabel: '상품·식자재', icon: PackageSearch },
  meals: { id: 'meals', label: '식단·식수 관리', shortLabel: '식단·식수', icon: CalendarDays },
  purchasing: { id: 'purchasing', label: '발주·구매 관리', shortLabel: '발주·구매', icon: ShoppingCart },
  inventory: { id: 'inventory', label: '입고·재고 관리', shortLabel: '입고·재고', icon: Warehouse },
  production: { id: 'production', label: '생산 관리', shortLabel: '생산관리', icon: ChefHat },
  delivery: { id: 'delivery', label: '배송 관리', shortLabel: '배송관리', icon: Truck },
  settlement: { id: 'settlement', label: '정산·원가 관리', shortLabel: '정산·원가', icon: Calculator },
  haccp: { id: 'haccp', label: '위생·HACCP', shortLabel: '위생·HACCP', icon: ShieldCheck },
};

const organizationLabel: Record<OrganizationType, string> = {
  BRAND: '브랜드 본사',
  DEALER: '지역 대리점',
  BIDDER: '학교 입찰업체',
};

const siteFilteredModules = new Set<ModuleId>([
  'meals', 'purchasing', 'inventory', 'production', 'delivery', 'settlement', 'haccp',
]);

const INITIAL_PRICE_MONTH = currentPriceMonth();

const statusByAction: Record<ErpAction['module'], string> = {
  meals: '확정',
  purchasing: '승인',
  inventory: '확인완료',
  production: '완료',
  delivery: '완료',
  haccp: '시정완료',
};

interface ActionDialogState {
  request: ErpAction;
  itemLabel: string;
}

interface ErpShellProps {
  session: AuthSession;
  onSessionExpired: (message?: string) => void;
}

class SessionExpiredError extends Error {
  constructor(message = '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

function createInitialErpData(tenant: AuthSession['memberships'][number]['tenant']): ErpData {
  return {
    tenant,
    tenants: [tenant],
    sites: [],
    metrics: {
      totalServings: 0,
      pendingOrders: 0,
      inventoryAlerts: 0,
      completedDeliveries: 0,
      totalDeliveries: 0,
      openHaccpIssues: 0,
    },
    networkMetrics: {
      activePartners: 0,
      openBids: 0,
      incomingOrders: 0,
      outgoingOrders: 0,
    },
    bidderTargetRegionCodes: [],
    bidderTargetAreaCodes: [],
    partners: [],
    schoolBids: [],
    channelOrders: [],
    products: [],
    mealPlans: [],
    purchaseOrders: [],
    inventoryLots: [],
    productionOrders: [],
    deliveries: [],
    settlements: [],
    haccpChecks: [],
  };
}

function assertSessionResponse(response: Response) {
  if (response.status === 401) throw new SessionExpiredError();
}

const productPriceFields = [
  'schoolPriceKg',
  'schoolPriceSpec',
  'schoolPriceEach',
  'vendorPriceKg',
  'vendorPriceSpec',
  'vendorPriceEach',
  'purchasePriceKg',
  'purchasePriceSpec',
  'purchasePriceEach',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrganizationType(value: unknown): value is OrganizationType {
  return value === 'BRAND' || value === 'DEALER' || value === 'BIDDER';
}

function parseProductPriceResponse(
  decoded: unknown,
  code: TenantCode,
  priceMonth: PriceMonth,
): ProductPriceSnapshot[] {
  if (
    !isRecord(decoded)
    || decoded.tenant !== code
    || decoded.priceMonth !== priceMonth
    || !Array.isArray(decoded.products)
  ) throw new Error('상품 월별 단가 응답의 회사 또는 기준월이 일치하지 않습니다.');

  return decoded.products.map((item) => parseProductPriceSnapshot(item, priceMonth));
}

function parseProductPriceSnapshot(item: unknown, priceMonth: PriceMonth): ProductPriceSnapshot {
  if (
    !isRecord(item)
    || typeof item.productId !== 'string'
    || item.productId.length === 0
    || item.priceMonth !== priceMonth
    || typeof item.priceInherited !== 'boolean'
    || !Number.isInteger(item.priceVersion)
    || !Number.isInteger(item.priceSourceVersion)
    || (item.priceSourceMonth !== null && !isPriceMonth(item.priceSourceMonth))
    || typeof item.updatedAt !== 'string'
    || Number.isNaN(Date.parse(item.updatedAt))
    || productPriceFields.some((field) => (
      !Number.isInteger(item[field])
      || (item[field] as number) < 0
      || (item[field] as number) > 100_000_000
    ))
  ) throw new Error('상품 월별 단가 응답에 올바르지 않은 값이 있습니다.');

  if (item.priceInherited) {
    if (
      item.priceVersion !== 0
      || (item.priceSourceVersion as number) < 1
      || (item.priceSourceMonth !== null && item.priceSourceMonth >= priceMonth)
    ) throw new Error('이어받은 월별 단가 응답의 원본 정보가 올바르지 않습니다.');
  } else if (
    (item.priceVersion as number) < 1
    || item.priceSourceMonth !== priceMonth
    || item.priceSourceVersion !== item.priceVersion
  ) throw new Error('직접 등록된 월별 단가 응답의 버전 정보가 올바르지 않습니다.');

  return item as unknown as ProductPriceSnapshot;
}

async function fetchTenantData(code: TenantCode) {
  const response = await fetch(`/api/erp?tenant=${encodeURIComponent(code)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  assertSessionResponse(response);
  if (!response.ok) throw new Error(`ERP API ${response.status}`);
  const decoded: unknown = await response.json();
  if (
    !isRecord(decoded)
    || !isRecord(decoded.tenant)
    || decoded.tenant.code !== code
    || !isOrganizationType(decoded.tenant.organizationType)
  ) throw new Error('ERP 응답의 회사 정보가 요청과 일치하지 않습니다.');
  return decoded as unknown as ErpData;
}

async function fetchProductPrices(code: TenantCode, priceMonth: PriceMonth) {
  const response = await fetch(
    `/api/erp/products/prices?tenant=${encodeURIComponent(code)}&priceMonth=${encodeURIComponent(priceMonth)}`,
    { cache: 'no-store', credentials: 'same-origin' },
  );
  assertSessionResponse(response);
  if (!response.ok) throw new Error(`상품 월별 단가 API ${response.status}`);
  const result: unknown = await response.json();
  return parseProductPriceResponse(result, code, priceMonth);
}

function assertProductPriceCoverage(
  products: Product[],
  snapshots: ProductPriceSnapshot[],
  priceMonth: PriceMonth,
) {
  const expectedIds = new Set(products.map((product) => product.id));
  const receivedIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (
      snapshot.priceMonth !== priceMonth
      || !expectedIds.has(snapshot.productId)
      || receivedIds.has(snapshot.productId)
    ) throw new Error('상품 월별 단가 응답이 상품 기준정보와 일치하지 않습니다.');
    receivedIds.add(snapshot.productId);
  }
  if (receivedIds.size !== expectedIds.size) {
    throw new Error('일부 상품의 월별 단가 응답이 누락되었습니다.');
  }
}

function productPriceValues(product: ProductPriceValues): ProductPriceValues {
  return {
    schoolPriceKg: product.schoolPriceKg,
    schoolPriceSpec: product.schoolPriceSpec,
    schoolPriceEach: product.schoolPriceEach,
    vendorPriceKg: product.vendorPriceKg,
    vendorPriceSpec: product.vendorPriceSpec,
    vendorPriceEach: product.vendorPriceEach,
    purchasePriceKg: product.purchasePriceKg,
    purchasePriceSpec: product.purchasePriceSpec,
    purchasePriceEach: product.purchasePriceEach,
  };
}

function createdProductPriceSnapshot(
  productId: string,
  product: ProductPriceValues,
  selectedMonth: PriceMonth,
  createdPriceMonth: PriceMonth,
  updatedAt: string,
): ProductPriceSnapshot {
  const selectedIsCreated = selectedMonth === createdPriceMonth;
  const common = {
    productId,
    ...productPriceValues(product),
    priceMonth: selectedMonth,
    priceSourceVersion: 1,
    updatedAt,
  };
  if (selectedIsCreated) {
    return { ...common, priceSourceMonth: createdPriceMonth, priceInherited: false, priceVersion: 1 };
  }
  return {
    ...common,
    priceSourceMonth: selectedMonth < createdPriceMonth ? null : createdPriceMonth,
    priceInherited: true,
    priceVersion: 0,
  };
}

function bulkProductFailure(message: string, total = 0): BulkProductMutationResult {
  return {
    ok: false,
    message,
    summary: { total, created: 0, updated: 0, failed: 0, notApplied: total },
    rowDetails: { included: 0, total, omitted: total, truncated: total > 0 },
    rows: [],
  };
}

function bulkProductPriceFailure(message: string, total = 0): BulkProductPriceMutationResult {
  return {
    ok: false,
    message,
    summary: { total, created: 0, updated: 0, failed: 0, notApplied: total },
    rowDetails: { included: 0, total, omitted: total, truncated: total > 0 },
    rows: [],
  };
}

function reconcileBulkProducts(
  currentProducts: Product[],
  request: BulkProductRequest,
  result: BulkProductMutationResult,
): Product[] | null {
  if (
    !result.appliedAt
    || Number.isNaN(Date.parse(result.appliedAt))
    || !Array.isArray(result.createdProductIds)
  ) return null;

  const requestedCreateCount = request.rows.reduce(
    (count, row) => count + (row.action === 'create' ? 1 : 0),
    0,
  );
  const requestedUpdateCount = request.rows.length - requestedCreateCount;
  const createdIdsValid = result.createdProductIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(result.createdProductIds).size === result.createdProductIds.length;
  if (
    result.summary.total !== request.rows.length
    || result.summary.created !== requestedCreateCount
    || result.summary.updated !== requestedUpdateCount
    || result.summary.failed !== 0
    || result.summary.notApplied !== 0
    || result.createdProductIds.length !== requestedCreateCount
    || !createdIdsValid
    || (requestedCreateCount > 0 && (!result.createdPriceMonth || !isPriceMonth(result.createdPriceMonth)))
  ) return null;

  const nextProducts = new Map(currentProducts.map((product) => [product.id, product]));
  let createdIndex = 0;
  for (const row of request.rows) {
    if (row.action === 'create') {
      const id = result.createdProductIds[createdIndex++];
      if (!id || nextProducts.has(id)) return null;
      nextProducts.set(id, {
        id,
        ...row.product,
        status: 'ACTIVE',
        version: 1,
        updatedAt: result.appliedAt,
      });
      continue;
    }

    const existing = nextProducts.get(row.id);
    if (!existing || (existing.version !== row.expectedVersion && existing.version !== row.expectedVersion + 1)) {
      return null;
    }
    nextProducts.set(row.id, {
      id: row.id,
      ...row.product,
      status: existing.status,
      version: row.expectedVersion + 1,
      updatedAt: result.appliedAt,
    });
  }

  return [...nextProducts.values()].sort((left, right) => {
    const leftValues = [left.status, left.name, left.sku];
    const rightValues = [right.status, right.name, right.sku];
    for (let index = 0; index < leftValues.length; index += 1) {
      if (leftValues[index] === rightValues[index]) continue;
      return (leftValues[index] as string) < (rightValues[index] as string) ? -1 : 1;
    }
    return 0;
  });
}

export function ErpShell({ session, onSessionExpired }: ErpShellProps) {
  const membership = session.memberships[0];
  const tenantCode = membership.tenant.code;
  const [data, setData] = useState<ErpData>(() => createInitialErpData(membership.tenant));
  const [priceMonth, setPriceMonth] = useState<PriceMonth>(INITIAL_PRICE_MONTH);
  const [productPrices, setProductPrices] = useState<ProductPriceSnapshot[]>([]);
  const [priceLoading, setPriceLoading] = useState(true);
  const [priceLoadError, setPriceLoadError] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<ModuleId>('dashboard');
  const [siteFilter, setSiteFilter] = useState('ALL');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [desktopNavigation, setDesktopNavigation] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuCloseButtonRef = useRef<HTMLButtonElement>(null);
  const selectedTenantRef = useRef<TenantCode>(tenantCode);
  const priceMonthRef = useRef<PriceMonth>(INITIAL_PRICE_MONTH);
  const loadGenerationRef = useRef(0);
  const priceLoadingGenerationRef = useRef(0);
  const refreshStatusGenerationRef = useRef(0);
  const networkIdempotencyKeysRef = useRef(new Map<string, string>());
  const roleLabel = membership.role === 'admin' ? '관리자' : membership.role === 'operator' ? '운영 담당자' : '조회 사용자';
  const avatarLabel = session.user.username.slice(0, 1).toLocaleUpperCase('ko-KR') || 'U';

  useEffect(() => {
    let active = true;
    const generation = ++loadGenerationRef.current;
    fetchTenantData(tenantCode)
      .then(async (next) => {
        try {
          const prices = await fetchProductPrices(tenantCode, priceMonthRef.current);
          assertProductPriceCoverage(next.products, prices, priceMonthRef.current);
          if (!active || generation !== loadGenerationRef.current || selectedTenantRef.current !== tenantCode) return;
          setData(next);
          setProductPrices(prices);
          setPriceLoadError(null);
          setLoadError(null);
          setConnected(true);
        } catch (error) {
          if (error instanceof SessionExpiredError) throw error;
          if (!active || generation !== loadGenerationRef.current || selectedTenantRef.current !== tenantCode) return;
          console.warn('Product monthly prices are unavailable', error);
          setData(next);
          setProductPrices([]);
          setPriceLoadError('월별 단가를 불러오지 못했습니다. 단가 조회를 다시 시도해 주세요.');
          setConnected(true);
        }
      })
      .catch((error) => {
        if (!active || generation !== loadGenerationRef.current || selectedTenantRef.current !== tenantCode) return;
        if (error instanceof SessionExpiredError) {
          onSessionExpired(error.message);
          return;
        }
        console.warn('ERP data load failed', error);
        setProductPrices([]);
        setLoadError('ERP 데이터를 불러오지 못했습니다. 서버 연결을 확인한 뒤 다시 시도해 주세요.');
        setPriceLoadError('ERP 데이터를 불러오지 못해 월별 단가를 확인할 수 없습니다.');
        setConnected(false);
      })
      .finally(() => {
        if (active && generation === loadGenerationRef.current && selectedTenantRef.current === tenantCode) {
          setLoading(false);
          setPriceLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [onSessionExpired, tenantCode]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktopNavigation(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (desktopNavigation || !mobileMenuOpen) return;
    const menuButton = menuButtonRef.current;
    lockBodyScroll();
    menuCloseButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unlockBodyScroll();
      window.removeEventListener('keydown', onKeyDown);
      menuButton?.focus();
    };
  }, [desktopNavigation, mobileMenuOpen]);

  const availableModules = useMemo(
    () => moduleIdsForOrganization(data.tenant.organizationType).map((id) => moduleCatalog[id]),
    [data.tenant.organizationType],
  );
  const activeDefinition = useMemo(
    () => availableModules.find((item) => item.id === activeModule) ?? moduleCatalog.dashboard,
    [activeModule, availableModules],
  );

  const selectModule = (id: ModuleId) => {
    if (!availableModules.some((item) => item.id === id)) return;
    setActiveModule(id);
    setMobileMenuOpen(false);
  };

  const refreshTenant = async (code: TenantCode) => {
    const generation = ++loadGenerationRef.current;
    const refreshStatusGeneration = ++refreshStatusGenerationRef.current;
    const requestedMonth = priceMonthRef.current;
    if (selectedTenantRef.current === code) {
      setRefreshing(true);
      setRefreshError(null);
    }
    try {
      const next = await fetchTenantData(code);
      let prices: ProductPriceSnapshot[];
      try {
        prices = await fetchProductPrices(code, requestedMonth);
        assertProductPriceCoverage(next.products, prices, requestedMonth);
      } catch (error) {
        if (error instanceof SessionExpiredError) throw error;
        if (
          generation !== loadGenerationRef.current
          || selectedTenantRef.current !== code
          || priceMonthRef.current !== requestedMonth
        ) return;
        console.warn('Product monthly price refresh failed', error);
        setData(next);
        setLoadError(null);
        setPriceLoadError('월별 단가 새로 고침에 실패했습니다. 마지막으로 확인한 단가는 편집할 수 없습니다.');
        setRefreshError('기본 ERP 데이터는 갱신했지만 월별 단가는 갱신하지 못했습니다. 다시 시도해 주세요.');
        setConnected(true);
        return;
      }
      if (
        generation !== loadGenerationRef.current
        || selectedTenantRef.current !== code
        || priceMonthRef.current !== requestedMonth
      ) return;
      setData(next);
      setProductPrices(prices);
      setPriceLoadError(null);
      setLoadError(null);
      setRefreshError(null);
      setConnected(true);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return;
      }
      if (generation === loadGenerationRef.current && selectedTenantRef.current === code) {
        setConnected(false);
        setRefreshError('최신 ERP 데이터를 가져오지 못했습니다. 마지막으로 확인한 데이터를 유지합니다.');
      }
    } finally {
      if (
        refreshStatusGeneration === refreshStatusGenerationRef.current
        && selectedTenantRef.current === code
      ) setRefreshing(false);
    }
  };

  const changePriceMonth = async (nextMonth: PriceMonth) => {
    const retryingCurrentMonth = nextMonth === priceMonthRef.current;
    if (!isPriceMonth(nextMonth) || (retryingCurrentMonth && !priceLoadError) || pendingAction || priceLoading) return;
    const code = selectedTenantRef.current;
    const generation = ++loadGenerationRef.current;
    const priceLoadingGeneration = ++priceLoadingGenerationRef.current;
    setPriceLoading(true);
    try {
      const prices = await fetchProductPrices(code, nextMonth);
      assertProductPriceCoverage(data.products, prices, nextMonth);
      if (generation !== loadGenerationRef.current || selectedTenantRef.current !== code) return;
      priceMonthRef.current = nextMonth;
      setPriceMonth(nextMonth);
      setProductPrices(prices);
      setPriceLoadError(null);
      setRefreshError(null);
      setConnected(true);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return;
      }
      if (generation !== loadGenerationRef.current || selectedTenantRef.current !== code) return;
      if (retryingCurrentMonth) {
        setPriceLoadError('월별 단가를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      setNotice({
        title: '월별 단가 조회 실패',
        message: error instanceof Error ? error.message : '선택한 월의 단가를 불러오지 못했습니다.',
        tone: 'error',
      });
    } finally {
      if (
        priceLoadingGeneration === priceLoadingGenerationRef.current
        && selectedTenantRef.current === code
      ) setPriceLoading(false);
    }
  };

  const updateLocalStatus = (action: ErpAction) => {
    setData((current) => {
      if (current.tenant.code !== action.tenant || selectedTenantRef.current !== action.tenant) return current;
      const status = statusByAction[action.module];
      if (action.module === 'meals') {
        return { ...current, mealPlans: current.mealPlans.map((item) => item.id === action.id ? { ...item, status } : item) };
      }
      if (action.module === 'purchasing') {
        return {
          ...current,
          metrics: { ...current.metrics, pendingOrders: Math.max(0, current.metrics.pendingOrders - 1) },
          purchaseOrders: current.purchaseOrders.map((item) => item.id === action.id ? { ...item, status } : item),
        };
      }
      if (action.module === 'inventory') {
        return { ...current, inventoryLots: current.inventoryLots.map((item) => item.id === action.id ? { ...item, status } : item) };
      }
      if (action.module === 'production') {
        return { ...current, productionOrders: current.productionOrders.map((item) => item.id === action.id ? { ...item, status } : item) };
      }
      if (action.module === 'delivery') {
        return {
          ...current,
          metrics: { ...current.metrics, completedDeliveries: Math.min(current.metrics.totalDeliveries, current.metrics.completedDeliveries + 1) },
          deliveries: current.deliveries.map((item) => item.id === action.id ? { ...item, status } : item),
        };
      }
      return {
        ...current,
        metrics: { ...current.metrics, openHaccpIssues: Math.max(0, current.metrics.openHaccpIssues - 1) },
        haccpChecks: current.haccpChecks.map((item) => item.id === action.id ? { ...item, status } : item),
      };
    });
  };

  const requestAction = (module: ErpAction['module'], id: string, action: ErpAction['action']) => {
    if (pendingAction) return;
    const itemLabel = module === 'meals'
      ? data.mealPlans.find((item) => item.id === id)?.menuName
      : module === 'purchasing'
        ? data.purchaseOrders.find((item) => item.id === id)?.orderNo
        : module === 'inventory'
          ? data.inventoryLots.find((item) => item.id === id)?.ingredientName
          : module === 'production'
            ? data.productionOrders.find((item) => item.id === id)?.menuName
            : module === 'delivery'
              ? data.deliveries.find((item) => item.id === id)?.deliveryNo
              : data.haccpChecks.find((item) => item.id === id)?.itemName;
    setActionError(null);
    setActionDialog({
      request: { tenant: tenantCode, module, id, action },
      itemLabel: itemLabel ?? '선택한 업무',
    });
  };

  const submitAction = async (evidence?: ErpAction['evidence']) => {
    if (!actionDialog) return;
    const request: ErpAction = { ...actionDialog.request, evidence };
    setActionError(null);
    setPendingAction(request.id);
    try {
      const response = await fetch('/api/erp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(request),
      });
      assertSessionResponse(response);
      const result = await response.json() as { message?: string };
      if (!response.ok) {
        setActionError(result.message ?? '서버가 업무 처리를 거절했습니다.');
        if (selectedTenantRef.current === request.tenant) setConnected(true);
        void refreshTenant(request.tenant);
        return;
      }
      updateLocalStatus(request);
      setActionDialog(null);
      window.requestAnimationFrame(() => {
        setNotice({ title: '처리 완료', message: result.message ?? '업무 처리가 완료되었습니다.', tone: 'success' });
      });
      if (selectedTenantRef.current === request.tenant) setConnected(true);
      void refreshTenant(request.tenant);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return;
      }
      if (selectedTenantRef.current === request.tenant) setConnected(false);
      setActionError(`서버에 연결할 수 없어 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleNetworkMutation = async (mutation: NetworkMutation): Promise<NetworkMutationResult> => {
    if (mutation.tenant !== selectedTenantRef.current || data.tenant.code !== selectedTenantRef.current) {
      return { ok: false, message: '회사 데이터가 전환 중입니다. 로딩이 끝난 뒤 다시 시도해 주세요.' };
    }
    const pendingId = mutation.module === 'partners'
      ? mutation.action === 'connect' ? 'partner-connect' : mutation.id
      : mutation.module === 'bids'
        ? 'bid-create'
        : mutation.module === 'bid-target-areas'
          ? 'bid-target-areas-set'
          : mutation.action === 'create' ? 'channel-order-create' : mutation.id;
    const requestBody = JSON.stringify(mutation);
    let idempotencyKey = networkIdempotencyKeysRef.current.get(requestBody);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      networkIdempotencyKeysRef.current.set(requestBody, idempotencyKey);
    }
    setPendingAction(pendingId);
    try {
      const response = await fetch('/api/erp/network', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: requestBody,
      });
      assertSessionResponse(response);
      const decoded: unknown = await response.json().catch(() => null);
      if (!isRecord(decoded) || typeof decoded.ok !== 'boolean' || typeof decoded.message !== 'string') {
        return { ok: false, message: '서버의 거래망 처리 응답을 확인할 수 없습니다.' };
      }
      const result = decoded as unknown as NetworkMutationResult;
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        return { ok: false, message: result.message };
      }
      if (networkIdempotencyKeysRef.current.get(requestBody) === idempotencyKey) {
        networkIdempotencyKeysRef.current.delete(requestBody);
      }
      if (!response.ok || !result.ok) {
        if (selectedTenantRef.current === mutation.tenant) setConnected(true);
        return { ok: false, message: result.message };
      }
      if (selectedTenantRef.current === mutation.tenant) setConnected(true);
      await refreshTenant(mutation.tenant);
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return { ok: false, message: '로그인 세션이 만료되었습니다.' };
      }
      if (selectedTenantRef.current === mutation.tenant) setConnected(false);
      return {
        ok: false,
        message: `서버에 연결할 수 없어 거래망 업무를 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`,
      };
    } finally {
      setPendingAction(null);
    }
  };

  const handleProductMutation = async (mutation: ProductMutation): Promise<ProductMutationResult> => {
    if (mutation.tenant !== selectedTenantRef.current || data.tenant.code !== selectedTenantRef.current) {
      return { ok: false, message: '회사 데이터가 전환 중입니다. 로딩이 끝난 뒤 다시 시도해 주세요.' };
    }
    const pendingId = mutation.action === 'create' ? 'product-create' : mutation.id;
    setPendingAction(pendingId);
    try {
      const response = await fetch('/api/erp/products', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(mutation),
      });
      assertSessionResponse(response);
      const result = await response.json() as ProductMutationResult;
      if (!response.ok || !result.ok || !result.product) {
        if (selectedTenantRef.current === mutation.tenant) setConnected(true);
        void refreshTenant(mutation.tenant);
        return { ok: false, message: result.message ?? '서버가 상품 처리를 거절했습니다.' };
      }

      const updatedProduct = result.product;
      setData((current) => {
        if (current.tenant.code !== mutation.tenant || selectedTenantRef.current !== mutation.tenant) return current;
        const exists = current.products.some((product) => product.id === updatedProduct.id);
        return {
          ...current,
          products: exists
            ? current.products.map((product) => product.id === updatedProduct.id ? updatedProduct : product)
            : [...current.products, updatedProduct],
          };
      });
      setProductPrices((current) => {
        if (selectedTenantRef.current !== mutation.tenant) return current;
        const next = new Map(current.map((price) => [price.productId, price]));
        if (mutation.action === 'create') {
          if (!result.createdPriceMonth || !isPriceMonth(result.createdPriceMonth)) return current;
          next.set(updatedProduct.id, createdProductPriceSnapshot(
            updatedProduct.id,
            updatedProduct,
            priceMonthRef.current,
            result.createdPriceMonth,
            updatedProduct.updatedAt,
          ));
        } else {
          const existing = next.get(updatedProduct.id);
          if (existing?.priceInherited && existing.priceSourceMonth === null) {
            next.set(updatedProduct.id, {
              ...existing,
              ...productPriceValues(updatedProduct),
              priceSourceVersion: updatedProduct.version,
              updatedAt: updatedProduct.updatedAt,
            });
          }
        }
        return [...next.values()];
      });
      if (mutation.action === 'create' && (!result.createdPriceMonth || !isPriceMonth(result.createdPriceMonth))) {
        setPriceLoadError('새 상품의 월별 단가 기준월을 확인할 수 없어 단가 편집을 잠시 중지했습니다.');
      }
      if (selectedTenantRef.current === mutation.tenant) setConnected(true);
      void refreshTenant(mutation.tenant);
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return { ok: false, message: '로그인 세션이 만료되었습니다.' };
      }
      if (selectedTenantRef.current === mutation.tenant) setConnected(false);
      return {
        ok: false,
        message: `서버에 연결할 수 없어 상품을 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`,
      };
    } finally {
      setPendingAction(null);
    }
  };

  const handleProductBulkMutation = async (
    request: BulkProductRequest,
    idempotencyKey: string,
  ): Promise<BulkProductMutationResult> => {
    if (request.tenant !== selectedTenantRef.current || data.tenant.code !== selectedTenantRef.current) {
      return bulkProductFailure('회사 데이터가 전환 중입니다. 로딩이 끝난 뒤 다시 시도해 주세요.', request.rows.length);
    }

    // Prevent an older full-data refresh from overwriting this batch after it
    // commits. The successful acknowledgement below is authoritative.
    loadGenerationRef.current += 1;
    setPendingAction('product-bulk');
    try {
      const response = await fetch('/api/erp/products/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(request),
      });
      assertSessionResponse(response);
      const result = await response.json() as Partial<BulkProductMutationResult>;
      if (!response.ok || !result.ok) {
        if (selectedTenantRef.current === request.tenant) setConnected(true);
        void refreshTenant(request.tenant);
        if (result.summary && result.rows) return result as BulkProductMutationResult;
        return bulkProductFailure(result.message ?? '서버가 엑셀 일괄 처리를 거절했습니다.', request.rows.length);
      }
      if (!result.summary || !result.rows) {
        return bulkProductFailure('서버의 엑셀 일괄 처리 응답을 확인할 수 없습니다.', request.rows.length);
      }

      if (selectedTenantRef.current === request.tenant) setConnected(true);
      const reconciledProducts = reconcileBulkProducts(data.products, request, result as BulkProductMutationResult);
      if (reconciledProducts) {
        setData((current) => (
          current.tenant.code === request.tenant && selectedTenantRef.current === request.tenant
            ? { ...current, products: reconciledProducts }
            : current
        ));
        setProductPrices((current) => {
          if (
            selectedTenantRef.current !== request.tenant
            || !result.appliedAt
            || !result.createdProductIds
            || (result.createdProductIds.length > 0 && (!result.createdPriceMonth || !isPriceMonth(result.createdPriceMonth)))
          ) return current;
          const selectedMonth = priceMonthRef.current;
          const next = new Map(current.map((price) => [price.productId, price]));
          let createdIndex = 0;
          for (const row of request.rows) {
            const productId = row.action === 'create'
              ? result.createdProductIds[createdIndex++]
              : row.id;
            if (!productId) return current;
            const existing = next.get(productId);
            if (row.action === 'update' && (!existing?.priceInherited || existing.priceSourceMonth !== null)) continue;
            if (row.action === 'create') {
              next.set(productId, createdProductPriceSnapshot(
                productId,
                row.product,
                selectedMonth,
                result.createdPriceMonth as PriceMonth,
                result.appliedAt,
              ));
            } else {
              if (!existing || !existing.priceInherited || existing.priceSourceMonth !== null) continue;
              const updatedFallback: ProductPriceSnapshot = {
                ...existing,
                ...productPriceValues(row.product),
                priceSourceVersion: row.expectedVersion + 1,
                updatedAt: result.appliedAt,
              };
              next.set(productId, updatedFallback);
            }
          }
          return [...next.values()];
        });
      } else {
        const importedProducts = result.rows.flatMap((row) => row.product ? [row.product] : []);
        if (importedProducts.length > 0) {
          setData((current) => {
            if (current.tenant.code !== request.tenant || selectedTenantRef.current !== request.tenant) return current;
            const nextProducts = new Map(current.products.map((product) => [product.id, product]));
            importedProducts.forEach((product) => nextProducts.set(product.id, product));
            return { ...current, products: [...nextProducts.values()] };
          });
        }
        // Compatibility fallback for an old or incomplete acknowledgement.
        // Re-fetch even after a temporary detail merge so a stale replay cannot
        // overwrite a newer local version. Do not delay the result modal.
        void refreshTenant(request.tenant);
      }
      return result as BulkProductMutationResult;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return bulkProductFailure('로그인 세션이 만료되었습니다.', request.rows.length);
      }
      if (selectedTenantRef.current === request.tenant) setConnected(false);
      return bulkProductFailure(
        `서버에 연결할 수 없어 상품을 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`,
        request.rows.length,
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleProductPriceMutation = async (
    mutation: ProductPriceMutation,
  ): Promise<ProductPriceMutationResult> => {
    if (
      mutation.tenant !== selectedTenantRef.current
      || mutation.priceMonth !== priceMonthRef.current
      || data.tenant.code !== selectedTenantRef.current
      || priceLoading
      || priceLoadError !== null
    ) {
      return { ok: false, message: '회사 또는 단가 기준월이 전환 중입니다. 로딩이 끝난 뒤 다시 시도해 주세요.' };
    }
    const pendingId = `product-price-${mutation.productId}`;
    const generation = ++loadGenerationRef.current;
    setPendingAction(pendingId);
    try {
      const response = await fetch('/api/erp/products/prices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(mutation),
      });
      assertSessionResponse(response);
      const decoded: unknown = await response.json();
      if (!response.ok || !isRecord(decoded) || decoded.ok !== true || !decoded.productPrice) {
        return {
          ok: false,
          message: isRecord(decoded) && typeof decoded.message === 'string'
            ? decoded.message
            : '서버가 월별 단가 처리를 거절했습니다.',
        };
      }
      const updatedPrice = parseProductPriceSnapshot(decoded.productPrice, mutation.priceMonth);
      if (
        updatedPrice.productId !== mutation.productId
        || updatedPrice.priceInherited
        || updatedPrice.priceVersion !== mutation.expectedVersion + 1
      ) throw new Error('서버의 월별 단가 저장 응답이 요청과 일치하지 않습니다.');
      const result: ProductPriceMutationResult = {
        ok: true,
        message: typeof decoded.message === 'string' ? decoded.message : '월별 단가를 저장했습니다.',
        productPrice: updatedPrice,
      };
      setProductPrices((current) => {
        if (
          generation !== loadGenerationRef.current
          || priceLoadError !== null
          || selectedTenantRef.current !== mutation.tenant
          || priceMonthRef.current !== mutation.priceMonth
        ) return current;
        const next = new Map(current.map((price) => [price.productId, price]));
        next.set(updatedPrice.productId, updatedPrice);
        return [...next.values()];
      });
      if (
        generation === loadGenerationRef.current
        && selectedTenantRef.current === mutation.tenant
        && priceMonthRef.current === mutation.priceMonth
      ) setConnected(true);
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return { ok: false, message: '로그인 세션이 만료되었습니다.' };
      }
      if (
        generation === loadGenerationRef.current
        && selectedTenantRef.current === mutation.tenant
        && priceMonthRef.current === mutation.priceMonth
      ) setConnected(false);
      return {
        ok: false,
        message: `서버에 연결할 수 없어 월별 단가를 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`,
      };
    } finally {
      setPendingAction((current) => current === pendingId ? null : current);
    }
  };

  const handleProductPriceBulkMutation = async (
    request: BulkProductPriceRequest,
    idempotencyKey: string,
  ): Promise<BulkProductPriceMutationResult> => {
    if (
      request.tenant !== selectedTenantRef.current
      || request.priceMonth !== priceMonthRef.current
      || data.tenant.code !== selectedTenantRef.current
      || priceLoading
      || priceLoadError !== null
    ) {
      return bulkProductPriceFailure(
        '회사 또는 단가 기준월이 전환 중입니다. 로딩이 끝난 뒤 다시 시도해 주세요.',
        request.rows.length,
      );
    }

    const generation = ++loadGenerationRef.current;
    setPendingAction('product-price-bulk');
    try {
      const response = await fetch('/api/erp/products/prices/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(request),
      });
      assertSessionResponse(response);
      const result = await response.json() as Partial<BulkProductPriceMutationResult>;
      if (!response.ok || !result.ok || !result.summary || !result.rows) {
        if (result.summary && result.rows) return result as BulkProductPriceMutationResult;
        return bulkProductPriceFailure(result.message ?? '서버가 월별 단가 일괄 처리를 거절했습니다.', request.rows.length);
      }

      const expectedCreated = request.rows.reduce(
        (count, row) => count + (row.expectedVersion === 0 ? 1 : 0),
        0,
      );
      const expectedUpdated = request.rows.length - expectedCreated;
      const requestRowsByNumber = new Map(request.rows.map((row) => [row.rowNumber, row]));
      const returnedRowsValid = result.rows.length === 0 || (
        result.rows.length === request.rows.length
        && result.rows.every((row) => {
          const requested = requestRowsByNumber.get(row.rowNumber);
          return requested !== undefined
            && row.status === (requested.expectedVersion === 0 ? 'created' : 'updated');
        })
      );
      const rowDetailsValid = !result.rowDetails || (
        result.rowDetails.included === result.rows.length
        && result.rowDetails.total === request.rows.length
        && result.rowDetails.omitted === request.rows.length - result.rows.length
        && result.rowDetails.truncated === (result.rows.length < request.rows.length)
      );
      const validCompactAck = Boolean(
        result.appliedAt
        && !Number.isNaN(Date.parse(result.appliedAt))
        && result.summary.total === request.rows.length
        && result.summary.created === expectedCreated
        && result.summary.updated === expectedUpdated
        && result.summary.failed === 0
        && result.summary.notApplied === 0
        && returnedRowsValid
        && rowDetailsValid,
      );
      if (validCompactAck) {
        const appliedAt = result.appliedAt as string;
        setProductPrices((current) => {
          if (
            generation !== loadGenerationRef.current
            || selectedTenantRef.current !== request.tenant
            || priceMonthRef.current !== request.priceMonth
          ) return current;
          const next = new Map(current.map((price) => [price.productId, price]));
          for (const row of request.rows) {
            next.set(row.productId, {
              productId: row.productId,
              ...row.prices,
              priceMonth: request.priceMonth,
              priceSourceMonth: request.priceMonth,
              priceSourceVersion: row.expectedVersion + 1,
              priceInherited: false,
              priceVersion: row.expectedVersion + 1,
              updatedAt: appliedAt,
            });
          }
          return [...next.values()];
        });
      } else {
        const fallbackLoadingGeneration = ++priceLoadingGenerationRef.current;
        setPriceLoading(true);
        void fetchProductPrices(request.tenant, request.priceMonth).then((prices) => {
          assertProductPriceCoverage(data.products, prices, request.priceMonth);
          if (
            selectedTenantRef.current === request.tenant
            && priceMonthRef.current === request.priceMonth
            && generation === loadGenerationRef.current
          ) {
            setProductPrices(prices);
            setPriceLoadError(null);
            setRefreshError(null);
          }
        }).catch((error) => {
          if (error instanceof SessionExpiredError) {
            onSessionExpired(error.message);
            return;
          }
          if (
            selectedTenantRef.current === request.tenant
            && priceMonthRef.current === request.priceMonth
            && generation === loadGenerationRef.current
          ) {
            console.warn('Product monthly prices could not be verified after bulk mutation', error);
            setPriceLoadError('저장은 완료됐지만 최신 월별 단가를 다시 확인하지 못했습니다. 단가 조회를 다시 시도해 주세요.');
            setRefreshError('월별 단가 저장 결과를 서버에서 다시 확인하지 못했습니다. 마지막으로 확인한 단가를 유지합니다.');
          }
        }).finally(() => {
          if (
            fallbackLoadingGeneration === priceLoadingGenerationRef.current
            && selectedTenantRef.current === request.tenant
            && priceMonthRef.current === request.priceMonth
          ) setPriceLoading(false);
        });
      }
      if (
        generation === loadGenerationRef.current
        && selectedTenantRef.current === request.tenant
        && priceMonthRef.current === request.priceMonth
      ) setConnected(true);
      return result as BulkProductPriceMutationResult;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error.message);
        return bulkProductPriceFailure('로그인 세션이 만료되었습니다.', request.rows.length);
      }
      if (
        generation === loadGenerationRef.current
        && selectedTenantRef.current === request.tenant
        && priceMonthRef.current === request.priceMonth
      ) setConnected(false);
      return bulkProductPriceFailure(
        `서버에 연결할 수 없어 월별 단가를 반영하지 못했습니다. ${error instanceof Error ? error.message : '연결 오류'}`,
        request.rows.length,
      );
    } finally {
      setPendingAction(null);
    }
  };

  const confirmLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const decoded: unknown = await response.json().catch(() => null);
      if (!response.ok && response.status !== 401) {
        throw new Error(isRecord(decoded) && typeof decoded.message === 'string'
          ? decoded.message
          : '로그아웃하지 못했습니다.');
      }
      setLogoutDialogOpen(false);
      onSessionExpired('로그아웃되었습니다. 다른 ERP 계정으로 로그인할 수 있습니다.');
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : '로그아웃하지 못했습니다.');
    } finally {
      setLoggingOut(false);
    }
  };

  const handleExport = () => {
    if (activeModule === 'products' && (priceLoading || priceLoadError)) {
      setNotice({
        title: '월별 단가 확인 필요',
        message: priceLoadError ?? '월별 단가를 불러오는 중입니다. 완료된 뒤 다시 시도해 주세요.',
        tone: 'error',
      });
      return;
    }
    const pricesByProductId = new Map(productPrices.map((price) => [price.productId, price]));
    const source = activeModule === 'products' ? data.products.map((product) => {
      const price = pricesByProductId.get(product.id);
      return price ? { ...product, ...price, id: product.id, priceMonth } : { ...product, priceMonth };
    })
      : activeModule === 'partners' ? data.partners
        : activeModule === 'bids' ? data.schoolBids
          : activeModule === 'channel-orders' ? data.channelOrders
            : activeModule === 'meals' ? data.mealPlans
              : activeModule === 'purchasing' ? data.purchaseOrders
                : activeModule === 'inventory' ? data.inventoryLots
                  : activeModule === 'production' ? data.productionOrders
                    : activeModule === 'delivery' ? data.deliveries
                      : activeModule === 'settlement' ? data.settlements
                        : activeModule === 'haccp' ? data.haccpChecks
                          : [{ ...data.metrics, ...data.networkMetrics }];
    const headers = Object.keys(source[0] ?? {});
    const rows = source.map((record) => headers.map((header) => JSON.stringify((record as unknown as Record<string, unknown>)[header] ?? '')).join(','));
    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    const dateStamp = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()).replaceAll('-', '');
    anchor.download = `${data.tenant.code.toLowerCase()}-${activeModule}-${activeModule === 'products' ? `${priceMonth}-` : ''}${dateStamp}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ title: 'CSV 저장 완료', message: '현재 화면의 데이터를 CSV 파일로 내려받았습니다.', tone: 'success' });
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (desktopNavigation || !mobileMenuOpen || event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const operationalAlertCount = data.metrics.pendingOrders
    + data.metrics.inventoryAlerts
    + data.metrics.openHaccpIssues
    + data.networkMetrics.incomingOrders;
  const partialDataUnavailable = Boolean(priceLoadError || refreshError);
  const connectionLabel = loading
    ? '서버 데이터 연결 중'
    : refreshing
      ? '서버 데이터 새로고침 중'
      : connected && !partialDataUnavailable
        ? '서버 데이터 연결됨'
        : connected
          ? '일부 서버 데이터 확인 필요'
          : '서버 연결 확인 필요';

  return (
    <main className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <a
        href="#erp-main-content"
        aria-hidden={!desktopNavigation && mobileMenuOpen}
        inert={!desktopNavigation && mobileMenuOpen}
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-[var(--ss-radius-md)] focus:bg-[var(--ss-brand)] focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-[var(--ss-on-brand)] focus:shadow-[var(--ss-shadow-lg)]"
      >
        본문 바로가기
      </a>
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="메뉴 닫기"
          className="fixed inset-0 z-30 bg-[var(--ss-overlay)] backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <aside
        id="erp-navigation"
        aria-hidden={!desktopNavigation && !mobileMenuOpen}
        inert={!desktopNavigation && !mobileMenuOpen}
        onKeyDown={handleMenuKeyDown}
        className={`erp-sidebar ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        <div className="flex h-16 items-center gap-3 border-b border-[var(--ss-border)] px-5">
          <StarSnapBrandIcon />
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[0.18em] text-[var(--ss-text-muted)]">STARSNAP ERP</p>
            <p className="truncate text-base font-semibold tracking-tight text-[var(--ss-text)]">{organizationLabel[data.tenant.organizationType]} ERP</p>
          </div>
          <button ref={menuCloseButtonRef} type="button" aria-label="메뉴 닫기" onClick={() => setMobileMenuOpen(false)} className="star-icon-button ml-auto lg:!hidden">
            <X size={20} />
          </button>
        </div>

        <div className="px-3 pt-4">
          <div aria-label={`현재 업체 ${data.tenant.name}, ${organizationLabel[data.tenant.organizationType]}`} className="flex min-h-14 items-center gap-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 py-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--ss-radius-sm)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]">
              <Building2 aria-hidden="true" size={18} />
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] font-bold tracking-[0.08em] text-[var(--ss-text-muted)]">{organizationLabel[data.tenant.organizationType]}</span>
              <span className="block truncate text-sm font-semibold text-[var(--ss-text)]">{data.tenant.name}</span>
            </span>
          </div>
        </div>

        <nav aria-label="ERP 주요 메뉴" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {availableModules.map((module) => {
            const Icon = module.icon;
            const active = module.id === activeModule;
            return (
              <button
                type="button"
                key={module.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => selectModule(module.id)}
                className={`star-nav-item ${active ? 'is-active' : ''}`}
              >
                <span className="star-nav-icon"><Icon size={18} /></span>
                {module.shortLabel}
              </button>
            );
          })}
        </nav>

        <div
          role={!loading && refreshing ? 'status' : undefined}
          aria-live={!loading && refreshing ? 'polite' : undefined}
          aria-atomic={!loading && refreshing ? 'true' : undefined}
          className="m-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] p-4"
        >
          <div className="flex items-center gap-2">
            {loading || refreshing ? (
              <span aria-hidden="true" className="h-[15px] w-[15px] animate-pulse rounded-full bg-[var(--ss-border)] motion-reduce:animate-none" />
            ) : connected && !partialDataUnavailable
              ? <Wifi aria-hidden="true" size={15} className="text-[var(--ss-success)]" />
              : <WifiOff aria-hidden="true" size={15} className="text-[var(--ss-warning)]" />}
            <p className="text-xs font-semibold text-[var(--ss-text-soft)]">{connectionLabel}</p>
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--ss-text-muted)]">현재 회사의 데이터만 분리해 표시합니다.</p>
        </div>
      </aside>

      <div
        id="erp-app-content"
        aria-hidden={!desktopNavigation && mobileMenuOpen}
        inert={!desktopNavigation && mobileMenuOpen}
        className="lg:pl-[240px]"
      >
        <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-[var(--ss-border)] bg-[var(--ss-header-bg)] px-4 shadow-[var(--ss-shadow-sm)] backdrop-blur-xl sm:px-6 lg:px-8">
          <button ref={menuButtonRef} type="button" aria-label="메뉴 열기" aria-expanded={mobileMenuOpen} aria-controls="erp-navigation" onClick={() => setMobileMenuOpen(true)} className="star-icon-button lg:!hidden">
            <Menu size={21} />
          </button>
          <div className="hidden min-w-0 sm:block">
            <p className="text-[11px] font-bold tracking-[0.12em] text-[var(--ss-text-muted)]">STARSNAP ERP</p>
            <p className="truncate text-sm font-semibold">{activeDefinition.label}</p>
          </div>
          <div className="ml-auto hidden w-full max-w-[360px] md:block">
            <ModuleSearchCombobox
              modules={availableModules}
              activeModule={activeModule}
              disabled={loading}
              onSelect={selectModule}
            />
          </div>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              aria-label={loading ? '운영 알림 불러오는 중' : `운영 알림 ${operationalAlertCount}건 열기`}
              aria-haspopup="dialog"
              disabled={loading}
               onClick={() => setNotice({
                 title: '운영 알림',
                 message: `거래망 수신 발주 ${data.networkMetrics.incomingOrders}건\n내부 발주 승인 대기 ${data.metrics.pendingOrders}건\n재고 주의 ${data.metrics.inventoryAlerts}건\nHACCP 시정조치 ${data.metrics.openHaccpIssues}건`,
                 tone: 'info',
              })}
              className="star-icon-button relative"
            >
              <Bell size={19} />
              {!loading && operationalAlertCount > 0 && (
                <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--ss-danger)] ring-2 ring-[var(--ss-surface)]" />
              )}
            </button>
            <div className="flex min-h-11 min-w-0 shrink items-center gap-2 rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] bg-[var(--ss-surface)] px-2.5 text-left shadow-[var(--ss-shadow-sm)] sm:px-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--ss-brand-soft)] text-xs font-bold text-[var(--ss-on-brand)]">{avatarLabel}</span>
              <span className="hidden min-w-0 sm:block">
                <span className="block max-w-32 truncate text-xs font-semibold">{session.user.username}</span>
                <span className="block max-w-40 truncate text-[10px] text-[var(--ss-text-muted)]">{organizationLabel[data.tenant.organizationType]} · {roleLabel}</span>
              </span>
            </div>
            <button
              type="button"
              aria-label={`${session.user.username} 계정 로그아웃`}
              aria-haspopup="dialog"
              onClick={() => {
                setLogoutError(null);
                setLogoutDialogOpen(true);
              }}
              className="star-icon-button star-icon-button-danger"
            >
              <LogOut aria-hidden="true" size={19} />
            </button>
          </div>
        </header>

        <section id="erp-main-content" tabIndex={-1} className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          <div className="mb-5 flex flex-col gap-3 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="eyebrow">{organizationLabel[data.tenant.organizationType]} WORKSPACE</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight">{activeDefinition.label}</h1>
              <p className="mt-1 text-sm text-[var(--ss-text-subtle)]">{data.tenant.name} · 2026년 8월 23일 일요일</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {siteFilteredModules.has(activeModule) ? (
                <>
                  <label className="sr-only" htmlFor="site-filter">사업장 필터</label>
                  <select id="site-filter" value={siteFilter} disabled={loading} onChange={(event) => setSiteFilter(event.target.value)} className="star-control px-3 text-sm font-semibold">
                    <option value="ALL">전체 사업장</option>
                    {data.sites.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}
                  </select>
                </>
              ) : null}
              <button type="button" onClick={handleExport} disabled={loading || (activeModule === 'products' && (priceLoading || priceLoadError !== null))} className="star-secondary-button text-sm">
                <Download size={17} /> CSV
              </button>
            </div>
          </div>

          {!loading && refreshError ? (
            <div role="alert" className="mb-4 flex flex-col gap-3 rounded-[var(--ss-radius-md)] border border-[var(--ss-warning-border)] bg-[var(--ss-warning-soft)] px-4 py-3 text-sm text-[var(--ss-warning-strong)] sm:flex-row sm:items-center sm:justify-between">
              <p className="font-medium leading-6">{refreshError}</p>
              <button
                type="button"
                disabled={refreshing || Boolean(pendingAction)}
                onClick={() => void refreshTenant(selectedTenantRef.current)}
                className="star-secondary-button shrink-0 px-4 text-sm"
              >
                <RotateCw aria-hidden="true" size={16} /> 다시 시도
              </button>
            </div>
          ) : null}

          {loadError ? (
            <div role="alert" className="panel mx-auto max-w-2xl text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-[var(--ss-radius-md)] bg-[var(--ss-warning-soft)] text-[var(--ss-warning-strong)]">
                <WifiOff aria-hidden="true" size={22} />
              </span>
              <h2 className="mt-4 text-lg font-semibold">ERP 데이터를 표시할 수 없습니다</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--ss-text-subtle)]">{loadError}</p>
              <button type="button" onClick={() => window.location.reload()} className="star-primary-button mt-5 px-5 text-sm">
                <RotateCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            </div>
          ) : (
            <ModuleView
              activeModule={activeModule}
              data={data}
              selectedTenant={tenantCode}
              priceMonth={priceMonth}
              productPrices={productPrices}
              priceLoading={priceLoading}
              priceLoadError={priceLoadError}
              loading={loading}
              pendingAction={pendingAction}
              searchQuery=""
              siteFilter={siteFilter}
              membershipRole={membership.role}
              onAction={requestAction}
              onNavigate={selectModule}
              onNetworkMutate={handleNetworkMutation}
              onProductMutate={handleProductMutation}
              onProductBulkMutate={handleProductBulkMutation}
              onProductPriceMonthChange={changePriceMonth}
              onProductPriceMutate={handleProductPriceMutation}
              onProductPriceBulkMutate={handleProductPriceBulkMutation}
              onNotice={setNotice}
            />
          )}
        </section>
      </div>

      <WorkflowActionModal
        key={actionDialog?.request.id ?? 'closed-action-dialog'}
        request={actionDialog?.request ?? null}
        itemLabel={actionDialog?.itemLabel ?? ''}
        haccpCheck={actionDialog?.request.module === 'haccp'
          ? data.haccpChecks.find((item) => item.id === actionDialog.request.id)
          : undefined}
        busy={Boolean(pendingAction && actionDialog?.request.id === pendingAction)}
        error={actionError}
        onClose={() => {
          if (!pendingAction) {
            setActionDialog(null);
            setActionError(null);
          }
        }}
        onSubmit={submitAction}
      />
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
      <AccessibleModal
        open={logoutDialogOpen}
        title="로그아웃"
        description="현재 ERP를 종료하고 다른 계정으로 로그인할 수 있습니다."
        busy={loggingOut}
        dismissOnBackdrop={!loggingOut}
        fallbackFocusSelector="#erp-main-content"
        onRequestClose={() => {
          if (!loggingOut) {
            setLogoutDialogOpen(false);
            setLogoutError(null);
          }
        }}
        size="small"
      >
        <div className="px-5 py-6 sm:px-6">
          <p className="text-sm leading-6 text-[var(--ss-text-soft)]">
            <strong>{session.user.username}</strong> 계정에서 로그아웃하시겠습니까?
          </p>
          {logoutError ? <p role="alert" className="mt-3 text-sm font-medium text-[var(--ss-danger)]">{logoutError}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-4 sm:px-6">
          <button
            type="button"
            data-modal-initial-focus
            disabled={loggingOut}
            onClick={() => {
              setLogoutDialogOpen(false);
              setLogoutError(null);
            }}
            className="star-secondary-button px-4 text-sm"
          >
            취소
          </button>
          <button type="button" disabled={loggingOut} onClick={() => void confirmLogout()} className="star-primary-button px-4 text-sm">
            {loggingOut ? '로그아웃 중…' : '로그아웃'}
          </button>
        </div>
      </AccessibleModal>
    </main>
  );
}
