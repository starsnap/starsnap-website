'use client';

import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface AccessibleModalProps {
  open: boolean;
  title: string;
  description?: string;
  busy?: boolean;
  children: ReactNode;
  onRequestClose: () => void;
  size?: 'small' | 'medium' | 'large';
  dismissOnBackdrop?: boolean;
  fallbackFocusSelector?: string;
}

const sizeClasses = {
  small: 'max-w-md',
  medium: 'max-w-2xl',
  large: 'max-w-4xl',
} as const;

const subscribeToClient = () => () => undefined;
let bodyScrollLockCount = 0;
let bodyOverflowBeforeModal = '';

export function lockBodyScroll() {
  if (bodyScrollLockCount === 0) bodyOverflowBeforeModal = document.body.style.overflow;
  bodyScrollLockCount += 1;
  document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll() {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount === 0) document.body.style.overflow = bodyOverflowBeforeModal;
}

/**
 * A styled native modal dialog. `showModal()` supplies browser-level focus
 * containment and background inertness; this wrapper adds focus restoration,
 * scroll locking, predictable Escape/backdrop handling, and a busy guard.
 */
export function AccessibleModal({
  open,
  title,
  description,
  busy = false,
  children,
  onRequestClose,
  size = 'medium',
  dismissOnBackdrop = true,
  fallbackFocusSelector,
}: AccessibleModalProps) {
  const mounted = useSyncExternalStore(subscribeToClient, () => true, () => false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scrollLockedRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      lockBodyScroll();
      scrollLockedRef.current = true;
      dialog.showModal();
      window.requestAnimationFrame(() => {
        const initialFocus = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')
          ?? dialog.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
        initialFocus?.focus();
      });
    }

    if (!open && dialog.open) {
      dialog.close();
      const returnTarget = returnFocusRef.current;
      if (scrollLockedRef.current) {
        unlockBodyScroll();
        scrollLockedRef.current = false;
      }
      window.requestAnimationFrame(() => {
        const fallbackTarget = fallbackFocusSelector
          ? document.querySelector<HTMLElement>(fallbackFocusSelector)
          : null;
        if (returnTarget?.isConnected) returnTarget.focus();
        else fallbackTarget?.focus();
      });
      returnFocusRef.current = null;
    }
  }, [fallbackFocusSelector, mounted, open]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    if (scrollLockedRef.current) {
      unlockBodyScroll();
      scrollLockedRef.current = false;
    }
    const returnTarget = returnFocusRef.current;
    const fallbackTarget = fallbackFocusSelector
      ? document.querySelector<HTMLElement>(fallbackFocusSelector)
      : null;
    if (returnTarget?.isConnected) returnTarget.focus();
    else fallbackTarget?.focus();
  }, [fallbackFocusSelector]);

  const requestClose = () => {
    if (!busy) onRequestClose();
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (dismissOnBackdrop && event.target === event.currentTarget) requestClose();
  };

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-busy={busy || undefined}
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${sizeClasses[size]} overflow-hidden rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-0 text-[var(--ss-text)] shadow-[var(--ss-shadow-lg)] backdrop:bg-[var(--ss-overlay)] backdrop:backdrop-blur-[2px] open:flex open:flex-col max-sm:mb-0 max-sm:mt-auto max-sm:max-h-[calc(100dvh-0.5rem)] max-sm:w-full max-sm:rounded-b-none max-sm:rounded-t-[var(--ss-radius-lg)]`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={handleBackdropClick}
    >
      <div className="flex min-h-16 shrink-0 items-start gap-4 border-b border-[var(--ss-border)] px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
          {description ? <p id={descriptionId} className="mt-1 text-sm leading-6 text-[var(--ss-text-subtle)]">{description}</p> : null}
        </div>
        <button
          type="button"
          aria-label={`${title} 닫기`}
          disabled={busy}
          onClick={requestClose}
          className="star-icon-button"
        >
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </dialog>,
    document.body,
  );
}
