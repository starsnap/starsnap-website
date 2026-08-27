import type {
  BulkProductPriceMutationResult,
  BulkProductPriceRequest,
  BulkProductPriceRowResult,
  BulkProductRowError,
  ProductPriceMutation,
  ProductPriceMutationResult,
  ProductPriceSnapshot,
  ProductPriceSnapshotResult,
  PriceMonth,
  TenantCode,
} from '@/app/lib/erp-types';
import { ensureDatabase } from './bootstrap';
import { claimIdempotency, commitIdempotency, releaseIdempotency } from './idempotency';
import { queryAll, queryOne, type SqlExecutor, withTransaction } from './postgres';

const IDEMPOTENCY_LEASE_MS = 60_000;
const BULK_IDEMPOTENCY_LEASE_MS = 10 * 60_000;
const BULK_DETAILED_RESPONSE_ROW_LIMIT = 500;
const BULK_ERROR_DETAIL_LIMIT = 200;

type TenantRow = { id: string };
type ProductPriceSnapshotRow = {
  productId: string;
  schoolPriceKg: number;
  schoolPriceSpec: number;
  schoolPriceEach: number;
  vendorPriceKg: number;
  vendorPriceSpec: number;
  vendorPriceEach: number;
  purchasePriceKg: number;
  purchasePriceSpec: number;
  purchasePriceEach: number;
  priceMonth: PriceMonth;
  priceSourceMonth: PriceMonth | null;
  priceSourceVersion: number;
  priceInherited: boolean;
  priceVersion: number;
  updatedAt: string | Date;
};
type CurrentPriceState = {
  productVersion: number;
  currentVersion: number | null;
  sourceMonth: PriceMonth | null;
  sourceVersion: number;
};
type StagedConflict = {
  rowNumber: number;
  code: 'PRODUCT_NOT_FOUND' | 'VERSION_CONFLICT';
  currentVersion: number | null;
};

class ProductPriceWriteConflict extends Error {}
class BulkProductPriceWriteConflict extends Error {}

function isoTimestamp(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value;
}

function snapshotFromRow(row: ProductPriceSnapshotRow): ProductPriceSnapshot {
  const common = {
    productId: row.productId,
    schoolPriceKg: row.schoolPriceKg,
    schoolPriceSpec: row.schoolPriceSpec,
    schoolPriceEach: row.schoolPriceEach,
    vendorPriceKg: row.vendorPriceKg,
    vendorPriceSpec: row.vendorPriceSpec,
    vendorPriceEach: row.vendorPriceEach,
    purchasePriceKg: row.purchasePriceKg,
    purchasePriceSpec: row.purchasePriceSpec,
    purchasePriceEach: row.purchasePriceEach,
    priceMonth: row.priceMonth,
    priceSourceVersion: row.priceSourceVersion,
    updatedAt: isoTimestamp(row.updatedAt),
  };
  if (row.priceInherited) {
    return { ...common, priceSourceMonth: row.priceSourceMonth, priceInherited: true, priceVersion: 0 };
  }
  if (!row.priceSourceMonth) throw new Error('Exact monthly price row is missing its source month.');
  return {
    ...common,
    priceSourceMonth: row.priceSourceMonth,
    priceInherited: false,
    priceVersion: row.priceVersion,
  };
}

async function tenantIdFor(code: TenantCode, executor?: SqlExecutor) {
  return queryOne<TenantRow>(
    `SELECT id FROM tenants WHERE code = $1 AND status = 'ACTIVE'`,
    [code],
    executor,
  );
}

async function requestHash(operation: string, request: unknown) {
  let canonical = JSON.stringify({ operation, request });
  const encoded = new TextEncoder().encode(canonical);
  canonical = '';
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBulkProductPriceFingerprint(request: BulkProductPriceRequest) {
  return requestHash('product-monthly-price-bulk-v2', request);
}

function exactSnapshot(mutation: ProductPriceMutation, version: number, updatedAt: string): ProductPriceSnapshot {
  return {
    productId: mutation.productId,
    ...mutation.prices,
    priceMonth: mutation.priceMonth,
    priceSourceMonth: mutation.priceMonth,
    priceSourceVersion: version,
    priceInherited: false,
    priceVersion: version,
    updatedAt,
  };
}

export async function fetchProductPriceSnapshots(
  code: TenantCode,
  priceMonth: PriceMonth,
): Promise<ProductPriceSnapshotResult | null> {
  await ensureDatabase();
  const tenant = await tenantIdFor(code);
  if (!tenant) return null;
  const rows = await queryAll<ProductPriceSnapshotRow>(
    `SELECT product.id AS "productId",
       COALESCE(source.school_price_kg, product.school_price_kg) AS "schoolPriceKg",
       COALESCE(source.school_price_spec, product.school_price_spec) AS "schoolPriceSpec",
       COALESCE(source.school_price_each, product.school_price_each) AS "schoolPriceEach",
       COALESCE(source.vendor_price_kg, product.vendor_price_kg) AS "vendorPriceKg",
       COALESCE(source.vendor_price_spec, product.vendor_price_spec) AS "vendorPriceSpec",
       COALESCE(source.vendor_price_each, product.vendor_price_each) AS "vendorPriceEach",
       COALESCE(source.purchase_price_kg, product.purchase_price_kg) AS "purchasePriceKg",
       COALESCE(source.purchase_price_spec, product.purchase_price_spec) AS "purchasePriceSpec",
       COALESCE(source.purchase_price_each, product.purchase_price_each) AS "purchasePriceEach",
       $1::text AS "priceMonth",
       source.price_month AS "priceSourceMonth",
       COALESCE(source.price_version, product.version) AS "priceSourceVersion",
       (source.price_month IS DISTINCT FROM $1::text) AS "priceInherited",
       CASE WHEN source.price_month = $1::text THEN source.price_version ELSE 0 END AS "priceVersion",
       COALESCE(source.updated_at, product.updated_at) AS "updatedAt"
     FROM products AS product
     LEFT JOIN LATERAL (
       SELECT price.* FROM product_monthly_prices AS price
       WHERE price.tenant_id = product.tenant_id AND price.product_id = product.id
         AND price.price_month <= $1::text
       ORDER BY price.price_month DESC LIMIT 1
     ) AS source ON TRUE
     WHERE product.tenant_id = $2
     ORDER BY product.id`,
    [priceMonth, tenant.id],
  );
  return { tenant: code, priceMonth, products: rows.map(snapshotFromRow) };
}

async function lockProduct(executor: SqlExecutor, tenantId: string) {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`mealops:products:${tenantId}`],
  );
}

async function currentPriceState(
  executor: SqlExecutor,
  tenantId: string,
  productId: string,
  priceMonth: PriceMonth,
) {
  return queryOne<CurrentPriceState>(
    `SELECT product.version AS "productVersion",
       exact.price_version AS "currentVersion",
       source.price_month AS "sourceMonth",
       COALESCE(source.price_version, product.version) AS "sourceVersion"
     FROM products AS product
     LEFT JOIN product_monthly_prices AS exact
       ON exact.tenant_id = product.tenant_id AND exact.product_id = product.id
      AND exact.price_month = $3
     LEFT JOIN LATERAL (
       SELECT price_month, price_version FROM product_monthly_prices AS candidate
       WHERE candidate.tenant_id = product.tenant_id AND candidate.product_id = product.id
         AND candidate.price_month <= $3
       ORDER BY candidate.price_month DESC LIMIT 1
     ) AS source ON TRUE
     WHERE product.tenant_id = $1 AND product.id = $2
     FOR UPDATE OF product`,
    [tenantId, productId, priceMonth],
    executor,
  );
}

function hasExpectedSource(state: CurrentPriceState, mutation: ProductPriceMutation) {
  return (state.currentVersion ?? 0) === mutation.expectedVersion
    && state.sourceMonth === mutation.expectedSourceMonth
    && state.sourceVersion === mutation.expectedSourceVersion;
}

export async function applyProductPriceMutation(
  mutation: ProductPriceMutation,
  idempotencyKey: string,
  actor: string,
) {
  await ensureDatabase();
  const fingerprint = await requestHash('product-monthly-price-upsert-v2', mutation);
  const now = new Date().toISOString();
  try {
    return await withTransaction(async (client) => {
      const tenant = await tenantIdFor(mutation.tenant, client);
      if (!tenant) return { status: 404, body: { ok: false, message: '회사를 찾을 수 없습니다.' } };
      const claim = await claimIdempotency(
        client, tenant.id, idempotencyKey, fingerprint, now, IDEMPOTENCY_LEASE_MS,
      );
      if (claim.kind === 'result') return claim.result;

      await lockProduct(client, tenant.id);
      const state = await currentPriceState(client, tenant.id, mutation.productId, mutation.priceMonth);
      if (!state) {
        await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, claim.leaseToken);
        return { status: 404, body: { ok: false, message: '현재 회사에서 해당 상품을 찾을 수 없습니다.' } };
      }
      if (!hasExpectedSource(state, mutation)) {
        await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, claim.leaseToken);
        return {
          status: 409,
          body: { ok: false, message: '다른 사용자가 대상월 또는 원본 단가를 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.' },
        };
      }

      const prices = [
        mutation.prices.schoolPriceKg,
        mutation.prices.schoolPriceSpec,
        mutation.prices.schoolPriceEach,
        mutation.prices.vendorPriceKg,
        mutation.prices.vendorPriceSpec,
        mutation.prices.vendorPriceEach,
        mutation.prices.purchasePriceKg,
        mutation.prices.purchasePriceSpec,
        mutation.prices.purchasePriceEach,
      ];
      let affected: number;
      if (mutation.expectedVersion === 0) {
        const inserted = await client.query(
          `INSERT INTO product_monthly_prices
            (tenant_id, product_id, price_month,
             school_price_kg, school_price_spec, school_price_each,
             vendor_price_kg, vendor_price_spec, vendor_price_each,
             purchase_price_kg, purchase_price_spec, purchase_price_each,
             price_version, created_at, updated_at)
           SELECT base.tenant_id, base.id, $3,
             $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13
           FROM products AS base
           LEFT JOIN LATERAL (
             SELECT candidate.price_month, candidate.price_version
             FROM product_monthly_prices AS candidate
             WHERE candidate.tenant_id = base.tenant_id AND candidate.product_id = base.id
               AND candidate.price_month <= $3
             ORDER BY candidate.price_month DESC LIMIT 1
           ) AS source ON TRUE
           WHERE base.tenant_id = $1 AND base.id = $2
             AND NOT EXISTS (
               SELECT 1 FROM product_monthly_prices AS exact
               WHERE exact.tenant_id = base.tenant_id AND exact.product_id = base.id
                 AND exact.price_month = $3
             )
             AND source.price_month IS NOT DISTINCT FROM $14::text
             AND COALESCE(source.price_version, base.version) = $15
           ON CONFLICT (tenant_id, product_id, price_month) DO NOTHING`,
          [tenant.id, mutation.productId, mutation.priceMonth, ...prices, now,
            mutation.expectedSourceMonth, mutation.expectedSourceVersion],
        );
        affected = Number(inserted.rowCount);
      } else {
        const updated = await client.query(
          `UPDATE product_monthly_prices AS price SET
             school_price_kg = $5, school_price_spec = $6, school_price_each = $7,
             vendor_price_kg = $8, vendor_price_spec = $9, vendor_price_each = $10,
             purchase_price_kg = $11, purchase_price_spec = $12, purchase_price_each = $13,
             price_version = price.price_version + 1, updated_at = $14
           WHERE price.tenant_id = $1 AND price.product_id = $2
             AND price.price_month = $3 AND price.price_version = $4
             AND $15::text IS NOT DISTINCT FROM price.price_month
             AND $16::integer = price.price_version`,
          [tenant.id, mutation.productId, mutation.priceMonth, mutation.expectedVersion,
            ...prices, now, mutation.expectedSourceMonth, mutation.expectedSourceVersion],
        );
        affected = Number(updated.rowCount);
      }
      if (affected !== 1) throw new ProductPriceWriteConflict();

      const nextVersion = mutation.expectedVersion + 1;
      const body: ProductPriceMutationResult = {
        ok: true,
        message: `${mutation.priceMonth} 월별 단가를 저장했습니다.`,
        productPrice: exactSnapshot(mutation, nextVersion, now),
      };
      await client.query(
        `INSERT INTO audit_logs
          (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
         VALUES ($1, $2, $3, 'upsert', 'product_monthly_prices', $4, $5, $6)`,
        [crypto.randomUUID(), tenant.id, actor, `${mutation.productId}:${mutation.priceMonth}`,
          `${mutation.priceMonth} · v${mutation.expectedVersion} → v${nextVersion}`, now],
      );
      await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, claim.leaseToken, body);
      return { status: 200, body };
    });
  } catch (error) {
    if (error instanceof ProductPriceWriteConflict) {
      return {
        status: 409,
        body: { ok: false, message: '다른 사용자가 월별 단가를 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.' },
      };
    }
    throw error;
  }
}

function rejectedBulkBody(
  request: BulkProductPriceRequest,
  errors: Map<number, BulkProductRowError[]>,
  message: string,
): BulkProductPriceMutationResult {
  const failedRows = request.rows.filter((row) => errors.has(row.rowNumber));
  const rows = failedRows.slice(0, BULK_ERROR_DETAIL_LIMIT).map<BulkProductPriceRowResult>((row) => ({
    rowNumber: row.rowNumber,
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
      total: request.rows.length,
      created: 0,
      updated: 0,
      failed: failedRows.length,
      notApplied: request.rows.length - failedRows.length,
    },
    rowDetails: {
      included: rows.length,
      total: request.rows.length,
      omitted: request.rows.length - rows.length,
      truncated: rows.length < request.rows.length,
    },
    rows,
  };
}

function asBulkReplay(request: BulkProductPriceRequest, result: { status: number; body: unknown }) {
  if (
    typeof result.body === 'object'
    && result.body !== null
    && 'summary' in result.body
    && 'rows' in result.body
  ) {
    return result as { status: number; body: BulkProductPriceMutationResult };
  }
  const message = typeof result.body === 'object'
    && result.body !== null
    && 'message' in result.body
    && typeof result.body.message === 'string'
    ? result.body.message
    : '월별 단가 일괄 요청 상태를 확인할 수 없습니다.';
  return { status: result.status, body: rejectedBulkBody(request, new Map(), message) };
}

async function stageBulkRequest(executor: SqlExecutor, request: BulkProductPriceRequest) {
  await executor.query(
    `CREATE TEMP TABLE product_price_bulk_input (
       row_number integer NOT NULL,
       product_id text NOT NULL,
       expected_version integer NOT NULL,
       expected_source_month text,
       expected_source_version integer NOT NULL,
       school_price_kg integer NOT NULL,
       school_price_spec integer NOT NULL,
       school_price_each integer NOT NULL,
       vendor_price_kg integer NOT NULL,
       vendor_price_spec integer NOT NULL,
       vendor_price_each integer NOT NULL,
       purchase_price_kg integer NOT NULL,
       purchase_price_spec integer NOT NULL,
       purchase_price_each integer NOT NULL,
       PRIMARY KEY (row_number)
     ) ON COMMIT DROP`,
  );
  const inserted = await executor.query(
    `INSERT INTO product_price_bulk_input
      (row_number, product_id, expected_version, expected_source_month, expected_source_version,
       school_price_kg, school_price_spec, school_price_each,
       vendor_price_kg, vendor_price_spec, vendor_price_each,
       purchase_price_kg, purchase_price_spec, purchase_price_each)
     SELECT payload."rowNumber", payload."productId", payload."expectedVersion",
       payload."expectedSourceMonth", payload."expectedSourceVersion",
       (payload.prices ->> 'schoolPriceKg')::integer,
       (payload.prices ->> 'schoolPriceSpec')::integer,
       (payload.prices ->> 'schoolPriceEach')::integer,
       (payload.prices ->> 'vendorPriceKg')::integer,
       (payload.prices ->> 'vendorPriceSpec')::integer,
       (payload.prices ->> 'vendorPriceEach')::integer,
       (payload.prices ->> 'purchasePriceKg')::integer,
       (payload.prices ->> 'purchasePriceSpec')::integer,
       (payload.prices ->> 'purchasePriceEach')::integer
     FROM jsonb_to_recordset($1::jsonb) AS payload(
       "rowNumber" integer,
       "productId" text,
       "expectedVersion" integer,
       "expectedSourceMonth" text,
       "expectedSourceVersion" integer,
       prices jsonb
     )`,
    [JSON.stringify(request.rows)],
  );
  if (Number(inserted.rowCount) !== request.rows.length) {
    throw new Error('월별 단가 일괄 처리 준비 데이터를 완전하게 적재하지 못했습니다.');
  }
}

async function lockBulkProducts(executor: SqlExecutor, tenantId: string) {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`mealops:products:${tenantId}`],
  );
  await executor.query(
    `SELECT product.id
     FROM products AS product
     JOIN (SELECT DISTINCT product_id FROM product_price_bulk_input) AS staged
       ON staged.product_id = product.id
     WHERE product.tenant_id = $1
     ORDER BY product.id
     FOR UPDATE OF product`,
    [tenantId],
  );
}

async function collectStagedConflicts(
  executor: SqlExecutor,
  tenantId: string,
  priceMonth: PriceMonth,
) {
  const conflicts = await queryAll<StagedConflict>(
    `WITH resolved AS (
       SELECT staged.row_number AS "rowNumber",
         staged.expected_version AS "expectedVersion",
         staged.expected_source_month AS "expectedSourceMonth",
         staged.expected_source_version AS "expectedSourceVersion",
         product.id AS "productId",
         product.version AS "productVersion",
         exact.price_version AS "currentVersion",
         source.price_month AS "sourceMonth",
         source.price_version AS "sourceVersion"
       FROM product_price_bulk_input AS staged
       LEFT JOIN products AS product
         ON product.tenant_id = $1 AND product.id = staged.product_id
       LEFT JOIN product_monthly_prices AS exact
         ON exact.tenant_id = $1 AND exact.product_id = staged.product_id
        AND exact.price_month = $2
       LEFT JOIN LATERAL (
         SELECT candidate.price_month, candidate.price_version
         FROM product_monthly_prices AS candidate
         WHERE candidate.tenant_id = $1 AND candidate.product_id = staged.product_id
           AND candidate.price_month <= $2
         ORDER BY candidate.price_month DESC LIMIT 1
       ) AS source ON TRUE
     )
     SELECT "rowNumber", 'PRODUCT_NOT_FOUND'::text AS code, NULL::integer AS "currentVersion"
     FROM resolved WHERE "productId" IS NULL
     UNION ALL
     SELECT "rowNumber", 'VERSION_CONFLICT'::text AS code, "currentVersion"
     FROM resolved
     WHERE "productId" IS NOT NULL AND (
       COALESCE("currentVersion", 0) <> "expectedVersion"
       OR "sourceMonth" IS DISTINCT FROM "expectedSourceMonth"
       OR COALESCE("sourceVersion", "productVersion") <> "expectedSourceVersion"
     )
     ORDER BY "rowNumber"`,
    [tenantId, priceMonth],
    executor,
  );
  const errors = new Map<number, BulkProductRowError[]>();
  for (const conflict of conflicts) {
    const error: BulkProductRowError = conflict.code === 'PRODUCT_NOT_FOUND'
      ? { field: 'productId', code: conflict.code, message: '현재 회사에서 해당 상품을 찾을 수 없습니다.' }
      : {
        field: 'expectedVersion',
        code: conflict.code,
        message: `대상월 또는 원본 단가가 변경되었습니다. 현재 대상월 버전은 ${conflict.currentVersion ?? 0}입니다.`,
      };
    errors.set(conflict.rowNumber, [...(errors.get(conflict.rowNumber) ?? []), error]);
  }
  return errors;
}

async function insertBulkPrices(
  executor: SqlExecutor,
  tenantId: string,
  priceMonth: PriceMonth,
  now: string,
) {
  const result = await executor.query(
    `INSERT INTO product_monthly_prices
      (tenant_id, product_id, price_month,
       school_price_kg, school_price_spec, school_price_each,
       vendor_price_kg, vendor_price_spec, vendor_price_each,
       purchase_price_kg, purchase_price_spec, purchase_price_each,
       price_version, created_at, updated_at)
     SELECT $1, staged.product_id, $2,
       staged.school_price_kg, staged.school_price_spec, staged.school_price_each,
       staged.vendor_price_kg, staged.vendor_price_spec, staged.vendor_price_each,
       staged.purchase_price_kg, staged.purchase_price_spec, staged.purchase_price_each,
       1, $3, $3
     FROM product_price_bulk_input AS staged
     JOIN products AS product ON product.tenant_id = $1 AND product.id = staged.product_id
     LEFT JOIN LATERAL (
       SELECT candidate.price_month, candidate.price_version
       FROM product_monthly_prices AS candidate
       WHERE candidate.tenant_id = $1 AND candidate.product_id = staged.product_id
         AND candidate.price_month <= $2
       ORDER BY candidate.price_month DESC LIMIT 1
     ) AS source ON TRUE
     WHERE staged.expected_version = 0
       AND NOT EXISTS (
         SELECT 1 FROM product_monthly_prices AS exact
         WHERE exact.tenant_id = $1 AND exact.product_id = staged.product_id
           AND exact.price_month = $2
       )
       AND source.price_month IS NOT DISTINCT FROM staged.expected_source_month
       AND COALESCE(source.price_version, product.version) = staged.expected_source_version
     ON CONFLICT (tenant_id, product_id, price_month) DO NOTHING`,
    [tenantId, priceMonth, now],
  );
  return Number(result.rowCount);
}

async function updateBulkPrices(
  executor: SqlExecutor,
  tenantId: string,
  priceMonth: PriceMonth,
  now: string,
) {
  const result = await executor.query(
    `UPDATE product_monthly_prices AS price SET
       school_price_kg = staged.school_price_kg,
       school_price_spec = staged.school_price_spec,
       school_price_each = staged.school_price_each,
       vendor_price_kg = staged.vendor_price_kg,
       vendor_price_spec = staged.vendor_price_spec,
       vendor_price_each = staged.vendor_price_each,
       purchase_price_kg = staged.purchase_price_kg,
       purchase_price_spec = staged.purchase_price_spec,
       purchase_price_each = staged.purchase_price_each,
       price_version = price.price_version + 1,
       updated_at = $3
     FROM product_price_bulk_input AS staged
     WHERE staged.expected_version > 0
       AND price.tenant_id = $1 AND price.product_id = staged.product_id
       AND price.price_month = $2 AND price.price_version = staged.expected_version
       AND staged.expected_source_month IS NOT DISTINCT FROM price.price_month
       AND staged.expected_source_version = price.price_version`,
    [tenantId, priceMonth, now],
  );
  return Number(result.rowCount);
}

async function auditBulkPrices(
  executor: SqlExecutor,
  tenantId: string,
  priceMonth: PriceMonth,
  actor: string,
  now: string,
) {
  const result = await executor.query(
    `INSERT INTO audit_logs
      (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
     SELECT md5($1 || ':' || staged.row_number::text || ':' || staged.product_id || ':' || random()::text),
       $2, $3,
       CASE WHEN staged.expected_version = 0 THEN 'create' ELSE 'update' END,
       'product_monthly_prices', staged.product_id || ':' || $4,
       $4 || ' · 엑셀 ' || staged.row_number || '행 · v' || staged.expected_version
         || ' → v' || (staged.expected_version + 1), $1
     FROM product_price_bulk_input AS staged`,
    [now, tenantId, actor, priceMonth],
  );
  return Number(result.rowCount);
}

export async function applyBulkProductPriceMutation(
  request: BulkProductPriceRequest,
  idempotencyKey: string,
  actor: string,
  fingerprint: string,
) {
  await ensureDatabase();
  const now = new Date().toISOString();
  try {
    return await withTransaction(async (client) => {
      const tenant = await tenantIdFor(request.tenant, client);
      if (!tenant) {
        return { status: 404, body: rejectedBulkBody(request, new Map(), '회사를 찾을 수 없습니다.') };
      }
      const claim = await claimIdempotency(
        client,
        tenant.id,
        idempotencyKey,
        fingerprint,
        now,
        BULK_IDEMPOTENCY_LEASE_MS,
      );
      if (claim.kind === 'result') return asBulkReplay(request, claim.result);

      await stageBulkRequest(client, request);
      await lockBulkProducts(client, tenant.id);
      const conflicts = await collectStagedConflicts(client, tenant.id, request.priceMonth);
      if (conflicts.size > 0) {
        await releaseIdempotency(client, tenant.id, idempotencyKey, fingerprint, claim.leaseToken);
        return {
          status: 409,
          body: rejectedBulkBody(request, conflicts, '월별 단가 충돌을 확인해 주세요. 한 행도 적용되지 않았습니다.'),
        };
      }

      const createCount = request.rows.filter((row) => row.expectedVersion === 0).length;
      const updateCount = request.rows.length - createCount;
      const created = createCount === 0 ? 0 : await insertBulkPrices(client, tenant.id, request.priceMonth, now);
      if (created !== createCount) throw new BulkProductPriceWriteConflict();
      const updated = updateCount === 0 ? 0 : await updateBulkPrices(client, tenant.id, request.priceMonth, now);
      if (updated !== updateCount) throw new BulkProductPriceWriteConflict();
      const audited = await auditBulkPrices(client, tenant.id, request.priceMonth, actor, now);
      if (audited !== request.rows.length) {
        throw new Error('월별 단가 일괄 감사 기록을 완전하게 저장하지 못했습니다.');
      }

      const rows = request.rows.length <= BULK_DETAILED_RESPONSE_ROW_LIMIT
        ? request.rows.map<BulkProductPriceRowResult>((row) => ({
          rowNumber: row.rowNumber,
          status: row.expectedVersion === 0 ? 'created' : 'updated',
          productPrice: {
            productId: row.productId,
            ...row.prices,
            priceMonth: request.priceMonth,
            priceSourceMonth: request.priceMonth,
            priceSourceVersion: row.expectedVersion + 1,
            priceInherited: false,
            priceVersion: row.expectedVersion + 1,
            updatedAt: now,
          },
        }))
        : [];
      const body: BulkProductPriceMutationResult = {
        ok: true,
        message: `${request.priceMonth} 월별 단가 ${request.rows.length}건을 일괄 반영했습니다.`,
        summary: {
          total: request.rows.length,
          created: createCount,
          updated: updateCount,
          failed: 0,
          notApplied: 0,
        },
        rowDetails: {
          included: rows.length,
          total: request.rows.length,
          omitted: request.rows.length - rows.length,
          truncated: rows.length < request.rows.length,
        },
        appliedAt: now,
        rows,
      };
      await client.query(
        `INSERT INTO audit_logs
          (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
         VALUES ($1, $2, $3, 'bulk-import', 'product_monthly_prices', $4, $5, $6)`,
        [
          crypto.randomUUID(),
          tenant.id,
          actor,
          `bulk-price:${request.priceMonth}:${request.source.fileSha256.slice(0, 16)}`,
          `${request.source.fileName} · ${request.priceMonth} · ${request.rows.length}건 일괄 반영`,
          now,
        ],
      );
      await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, claim.leaseToken, body);
      return { status: 200, body };
    });
  } catch (error) {
    if (error instanceof BulkProductPriceWriteConflict) {
      return {
        status: 409,
        body: rejectedBulkBody(
          request,
          new Map(),
          '다른 요청이 먼저 월별 단가를 변경했습니다. 한 행도 적용되지 않았습니다.',
        ),
      };
    }
    throw error;
  }
}
