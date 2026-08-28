import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const source = process.env.STARSNAP_WORKER_SOURCE_CONFIG?.trim()
  || '/app/dist/server/wrangler.json';
const target = process.env.STARSNAP_WORKER_CONFIG_FILE?.trim()
  || '/app/dist/server/wrangler.runtime.json';
const secretsTarget = process.env.STARSNAP_WORKER_SECRETS_FILE?.trim()
  || '/app/dist/server/.dev.vars';
if (!isAbsolute(source) || !isAbsolute(target) || resolve(source) === resolve(target)) {
  throw new Error('Worker config paths must be distinct absolute paths.');
}
if (
  !isAbsolute(secretsTarget)
  || dirname(resolve(source)) !== dirname(resolve(target))
  || dirname(resolve(source)) !== dirname(resolve(secretsTarget))
) {
  throw new Error('Runtime Worker config must stay beside the built config so relative paths remain valid.');
}

const publicNames = [
  'SITE_ORIGIN',
  'ERP_ALLOWED_ORIGINS',
  'PGPOOL_MAX',
  'PGSSL',
  'AUTH_TRUST_PROXY_HEADERS',
  'AUTH_EMAIL_TRANSPORT',
  'AUTH_MAILPIT_URL',
  'AUTH_MAILPIT_PUBLIC_URL',
  'AUTH_EMAIL_FROM',
  'AUTH_SMTP_MAILER_URL',
  'ERP_EMBEDDING_BASE_URL',
  'ERP_EMBEDDING_BATCH_SIZE',
  'ERP_EMBEDDING_TIMEOUT_MS',
  'ERP_EMBEDDING_KEEP_ALIVE',
  'HUB_SERVER_LOG_URL',
  'HUB_SERVER_LOG_TIMEOUT_MS',
  'EAT_CACHE_TTL_MINUTES',
];
const secretNames = [
  'DATABASE_URL',
  'PGSSL_CA',
  'AUTH_CODE_SECRET',
  'AUTH_SMTP_MAILER_TOKEN',
  'RESEND_API_KEY',
  'ERP_EMBEDDING_WORKER_TOKEN',
  'HUB_SERVER_LOG_SECRET',
  'EAT_API_SERVICE_KEY',
  'NEIS_API_KEY',
];

const parsed = JSON.parse(readFileSync(source, 'utf8'));
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  throw new Error('Built Wrangler config is invalid.');
}
const vars = parsed.vars && typeof parsed.vars === 'object' && !Array.isArray(parsed.vars)
  ? { ...parsed.vars }
  : {};
let bindingCount = 0;
for (const name of secretNames) delete vars[name];
for (const name of publicNames) {
  const value = process.env[name];
  if (!value) continue;
  if (value.includes('\0')) throw new Error(`${name} contains a null byte.`);
  vars[name] = value;
  bindingCount += 1;
}
parsed.vars = vars;
writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
chmodSync(target, 0o600);

const secretLines = [];
for (const name of secretNames) {
  const value = process.env[name];
  if (!value) continue;
  if (value.includes('\0')) throw new Error(`${name} contains a null byte.`);
  secretLines.push(`${name}=${JSON.stringify(value)}`);
}
writeFileSync(secretsTarget, `${secretLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
chmodSync(secretsTarget, 0o600);
console.log(JSON.stringify({
  service: 'starsnap-worker-config',
  publicBindings: bindingCount,
  secretBindings: secretLines.length,
}));
