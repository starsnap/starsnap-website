import type { PoolClient } from 'pg';

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

export const postgresMigrations: readonly PostgresMigration[] = [
  { version: 1, name: 'enable-pgvector', sql: 'CREATE EXTENSION IF NOT EXISTS vector' },
  {
    version: 2,
    name: 'create-erp-schema',
    sql: `
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', brand_color TEXT NOT NULL DEFAULT '#17324D',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), code TEXT NOT NULL,
        name TEXT NOT NULL, type TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
        active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), sku TEXT NOT NULL,
        name TEXT NOT NULL, category TEXT NOT NULL, specification TEXT NOT NULL, unit TEXT NOT NULL,
        unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 0 AND 100000000),
        school_price_kg INTEGER NOT NULL DEFAULT 0 CHECK (school_price_kg BETWEEN 0 AND 100000000),
        school_price_spec INTEGER NOT NULL DEFAULT 0 CHECK (school_price_spec BETWEEN 0 AND 100000000),
        school_price_each INTEGER NOT NULL DEFAULT 0 CHECK (school_price_each BETWEEN 0 AND 100000000),
        vendor_price_kg INTEGER NOT NULL DEFAULT 0 CHECK (vendor_price_kg BETWEEN 0 AND 100000000),
        vendor_price_spec INTEGER NOT NULL DEFAULT 0 CHECK (vendor_price_spec BETWEEN 0 AND 100000000),
        vendor_price_each INTEGER NOT NULL DEFAULT 0 CHECK (vendor_price_each BETWEEN 0 AND 100000000),
        purchase_price_kg INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_kg BETWEEN 0 AND 100000000),
        purchase_price_spec INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_spec BETWEEN 0 AND 100000000),
        purchase_price_each INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_each BETWEEN 0 AND 100000000),
        supplier_name TEXT NOT NULL, storage_type TEXT NOT NULL, allergens TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ACTIVE', version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, sku), UNIQUE (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS product_price_v2_backup (
        product_id TEXT PRIMARY KEY,
        school_price_kg INTEGER NOT NULL, school_price_spec INTEGER NOT NULL, school_price_each INTEGER NOT NULL,
        vendor_price_kg INTEGER NOT NULL, vendor_price_spec INTEGER NOT NULL, vendor_price_each INTEGER NOT NULL,
        purchase_price_kg INTEGER NOT NULL, purchase_price_spec INTEGER NOT NULL, purchase_price_each INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_monthly_prices (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), product_id TEXT NOT NULL,
        price_month TEXT NOT NULL CHECK (price_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        school_price_kg INTEGER NOT NULL CHECK (school_price_kg BETWEEN 0 AND 100000000),
        school_price_spec INTEGER NOT NULL CHECK (school_price_spec BETWEEN 0 AND 100000000),
        school_price_each INTEGER NOT NULL CHECK (school_price_each BETWEEN 0 AND 100000000),
        vendor_price_kg INTEGER NOT NULL CHECK (vendor_price_kg BETWEEN 0 AND 100000000),
        vendor_price_spec INTEGER NOT NULL CHECK (vendor_price_spec BETWEEN 0 AND 100000000),
        vendor_price_each INTEGER NOT NULL CHECK (vendor_price_each BETWEEN 0 AND 100000000),
        purchase_price_kg INTEGER NOT NULL CHECK (purchase_price_kg BETWEEN 0 AND 100000000),
        purchase_price_spec INTEGER NOT NULL CHECK (purchase_price_spec BETWEEN 0 AND 100000000),
        purchase_price_each INTEGER NOT NULL CHECK (purchase_price_each BETWEEN 0 AND 100000000),
        price_version INTEGER NOT NULL DEFAULT 1 CHECK (price_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, product_id, price_month),
        FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS meal_plans (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, service_date TEXT NOT NULL,
        meal_type TEXT NOT NULL, menu_name TEXT NOT NULL, planned_servings INTEGER NOT NULL,
        actual_servings INTEGER, allergens TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, order_no TEXT NOT NULL,
        supplier_name TEXT NOT NULL, delivery_date TEXT NOT NULL, total_amount INTEGER NOT NULL,
        item_count INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, order_no), FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS inventory_lots (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, ingredient_name TEXT NOT NULL,
        lot_no TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity >= 0), unit TEXT NOT NULL,
        expires_at TEXT NOT NULL, location TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, lot_no), FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS production_orders (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, service_date TEXT NOT NULL,
        menu_name TEXT NOT NULL, planned_quantity INTEGER NOT NULL, actual_quantity INTEGER,
        core_temperature INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, delivery_no TEXT NOT NULL,
        scheduled_at TEXT NOT NULL, driver_name TEXT NOT NULL, vehicle_no TEXT NOT NULL,
        servings INTEGER NOT NULL, temperature INTEGER, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, delivery_no), FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS settlements (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, settlement_month TEXT NOT NULL,
        actual_servings INTEGER NOT NULL, sales_amount INTEGER NOT NULL, ingredient_cost INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, site_id, settlement_month),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS haccp_checks (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, check_date TEXT NOT NULL,
        category TEXT NOT NULL, item_name TEXT NOT NULL, measured_value TEXT NOT NULL,
        assignee_name TEXT NOT NULL, corrective_action TEXT, verification_value TEXT,
        verified_by TEXT, verified_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, key)
      );
      CREATE TABLE IF NOT EXISTS product_bulk_staging (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), idempotency_key TEXT NOT NULL,
        lease_token TEXT NOT NULL, row_number INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'update')), product_id TEXT NOT NULL,
        expected_version INTEGER, sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
        specification TEXT NOT NULL, unit TEXT NOT NULL,
        school_price_kg INTEGER NOT NULL, school_price_spec INTEGER NOT NULL, school_price_each INTEGER NOT NULL,
        vendor_price_kg INTEGER NOT NULL, vendor_price_spec INTEGER NOT NULL, vendor_price_each INTEGER NOT NULL,
        purchase_price_kg INTEGER NOT NULL, purchase_price_spec INTEGER NOT NULL, purchase_price_each INTEGER NOT NULL,
        supplier_name TEXT NOT NULL, storage_type TEXT NOT NULL, allergens TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key, lease_token, row_number)
      );
      CREATE TABLE IF NOT EXISTS product_price_bulk_staging (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), idempotency_key TEXT NOT NULL,
        lease_token TEXT NOT NULL, row_number INTEGER NOT NULL, product_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL CHECK (expected_version >= 0), expected_source_month TEXT,
        expected_source_version INTEGER NOT NULL CHECK (expected_source_version >= 1),
        school_price_kg INTEGER NOT NULL, school_price_spec INTEGER NOT NULL, school_price_each INTEGER NOT NULL,
        vendor_price_kg INTEGER NOT NULL, vendor_price_spec INTEGER NOT NULL, vendor_price_each INTEGER NOT NULL,
        purchase_price_kg INTEGER NOT NULL, purchase_price_spec INTEGER NOT NULL, purchase_price_each INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, idempotency_key, lease_token, row_number)
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), actor TEXT NOT NULL,
        action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        detail TEXT NOT NULL, created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_products_tenant_name ON products(tenant_id, name);
      CREATE INDEX IF NOT EXISTS idx_products_tenant_status ON products(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_product_monthly_prices_tenant_month ON product_monthly_prices(tenant_id, price_month, product_id);
      CREATE INDEX IF NOT EXISTS idx_meal_plans_tenant_date ON meal_plans(tenant_id, service_date);
      CREATE INDEX IF NOT EXISTS idx_meal_plans_tenant_status ON meal_plans(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_status ON purchase_orders(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_status ON inventory_lots(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_expiry ON inventory_lots(tenant_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_production_orders_tenant_date ON production_orders(tenant_id, service_date);
      CREATE INDEX IF NOT EXISTS idx_production_orders_tenant_status ON production_orders(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_tenant_status ON deliveries(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_settlements_tenant_month ON settlements(tenant_id, settlement_month);
      CREATE INDEX IF NOT EXISTS idx_haccp_checks_tenant_date ON haccp_checks(tenant_id, check_date);
      CREATE INDEX IF NOT EXISTS idx_haccp_checks_tenant_status ON haccp_checks(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_product_bulk_staging_scope_action ON product_bulk_staging(tenant_id,idempotency_key,lease_token,action);
      CREATE INDEX IF NOT EXISTS idx_product_bulk_staging_created_at ON product_bulk_staging(created_at);
      CREATE INDEX IF NOT EXISTS idx_product_price_bulk_staging_scope ON product_price_bulk_staging(tenant_id,idempotency_key,lease_token);
      CREATE INDEX IF NOT EXISTS idx_product_price_bulk_staging_created_at ON product_price_bulk_staging(created_at);
    `,
  },
  {
    version: 3,
    name: 'create-vector-storage',
    sql: `
      CREATE TABLE IF NOT EXISTS erp_embeddings (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, model TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK (dimension > 0), content_hash TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, embedding vector NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CONSTRAINT chk_erp_embeddings_dimension_matches CHECK (vector_dims(embedding) = dimension),
        UNIQUE (tenant_id, entity_type, entity_id, model)
      );
      CREATE INDEX IF NOT EXISTS idx_erp_embeddings_tenant_entity
        ON erp_embeddings(tenant_id, entity_type, entity_id);
    `,
  },
  {
    version: 4,
    name: 'create-product-price-triggers',
    sql: `
      CREATE OR REPLACE FUNCTION sync_product_price_backup() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM product_price_v2_backup WHERE product_id = OLD.id;
          RETURN OLD;
        END IF;
        INSERT INTO product_price_v2_backup (
          product_id,school_price_kg,school_price_spec,school_price_each,
          vendor_price_kg,vendor_price_spec,vendor_price_each,
          purchase_price_kg,purchase_price_spec,purchase_price_each
        ) VALUES (
          NEW.id,NEW.school_price_kg,NEW.school_price_spec,NEW.school_price_each,
          NEW.vendor_price_kg,NEW.vendor_price_spec,NEW.vendor_price_each,
          NEW.purchase_price_kg,NEW.purchase_price_spec,NEW.purchase_price_each
        ) ON CONFLICT (product_id) DO UPDATE SET
          school_price_kg=EXCLUDED.school_price_kg, school_price_spec=EXCLUDED.school_price_spec,
          school_price_each=EXCLUDED.school_price_each, vendor_price_kg=EXCLUDED.vendor_price_kg,
          vendor_price_spec=EXCLUDED.vendor_price_spec, vendor_price_each=EXCLUDED.vendor_price_each,
          purchase_price_kg=EXCLUDED.purchase_price_kg, purchase_price_spec=EXCLUDED.purchase_price_spec,
          purchase_price_each=EXCLUDED.purchase_price_each;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_products_price_backup_insert ON products;
      DROP TRIGGER IF EXISTS trg_products_price_backup_update ON products;
      DROP TRIGGER IF EXISTS trg_products_price_backup_delete ON products;
      CREATE TRIGGER trg_products_price_backup_insert AFTER INSERT ON products FOR EACH ROW EXECUTE FUNCTION sync_product_price_backup();
      CREATE TRIGGER trg_products_price_backup_update AFTER UPDATE ON products FOR EACH ROW EXECUTE FUNCTION sync_product_price_backup();
      CREATE TRIGGER trg_products_price_backup_delete AFTER DELETE ON products FOR EACH ROW EXECUTE FUNCTION sync_product_price_backup();

      CREATE OR REPLACE FUNCTION create_initial_monthly_product_price() RETURNS trigger AS $$
      BEGIN
        INSERT INTO product_monthly_prices (
          tenant_id,product_id,price_month,
          school_price_kg,school_price_spec,school_price_each,
          vendor_price_kg,vendor_price_spec,vendor_price_each,
          purchase_price_kg,purchase_price_spec,purchase_price_each,
          price_version,created_at,updated_at
        ) VALUES (
          NEW.tenant_id,NEW.id,to_char(NEW.created_at::timestamptz AT TIME ZONE 'Asia/Seoul','YYYY-MM'),
          NEW.school_price_kg,NEW.school_price_spec,NEW.school_price_each,
          NEW.vendor_price_kg,NEW.vendor_price_spec,NEW.vendor_price_each,
          NEW.purchase_price_kg,NEW.purchase_price_spec,NEW.purchase_price_each,
          1,NEW.created_at,NEW.updated_at
        ) ON CONFLICT (tenant_id,product_id,price_month) DO NOTHING;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_products_monthly_price_insert ON products;
      DROP TRIGGER IF EXISTS trg_products_monthly_price_insert_v2 ON products;
      CREATE TRIGGER trg_products_monthly_price_insert_v2 AFTER INSERT ON products
        FOR EACH ROW EXECUTE FUNCTION create_initial_monthly_product_price();
    `,
  },
  {
    version: 5,
    name: 'add-idempotency-leases',
    sql: `
      ALTER TABLE idempotency_keys
        ADD COLUMN IF NOT EXISTS lease_token TEXT NOT NULL DEFAULT '';
      ALTER TABLE idempotency_keys
        ADD COLUMN IF NOT EXISTS lease_expires_at TEXT;
    `,
  },
  {
    version: 6,
    name: 'add-product-similarity-search',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE INDEX IF NOT EXISTS idx_products_name_trgm
        ON products USING gin (lower(name) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
        ON products USING gin (lower(sku) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_supplier_trgm
        ON products USING gin (lower(supplier_name) gin_trgm_ops);

      CREATE INDEX IF NOT EXISTS idx_erp_embeddings_product_chargram_hnsw
        ON erp_embeddings USING hnsw ((embedding::vector(256)) vector_cosine_ops)
        WHERE entity_type = 'product'
          AND model = 'starsnap-local-chargram-v1'
          AND dimension = 256;
    `,
  },
  {
    version: 7,
    name: 'add-product-bge-m3-search',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_erp_embeddings_product_bge_m3_hnsw
        ON erp_embeddings USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
        WHERE entity_type = 'product'
          AND model = 'ollama/bge-m3:567m-fp16@790764642607'
          AND dimension = 1024;
    `,
  },
  {
    version: 8,
    name: 'add-product-embedding-job-queue',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_products_tenant_id_id
        ON products (tenant_id, id);
      CREATE TABLE IF NOT EXISTS product_embedding_jobs (
        tenant_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        target_version INTEGER NOT NULL CHECK (target_version >= 1),
        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TIMESTAMPTZ,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, product_id),
        FOREIGN KEY (tenant_id, product_id)
          REFERENCES products(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT chk_product_embedding_jobs_lease CHECK (
          (
            status = 'PROCESSING'
            AND lease_owner IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
          ) OR (
            status <> 'PROCESSING'
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
          )
        )
      );
      CREATE INDEX IF NOT EXISTS idx_product_embedding_jobs_ready
        ON product_embedding_jobs (available_at, updated_at, tenant_id, product_id)
        WHERE status IN ('PENDING', 'RETRY');
      CREATE INDEX IF NOT EXISTS idx_product_embedding_jobs_expired_lease
        ON product_embedding_jobs (lease_expires_at, updated_at)
        WHERE status = 'PROCESSING';
      CREATE INDEX IF NOT EXISTS idx_product_embedding_jobs_tenant_status
        ON product_embedding_jobs (tenant_id, status);
    `,
  },
  {
    version: 9,
    name: 'add-tenant-user-authentication',
    sql: `
      CREATE TABLE IF NOT EXISTS erp_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email TEXT NOT NULL,
        email_normalized TEXT NOT NULL UNIQUE,
        email_verified_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CONSTRAINT chk_erp_users_status CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT chk_erp_users_username_normalized
          CHECK (username_normalized ~ '^[a-z0-9][a-z0-9._-]{3,29}$')
      );
      CREATE TABLE IF NOT EXISTS tenant_memberships (
        user_id TEXT NOT NULL REFERENCES erp_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL CONSTRAINT chk_tenant_memberships_role
          CHECK (role IN ('viewer', 'operator', 'admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (user_id, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant
        ON tenant_memberships (tenant_id, user_id);

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES erp_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
        ON auth_sessions (user_id, expires_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
        ON auth_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS email_verification_challenges (
        id TEXT PRIMARY KEY,
        email_normalized TEXT NOT NULL,
        code_mac TEXT NOT NULL,
        verification_token_hash TEXT UNIQUE,
        attempt_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_email_verification_attempts
          CHECK (attempt_count BETWEEN 0 AND 20),
        expires_at TIMESTAMPTZ NOT NULL,
        verified_at TIMESTAMPTZ,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS idx_email_verification_active
        ON email_verification_challenges (email_normalized, created_at DESC)
        WHERE consumed_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_email_verification_expiry
        ON email_verification_challenges (expires_at);

      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        action TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        attempt_count INTEGER NOT NULL DEFAULT 1 CONSTRAINT chk_auth_rate_limits_attempts
          CHECK (attempt_count >= 1),
        PRIMARY KEY (action, scope_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window
        ON auth_rate_limits (window_started_at);
    `,
  },
  {
    version: 10,
    name: 'align-auth-credential-policy-with-starsnap',
    sql: `
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM erp_users
          WHERE username !~ '^[A-Za-z0-9]{4,12}$'
             OR username_normalized !~ '^[a-z0-9]{4,12}$'
             OR lower(username) <> username_normalized
        ) THEN
          RAISE EXCEPTION 'Existing ERP usernames do not satisfy the StarSnap username policy';
        END IF;
      END
      $migration$;

      ALTER TABLE erp_users
        DROP CONSTRAINT IF EXISTS chk_erp_users_username_normalized;
      ALTER TABLE erp_users
        DROP CONSTRAINT IF EXISTS chk_erp_users_username_policy;
      ALTER TABLE erp_users
        ADD CONSTRAINT chk_erp_users_username_policy CHECK (
          username ~ '^[A-Za-z0-9]{4,12}$'
          AND username_normalized ~ '^[a-z0-9]{4,12}$'
          AND lower(username) = username_normalized
        );
    `,
  },
  {
    version: 11,
    name: 'add-brand-dealer-bidder-network',
    sql: `
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS organization_type TEXT;
      UPDATE tenants
        SET organization_type = CASE code
          WHEN 'DAON' THEN 'BRAND'
          WHEN 'SAEBOM' THEN 'DEALER'
          ELSE 'BIDDER'
        END
        WHERE organization_type IS NULL;
      ALTER TABLE tenants
        ALTER COLUMN organization_type SET DEFAULT 'BIDDER',
        ALTER COLUMN organization_type SET NOT NULL;
      ALTER TABLE tenants
        DROP CONSTRAINT IF EXISTS chk_tenants_organization_type;
      ALTER TABLE tenants
        ADD CONSTRAINT chk_tenants_organization_type
        CHECK (organization_type IN ('BRAND', 'DEALER', 'BIDDER'));

      CREATE TABLE IF NOT EXISTS brand_dealer_assignments (
        id TEXT PRIMARY KEY,
        brand_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        dealer_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        region TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CONSTRAINT chk_brand_dealer_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT uq_brand_dealer_pair UNIQUE (brand_tenant_id, dealer_tenant_id),
        CONSTRAINT chk_brand_dealer_distinct CHECK (brand_tenant_id <> dealer_tenant_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_active_brand_per_dealer
        ON brand_dealer_assignments (dealer_tenant_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX IF NOT EXISTS idx_brand_dealer_brand_status
        ON brand_dealer_assignments (brand_tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_brand_dealer_dealer_status
        ON brand_dealer_assignments (dealer_tenant_id, status);

      CREATE TABLE IF NOT EXISTS dealer_bidder_links (
        id TEXT PRIMARY KEY,
        dealer_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        bidder_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CONSTRAINT chk_dealer_bidder_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT uq_dealer_bidder_pair UNIQUE (dealer_tenant_id, bidder_tenant_id),
        CONSTRAINT chk_dealer_bidder_distinct CHECK (dealer_tenant_id <> bidder_tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dealer_bidder_dealer_status
        ON dealer_bidder_links (dealer_tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_dealer_bidder_bidder_status
        ON dealer_bidder_links (bidder_tenant_id, status);

      CREATE TABLE IF NOT EXISTS school_bids (
        id TEXT PRIMARY KEY,
        bidder_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        bid_no TEXT NOT NULL,
        school_name TEXT NOT NULL,
        title TEXT NOT NULL,
        region TEXT NOT NULL,
        awarded_at TEXT NOT NULL,
        contract_start TEXT NOT NULL,
        contract_end TEXT NOT NULL,
        contract_amount INTEGER NOT NULL CONSTRAINT chk_school_bids_amount CHECK (contract_amount >= 0),
        status TEXT NOT NULL DEFAULT 'AWARDED'
          CONSTRAINT chk_school_bids_status CHECK (status IN ('AWARDED', 'ACTIVE', 'CLOSED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT uq_school_bids_bidder_no UNIQUE (bidder_tenant_id, bid_no),
        CONSTRAINT uq_school_bids_bidder_id UNIQUE (bidder_tenant_id, id),
        CONSTRAINT chk_school_bids_dates CHECK (contract_start <= contract_end)
      );
      CREATE INDEX IF NOT EXISTS idx_school_bids_bidder_status
        ON school_bids (bidder_tenant_id, status);

      CREATE TABLE IF NOT EXISTS channel_orders (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL,
        direction TEXT NOT NULL
          CONSTRAINT chk_channel_orders_direction CHECK (direction IN ('BIDDER_TO_DEALER', 'DEALER_TO_BRAND')),
        buyer_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        supplier_tenant_id TEXT NOT NULL REFERENCES tenants(id),
        school_bid_id TEXT,
        delivery_date TEXT NOT NULL,
        total_amount INTEGER NOT NULL CONSTRAINT chk_channel_orders_amount CHECK (total_amount >= 0),
        item_count INTEGER NOT NULL CONSTRAINT chk_channel_orders_item_count CHECK (item_count > 0),
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'REQUESTED'
          CONSTRAINT chk_channel_orders_status
          CHECK (status IN ('REQUESTED', 'ACCEPTED', 'SHIPPED', 'COMPLETED', 'REJECTED', 'CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT uq_channel_orders_buyer_no UNIQUE (buyer_tenant_id, order_no),
        CONSTRAINT chk_channel_orders_distinct CHECK (buyer_tenant_id <> supplier_tenant_id),
        CONSTRAINT chk_channel_orders_bid_direction CHECK (
          (direction = 'BIDDER_TO_DEALER' AND school_bid_id IS NOT NULL)
          OR (direction = 'DEALER_TO_BRAND' AND school_bid_id IS NULL)
        ),
        CONSTRAINT fk_channel_orders_bidder_school_bid
          FOREIGN KEY (buyer_tenant_id, school_bid_id)
          REFERENCES school_bids (bidder_tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_orders_buyer_status
        ON channel_orders (buyer_tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_channel_orders_supplier_status
        ON channel_orders (supplier_tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_channel_orders_school_bid
        ON channel_orders (school_bid_id);
    `,
  },
  {
    version: 12,
    name: 'add-bid-region-targeting',
    sql: `
      CREATE TABLE IF NOT EXISTS brand_dealer_regions (
        assignment_id TEXT NOT NULL
          REFERENCES brand_dealer_assignments(id) ON DELETE CASCADE,
        region_code TEXT NOT NULL
          CONSTRAINT chk_brand_dealer_regions_code
          CHECK (region_code IN (
            'SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN',
            'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK',
            'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU'
          )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (assignment_id, region_code)
      );
      CREATE INDEX IF NOT EXISTS idx_brand_dealer_regions_code
        ON brand_dealer_regions (region_code, assignment_id);

      CREATE TABLE IF NOT EXISTS bidder_target_regions (
        bidder_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        region_code TEXT NOT NULL
          CONSTRAINT chk_bidder_target_regions_code
          CHECK (region_code IN (
            'SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN',
            'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK',
            'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU'
          )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bidder_tenant_id, region_code)
      );
      CREATE INDEX IF NOT EXISTS idx_bidder_target_regions_code
        ON bidder_target_regions (region_code, bidder_tenant_id);

      ALTER TABLE school_bids
        ADD COLUMN IF NOT EXISTS region_code TEXT;
      ALTER TABLE school_bids
        DROP CONSTRAINT IF EXISTS chk_school_bids_region_code;
      ALTER TABLE school_bids
        ADD CONSTRAINT chk_school_bids_region_code
        CHECK (region_code IS NULL OR region_code IN (
          'SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN',
          'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK',
          'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU'
        ));
      CREATE INDEX IF NOT EXISTS idx_school_bids_region_status
        ON school_bids (region_code, status);
    `,
  },
  {
    version: 13,
    name: 'add-administrative-area-targeting',
    sql: `
      CREATE TABLE IF NOT EXISTS administrative_areas (
        code TEXT PRIMARY KEY
          CONSTRAINT chk_administrative_areas_code
          CHECK (code ~ '^[0-9]{2}([0-9]{3})?$'),
        parent_code TEXT
          CONSTRAINT fk_administrative_areas_parent
          REFERENCES administrative_areas(code),
        province_code TEXT NOT NULL
          CONSTRAINT chk_administrative_areas_province_code
          CHECK (province_code ~ '^[0-9]{2}$'),
        name TEXT NOT NULL,
        local_name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        level TEXT NOT NULL
          CONSTRAINT chk_administrative_areas_level
          CHECK (level IN ('SIDO', 'CITY_COUNTY', 'ADMIN_DISTRICT')),
        selectable BOOLEAN NOT NULL DEFAULT FALSE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        data_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT chk_administrative_areas_parent CHECK (
          (level = 'SIDO' AND parent_code IS NULL)
          OR (level <> 'SIDO' AND parent_code IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_administrative_areas_parent_active
        ON administrative_areas (parent_code, active);
      CREATE INDEX IF NOT EXISTS idx_administrative_areas_province_level
        ON administrative_areas (province_code, level, active);

      CREATE TABLE IF NOT EXISTS brand_dealer_areas (
        assignment_id TEXT NOT NULL
          REFERENCES brand_dealer_assignments(id) ON DELETE CASCADE,
        area_code TEXT NOT NULL REFERENCES administrative_areas(code),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (assignment_id, area_code)
      );
      CREATE INDEX IF NOT EXISTS idx_brand_dealer_areas_code
        ON brand_dealer_areas (area_code, assignment_id);

      CREATE TABLE IF NOT EXISTS bidder_target_areas (
        bidder_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        area_code TEXT NOT NULL REFERENCES administrative_areas(code),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bidder_tenant_id, area_code)
      );
      CREATE INDEX IF NOT EXISTS idx_bidder_target_areas_code
        ON bidder_target_areas (area_code, bidder_tenant_id);

      ALTER TABLE school_bids
        ADD COLUMN IF NOT EXISTS area_code TEXT;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'school_bids'::regclass
            AND conname = 'fk_school_bids_area'
        ) THEN
          ALTER TABLE school_bids
            ADD CONSTRAINT fk_school_bids_area
            FOREIGN KEY (area_code) REFERENCES administrative_areas(code);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_school_bids_area_status
        ON school_bids (area_code, status);
    `,
  },
  {
    version: 14,
    name: 'add-national-school-master',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE IF NOT EXISTS school_sync_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_data_version TEXT,
        status TEXT NOT NULL DEFAULT 'RUNNING'
          CONSTRAINT chk_school_sync_runs_status
          CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        expected_count INTEGER
          CONSTRAINT chk_school_sync_runs_expected_count
          CHECK (expected_count IS NULL OR expected_count >= 0),
        processed_count INTEGER NOT NULL DEFAULT 0
          CONSTRAINT chk_school_sync_runs_processed_count CHECK (processed_count >= 0),
        mapped_count INTEGER NOT NULL DEFAULT 0
          CONSTRAINT chk_school_sync_runs_mapped_count CHECK (mapped_count >= 0),
        deactivated_count INTEGER NOT NULL DEFAULT 0
          CONSTRAINT chk_school_sync_runs_deactivated_count CHECK (deactivated_count >= 0),
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        completed_at TIMESTAMPTZ,
        CONSTRAINT chk_school_sync_runs_completion CHECK (
          (status = 'RUNNING' AND completed_at IS NULL)
          OR (status IN ('COMPLETED', 'FAILED') AND completed_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_school_sync_runs_running_source
        ON school_sync_runs (source)
        WHERE status = 'RUNNING';
      CREATE INDEX IF NOT EXISTS idx_school_sync_runs_source_started
        ON school_sync_runs (source, started_at DESC);

      CREATE TABLE IF NOT EXISTS schools (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_office_code TEXT NOT NULL,
        source_school_code TEXT NOT NULL,
        name TEXT NOT NULL,
        english_name TEXT,
        school_kind TEXT NOT NULL,
        education_office_name TEXT,
        jurisdiction_org_name TEXT,
        foundation_type TEXT,
        location_name TEXT,
        postal_code TEXT,
        road_address TEXT NOT NULL,
        road_detail_address TEXT,
        phone TEXT,
        fax TEXT,
        homepage TEXT,
        coeducation_type TEXT,
        day_night_type TEXT,
        foundation_date TEXT,
        anniversary_date TEXT,
        source_updated_at TEXT,
        source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        area_code TEXT REFERENCES administrative_areas(code),
        mapping_status TEXT NOT NULL DEFAULT 'UNMAPPED'
          CONSTRAINT chk_schools_mapping_status
          CHECK (mapping_status IN ('MAPPED', 'UNMAPPED', 'REVIEW_REQUIRED')),
        active BOOLEAN NOT NULL DEFAULT FALSE,
        missing_sync_count INTEGER NOT NULL DEFAULT 0
          CONSTRAINT chk_schools_missing_sync_count CHECK (missing_sync_count >= 0),
        last_seen_run_id TEXT NOT NULL REFERENCES school_sync_runs(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_schools_external_identity
          UNIQUE (source, source_office_code, source_school_code),
        CONSTRAINT chk_schools_external_identity CHECK (
          btrim(source) <> ''
          AND btrim(source_office_code) <> ''
          AND btrim(source_school_code) <> ''
        ),
        CONSTRAINT chk_schools_required_text CHECK (
          btrim(name) <> '' AND btrim(school_kind) <> '' AND btrim(road_address) <> ''
        ),
        CONSTRAINT chk_schools_area_mapping CHECK (
          (mapping_status = 'MAPPED' AND area_code IS NOT NULL)
          OR (mapping_status IN ('UNMAPPED', 'REVIEW_REQUIRED') AND area_code IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_schools_name_trgm
        ON schools USING gin (lower(name) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_schools_road_address_trgm
        ON schools USING gin (lower(road_address) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_schools_source_active
        ON schools (source, active, source_office_code, source_school_code);
      CREATE INDEX IF NOT EXISTS idx_schools_area_active
        ON schools (area_code, active, name);
      CREATE INDEX IF NOT EXISTS idx_schools_last_seen_run
        ON schools (last_seen_run_id);

      ALTER TABLE school_bids
        ADD COLUMN IF NOT EXISTS school_id TEXT;
      ALTER TABLE school_bids
        ADD COLUMN IF NOT EXISTS school_address TEXT;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'school_bids'::regclass
            AND conname = 'fk_school_bids_school'
        ) THEN
          ALTER TABLE school_bids
            ADD CONSTRAINT fk_school_bids_school
            FOREIGN KEY (school_id) REFERENCES schools(id);
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'school_bids'::regclass
            AND conname = 'chk_school_bids_school_snapshot'
        ) THEN
          ALTER TABLE school_bids
            ADD CONSTRAINT chk_school_bids_school_snapshot CHECK (
              school_id IS NULL
              OR (
                school_address IS NOT NULL
                AND btrim(school_address) <> ''
                AND area_code IS NOT NULL
              )
            );
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_school_bids_school_status
        ON school_bids (school_id, status);
    `,
  },
  {
    version: 15,
    name: 'add-eat-bid-public-cache',
    sql: `
      CREATE TABLE IF NOT EXISTS eat_bid_query_cache (
        query_hash TEXT PRIMARY KEY
          CONSTRAINT chk_eat_bid_query_cache_hash
          CHECK (query_hash ~ '^[0-9a-f]{64}$'),
        normalized_filters JSONB NOT NULL
          CONSTRAINT chk_eat_bid_query_cache_filters
          CHECK (jsonb_typeof(normalized_filters) = 'object'),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        page INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_query_cache_page CHECK (page > 0),
        page_size INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_query_cache_page_size CHECK (page_size > 0),
        total_count INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_query_cache_total_count CHECK (total_count >= 0),
        fetched_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        last_accessed_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT chk_eat_bid_query_cache_dates CHECK (start_date <= end_date),
        CONSTRAINT chk_eat_bid_query_cache_expiry CHECK (expires_at > fetched_at),
        CONSTRAINT chk_eat_bid_query_cache_access CHECK (last_accessed_at >= fetched_at)
      );
      CREATE INDEX IF NOT EXISTS idx_eat_bid_query_cache_expiry
        ON eat_bid_query_cache (expires_at);
      CREATE INDEX IF NOT EXISTS idx_eat_bid_query_cache_last_accessed
        ON eat_bid_query_cache (last_accessed_at);

      CREATE TABLE IF NOT EXISTS eat_bid_announcements (
        query_hash TEXT NOT NULL
          REFERENCES eat_bid_query_cache(query_hash) ON DELETE CASCADE,
        bid_no TEXT NOT NULL
          CONSTRAINT chk_eat_bid_announcements_bid_no CHECK (btrim(bid_no) <> ''),
        bid_name TEXT NOT NULL DEFAULT '',
        status_name TEXT NOT NULL DEFAULT '',
        announcement_date TEXT NOT NULL DEFAULT '',
        announcement_time TEXT NOT NULL DEFAULT '',
        purchasing_organization_name TEXT NOT NULL DEFAULT '',
        demand_organization_name TEXT NOT NULL DEFAULT '',
        bid_start_date TEXT NOT NULL DEFAULT '',
        bid_end_date TEXT NOT NULL DEFAULT '',
        bid_open_date TEXT NOT NULL DEFAULT '',
        bid_open_time TEXT NOT NULL DEFAULT '',
        delivery_start_date TEXT NOT NULL DEFAULT '',
        delivery_end_date TEXT NOT NULL DEFAULT '',
        delivery_address TEXT NOT NULL DEFAULT '',
        base_price_text TEXT NOT NULL DEFAULT '',
        item_name TEXT NOT NULL DEFAULT '',
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT chk_eat_bid_announcements_payload
          CHECK (jsonb_typeof(raw_payload) = 'object'),
        fetched_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (query_hash, bid_no)
      );
      CREATE INDEX IF NOT EXISTS idx_eat_bid_announcements_demand_org
        ON eat_bid_announcements (
          query_hash, demand_organization_name, announcement_date DESC
        );
      CREATE INDEX IF NOT EXISTS idx_eat_bid_announcements_bid_date
        ON eat_bid_announcements (query_hash, announcement_date DESC, bid_no);

      CREATE TABLE IF NOT EXISTS eat_bid_item_specs (
        query_hash TEXT NOT NULL,
        spec_id TEXT NOT NULL
          CONSTRAINT chk_eat_bid_item_specs_id CHECK (btrim(spec_id) <> ''),
        bid_no TEXT NOT NULL,
        message_order INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_item_specs_message_order CHECK (message_order >= 0),
        item_order INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_item_specs_item_order CHECK (item_order >= 0),
        inst_name TEXT NOT NULL DEFAULT '',
        item_name TEXT NOT NULL DEFAULT '',
        food_name TEXT NOT NULL DEFAULT '',
        specification TEXT NOT NULL DEFAULT '',
        unit_name TEXT NOT NULL DEFAULT '',
        attributes TEXT NOT NULL DEFAULT '',
        quantity_text TEXT NOT NULL DEFAULT '',
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT chk_eat_bid_item_specs_payload
          CHECK (jsonb_typeof(raw_payload) = 'object'),
        PRIMARY KEY (query_hash, spec_id),
        CONSTRAINT fk_eat_bid_item_specs_announcement
          FOREIGN KEY (query_hash, bid_no)
          REFERENCES eat_bid_announcements(query_hash, bid_no) ON DELETE CASCADE,
        CONSTRAINT uq_eat_bid_item_specs_position
          UNIQUE (query_hash, bid_no, message_order, item_order)
      );
      CREATE INDEX IF NOT EXISTS idx_eat_bid_item_specs_food_name
        ON eat_bid_item_specs (query_hash, food_name);

      CREATE TABLE IF NOT EXISTS eat_bid_query_results (
        query_hash TEXT NOT NULL
          REFERENCES eat_bid_query_cache(query_hash) ON DELETE CASCADE,
        bid_no TEXT NOT NULL,
        position INTEGER NOT NULL
          CONSTRAINT chk_eat_bid_query_results_position CHECK (position >= 0),
        PRIMARY KEY (query_hash, bid_no),
        CONSTRAINT fk_eat_bid_query_results_announcement
          FOREIGN KEY (query_hash, bid_no)
          REFERENCES eat_bid_announcements(query_hash, bid_no) ON DELETE CASCADE,
        CONSTRAINT uq_eat_bid_query_results_position UNIQUE (query_hash, position)
      );
      CREATE INDEX IF NOT EXISTS idx_eat_bid_query_results_bid
        ON eat_bid_query_results (bid_no, query_hash);
    `,
  },
];

export const latestPostgresSchemaVersion = postgresMigrations[postgresMigrations.length - 1].version;

async function migrationChecksum(migration: PostgresMigration) {
  const payload = new TextEncoder().encode(`${migration.version}\n${migration.name}\n${migration.sql}`);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runPostgresMigrations(client: PoolClient) {
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mealops-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT,
      applied_at TEXT NOT NULL
    )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    const applied = await client.query<{ version: number; name: string; checksum: string | null }>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    const appliedByVersion = new Map(applied.rows.map((row) => [Number(row.version), row]));
    for (const migration of postgresMigrations) {
      const checksum = await migrationChecksum(migration);
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name || (existing.checksum && existing.checksum !== checksum)) {
          throw new Error(`PostgreSQL migration ${migration.version} metadata/checksum mismatch.`);
        }
        if (!existing.checksum) {
          await client.query(
            'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL',
            [checksum, migration.version],
          );
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
        [migration.version, migration.name, checksum, new Date().toISOString()],
      );
    }
    const expectedVersions = postgresMigrations.map((migration) => migration.version);
    const verified = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM schema_migrations
       WHERE version = ANY($1::integer[]) AND checksum IS NOT NULL`,
      [expectedVersions],
    );
    if (verified.rows[0]?.count !== expectedVersions.length) {
      throw new Error('PostgreSQL migration verification failed.');
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('PostgreSQL migration rollback failed', rollbackError);
    }
    throw error;
  }
}
