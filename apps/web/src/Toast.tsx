import { useCallback, useRef, useState } from 'react';

export type ToastTone = 'info' | 'ok' | 'warn' | 'bad';
export interface ToastItem { readonly id: number; readonly text: string; readonly tone: ToastTone }

/** Bottom-right transient notifications; each auto-dismisses and can be closed early. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);
  const push = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = ++seq.current;
    setToasts((list) => [...list.slice(-3), { id, text, tone }]);
    window.setTimeout(() => dismiss(id), 3800);
  }, [dismiss]);
  return { toasts, push, dismiss };
}

export function ToastViewport({ toasts, onDismiss }: {
  toasts: readonly ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.tone}`} key={toast.id} role="status">
          <span className="toast-mark" aria-hidden="true">
            {toast.tone === 'ok' ? '✓' : toast.tone === 'bad' ? '!' : toast.tone === 'warn' ? '!' : 'i'}
          </span>
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
