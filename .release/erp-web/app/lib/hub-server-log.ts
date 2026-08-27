import { env, waitUntil } from 'cloudflare:workers';

const SOURCE_SERVICE = 'starsnap-erp-web';
const DEFAULT_TIMEOUT_MS = 750;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5_000;
const MAX_PATH_LENGTH = 255;
const MAX_QUERY_LENGTH = 2_000;
const MAX_USER_AGENT_LENGTH = 1_000;
const FALLBACK_IP_ADDRESS = '127.0.0.1';
const REDACTED_QUERY_VALUE = 'REDACTED';

// The embedding worker polls this private route every second. Forwarding those
// polls would add more than 86,000 low-value Hub rows per day.
const HIGH_VOLUME_EXCLUDED_PATHS = new Set([
  '/api/internal/product-embeddings/drain',
]);

const SENSITIVE_QUERY_KEY_FRAGMENTS = [
  'password',
  'passcode',
  'code',
  'verificationcode',
  'verifycode',
  'emailcode',
  'authcode',
  'onetimecode',
  'otp',
  'token',
  'secret',
  'credential',
  'signature',
  'authorization',
  'cookie',
  'session',
  'apikey',
  'accesskey',
];

interface HubBindings {
  HUB_SERVER_LOG_URL?: string;
  HUB_SERVER_LOG_TIMEOUT_MS?: string;
  HUB_SERVER_LOG_SECRET?: string;
  AUTH_TRUST_PROXY_HEADERS?: string;
}

interface HubServerLogConfig {
  url: string;
  timeoutMs: number;
  secret: string;
}

interface HubServerLogPayload {
  sourceService: string;
  path: string;
  method: string;
  statusCode: string;
  success: boolean;
  ipAddress: string;
  responseTimeMs: number;
  requestedAt: string;
  userAgent: string | null;
  requestHeaders: string;
  requestBody: string;
  responseHeaders: string;
  responseBody: string;
  queryParams: string | null;
}

type ApiRouteHandler = (request: Request) => Response | Promise<Response>;

function bindings(): HubBindings {
  return env as unknown as HubBindings;
}

function configuredTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)));
}

function hubServerLogConfig(): HubServerLogConfig | null {
  const currentBindings = bindings();
  const url = currentBindings.HUB_SERVER_LOG_URL?.trim() ?? '';
  const secret = currentBindings.HUB_SERVER_LOG_SECRET?.trim() ?? '';
  if (!url || !secret) return null;
  return {
    url,
    timeoutMs: configuredTimeoutMs(currentBindings.HUB_SERVER_LOG_TIMEOUT_MS),
    secret,
  };
}

function proxyHeadersAreTrusted(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (bindings().AUTH_TRUST_PROXY_HEADERS ?? '').trim().toLowerCase(),
  );
}

function normalizeIpv4(value: string | null): string {
  if (!value) return FALLBACK_IP_ADDRESS;
  const trimmed = value.trim();
  const candidate = trimmed.includes(':') ? (trimmed.split(':').at(-1) ?? trimmed) : trimmed;
  const parts = candidate.split('.');
  if (
    parts.length !== 4
    || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    return FALLBACK_IP_ADDRESS;
  }
  return parts.map((part) => String(Number(part))).join('.');
}

function trustedClientIp(request: Request): string {
  if (!proxyHeadersAreTrusted()) return FALLBACK_IP_ADDRESS;
  const forwardedFor = request.headers.get('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .find(Boolean);
  return normalizeIpv4(
    request.headers.get('cf-connecting-ip')
      ?? request.headers.get('x-real-ip')
      ?? forwardedFor
      ?? null,
  );
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_QUERY_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redactedQueryParams(url: URL): string | null {
  const result = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    result.append(key, isSensitiveQueryKey(key) ? REDACTED_QUERY_VALUE : value);
  });
  const serialized = result.toString();
  return serialized ? serialized.slice(0, MAX_QUERY_LENGTH) : null;
}

function sanitizedUserAgent(request: Request): string | null {
  const value = request.headers.get('user-agent')
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, MAX_USER_AGENT_LENGTH)
    .trim();
  return value || null;
}

function createPayload(
  request: Request,
  statusCode: number,
  requestedAt: Date,
  startedAtMs: number,
): HubServerLogPayload {
  const url = new URL(request.url);
  return {
    sourceService: SOURCE_SERVICE,
    path: (url.pathname || '/').slice(0, MAX_PATH_LENGTH),
    method: request.method.toUpperCase(),
    statusCode: String(statusCode),
    success: statusCode >= 200 && statusCode < 400,
    ipAddress: trustedClientIp(request),
    responseTimeMs: Math.max(0, Number((performance.now() - startedAtMs).toFixed(3))),
    requestedAt: requestedAt.toISOString(),
    userAgent: sanitizedUserAgent(request),
    requestHeaders: '',
    requestBody: '',
    responseHeaders: '',
    responseBody: '',
    queryParams: redactedQueryParams(url),
  };
}

async function publishServerLog(config: HubServerLogConfig, payload: HubServerLogPayload): Promise<void> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Server-Log': 'true',
        'X-Hub-Log-Secret': config.secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      console.warn(`[hub-server-log] Hub rejected metadata with status ${response.status}`);
    }
  } catch (error) {
    console.warn(
      '[hub-server-log] Metadata forwarding failed',
      error instanceof Error ? error.name : 'UnknownError',
    );
  }
}

function scheduleServerLog(config: HubServerLogConfig, payload: HubServerLogPayload): void {
  const task = publishServerLog(config, payload);
  try {
    waitUntil(task);
  } catch {
    // The request context should provide waitUntil. The task is already
    // fail-open, so a local runtime without context may still finish it.
    void task;
  }
}

export function withHubServerLog(handler: ApiRouteHandler): ApiRouteHandler {
  return async function hubLoggedRoute(request: Request): Promise<Response> {
    const config = hubServerLogConfig();
    const url = new URL(request.url);
    if (!config || HIGH_VOLUME_EXCLUDED_PATHS.has(url.pathname)) {
      return handler(request);
    }

    const requestedAt = new Date();
    const startedAtMs = performance.now();
    try {
      const response = await handler(request);
      scheduleServerLog(config, createPayload(request, response.status, requestedAt, startedAtMs));
      return response;
    } catch (error) {
      scheduleServerLog(config, createPayload(request, 500, requestedAt, startedAtMs));
      throw error;
    }
  };
}
