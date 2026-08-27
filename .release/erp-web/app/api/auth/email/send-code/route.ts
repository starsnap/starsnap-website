import { NextResponse } from 'next/server';
import { parseEmailRequest } from '@/app/lib/auth-validation';
import {
  authResponseHeaders,
  clientRateLimitScope,
  isLoopbackRequest,
  isStrictSameOrigin,
  readSmallJson,
} from '@/app/lib/auth-http';
import {
  AuthConfigurationError,
  beginEmailVerification,
  cancelEmailVerification,
  finalizeEmailVerificationDelivery,
  withEmailRegistrationLock,
} from '@/db/auth-repository';
import {
  AuthEmailConfigurationError,
  AuthEmailDeliveryError,
  sendSignupVerificationEmail,
} from '@/db/auth-email';

export async function POST(request: Request) {
  const headers = authResponseHeaders();
  if (!isStrictSameOrigin(request)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 출처입니다.' }, { status: 403, headers });
  }
  const body = await readSmallJson(request, 2 * 1024);
  if (!body.ok) return NextResponse.json({ ok: false, message: body.message }, { status: body.status, headers });
  const parsed = parseEmailRequest(body.value);
  if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 422, headers });

  try {
    return await withEmailRegistrationLock(parsed.value.email, async () => {
      let challengeId: string | null = null;
      try {
        const challenge = await beginEmailVerification(parsed.value.email, clientRateLimitScope(request));
        if (!challenge.ok) {
          if (challenge.code === 'RATE_LIMITED') {
            headers.set('Retry-After', String(challenge.retryAfter ?? 60));
          }
          const status = challenge.code === 'RATE_LIMITED'
            ? 429
            : challenge.code === 'EMAIL_TAKEN'
              ? 409
              : 422;
          return NextResponse.json(
            { ok: false, code: challenge.code, message: challenge.message },
            { status, headers },
          );
        }
        challengeId = challenge.challengeId;
        // Invalidating older challenges is the final database step. Do it before
        // SMTP so a successfully delivered code is never deleted by a later DB error.
        await finalizeEmailVerificationDelivery(challenge.challengeId, parsed.value.email);
        const delivery = await sendSignupVerificationEmail({
          email: parsed.value.email,
          code: challenge.code,
          challengeId: challenge.challengeId,
        });
        const deliveryUncertain = delivery.transport === 'smtp-mailer'
          && delivery.deliveryState === 'uncertain';
        return NextResponse.json({
          ok: true,
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          ...(delivery.transport === 'mailpit' && delivery.localInboxUrl && isLoopbackRequest(request)
            ? { localInboxUrl: delivery.localInboxUrl }
            : {}),
          deliveryState: deliveryUncertain ? 'uncertain' : 'delivered',
          message: deliveryUncertain
            ? '메일 서버의 발송 확인이 지연되고 있습니다. 인증코드는 계속 유효하니 메일함을 확인해 주세요.'
            : '인증코드를 이메일로 보냈습니다.',
        }, { status: deliveryUncertain ? 202 : 200, headers });
      } catch (error) {
        if (challengeId) await cancelEmailVerification(challengeId).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (
      error instanceof AuthConfigurationError
      || error instanceof AuthEmailConfigurationError
      || error instanceof AuthEmailDeliveryError
    ) {
      console.error('Auth email is unavailable', error.message);
      return NextResponse.json(
        { ok: false, message: '이메일 인증 서비스를 사용할 수 없습니다. 관리자에게 문의해 주세요.' },
        { status: 503, headers },
      );
    }
    console.error('Email verification request failed', error);
    return NextResponse.json({ ok: false, message: '인증코드 발송 중 오류가 발생했습니다.' }, { status: 500, headers });
  }
}
