import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const DEFAULT_ENDPOINT = 'http://web:3000/api/internal/product-embeddings/drain';
const DEFAULT_TOKEN_FILE = '/run/starsnap-secrets/embedding-worker-token';
const DEFAULT_LIMIT = 500;
const DEFAULT_POLL_MS = 1_000;
const IDLE_LOG_INTERVAL_MS = 30_000;
const SERVER_MAX_BATCH_SIZE = 128;

function boundedInteger(name, fallback, minimum, maximum) {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function configuredEndpoint() {
  const configured = process.env.ERP_EMBEDDING_WORKER_URL?.trim() || DEFAULT_ENDPOINT;
  const endpoint = new URL(configured);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('ERP_EMBEDDING_WORKER_URL must be an HTTP(S) URL without embedded credentials.');
  }
  return endpoint.toString();
}

function configuredToken() {
  const direct = process.env.ERP_EMBEDDING_WORKER_TOKEN?.trim();
  const token = direct || readFileSync(
    process.env.ERP_EMBEDDING_WORKER_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE,
    'utf8',
  ).trim();
  if (token.length < 32) throw new Error('ERP embedding worker token must contain at least 32 characters.');
  return token;
}

function countFrom(payload, names) {
  const containers = [payload, payload?.result, payload?.summary, payload?.stats]
    .filter((candidate) => candidate && typeof candidate === 'object');
  for (const container of containers) {
    for (const name of names) {
      const value = Number(container[name]);
      if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    }
  }
  return 0;
}

function normalizedDrainResult(payload) {
  const claimed = countFrom(payload, ['claimed', 'claimedCount']);
  const vectorized = countFrom(payload, ['vectorized', 'embedded', 'generated', 'vectorizedCount']);
  const reused = countFrom(payload, ['reused', 'reusedCount']);
  const skipped = countFrom(payload, ['skipped', 'superseded', 'stale', 'skippedCount']);
  const completed = countFrom(payload, ['completed', 'completedCount']);
  const requeued = countFrom(payload, ['requeued', 'requeuedCount']);
  const retrying = countFrom(payload, ['retrying', 'retryingCount']);
  const exhausted = countFrom(payload, ['exhausted', 'exhaustedCount']);
  const failed = countFrom(payload, ['failed', 'failedCount']) || exhausted;
  const reportedProcessed = countFrom(payload, ['processed', 'processedCount']);
  const processed = reportedProcessed
    || completed + requeued + retrying + exhausted
    || vectorized + reused + skipped;
  const pending = countFrom(payload, ['pending', 'remaining', 'queued', 'pendingCount']);
  const hasMore = Boolean(payload?.hasMore ?? payload?.result?.hasMore ?? payload?.summary?.hasMore);
  return {
    claimed,
    processed,
    vectorized,
    reused,
    skipped,
    completed,
    requeued,
    retrying,
    exhausted,
    failed,
    pending,
    hasMore,
  };
}

function log(event, detail = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'product-embedding-worker',
    event,
    workerId,
    ...detail,
  }));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const endpoint = configuredEndpoint();
const token = configuredToken();
const configuredWorkerId = process.env.ERP_EMBEDDING_WORKER_ID?.normalize('NFKC').trim();
const workerId = configuredWorkerId || `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
if (workerId.length > 128) {
  throw new Error('ERP_EMBEDDING_WORKER_ID must contain at most 128 characters.');
}
const limit = boundedInteger('ERP_EMBEDDING_WORKER_LIMIT', DEFAULT_LIMIT, 1, 10_000);
const pollMs = boundedInteger('ERP_EMBEDDING_WORKER_POLL_MS', DEFAULT_POLL_MS, 100, 60_000);
const embeddingBatchSize = boundedInteger('ERP_EMBEDDING_BATCH_SIZE', 128, 1, 512);
const embeddingTimeoutMs = boundedInteger('ERP_EMBEDDING_TIMEOUT_MS', 120_000, 1_000, 600_000);
const embeddingCallsPerDrain = Math.ceil(Math.min(limit, SERVER_MAX_BATCH_SIZE) / embeddingBatchSize);
// One tags probe + up to three attempts per internal embedding batch + one
// minute for JSON and fenced DB persistence.
const derivedRequestTimeoutMs = embeddingTimeoutMs * (1 + 3 * embeddingCallsPerDrain) + 60_000;
const timeoutMs = boundedInteger(
  'ERP_EMBEDDING_WORKER_TIMEOUT_MS',
  derivedRequestTimeoutMs,
  1_000,
  604_800_000,
);
if (timeoutMs < derivedRequestTimeoutMs) {
  throw new Error(
    `ERP_EMBEDDING_WORKER_TIMEOUT_MS must be at least ${derivedRequestTimeoutMs}ms for the configured embedding budget.`,
  );
}

let stopping = false;
let activeController = null;
let interruptSleep = null;
let consecutiveFailures = 0;
let lastLogAt = 0;
const totals = {
  calls: 0,
  claimed: 0,
  processed: 0,
  vectorized: 0,
  reused: 0,
  skipped: 0,
  completed: 0,
  requeued: 0,
  retrying: 0,
  exhausted: 0,
  failed: 0,
  requestFailures: 0,
};
const startedAt = Date.now();

function stop(signal) {
  if (stopping) return;
  stopping = true;
  log('shutdown-requested', { signal });
  activeController?.abort(new Error(`Worker received ${signal}.`));
  interruptSleep?.();
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

function sleep(milliseconds) {
  if (stopping || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      interruptSleep = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    interruptSleep = finish;
  });
}

async function drain() {
  const controller = new AbortController();
  activeController = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Drain request exceeded ${timeoutMs}ms.`));
  }, timeoutMs);
  const requestStartedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workerId, limit }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = {};
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        throw new Error(`Drain endpoint returned invalid JSON (${response.status}).`, { cause: error });
      }
    }
    if (!response.ok || payload?.ok === false) {
      const message = typeof payload?.message === 'string'
        ? payload.message.slice(0, 300)
        : `HTTP ${response.status}`;
      throw new Error(`Drain request failed: ${message}`);
    }
    return {
      ...normalizedDrainResult(payload),
      durationMs: Date.now() - requestStartedAt,
    };
  } catch (error) {
    if (timedOut) throw new Error(`Drain request timed out after ${timeoutMs}ms.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) activeController = null;
  }
}

function record(result) {
  totals.calls += 1;
  totals.claimed += result.claimed;
  totals.processed += result.processed;
  totals.vectorized += result.vectorized;
  totals.reused += result.reused;
  totals.skipped += result.skipped;
  totals.completed += result.completed;
  totals.requeued += result.requeued;
  totals.retrying += result.retrying;
  totals.exhausted += result.exhausted;
  totals.failed += result.failed;
}

async function main() {
  log('started', { endpoint, limit, pollMs, timeoutMs });

  while (!stopping) {
    try {
      const result = await drain();
      record(result);
      const now = Date.now();
      if (result.claimed > 0 || result.processed > 0 || now - lastLogAt >= IDLE_LOG_INTERVAL_MS) {
        log('drain-summary', { ...result, totals: { ...totals } });
        lastLogAt = now;
      }

      // A successful HTTP response can still mean that Ollama work was put
      // back on the durable retry queue. Back off here so an unavailable GPU
      // cannot burn through every job's retry budget in a tight loop.
      if (result.retrying > 0 || result.exhausted > 0) {
        consecutiveFailures += 1;
        const retryMs = Math.min(30_000, pollMs * (2 ** Math.min(consecutiveFailures - 1, 5)));
        log('drain-deferred', {
          retrying: result.retrying,
          exhausted: result.exhausted,
          consecutiveFailures,
          retryMs,
          totals: { ...totals },
        });
        await sleep(retryMs);
        continue;
      }
      consecutiveFailures = 0;

      // The API may clamp a requested limit to its GPU-safe batch size. Any
      // claimed work therefore triggers an immediate next drain; one final
      // empty response returns the loop to its configured idle poll cadence.
      const shouldDrainAgain = result.claimed > 0
        || (result.hasMore && result.processed > 0);
      if (!shouldDrainAgain) await sleep(pollMs);
    } catch (error) {
      if (stopping) break;
      consecutiveFailures += 1;
      totals.requestFailures += 1;
      const retryMs = Math.min(30_000, pollMs * (2 ** Math.min(consecutiveFailures - 1, 5)));
      log('drain-error', {
        message: errorMessage(error),
        consecutiveFailures,
        retryMs,
        totals: { ...totals },
      });
      await sleep(retryMs);
    }
  }

  log('stopped', { uptimeMs: Date.now() - startedAt, totals: { ...totals } });
}

main().catch((error) => {
  log('fatal-error', { message: errorMessage(error), totals: { ...totals } });
  process.exitCode = 1;
});
