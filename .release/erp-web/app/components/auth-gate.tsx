'use client';

import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AuthSession } from '../lib/auth-types';
import { AuthScreen, parseAuthenticatedSession } from './auth-screen';
import { ErpShell } from './erp-shell';
import { StarSnapBrandIcon } from './starsnap-brand-icon';

type GateState =
  | { status: 'loading' }
  | { status: 'signed-out'; notice: string | null }
  | { status: 'authenticated'; session: AuthSession }
  | { status: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function AuthGate() {
  const [state, setState] = useState<GateState>({ status: 'loading' });
  const [loadGeneration, setLoadGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestSession = async () => {
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const decoded: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;

        if (response.status === 401 || (isRecord(decoded) && decoded.authenticated === false)) {
          setState({ status: 'signed-out', notice: null });
          return;
        }
        if (!response.ok) {
          const message = isRecord(decoded) && typeof decoded.message === 'string'
            ? decoded.message
            : '로그인 상태를 확인하지 못했습니다.';
          throw new Error(message);
        }
        const session = parseAuthenticatedSession(decoded);
        if (!session) throw new Error('로그인 세션 응답이 올바르지 않습니다.');
        setState({ status: 'authenticated', session });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : '로그인 상태를 확인하지 못했습니다.',
        });
      }
    };
    void requestSession();
    return () => controller.abort();
  }, [loadGeneration]);

  const handleAuthenticated = (session: AuthSession) => {
    setState({ status: 'authenticated', session });
  };

  const handleSessionExpired = useCallback((message?: string) => {
    setState({
      status: 'signed-out',
      notice: message ?? '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.',
    });
    void fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }, []);

  if (state.status === 'authenticated') {
    const firstMembership = state.session.memberships[0];
    return (
      <ErpShell
        key={`${state.session.user.id}:${firstMembership.tenant.id}`}
        session={state.session}
        onSessionExpired={handleSessionExpired}
      />
    );
  }

  if (state.status === 'signed-out') {
    return <AuthScreen initialNotice={state.notice} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <main className="grid min-h-[100svh] place-items-center px-4 py-8">
      <section aria-live="polite" aria-busy={state.status === 'loading' || undefined} className="w-full max-w-md rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-8 text-center shadow-[var(--ss-shadow-lg)]">
        <StarSnapBrandIcon className="mx-auto" />
        <h1 className="mt-5 text-xl font-bold tracking-tight">StarSnap ERP</h1>
        {state.status === 'loading' ? (
          <p className="mt-2 text-sm leading-6 text-[var(--ss-text-subtle)]">로그인 상태를 확인하고 있습니다.</p>
        ) : (
          <>
            <p role="alert" className="mt-2 text-sm leading-6 text-[var(--ss-danger)]">{state.message}</p>
            <button
              type="button"
              onClick={() => {
                setState({ status: 'loading' });
                setLoadGeneration((current) => current + 1);
              }}
              className="star-primary-button mt-5 px-5 text-sm"
            >
              <RotateCw aria-hidden="true" size={17} /> 다시 시도
            </button>
          </>
        )}
      </section>
    </main>
  );
}
