import type { PoolClient } from 'pg';
import { bidAdministrativeAreaNodes, bidAreaDataVersion } from '@/app/lib/bid-regions';
import { createFallbackData, tenantOptions } from '@/app/lib/fallback-data';
import { currentPriceMonth } from '@/app/lib/price-month';
import { getPool } from './postgres';
import { runPostgresMigrations } from './postgres-migrations';
import { enqueueStaleProductEmbeddingJobs } from './product-embedding-queue';

let initialized = false;

async function seedAdministrativeAreas(client: PoolClient) {
  const now = new Date().toISOString();
  const levels = ['SIDO', 'CITY_COUNTY', 'ADMIN_DISTRICT'] as const;

  // The self-referencing hierarchy must be written in parent-first batches:
  // provinces, then cities/counties, then non-autonomous administrative districts.
  for (const level of levels) {
    const nodes = bidAdministrativeAreaNodes.filter((node) => node.level === level);
    if (nodes.length === 0) continue;
    await client.query(
      `INSERT INTO administrative_areas (
        code,parent_code,province_code,name,local_name,full_name,level,selectable,
        active,data_version,created_at,updated_at
      )
      SELECT
        node.code,node.parent_code,node.province_code,node.name,node.local_name,node.full_name,
        node.level,node.selectable,TRUE,$2,$3,$3
      FROM jsonb_to_recordset($1::jsonb) AS node(
        code TEXT,
        parent_code TEXT,
        province_code TEXT,
        name TEXT,
        local_name TEXT,
        full_name TEXT,
        level TEXT,
        selectable BOOLEAN
      )
      ON CONFLICT (code) DO UPDATE SET
        parent_code = EXCLUDED.parent_code,
        province_code = EXCLUDED.province_code,
        name = EXCLUDED.name,
        local_name = EXCLUDED.local_name,
        full_name = EXCLUDED.full_name,
        level = EXCLUDED.level,
        selectable = EXCLUDED.selectable,
        active = TRUE,
        data_version = EXCLUDED.data_version,
        updated_at = EXCLUDED.updated_at`,
      [
        JSON.stringify(nodes.map((node) => ({
          code: node.code,
          parent_code: node.parentCode,
          province_code: node.provinceCode,
          name: node.name,
          local_name: node.localName,
          full_name: node.fullName,
          level: node.level,
          selectable: node.selectable,
        }))),
        bidAreaDataVersion,
        now,
      ],
    );
  }

  const activeCodes = bidAdministrativeAreaNodes.map((node) => node.code);
  await client.query(
    `UPDATE administrative_areas
     SET active = FALSE, updated_at = $2
     WHERE active = TRUE
       AND NOT (code = ANY($1::text[]))`,
    [activeCodes, now],
  );
}

async function seedFallbackData(client: PoolClient) {
  const now = new Date().toISOString();
  for (const tenant of tenantOptions) {
    await client.query(
      `INSERT INTO tenants (id, code, name, organization_type, status, brand_color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $6)
       ON CONFLICT (code) DO UPDATE SET
         updated_at = EXCLUDED.updated_at`,
      [tenant.id, tenant.code, tenant.name, tenant.organizationType, tenant.brandColor, now],
    );
    const data = createFallbackData(tenant.code);
    for (const [index, site] of data.sites.entries()) {
      await client.query(
        `INSERT INTO sites
          (id, tenant_id, code, name, type, timezone, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'Asia/Seoul',TRUE,$6,$6) ON CONFLICT DO NOTHING`,
        [site.id, tenant.id, `SITE-${index + 1}`, site.name, site.type, now],
      );
    }
    for (const product of data.products) {
      const unitPrice = product.unit === 'KG' ? product.purchasePriceKg
        : product.unit === 'EA' ? product.purchasePriceEach : product.purchasePriceSpec;
      await client.query(
        `INSERT INTO products (
          id,tenant_id,sku,name,category,specification,unit,unit_price,
          school_price_kg,school_price_spec,school_price_each,
          vendor_price_kg,vendor_price_spec,vendor_price_each,
          purchase_price_kg,purchase_price_spec,purchase_price_each,
          supplier_name,storage_type,allergens,status,version,created_at,updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
        ) ON CONFLICT DO NOTHING`,
        [product.id, tenant.id, product.sku, product.name, product.category,
          product.specification, product.unit, unitPrice,
          product.schoolPriceKg, product.schoolPriceSpec, product.schoolPriceEach,
          product.vendorPriceKg, product.vendorPriceSpec, product.vendorPriceEach,
          product.purchasePriceKg, product.purchasePriceSpec, product.purchasePriceEach,
          product.supplierName, product.storageType, product.allergens, product.status,
          product.version, now, product.updatedAt],
      );
    }

    const siteByName = new Map(data.sites.map((site) => [site.name, site.id]));
    const siteIdFor = (name: string) => {
      const siteId = siteByName.get(name);
      if (!siteId) throw new Error(`Seed data references an unknown site: ${tenant.code}/${name}`);
      return siteId;
    };
    for (const item of data.mealPlans) {
      await client.query(
        `INSERT INTO meal_plans
          (id,tenant_id,site_id,service_date,meal_type,menu_name,planned_servings,
           actual_servings,allergens,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.serviceDate, item.mealType,
          item.menuName, item.plannedServings, item.actualServings, item.allergens, item.status, now],
      );
    }
    for (const item of data.purchaseOrders) {
      await client.query(
        `INSERT INTO purchase_orders
          (id,tenant_id,site_id,order_no,supplier_name,delivery_date,total_amount,item_count,
           status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.orderNo, item.supplierName,
          item.deliveryDate, item.totalAmount, item.itemCount, item.status, now],
      );
    }
    for (const item of data.inventoryLots) {
      await client.query(
        `INSERT INTO inventory_lots
          (id,tenant_id,site_id,ingredient_name,lot_no,quantity,unit,expires_at,location,
           status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.ingredientName, item.lotNo,
          item.quantity, item.unit, item.expiresAt, item.location, item.status, now],
      );
    }
    for (const item of data.productionOrders) {
      await client.query(
        `INSERT INTO production_orders
          (id,tenant_id,site_id,service_date,menu_name,planned_quantity,actual_quantity,
           core_temperature,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.serviceDate, item.menuName,
          item.plannedQuantity, item.actualQuantity, item.coreTemperature, item.status, now],
      );
    }
    for (const item of data.deliveries) {
      await client.query(
        `INSERT INTO deliveries
          (id,tenant_id,site_id,delivery_no,scheduled_at,driver_name,vehicle_no,servings,
           temperature,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.deliveryNo, item.scheduledAt,
          item.driverName, item.vehicleNo, item.servings, item.temperature, item.status, now],
      );
    }
    for (const item of data.settlements) {
      await client.query(
        `INSERT INTO settlements
          (id,tenant_id,site_id,settlement_month,actual_servings,sales_amount,ingredient_cost,
           status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING`,
        [item.id, tenant.id, siteIdFor(item.siteName), item.settlementMonth,
          item.actualServings, item.salesAmount, item.ingredientCost, item.status, now],
      );
    }
  }

}

async function backfillCurrentMonthlyPrices(client: PoolClient) {
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO product_monthly_prices (
      tenant_id,product_id,price_month,
      school_price_kg,school_price_spec,school_price_each,
      vendor_price_kg,vendor_price_spec,vendor_price_each,
      purchase_price_kg,purchase_price_spec,purchase_price_each,
      price_version,created_at,updated_at
    ) SELECT tenant_id,id,$1,
      school_price_kg,school_price_spec,school_price_each,
      vendor_price_kg,vendor_price_spec,vendor_price_each,
      purchase_price_kg,purchase_price_spec,purchase_price_each,1,$2,$2
    FROM products ON CONFLICT (tenant_id, product_id, price_month) DO NOTHING`,
    [currentPriceMonth(), now],
  );
}

async function cleanupExpiredAuthData(client: PoolClient) {
  await client.query('DELETE FROM auth_sessions WHERE expires_at <= clock_timestamp()');
  await client.query(
    `DELETE FROM email_verification_challenges
     WHERE expires_at < clock_timestamp() - interval '1 day'
        OR consumed_at < clock_timestamp() - interval '1 day'`,
  );
  await client.query(
    `DELETE FROM auth_rate_limits
     WHERE window_started_at < clock_timestamp() - interval '1 day'`,
  );
}

async function initialize() {
  const bootstrapPool = getPool();
  let client: PoolClient | undefined;
  let transactionOpen = false;
  try {
    client = await bootstrapPool.connect();
    await runPostgresMigrations(client);
    await client.query('BEGIN');
    transactionOpen = true;
    await cleanupExpiredAuthData(client);
    await seedAdministrativeAreas(client);
    await seedFallbackData(client);
    await backfillCurrentMonthlyPrices(client);
    // Persist the work in the same transaction as seed data. GPU inference is
    // drained by the embedding worker after this transaction commits.
    await enqueueStaleProductEmbeddingJobs(client);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (client && transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) {
        console.error('PostgreSQL bootstrap rollback failed', rollbackError);
      }
    }
    throw error;
  } finally {
    client?.release();
    await bootstrapPool.end();
  }
}

export async function ensureDatabase() {
  if (initialized) return;
  // Cloudflare request-owned PostgreSQL sockets must never be shared through
  // an in-flight module-global Promise. Concurrent cold requests may each run
  // this idempotent bootstrap; the migration advisory lock and ON CONFLICT
  // writes serialize the small overlap safely.
  await initialize();
  initialized = true;
}
