import { env } from 'cloudflare:workers';

export const SESSION_COOKIE_NAME = 'starsnap_session';
export const SECURE_SESSION_COOKIE_NAME = '__Host-starsnap_session';

const MAX_AUTH_BODY_BYTES = 8 * 1024;

function setting(name: string) {
  return (env as unknown as Record<string, unknown>)[name];
}

function configuredSiteOrigin() {
  const value = authSetting('SITE_ORIGIN');
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function requestUsesHttps(request: Request) {
  return new URL(request.url).protocol === 'https:'
    || configuredSiteOrigin()?.startsWith('https://') === true;
}

function parseCookies(request: Request) {
  const values = new Map<string, string>();
  for (const item of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name && !values.has(name)) values.set(name, value);
  }
  return values;
}

export function sessionTokenFromRequest(request: Request) {
  const cookies = parseCookies(request);
  const token = requestUsesHttps(request)
    ? cookies.get(SECURE_SESSION_COOKIE_NAME) ?? null
    : cookies.get(SESSION_COOKIE_NAME) ?? null;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function sessionCookie(request: Request, token: string, maxAgeSeconds: number) {
  const secure = requestUsesHttps(request);
  const name = secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  return [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function expiredSessionCookies(request: Request) {
  const secure = requestUsesHttps(request);
  const names = secure
    ? [SECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME]
    : [SESSION_COOKIE_NAME];
  return names.map((name) => [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    name === SECURE_SESSION_COOKIE_NAME ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

export function authResponseHeaders() {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function appendSessionCookie(
  headers: Headers,
  request: Request,
  token: string,
  maxAgeSeconds: number,
) {
  headers.append('Set-Cookie', sessionCookie(request, token, maxAgeSeconds));
}

export function appendExpiredSessionCookies(headers: Headers, request: Request) {
  for (const cookie of expiredSessionCookies(request)) headers.append('Set-Cookie', cookie);
}

export function isStrictSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const suppliedOrigin = new URL(origin).origin;
    return suppliedOrigin === new URL(request.url).origin
      || suppliedOrigin === configuredSiteOrigin();
  } catch {
    return false;
  }
}

export function isLoopbackRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function clientRateLimitScope(request: Request) {
  // Forwarded client-IP headers are attacker-controlled unless a trusted edge
  // strips and overwrites them. Docker therefore ignores them by default.
  const trustProxyHeaders = authSetting('AUTH_TRUST_PROXY_HEADERS').toLowerCase() === 'true';
  const connectingIp = trustProxyHeaders
    ? request.headers.get('cf-connecting-ip')?.trim()
      || request.headers.get('x-real-ip')?.trim()
      || request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim()
      || 'unknown'
    : 'direct';
  const safeIp = /^[0-9a-f:.]{2,64}$/i.test(connectingIp) ? connectingIp.toLowerCase() : 'unknown';
  return safeIp;
}

export type SmallJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; message: string };

export async function readSmallJson(
  request: Request,
  maxBytes = MAX_AUTH_BODY_BYTES,
): Promise<SmallJsonResult> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { ok: false, status: 415, message: 'Content-Type은 application/json이어야 합니다.' };
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, message: '요청 본문이 너무 큽니다.' };
  }
  if (!request.body) return { ok: false, status: 400, message: 'JSON 요청 본문이 필요합니다.' };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('auth request body limit exceeded');
      return { ok: false, status: 413, message: '요청 본문이 너무 큽니다.' };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'JSON 요청 본문이 올바르지 않습니다.' };
  }
}

export function authSetting(name: string) {
  const value = setting(name);
  return typeof value === 'string' ? value.trim() : '';
}
