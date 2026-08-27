import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const PRICE_FIELDS = [
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
const TENANTS = ['HANBIT', 'SAEBOM', 'DAON'];
const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const tenant = process.env.SMOKE_TENANT ?? 'HANBIT';
const run10k = process.argv.includes('--bulk-10k') || process.env.MONTHLY_PRICE_SMOKE_10K === '1';
const requestTimeoutMs = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS ?? (run10k ? 300_000 : 60_000));
const runStartedAt = Date.now();
const runToken = runStartedAt.toString(36).toUpperCase();
const requestStats = {
  productPosts: 0,
  productBulkPosts: 0,
  pricePosts: 0,
  priceBulkPosts: 0,
};

assert.ok(TENANTS.includes(tenant), `SMOKE_TENANT must be one of ${TENANTS.join(', ')}`);
assert.ok(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0, 'SMOKE_REQUEST_TIMEOUT_MS must be positive');

const parsedBaseUrl = new URL(baseUrl);
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsedBaseUrl.hostname);
if (!isLoopback && process.env.ALLOW_REMOTE_SMOKE !== '1') {
  throw new Error(
    `Refusing to mutate non-loopback API ${baseUrl}. Set ALLOW_REMOTE_SMOKE=1 only for an isolated test service.`,
  );
}

function bodyPreview(value, maxLength = 2_000) {
  let serialized;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

function assertStatus(result, expected, label) {
  assert.equal(
    result.response.status,
    expected,
    `${label}: expected HTTP ${expected}, received ${result.response.status}: ${bodyPreview(result.body)}`,
  );
}

function assertRejected(result, expectedStatus, label) {
  assertStatus(result, expectedStatus, label);
  assert.notEqual(result.body?.ok, true, `${label}: failure response cannot report ok=true`);
  assert.equal(typeof result.body?.message, 'string', `${label}: failure response must include a message`);
}

async function request(path, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const pathname = new URL(path, `${baseUrl}/`).pathname;
  if (method === 'POST') {
    if (pathname === '/api/erp/products') requestStats.productPosts += 1;
    if (pathname === '/api/erp/products/bulk') requestStats.productBulkPosts += 1;
    if (pathname === '/api/erp/products/prices') requestStats.pricePosts += 1;
    if (pathname === '/api/erp/products/prices/bulk') requestStats.priceBulkPosts += 1;
  }

  const started = performance.now();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawText = response.status === 204 ? '' : await response.text();
  let body = rawText;
  if (rawText && response.headers.get('content-type')?.includes('application/json')) {
    try {
      body = JSON.parse(rawText);
    } catch (error) {
      throw new Error(
        `${method} ${path} returned invalid JSON (${response.status}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    response,
    body,
    rawText,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function postJson(path, body, idempotencyKey) {
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function productMutation(body, idempotencyKey) {
  return postJson('/api/erp/products', body, idempotencyKey);
}

function bulkProductMutation(body, idempotencyKey) {
  return postJson('/api/erp/products/bulk', body, idempotencyKey);
}

function productPriceMutation(body, idempotencyKey) {
  return postJson('/api/erp/products/prices', body, idempotencyKey);
}

function bulkProductPriceMutation(body, idempotencyKey) {
  return postJson('/api/erp/products/prices/bulk', body, idempotencyKey);
}

function workbookSource(label) {
  return {
    fileName: `${label}.xlsx`,
    fileSha256: createHash('sha256').update(label).digest('hex'),
  };
}

function priceValues(base) {
  return Object.fromEntries(PRICE_FIELDS.map((field, index) => [field, base + index + 1]));
}

function assertPriceValues(actual, expected, label) {
  for (const field of PRICE_FIELDS) {
    assert.equal(actual[field], expected[field], `${label}: ${field}`);
  }
}

function kstMonth(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  assert.ok(year && month, 'Could not determine the current KST month');
  return `${year}-${month}`;
}

function addMonths(month, delta) {
  assert.match(month, /^\d{4}-(0[1-9]|1[0-2])$/);
  const [year, monthNumber] = month.split('-').map(Number);
  const absoluteMonth = year * 12 + monthNumber - 1 + delta;
  const nextYear = Math.floor(absoluteMonth / 12);
  const nextMonth = absoluteMonth % 12 + 1;
  assert.ok(nextYear >= 1 && nextYear <= 9999, `Month offset is outside the supported range: ${month} + ${delta}`);
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

function assertSnapshotShape(snapshot, requestedMonth, label) {
  assert.ok(snapshot && typeof snapshot === 'object', `${label}: snapshot is required`);
  assert.equal(snapshot.priceMonth, requestedMonth, `${label}: requested month`);
  assert.equal(Number.isInteger(snapshot.priceSourceVersion), true, `${label}: source version must be an integer`);
  assert.ok(snapshot.priceSourceVersion >= 1, `${label}: source version must be positive`);
  for (const field of PRICE_FIELDS) {
    assert.equal(Number.isInteger(snapshot[field]), true, `${label}: ${field} must be an integer`);
    assert.ok(snapshot[field] >= 0 && snapshot[field] <= 100_000_000, `${label}: ${field} is outside the price range`);
  }

  if (snapshot.priceInherited) {
    assert.equal(snapshot.priceVersion, 0, `${label}: inherited target version`);
    if (snapshot.priceSourceMonth !== null) {
      assert.match(snapshot.priceSourceMonth, /^\d{4}-(0[1-9]|1[0-2])$/, `${label}: source month`);
      assert.ok(snapshot.priceSourceMonth < requestedMonth, `${label}: inherited source must precede the target`);
    }
  } else {
    assert.equal(snapshot.priceSourceMonth, requestedMonth, `${label}: exact source month`);
    assert.ok(snapshot.priceVersion >= 1, `${label}: exact target version`);
    assert.equal(snapshot.priceSourceVersion, snapshot.priceVersion, `${label}: exact source/target version`);
  }
}

async function getProductPrices(selectedTenant, priceMonth) {
  const result = await request(
    `/api/erp/products/prices?tenant=${encodeURIComponent(selectedTenant)}&priceMonth=${encodeURIComponent(priceMonth)}`,
  );
  assertStatus(result, 200, `GET monthly prices ${selectedTenant}/${priceMonth}`);
  assert.equal(result.body.tenant, selectedTenant);
  assert.equal(result.body.priceMonth, priceMonth);
  assert.ok(Array.isArray(result.body.products));
  for (const snapshot of result.body.products) {
    assertSnapshotShape(snapshot, priceMonth, `GET ${priceMonth}/${snapshot.productId}`);
  }
  return result.body.products;
}

async function getProductPrice(selectedTenant, priceMonth, productId) {
  const products = await getProductPrices(selectedTenant, priceMonth);
  const snapshot = products.find((item) => item.productId === productId);
  assert.ok(snapshot, `No monthly price snapshot for ${selectedTenant}/${productId}/${priceMonth}`);
  return snapshot;
}

function mutationFromSnapshot(selectedTenant, snapshot, prices) {
  return {
    tenant: selectedTenant,
    module: 'product-prices',
    action: 'upsert',
    productId: snapshot.productId,
    priceMonth: snapshot.priceMonth,
    expectedVersion: snapshot.priceVersion,
    expectedSourceMonth: snapshot.priceSourceMonth,
    expectedSourceVersion: snapshot.priceSourceVersion,
    prices,
  };
}

function bulkRowFromSnapshot(snapshot, rowNumber, prices) {
  return {
    rowNumber,
    productId: snapshot.productId,
    expectedVersion: snapshot.priceVersion,
    expectedSourceMonth: snapshot.priceSourceMonth,
    expectedSourceVersion: snapshot.priceSourceVersion,
    prices,
  };
}

function assertExactSnapshot(snapshot, priceMonth, version, prices, label) {
  assertSnapshotShape(snapshot, priceMonth, label);
  assert.equal(snapshot.priceInherited, false, `${label}: must be exact`);
  assert.equal(snapshot.priceSourceMonth, priceMonth, `${label}: source month`);
  assert.equal(snapshot.priceVersion, version, `${label}: target version`);
  assert.equal(snapshot.priceSourceVersion, version, `${label}: source version`);
  assertPriceValues(snapshot, prices, label);
}

function productInput(sku, name, prices) {
  return {
    sku,
    name,
    category: '월별 단가 검증',
    specification: '1kg / PACK',
    unit: 'KG',
    ...prices,
    supplierName: '월별 단가 검증 공급사',
    storageType: 'CHILLED',
    allergens: '',
  };
}

async function locateCreateMonth(productId, initialPrices, responseMonth, beforeCreate, afterCreate) {
  const candidates = [
    responseMonth,
    kstMonth(beforeCreate),
    kstMonth(afterCreate),
  ].filter((month, index, values) => month && values.indexOf(month) === index);
  const observed = [];
  for (const candidate of candidates) {
    const snapshot = await getProductPrice(tenant, candidate, productId);
    observed.push({
      month: candidate,
      inherited: snapshot.priceInherited,
      sourceMonth: snapshot.priceSourceMonth,
      targetVersion: snapshot.priceVersion,
      sourceVersion: snapshot.priceSourceVersion,
    });
    if (!snapshot.priceInherited && snapshot.priceSourceMonth === candidate) {
      assertExactSnapshot(snapshot, candidate, 1, initialPrices, 'product-create current-month snapshot');
      return { month: candidate, snapshot };
    }
  }
  assert.fail(`Product create did not produce an exact current-month v1 price: ${bodyPreview(observed)}`);
}

async function ensureTenThousandProducts() {
  console.log('[10k] loading product master');
  const initial = await request(`/api/erp?tenant=${encodeURIComponent(tenant)}`);
  assertStatus(initial, 200, 'load product master for 10k test');
  assert.ok(Array.isArray(initial.body.products));
  const existingIds = initial.body.products.map((product) => product.id);
  assert.equal(new Set(existingIds).size, existingIds.length, 'product IDs must be unique');
  if (existingIds.length >= 10_000) return existingIds.slice(0, 10_000);

  const missing = 10_000 - existingIds.length;
  console.log(`[10k] creating ${missing.toLocaleString('en-US')} products in one product-bulk POST`);
  const rows = Array.from({ length: missing }, (_, index) => ({
    rowNumber: index + 2,
    action: 'create',
    product: productInput(
      `M10-${runToken}-${index.toString(36).toUpperCase()}`,
      `월별 단가 10K 검증 상품 ${index + 1}`,
      priceValues(2_000_000 + index * 20),
    ),
  }));
  const body = {
    schemaVersion: 2,
    tenant,
    source: workbookSource(`monthly-price-products-${runToken}`),
    rows,
  };
  const beforePosts = requestStats.productBulkPosts;
  const created = await bulkProductMutation(body, `monthly-price-products-${runToken}`);
  assert.equal(requestStats.productBulkPosts - beforePosts, 1, '10k prerequisite products must use one product-bulk POST');
  assertStatus(created, 200, 'create prerequisite products');
  assert.deepEqual(created.body.summary, {
    total: missing,
    created: missing,
    updated: 0,
    failed: 0,
    notApplied: 0,
  });
  assert.ok(Array.isArray(created.body.createdProductIds), 'compact product ACK must include createdProductIds');
  assert.equal(created.body.createdProductIds.length, missing, 'compact product ACK ID count');
  assert.equal(new Set(created.body.createdProductIds).size, missing, 'compact product ACK IDs must be unique');
  return [...existingIds, ...created.body.createdProductIds];
}

async function findUnusedBulkMonth(productIds, firstCandidate) {
  const selectedIds = new Set(productIds);
  for (let offset = 0; offset < 36; offset += 1) {
    const candidate = addMonths(firstCandidate, offset);
    const snapshots = (await getProductPrices(tenant, candidate))
      .filter((snapshot) => selectedIds.has(snapshot.productId));
    assert.equal(snapshots.length, productIds.length, `10k snapshot coverage for ${candidate}`);
    if (snapshots.every((snapshot) => snapshot.priceVersion === 0 && snapshot.priceInherited)) {
      return { candidate, snapshots };
    }
  }
  assert.fail('Could not find an unused future month for the 10k monthly-price test');
}

async function runTenThousandTest(firstCandidate) {
  const productIds = await ensureTenThousandProducts();
  assert.equal(productIds.length, 10_000);
  const { candidate: bulkMonth, snapshots: initialSnapshots } =
    await findUnusedBulkMonth(productIds, firstCandidate);
  const initialById = new Map(initialSnapshots.map((snapshot) => [snapshot.productId, snapshot]));
  const createExpected = new Map();
  const createRows = productIds.map((productId, index) => {
    const snapshot = initialById.get(productId);
    assert.ok(snapshot);
    const prices = priceValues(5_000_000 + index * 20);
    createExpected.set(productId, prices);
    return bulkRowFromSnapshot(snapshot, index + 2, prices);
  });
  const createRequest = {
    schemaVersion: 2,
    tenant,
    priceMonth: bulkMonth,
    source: workbookSource(`monthly-price-10k-create-${runToken}`),
    rows: createRows,
  };
  const createPayloadBytes = Buffer.byteLength(JSON.stringify(createRequest));

  console.log(`[10k] creating 10,000 monthly prices for ${bulkMonth} in one price-bulk POST`);
  const beforeCreatePosts = requestStats.priceBulkPosts;
  const created = await bulkProductPriceMutation(
    createRequest,
    `monthly-price-10k-create-${runToken}`,
  );
  assert.equal(
    requestStats.priceBulkPosts - beforeCreatePosts,
    1,
    '10,000 monthly-price creates must use exactly one price-bulk POST',
  );
  assertStatus(created, 200, '10k monthly-price create');
  assert.deepEqual(created.body.summary, {
    total: 10_000,
    created: 10_000,
    updated: 0,
    failed: 0,
    notApplied: 0,
  });
  assert.deepEqual(created.body.rows, [], '10k success ACK must omit per-row bodies');
  assert.deepEqual(created.body.rowDetails, {
    included: 0,
    total: 10_000,
    omitted: 10_000,
    truncated: true,
  });
  assert.ok(Number.isFinite(Date.parse(created.body.appliedAt)), '10k create ACK must include appliedAt');
  assert.ok(created.rawText.length < 2_000_000, '10k create ACK must remain below 2 MB');

  const afterCreate = await getProductPrices(tenant, bulkMonth);
  const afterCreateById = new Map(afterCreate.map((snapshot) => [snapshot.productId, snapshot]));
  for (const productId of productIds) {
    const snapshot = afterCreateById.get(productId);
    assert.ok(snapshot, `10k created snapshot missing: ${productId}`);
    assertExactSnapshot(snapshot, bulkMonth, 1, createExpected.get(productId), `10k create ${productId}`);
  }

  const updateExpected = new Map();
  const updateRows = productIds.map((productId, index) => {
    const snapshot = afterCreateById.get(productId);
    assert.ok(snapshot);
    const prices = priceValues(7_000_000 + index * 20);
    updateExpected.set(productId, prices);
    return bulkRowFromSnapshot(snapshot, index + 2, prices);
  });
  const updateRequest = {
    schemaVersion: 2,
    tenant,
    priceMonth: bulkMonth,
    source: workbookSource(`monthly-price-10k-update-${runToken}`),
    rows: updateRows,
  };
  const updatePayloadBytes = Buffer.byteLength(JSON.stringify(updateRequest));

  console.log(`[10k] updating all 10,000 monthly prices for ${bulkMonth} in one price-bulk POST`);
  const beforeUpdatePosts = requestStats.priceBulkPosts;
  const updated = await bulkProductPriceMutation(
    updateRequest,
    `monthly-price-10k-update-${runToken}`,
  );
  assert.equal(
    requestStats.priceBulkPosts - beforeUpdatePosts,
    1,
    '10,000 monthly-price updates must use exactly one price-bulk POST',
  );
  assertStatus(updated, 200, '10k monthly-price update');
  assert.deepEqual(updated.body.summary, {
    total: 10_000,
    created: 0,
    updated: 10_000,
    failed: 0,
    notApplied: 0,
  });
  assert.deepEqual(updated.body.rows, [], '10k update ACK must omit per-row bodies');
  assert.deepEqual(updated.body.rowDetails, {
    included: 0,
    total: 10_000,
    omitted: 10_000,
    truncated: true,
  });
  assert.ok(Number.isFinite(Date.parse(updated.body.appliedAt)), '10k update ACK must include appliedAt');
  assert.ok(updated.rawText.length < 2_000_000, '10k update ACK must remain below 2 MB');

  const afterUpdate = await getProductPrices(tenant, bulkMonth);
  const afterUpdateById = new Map(afterUpdate.map((snapshot) => [snapshot.productId, snapshot]));
  for (const productId of productIds) {
    const snapshot = afterUpdateById.get(productId);
    assert.ok(snapshot, `10k updated snapshot missing: ${productId}`);
    assertExactSnapshot(snapshot, bulkMonth, 2, updateExpected.get(productId), `10k update ${productId}`);
  }

  return {
    month: bulkMonth,
    productCount: productIds.length,
    createRequestCount: 1,
    updateRequestCount: 1,
    createPayloadBytes,
    updatePayloadBytes,
    createMs: created.elapsedMs,
    updateMs: updated.elapsedMs,
    createAckBytes: Buffer.byteLength(created.rawText),
    updateAckBytes: Buffer.byteLength(updated.rawText),
  };
}

async function main() {
  console.log(`Monthly-price smoke against ${baseUrl} (${tenant})${run10k ? ' with 10k mode' : ''}`);
  const health = await request('/api/health');
  assertStatus(health, 200, 'health check');

  const initialPrices = priceValues(10_000);
  const sku = `MP-${runToken}`.slice(0, 30);
  const createInput = productInput(sku, `월별 단가 검증 ${runToken}`, initialPrices);
  const beforeCreate = Date.now();
  const created = await productMutation(
    { tenant, module: 'products', action: 'create', product: createInput },
    `monthly-price-product-create-${runToken}`,
  );
  const afterCreate = Date.now();
  assertStatus(created, 200, 'create monthly-price test product');
  assert.equal(created.body.ok, true);
  assert.ok(created.body.product?.id);
  assert.equal(created.body.product.version, 1);
  const productId = created.body.product.id;

  const current = await locateCreateMonth(
    productId,
    initialPrices,
    created.body.createdPriceMonth,
    beforeCreate,
    afterCreate,
  );
  const currentMonth = current.month;
  console.log(`[contract] product ${productId} has exact v1 prices in current KST month ${currentMonth}`);

  const baseMonth = addMonths(currentMonth, -(120 + runStartedAt % 120));
  const futureOffset = 120 + runStartedAt % 48_000;
  const monthA = addMonths(currentMonth, futureOffset);
  const monthB = addMonths(monthA, 1);
  const monthC = addMonths(monthA, 2);
  const monthD = addMonths(monthA, 3);

  const baseBeforeUpdate = await getProductPrice(tenant, baseMonth, productId);
  assert.equal(baseBeforeUpdate.priceInherited, true);
  assert.equal(baseBeforeUpdate.priceVersion, 0);
  assert.equal(baseBeforeUpdate.priceSourceMonth, null);
  assert.equal(baseBeforeUpdate.priceSourceVersion, 1);
  assertPriceValues(baseBeforeUpdate, initialPrices, 'base-price snapshot before Product update');

  const masterPricesV2 = priceValues(20_000);
  const productUpdated = await productMutation(
    {
      tenant,
      module: 'products',
      action: 'update',
      id: productId,
      expectedVersion: 1,
      product: {
        ...createInput,
        name: `${createInput.name} 상품원본수정`,
        ...masterPricesV2,
      },
    },
    `monthly-price-product-update-${runToken}`,
  );
  assertStatus(productUpdated, 200, 'update Product base row');
  assert.equal(productUpdated.body.product.version, 2);

  const staleBaseSource = await productPriceMutation(
    mutationFromSnapshot(tenant, baseBeforeUpdate, priceValues(30_000)),
    `monthly-price-base-stale-${runToken}`,
  );
  assertRejected(staleBaseSource, 409, 'stale Product.version source');

  const baseAfterUpdate = await getProductPrice(tenant, baseMonth, productId);
  assert.equal(baseAfterUpdate.priceInherited, true);
  assert.equal(baseAfterUpdate.priceVersion, 0);
  assert.equal(baseAfterUpdate.priceSourceMonth, null);
  assert.equal(baseAfterUpdate.priceSourceVersion, 2);
  assertPriceValues(baseAfterUpdate, masterPricesV2, 'base-price snapshot after Product update');

  const baseExactPrices = priceValues(31_000);
  const baseSaved = await productPriceMutation(
    mutationFromSnapshot(tenant, baseAfterUpdate, baseExactPrices),
    `monthly-price-base-save-${runToken}`,
  );
  assertStatus(baseSaved, 200, 'save exact price based on fresh Product.version');
  assert.equal(baseSaved.body.ok, true);
  assertExactSnapshot(baseSaved.body.productPrice, baseMonth, 1, baseExactPrices, 'saved base-month exact price');

  const currentAfterMasterUpdate = await getProductPrice(tenant, currentMonth, productId);
  assertExactSnapshot(
    currentAfterMasterUpdate,
    currentMonth,
    1,
    initialPrices,
    'current monthly row remains independent from Product update',
  );

  const inheritedA = await getProductPrice(tenant, monthA, productId);
  assert.equal(inheritedA.priceInherited, true);
  assert.equal(inheritedA.priceVersion, 0);
  assert.equal(inheritedA.priceSourceMonth, currentMonth);
  assert.equal(inheritedA.priceSourceVersion, 1);
  assertPriceValues(inheritedA, initialPrices, 'future carry-forward from current month');

  const monthAPricesV1 = priceValues(40_000);
  const monthACreateBody = mutationFromSnapshot(tenant, inheritedA, monthAPricesV1);
  const invalidSingle = { ...monthACreateBody };
  delete invalidSingle.expectedSourceMonth;
  delete invalidSingle.expectedSourceVersion;
  const missingSingleSource = await productPriceMutation(
    invalidSingle,
    `monthly-price-single-missing-source-${runToken}`,
  );
  assertRejected(missingSingleSource, 422, 'single mutation source tuple is required');

  const monthACreateKey = `monthly-price-a-create-${runToken}`;
  const monthACreated = await productPriceMutation(monthACreateBody, monthACreateKey);
  assertStatus(monthACreated, 200, 'create exact month A');
  assertExactSnapshot(monthACreated.body.productPrice, monthA, 1, monthAPricesV1, 'month A create');

  const monthAReplay = await productPriceMutation(monthACreateBody, monthACreateKey);
  assertStatus(monthAReplay, 200, 'single idempotency replay');
  assert.deepEqual(monthAReplay.body, monthACreated.body, 'single idempotency replay body');

  const monthAKeyReuse = await productPriceMutation(
    { ...monthACreateBody, prices: priceValues(41_000) },
    monthACreateKey,
  );
  assertRejected(monthAKeyReuse, 409, 'single idempotency key reuse');

  const monthAStaleCreate = await productPriceMutation(
    monthACreateBody,
    `monthly-price-a-stale-create-${runToken}`,
  );
  assertRejected(monthAStaleCreate, 409, 'stale exact target create');

  const monthAExactV1 = await getProductPrice(tenant, monthA, productId);
  const monthAPricesV2 = priceValues(42_000);
  const monthAUpdated = await productPriceMutation(
    mutationFromSnapshot(tenant, monthAExactV1, monthAPricesV2),
    `monthly-price-a-update-${runToken}`,
  );
  assertStatus(monthAUpdated, 200, 'update exact month A');
  assertExactSnapshot(monthAUpdated.body.productPrice, monthA, 2, monthAPricesV2, 'month A update');

  const staleMonthCSource = await getProductPrice(tenant, monthC, productId);
  assert.equal(staleMonthCSource.priceInherited, true);
  assert.equal(staleMonthCSource.priceSourceMonth, monthA);
  assert.equal(staleMonthCSource.priceSourceVersion, 2);

  const inheritedB = await getProductPrice(tenant, monthB, productId);
  assert.equal(inheritedB.priceInherited, true);
  assert.equal(inheritedB.priceSourceMonth, monthA);
  assert.equal(inheritedB.priceSourceVersion, 2);
  const monthBPrices = priceValues(50_000);
  const monthBCreated = await productPriceMutation(
    mutationFromSnapshot(tenant, inheritedB, monthBPrices),
    `monthly-price-b-create-${runToken}`,
  );
  assertStatus(monthBCreated, 200, 'insert intermediate month B');
  assertExactSnapshot(monthBCreated.body.productPrice, monthB, 1, monthBPrices, 'month B create');

  const staleMonthC = await productPriceMutation(
    mutationFromSnapshot(tenant, staleMonthCSource, priceValues(60_000)),
    `monthly-price-c-stale-source-${runToken}`,
  );
  assertRejected(staleMonthC, 409, 'intermediate-month source race');

  const freshMonthC = await getProductPrice(tenant, monthC, productId);
  assert.equal(freshMonthC.priceInherited, true);
  assert.equal(freshMonthC.priceVersion, 0);
  assert.equal(freshMonthC.priceSourceMonth, monthB);
  assert.equal(freshMonthC.priceSourceVersion, 1);
  assertPriceValues(freshMonthC, monthBPrices, 'fresh month C carry-forward');
  const monthCPrices = priceValues(61_000);
  const monthCCreated = await productPriceMutation(
    mutationFromSnapshot(tenant, freshMonthC, monthCPrices),
    `monthly-price-c-create-${runToken}`,
  );
  assertStatus(monthCCreated, 200, 'create month C after refreshing source');
  assertExactSnapshot(monthCCreated.body.productPrice, monthC, 1, monthCPrices, 'month C create');

  assertExactSnapshot(
    await getProductPrice(tenant, currentMonth, productId),
    currentMonth,
    1,
    initialPrices,
    'current month independence',
  );
  assertExactSnapshot(
    await getProductPrice(tenant, monthA, productId),
    monthA,
    2,
    monthAPricesV2,
    'month A independence',
  );
  assertExactSnapshot(
    await getProductPrice(tenant, monthB, productId),
    monthB,
    1,
    monthBPrices,
    'month B independence',
  );
  assertExactSnapshot(
    await getProductPrice(tenant, monthC, productId),
    monthC,
    1,
    monthCPrices,
    'month C independence',
  );

  const inheritedD = await getProductPrice(tenant, monthD, productId);
  assert.equal(inheritedD.priceInherited, true);
  assert.equal(inheritedD.priceSourceMonth, monthC);
  assert.equal(inheritedD.priceSourceVersion, 1);
  const monthDPrices = priceValues(70_000);
  const validBulk = {
    schemaVersion: 2,
    tenant,
    priceMonth: monthD,
    source: workbookSource(`monthly-price-small-${runToken}`),
    rows: [bulkRowFromSnapshot(inheritedD, 2, monthDPrices)],
  };

  const legacyBulk = await bulkProductPriceMutation(
    { ...validBulk, schemaVersion: 1 },
    `monthly-price-bulk-legacy-${runToken}`,
  );
  assertRejected(legacyBulk, 422, 'monthly-price bulk schema v1');

  const missingSourceBulkBody = structuredClone(validBulk);
  delete missingSourceBulkBody.rows[0].expectedSourceMonth;
  delete missingSourceBulkBody.rows[0].expectedSourceVersion;
  const missingBulkSource = await bulkProductPriceMutation(
    missingSourceBulkBody,
    `monthly-price-bulk-missing-source-${runToken}`,
  );
  assertRejected(missingBulkSource, 422, 'bulk row source tuple is required');

  const smallBulkKey = `monthly-price-bulk-create-${runToken}`;
  const smallBulk = await bulkProductPriceMutation(validBulk, smallBulkKey);
  assertStatus(smallBulk, 200, 'small monthly-price bulk create');
  assert.equal(smallBulk.body.ok, true);
  assert.deepEqual(smallBulk.body.summary, {
    total: 1,
    created: 1,
    updated: 0,
    failed: 0,
    notApplied: 0,
  });
  assert.deepEqual(smallBulk.body.rowDetails, {
    included: 1,
    total: 1,
    omitted: 0,
    truncated: false,
  });
  assert.equal(smallBulk.body.rows.length, 1);
  assert.equal(smallBulk.body.rows[0].status, 'created');
  assertExactSnapshot(smallBulk.body.rows[0].productPrice, monthD, 1, monthDPrices, 'small bulk result');

  const smallBulkReplay = await bulkProductPriceMutation(validBulk, smallBulkKey);
  assertStatus(smallBulkReplay, 200, 'bulk idempotency replay');
  assert.deepEqual(smallBulkReplay.body, smallBulk.body, 'bulk idempotency replay body');

  const bulkKeyReuseBody = structuredClone(validBulk);
  bulkKeyReuseBody.rows[0].prices = priceValues(71_000);
  const smallBulkKeyReuse = await bulkProductPriceMutation(bulkKeyReuseBody, smallBulkKey);
  assertRejected(smallBulkKeyReuse, 409, 'bulk idempotency key reuse');

  const smallBulkStaleTarget = await bulkProductPriceMutation(
    validBulk,
    `monthly-price-bulk-stale-target-${runToken}`,
  );
  assertRejected(smallBulkStaleTarget, 409, 'bulk stale exact target');

  const otherTenant = TENANTS.find((candidate) => candidate !== tenant);
  const crossTenant = await productPriceMutation(
    {
      ...mutationFromSnapshot(tenant, inheritedD, priceValues(80_000)),
      tenant: otherTenant,
    },
    `monthly-price-cross-tenant-${runToken}`,
  );
  assertRejected(crossTenant, 404, 'monthly-price tenant isolation');

  assertExactSnapshot(
    await getProductPrice(tenant, monthD, productId),
    monthD,
    1,
    monthDPrices,
    'month D bulk persistence',
  );

  let bulk10kResult;
  if (run10k) {
    bulk10kResult = await runTenThousandTest(addMonths(monthD, 600 + runStartedAt % 240));
  }

  const summary = {
    ok: true,
    baseUrl,
    tenant,
    productId,
    months: {
      productBaseFallback: baseMonth,
      currentExact: currentMonth,
      exactA: monthA,
      intermediateB: monthB,
      sourceRaceC: monthC,
      bulkD: monthD,
    },
    verified: [
      'current exact snapshot',
      'monthly independence and carry-forward',
      'Product.version source conflict',
      'intermediate-month source race',
      'single idempotency, key reuse, and stale target',
      'bulk schema v2/source tuple/idempotency/stale target',
      'tenant isolation',
    ],
    requestStats,
    bulk10k: bulk10kResult,
    elapsedMs: Date.now() - runStartedAt,
  };
  console.log(JSON.stringify(summary, null, 2));
}

await main();
