'use client';

import { type FormEvent } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ErpAction } from '../lib/erp-types';
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
} satisfies Record<string, { title: string; description: string; submitLabel: string }>;

interface WorkflowActionModalProps {
  request: ErpAction | null;
  itemLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
}

export function WorkflowActionModal({
  request,
  itemLabel,
  busy,
  error,
  onClose,
  onSubmit,
}: WorkflowActionModalProps) {
  if (!request) return null;
  const content = actionContent[`${request.module}:${request.action}` as keyof typeof actionContent];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
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
      size="small"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3 rounded-[var(--ss-radius-lg)] bg-[var(--ss-surface-subtle)] p-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-lime-soft)] text-[var(--color-navy)]">
              <CheckCircle2 aria-hidden="true" size={20} />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold text-[var(--color-muted-ink)]">처리 대상</p>
              <p className="mt-1 break-words text-sm font-semibold">{itemLabel}</p>
            </div>
          </div>

          {error ? <div role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"><AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={17} />{error}</div> : null}
        </div>

        <div className="sticky bottom-0 flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            type="button"
            data-modal-initial-focus
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
