'use client';

import { useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react';
import type { ErpAction, HaccpCheck } from '../lib/erp-types';
import { AccessibleModal } from './accessible-modal';

const actionContent = {
  'meals:confirm': {
    title: '식단을 확정할까요?',
    description: '확정된 식단과 식수는 발주 및 생산 계획의 기준으로 사용됩니다.',
    submitLabel: '식단 확정',
  },
  'purchasing:approve': {
    title: '발주를 승인할까요?',
    description: '승인 후 공급업체 발주와 입고 준비 단계로 진행됩니다.',
    submitLabel: '발주 승인',
  },
  'inventory:acknowledge': {
    title: '재고 주의를 확인했나요?',
    description: '부족 수량 또는 유통기한을 확인한 기록을 남깁니다.',
    submitLabel: '확인 완료',
  },
  'production:complete': {
    title: '생산을 마감할까요?',
    description: '생산량과 위생 기록을 확인한 뒤 완료 상태로 변경합니다.',
    submitLabel: '생산 마감',
  },
  'delivery:complete': {
    title: '배송 인수를 완료할까요?',
    description: '납품처 인수와 배송 완료 상태를 기록합니다.',
    submitLabel: '인수 완료',
  },
  'haccp:resolve': {
    title: 'HACCP 시정조치 종결',
    description: '재측정 결과와 시정조치 확인 내용을 함께 기록해야 종결할 수 있습니다.',
    submitLabel: '시정완료 처리',
  },
} satisfies Record<string, { title: string; description: string; submitLabel: string }>;

interface WorkflowActionModalProps {
  request: ErpAction | null;
  itemLabel: string;
  haccpCheck?: HaccpCheck;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (evidence?: ErpAction['evidence']) => void;
}

export function WorkflowActionModal({
  request,
  itemLabel,
  haccpCheck,
  busy,
  error,
  onClose,
  onSubmit,
}: WorkflowActionModalProps) {
  const [verificationValue, setVerificationValue] = useState('');
  const [correctiveAction, setCorrectiveAction] = useState(
    request?.module === 'haccp' ? haccpCheck?.correctiveAction ?? '' : '',
  );
  const [fieldErrors, setFieldErrors] = useState<{ verificationValue?: string; correctiveAction?: string }>({});
  const verificationRef = useRef<HTMLInputElement>(null);
  const correctiveActionRef = useRef<HTMLTextAreaElement>(null);

  if (!request) return null;
  const content = actionContent[`${request.module}:${request.action}` as keyof typeof actionContent];
  const isHaccp = request.module === 'haccp' && request.action === 'resolve';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!isHaccp) {
      onSubmit();
      return;
    }
    const nextErrors: typeof fieldErrors = {};
    const normalizedVerification = verificationValue.trim();
    const normalizedAction = correctiveAction.trim();
    if (!normalizedVerification) nextErrors.verificationValue = '재측정값을 입력해 주세요.';
    if (!normalizedAction) nextErrors.correctiveAction = '시정조치 확인 내용을 입력해 주세요.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      if (nextErrors.verificationValue) verificationRef.current?.focus();
      else correctiveActionRef.current?.focus();
      return;
    }
    onSubmit({ verificationValue: normalizedVerification, correctiveAction: normalizedAction });
  };

  return (
    <AccessibleModal
      open
      title={content.title}
      description={content.description}
      busy={busy}
      dismissOnBackdrop={false}
      fallbackFocusSelector="#erp-main-content"
      onRequestClose={onClose}
      size={isHaccp ? 'medium' : 'small'}
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-col" noValidate>
        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3 rounded-[var(--ss-radius-lg)] bg-[var(--ss-surface-subtle)] p-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-lime-soft)] text-[var(--color-navy)]">
              {isHaccp ? <ShieldCheck aria-hidden="true" size={20} /> : <CheckCircle2 aria-hidden="true" size={20} />}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold text-[var(--color-muted-ink)]">처리 대상</p>
              <p className="mt-1 break-words text-sm font-semibold">{itemLabel}</p>
              {haccpCheck ? <p className="mt-1 text-xs text-[var(--ss-text-subtle)]">최초 측정값 {haccpCheck.measuredValue} · {haccpCheck.siteName}</p> : null}
            </div>
          </div>

          {isHaccp ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-semibold">종결 증빙</legend>
              <div>
                <label htmlFor="haccp-verification-value" className="mb-1.5 block text-sm font-bold">재측정값 <span className="text-red-600">필수</span></label>
                <input
                  ref={verificationRef}
                  data-modal-initial-focus
                  id="haccp-verification-value"
                  value={verificationValue}
                  onChange={(event) => {
                    setVerificationValue(event.target.value);
                    if (fieldErrors.verificationValue) setFieldErrors((current) => ({ ...current, verificationValue: undefined }));
                  }}
                  required
                  maxLength={80}
                  disabled={busy}
                  aria-invalid={Boolean(fieldErrors.verificationValue)}
                  aria-describedby={fieldErrors.verificationValue ? 'haccp-verification-error' : undefined}
                  placeholder="예: 5°C"
                  className="star-control w-full px-3 text-sm disabled:bg-[var(--ss-surface-subtle)]"
                />
                {fieldErrors.verificationValue ? <p id="haccp-verification-error" role="alert" className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-red-700"><AlertCircle aria-hidden="true" size={14} /> {fieldErrors.verificationValue}</p> : null}
              </div>
              <div>
                <label htmlFor="haccp-corrective-action" className="mb-1.5 block text-sm font-bold">시정조치 확인 내용 <span className="text-red-600">필수</span></label>
                <textarea
                  ref={correctiveActionRef}
                  id="haccp-corrective-action"
                  value={correctiveAction}
                  onChange={(event) => {
                    setCorrectiveAction(event.target.value);
                    if (fieldErrors.correctiveAction) setFieldErrors((current) => ({ ...current, correctiveAction: undefined }));
                  }}
                  required
                  maxLength={500}
                  rows={4}
                  disabled={busy}
                  aria-invalid={Boolean(fieldErrors.correctiveAction)}
                  aria-describedby={fieldErrors.correctiveAction ? 'haccp-action-error' : undefined}
                  className="star-control w-full resize-y px-3 py-2.5 text-sm disabled:bg-[var(--ss-surface-subtle)]"
                />
                {fieldErrors.correctiveAction ? <p id="haccp-action-error" role="alert" className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-red-700"><AlertCircle aria-hidden="true" size={14} /> {fieldErrors.correctiveAction}</p> : null}
              </div>
            </fieldset>
          ) : null}

          {error ? <div role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"><AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={17} />{error}</div> : null}
        </div>

        <div className="sticky bottom-0 flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            type="button"
            data-modal-initial-focus={!isHaccp ? true : undefined}
            disabled={busy}
            onClick={onClose}
            className="star-secondary-button px-4 text-sm"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy}
            className="star-primary-button px-5 text-sm disabled:cursor-wait"
          >
            {busy ? '처리 중…' : content.submitLabel}
          </button>
        </div>
      </form>
    </AccessibleModal>
  );
}
