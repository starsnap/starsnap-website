import type { PoolClient } from 'pg';
import type {
  BulkProductMutationResult,
  BulkProductRequest,
  BulkProductRowError,
  BulkProductRowResult,
  Product,
  ProductInput,
  ProductMutation,
} from '@/app/lib/erp-types';
import { currentPriceMonth } from '@/app/lib/price-month';
import { ensureDatabase } from './bootstrap';
import { claimIdempotency, commitIdempotency, releaseIdempotency } from './idempotency';
import { queryAll, queryOne, withTransaction } from './postgres';
import { enqueueProductEmbeddingJobs } from './product-embedding-queue';

const productColumns = `id, sku, name, category, specification, unit,
  school_price_kg AS "schoolPriceKg", school_price_spec AS "schoolPriceSpec",
  school_price_each AS "schoolPriceEach", vendor_price_kg AS "vendorPriceKg",
  vendor_price_spec AS "vendorPriceSpec", vendor_price_each AS "vendorPriceEach",
  purchase_price_kg AS "purchasePriceKg", purchase_price_spec AS "purchasePriceSpec",
  purchase_price_each AS "purchasePriceEach", supplier_name AS "supplierName",
  storage_type AS "storageType", allergens, status, version, updated_at AS "updatedAt"`;
const productSelect = `SELECT ${productColumns} FROM products`;
const IDEMPOTENCY_LEASE_MS = 60_000;
const BULK_IDEMPOTENCY_LEASE_MS = 10 * 60_000;
const BULK_DETAILED_RESPONSE_ROW_LIMIT = 500;
const BULK_ERROR_DETAIL_LIMIT = 200;

interface TenantRow { id: string }
interface CountRow { count: number }
interface StagedBulkRow {
  rowNumber: number;
  action: 'create' | 'update';
  productId: string;
  expectedVersion: number | null;
  product: ProductInput;
}
interface BulkWorkJsonRow {
  row_number: number;
  action: 'create' | 'update';
  product_id: string;
  expected_version: number | null;
  sku: string;
  name: string;
  category: string;
  specification: string;
  unit: string;
  school_price_kg: number;
  school_price_spec: number;
  school_price_each: number;
  vendor_price_kg: number;
  vendor_price_spec: number;
  vendor_price_each: number;
  purchase_price_kg: number;
  purchase_price_spec: number;
  purchase_price_each: number;
  supplier_name: string;
  storage_type: string;
  allergens: string;
}
type StagedConflictCode =
  | 'DUPLICATE_ROW_NUMBER'
  | 'DUPLICATE_SKU_IN_FILE'
  | 'DUPLICATE_PRODUCT_ID_IN_FILE'
  | 'PRODUCT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'SKU_ALREADY_EXISTS';
interface StagedConflict {
  rowNumber: number;
  code: StagedConflictCode;
  currentVersion: number | null;
}

function legacyUnitPrice(product: Pick<Product, 'unit' | 'purchasePriceKg' | 'purchasePriceSpec' | 'purchasePriceEach'>) {
  if (product.unit === 'KG') return product.purchasePriceKg;
  if (product.unit === 'EA') return product.purchasePriceEach;
  return product.purchasePriceSpec;
}

async function requestHash(operation: string, request: unknown) {
  let canonical = JSON.stringify({ operation, request });
  const encoded = new TextEncoder().encode(canonical);
  canonical = '';
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBulkProductFingerprint(request: BulkProductRequest) {
  return requestHash('product-bulk-v2', request);
}

async function acquireProductLock(client: PoolClient, tenantId: string) {
  await queryAll(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`mealops:products:${tenantId}`],
    client,
  );
}

async function insertAudit(
  client: PoolClient,
  tenantId: string,
  actor: string,
  action: string,
  entityId: string,
  detail: string,
  now: string,
) {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO audit_logs
       (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
     VALUES ($1, $2, $3, $4, 'products', $5, $6, $7)
     RETURNING id`,
    [crypto.randomUUID(), tenantId, actor, action, entityId, detail, now],
    client,
  );
  if (!inserted) throw new Error('상품 감사 로그를 저장하지 못했습니다.');
}

async function queueProductSearchVectors(
  client: PoolClient,
  tenantId: string,
  products: readonly { productId: string; targetVersion: number }[],
) {
  const expectedCount = new Set(products.map((product) => product.productId)).size;
  const queuedCount = await enqueueProductEmbeddingJobs(client, tenantId, products);
  if (queuedCount !== expectedCount) {
    throw new Error(`상품 검색 벡터 작업 예약 행 수가 요청과 일치하지 않습니다. (${queuedCount}/${expectedCount})`);
  }
  return queuedCount;
}

export async function applyProductMutation(mutation: ProductMutation, idempotencyKey: string, actor: string) {
  await ensureDatabase();
  const fingerprint = await requestHash('product-mutation-v2', mutation);
  const now = new Date().toISOString();

  return withTransaction(async (client) => {
    const tenant = await queryOne<TenantRow>(
      `SELECT id FROM tenants WHERE code = $1 AND status = 'ACTIVE'`,
      [mutation.tenant],
      client,
    );
    if (!tenant) return { status: 404, body: { ok: false, message: '회사를 찾을 수 없습니다.' } };

    const claim = await claimIdempotency(client, tenant.id, idempotencyKey, fingerprint, now, IDEMPOTENCY_LEASE_MS);
    if (claim.kind === 'result') return claim.result;
    const { leaseToken } = claim;

    await acquireProductLock(client, tenant.id);

    const current = mutation.action === 'create'
      ? undefined
      : await queryOne<Product>(`${productSelect} WHERE tenant_id = $1 AND id = $2`, [tenant.id, mutation.id], client);
    if (mutation.action !== 'create' && !current) {
      await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken);
      return { status: 404, body: { ok: false, message: '현재 회사에서 해당 상품을 찾을 수 없습니다.' } };
    }
    if (mutation.action !== 'create' && current?.version !== mutation.expectedVersion) {
      await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken);
      return {
        status: 409,
        body: { ok: false, message: '다른 사용자가 상품을 먼저 변경했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.' },
      };
    }

    if (mutation.action !== 'set-status') {
      const duplicateSku = await queryOne<{ id: string }>(
        `SELECT id FROM products WHERE tenant_id = $1 AND sku = $2 AND id <> $3`,
        [tenant.id, mutation.product.sku, mutation.action === 'create' ? '' : mutation.id],
        client,
      );
      if (duplicateSku) {
        await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken);
        return { status: 409, body: { ok: false, message: '같은 상품 코드가 이미 등록되어 있습니다.' } };
      }
    }

    if (mutation.action === 'create') {
      const product = mutation.product;
      const id = crypto.randomUUID();
      const created = await queryOne<Product>(
        `INSERT INTO products
          (id, tenant_id, sku, name, category, specification, unit, unit_price,
           school_price_kg, school_price_spec, school_price_each,
           vendor_price_kg, vendor_price_spec, vendor_price_each,
           purchase_price_kg, purchase_price_spec, purchase_price_each,
           supplier_name, storage_type, allergens, status, version, created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, $20, 'ACTIVE', 1, $21, $21)
         RETURNING ${productColumns}`,
        [
          id, tenant.id, product.sku, product.name, product.category, product.specification, product.unit,
          legacyUnitPrice(product), product.schoolPriceKg, product.schoolPriceSpec, product.schoolPriceEach,
          product.vendorPriceKg, product.vendorPriceSpec, product.vendorPriceEach, product.purchasePriceKg,
          product.purchasePriceSpec, product.purchasePriceEach, product.supplierName, product.storageType,
          product.allergens, now,
        ],
        client,
      );
      if (!created) throw new Error('상품 등록 결과를 확인할 수 없습니다.');
      const queuedCount = await queueProductSearchVectors(client, tenant.id, [
        { productId: created.id, targetVersion: created.version },
      ]);
      const body = {
        ok: true,
        product: created,
        createdPriceMonth: currentPriceMonth(new Date(now)),
        vectorization: {
          mode: 'ASYNC' as const,
          status: 'QUEUED' as const,
          queued: queuedCount,
          targetVersion: created.version,
          statusUrl: `/api/erp/products/vectorization?tenant=${mutation.tenant}`,
        },
        message: `${created.name} 상품을 등록했습니다. 유사 검색 벡터는 백그라운드에서 생성됩니다.`,
      };
      await insertAudit(client, tenant.id, actor, mutation.action, created.id, `${created.sku} 등록`, now);
      await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
      return { status: 200, body };
    }

    if (mutation.action === 'set-status') {
      if (current?.status === mutation.status) {
        const body = {
          ok: true,
          product: current,
          alreadyApplied: true,
          vectorization: { mode: 'ASYNC' as const, status: 'NOT_REQUIRED' as const, queued: 0 },
          message: `이미 ${mutation.status === 'ACTIVE' ? '사용' : '사용 중지'} 상태입니다.`,
        };
        await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
        return { status: 200, body };
      }
      const updated = await queryOne<Product>(
        `UPDATE products SET status = $1, version = version + 1, updated_at = $2
         WHERE tenant_id = $3 AND id = $4 AND version = $5
         RETURNING ${productColumns}`,
        [mutation.status, now, tenant.id, mutation.id, mutation.expectedVersion],
        client,
      );
      if (!updated) throw new Error('상품 상태 변경 행 수가 요청과 일치하지 않습니다.');
      const queuedCount = await queueProductSearchVectors(client, tenant.id, [
        { productId: updated.id, targetVersion: updated.version },
      ]);
      const label = mutation.status === 'ACTIVE' ? '사용' : '사용 중지';
      const body = {
        ok: true,
        product: updated,
        vectorization: {
          mode: 'ASYNC' as const,
          status: 'QUEUED' as const,
          queued: queuedCount,
          targetVersion: updated.version,
          statusUrl: `/api/erp/products/vectorization?tenant=${mutation.tenant}`,
        },
        message: `${updated.name} 상품을 ${label} 상태로 변경했습니다. 유사 검색 정보는 백그라운드에서 반영됩니다.`,
      };
      await insertAudit(client, tenant.id, actor, mutation.action, updated.id, `${current?.status} → ${mutation.status}`, now);
      await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
      return { status: 200, body };
    }

    const product = mutation.product;
    const updated = await queryOne<Product>(
      `UPDATE products SET
        sku = $1, name = $2, category = $3, specification = $4, unit = $5, unit_price = $6,
        school_price_kg = $7, school_price_spec = $8, school_price_each = $9,
        vendor_price_kg = $10, vendor_price_spec = $11, vendor_price_each = $12,
        purchase_price_kg = $13, purchase_price_spec = $14, purchase_price_each = $15,
        supplier_name = $16, storage_type = $17, allergens = $18,
        version = version + 1, updated_at = $19
       WHERE tenant_id = $20 AND id = $21 AND version = $22
       RETURNING ${productColumns}`,
      [
        product.sku, product.name, product.category, product.specification, product.unit, legacyUnitPrice(product),
        product.schoolPriceKg, product.schoolPriceSpec, product.schoolPriceEach, product.vendorPriceKg,
        product.vendorPriceSpec, product.vendorPriceEach, product.purchasePriceKg, product.purchasePriceSpec,
        product.purchasePriceEach, product.supplierName, product.storageType, product.allergens,
        now, tenant.id, mutation.id, mutation.expectedVersion,
      ],
      client,
    );
    if (!updated) throw new Error('상품 수정 행 수가 요청과 일치하지 않습니다.');
    const queuedCount = await queueProductSearchVectors(client, tenant.id, [
      { productId: updated.id, targetVersion: updated.version },
    ]);
    const body = {
      ok: true,
      product: updated,
      vectorization: {
        mode: 'ASYNC' as const,
        status: 'QUEUED' as const,
        queued: queuedCount,
        targetVersion: updated.version,
        statusUrl: `/api/erp/products/vectorization?tenant=${mutation.tenant}`,
      },
      message: `${updated.name} 상품 정보를 수정했습니다. 유사 검색 벡터는 백그라운드에서 갱신됩니다.`,
    };
    await insertAudit(client, tenant.id, actor, mutation.action, updated.id, `v${mutation.expectedVersion} → v${updated.version}`, now);
    await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
    return { status: 200, body };
  });
}

function buildStagedRows(request: BulkProductRequest) {
  return request.rows.map<StagedBulkRow>((row) => ({
    rowNumber: row.rowNumber,
    action: row.action,
    productId: row.action === 'create' ? crypto.randomUUID() : row.id,
    expectedVersion: row.action === 'update' ? row.expectedVersion : null,
    product: row.product,
  }));
}

function workJson(stagedRows: StagedBulkRow[]) {
  return JSON.stringify(stagedRows.map<BulkWorkJsonRow>((row) => ({
    row_number: row.rowNumber,
    action: row.action,
    product_id: row.productId,
    expected_version: row.expectedVersion,
    sku: row.product.sku,
    name: row.product.name,
    category: row.product.category,
    specification: row.product.specification,
    unit: row.product.unit,
    school_price_kg: row.product.schoolPriceKg,
    school_price_spec: row.product.schoolPriceSpec,
    school_price_each: row.product.schoolPriceEach,
    vendor_price_kg: row.product.vendorPriceKg,
    vendor_price_spec: row.product.vendorPriceSpec,
    vendor_price_each: row.product.vendorPriceEach,
    purchase_price_kg: row.product.purchasePriceKg,
    purchase_price_spec: row.product.purchasePriceSpec,
    purchase_price_each: row.product.purchasePriceEach,
    supplier_name: row.product.supplierName,
    storage_type: row.product.storageType,
    allergens: row.product.allergens,
  })));
}

async function createBulkWorkTable(client: PoolClient, stagedRows: StagedBulkRow[]) {
  await queryAll(
    `CREATE TEMPORARY TABLE product_bulk_work (
       row_number integer NOT NULL, action text NOT NULL, product_id text NOT NULL,
       expected_version integer, sku text NOT NULL, name text NOT NULL,
       category text NOT NULL, specification text NOT NULL, unit text NOT NULL,
       school_price_kg integer NOT NULL, school_price_spec integer NOT NULL,
       school_price_each integer NOT NULL, vendor_price_kg integer NOT NULL,
       vendor_price_spec integer NOT NULL, vendor_price_each integer NOT NULL,
       purchase_price_kg integer NOT NULL, purchase_price_spec integer NOT NULL,
       purchase_price_each integer NOT NULL, supplier_name text NOT NULL,
       storage_type text NOT NULL, allergens text NOT NULL
     ) ON COMMIT DROP`,
    [],
    client,
  );
  const loaded = await queryOne<CountRow>(
    `WITH inserted AS (
       INSERT INTO product_bulk_work
         (row_number, action, product_id, expected_version, sku, name, category,
          specification, unit, school_price_kg, school_price_spec, school_price_each,
          vendor_price_kg, vendor_price_spec, vendor_price_each, purchase_price_kg,
          purchase_price_spec, purchase_price_each, supplier_name, storage_type, allergens)
       SELECT row_number, action, product_id, expected_version, sku, name, category,
         specification, unit, school_price_kg, school_price_spec, school_price_each,
         vendor_price_kg, vendor_price_spec, vendor_price_each, purchase_price_kg,
         purchase_price_spec, purchase_price_each, supplier_name, storage_type, allergens
       FROM jsonb_to_recordset($1::jsonb) AS source(
         row_number integer, action text, product_id text, expected_version integer,
         sku text, name text, category text, specification text, unit text,
         school_price_kg integer, school_price_spec integer, school_price_each integer,
         vendor_price_kg integer, vendor_price_spec integer, vendor_price_each integer,
         purchase_price_kg integer, purchase_price_spec integer, purchase_price_each integer,
         supplier_name text, storage_type text, allergens text)
       RETURNING 1
     ) SELECT count(*)::integer AS count FROM inserted`,
    [workJson(stagedRows)],
    client,
  );
  if (loaded?.count !== stagedRows.length) throw new Error('상품 일괄 처리 준비 데이터를 완전하게 적재하지 못했습니다.');
}

async function acquireBulkProductLocks(client: PoolClient, tenantId: string) {
  await queryAll(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`mealops:products:${tenantId}`],
    client,
  );
}

async function collectStagedConflicts(client: PoolClient, tenantId: string) {
  const conflicts = await queryAll<StagedConflict>(
    `WITH joined AS (
       SELECT work.row_number AS "rowNumber", work.action,
         work.product_id AS "productId", work.expected_version AS "expectedVersion",
         target.id AS "targetId", target.version AS "currentVersion",
         sku_owner.id AS "skuOwnerId"
       FROM product_bulk_work AS work
       LEFT JOIN products AS target ON target.tenant_id = $1 AND target.id = work.product_id
       LEFT JOIN products AS sku_owner ON sku_owner.tenant_id = $1 AND sku_owner.sku = work.sku
     ), duplicate_rows AS (
       SELECT row_number FROM product_bulk_work GROUP BY row_number HAVING count(*) > 1
     ), duplicate_skus AS (
       SELECT sku FROM product_bulk_work GROUP BY sku HAVING count(*) > 1
     ), duplicate_ids AS (
       SELECT product_id FROM product_bulk_work WHERE action = 'update'
       GROUP BY product_id HAVING count(*) > 1
     )
     SELECT work.row_number AS "rowNumber", 'DUPLICATE_ROW_NUMBER' AS code, NULL::integer AS "currentVersion"
     FROM product_bulk_work AS work JOIN duplicate_rows USING (row_number)
     UNION ALL
     SELECT work.row_number, 'DUPLICATE_SKU_IN_FILE', NULL::integer
     FROM product_bulk_work AS work JOIN duplicate_skus USING (sku)
     UNION ALL
     SELECT work.row_number, 'DUPLICATE_PRODUCT_ID_IN_FILE', NULL::integer
     FROM product_bulk_work AS work JOIN duplicate_ids USING (product_id)
     UNION ALL
     SELECT "rowNumber", 'PRODUCT_NOT_FOUND', NULL::integer FROM joined
     WHERE action = 'update' AND "targetId" IS NULL
     UNION ALL
     SELECT "rowNumber", 'VERSION_CONFLICT', "currentVersion" FROM joined
     WHERE action = 'update' AND "targetId" IS NOT NULL AND "currentVersion" <> "expectedVersion"
     UNION ALL
     SELECT "rowNumber", 'SKU_ALREADY_EXISTS', NULL::integer FROM joined
     WHERE "skuOwnerId" IS NOT NULL AND (action = 'create' OR "skuOwnerId" <> "productId")
     ORDER BY "rowNumber", code`,
    [tenantId],
    client,
  );
  const errors = new Map<number, BulkProductRowError[]>();
  for (const conflict of conflicts) {
    let error: BulkProductRowError;
    if (conflict.code === 'DUPLICATE_ROW_NUMBER') {
      error = { field: 'rowNumber', code: conflict.code, message: '파일 안에서 행 번호가 중복되었습니다.' };
    } else if (conflict.code === 'DUPLICATE_SKU_IN_FILE') {
      error = { field: 'sku', code: conflict.code, message: '파일 안에서 상품 코드가 중복되었습니다.' };
    } else if (conflict.code === 'DUPLICATE_PRODUCT_ID_IN_FILE') {
      error = { field: 'id', code: conflict.code, message: '같은 상품을 파일에서 두 번 이상 수정할 수 없습니다.' };
    } else if (conflict.code === 'PRODUCT_NOT_FOUND') {
      error = { field: 'id', code: conflict.code, message: '현재 회사에서 수정할 상품을 찾을 수 없습니다.' };
    } else if (conflict.code === 'VERSION_CONFLICT') {
      error = { field: 'expectedVersion', code: conflict.code, message: `상품 버전이 변경되었습니다. 현재 버전은 ${conflict.currentVersion}입니다.` };
    } else {
      error = { field: 'sku', code: conflict.code, message: '현재 회사에서 같은 상품 코드를 이미 사용하고 있습니다.' };
    }
    errors.set(conflict.rowNumber, [...(errors.get(conflict.rowNumber) ?? []), error]);
  }
  return errors;
}

function rejectedBulkBody(
  request: BulkProductRequest,
  errors: Map<number, BulkProductRowError[]>,
  message: string,
): BulkProductMutationResult {
  const failedRows = request.rows.filter((row) => errors.has(row.rowNumber));
  const rows = failedRows.slice(0, BULK_ERROR_DETAIL_LIMIT).map<BulkProductRowResult>((row) => ({
    rowNumber: row.rowNumber,
    action: row.action,
    status: 'error',
    errors: errors.get(row.rowNumber),
  }));
  const detailNote = failedRows.length > BULK_ERROR_DETAIL_LIMIT
    ? ` 오류 상세는 처음 ${BULK_ERROR_DETAIL_LIMIT}행만 표시합니다.`
    : '';
  return {
    ok: false,
    message: `${message}${detailNote}`,
    summary: {
      total: request.rows.length, created: 0, updated: 0,
      failed: failedRows.length, notApplied: request.rows.length - failedRows.length,
    },
    rowDetails: {
      included: rows.length, total: request.rows.length,
      omitted: request.rows.length - rows.length, truncated: rows.length < request.rows.length,
    },
    rows,
  };
}

function asBulkReplay(request: BulkProductRequest, result: { status: number; body: unknown }) {
  if (typeof result.body === 'object' && result.body !== null && 'summary' in result.body && 'rows' in result.body) {
    return result as { status: number; body: BulkProductMutationResult };
  }
  const message = typeof result.body === 'object' && result.body !== null
    && 'message' in result.body && typeof result.body.message === 'string'
    ? result.body.message
    : '일괄 요청 상태를 확인할 수 없습니다.';
  return { status: result.status, body: rejectedBulkBody(request, new Map(), message) };
}

function detailedSuccessRows(stagedRows: StagedBulkRow[], currentProducts: Product[], now: string) {
  const byId = new Map(currentProducts.map((product) => [product.id, product]));
  return stagedRows.map<BulkProductRowResult>((row) => ({
    rowNumber: row.rowNumber,
    action: row.action,
    status: row.action === 'create' ? 'created' : 'updated',
    product: {
      id: row.productId,
      ...row.product,
      status: row.action === 'create' ? 'ACTIVE' : byId.get(row.productId)?.status ?? 'ACTIVE',
      version: row.action === 'create' ? 1 : (row.expectedVersion as number) + 1,
      updatedAt: now,
    },
  }));
}

async function currentProductsForDetailedResponse(client: PoolClient, tenantId: string, stagedRows: StagedBulkRow[]) {
  const updateIds = stagedRows.flatMap((row) => row.action === 'update' ? [row.productId] : []);
  if (updateIds.length === 0) return [];
  return queryAll<Product>(`${productSelect} WHERE tenant_id = $1 AND id = ANY($2::text[])`, [tenantId, updateIds], client);
}

async function applyBulkRows(client: PoolClient, tenantId: string, now: string, createCount: number, updateCount: number) {
  if (createCount > 0) {
    const inserted = await queryOne<CountRow>(
      `WITH inserted AS (
         INSERT INTO products
          (id, tenant_id, sku, name, category, specification, unit, unit_price,
           school_price_kg, school_price_spec, school_price_each,
           vendor_price_kg, vendor_price_spec, vendor_price_each,
           purchase_price_kg, purchase_price_spec, purchase_price_each,
           supplier_name, storage_type, allergens, status, version, created_at, updated_at)
         SELECT work.product_id, $1, work.sku, work.name, work.category, work.specification,
           work.unit, CASE work.unit WHEN 'KG' THEN work.purchase_price_kg
             WHEN 'EA' THEN work.purchase_price_each ELSE work.purchase_price_spec END,
           work.school_price_kg, work.school_price_spec, work.school_price_each,
           work.vendor_price_kg, work.vendor_price_spec, work.vendor_price_each,
           work.purchase_price_kg, work.purchase_price_spec, work.purchase_price_each,
           work.supplier_name, work.storage_type, work.allergens, 'ACTIVE', 1, $2, $2
         FROM product_bulk_work AS work WHERE work.action = 'create'
         ORDER BY work.row_number RETURNING 1
       ) SELECT count(*)::integer AS count FROM inserted`,
      [tenantId, now], client,
    );
    if (inserted?.count !== createCount) throw new Error('상품 일괄 등록 행 수가 요청과 일치하지 않습니다.');
  }
  if (updateCount > 0) {
    const updated = await queryOne<CountRow>(
      `WITH updated AS (
         UPDATE products AS product SET
           sku = work.sku, name = work.name, category = work.category,
           specification = work.specification, unit = work.unit,
           unit_price = CASE work.unit WHEN 'KG' THEN work.purchase_price_kg
             WHEN 'EA' THEN work.purchase_price_each ELSE work.purchase_price_spec END,
           school_price_kg = work.school_price_kg, school_price_spec = work.school_price_spec,
           school_price_each = work.school_price_each, vendor_price_kg = work.vendor_price_kg,
           vendor_price_spec = work.vendor_price_spec, vendor_price_each = work.vendor_price_each,
           purchase_price_kg = work.purchase_price_kg, purchase_price_spec = work.purchase_price_spec,
           purchase_price_each = work.purchase_price_each, supplier_name = work.supplier_name,
           storage_type = work.storage_type, allergens = work.allergens,
           version = work.expected_version + 1, updated_at = $2
         FROM product_bulk_work AS work
         WHERE work.action = 'update' AND product.tenant_id = $1
           AND product.id = work.product_id AND product.version = work.expected_version
         RETURNING 1
       ) SELECT count(*)::integer AS count FROM updated`,
      [tenantId, now], client,
    );
    if (updated?.count !== updateCount) throw new Error('상품 일괄 수정 행 수가 요청과 일치하지 않습니다.');
  }
}

async function insertBulkAudits(client: PoolClient, tenantId: string, actor: string, request: BulkProductRequest, now: string) {
  const itemAudits = await queryOne<CountRow>(
    `WITH inserted AS (
       INSERT INTO audit_logs
         (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
       SELECT gen_random_uuid()::text, $1, $2, work.action, 'products', work.product_id,
         CASE work.action WHEN 'create'
           THEN '엑셀 ' || work.row_number || '행 · ' || work.sku || ' 등록'
           ELSE '엑셀 ' || work.row_number || '행 · v' || work.expected_version
             || ' → v' || (work.expected_version + 1) END, $3
       FROM product_bulk_work AS work RETURNING 1
     ) SELECT count(*)::integer AS count FROM inserted`,
    [tenantId, actor, now], client,
  );
  if (itemAudits?.count !== request.rows.length) throw new Error('상품 일괄 처리 감사 로그 행 수가 요청과 일치하지 않습니다.');
  const importAudit = await queryOne<{ id: string }>(
    `INSERT INTO audit_logs
       (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
     VALUES ($1, $2, $3, 'bulk-import', 'products', $4, $5, $6) RETURNING id`,
    [
      crypto.randomUUID(), tenantId, actor, `bulk:${request.source.fileSha256.slice(0, 16)}`,
      `${request.source.fileName} · ${request.rows.length}건 일괄 반영`, now,
    ],
    client,
  );
  if (!importAudit) throw new Error('상품 일괄 처리 요약 감사 로그를 저장하지 못했습니다.');
}

export async function applyBulkProductMutation(
  request: BulkProductRequest,
  idempotencyKey: string,
  actor: string,
  fingerprint: string,
) {
  await ensureDatabase();
  const now = new Date().toISOString();
  return withTransaction(async (client) => {
    const tenant = await queryOne<TenantRow>(
      `SELECT id FROM tenants WHERE code = $1 AND status = 'ACTIVE'`,
      [request.tenant], client,
    );
    if (!tenant) return { status: 404, body: rejectedBulkBody(request, new Map(), '회사를 찾을 수 없습니다.') };

    const claim = await claimIdempotency(
      client, tenant.id, idempotencyKey, fingerprint, now, BULK_IDEMPOTENCY_LEASE_MS,
    );
    if (claim.kind === 'result') return asBulkReplay(request, claim.result);
    const { leaseToken } = claim;

    const stagedRows = buildStagedRows(request);
    await createBulkWorkTable(client, stagedRows);
    await acquireBulkProductLocks(client, tenant.id);
    const conflicts = await collectStagedConflicts(client, tenant.id);
    if (conflicts.size > 0) {
      await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken);
      return {
        status: 409,
        body: rejectedBulkBody(request, conflicts, '상품 충돌을 확인해 주세요. 한 행도 적용되지 않았습니다.'),
      };
    }

    const createCount = stagedRows.filter((row) => row.action === 'create').length;
    const updateCount = stagedRows.length - createCount;
    const currentProducts = request.rows.length <= BULK_DETAILED_RESPONSE_ROW_LIMIT
      ? await currentProductsForDetailedResponse(client, tenant.id, stagedRows) : [];
    const rows = request.rows.length <= BULK_DETAILED_RESPONSE_ROW_LIMIT
      ? detailedSuccessRows(stagedRows, currentProducts, now) : [];
    const body: BulkProductMutationResult = {
      ok: true,
      message: `상품 ${stagedRows.length}건을 일괄 반영했습니다. 유사 검색 벡터는 백그라운드에서 갱신됩니다.`,
      summary: { total: stagedRows.length, created: createCount, updated: updateCount, failed: 0, notApplied: 0 },
      rowDetails: {
        included: rows.length, total: stagedRows.length,
        omitted: stagedRows.length - rows.length, truncated: rows.length < stagedRows.length,
      },
      appliedAt: now,
      createdProductIds: stagedRows.flatMap((row) => row.action === 'create' ? [row.productId] : []),
      ...(createCount > 0 ? { createdPriceMonth: currentPriceMonth(new Date(now)) } : {}),
      vectorization: {
        mode: 'ASYNC',
        status: 'QUEUED',
        queued: stagedRows.length,
        statusUrl: `/api/erp/products/vectorization?tenant=${request.tenant}`,
      },
      rows,
    };

    await applyBulkRows(client, tenant.id, now, createCount, updateCount);
    const queuedCount = await queueProductSearchVectors(
      client,
      tenant.id,
      stagedRows.map((row) => ({
        productId: row.productId,
        targetVersion: row.action === 'create' ? 1 : (row.expectedVersion ?? 0) + 1,
      })),
    );
    body.vectorization!.queued = queuedCount;
    await insertBulkAudits(client, tenant.id, actor, request, now);
    await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
    return { status: 200, body };
  });
}
