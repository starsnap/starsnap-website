import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3110').replace(/\/$/, '');
const runToken = `${Date.now()}`.slice(-10);

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const body = text && response.headers.get('content-type')?.includes('application/json')
    ? JSON.parse(text)
    : text;
  return { response, body };
}

function source(label) {
  return {
    fileName: `${label}.xlsx`,
    fileSha256: createHash('sha256').update(label).digest('hex'),
  };
}

function product(index, revision) {
  const priceBase = revision * 100_000 + index;
  return {
    sku: `TENK-${runToken}-${String(index).padStart(5, '0')}`,
    name: `10K 검증 상품 ${index} 수정 ${revision}`,
    category: '10K 검증',
    specification: `${revision + 1}kg / BOX`,
    unit: index % 3 === 0 ? 'KG' : index % 3 === 1 ? 'EA' : 'BOX',
    schoolPriceKg: priceBase + 1,
    schoolPriceSpec: priceBase + 2,
    schoolPriceEach: priceBase + 3,
    vendorPriceKg: priceBase + 4,
    vendorPriceSpec: priceBase + 5,
    vendorPriceEach: priceBase + 6,
    purchasePriceKg: priceBase + 7,
    purchasePriceSpec: priceBase + 8,
    purchasePriceEach: priceBase + 9,
    supplierName: '10K 검증 공급업체',
    storageType: index % 2 === 0 ? 'CHILLED' : 'FROZEN',
    allergens: index % 2 === 0 ? '대두' : '',
  };
}

async function bulk(body, key) {
  const started = performance.now();
  const result = await request('/api/erp/products/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  return { ...result, elapsedMs: Math.round(performance.now() - started) };
}

// Initialize a brand-new local D1 before measuring the bulk path itself.
assert.equal((await request('/api/erp?tenant=HANBIT')).response.status, 200);

const createRequest = {
  schemaVersion: 2,
  tenant: 'HANBIT',
  source: source(`10k-create-${runToken}`),
  rows: Array.from({ length: 10_000 }, (_, index) => ({
    rowNumber: index + 2,
    action: 'create',
    product: product(index, 1),
  })),
};
const createKey = `10k-create-${runToken}`;
const created = await bulk(createRequest, createKey);
assert.equal(created.response.status, 200, JSON.stringify(created.body));
assert.deepEqual(created.body.summary, { total: 10_000, created: 10_000, updated: 0, failed: 0, notApplied: 0 });
assert.deepEqual(created.body.rows, []);
assert.deepEqual(created.body.rowDetails, { included: 0, total: 10_000, omitted: 10_000, truncated: true });

const afterCreate = await request('/api/erp?tenant=HANBIT');
assert.equal(afterCreate.response.status, 200);
const createdProducts = afterCreate.body.products.filter((item) => item.sku.startsWith(`TENK-${runToken}-`));
assert.equal(createdProducts.length, 10_000);
const bySku = new Map(createdProducts.map((item) => [item.sku, item]));
for (const index of [0, 4_999, 9_999]) {
  const saved = bySku.get(product(index, 1).sku);
  assert.ok(saved);
  assert.equal(saved.version, 1);
  assert.equal(saved.vendorPriceEach, product(index, 1).vendorPriceEach);
}

const updateRequest = {
  schemaVersion: 2,
  tenant: 'HANBIT',
  source: source(`10k-update-${runToken}`),
  rows: Array.from({ length: 10_000 }, (_, index) => {
    const desired = product(index, 2);
    const saved = bySku.get(desired.sku);
    assert.ok(saved);
    return {
      rowNumber: index + 2,
      action: 'update',
      id: saved.id,
      expectedVersion: 1,
      product: desired,
    };
  }),
};
const updateKey = `10k-update-${runToken}`;
const updated = await bulk(updateRequest, updateKey);
assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
assert.deepEqual(updated.body.summary, { total: 10_000, created: 0, updated: 10_000, failed: 0, notApplied: 0 });
assert.deepEqual(updated.body.rows, []);
assert.equal(JSON.stringify(updated.body).length < 2_000_000, true);

const replay = await bulk(updateRequest, updateKey);
assert.equal(replay.response.status, 200);
assert.deepEqual(replay.body, updated.body);

const afterUpdate = await request('/api/erp?tenant=HANBIT');
const updatedProducts = afterUpdate.body.products.filter((item) => item.sku.startsWith(`TENK-${runToken}-`));
assert.equal(updatedProducts.length, 10_000);
const updatedBySku = new Map(updatedProducts.map((item) => [item.sku, item]));
for (const index of [0, 4_999, 9_999]) {
  const saved = updatedBySku.get(product(index, 2).sku);
  assert.ok(saved);
  assert.equal(saved.version, 2);
  assert.equal(saved.name, product(index, 2).name);
  assert.equal(saved.purchasePriceSpec, product(index, 2).purchasePriceSpec);
}

const staleRequest = structuredClone(updateRequest);
staleRequest.source = source(`10k-stale-${runToken}`);
staleRequest.rows[0].expectedVersion = 1;
staleRequest.rows.slice(1).forEach((row) => { row.expectedVersion = 2; });
const stale = await bulk(staleRequest, `10k-stale-${runToken}`);
assert.equal(stale.response.status, 409);
assert.deepEqual(stale.body.summary, { total: 10_000, created: 0, updated: 0, failed: 1, notApplied: 9_999 });
assert.equal(stale.body.rows.length, 1);
assert.equal(stale.body.rows[0].errors[0].code, 'VERSION_CONFLICT');
assert.deepEqual(stale.body.rowDetails, { included: 1, total: 10_000, omitted: 9_999, truncated: true });

console.log(JSON.stringify({
  createMs: created.elapsedMs,
  updateMs: updated.elapsedMs,
  replayMs: replay.elapsedMs,
  staleConflictMs: stale.elapsedMs,
  productsVerified: updatedProducts.length,
}));
