import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const tenant = process.env.SMOKE_TENANT ?? 'DAON';
const rowCount = 10_000;
const timeoutMs = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS ?? 300_000);
const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

const parsedBaseUrl = new URL(baseUrl);
assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedBaseUrl.hostname), '10k smoke는 로컬 격리 서버에서만 실행할 수 있습니다.');

function source(label) {
  return {
    fileName: `${label}.xlsx`,
    fileSha256: createHash('sha256').update(label).digest('hex'),
  };
}

async function postBulk(body, idempotencyKey) {
  const serialized = JSON.stringify(body);
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/erp/products/bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: serialized,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  const result = raw ? JSON.parse(raw) : null;
  assert.equal(response.status, 200, raw.slice(0, 2_000));
  assert.equal(result?.ok, true);
  return {
    result,
    payloadBytes: Buffer.byteLength(serialized),
    acknowledgementBytes: Buffer.byteLength(raw),
    elapsedMs: Math.round(performance.now() - started),
  };
}

const products = Array.from({ length: rowCount }, (_, index) => ({
  sku: `PG10K-${token}-${index.toString(36).toUpperCase().padStart(3, '0')}`,
  name: `PostgreSQL 대량 상품 ${index + 1}`,
  category: '대량검증',
  specification: '1kg / 규격',
  unit: 'KG',
  schoolPriceKg: 10_000 + index,
  schoolPriceSpec: 20_000 + index,
  schoolPriceEach: 30_000 + index,
  vendorPriceKg: 9_000 + index,
  vendorPriceSpec: 19_000 + index,
  vendorPriceEach: 29_000 + index,
  purchasePriceKg: 8_000 + index,
  purchasePriceSpec: 18_000 + index,
  purchasePriceEach: 28_000 + index,
  supplierName: 'PostgreSQL 대량 검증 업체',
  storageType: 'AMBIENT',
  allergens: '',
}));

const create = await postBulk({
  schemaVersion: 2,
  tenant,
  source: source(`product-create-${token}`),
  rows: products.map((product, index) => ({
    rowNumber: index + 2,
    action: 'create',
    product,
  })),
}, `smoke-product-create-10k-${token}`);

assert.deepEqual(create.result.summary, {
  total: rowCount,
  created: rowCount,
  updated: 0,
  failed: 0,
  notApplied: 0,
});
assert.equal(create.result.createdProductIds.length, rowCount);
assert.equal(new Set(create.result.createdProductIds).size, rowCount);
assert.deepEqual(create.result.vectorization, {
  mode: 'ASYNC',
  status: 'QUEUED',
  queued: rowCount,
  statusUrl: `/api/erp/products/vectorization?tenant=${tenant}`,
});

const update = await postBulk({
  schemaVersion: 2,
  tenant,
  source: source(`product-update-${token}`),
  rows: products.map((product, index) => ({
    rowNumber: index + 2,
    action: 'update',
    id: create.result.createdProductIds[index],
    expectedVersion: 1,
    product: {
      ...product,
      name: `PostgreSQL 대량 수정 상품 ${index + 1}`,
      schoolPriceKg: product.schoolPriceKg + 111,
      vendorPriceSpec: product.vendorPriceSpec + 222,
      purchasePriceEach: product.purchasePriceEach + 333,
    },
  })),
}, `smoke-product-update-10k-${token}`);

assert.deepEqual(update.result.summary, {
  total: rowCount,
  created: 0,
  updated: rowCount,
  failed: 0,
  notApplied: 0,
});
assert.deepEqual(update.result.rowDetails, {
  included: 0,
  total: rowCount,
  omitted: rowCount,
  truncated: true,
});
assert.deepEqual(update.result.vectorization, {
  mode: 'ASYNC',
  status: 'QUEUED',
  queued: rowCount,
  statusUrl: `/api/erp/products/vectorization?tenant=${tenant}`,
});

const readbackResponse = await fetch(`${baseUrl}/api/erp?tenant=${encodeURIComponent(tenant)}`, {
  signal: AbortSignal.timeout(timeoutMs),
});
const readback = await readbackResponse.json();
assert.equal(readbackResponse.status, 200, JSON.stringify(readback).slice(0, 2_000));
const createdIds = new Set(create.result.createdProductIds);
const persisted = readback.products.filter((product) => createdIds.has(product.id));
assert.equal(persisted.length, rowCount);
assert.ok(persisted.every((product) => product.version === 2));
assert.ok(persisted.every((product) => product.name.startsWith('PostgreSQL 대량 수정 상품 ')));
assert.ok(persisted.every((product) => product.schoolPriceKg >= 10_111));
assert.ok(persisted.every((product) => product.vendorPriceSpec >= 19_222));
assert.ok(persisted.every((product) => product.purchasePriceEach >= 28_333));

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  tenant,
  rowCount,
  mutationRequests: { create: 1, update: 1 },
  readback: { matched: persisted.length, version: 2 },
  create: {
    elapsedMs: create.elapsedMs,
    payloadBytes: create.payloadBytes,
    acknowledgementBytes: create.acknowledgementBytes,
  },
  update: {
    elapsedMs: update.elapsedMs,
    payloadBytes: update.payloadBytes,
    acknowledgementBytes: update.acknowledgementBytes,
  },
}, null, 2));
