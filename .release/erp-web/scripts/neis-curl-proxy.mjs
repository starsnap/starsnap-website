import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const listenHost = '127.0.0.1';
const listenPort = Number(process.env.NEIS_CURL_PROXY_PORT ?? '3001');
const curlExecutable = process.env.NEIS_CURL_BIN?.trim() || '/usr/bin/curl';
const endpoint = 'https://open.neis.go.kr/hub/mealServiceDietInfo';
const maximumBodyBytes = 8_192;
const maximumResponseBytes = 2_000_000;
const maximumConcurrentRequests = 4;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const codePattern = /^[A-Za-z0-9._-]{1,32}$/;

function configuredKey() {
  const value = process.env.NEIS_API_KEY?.trim() ?? '';
  if (!value) throw new Error('NEIS_API_KEY is required.');
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('NEIS_API_KEY contains invalid percent encoding.');
  }
}

function dateNumber(value) {
  if (!isoDatePattern.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? timestamp
    : null;
}

export function parseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const officeCode = typeof value.officeCode === 'string' ? value.officeCode.trim() : '';
  const schoolCode = typeof value.schoolCode === 'string' ? value.schoolCode.trim() : '';
  const fromDate = typeof value.fromDate === 'string' ? value.fromDate.trim() : '';
  const toDate = typeof value.toDate === 'string' ? value.toDate.trim() : '';
  const from = dateNumber(fromDate);
  const to = dateNumber(toDate);
  if (!codePattern.test(officeCode) || !codePattern.test(schoolCode) || from === null || to === null) return null;
  const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
  if (inclusiveDays < 1 || inclusiveDays > 31) return null;
  return { officeCode, schoolCode, fromDate, toDate };
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': Buffer.byteLength(encoded),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBodyBytes) throw new RangeError('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function buildCurlArgs(query) {
  return [
    '--disable',
    '--silent',
    '--show-error',
    '--fail-with-body',
    '--proto', '=https',
    '--connect-timeout', '3',
    '--max-time', '8',
    '--max-redirs', '0',
    '--get', endpoint,
    '--data-urlencode', 'KEY@-',
    '--data-urlencode', 'Type=json',
    '--data-urlencode', 'pIndex=1',
    '--data-urlencode', 'pSize=100',
    '--data-urlencode', `ATPT_OFCDC_SC_CODE=${query.officeCode}`,
    '--data-urlencode', `SD_SCHUL_CODE=${query.schoolCode}`,
    '--data-urlencode', `MLSV_FROM_YMD=${query.fromDate.replaceAll('-', '')}`,
    '--data-urlencode', `MLSV_TO_YMD=${query.toDate.replaceAll('-', '')}`,
  ];
}

function runCurl(args, key, signal) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NEIS_API_KEY;
    const child = spawn(curlExecutable, args, {
      env: childEnvironment,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let errorBytes = 0;
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    child.once('error', error => finish(error));
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maximumResponseBytes) {
        child.kill('SIGKILL');
        finish(new RangeError('NEIS response exceeded proxy limit.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errorBytes < 8_192) stderr.push(chunk);
      errorBytes += chunk.length;
    });
    child.once('close', (code, terminationSignal) => {
      if (code === 0) {
        finish(null, Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const error = new Error('curl request failed.');
      error.code = code ?? 'UNKNOWN';
      error.killed = Boolean(terminationSignal);
      finish(error);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(key);
  });
}

async function fetchMeals(query, key, signal) {
  const args = buildCurlArgs(query);
  const stdout = await runCurl(args, key, signal);
  const parsed = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('NEIS response is not an object.');
  }
  return JSON.stringify(parsed);
}

export function startProxy() {
  const key = configuredKey();
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error('NEIS_CURL_PROXY_PORT is invalid.');
  }
  let activeRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/meal-service-diet-info') {
      sendJson(response, 404, { message: 'Not found.' });
      return;
    }
    if (activeRequests >= maximumConcurrentRequests) {
      sendJson(response, 503, { message: 'NEIS proxy is busy.' });
      return;
    }
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    activeRequests += 1;
    try {
      const query = parseRequest(await readJson(request));
      if (!query) {
        sendJson(response, 400, { message: 'Invalid NEIS meal query.' });
        return;
      }
      const body = await fetchMeals(query, key, controller.signal);
      response.writeHead(200, {
        'Cache-Control': 'no-store, max-age=0',
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      const timeout = Boolean(
        error && typeof error === 'object'
        && (('killed' in error && error.killed) || ('name' in error && error.name === 'AbortError'))
      );
      console.error('NEIS curl proxy request failed', {
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN',
        timeout,
      });
      sendJson(response, timeout ? 504 : 502, { message: 'NEIS upstream request failed.' });
    } finally {
      activeRequests -= 1;
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.listen(listenPort, listenHost, () => {
    console.log(JSON.stringify({ service: 'neis-curl-proxy', host: listenHost, port: listenPort }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startProxy();
