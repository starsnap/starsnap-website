const baseUrl = (process.argv[2] ?? process.env.ERP_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
if (!localHostnames.has(parsedBaseUrl.hostname) && process.env.ALLOW_REMOTE_SMOKE !== '1') {
  throw new Error(`Refusing non-local product search smoke target ${parsedBaseUrl.origin}; set ALLOW_REMOTE_SMOKE=1 to proceed.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, expectedStatus = 200) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  assert(response.status === expectedStatus, `${path}: expected ${expectedStatus}, received ${response.status} (${JSON.stringify(body)})`);
  return { body, elapsedMs };
}

function searchPath(tenant, query, mode, page = 1) {
  const parameters = new URLSearchParams({
    tenant,
    q: query,
    mode,
    category: 'ALL',
    status: 'ALL',
    page: String(page),
    pageSize: '50',
  });
  return `/api/erp/products/search?${parameters.toString()}`;
}

const health = await request('/api/health');
assert(health.body?.ok === true, 'health endpoint did not report ok');
assert(health.body?.schemaVersion === 8, `expected schema version 8, received ${health.body?.schemaVersion}`);
assert(health.body?.productSearch?.trigram?.available === true, 'pg_trgm is unavailable');
assert(health.body?.productSearch?.vector?.available === true, 'product vector search is unavailable');
assert(health.body?.productSearch?.vector?.dimension === 1024, 'unexpected product vector dimension');
assert(health.body?.productSearch?.vector?.provider === 'ollama', 'Ollama product embedding runtime is unavailable');
assert(
  health.body?.productSearch?.vector?.runtimeModel === 'bge-m3:567m-fp16',
  'unexpected Ollama product embedding model',
);
assert(health.body?.productSearch?.vector?.complete === true, 'product vector coverage is incomplete');
assert(health.body?.productSearch?.vector?.staleProducts === 0, 'stale product vectors remain');
assert(
  health.body?.productSearch?.vector?.indexedProducts === health.body?.productSearch?.vector?.totalProducts,
  'product vector count does not match the product catalog',
);

const erp = await request('/api/erp?tenant=HANBIT');
const products = Array.isArray(erp.body?.products) ? erp.body.products : [];
const productIds = new Set(products.map((product) => product.id));
const byName = new Map(products.map((product) => [product.name, product]));
assert(byName.has('냉동 닭정육'), 'HANBIT fixture 냉동 닭정육 is missing');
assert(byName.has('고등어 필렛'), 'HANBIT fixture 고등어 필렛 is missing');
assert(health.body.productSearch.vector.indexedProducts >= products.length, 'product vectors were not backfilled');

const exact = await request(searchPath('HANBIT', 'FD-0004', 'SMART'));
assert(exact.body?.mode === 'SMART', 'SMART search did not preserve its requested mode');
assert(exact.body?.executionMode === 'SMART', 'SMART search did not use its vector-enabled execution mode');
assert(exact.body?.vectorStatus === 'USED', 'SMART search did not report vector use');
assert(exact.body?.items?.[0]?.productId === byName.get('양파')?.id, 'exact SKU did not rank 양파 first');
assert(exact.body.items[0].product?.id === exact.body.items[0].productId, 'exact result omitted its product snapshot');
assert(exact.body.items[0].reason === 'EXACT_SKU', 'exact SKU reason is incorrect');

const exactPageTwo = await request(searchPath('HANBIT', 'FD-0004', 'SMART', 2));
assert(exactPageTwo.body?.total === exact.body.total, 'out-of-range page lost the real result total');
assert(exactPageTwo.body?.items?.length === 0, 'out-of-range exact search page should be empty');

const trigram = await request(searchPath('HANBIT', '고등어 필래', 'TRIGRAM'));
assert(trigram.body?.mode === 'TRIGRAM', 'TRIGRAM search did not preserve its requested mode');
assert(trigram.body?.executionMode === 'TRIGRAM', 'TRIGRAM search execution mode is incorrect');
assert(trigram.body?.vectorStatus === 'NOT_REQUESTED', 'TRIGRAM search unexpectedly requested a vector');
assert(trigram.body?.items?.some((item) => item.productId === byName.get('고등어 필렛')?.id), 'trigram typo search did not find 고등어 필렛');

const vector = await request(searchPath('HANBIT', '냉동 닭정유', 'VECTOR'));
assert(vector.body?.mode === 'VECTOR', 'VECTOR search did not preserve its requested mode');
assert(vector.body?.executionMode === 'VECTOR', 'VECTOR search execution mode is incorrect');
assert(vector.body?.vectorStatus === 'USED', 'VECTOR search did not report vector use');
assert(vector.body?.items?.some((item) => item.productId === byName.get('냉동 닭정육')?.id), 'vector typo search did not find 냉동 닭정육');

const semanticCases = [
  ['닭고기', '냉동 닭정육'],
  ['쌀', '백미'],
  ['콩으로 만든 식품', '두부'],
  ['생선', '고등어 필렛'],
];
const semanticTimings = {};
for (const [query, expectedName] of semanticCases) {
  const semantic = await request(searchPath('HANBIT', query, 'VECTOR'));
  assert(
    semantic.body?.items?.[0]?.productId === byName.get(expectedName)?.id,
    `semantic query ${query} did not rank ${expectedName} first`,
  );
  semanticTimings[query] = semantic.elapsedMs;
}

for (const result of [exact.body, trigram.body, vector.body]) {
  assert(result.items.every((item) => productIds.has(item.productId)), 'search returned a product from another tenant');
  assert(result.items.every((item) => item.product?.id === item.productId), 'search result product snapshot is inconsistent');
  assert(result.items.length <= 50, 'search page exceeded 50 rows');
}

const wildcard = await request(searchPath('HANBIT', '양%', 'TRIGRAM'));
const wildcardOnion = wildcard.body?.items?.find((item) => item.productId === byName.get('양파')?.id);
assert(wildcardOnion, 'accepted wildcard-escape query did not find the trigram fixture');
assert(wildcardOnion.reason !== 'CONTAINS', 'percent sign was treated as a LIKE wildcard');

await request(`${searchPath('HANBIT', '양파', 'SMART').replace('mode=SMART', 'mode=INVALID')}`, 400);
await request(searchPath('HANBIT', '%_\\', 'SMART'), 400);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  schemaVersion: health.body.schemaVersion,
  indexedProducts: health.body.productSearch.vector.indexedProducts,
  timingsMs: {
    health: health.elapsedMs,
    exact: exact.elapsedMs,
    trigram: trigram.elapsedMs,
    vector: vector.elapsedMs,
    semantic: semanticTimings,
  },
}, null, 2));
