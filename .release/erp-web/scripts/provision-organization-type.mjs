import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    index += 1;
  }
}

const tenantCode = args.get('--tenant')?.trim().toUpperCase();
const organizationType = args.get('--type')?.trim().toUpperCase();
const actor = args.get('--actor')?.trim();
const confirmation = args.get('--confirm')?.trim().toUpperCase();
const connectionString = process.env.DATABASE_URL;
const allowedTypes = new Set(['BRAND', 'DEALER', 'BIDDER']);

if (!connectionString || !tenantCode || !organizationType || !actor) {
  console.error('Usage: DATABASE_URL=... npm run organization:provision -- --tenant CODE --type BRAND|DEALER|BIDDER --actor PLATFORM_ADMIN --confirm CODE:TYPE');
  process.exit(2);
}
if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(tenantCode)) {
  throw new Error('Tenant code must contain 3-32 uppercase letters, numbers, or hyphens.');
}
if (!allowedTypes.has(organizationType)) throw new Error('Organization type must be BRAND, DEALER, or BIDDER.');
if (actor.length > 120) throw new Error('Actor must be 120 characters or fewer.');
if (confirmation !== `${tenantCode}:${organizationType}`) {
  throw new Error(`Refusing organization change without --confirm ${tenantCode}:${organizationType}.`);
}

const pool = new Pool({
  connectionString,
  max: 1,
  ssl: process.env.PGSSL === 'require'
    ? { rejectUnauthorized: true, ca: process.env.PGSSL_CA?.replaceAll('\\n', '\n') }
    : process.env.PGSSL === 'insecure'
      ? { rejectUnauthorized: false }
      : undefined,
});

let client;
try {
  client = await pool.connect();
  // Explicit tenant row locks serialize provisioning with network mutations.
  // READ COMMITTED gives the usage check a fresh snapshot after any lock wait.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const schema = await client.query('SELECT MAX(version)::integer AS version FROM schema_migrations');
  if ((schema.rows[0]?.version ?? 0) < 11) throw new Error('Schema version 11 or later is required.');

  const tenantResult = await client.query(
    `SELECT id, code, name, organization_type AS "organizationType"
     FROM tenants WHERE code = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [tenantCode],
  );
  const tenant = tenantResult.rows[0];
  if (!tenant) throw new Error(`Active tenant ${tenantCode} was not found.`);
  if (tenant.organizationType === organizationType) {
    await client.query('COMMIT');
    console.log(`${tenant.code} (${tenant.name}) is already ${organizationType}.`);
    process.exitCode = 0;
  } else {
    const usage = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM brand_dealer_assignments WHERE brand_tenant_id = $1 OR dealer_tenant_id = $1)
         OR EXISTS (SELECT 1 FROM dealer_bidder_links WHERE dealer_tenant_id = $1 OR bidder_tenant_id = $1)
         OR EXISTS (SELECT 1 FROM school_bids WHERE bidder_tenant_id = $1)
         OR EXISTS (SELECT 1 FROM channel_orders WHERE buyer_tenant_id = $1 OR supplier_tenant_id = $1)
         AS "hasNetworkData"`,
      [tenant.id],
    );
    if (usage.rows[0]?.hasNetworkData) {
      throw new Error('Refusing to reclassify a tenant that already has network relationships, bids, or orders.');
    }

    const now = new Date().toISOString();
    await client.query(
      'UPDATE tenants SET organization_type = $1, updated_at = $2 WHERE id = $3',
      [organizationType, now, tenant.id],
    );
    await client.query(
      `INSERT INTO audit_logs
        (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
       VALUES ($1, $2, $3, 'provision-organization-type', 'tenant', $2, $4, $5)`,
      [randomUUID(), tenant.id, actor, `${tenant.organizationType} → ${organizationType}`, now],
    );
    await client.query('COMMIT');
    console.log(`Updated ${tenant.code} (${tenant.name}) from ${tenant.organizationType} to ${organizationType}.`);
  }
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
