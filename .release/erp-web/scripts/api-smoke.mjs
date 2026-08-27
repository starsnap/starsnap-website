import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsedBaseUrl.hostname);
if (!isLoopback && process.env.ALLOW_REMOTE_SMOKE !== '1') {
  throw new Error(
    `Refusing to mutate non-loopback API ${baseUrl}. Set ALLOW_REMOTE_SMOKE=1 only for an isolated test service.`,
  );
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = response.status === 204 ? '' : await response.text();
  let body = text;
  if (text && response.headers.get('content-type')?.includes('application/json')) body = JSON.parse(text);
  return { response, body };
}

function action(tenant, module, id, operation, idempotencyKey, evidence) {
  return request('/api/erp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ tenant, module, id, action: operation, evidence }),
  });
}

function productMutation(body, idempotencyKey) {
  return request('/api/erp/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function bulkProductMutation(body, idempotencyKey, serializedBody = JSON.stringify(body)) {
  return request('/api/erp/products/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: serializedBody,
  });
}

function workbookSource(label) {
  return {
    fileName: `${label}.xlsx`,
    fileSha256: createHash('sha256').update(label).digest('hex'),
  };
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
];

function assertProductPriceShape(product) {
  assert.equal(Object.hasOwn(product, 'unitPrice'), false);
  for (const field of productPriceFields) {
    assert.equal(Number.isInteger(product[field]), true, `${field} must be an integer`);
    assert.ok(product[field] >= 0 && product[field] <= 100_000_000, `${field} must be in range`);
  }
}

for (const tenant of ['HANBIT', 'SAEBOM', 'DAON']) {
  const { response, body } = await request(`/api/erp?tenant=${tenant}`);
  assert.equal(response.status, 200);
  assert.equal(body.tenant.code, tenant);
  assert.ok(body.products.length >= 6);
  assert.ok(body.products.every((product) => product.id.startsWith(tenant.toLowerCase()) || /^[0-9a-f-]{36}$/.test(product.id)));
  body.products.forEach(assertProductPriceShape);
  const migratedSeed = body.products.find((product) => product.sku === 'FD-0001');
  assert.ok(migratedSeed);
  assert.equal(migratedSeed.purchasePriceSpec, 78000);
  for (const field of productPriceFields.filter((field) => field !== 'purchasePriceSpec')) {
    assert.equal(migratedSeed[field], 0);
  }
  const migratedEachSeed = body.products.find((product) => product.sku === 'FD-0002');
  assert.ok(migratedEachSeed);
  assert.equal(migratedEachSeed.purchasePriceEach, 6900);
  for (const field of productPriceFields.filter((field) => field !== 'purchasePriceEach')) {
    assert.equal(migratedEachSeed[field], 0);
  }
}

assert.equal((await request('/api/erp?tenant=UNKNOWN')).response.status, 400);
assert.equal((await request('/api/erp?tenant=HANBIT', { headers: { Origin: 'https://evil.example' } })).response.status, 403);
assert.equal((await request('/api/erp', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081' } })).response.status, 204);

const purchasingKey = 'smoke-hanbit-purchase-0001';
const purchasing = await action('HANBIT', 'purchasing', 'hanbit-po-1', 'approve', purchasingKey);
assert.equal(purchasing.response.status, 200);
assert.equal(purchasing.body.status, '승인');

const replay = await action('HANBIT', 'purchasing', 'hanbit-po-1', 'approve', purchasingKey);
assert.equal(replay.response.status, 200);
assert.deepEqual(replay.body, purchasing.body);

const keyReuse = await action('HANBIT', 'inventory', 'hanbit-lot-1', 'acknowledge', purchasingKey);
assert.equal(keyReuse.response.status, 409);

const crossTenant = await action('DAON', 'purchasing', 'hanbit-po-2', 'approve', 'smoke-cross-tenant-0001');
assert.equal(crossTenant.response.status, 404);

const invalidTransition = await action('SAEBOM', 'delivery', 'saebom-del-3', 'complete', 'smoke-invalid-transition-0001');
assert.equal(invalidTransition.response.status, 409);

const inventory = await action('SAEBOM', 'inventory', 'saebom-lot-1', 'acknowledge', 'smoke-saebom-inventory-0001');
assert.equal(inventory.response.status, 200);
assert.equal(inventory.body.status, '확인완료');

const production = await action('DAON', 'production', 'daon-prod-1', 'complete', 'smoke-daon-production-0001');
assert.equal(production.response.status, 200);
assert.equal(production.body.status, '완료');

const missingEvidence = await action('HANBIT', 'haccp', 'hanbit-haccp-1', 'resolve', 'smoke-haccp-missing-0001');
assert.equal(missingEvidence.response.status, 422);

const haccp = await action(
  'HANBIT',
  'haccp',
  'hanbit-haccp-1',
  'resolve',
  'smoke-haccp-valid-0001',
  { verificationValue: '5°C', correctiveAction: '문 닫힘과 적재 간격을 확인하고 재측정함' },
);
assert.equal(haccp.response.status, 200);
assert.equal(haccp.body.status, '시정완료');

const concurrent = await Promise.all([
  action('SAEBOM', 'meals', 'saebom-meal-1', 'confirm', 'smoke-concurrent-meal-0001'),
  action('SAEBOM', 'meals', 'saebom-meal-1', 'confirm', 'smoke-concurrent-meal-0002'),
]);
assert.ok(concurrent.every(({ response }) => response.status === 200));
assert.equal(concurrent.filter(({ body }) => body.alreadyApplied === true).length, 1);

const hanbit = (await request('/api/erp?tenant=HANBIT')).body;
assert.equal(hanbit.purchaseOrders.find((item) => item.id === 'hanbit-po-1').status, '승인');
const verifiedHaccp = hanbit.haccpChecks.find((item) => item.id === 'hanbit-haccp-1');
assert.equal(verifiedHaccp.status, '시정완료');
assert.equal(verifiedHaccp.verificationValue, '5°C');
assert.equal(verifiedHaccp.verifiedBy, 'local-demo@starsnap.local');
assert.ok(verifiedHaccp.verifiedAt);

const runToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
const runId = `product-${runToken}`;
const productPayload = {
  sku: `SMK-${runToken}`,
  name: 'API 검증용 식자재',
  category: '검증',
  specification: '1kg / PACK',
  unit: 'PACK',
  schoolPriceKg: 15000,
  schoolPriceSpec: 15100,
  schoolPriceEach: 15200,
  vendorPriceKg: 13000,
  vendorPriceSpec: 13100,
  vendorPriceEach: 13200,
  purchasePriceKg: 11000,
  purchasePriceSpec: 12000,
  purchasePriceEach: 11200,
  supplierName: '검증 공급사',
  storageType: 'CHILLED',
  allergens: '',
};
const productCreateRequest = { tenant: 'HANBIT', module: 'products', action: 'create', product: productPayload };
const productCreateKey = `smoke-create-${runId}`;
const createdProduct = await productMutation(productCreateRequest, productCreateKey);
assert.equal(createdProduct.response.status, 200);
assert.equal(createdProduct.body.product.sku, productPayload.sku);
assert.equal(createdProduct.body.product.status, 'ACTIVE');
assertProductPriceShape(createdProduct.body.product);
for (const field of productPriceFields) assert.equal(createdProduct.body.product[field], productPayload[field]);

const productReplay = await productMutation(productCreateRequest, productCreateKey);
assert.equal(productReplay.response.status, 200);
assert.deepEqual(productReplay.body, createdProduct.body);

const productKeyReuse = await productMutation(
  { ...productCreateRequest, product: { ...productPayload, name: '다른 요청 본문' } },
  productCreateKey,
);
assert.equal(productKeyReuse.response.status, 409);

const duplicateProduct = await productMutation(productCreateRequest, `smoke-product-duplicate-${runId}`);
assert.equal(duplicateProduct.response.status, 409);

const concurrentSku = `RACE-${runToken}`;
const concurrentCreateRequest = {
  ...productCreateRequest,
  product: { ...productPayload, sku: concurrentSku, name: '동시 등록 검증 상품' },
};
const concurrentCreateKeys = [`smoke-product-race-a-${runId}`, `smoke-product-race-b-${runId}`];
const concurrentCreates = await Promise.all([
  productMutation(concurrentCreateRequest, concurrentCreateKeys[0]),
  productMutation(concurrentCreateRequest, concurrentCreateKeys[1]),
]);
assert.deepEqual(concurrentCreates.map(({ response }) => response.status).sort(), [200, 409]);
const failedCreateIndex = concurrentCreates.findIndex(({ response }) => response.status === 409);
assert.equal((await productMutation(concurrentCreateRequest, concurrentCreateKeys[failedCreateIndex])).response.status, 409);

const invalidProduct = await productMutation(
  { ...productCreateRequest, product: { ...productPayload, sku: '!' } },
  `smoke-product-invalid-${runId}`,
);
assert.equal(invalidProduct.response.status, 422);

const invalidProductPrice = await productMutation(
  { ...productCreateRequest, product: { ...productPayload, sku: `PRICE-${runToken}`, vendorPriceEach: 100_000_001 } },
  `smoke-product-invalid-price-${runId}`,
);
assert.equal(invalidProductPrice.response.status, 422);
assert.match(invalidProductPrice.body.message, /업체가 개당단가/);

const crossTenantProduct = await productMutation(
  {
    tenant: 'DAON',
    module: 'products',
    action: 'update',
    id: createdProduct.body.product.id,
    expectedVersion: createdProduct.body.product.version,
    product: productPayload,
  },
  `smoke-product-cross-tenant-${runId}`,
);
assert.equal(crossTenantProduct.response.status, 404);

const latestProduct = (await request('/api/erp?tenant=HANBIT')).body.products.find((item) => item.id === createdProduct.body.product.id);
const updateRequests = [
  {
    tenant: 'HANBIT',
    module: 'products',
    action: 'update',
    id: latestProduct.id,
    expectedVersion: latestProduct.version,
    product: { ...productPayload, specification: '동시 수정 A' },
  },
  {
    tenant: 'HANBIT',
    module: 'products',
    action: 'update',
    id: latestProduct.id,
    expectedVersion: latestProduct.version,
    product: { ...productPayload, specification: '동시 수정 B' },
  },
];
const updateKeys = [`smoke-product-update-a-${runId}`, `smoke-product-update-b-${runId}`];
const concurrentUpdates = await Promise.all([
  productMutation(updateRequests[0], updateKeys[0]),
  productMutation(updateRequests[1], updateKeys[1]),
]);
assert.deepEqual(concurrentUpdates.map(({ response }) => response.status).sort(), [200, 409]);
const failedUpdateIndex = concurrentUpdates.findIndex(({ response }) => response.status === 409);
assert.equal((await productMutation(updateRequests[failedUpdateIndex], updateKeys[failedUpdateIndex])).response.status, 409);
const updatedProduct = concurrentUpdates.find(({ response }) => response.status === 200);
assert.ok(updatedProduct);
assert.equal(updatedProduct.body.product.version, latestProduct.version + 1);

const staleProduct = await productMutation(
  {
    tenant: 'HANBIT',
    module: 'products',
    action: 'set-status',
    id: latestProduct.id,
    expectedVersion: latestProduct.version,
    status: 'INACTIVE',
  },
  `smoke-product-stale-${runId}`,
);
assert.equal(staleProduct.response.status, 409);

const disabledProduct = await productMutation(
  {
    tenant: 'HANBIT',
    module: 'products',
    action: 'set-status',
    id: latestProduct.id,
    expectedVersion: updatedProduct.body.product.version,
    status: 'INACTIVE',
  },
  `smoke-product-disable-${runId}`,
);
assert.equal(disabledProduct.response.status, 200);
assert.equal(disabledProduct.body.product.status, 'INACTIVE');

const restoredProduct = await productMutation(
  {
    tenant: 'HANBIT',
    module: 'products',
    action: 'set-status',
    id: latestProduct.id,
    expectedVersion: disabledProduct.body.product.version,
    status: 'ACTIVE',
  },
  `smoke-product-restore-${runId}`,
);
assert.equal(restoredProduct.response.status, 200);
assert.equal(restoredProduct.body.product.status, 'ACTIVE');

const noOpStatusRequest = {
  tenant: 'HANBIT',
  module: 'products',
  action: 'set-status',
  id: latestProduct.id,
  expectedVersion: restoredProduct.body.product.version,
  status: 'ACTIVE',
};
const competingStatusRequest = {
  ...noOpStatusRequest,
  status: 'INACTIVE',
};
const noOpStatusKey = `smoke-product-noop-race-${runId}`;
const [noOpStatus, competingStatus] = await Promise.all([
  productMutation(noOpStatusRequest, noOpStatusKey),
  productMutation(competingStatusRequest, `smoke-product-change-race-${runId}`),
]);
assert.equal(competingStatus.response.status, 200);
assert.ok([200, 409].includes(noOpStatus.response.status));
if (noOpStatus.response.status === 200) assert.equal(noOpStatus.body.alreadyApplied, true);

const noOpReplayAfterRace = await productMutation(noOpStatusRequest, noOpStatusKey);
assert.equal(noOpReplayAfterRace.response.status, noOpStatus.response.status);
assert.deepEqual(noOpReplayAfterRace.body, noOpStatus.body);

const racedProduct = (await request('/api/erp?tenant=HANBIT')).body.products.find((item) => item.id === latestProduct.id);
assert.equal(racedProduct.status, 'INACTIVE');
assert.equal(racedProduct.version, restoredProduct.body.product.version + 1);

const finalRestore = await productMutation(
  {
    ...competingStatusRequest,
    expectedVersion: racedProduct.version,
    status: 'ACTIVE',
  },
  `smoke-product-final-restore-${runId}`,
);
assert.equal(finalRestore.response.status, 200);
assert.equal(finalRestore.body.product.status, 'ACTIVE');

const bulkSkuA = `BULK-A-${runToken}`;
const bulkSkuB = `BULK-B-${runToken}`;
const bulkUpdatedPrices = {
  schoolPriceKg: 25000,
  schoolPriceSpec: 25100,
  schoolPriceEach: 25200,
  vendorPriceKg: 23000,
  vendorPriceSpec: 23100,
  vendorPriceEach: 23200,
  purchasePriceKg: 21000,
  purchasePriceSpec: 13000,
  purchasePriceEach: 21200,
};
const bulkCreateRequest = {
  schemaVersion: 2,
  tenant: 'SAEBOM',
  source: workbookSource(`bulk-create-${runId}`),
  rows: [
    { rowNumber: 2, action: 'create', product: { ...productPayload, sku: bulkSkuA, name: '엑셀 일괄 등록 A', unit: 'KG' } },
    { rowNumber: 3, action: 'create', product: { ...productPayload, sku: bulkSkuB, name: '엑셀 일괄 등록 B', unit: 'EA', storageType: 'FROZEN' } },
  ],
};
const legacyWorkbook = await bulkProductMutation(
  { ...bulkCreateRequest, schemaVersion: 1 },
  `smoke-bulk-legacy-schema-${runId}`,
);
assert.equal(legacyWorkbook.response.status, 422);
assert.match(legacyWorkbook.body.message, /최신 양식을 다시 다운로드/);

const bulk101Rows = Array.from({ length: 101 }, (_, index) => ({
  rowNumber: index + 2,
  action: 'create',
  product: { ...productPayload, sku: `CAP-${index.toString(36).toUpperCase()}-${runToken}`, schoolPriceKg: -1 },
}));
const accepted101Rows = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'SAEBOM',
    source: workbookSource(`bulk-101-boundary-${runId}`),
    rows: bulk101Rows,
  },
  `smoke-bulk-101-boundary-${runId}`,
);
assert.equal(accepted101Rows.response.status, 422);
assert.equal(accepted101Rows.body.summary.total, 101);
assert.equal(accepted101Rows.body.summary.failed, 101);
assert.ok(accepted101Rows.body.rows.every((row) => row.errors.some((error) => error.field === 'schoolPriceKg')));

const rejected10001Rows = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'SAEBOM',
    source: workbookSource(`bulk-10001-boundary-${runId}`),
    rows: Array.from({ length: 10_001 }, (_, index) => ({
      rowNumber: index + 2,
      action: 'create',
      product: { ...productPayload, sku: `MAX-${index.toString(36).toUpperCase()}-${runToken}` },
    })),
  },
  `smoke-bulk-10001-boundary-${runId}`,
);
assert.equal(rejected10001Rows.response.status, 422);
assert.equal(rejected10001Rows.body.summary.total, 10_001);
assert.match(rejected10001Rows.body.message, /1~10,000개/);

const bulk10000Request = {
  schemaVersion: 2,
  tenant: 'DAON',
  source: workbookSource(`bulk-10000-success-${runId}`),
  rows: Array.from({ length: 10_000 }, (_, index) => ({
    rowNumber: index + 2,
    action: 'create',
    product: {
      ...productPayload,
      sku: `L10K-${index.toString(36).toUpperCase()}-${runToken}`,
      name: '가'.repeat(100),
      category: '나'.repeat(40),
      specification: '다'.repeat(80),
      supplierName: '라'.repeat(100),
      allergens: '마'.repeat(120),
    },
  })),
};
const bulk10000Json = JSON.stringify(bulk10000Request);
const bulk10000BodyBytes = Buffer.byteLength(bulk10000Json);
assert.ok(bulk10000BodyBytes > 4 * 1024 * 1024, '10,000-row regression body must exceed the former 4MiB cap');
assert.ok(bulk10000BodyBytes < 48 * 1024 * 1024, '10,000-row regression body must fit the explicit 48MiB cap');
const bulk10000Created = await bulkProductMutation(
  bulk10000Request,
  `smoke-bulk-10000-success-${runId}`,
  bulk10000Json,
);
assert.equal(bulk10000Created.response.status, 200);
assert.equal(bulk10000Created.body.ok, true);
assert.deepEqual(bulk10000Created.body.summary, { total: 10_000, created: 10_000, updated: 0, failed: 0, notApplied: 0 });
assert.deepEqual(bulk10000Created.body.rows, []);
assert.deepEqual(bulk10000Created.body.rowDetails, { included: 0, total: 10_000, omitted: 10_000, truncated: true });
assert.ok(!Number.isNaN(Date.parse(bulk10000Created.body.appliedAt)));
assert.equal(bulk10000Created.body.createdProductIds.length, 10_000);
assert.equal(new Set(bulk10000Created.body.createdProductIds).size, 10_000);
assert.ok(Buffer.byteLength(JSON.stringify(bulk10000Created.body)) < 1024 * 1024, '10,000-create acknowledgement must stay below 1 MiB');

const bulkCreateKey = `smoke-bulk-create-${runId}`;
const bulkCreated = await bulkProductMutation(bulkCreateRequest, bulkCreateKey);
assert.equal(bulkCreated.response.status, 200);
assert.equal(bulkCreated.body.ok, true);
assert.deepEqual(bulkCreated.body.summary, { total: 2, created: 2, updated: 0, failed: 0, notApplied: 0 });
assert.deepEqual(bulkCreated.body.rows.map((row) => row.status), ['created', 'created']);
assert.deepEqual(bulkCreated.body.createdProductIds, bulkCreated.body.rows.map((row) => row.product.id));
assert.ok(bulkCreated.body.rows.every((row) => row.product.updatedAt === bulkCreated.body.appliedAt));

const bulkReplay = await bulkProductMutation(bulkCreateRequest, bulkCreateKey);
assert.equal(bulkReplay.response.status, 200);
assert.deepEqual(bulkReplay.body, bulkCreated.body);

const bulkKeyReuse = await bulkProductMutation(
  {
    ...bulkCreateRequest,
    rows: [{ ...bulkCreateRequest.rows[0], product: { ...bulkCreateRequest.rows[0].product, name: '다른 일괄 요청' } }],
  },
  bulkCreateKey,
);
assert.equal(bulkKeyReuse.response.status, 409);
assert.equal(bulkKeyReuse.body.ok, false);

const [bulkProductA, bulkProductB] = bulkCreated.body.rows.map((row) => row.product);
const bulkUpdateRequest = {
  schemaVersion: 2,
  tenant: 'SAEBOM',
  source: workbookSource(`bulk-update-${runId}`),
  rows: [
    {
      rowNumber: 2,
      action: 'update',
      id: bulkProductA.id,
      expectedVersion: bulkProductA.version,
      product: { ...productPayload, sku: bulkSkuA, name: '엑셀 일괄 수정 A', specification: '2kg / PACK' },
    },
    {
      rowNumber: 3,
      action: 'update',
      id: bulkProductB.id,
      expectedVersion: bulkProductB.version,
      product: { ...productPayload, ...bulkUpdatedPrices, sku: bulkSkuB, name: '엑셀 일괄 수정 B', storageType: 'FROZEN' },
    },
  ],
};
const bulkUpdated = await bulkProductMutation(bulkUpdateRequest, `smoke-bulk-update-${runId}`);
assert.equal(bulkUpdated.response.status, 200);
assert.deepEqual(bulkUpdated.body.summary, { total: 2, created: 0, updated: 2, failed: 0, notApplied: 0 });
assert.deepEqual(bulkUpdated.body.createdProductIds, []);
assert.ok(bulkUpdated.body.rows.every((row) => row.product.updatedAt === bulkUpdated.body.appliedAt));
assert.ok(bulkUpdated.body.rows.every((row) => row.product.version === 2));
const bulkUpdatedProductB = bulkUpdated.body.rows[1].product;
assertProductPriceShape(bulkUpdatedProductB);
for (const field of productPriceFields) assert.equal(bulkUpdatedProductB[field], bulkUpdatedPrices[field]);

const mixedOrderAnchorSku = `BULK-MIX-ANCHOR-${runToken}`;
const mixedOrderFirstSku = `BULK-MIX-FIRST-${runToken}`;
const mixedOrderLastSku = `BULK-MIX-LAST-${runToken}`;
const mixedOrderAnchor = await productMutation(
  {
    tenant: 'SAEBOM',
    module: 'products',
    action: 'create',
    product: { ...productPayload, sku: mixedOrderAnchorSku, name: '혼합 순서 기준 상품' },
  },
  `smoke-bulk-mixed-anchor-${runId}`,
);
assert.equal(mixedOrderAnchor.response.status, 200);
const mixedOrderKey = `smoke-bulk-mixed-order-${runId}`;
const mixedOrderRequest = {
  schemaVersion: 2,
  tenant: 'SAEBOM',
  source: workbookSource(`bulk-mixed-order-${runId}`),
  rows: [
    { rowNumber: 2, action: 'create', product: { ...productPayload, sku: mixedOrderFirstSku, name: '혼합 첫 등록' } },
    {
      rowNumber: 3,
      action: 'update',
      id: mixedOrderAnchor.body.product.id,
      expectedVersion: mixedOrderAnchor.body.product.version,
      product: { ...productPayload, sku: mixedOrderAnchorSku, name: '혼합 중간 수정' },
    },
    { rowNumber: 4, action: 'create', product: { ...productPayload, sku: mixedOrderLastSku, name: '혼합 마지막 등록' } },
  ],
};
const mixedOrder = await bulkProductMutation(mixedOrderRequest, mixedOrderKey);
assert.equal(mixedOrder.response.status, 200);
assert.deepEqual(mixedOrder.body.rows.map((row) => row.status), ['created', 'updated', 'created']);
assert.deepEqual(
  mixedOrder.body.createdProductIds,
  [mixedOrder.body.rows[0].product.id, mixedOrder.body.rows[2].product.id],
);
const mixedOrderReplay = await bulkProductMutation(mixedOrderRequest, mixedOrderKey);
assert.deepEqual(mixedOrderReplay.body, mixedOrder.body);
const afterMixedOrder = (await request('/api/erp?tenant=SAEBOM')).body;
assert.equal(afterMixedOrder.products.find((product) => product.sku === mixedOrderFirstSku).id, mixedOrder.body.createdProductIds[0]);
assert.equal(afterMixedOrder.products.find((product) => product.sku === mixedOrderLastSku).id, mixedOrder.body.createdProductIds[1]);

const bulkRaceCreateSku = `BULK-RACE-${runToken}`;
const singleRaceRequest = {
  ...productCreateRequest,
  tenant: 'SAEBOM',
  action: 'update',
  id: bulkProductB.id,
  expectedVersion: 2,
  product: { ...productPayload, sku: bulkSkuB, name: '단건 동시 수정 승자 후보', storageType: 'FROZEN' },
};
const mixedRaceRequest = {
  schemaVersion: 2,
  tenant: 'SAEBOM',
  source: workbookSource(`bulk-transaction-race-${runId}`),
  rows: [
    { rowNumber: 2, action: 'create', product: { ...productPayload, sku: bulkRaceCreateSku, name: '동시성 원자성 검증 등록' } },
    {
      rowNumber: 3,
      action: 'update',
      id: bulkProductB.id,
      expectedVersion: 2,
      product: { ...productPayload, sku: bulkSkuB, name: '일괄 동시 수정 승자 후보', storageType: 'FROZEN' },
    },
  ],
};
const [singleRace, mixedRace] = await Promise.all([
  productMutation(singleRaceRequest, `smoke-bulk-race-single-${runId}`),
  bulkProductMutation(mixedRaceRequest, `smoke-bulk-race-batch-${runId}`),
]);
assert.deepEqual([singleRace.response.status, mixedRace.response.status].sort(), [200, 409]);
const afterBulkRace = (await request('/api/erp?tenant=SAEBOM')).body;
assert.equal(
  afterBulkRace.products.some((product) => product.sku === bulkRaceCreateSku),
  mixedRace.response.status === 200,
);
if (mixedRace.response.status === 409) {
  assert.equal(mixedRace.body.summary.created, 0);
  assert.ok(mixedRace.body.rows.every((row) => row.status === 'error' || row.status === 'not_applied'));
}

const rollbackSku = `ROLLBACK-${runToken}`;
const atomicRollback = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'SAEBOM',
    source: workbookSource(`bulk-rollback-${runId}`),
    rows: [
      { rowNumber: 2, action: 'create', product: { ...productPayload, sku: rollbackSku, name: '저장되면 안 되는 상품' } },
      {
        rowNumber: 3,
        action: 'update',
        id: bulkProductA.id,
        expectedVersion: 1,
        product: { ...productPayload, sku: bulkSkuA, name: '오래된 버전 수정' },
      },
    ],
  },
  `smoke-bulk-rollback-${runId}`,
);
assert.equal(atomicRollback.response.status, 409);
assert.equal(atomicRollback.body.ok, false);
assert.equal(atomicRollback.body.summary.created, 0);
assert.equal(atomicRollback.body.summary.notApplied, 1);
assert.ok(atomicRollback.body.rows.every((row) => row.status === 'error'));
assert.deepEqual(atomicRollback.body.rowDetails, { included: 1, total: 2, omitted: 1, truncated: true });
const afterRollback = (await request('/api/erp?tenant=SAEBOM')).body;
assert.equal(afterRollback.products.some((product) => product.sku === rollbackSku), false);
assert.equal(afterRollback.products.find((product) => product.id === bulkProductA.id).name, '엑셀 일괄 수정 A');

const duplicateInWorkbook = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'SAEBOM',
    source: workbookSource(`bulk-duplicate-${runId}`),
    rows: [
      { rowNumber: 2, action: 'create', product: { ...productPayload, sku: `DUP-${runToken}`, name: '중복 행 A' } },
      { rowNumber: 3, action: 'create', product: { ...productPayload, sku: `dup-${runToken}`, name: '중복 행 B' } },
    ],
  },
  `smoke-bulk-duplicate-${runId}`,
);
assert.equal(duplicateInWorkbook.response.status, 422);
assert.equal(duplicateInWorkbook.body.summary.failed, 2);
assert.ok(duplicateInWorkbook.body.rows.every((row) => row.status === 'error'));

const invalidBulkAllergens = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'SAEBOM',
    source: workbookSource(`bulk-invalid-allergens-${runId}`),
    rows: [{
      rowNumber: 2,
      action: 'create',
      product: { ...productPayload, sku: `ALG-${runToken}`, allergens: 17 },
    }],
  },
  `smoke-bulk-invalid-allergens-${runId}`,
);
assert.equal(invalidBulkAllergens.response.status, 422);
assert.equal(invalidBulkAllergens.body.rows[0].errors[0].field, 'allergens');

const crossTenantBulk = await bulkProductMutation(
  {
    schemaVersion: 2,
    tenant: 'DAON',
    source: workbookSource(`bulk-cross-tenant-${runId}`),
    rows: [{
      rowNumber: 2,
      action: 'update',
      id: bulkProductA.id,
      expectedVersion: 2,
      product: { ...productPayload, sku: bulkSkuA, name: '다른 회사에서 수정되면 안 됨' },
    }],
  },
  `smoke-bulk-cross-tenant-${runId}`,
);
assert.equal(crossTenantBulk.response.status, 409);
assert.equal(crossTenantBulk.body.rows[0].errors[0].code, 'PRODUCT_NOT_FOUND');

console.log('StarSnap ERP API smoke passed: tenant boundaries, workflows, idempotency, HACCP evidence, 9-field product pricing, 10,000-row compact bulk limits, CRUD/status concurrency, and atomic Excel bulk create/update.');
