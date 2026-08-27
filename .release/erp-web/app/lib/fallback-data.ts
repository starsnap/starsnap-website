import type { ErpData, TenantSummary } from './erp-types';

export type DemoTenantCode = 'HANBIT' | 'SAEBOM' | 'DAON';

export const tenantOptions: Array<TenantSummary & { code: DemoTenantCode }> = [
  { id: 'ten-hanbit', code: 'HANBIT', name: '한빛푸드', brandColor: '#17324D', organizationType: 'BIDDER' },
  { id: 'ten-saebom', code: 'SAEBOM', name: '새봄케이터링', brandColor: '#2563EB', organizationType: 'DEALER' },
  { id: 'ten-daon', code: 'DAON', name: '다온식품', brandColor: '#0F766E', organizationType: 'BRAND' },
];

const tenantSiteNames: Record<DemoTenantCode, [string, string]> = {
  HANBIT: ['한빛푸드 중앙키친', '새봄산업 구내식당'],
  SAEBOM: ['새봄케이터링 푸드랩', '가온테크 구내식당'],
  DAON: ['다온급식 중앙조리장', '두레산업 2공장'],
};

function productPrices(unit: ErpData['products'][number]['unit'], legacyUnitPrice: number) {
  return {
    schoolPriceKg: 0,
    schoolPriceSpec: 0,
    schoolPriceEach: 0,
    vendorPriceKg: 0,
    vendorPriceSpec: 0,
    vendorPriceEach: 0,
    purchasePriceKg: unit === 'KG' ? legacyUnitPrice : 0,
    purchasePriceSpec: unit !== 'KG' && unit !== 'EA' ? legacyUnitPrice : 0,
    purchasePriceEach: unit === 'EA' ? legacyUnitPrice : 0,
  };
}

export function createFallbackData(code: DemoTenantCode): ErpData {
  const tenant = tenantOptions.find((item) => item.code === code) ?? tenantOptions[0];
  const [kitchen, customer] = tenantSiteNames[code];
  const secondaryCustomer = code === 'HANBIT'
    ? '한빛전자 1공장'
    : code === 'SAEBOM'
      ? '새봄물류센터 구내식당'
      : '다온전자 2공장';
  const prefix = code.toLowerCase();

  return {
    tenant,
    tenants: tenantOptions,
    sites: [
      { id: `${prefix}-kitchen`, name: kitchen, type: 'CENTRAL_KITCHEN' },
      { id: `${prefix}-customer`, name: customer, type: 'CUSTOMER_SITE' },
      { id: `${prefix}-secondary`, name: secondaryCustomer, type: 'CUSTOMER_SITE' },
    ],
    metrics: {
      totalServings: code === 'HANBIT' ? 3240 : code === 'SAEBOM' ? 2180 : 1460,
      pendingOrders: code === 'HANBIT' ? 7 : 4,
      inventoryAlerts: code === 'DAON' ? 2 : 4,
      completedDeliveries: code === 'HANBIT' ? 18 : 11,
      totalDeliveries: code === 'HANBIT' ? 24 : 16,
      openHaccpIssues: 1,
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
    products: [
      { id: `${prefix}-product-1`, sku: 'FD-0001', name: '냉동 닭정육', category: '축산', specification: '10kg / BOX', unit: 'BOX', ...productPrices('BOX', 78000), supplierName: '푸른식품', storageType: 'FROZEN', allergens: '', status: 'ACTIVE', version: 1, updatedAt: '2026-08-23T09:00:00.000Z' },
      { id: `${prefix}-product-2`, sku: 'FD-0002', name: '두부', category: '가공식품', specification: '3kg / EA', unit: 'EA', ...productPrices('EA', 6900), supplierName: '바른식품', storageType: 'CHILLED', allergens: '대두', status: 'ACTIVE', version: 1, updatedAt: '2026-08-23T09:10:00.000Z' },
      { id: `${prefix}-product-3`, sku: 'FD-0003', name: '백미', category: '곡류', specification: '20kg / BAG', unit: 'BAG', ...productPrices('BAG', 56800), supplierName: '한결미곡', storageType: 'AMBIENT', allergens: '', status: 'ACTIVE', version: 1, updatedAt: '2026-08-23T09:20:00.000Z' },
      { id: `${prefix}-product-4`, sku: 'FD-0004', name: '양파', category: '농산', specification: '15kg / BAG', unit: 'BAG', ...productPrices('BAG', 23500), supplierName: '바른농산', storageType: 'AMBIENT', allergens: '', status: 'ACTIVE', version: 1, updatedAt: '2026-08-23T09:30:00.000Z' },
      { id: `${prefix}-product-5`, sku: 'FD-0005', name: '고등어 필렛', category: '수산', specification: '10kg / BOX', unit: 'BOX', ...productPrices('BOX', 112000), supplierName: '동해수산', storageType: 'FROZEN', allergens: '고등어', status: 'ACTIVE', version: 1, updatedAt: '2026-08-23T09:40:00.000Z' },
      { id: `${prefix}-product-6`, sku: 'FD-0006', name: '배추김치', category: '가공식품', specification: '10kg / BOX', unit: 'BOX', ...productPrices('BOX', 42500), supplierName: '참맛푸드', storageType: 'CHILLED', allergens: '새우', status: 'INACTIVE', version: 1, updatedAt: '2026-08-23T09:50:00.000Z' },
    ],
    mealPlans: [
      { id: `${prefix}-meal-1`, siteName: customer, serviceDate: '2026-08-24', mealType: '중식', menuName: '잡곡밥 · 닭개장 · 두부조림 · 깍두기', plannedServings: 320, actualServings: null, allergens: '⑤⑥⑬', status: '승인대기' },
      { id: `${prefix}-meal-2`, siteName: kitchen, serviceDate: '2026-08-24', mealType: '석식', menuName: '흰밥 · 된장찌개 · 돈육불고기 · 오이무침', plannedServings: 180, actualServings: null, allergens: '⑤⑥⑩', status: '확정' },
      { id: `${prefix}-meal-3`, siteName: customer, serviceDate: '2026-08-25', mealType: '중식', menuName: '현미밥 · 미역국 · 고등어구이 · 열무김치', plannedServings: 318, actualServings: null, allergens: '④⑤⑥', status: '작성중' },
    ],
    purchaseOrders: [
      { id: `${prefix}-po-1`, orderNo: 'PO-260823-014', siteName: kitchen, supplierName: '푸른식품', deliveryDate: '2026-08-24', totalAmount: 3420000, itemCount: 12, status: '승인대기' },
      { id: `${prefix}-po-2`, orderNo: 'PO-260823-013', siteName: kitchen, supplierName: '바른농산', deliveryDate: '2026-08-24', totalAmount: 2180000, itemCount: 8, status: '발주완료' },
      { id: `${prefix}-po-3`, orderNo: 'PO-260822-009', siteName: customer, supplierName: '동해수산', deliveryDate: '2026-08-23', totalAmount: 1260000, itemCount: 5, status: '부분입고' },
    ],
    inventoryLots: [
      { id: `${prefix}-lot-1`, siteName: kitchen, ingredientName: '냉동 닭정육', lotNo: 'LT-260820-31', quantity: 28, unit: 'kg', expiresAt: '2026-08-29', location: '냉동 1구역', status: '부족' },
      { id: `${prefix}-lot-2`, siteName: kitchen, ingredientName: '두부 3kg', lotNo: 'LT-260822-17', quantity: 14, unit: 'EA', expiresAt: '2026-08-25', location: '냉장 2구역', status: '임박' },
      { id: `${prefix}-lot-3`, siteName: kitchen, ingredientName: '백미', lotNo: 'LT-260815-02', quantity: 420, unit: 'kg', expiresAt: '2027-02-14', location: '상온 A-03', status: '정상' },
    ],
    productionOrders: [
      { id: `${prefix}-prod-1`, siteName: kitchen, serviceDate: '2026-08-24', menuName: '닭개장', plannedQuantity: 320, actualQuantity: 326, coreTemperature: 76, status: '마감대기' },
      { id: `${prefix}-prod-2`, siteName: kitchen, serviceDate: '2026-08-24', menuName: '두부조림', plannedQuantity: 320, actualQuantity: null, coreTemperature: null, status: '작업중' },
      { id: `${prefix}-prod-3`, siteName: customer, serviceDate: '2026-08-24', menuName: '깍두기 소분', plannedQuantity: 320, actualQuantity: 320, coreTemperature: null, status: '완료' },
    ],
    deliveries: [
      { id: `${prefix}-del-1`, deliveryNo: 'DL-260824-018', siteName: customer, scheduledAt: '2026-08-24T10:40:00+09:00', driverName: '박배송', vehicleNo: '81가 2034', servings: 320, temperature: 5, status: '배송중' },
      { id: `${prefix}-del-2`, deliveryNo: 'DL-260824-017', siteName: secondaryCustomer, scheduledAt: '2026-08-24T10:20:00+09:00', driverName: '최기사', vehicleNo: '83나 7182', servings: 280, temperature: 4, status: '완료' },
      { id: `${prefix}-del-3`, deliveryNo: 'DL-260824-019', siteName: secondaryCustomer, scheduledAt: '2026-08-24T11:10:00+09:00', driverName: '윤배송', vehicleNo: '87다 5519', servings: 210, temperature: null, status: '지연' },
    ],
    settlements: [
      { id: `${prefix}-settle-1`, siteName: customer, settlementMonth: '2026-08', actualServings: 6840, salesAmount: 37620000, ingredientCost: 16140000, status: '검토중' },
      { id: `${prefix}-settle-2`, siteName: secondaryCustomer, settlementMonth: '2026-08', actualServings: 5920, salesAmount: 32560000, ingredientCost: 13024000, status: '확정' },
    ],
    haccpChecks: [
      { id: `${prefix}-haccp-1`, siteName: kitchen, checkDate: '2026-08-23', category: '냉장고', itemName: '2번 냉장고 온도', measuredValue: '9°C', assigneeName: '김영양사', correctiveAction: '문 개방 상태 확인 후 재측정 예정', verificationValue: null, verifiedBy: null, verifiedAt: null, status: '시정필요' },
      { id: `${prefix}-haccp-2`, siteName: kitchen, checkDate: '2026-08-23', category: '조리', itemName: '닭개장 중심온도', measuredValue: '76°C', assigneeName: '이조리사', correctiveAction: null, verificationValue: null, verifiedBy: null, verifiedAt: null, status: '적합' },
      { id: `${prefix}-haccp-3`, siteName: customer, checkDate: '2026-08-23', category: '보존식', itemName: '중식 보존식 채취', measuredValue: '-18°C / 150g', assigneeName: '정영양사', correctiveAction: null, verificationValue: null, verifiedBy: null, verifiedAt: null, status: '완료' },
    ],
  };
}
