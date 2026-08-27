import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const TEST_STATE_KEY = '__starsnapHubServerLogTestState';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pendingTasks = [];
const hubCalls = [];
const testState = {
  env: {},
  waitUntil(task) {
    pendingTasks.push(Promise.resolve(task));
  },
};

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
globalThis[TEST_STATE_KEY] = testState;

let viteServer;
let withHubServerLog;

function resetBindings(overrides = {}) {
  for (const key of Object.keys(testState.env)) {
    delete testState.env[key];
  }
  Object.assign(testState.env, {
    HUB_SERVER_LOG_URL: 'http://hub.internal/api/server-logs',
    HUB_SERVER_LOG_SECRET: 'test-hub-secret',
    HUB_SERVER_LOG_TIMEOUT_MS: '750',
    AUTH_TRUST_PROXY_HEADERS: 'true',
    ...overrides,
  });
}

async function settleScheduledTasks() {
  const currentTasks = pendingTasks.splice(0, pendingTasks.length);
  await Promise.all(currentTasks);
}

function recordedPayload(index = 0) {
  const [, init] = hubCalls[index];
  return JSON.parse(init.body);
}

before(async () => {
  viteServer = await createServer({
    root: projectRoot,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    plugins: [
      {
        name: 'hub-server-log-cloudflare-test-double',
        enforce: 'pre',
        resolveId(source) {
          return source === 'cloudflare:workers' ? '\0hub-server-log-cloudflare-test-double' : null;
        },
        load(id) {
          if (id !== '\0hub-server-log-cloudflare-test-double') return null;
          return `
            const state = globalThis.${TEST_STATE_KEY};
            export const env = state.env;
            export function waitUntil(task) { state.waitUntil(task); }
          `;
        },
      },
    ],
  });

  ({ withHubServerLog } = await viteServer.ssrLoadModule('/app/lib/hub-server-log.ts'));
});

beforeEach(() => {
  resetBindings();
  pendingTasks.length = 0;
  hubCalls.length = 0;
  console.warn = originalWarn;
  globalThis.fetch = async (url, init) => {
    hubCalls.push([url, init]);
    return new Response('{"created":true}', {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  await viteServer?.close();
  delete globalThis[TEST_STATE_KEY];
});

test('publishes only sanitized ERP request metadata', async () => {
  const response = new Response('{"ok":true}', {
    status: 201,
    headers: { 'Set-Cookie': 'session=must-not-leak' },
  });
  const wrapped = withHubServerLog(async () => response);
  const result = await wrapped(new Request(
    'https://erp.starsnap.kr/api/auth/login?page=2&password=hunter2&verification_code=123456&session_id=abc&api_key=secret',
    {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.9',
        Cookie: 'session=must-not-leak',
        'User-Agent': 'StarSnap ERP test',
      },
    },
  ));

  assert.strictEqual(result, response);
  await settleScheduledTasks();
  assert.equal(hubCalls.length, 1);

  const [url, init] = hubCalls[0];
  const payload = recordedPayload();
  const query = new URLSearchParams(payload.queryParams);
  const headers = new Headers(init.headers);

  assert.equal(String(url), 'http://hub.internal/api/server-logs');
  assert.equal(headers.get('X-Hub-Log-Secret'), 'test-hub-secret');
  assert.equal(payload.sourceService, 'starsnap-erp-web');
  assert.equal(payload.path, '/api/auth/login');
  assert.equal(payload.method, 'POST');
  assert.equal(payload.statusCode, '201');
  assert.equal(payload.success, true);
  assert.equal(payload.ipAddress, '203.0.113.9');
  assert.equal(payload.requestHeaders, '');
  assert.equal(payload.requestBody, '');
  assert.equal(payload.responseHeaders, '');
  assert.equal(payload.responseBody, '');
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('password'), 'REDACTED');
  assert.equal(query.get('verification_code'), 'REDACTED');
  assert.equal(query.get('session_id'), 'REDACTED');
  assert.equal(query.get('api_key'), 'REDACTED');
});

test('keeps the ERP response when Hub publishing fails', async () => {
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  globalThis.fetch = async () => {
    throw new TypeError('Hub is unavailable');
  };

  const response = new Response(null, { status: 202 });
  const wrapped = withHubServerLog(async () => response);
  const result = await wrapped(new Request('https://erp.starsnap.kr/api/erp', { method: 'POST' }));

  assert.strictEqual(result, response);
  await settleScheduledTasks();
  assert.equal(warnings.length, 1);
});

test('records status 500 and rethrows the original handler error', async () => {
  const failure = new Error('database failed');
  const wrapped = withHubServerLog(async () => {
    throw failure;
  });

  await assert.rejects(
    () => wrapped(new Request('https://erp.starsnap.kr/api/erp/products', { method: 'POST' })),
    (error) => error === failure,
  );
  await settleScheduledTasks();

  assert.equal(hubCalls.length, 1);
  const payload = recordedPayload();
  assert.equal(payload.statusCode, '500');
  assert.equal(payload.success, false);
});

test('does not publish the high-volume embedding drain route', async () => {
  const response = new Response('{"ok":true}', { status: 200 });
  const wrapped = withHubServerLog(async () => response);
  const result = await wrapped(new Request(
    'https://erp.starsnap.kr/api/internal/product-embeddings/drain',
    { method: 'POST' },
  ));

  assert.strictEqual(result, response);
  assert.equal(hubCalls.length, 0);
  assert.equal(pendingTasks.length, 0);
});
