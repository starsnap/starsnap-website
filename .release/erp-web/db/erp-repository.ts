import type { PoolClient } from 'pg';
import type {
  Delivery,
  ErpAction,
  ErpData,
  InventoryLot,
  MealPlan,
  Product,
  ProductionOrder,
  PurchaseOrder,
  Settlement,
  SiteSummary,
  TenantCode,
  TenantSummary,
} from '@/app/lib/erp-types';
import { ensureDatabase } from './bootstrap';
import { claimIdempotency, commitIdempotency, releaseIdempotency } from './idempotency';
import { fetchNetworkDataWithClient } from './network-repository';
import { queryAll, queryOne, withTransaction } from './postgres';

export async function fetchErpData(code: TenantCode): Promise<ErpData | null> {
  await ensureDatabase();
  return withTransaction(
    (client) => fetchErpDataWithClient(code, client),
    'REPEATABLE READ',
  );
}

async function fetchErpDataWithClient(code: TenantCode, client: PoolClient): Promise<ErpData | null> {
  const tenant = await queryOne<TenantSummary>(
    `SELECT id, code, name, brand_color AS "brandColor",
       organization_type AS "organizationType"
     FROM tenants WHERE code = $1 AND status = $2`,
    [code, 'ACTIVE'],
    client,
  );
  if (!tenant) return null;

  const [tenants, sites, products, mealPlans, purchaseOrders, inventoryLots,
    productionOrders, deliveries, settlements, networkData] = await Promise.all([
    queryAll<TenantSummary>(
      `SELECT id, code, name, brand_color AS "brandColor",
         organization_type AS "organizationType"
       FROM tenants WHERE status = $1 AND code = $2 ORDER BY name`,
      ['ACTIVE', code],
      client,
    ),
    queryAll<SiteSummary>(
      'SELECT id, name, type FROM sites WHERE tenant_id = $1 AND active IS TRUE ORDER BY name',
      [tenant.id],
      client,
    ),
    queryAll<Product>(
      `SELECT id, sku, name, category, specification, unit,
        school_price_kg AS "schoolPriceKg", school_price_spec AS "schoolPriceSpec",
        school_price_each AS "schoolPriceEach", vendor_price_kg AS "vendorPriceKg",
        vendor_price_spec AS "vendorPriceSpec", vendor_price_each AS "vendorPriceEach",
        purchase_price_kg AS "purchasePriceKg", purchase_price_spec AS "purchasePriceSpec",
        purchase_price_each AS "purchasePriceEach", supplier_name AS "supplierName",
        storage_type AS "storageType", allergens, status, version, updated_at AS "updatedAt"
       FROM products WHERE tenant_id = $1 ORDER BY status, name, sku`,
      [tenant.id],
      client,
    ),
    queryAll<MealPlan>(
      `SELECT mp.id, s.name AS "siteName", mp.service_date AS "serviceDate",
        mp.meal_type AS "mealType", mp.menu_name AS "menuName",
        mp.planned_servings AS "plannedServings", mp.actual_servings AS "actualServings",
        mp.allergens, mp.status
       FROM meal_plans mp JOIN sites s ON s.id = mp.site_id AND s.tenant_id = mp.tenant_id
       WHERE mp.tenant_id = $1 ORDER BY mp.service_date, mp.meal_type`,
      [tenant.id],
      client,
    ),
    queryAll<PurchaseOrder>(
      `SELECT po.id, po.order_no AS "orderNo", s.name AS "siteName",
        po.supplier_name AS "supplierName", po.delivery_date AS "deliveryDate",
        po.total_amount AS "totalAmount", po.item_count AS "itemCount", po.status
       FROM purchase_orders po JOIN sites s ON s.id = po.site_id AND s.tenant_id = po.tenant_id
       WHERE po.tenant_id = $1 ORDER BY po.delivery_date DESC, po.order_no DESC`,
      [tenant.id],
      client,
    ),
    queryAll<InventoryLot>(
      `SELECT il.id, s.name AS "siteName", il.ingredient_name AS "ingredientName",
        il.lot_no AS "lotNo", il.quantity, il.unit, il.expires_at AS "expiresAt",
        il.location, il.status
       FROM inventory_lots il JOIN sites s ON s.id = il.site_id AND s.tenant_id = il.tenant_id
       WHERE il.tenant_id = $1 ORDER BY il.expires_at`,
      [tenant.id],
      client,
    ),
    queryAll<ProductionOrder>(
      `SELECT p.id, s.name AS "siteName", p.service_date AS "serviceDate",
        p.menu_name AS "menuName", p.planned_quantity AS "plannedQuantity",
        p.actual_quantity AS "actualQuantity", p.core_temperature AS "coreTemperature", p.status
       FROM production_orders p JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 ORDER BY p.service_date, p.menu_name`,
      [tenant.id],
      client,
    ),
    queryAll<Delivery>(
      `SELECT d.id, d.delivery_no AS "deliveryNo", s.name AS "siteName",
        d.scheduled_at AS "scheduledAt", d.driver_name AS "driverName",
        d.vehicle_no AS "vehicleNo", d.servings, d.temperature, d.status
       FROM deliveries d JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1 ORDER BY d.scheduled_at`,
      [tenant.id],
      client,
    ),
    queryAll<Settlement>(
      `SELECT st.id, s.name AS "siteName", st.settlement_month AS "settlementMonth",
        st.actual_servings AS "actualServings", st.sales_amount AS "salesAmount",
        st.ingredient_cost AS "ingredientCost", st.status
       FROM settlements st JOIN sites s ON s.id = st.site_id AND s.tenant_id = st.tenant_id
       WHERE st.tenant_id = $1 ORDER BY st.settlement_month DESC, s.name`,
      [tenant.id],
      client,
    ),
    fetchNetworkDataWithClient(tenant, client),
  ]);

  return {
    tenant, tenants, sites,
    metrics: {
      totalServings: mealPlans.reduce((sum, item) => sum + item.plannedServings, 0),
      pendingOrders: purchaseOrders.filter((item) => item.status === '승인대기').length,
      inventoryAlerts: inventoryLots.filter((item) => item.status !== '정상').length,
      completedDeliveries: deliveries.filter((item) => item.status === '완료').length,
      totalDeliveries: deliveries.length,
    },
    ...networkData,
    products, mealPlans, purchaseOrders, inventoryLots, productionOrders,
    deliveries, settlements,
  };
}

const transitions = {
  'meals:confirm': { table: 'meal_plans', status: '확정', allowedStatuses: ['작성중', '승인대기'], label: '식단 확정' },
  'purchasing:approve': { table: 'purchase_orders', status: '승인', allowedStatuses: ['승인대기'], label: '발주 승인' },
  'inventory:acknowledge': { table: 'inventory_lots', status: '확인완료', allowedStatuses: ['부족', '임박'], label: '재고 주의 확인' },
  'production:complete': { table: 'production_orders', status: '완료', allowedStatuses: ['마감대기', '작업중'], label: '생산 마감' },
  'delivery:complete': { table: 'deliveries', status: '완료', allowedStatuses: ['배송중'], label: '배송 완료' },
} as const;

async function requestHash(action: ErpAction) {
  const canonical = JSON.stringify({
    tenant: action.tenant,
    module: action.module,
    id: action.id,
    action: action.action,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function releaseAndReturn(
  client: PoolClient,
  tenantId: string,
  key: string,
  fingerprint: string,
  leaseToken: string,
  result: { status: number; body: unknown },
) {
  await releaseIdempotency(client, tenantId, key, fingerprint, leaseToken);
  return result;
}

export async function applyErpAction(action: ErpAction, idempotencyKey: string, actor: string) {
  await ensureDatabase();
  const fingerprint = await requestHash(action);

  return withTransaction(async (client) => {
    const tenantResult = await client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE code = $1 AND status = $2',
      [action.tenant, 'ACTIVE'],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) return { status: 404, body: { ok: false, message: '회사를 찾을 수 없습니다.' } };

    const now = new Date().toISOString();
    const claim = await claimIdempotency(client, tenant.id, idempotencyKey, fingerprint, now, 60_000);
    if (claim.kind === 'result') return claim.result;
    const { leaseToken } = claim;

    const transition = transitions[`${action.module}:${action.action}` as keyof typeof transitions];
    if (!transition) {
      return releaseAndReturn(client, tenant.id, idempotencyKey, fingerprint, leaseToken, {
        status: 422, body: { ok: false, message: '허용되지 않은 업무 처리입니다.' },
      });
    }

    const entityResult = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM ${transition.table} WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [action.id, tenant.id],
    );
    const entity = entityResult.rows[0];
    if (!entity) {
      return releaseAndReturn(client, tenant.id, idempotencyKey, fingerprint, leaseToken, {
        status: 404, body: { ok: false, message: '현재 회사에서 해당 업무를 찾을 수 없습니다.' },
      });
    }
    if (entity.status === transition.status) {
      const body = {
        ok: true, id: action.id, status: transition.status, alreadyApplied: true,
        message: `이미 ${transition.label} 처리된 업무입니다.`,
      };
      await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
      return { status: 200, body };
    }

    const allowed = transition.allowedStatuses as readonly string[];
    if (!allowed.includes(entity.status)) {
      return releaseAndReturn(client, tenant.id, idempotencyKey, fingerprint, leaseToken, {
        status: 409,
        body: {
          ok: false, id: action.id, status: entity.status,
          message: `${entity.status} 상태에서는 ${transition.label} 처리를 할 수 없습니다.`,
        },
      });
    }

    const update = await client.query(
      `UPDATE ${transition.table} SET status = $1, updated_at = $2
       WHERE id = $3 AND tenant_id = $4 AND status = ANY($5::text[]) RETURNING id`,
      [transition.status, now, action.id, tenant.id, [...allowed]],
    );

    if (update.rowCount !== 1) {
      return releaseAndReturn(client, tenant.id, idempotencyKey, fingerprint, leaseToken, {
        status: 409,
        body: { ok: false, id: action.id, status: entity.status, message: '다른 요청이 먼저 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.' },
      });
    }

    await client.query(
      `INSERT INTO audit_logs
        (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), tenant.id, actor, action.action, action.module,
        action.id, `${entity.status} → ${transition.status}`, now],
    );
    const body = { ok: true, id: action.id, status: transition.status, message: `${transition.label} 처리가 완료되었습니다.` };
    await commitIdempotency(client, tenant.id, idempotencyKey, fingerprint, leaseToken, body);
    return { status: 200, body };
  });
}
