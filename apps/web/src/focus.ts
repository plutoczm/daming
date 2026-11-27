import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Dialog focus management: move focus in, keep Tab inside, restore focus on close,
 * and lock background scrolling. Esc is handled here in the capture phase so a
 * dialog never loses the key to a global shortcut handler.
 */
export function useFocusTrap(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  options: { readonly initialFocus?: string; readonly onClose?: () => void } = {}
): void {
  useEffect(() => {
    if (!active) return;
    const node: HTMLElement | null = container.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => element.getAttribute('aria-hidden') !== 'true');
    const initial = options.initialFocus ? node.querySelector<HTMLElement>(options.initialFocus) : null;
    (initial ?? items()[0] ?? node).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = items();
      if (!focusable.length) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? index <= 0 ? focusable[focusable.length - 1]! : focusable[index - 1]!
        : index === -1 || index === focusable.length - 1 ? focusable[0]! : focusable[index + 1]!;
      event.preventDefault();
      next.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}