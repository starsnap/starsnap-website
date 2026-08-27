import { env } from 'cloudflare:workers';
import { authorizeSessionTenant, readAuthSession } from '@/db/auth-repository';
import type { AuthRole } from './auth-types';
import type { TenantCode } from './erp-types';
import { isStrictSameOrigin, sessionTokenFromRequest } from './auth-http';

export interface RequestIdentity {
  userId: string;
  actor: string;
  email: string;
  role: AuthRole;
  tenantId: string;
}

function setting(name: string) {
  return (env as unknown as Record<string, unknown>)[name];
}

export function isAllowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return request.method === 'GET' || request.method === 'HEAD';

  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.origin === requestUrl.origin) return true;

    // Session-bearing mutations are intentionally same-origin. The configured
    // allowlist is retained only for read-only requests and preflight checks.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return isStrictSameOrigin(request);
    }

    const configured = String(setting('ERP_ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return configured.includes(originUrl.origin);
  } catch {
    return false;
  }
}

export async function authenticateRequest(request: Request) {
  const token = sessionTokenFromRequest(request);
  if (!token) return { ok: false as const, status: 401, message: '로그인이 필요합니다.' };
  try {
    const session = await readAuthSession(token);
    return session
      ? { ok: true as const }
      : { ok: false as const, status: 401, message: '로그인이 필요합니다.' };
  } catch (error) {
    console.error('Authentication preflight failed', error);
    return { ok: false as const, status: 503, message: '로그인 상태를 확인할 수 없습니다.' };
  }
}

export async function authorizeTenant(request: Request, tenant: TenantCode, mutation = false) {
  const token = sessionTokenFromRequest(request);
  if (!token) return { ok: false as const, status: 401, message: '로그인이 필요합니다.' };

  const access = await authorizeSessionTenant(token, tenant);
  if (!access) return { ok: false as const, status: 401, message: '로그인이 필요합니다.' };
  if (!access.role || !access.tenantId) {
    return { ok: false as const, status: 403, message: '이 회사 데이터에 접근할 권한이 없습니다.' };
  }
  if (mutation && access.role === 'viewer') {
    return { ok: false as const, status: 403, message: '조회 전용 계정은 업무를 변경할 수 없습니다.' };
  }
  return {
    ok: true as const,
    identity: {
      userId: access.userId,
      actor: access.username,
      email: access.email,
      role: access.role,
      tenantId: access.tenantId,
    } satisfies RequestIdentity,
  };
}
