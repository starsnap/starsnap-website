import type { BidAreaCode, BidRegionCode } from './bid-regions';

// Tenant codes are created when a company signs up. Runtime boundaries must
// validate them with normalizeTenantCode before treating a string as a code.
export type TenantCode = string;
export type OrganizationType = 'BRAND' | 'DEALER' | 'BIDDER';
export type ModuleId =
  | 'dashboard'
  | 'partners'
  | 'bids'
  | 'channel-orders'
  | 'products'
  | 'meals'
  | 'purchasing'
  | 'inventory'
  | 'production'
  | 'delivery'
  | 'settlement';
export type ProductStatus = 'ACTIVE' | 'INACTIVE';
export type ProductStorageType = 'AMBIENT' | 'CHILLED' | 'FROZEN';
export type ProductUnit = 'KG' | 'G' | 'EA' | 'BOX' | 'PACK' | 'L' | 'BAG';
export type ProductSearchMode = 'SMART' | 'TRIGRAM' | 'VECTOR';
export type ProductSearchReason = 'EXACT_SKU' | 'EXACT_NAME' | 'CONTAINS' | 'NAME_TRIGRAM' | 'VECTOR_SIMILAR';
type PriceMonthNumber = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12';
export type PriceMonth = `${number}-${PriceMonthNumber}`;

export interface TenantSummary {
  id: string;
  code: TenantCode;
  name: string;
  brandColor: string;
  organizationType: OrganizationType;
}

export interface SiteSummary {
  id: string;
  name: string;
  type: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  specification: string;
  unit: ProductUnit;
  schoolPriceKg: number;
  schoolPriceSpec: number;
  schoolPriceEach: number;
  vendorPriceKg: number;
  vendorPriceSpec: number;
  vendorPriceEach: number;
  purchasePriceKg: number;
  purchasePriceSpec: number;
  purchasePriceEach: number;
  supplierName: string;
  storageType: ProductStorageType;
  allergens: string;
  status: ProductStatus;
  version: number;
  updatedAt: string;
}

export type ProductInput = Omit<Product, 'id' | 'status' | 'version' | 'updatedAt'>;

export type ProductMutation = {
  tenant: TenantCode;
  module: 'products';
} & (
  | { action: 'create'; product: ProductInput }
  | { action: 'update'; id: string; expectedVersion: number; product: ProductInput }
  | { action: 'set-status'; id: string; expectedVersion: number; status: ProductStatus }
);

export interface ProductMutationResult {
  ok: boolean;
  message: string;
  product?: Product;
  alreadyApplied?: boolean;
  vectorization?: ProductVectorizationStatus;
  /** KST month used by the product-create trigger for its initial exact price. */
  createdPriceMonth?: PriceMonth;
}

export interface ProductVectorizationStatus {
  mode: 'ASYNC';
  status: 'QUEUED' | 'NOT_REQUIRED';
  queued: number;
  targetVersion?: number;
  statusUrl?: string;
}

export interface ProductSearchItem {
  productId: string;
  /** Authoritative product snapshot used to render this search result. */
  product: Product;
  /** A mode-specific ranking score in the 0..1 range. */
  score: number;
  trigramScore: number;
  vectorScore: number;
  reason: ProductSearchReason;
}

export interface ProductSearchResponse {
  tenant: TenantCode;
  query: string;
  /** Search mode requested by the caller. */
  mode: ProductSearchMode;
  /** Mode actually used after applying a safe runtime fallback. */
  executionMode: ProductSearchMode;
  vectorStatus: 'USED' | 'NOT_REQUESTED' | 'UNAVAILABLE';
  total: number;
  page: number;
  pageSize: number;
  model: string;
  items: ProductSearchItem[];
}

export type BulkProductRow =
  | { rowNumber: number; action: 'create'; product: ProductInput }
  | { rowNumber: number; action: 'update'; id: string; expectedVersion: number; product: ProductInput };

export interface BulkProductRequest {
  schemaVersion: 2;
  tenant: TenantCode;
  source: {
    fileName: string;
    fileSha256: string;
  };
  rows: BulkProductRow[];
}

interface ProductPriceSnapshotBase extends ProductPriceValues {
  productId: string;
  priceMonth: PriceMonth;
  /** Version of the exact monthly row or Product base row supplying the values. */
  priceSourceVersion: number;
  updatedAt: string;
}

export type ProductPriceSnapshot = ProductPriceSnapshotBase & (
  | {
      priceSourceMonth: PriceMonth;
      priceInherited: false;
      priceVersion: number;
    }
  | {
      priceSourceMonth: PriceMonth | null;
      /** True when the selected month carries forward an earlier/default price. */
      priceInherited: true;
      priceVersion: 0;
    }
);

export interface ProductPriceSnapshotResult {
  tenant: TenantCode;
  priceMonth: PriceMonth;
  products: ProductPriceSnapshot[];
}

export type ProductPriceValues = Pick<
  Product,
  | 'schoolPriceKg'
  | 'schoolPriceSpec'
  | 'schoolPriceEach'
  | 'vendorPriceKg'
  | 'vendorPriceSpec'
  | 'vendorPriceEach'
  | 'purchasePriceKg'
  | 'purchasePriceSpec'
  | 'purchasePriceEach'
>;

export interface ProductPriceMutation {
  tenant: TenantCode;
  module: 'product-prices';
  action: 'upsert';
  productId: string;
  priceMonth: PriceMonth;
  expectedVersion: number;
  expectedSourceMonth: PriceMonth | null;
  expectedSourceVersion: number;
  prices: ProductPriceValues;
}

export interface ProductPriceMutationResult {
  ok: boolean;
  message: string;
  productPrice?: ProductPriceSnapshot;
}

export interface BulkProductPriceRow {
  rowNumber: number;
  productId: string;
  expectedVersion: number;
  expectedSourceMonth: PriceMonth | null;
  expectedSourceVersion: number;
  prices: ProductPriceValues;
}

export interface BulkProductPriceRequest {
  schemaVersion: 2;
  tenant: TenantCode;
  priceMonth: PriceMonth;
  source: {
    fileName: string;
    fileSha256: string;
  };
  rows: BulkProductPriceRow[];
}

export interface BulkProductPriceRowResult {
  rowNumber: number;
  status: 'created' | 'updated' | 'error' | 'not_applied';
  productPrice?: ProductPriceSnapshot;
  errors?: BulkProductRowError[];
}

export interface BulkProductPriceMutationResult {
  ok: boolean;
  message: string;
  summary: {
    total: number;
    created: number;
    updated: number;
    failed: number;
    notApplied: number;
  };
  rowDetails?: {
    included: number;
    total: number;
    omitted: number;
    truncated: boolean;
  };
  appliedAt?: string;
  rows: BulkProductPriceRowResult[];
}

export type BulkProductErrorCode =
  | 'INVALID_VALUE'
  | 'DUPLICATE_ROW_NUMBER'
  | 'DUPLICATE_SKU_IN_FILE'
  | 'DUPLICATE_PRODUCT_ID_IN_FILE'
  | 'PRODUCT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'SKU_ALREADY_EXISTS'
  | 'BATCH_NOT_APPLIED';

export interface BulkProductRowError {
  field?: string;
  code: BulkProductErrorCode;
  message: string;
}

export interface BulkProductRowResult {
  rowNumber: number;
  action: 'create' | 'update';
  status: 'created' | 'updated' | 'error' | 'not_applied';
  product?: Product;
  errors?: BulkProductRowError[];
}

export interface BulkProductMutationResult {
  ok: boolean;
  message: string;
  vectorization?: ProductVectorizationStatus;
  summary: {
    total: number;
    created: number;
    updated: number;
    failed: number;
    notApplied: number;
  };
  rowDetails?: {
    included: number;
    total: number;
    omitted: number;
    truncated: boolean;
  };
  /** Commit timestamp shared by every product applied in a successful batch. */
  appliedAt?: string;
  /**
   * Server-generated IDs for create rows, in the same relative order as the
   * create rows in the request. This compact acknowledgement lets clients
   * reconcile large batches without downloading the full product master.
   */
  createdProductIds?: string[];
  /** KST month used by product-create triggers for every created row in this batch. */
  createdPriceMonth?: PriceMonth;
  /**
   * Successful batches up to 500 rows include products; larger successes omit
   * them. Every failure includes only actual errors, capped at 200 rows.
   * summary and rowDetails always describe omissions for the full batch.
   */
  rows: BulkProductRowResult[];
}

export interface MealPlan {
  id: string;
  siteName: string;
  serviceDate: string;
  mealType: string;
  menuName: string;
  plannedServings: number;
  actualServings: number | null;
  allergens: string;
  status: string;
}

export interface PurchaseOrder {
  id: string;
  orderNo: string;
  siteName: string;
  supplierName: string;
  deliveryDate: string;
  totalAmount: number;
  itemCount: number;
  status: string;
}

export type PartnerRelationshipType = 'BRAND_DEALER' | 'DEALER_BIDDER';
export type PartnerRelationshipStatus = 'ACTIVE' | 'INACTIVE';

export interface PartnerRelationship {
  id: string;
  type: PartnerRelationshipType;
  partner: TenantSummary;
  region: string | null;
  regionCodes: BidRegionCode[];
  areaCodes: BidAreaCode[];
  status: PartnerRelationshipStatus;
  createdAt: string;
  updatedAt: string;
}

export type SchoolBidStatus = 'AWARDED' | 'ACTIVE' | 'CLOSED';

export interface SchoolBid {
  id: string;
  schoolId: string | null;
  bidNo: string;
  schoolName: string;
  schoolAddress: string | null;
  title: string;
  region: string;
  regionCode: BidRegionCode | null;
  areaCode: BidAreaCode | null;
  awardedAt: string;
  contractStart: string;
  contractEnd: string;
  contractAmount: number;
  status: SchoolBidStatus;
  bidder: TenantSummary;
}

export type ChannelOrderDirection = 'BIDDER_TO_DEALER' | 'DEALER_TO_BRAND';
export type ChannelOrderStatus = 'REQUESTED' | 'ACCEPTED' | 'SHIPPED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

export interface ChannelOrder {
  id: string;
  orderNo: string;
  direction: ChannelOrderDirection;
  buyer: TenantSummary;
  supplier: TenantSummary;
  schoolBidId: string | null;
  schoolBidNo: string | null;
  schoolName: string | null;
  deliveryDate: string;
  totalAmount: number;
  itemCount: number;
  note: string;
  status: ChannelOrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryLot {
  id: string;
  siteName: string;
  ingredientName: string;
  lotNo: string;
  quantity: number;
  unit: string;
  expiresAt: string;
  location: string;
  status: string;
}

export interface ProductionOrder {
  id: string;
  siteName: string;
  serviceDate: string;
  menuName: string;
  plannedQuantity: number;
  actualQuantity: number | null;
  coreTemperature: number | null;
  status: string;
}

export interface Delivery {
  id: string;
  deliveryNo: string;
  siteName: string;
  scheduledAt: string;
  driverName: string;
  vehicleNo: string;
  servings: number;
  temperature: number | null;
  status: string;
}

export interface Settlement {
  id: string;
  siteName: string;
  settlementMonth: string;
  actualServings: number;
  salesAmount: number;
  ingredientCost: number;
  status: string;
}

export interface ErpMetrics {
  totalServings: number;
  pendingOrders: number;
  inventoryAlerts: number;
  completedDeliveries: number;
  totalDeliveries: number;
}

export interface NetworkMetrics {
  activePartners: number;
  openBids: number;
  incomingOrders: number;
  outgoingOrders: number;
}

export interface ErpData {
  tenant: TenantSummary;
  tenants: TenantSummary[];
  sites: SiteSummary[];
  metrics: ErpMetrics;
  networkMetrics: NetworkMetrics;
  bidderTargetRegionCodes: BidRegionCode[];
  bidderTargetAreaCodes: BidAreaCode[];
  partners: PartnerRelationship[];
  schoolBids: SchoolBid[];
  channelOrders: ChannelOrder[];
  products: Product[];
  mealPlans: MealPlan[];
  purchaseOrders: PurchaseOrder[];
  inventoryLots: InventoryLot[];
  productionOrders: ProductionOrder[];
  deliveries: Delivery[];
  settlements: Settlement[];
}

export interface ErpAction {
  tenant: TenantCode;
  module: 'meals' | 'purchasing' | 'inventory' | 'production' | 'delivery';
  id: string;
  action: 'confirm' | 'approve' | 'acknowledge' | 'complete';
}

export type NetworkMutation = {
  tenant: TenantCode;
} & (
  | {
      module: 'partners';
      action: 'connect';
      partnerCode: TenantCode;
      areaCodes?: BidAreaCode[];
    }
  | {
      module: 'partners';
      action: 'set-status';
      id: string;
      status: PartnerRelationshipStatus;
    }
  | {
      module: 'bids';
      action: 'create';
      bid: {
        bidNo: string;
        schoolId: string;
        title: string;
        awardedAt: string;
        contractStart: string;
        contractEnd: string;
        contractAmount: number;
      };
    }
  | {
      module: 'bid-target-areas';
      action: 'set';
      areaCodes: BidAreaCode[];
    }
  | {
      module: 'channel-orders';
      action: 'create';
      order: {
        partnerCode: TenantCode;
        schoolBidId?: string;
        deliveryDate: string;
        totalAmount: number;
        itemCount: number;
        note?: string;
      };
    }
  | {
      module: 'channel-orders';
      action: 'transition';
      id: string;
      status: ChannelOrderStatus;
    }
);

export interface NetworkMutationResult {
  ok: boolean;
  message: string;
  id?: string;
  status?: PartnerRelationshipStatus | ChannelOrderStatus;
  alreadyApplied?: boolean;
}
