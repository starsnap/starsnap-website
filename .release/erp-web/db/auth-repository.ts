import type { PoolClient } from 'pg';
import type { AuthRole, AuthSession } from '@/app/lib/auth-types';
import type { TenantSummary } from '@/app/lib/erp-types';
import { authSetting } from '@/app/lib/auth-http';
import { ensureDatabase } from './bootstrap';
import {
  burnPasswordVerification,
  constantTimeEqual,
  createEmailCode,
  createSessionToken,
  createVerificationToken,
  hashEmailCode,
  hashOpaqueToken,
  hashPassword,
  hashRateLimitScope,
  verifyPassword,
} from './auth-crypto';
import {
  queryAll,
  queryOne,
  type SqlExecutor,
  withAdvisoryLock,
  withTransaction,
} from './postgres';

const EMAIL_CODE_TTL_SECONDS = 10 * 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_SECONDS = 60;
const EMAIL_TAKEN_MESSAGE = '이미 가입된 이메일입니다. 로그인하거나 다른 이메일을 입력해 주세요.';
export const AUTH_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export class AuthConfigurationError extends Error {}

interface RateLimitRow {
  attemptCount: number;
  retryAt: string;
}

interface UserCredentialRow {
  id: string;
  username: string;
  passwordHash: string;
  email: string;
  status: 'ACTIVE' | 'LOCKED' | 'DISABLED';
}

interface SessionUserRow {
  id: string;
  username: string;
  email: string;
  expiresAt: string;
}

interface MembershipRow {
  role: AuthRole;
  id: string;
  code: string;
  name: string;
  brandColor: string;
  organizationType: TenantSummary['organizationType'];
}

interface ChallengeRow {
  id: string;
  emailNormalized: string;
  codeMac: string;
  attemptCount: number;
  expiresAt: string;
  verifiedAt: string | null;
}

interface TenantAccessRow {
  userId: string;
  username: string;
  email: string;
  role: AuthRole | null;
  tenantId: string | null;
}

export type AuthFailureCode =
  | 'RATE_LIMITED'
  | 'USERNAME_TAKEN'
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'VERIFICATION_REQUIRED';

export type AuthResult<T> =
  | ({ ok: true } & T)
  | {
    ok: false;
    code: AuthFailureCode;
    message: string;
    retryAfter?: number;
  };

function codeSecret() {
  const value = authSetting('AUTH_CODE_SECRET');
  if (value.length < 32) {
    throw new AuthConfigurationError('AUTH_CODE_SECRET은 32자 이상의 비밀값이어야 합니다.');
  }
  return value;
}

function iso(value: string | Date) {
  return new Date(value).toISOString();
}

function retryAfterSeconds(value: string | Date) {
  return Math.max(1, Math.ceil((new Date(value).getTime() - Date.now()) / 1000));
}

async function consumeRateLimit(
  action: string,
  scopeHash: string,
  windowSeconds: number,
  maximum: number,
  executor?: SqlExecutor,
) {
  const row = await queryOne<RateLimitRow>(
    `INSERT INTO auth_rate_limits (action, scope_hash, window_started_at, attempt_count)
     VALUES ($1, $2, clock_timestamp(), 1)
     ON CONFLICT (action, scope_hash) DO UPDATE SET
       attempt_count = CASE
         WHEN auth_rate_limits.window_started_at <= clock_timestamp() - make_interval(secs => $3::double precision)
           THEN 1
         ELSE auth_rate_limits.attempt_count + 1
       END,
       window_started_at = CASE
         WHEN auth_rate_limits.window_started_at <= clock_timestamp() - make_interval(secs => $3::double precision)
           THEN clock_timestamp()
         ELSE auth_rate_limits.window_started_at
       END
     RETURNING attempt_count AS "attemptCount",
       (window_started_at + make_interval(secs => $3::double precision))::text AS "retryAt"`,
    [action, scopeHash, windowSeconds],
    executor,
  );
  if (!row) throw new Error('인증 요청 제한 상태를 확인할 수 없습니다.');
  return {
    allowed: Number(row.attemptCount) <= maximum,
    retryAfter: retryAfterSeconds(row.retryAt),
  };
}

function rateLimited(retryAfter: number): AuthResult<never> {
  return {
    ok: false,
    code: 'RATE_LIMITED',
    message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    retryAfter,
  };
}

function hexBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return new Uint8Array();
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function codeMacMatches(left: string, right: string) {
  return constantTimeEqual(hexBytes(left), hexBytes(right));
}

export function withEmailRegistrationLock<T>(email: string, callback: () => Promise<T>) {
  return withAdvisoryLock(`starsnap-auth-email:${email}`, callback);
}

async function membershipsForUser(userId: string, executor?: SqlExecutor) {
  const rows = await queryAll<MembershipRow>(
    `SELECT tm.role, t.id, t.code, t.name, t.brand_color AS "brandColor",
       t.organization_type AS "organizationType"
     FROM tenant_memberships tm
     JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'ACTIVE'
     WHERE tm.user_id = $1
     ORDER BY t.name, t.code`,
    [userId],
    executor,
  );
  return rows.map((row) => ({
    role: row.role,
    tenant: {
      id: row.id,
      code: row.code as TenantSummary['code'],
      name: row.name,
      brandColor: row.brandColor,
      organizationType: row.organizationType,
    },
  }));
}

async function insertSession(client: PoolClient, userId: string) {
  const token = createSessionToken();
  const tokenHash = await hashOpaqueToken(token);
  const row = await queryOne<{ expiresAt: string }>(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3::double precision))
     RETURNING expires_at::text AS "expiresAt"`,
    [tokenHash, userId, AUTH_SESSION_MAX_AGE_SECONDS],
    client,
  );
  if (!row) throw new Error('로그인 세션을 만들 수 없습니다.');
  await client.query(
    `DELETE FROM auth_sessions
     WHERE user_id = $1 AND expires_at <= clock_timestamp()`,
    [userId],
  );
  return { token, expiresAt: iso(row.expiresAt) };
}

export async function checkUsernameAvailability(
  normalizedUsername: string,
  clientScope: string,
): Promise<AuthResult<{ available: boolean }>> {
  await ensureDatabase();
  const scopeHash = await hashRateLimitScope(`username-check:${clientScope}`);
  const limit = await consumeRateLimit('username-check', scopeHash, 60, 60);
  if (!limit.allowed) return rateLimited(limit.retryAfter);
  const existing = await queryOne<{ found: boolean }>(
    'SELECT TRUE AS found FROM erp_users WHERE username_normalized = $1',
    [normalizedUsername],
  );
  return { ok: true, available: !existing };
}

export async function beginEmailVerification(
  email: string,
  clientScope: string,
): Promise<AuthResult<{ challengeId: string; code: string; expiresAt: string }>> {
  await ensureDatabase();
  const clientHash = await hashRateLimitScope(`email-send-client:${clientScope}`);
  const emailHash = await hashRateLimitScope(`email-send-address:${email}`);

  return withTransaction(async (client) => {
    const clientLimit = await consumeRateLimit('email-send-client', clientHash, 10 * 60, 10, client);
    if (!clientLimit.allowed) return rateLimited(clientLimit.retryAfter);
    const emailLimit = await consumeRateLimit('email-send-address', emailHash, 10 * 60, 3, client);
    if (!emailLimit.allowed) return rateLimited(emailLimit.retryAfter);

    const existingUser = await queryOne<{ found: boolean }>(
      'SELECT TRUE AS found FROM erp_users WHERE email_normalized = $1',
      [email],
      client,
    );
    if (existingUser) {
      return { ok: false, code: 'EMAIL_TAKEN', message: EMAIL_TAKEN_MESSAGE };
    }

    const recent = await queryOne<{ retryAt: string }>(
      `SELECT (created_at + make_interval(secs => $2::double precision))::text AS "retryAt"
       FROM email_verification_challenges
       WHERE email_normalized = $1
         AND created_at > clock_timestamp() - make_interval(secs => $2::double precision)
       ORDER BY created_at DESC LIMIT 1`,
      [email, EMAIL_RESEND_SECONDS],
      client,
    );
    if (recent) return rateLimited(retryAfterSeconds(recent.retryAt));

    const secret = codeSecret();
    const challengeId = crypto.randomUUID();
    const code = createEmailCode();
    const codeMac = await hashEmailCode(secret, challengeId, email, code);
    const inserted = await queryOne<{ expiresAt: string }>(
      `INSERT INTO email_verification_challenges
        (id, email_normalized, code_mac, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4::double precision))
       RETURNING expires_at::text AS "expiresAt"`,
      [challengeId, email, codeMac, EMAIL_CODE_TTL_SECONDS],
      client,
    );
    if (!inserted) throw new Error('이메일 인증 요청을 저장할 수 없습니다.');
    return { ok: true, challengeId, code, expiresAt: iso(inserted.expiresAt) };
  });
}

export async function cancelEmailVerification(challengeId: string) {
  await ensureDatabase();
  await queryOne(
    `DELETE FROM email_verification_challenges
     WHERE id = $1 AND verified_at IS NULL AND consumed_at IS NULL
     RETURNING id`,
    [challengeId],
  );
}

export async function finalizeEmailVerificationDelivery(challengeId: string, email: string) {
  await ensureDatabase();
  await withTransaction(async (client) => {
    const current = await queryOne<{ id: string }>(
      `SELECT id FROM email_verification_challenges
       WHERE id = $1 AND email_normalized = $2
         AND consumed_at IS NULL AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [challengeId, email],
      client,
    );
    if (!current) throw new Error('발송된 이메일 인증 요청을 확인할 수 없습니다.');
    await client.query(
      `UPDATE email_verification_challenges
       SET consumed_at = clock_timestamp()
       WHERE email_normalized = $1 AND id <> $2 AND consumed_at IS NULL`,
      [email, challengeId],
    );
  });
}

export async function verifyEmailChallenge(input: {
  challengeId: string;
  email: string;
  code: string;
  clientScope: string;
}): Promise<AuthResult<{ verificationToken: string }>> {
  await ensureDatabase();
  const secret = codeSecret();
  const providedMac = await hashEmailCode(secret, input.challengeId, input.email, input.code);
  const verificationToken = createVerificationToken();
  const verificationTokenHash = await hashOpaqueToken(verificationToken);
  const clientHash = await hashRateLimitScope(`email-verify-client:${input.clientScope}`);

  return withTransaction(async (client) => {
    const limit = await consumeRateLimit('email-verify-client', clientHash, 10 * 60, 30, client);
    if (!limit.allowed) return rateLimited(limit.retryAfter);
    const challenge = await queryOne<ChallengeRow>(
      `SELECT id, email_normalized AS "emailNormalized", code_mac AS "codeMac",
         attempt_count AS "attemptCount", expires_at::text AS "expiresAt",
         verified_at::text AS "verifiedAt"
       FROM email_verification_challenges
       WHERE id = $1 AND consumed_at IS NULL
       FOR UPDATE`,
      [input.challengeId],
      client,
    );
    if (!challenge || challenge.emailNormalized !== input.email) {
      return { ok: false, code: 'INVALID_CODE', message: '인증코드를 확인해 주세요.' };
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      return { ok: false, code: 'CODE_EXPIRED', message: '인증코드가 만료되었습니다. 새 코드를 요청해 주세요.' };
    }
    if (Number(challenge.attemptCount) >= EMAIL_CODE_MAX_ATTEMPTS) {
      return { ok: false, code: 'INVALID_CODE', message: '인증코드 확인 횟수를 초과했습니다. 새 코드를 요청해 주세요.' };
    }
    if (!codeMacMatches(challenge.codeMac, providedMac)) {
      await client.query(
        `UPDATE email_verification_challenges
         SET attempt_count = LEAST($2, attempt_count + 1)
         WHERE id = $1`,
        [input.challengeId, EMAIL_CODE_MAX_ATTEMPTS],
      );
      return { ok: false, code: 'INVALID_CODE', message: '인증코드를 확인해 주세요.' };
    }

    await client.query(
      `UPDATE email_verification_challenges
       SET verification_token_hash = $2, verified_at = clock_timestamp()
       WHERE id = $1 AND consumed_at IS NULL`,
      [input.challengeId, verificationTokenHash],
    );
    return { ok: true, verificationToken };
  });
}

export async function signupAccount(input: {
  username: string;
  normalizedUsername: string;
  password: string;
  email: string;
  companyName: string;
  verificationToken: string;
  clientScope: string;
}): Promise<AuthResult<{ session: AuthSession; token: string }>> {
  await ensureDatabase();
  const clientHash = await hashRateLimitScope(`signup-client:${input.clientScope}`);
  const signupLimit = await consumeRateLimit('signup-client', clientHash, 60 * 60, 10);
  if (!signupLimit.allowed) return rateLimited(signupLimit.retryAfter);

  const [passwordHash, verificationTokenHash] = await Promise.all([
    hashPassword(input.password),
    hashOpaqueToken(input.verificationToken),
  ]);
  const userId = `usr-${crypto.randomUUID()}`;

  return withEmailRegistrationLock(input.email, () => withTransaction(async (client) => {
    const challenge = await queryOne<{ id: string }>(
      `SELECT id FROM email_verification_challenges
       WHERE email_normalized = $1
         AND verification_token_hash = $2
         AND verified_at IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [input.email, verificationTokenHash],
      client,
    );
    if (!challenge) {
      return {
        ok: false,
        code: 'VERIFICATION_REQUIRED',
        message: '이메일 인증이 만료되었거나 유효하지 않습니다. 다시 인증해 주세요.',
      };
    }

    const createdUser = await queryOne<{ id: string }>(
      `INSERT INTO erp_users
        (id, username, username_normalized, password_hash, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $5, clock_timestamp())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, input.username, input.normalizedUsername, passwordHash, input.email],
      client,
    );
    if (!createdUser) {
      const usernameExists = await queryOne<{ found: boolean }>(
        'SELECT TRUE AS found FROM erp_users WHERE username_normalized = $1',
        [input.normalizedUsername],
        client,
      );
      return usernameExists
        ? { ok: false, code: 'USERNAME_TAKEN', message: '이미 사용 중인 아이디입니다.' }
        : { ok: false, code: 'EMAIL_TAKEN', message: EMAIL_TAKEN_MESSAGE };
    }

    let tenant: TenantSummary | null = null;
    for (let attempt = 0; attempt < 3 && !tenant; attempt += 1) {
      const tenantId = `ten-${crypto.randomUUID()}`;
      const tenantCode = `ORG-${crypto.randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
      const inserted = await queryOne<MembershipRow>(
        `INSERT INTO tenants
          (id, code, name, organization_type, status, brand_color, created_at, updated_at)
         VALUES ($1, $2, $3, 'BIDDER', 'ACTIVE', '#17324D', clock_timestamp()::text, clock_timestamp()::text)
         ON CONFLICT DO NOTHING
         RETURNING id, code, name, brand_color AS "brandColor",
           organization_type AS "organizationType", 'admin'::text AS role`,
        [tenantId, tenantCode, input.companyName],
        client,
      );
      if (inserted) {
        tenant = {
          id: inserted.id,
          code: inserted.code as TenantSummary['code'],
          name: inserted.name,
          brandColor: inserted.brandColor,
          organizationType: inserted.organizationType,
        };
      }
    }
    if (!tenant) throw new Error('업체 식별자를 만들 수 없습니다.');

    await client.query(
      `INSERT INTO sites
        (id, tenant_id, code, name, type, timezone, active, created_at, updated_at)
       VALUES ($1, $2, 'MAIN', $3, 'CENTRAL_KITCHEN', 'Asia/Seoul', TRUE,
         clock_timestamp()::text, clock_timestamp()::text)`,
      [`site-${crypto.randomUUID()}`, tenant.id, `${input.companyName} 본사`],
    );

    await client.query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'admin')`,
      [userId, tenant.id],
    );
    const consumed = await queryOne<{ id: string }>(
      `UPDATE email_verification_challenges
       SET consumed_at = clock_timestamp()
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [challenge.id],
      client,
    );
    if (!consumed) throw new Error('이메일 인증 사용 상태를 저장할 수 없습니다.');

    const createdSession = await insertSession(client, userId);
    return {
      ok: true,
      token: createdSession.token,
      session: {
        user: { id: userId, username: input.username, email: input.email },
        memberships: [{ role: 'admin', tenant }],
        expiresAt: createdSession.expiresAt,
      },
    };
  }));
}

export async function loginAccount(input: {
  normalizedUsername: string;
  password: string;
  clientScope: string;
}): Promise<AuthResult<{ session: AuthSession; token: string }>> {
  await ensureDatabase();
  const [clientHash, usernameHash] = await Promise.all([
    hashRateLimitScope(`login-client:${input.clientScope}`),
    hashRateLimitScope(`login-username:${input.normalizedUsername}`),
  ]);
  const limits = await withTransaction(async (client) => Promise.all([
    consumeRateLimit('login-client', clientHash, 15 * 60, 30, client),
    consumeRateLimit('login-username', usernameHash, 15 * 60, 10, client),
  ]));
  const blocked = limits.find((item) => !item.allowed);
  if (blocked) return rateLimited(blocked.retryAfter);

  const user = await queryOne<UserCredentialRow>(
    `SELECT id, username, password_hash AS "passwordHash", email, status
     FROM erp_users WHERE username_normalized = $1`,
    [input.normalizedUsername],
  );
  const passwordMatches = user
    ? await verifyPassword(input.password, user.passwordHash)
    : (await burnPasswordVerification(input.password), false);
  if (!user || !passwordMatches || user.status !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호를 확인해 주세요.' };
  }

  return withTransaction(async (client) => {
    const [memberships, createdSession] = await Promise.all([
      membershipsForUser(user.id, client),
      insertSession(client, user.id),
    ]);
    return {
      ok: true,
      token: createdSession.token,
      session: {
        user: { id: user.id, username: user.username, email: user.email },
        memberships,
        expiresAt: createdSession.expiresAt,
      },
    };
  });
}

export async function readAuthSession(token: string): Promise<AuthSession | null> {
  await ensureDatabase();
  const tokenHash = await hashOpaqueToken(token);
  return withTransaction(async (client) => {
    const user = await queryOne<SessionUserRow>(
      `SELECT u.id, u.username, u.email, s.expires_at::text AS "expiresAt"
       FROM auth_sessions s
       JOIN erp_users u ON u.id = s.user_id AND u.status = 'ACTIVE'
       WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp()`,
      [tokenHash],
      client,
    );
    if (!user) return null;
    await client.query(
      `UPDATE auth_sessions SET last_seen_at = clock_timestamp()
       WHERE token_hash = $1
         AND last_seen_at < clock_timestamp() - interval '5 minutes'`,
      [tokenHash],
    );
    const memberships = await membershipsForUser(user.id, client);
    return {
      user: { id: user.id, username: user.username, email: user.email },
      memberships,
      expiresAt: iso(user.expiresAt),
    };
  });
}

export async function destroyAuthSession(token: string | null) {
  if (!token) return;
  await ensureDatabase();
  const tokenHash = await hashOpaqueToken(token);
  await queryOne('DELETE FROM auth_sessions WHERE token_hash = $1 RETURNING token_hash', [tokenHash]);
}

export async function authorizeSessionTenant(
  token: string,
  tenantCode: string,
): Promise<TenantAccessRow | null> {
  await ensureDatabase();
  const tokenHash = await hashOpaqueToken(token);
  const row = await queryOne<TenantAccessRow>(
    `SELECT u.id AS "userId", u.username, u.email,
       access.role, access.tenant_id AS "tenantId"
     FROM auth_sessions s
     JOIN erp_users u ON u.id = s.user_id AND u.status = 'ACTIVE'
     LEFT JOIN LATERAL (
       SELECT tm.role, t.id AS tenant_id
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = u.id AND t.code = $2 AND t.status = 'ACTIVE'
       LIMIT 1
     ) access ON TRUE
     WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp()`,
    [tokenHash, tenantCode],
  );
  return row ?? null;
}
