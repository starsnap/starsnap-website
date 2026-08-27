import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { runPostgresMigrations } from '../db/postgres-migrations.ts';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, 'true');
  }
}

const sourcePath = args.get('--source');
const replace = args.get('--replace') === 'true';
const connectionString = process.env.DATABASE_URL;
const expectedSourceSha256 = process.env.D1_EXPECTED_SHA256?.trim().toLowerCase();
const replaceConfirmation = process.env.D1_REPLACE_CONFIRM;
const writesQuiesced = process.env.D1_WRITES_QUIESCED === 'WRITES_STOPPED';
const forceReapply = process.env.D1_FORCE_REAPPLY === 'REAPPLY_VERIFIED_SNAPSHOT';
const expectedDatabase = process.env.POSTGRES_DB?.trim();
if (!sourcePath || !connectionString) {
  console.error('Usage: DATABASE_URL=... D1_EXPECTED_SHA256=... D1_REPLACE_CONFIRM=REPLACE_POSTGRES_FROM_D1 node scripts/migrate-d1-to-postgres.mjs --source <snapshot.sqlite> --replace');
  process.exit(2);
}
if (!replace || replaceConfirmation !== 'REPLACE_POSTGRES_FROM_D1' || !writesQuiesced) {
  throw new Error('Refusing destructive import without --replace, D1_REPLACE_CONFIRM=REPLACE_POSTGRES_FROM_D1, and D1_WRITES_QUIESCED=WRITES_STOPPED.');
}
if (!expectedSourceSha256 || !/^[a-f0-9]{64}$/.test(expectedSourceSha256)) {
  throw new Error('D1_EXPECTED_SHA256 must contain the verified 64-character snapshot SHA-256.');
}
if (expectedDatabase) {
  const targetDatabase = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (targetDatabase !== expectedDatabase) {
    throw new Error(`DATABASE_URL targets ${targetDatabase}, but POSTGRES_DB requires ${expectedDatabase}.`);
  }
}

const tableDefinitions = [
  { table: 'tenants', columns: [['id', 'text'], ['code', 'text'], ['name', 'text'], ['status', 'text'], ['brand_color', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'sites', columns: [['id', 'text'], ['tenant_id', 'text'], ['code', 'text'], ['name', 'text'], ['type', 'text'], ['timezone', 'text'], ['active', 'boolean'], ['created_at', 'text'], ['updated_at', 'text']], booleanColumns: ['active'] },
  { table: 'products', columns: [['id', 'text'], ['tenant_id', 'text'], ['sku', 'text'], ['name', 'text'], ['category', 'text'], ['specification', 'text'], ['unit', 'text'], ['unit_price', 'integer'], ['supplier_name', 'text'], ['storage_type', 'text'], ['allergens', 'text'], ['status', 'text'], ['version', 'integer'], ['created_at', 'text'], ['updated_at', 'text'], ['school_price_kg', 'integer'], ['school_price_spec', 'integer'], ['school_price_each', 'integer'], ['vendor_price_kg', 'integer'], ['vendor_price_spec', 'integer'], ['vendor_price_each', 'integer'], ['purchase_price_kg', 'integer'], ['purchase_price_spec', 'integer'], ['purchase_price_each', 'integer']] },
  { table: 'product_monthly_prices', columns: [['tenant_id', 'text'], ['product_id', 'text'], ['price_month', 'text'], ['school_price_kg', 'integer'], ['school_price_spec', 'integer'], ['school_price_each', 'integer'], ['vendor_price_kg', 'integer'], ['vendor_price_spec', 'integer'], ['vendor_price_each', 'integer'], ['purchase_price_kg', 'integer'], ['purchase_price_spec', 'integer'], ['purchase_price_each', 'integer'], ['price_version', 'integer'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'product_price_v2_backup', columns: [['product_id', 'text'], ['school_price_kg', 'integer'], ['school_price_spec', 'integer'], ['school_price_each', 'integer'], ['vendor_price_kg', 'integer'], ['vendor_price_spec', 'integer'], ['vendor_price_each', 'integer'], ['purchase_price_kg', 'integer'], ['purchase_price_spec', 'integer'], ['purchase_price_each', 'integer']] },
  { table: 'meal_plans', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['service_date', 'text'], ['meal_type', 'text'], ['menu_name', 'text'], ['planned_servings', 'integer'], ['actual_servings', 'integer'], ['allergens', 'text'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'purchase_orders', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['order_no', 'text'], ['supplier_name', 'text'], ['delivery_date', 'text'], ['total_amount', 'integer'], ['item_count', 'integer'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'inventory_lots', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['ingredient_name', 'text'], ['lot_no', 'text'], ['quantity', 'integer'], ['unit', 'text'], ['expires_at', 'text'], ['location', 'text'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'production_orders', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['service_date', 'text'], ['menu_name', 'text'], ['planned_quantity', 'integer'], ['actual_quantity', 'integer'], ['core_temperature', 'integer'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'deliveries', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['delivery_no', 'text'], ['scheduled_at', 'text'], ['driver_name', 'text'], ['vehicle_no', 'text'], ['servings', 'integer'], ['temperature', 'integer'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'settlements', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['settlement_month', 'text'], ['actual_servings', 'integer'], ['sales_amount', 'integer'], ['ingredient_cost', 'integer'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'haccp_checks', columns: [['id', 'text'], ['tenant_id', 'text'], ['site_id', 'text'], ['check_date', 'text'], ['category', 'text'], ['item_name', 'text'], ['measured_value', 'text'], ['assignee_name', 'text'], ['corrective_action', 'text'], ['verification_value', 'text'], ['verified_by', 'text'], ['verified_at', 'text'], ['status', 'text'], ['created_at', 'text'], ['updated_at', 'text']] },
  { table: 'idempotency_keys', columns: [['tenant_id', 'text'], ['key', 'text'], ['request_hash', 'text'], ['response_json', 'text'], ['created_at', 'text'], ['lease_token', 'text'], ['lease_expires_at', 'text']] },
  { table: 'audit_logs', columns: [['id', 'text'], ['tenant_id', 'text'], ['actor', 'text'], ['action', 'text'], ['entity_type', 'text'], ['entity_id', 'text'], ['detail', 'text'], ['created_at', 'text']] },
];

const transientSourceTables = ['product_bulk_staging', 'product_price_bulk_staging'];
const sourceMetadataTables = ['_cf_METADATA', 'd1_migrations', '__drizzle_migrations'];
const replacedDestinationTables = [
  'erp_embeddings', 'product_bulk_staging', 'product_price_bulk_staging',
  'idempotency_keys', 'audit_logs', 'haccp_checks', 'settlements', 'deliveries',
  'production_orders', 'inventory_lots', 'purchase_orders', 'meal_plans',
  'product_monthly_prices', 'products', 'sites', 'tenants', 'product_price_v2_backup',
];
const retainedDestinationTables = ['schema_migrations', 'data_migrations', 'data_migration_state'];

function quoted(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

function sourceRows(database, definition) {
  const names = definition.columns.map(([name]) => quoted(name));
  const rows = database.prepare(`SELECT ${names.join(', ')} FROM ${quoted(definition.table)}`).all();
  const booleans = new Set(definition.booleanColumns || []);
  return rows.map((row) => Object.fromEntries(definition.columns.map(([name]) => [
    name,
    booleans.has(name) ? Boolean(row[name]) : row[name],
  ])));
}

function rowsSha256(rows) {
  const canonicalRows = rows.map((row) => JSON.stringify(row)).sort();
  const hash = createHash('sha256');
  for (const row of canonicalRows) hash.update(row).update('\n');
  return hash.digest('hex');
}

async function destinationRows(client, definition) {
  const names = definition.columns.map(([name]) => quoted(name));
  const result = await client.query(`SELECT ${names.join(', ')} FROM ${quoted(definition.table)}`);
  return result.rows;
}

async function destinationSnapshot(client) {
  const counts = {};
  const hashes = {};
  for (const definition of tableDefinitions) {
    const result = await client.query(`SELECT COUNT(*)::integer AS count FROM ${quoted(definition.table)}`);
    counts[definition.table] = result.rows[0].count;
    hashes[definition.table] = rowsSha256(await destinationRows(client, definition));
  }
  return { counts, hashes };
}

async function insertRows(client, definition, rows) {
  if (rows.length === 0) return;
  const names = definition.columns.map(([name]) => name);
  const recordDefinition = definition.columns.map(([name, type]) => `${quoted(name)} ${type}`).join(', ');
  const insertSql = `INSERT INTO ${quoted(definition.table)} (${names.map(quoted).join(', ')})
    SELECT ${names.map(quoted).join(', ')}
    FROM jsonb_to_recordset($1::jsonb) AS imported(${recordDefinition})`;
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const chunk = rows.slice(offset, offset + 1000);
    const result = await client.query(insertSql, [JSON.stringify(chunk)]);
    if (result.rowCount !== chunk.length) {
      throw new Error(`${definition.table} import count mismatch at ${offset}: ${result.rowCount}/${chunk.length}`);
    }
  }
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();
try {
  const quickCheck = source.prepare('PRAGMA quick_check').get()?.quick_check;
  const foreignKeyIssues = source.prepare('PRAGMA foreign_key_check').all();
  if (quickCheck !== 'ok' || foreignKeyIssues.length !== 0) {
    throw new Error(`Invalid D1 snapshot: quick_check=${quickCheck}, foreign_key_issues=${foreignKeyIssues.length}`);
  }
  const sourceSha256 = await sha256File(sourcePath);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`D1 snapshot SHA-256 mismatch: actual=${sourceSha256}, expected=${expectedSourceSha256}`);
  }
  const sourceTables = new Set(source.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map(({ name }) => name));
  const missingSourceTables = tableDefinitions
    .map(({ table }) => table)
    .filter((table) => !sourceTables.has(table));
  if (missingSourceTables.length > 0) {
    throw new Error(`Unsupported old D1 schema; apply the historical D1 migrations to a copy first. Missing: ${missingSourceTables.join(', ')}`);
  }
  const knownSourceTables = new Set([
    ...tableDefinitions.map(({ table }) => table),
    ...transientSourceTables,
    ...sourceMetadataTables,
  ]);
  const unknownSourceTables = [...sourceTables].filter((table) => !knownSourceTables.has(table));
  if (unknownSourceTables.length > 0) {
    throw new Error(`Importer does not know how to migrate new D1 tables: ${unknownSourceTables.join(', ')}`);
  }
  const transientSourceCounts = Object.fromEntries(transientSourceTables.map((table) => [
    table,
    sourceTables.has(table)
      ? Number(source.prepare(`SELECT COUNT(*) AS count FROM ${quoted(table)}`).get().count)
      : 0,
  ]));
  if (Object.values(transientSourceCounts).some((count) => count !== 0)) {
    throw new Error(`D1 snapshot contains in-flight bulk staging rows: ${JSON.stringify(transientSourceCounts)}`);
  }
  const sourceCounts = Object.fromEntries(tableDefinitions.map((definition) => [
    definition.table,
    Number(source.prepare(`SELECT COUNT(*) AS count FROM ${quoted(definition.table)}`).get().count),
  ]));
  const sourceHashes = Object.fromEntries(tableDefinitions.map((definition) => [
    definition.table,
    rowsSha256(sourceRows(source, definition)),
  ]));

  await runPostgresMigrations(client);
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mealops:d1-import', 0))");
  const schemaReady = await client.query("SELECT to_regclass('public.tenants') AS table_name");
  if (!schemaReady.rows[0]?.table_name) throw new Error('PostgreSQL schema initialization failed.');
  await client.query(`CREATE TABLE IF NOT EXISTS data_migrations (
    source_sha256 text PRIMARY KEY,
    source_kind text NOT NULL,
    source_path text NOT NULL,
    table_counts jsonb NOT NULL,
    table_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied_at text NOT NULL
  )`);
  await client.query("ALTER TABLE data_migrations ADD COLUMN IF NOT EXISTS table_hashes jsonb NOT NULL DEFAULT '{}'::jsonb");
  await client.query(`CREATE TABLE IF NOT EXISTS data_migration_state (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    active_source_sha256 text NOT NULL REFERENCES data_migrations(source_sha256),
    activated_at text NOT NULL
  )`);

  const destinationTables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const knownDestinationTables = new Set([
    ...tableDefinitions.map(({ table }) => table),
    ...replacedDestinationTables,
    ...retainedDestinationTables,
  ]);
  const unknownDestinationTables = destinationTables.rows
    .map(({ tablename }) => tablename)
    .filter((table) => !knownDestinationTables.has(table));
  if (unknownDestinationTables.length > 0) {
    throw new Error(`Importer does not know how to preserve new PostgreSQL tables: ${unknownDestinationTables.join(', ')}`);
  }

  const activeSnapshot = await client.query(
    'SELECT active_source_sha256 FROM data_migration_state WHERE singleton IS TRUE',
  );
  const activeSourceSha256 = activeSnapshot.rows[0]?.active_source_sha256;
  const priorImport = await client.query(
    'SELECT source_sha256 FROM data_migrations WHERE source_sha256 = $1',
    [sourceSha256],
  );
  if (priorImport.rowCount === 1 && activeSourceSha256 !== sourceSha256 && !forceReapply) {
    throw new Error('This D1 snapshot was imported previously but is not active. Set D1_FORCE_REAPPLY=REAPPLY_VERIFIED_SNAPSHOT to restore it.');
  }
  if (activeSourceSha256 === sourceSha256 && !forceReapply) {
    const destination = await destinationSnapshot(client);
    const driftedTables = tableDefinitions
      .map(({ table }) => table)
      .filter((table) => destination.counts[table] !== sourceCounts[table] || destination.hashes[table] !== sourceHashes[table]);
    if (driftedTables.length > 0) {
      throw new Error(`Active D1 snapshot no longer matches PostgreSQL (${driftedTables.join(', ')}). Verify the target, then set D1_FORCE_REAPPLY=REAPPLY_VERIFIED_SNAPSHOT to restore it.`);
    }
    await client.query('ROLLBACK');
    console.log(JSON.stringify({
      ok: true, alreadyApplied: true, verified: true, sourceSha256, sourceCounts,
      destinationCounts: destination.counts, sourceHashes, destinationHashes: destination.hashes,
    }));
  } else {
    const targetOnlyData = await client.query(`SELECT
      (SELECT count(*)::integer FROM erp_embeddings) AS embeddings,
      (SELECT count(*)::integer FROM product_bulk_staging) AS product_staging,
      (SELECT count(*)::integer FROM product_price_bulk_staging) AS price_staging`);
    if (Object.values(targetOnlyData.rows[0]).some((count) => Number(count) !== 0)) {
      throw new Error(`Refusing to erase PostgreSQL-only or in-flight data: ${JSON.stringify(targetOnlyData.rows[0])}`);
    }
    await client.query(`TRUNCATE TABLE ${replacedDestinationTables.map(quoted).join(', ')}`);
    await client.query('ALTER TABLE products DISABLE TRIGGER USER');
    for (const definition of tableDefinitions) {
      await insertRows(client, definition, sourceRows(source, definition));
    }
    await client.query('ALTER TABLE products ENABLE TRIGGER USER');

    const destination = await destinationSnapshot(client);
    const destinationCounts = destination.counts;
    const destinationHashes = destination.hashes;
    for (const definition of tableDefinitions) {
      if (destinationCounts[definition.table] !== sourceCounts[definition.table]) {
        throw new Error(`${definition.table} final count mismatch: ${destinationCounts[definition.table]}/${sourceCounts[definition.table]}`);
      }
      if (destinationHashes[definition.table] !== sourceHashes[definition.table]) {
        throw new Error(`${definition.table} content hash mismatch after import.`);
      }
    }
    const integrity = await client.query(`SELECT
      (SELECT COUNT(*)::integer FROM product_monthly_prices price
        LEFT JOIN products product ON product.tenant_id = price.tenant_id AND product.id = price.product_id
        WHERE product.id IS NULL) AS orphan_prices,
      (SELECT COUNT(*)::integer FROM products product
        LEFT JOIN product_monthly_prices price ON price.tenant_id = product.tenant_id AND price.product_id = product.id
        WHERE price.product_id IS NULL) AS products_without_price,
      (SELECT COUNT(*)::integer FROM products product
        JOIN product_price_v2_backup backup ON backup.product_id = product.id
        WHERE (product.school_price_kg, product.school_price_spec, product.school_price_each,
               product.vendor_price_kg, product.vendor_price_spec, product.vendor_price_each,
               product.purchase_price_kg, product.purchase_price_spec, product.purchase_price_each)
           IS DISTINCT FROM
              (backup.school_price_kg, backup.school_price_spec, backup.school_price_each,
               backup.vendor_price_kg, backup.vendor_price_spec, backup.vendor_price_each,
               backup.purchase_price_kg, backup.purchase_price_spec, backup.purchase_price_each)) AS backup_price_mismatches,
      (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version`);
    const checks = integrity.rows[0];
    if (checks.orphan_prices !== 0 || checks.products_without_price !== 0 || checks.backup_price_mismatches !== 0 || !checks.vector_version) {
      throw new Error(`PostgreSQL integrity verification failed: ${JSON.stringify(checks)}`);
    }
    await client.query(
      `INSERT INTO data_migrations
         (source_sha256, source_kind, source_path, table_counts, table_hashes, applied_at)
       VALUES ($1, 'cloudflare-d1-sqlite', $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (source_sha256) DO UPDATE SET
         source_path = EXCLUDED.source_path,
         table_counts = EXCLUDED.table_counts,
         table_hashes = EXCLUDED.table_hashes,
         applied_at = EXCLUDED.applied_at`,
      [sourceSha256, sourcePath, JSON.stringify(sourceCounts), JSON.stringify(sourceHashes), new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO data_migration_state (singleton, active_source_sha256, activated_at)
       VALUES (TRUE, $1, $2)
       ON CONFLICT (singleton) DO UPDATE SET
         active_source_sha256 = EXCLUDED.active_source_sha256,
         activated_at = EXCLUDED.activated_at`,
      [sourceSha256, new Date().toISOString()],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({
      ok: true, alreadyApplied: false, forced: forceReapply, sourceSha256,
      sourceCounts, destinationCounts, sourceHashes, destinationHashes, integrity: checks,
    }));
  }
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {}
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  source.close();
  client.release();
  await pool.end();
}
