import { env } from 'cloudflare:workers';

interface AuthEmailBindings {
  AUTH_EMAIL_TRANSPORT?: string;
  AUTH_MAILPIT_URL?: string;
  AUTH_MAILPIT_PUBLIC_URL?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_SMTP_MAILER_URL?: string;
  AUTH_SMTP_MAILER_TOKEN?: string;
  RESEND_API_KEY?: string;
}

export class AuthEmailConfigurationError extends Error {}
export class AuthEmailDeliveryError extends Error {}

function bindings() {
  return env as unknown as AuthEmailBindings;
}

function trimmed(value: string | undefined) {
  return value?.trim() ?? '';
}

function emailAddress(value: string) {
  const bracketed = value.match(/<([^<>]+)>\s*$/)?.[1]?.trim();
  return bracketed || value.trim();
}

function senderName(value: string) {
  const match = value.match(/^\s*([^<>]+?)\s*<[^<>]+>\s*$/);
  return match?.[1]?.trim() || 'StarSnap ERP';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new AuthEmailDeliveryError(
      error instanceof Error && error.name === 'AbortError'
        ? '이메일 발송 시간이 초과되었습니다.'
        : '이메일 발송 서비스에 연결할 수 없습니다.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function messageText(code: string) {
  return [
    'StarSnap ERP 회원가입 이메일 인증코드입니다.',
    '',
    `인증코드: ${code}`,
    '',
    '이 코드는 10분 동안만 사용할 수 있습니다.',
    '본인이 요청하지 않았다면 이 메일을 무시해 주세요.',
  ].join('\n');
}

function messageHtml(code: string) {
  return `<!doctype html><html lang="ko"><body style="font-family:Arial,sans-serif;color:#172033">
    <div style="max-width:520px;margin:32px auto;padding:28px;border:1px solid #e5e7eb;border-radius:16px">
      <p style="font-size:12px;font-weight:700;letter-spacing:.12em;color:#64748b">STARSNAP ERP</p>
      <h1 style="font-size:22px;margin:12px 0">이메일 인증코드</h1>
      <p style="line-height:1.6;color:#475569">회원가입 화면에 아래 6자리 코드를 입력해 주세요.</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:.22em;margin:24px 0;padding:18px;text-align:center;background:#fff8c5;border-radius:12px">${code}</p>
      <p style="font-size:13px;line-height:1.6;color:#64748b">이 코드는 10분 동안만 사용할 수 있습니다. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.</p>
    </div>
  </body></html>`;
}

async function sendWithMailpit(
  baseUrl: string,
  from: string,
  to: string,
  code: string,
) {
  let endpoint: URL;
  try {
    endpoint = new URL('/api/v1/send', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new AuthEmailConfigurationError('AUTH_MAILPIT_URL이 올바른 URL이 아닙니다.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new AuthEmailConfigurationError('AUTH_MAILPIT_URL은 HTTP 또는 HTTPS URL이어야 합니다.');
  }
  const response = await fetchWithTimeout(endpoint.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: emailAddress(from), Name: senderName(from) },
      To: [{ Email: to }],
      Subject: '[StarSnap ERP] 이메일 인증코드',
      Text: messageText(code),
      HTML: messageHtml(code),
      Tags: ['starsnap-auth'],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthEmailDeliveryError(`Mailpit 이메일 발송이 거절되었습니다. (HTTP ${response.status})`);
  }
  await response.body?.cancel().catch(() => undefined);
}

async function sendWithResend(
  apiKey: string,
  from: string,
  to: string,
  code: string,
  challengeId: string,
) {
  if (!apiKey.startsWith('re_') || apiKey.length < 16) {
    throw new AuthEmailConfigurationError('RESEND_API_KEY가 올바르게 설정되지 않았습니다.');
  }
  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `starsnap-auth-${challengeId}`,
      'User-Agent': 'StarSnap-ERP/1.0',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: '[StarSnap ERP] 이메일 인증코드',
      text: messageText(code),
      html: messageHtml(code),
      tags: [{ name: 'category', value: 'email_verification' }],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthEmailDeliveryError(`Resend 이메일 발송이 거절되었습니다. (HTTP ${response.status})`);
  }
  await response.body?.cancel().catch(() => undefined);
}

async function sendWithSmtpMailer(
  baseUrl: string,
  token: string,
  to: string,
  code: string,
  challengeId: string,
) {
  if (token.length < 32) {
    throw new AuthEmailConfigurationError('AUTH_SMTP_MAILER_TOKEN이 올바르게 설정되지 않았습니다.');
  }
  let endpoint: URL;
  try {
    endpoint = new URL('/internal/email-verification', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new AuthEmailConfigurationError('AUTH_SMTP_MAILER_URL이 올바른 URL이 아닙니다.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new AuthEmailConfigurationError('AUTH_SMTP_MAILER_URL은 HTTP 또는 HTTPS URL이어야 합니다.');
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: to, code, challengeId }),
    }, 30_000);
  } catch (error) {
    if (error instanceof AuthEmailDeliveryError) return 'uncertain' as const;
    throw error;
  }
  if (response.status === 202) {
    await response.body?.cancel().catch(() => undefined);
    return 'uncertain' as const;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthEmailDeliveryError(`SMTP 이메일 발송이 거절되었습니다. (HTTP ${response.status})`);
  }
  await response.body?.cancel().catch(() => undefined);
  return 'delivered' as const;
}

export async function sendSignupVerificationEmail(input: {
  email: string;
  code: string;
  challengeId: string;
}) {
  const current = bindings();
  const transport = trimmed(current.AUTH_EMAIL_TRANSPORT).toLowerCase();
  const from = trimmed(current.AUTH_EMAIL_FROM);

  if (transport === 'mailpit') {
    if (!from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailAddress(from))) {
      throw new AuthEmailConfigurationError('AUTH_EMAIL_FROM이 올바르게 설정되지 않았습니다.');
    }
    const baseUrl = trimmed(current.AUTH_MAILPIT_URL);
    if (!baseUrl) throw new AuthEmailConfigurationError('AUTH_MAILPIT_URL이 설정되지 않았습니다.');
    await sendWithMailpit(baseUrl, from, input.email, input.code);
    return {
      transport: 'mailpit' as const,
      localInboxUrl: trimmed(current.AUTH_MAILPIT_PUBLIC_URL) || undefined,
    };
  }
  if (transport === 'resend') {
    if (!from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailAddress(from))) {
      throw new AuthEmailConfigurationError('AUTH_EMAIL_FROM이 올바르게 설정되지 않았습니다.');
    }
    await sendWithResend(
      trimmed(current.RESEND_API_KEY),
      from,
      input.email,
      input.code,
      input.challengeId,
    );
    return { transport: 'resend' as const };
  }
  if (transport === 'smtp-mailer') {
    const baseUrl = trimmed(current.AUTH_SMTP_MAILER_URL);
    if (!baseUrl) throw new AuthEmailConfigurationError('AUTH_SMTP_MAILER_URL이 설정되지 않았습니다.');
    const deliveryState = await sendWithSmtpMailer(
      baseUrl,
      trimmed(current.AUTH_SMTP_MAILER_TOKEN),
      input.email,
      input.code,
      input.challengeId,
    );
    return { transport: 'smtp-mailer' as const, deliveryState };
  }
  throw new AuthEmailConfigurationError('AUTH_EMAIL_TRANSPORT는 mailpit, smtp-mailer 또는 resend여야 합니다.');
}
