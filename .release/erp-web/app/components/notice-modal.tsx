'use client';

import { AlertCircle, BellRing, CheckCircle2, Info } from 'lucide-react';
import type { NoticeMessage } from './module-views';
import { AccessibleModal } from './accessible-modal';

interface NoticeModalProps {
  notice: NoticeMessage | null;
  onClose: () => void;
  fallbackFocusSelector?: string;
}

const toneStyles = {
  success: { icon: CheckCircle2, iconClass: 'bg-emerald-50 text-emerald-700' },
  error: { icon: AlertCircle, iconClass: 'bg-red-50 text-red-700' },
  info: { icon: Info, iconClass: 'bg-blue-50 text-blue-700' },
} as const;

export function NoticeModal({ notice, onClose, fallbackFocusSelector = '#erp-main-content' }: NoticeModalProps) {
  if (!notice) return null;
  const style = toneStyles[notice.tone];
  const Icon = notice.title === '운영 알림' ? BellRing : style.icon;

  return (
    <AccessibleModal open title={notice.title} onRequestClose={onClose} fallbackFocusSelector={fallbackFocusSelector} size="small">
      <div className="px-5 py-6 sm:px-6">
        <div className="flex items-start gap-4">
          <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${style.iconClass}`}>
            <Icon aria-hidden="true" size={23} />
          </span>
          <p className="whitespace-pre-line pt-1 text-sm font-medium leading-7 text-[var(--ss-text-soft)]">{notice.message}</p>
        </div>
      </div>
      <div className="flex justify-end border-t border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-4 sm:px-6">
        <button
          type="button"
          data-modal-initial-focus
          onClick={onClose}
          className="star-primary-button px-5 text-sm"
        >
          확인
        </button>
      </div>
    </AccessibleModal>
  );
}
