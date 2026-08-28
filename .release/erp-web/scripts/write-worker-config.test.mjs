import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writerPath = path.join(projectRoot, 'scripts', 'write-worker-config.mjs');

function runWriter(env) {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (
      name === 'SITE_ORIGIN'
      || name === 'DATABASE_URL'
      || name === 'PGSSL'
      || name === 'PGSSL_CA'
      || name === 'PGPOOL_MAX'
      || name === 'RESEND_API_KEY'
      || name.startsWith('AUTH_')
      || name.startsWith('ERP_')
      || name.startsWith('HUB_SERVER_LOG_')
      || name.startsWith('EAT_')
      || name.startsWith('NEIS_')
      || name.startsWith('STARSNAP_WORKER_')
    ) delete childEnv[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath], {
      env: { ...childEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`writer exited ${code}: ${stderr}`));
    });
  });
}

test('propagates public bindings and keeps Hub, eAT, and NEIS secrets out of Wrangler vars', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starsnap-worker-config-'));
  const source = path.join(directory, 'wrangler.json');
  const target = path.join(directory, 'wrangler.runtime.json');
  const secretsTarget = path.join(directory, '.dev.vars');
  const secret = 'test-only-hub-secret';
  const eatSecret = 'test-only-eat-service-key';
  const neisSecret = 'test-only-neis-api-key';

  try {
    await writeFile(source, JSON.stringify({
      name: 'starsnap-erp-web',
      vars: {
        SITE_ORIGIN: 'https://erp.starsnap.kr',
        HUB_SERVER_LOG_SECRET: 'stale-secret-must-be-removed',
        EAT_API_SERVICE_KEY: 'stale-eat-secret-must-be-removed',
        NEIS_API_KEY: 'stale-neis-secret-must-be-removed',
      },
    }));

    const output = await runWriter({
      STARSNAP_WORKER_SOURCE_CONFIG: source,
      STARSNAP_WORKER_CONFIG_FILE: target,
      STARSNAP_WORKER_SECRETS_FILE: secretsTarget,
      HUB_SERVER_LOG_URL: 'http://hub.internal:8081/api/server-logs',
      HUB_SERVER_LOG_TIMEOUT_MS: '750',
      HUB_SERVER_LOG_SECRET: secret,
      EAT_CACHE_TTL_MINUTES: '360',
      EAT_API_SERVICE_KEY: eatSecret,
      NEIS_API_KEY: neisSecret,
    });

    const runtimeConfigText = await readFile(target, 'utf8');
    const runtimeConfig = JSON.parse(runtimeConfigText);
    const secretsText = await readFile(secretsTarget, 'utf8');

    assert.equal(runtimeConfig.vars.HUB_SERVER_LOG_URL, 'http://hub.internal:8081/api/server-logs');
    assert.equal(runtimeConfig.vars.HUB_SERVER_LOG_TIMEOUT_MS, '750');
    assert.equal(runtimeConfig.vars.EAT_CACHE_TTL_MINUTES, '360');
    assert.equal(runtimeConfig.vars.SITE_ORIGIN, 'https://erp.starsnap.kr');
    assert.equal(runtimeConfig.vars.HUB_SERVER_LOG_SECRET, undefined);
    assert.equal(runtimeConfig.vars.EAT_API_SERVICE_KEY, undefined);
    assert.equal(runtimeConfig.vars.NEIS_API_KEY, undefined);
    assert.equal(runtimeConfigText.includes(secret), false);
    assert.equal(runtimeConfigText.includes(eatSecret), false);
    assert.equal(runtimeConfigText.includes(neisSecret), false);
    assert.equal(secretsText, [
      `HUB_SERVER_LOG_SECRET=${JSON.stringify(secret)}`,
      `EAT_API_SERVICE_KEY=${JSON.stringify(eatSecret)}`,
      `NEIS_API_KEY=${JSON.stringify(neisSecret)}`,
      '',
    ].join('\n'));
    assert.deepEqual(JSON.parse(output), {
      service: 'starsnap-worker-config',
      publicBindings: 3,
      secretBindings: 3,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
