import { useEffect, useRef, useState } from 'react';

/** Animate an integer toward `target` (ease-out cubic) for KPI counters. */
export function useCountUp(target: number, durationMs = 720): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(target) ? target : 0;
    if (from === to) return;
    // Reduced motion: jump straight to the new number, no ticking digits.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = to;
      setValue(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

/**
 * Scroll reveal: mark the container `reveal-ready` and observe every `[data-reveal]`
 * descendant. Falls back to visible when IntersectionObserver is unavailable.
 */
export function useScrollReveal<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      root.classList.add('reveal-ready');
      nodes.forEach((node) => node.classList.add('is-visible'));
      return;
    }
    root.classList.add('reveal-ready');
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.06, rootMargin: '0px 0px -8% 0px' });
    nodes.forEach((node) => io.observe(node));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/**
 * Pointer sheen: paper surfaces get a soft light that follows the cursor.
 * One delegated listener and one rAF per frame — no per-card handlers, no
 * re-render. Skipped for touch input and reduced motion, where it is noise.
 * The CSS side reads `--sheen-x/--sheen-y` (see the UI v5 layer in styles.css).
 */
const SHEEN_TARGETS = [
  '.kpi', '.quick-tile', '.status-card', '.inbox-card', '.provider-card', '.agent-card', '.dm-card',
  '.crew-node', '.board-card', '.exec-node', '.intake-card', '.platform-hero', '.quota-card'
].join(', ');
const SHEEN_PARKED = '-999px';

export function usePointerSheen(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let hovered: HTMLElement | null = null;
    let frame = 0;
    let point: { x: number; y: number } | null = null;

    const park = (element: HTMLElement) => {
      element.style.setProperty('--sheen-x', SHEEN_PARKED);
      element.style.setProperty('--sheen-y', SHEEN_PARKED);
    };
    const paint = () => {
      frame = 0;
      if (!hovered || !point) return;
      const rect = hovered.getBoundingClientRect();
      hovered.style.setProperty('--sheen-x', `${Math.round(point.x - rect.left)}px`);
      hovered.style.setProperty('--sheen-y', `${Math.round(point.y - rect.top)}px`);
    };
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(SHEEN_TARGETS)
        : null;
      if (target !== hovered) {
        if (hovered) park(hovered);
        hovered = target;
      }
      if (!hovered) return;
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      if (frame) cancelAnimationFrame(frame);
      if (hovered) park(hovered);
    };
  }, []);
}

/** Document scroll progress 0..1 for the thin top progress bar. */
export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const read = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setProgress(max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0);
    };
    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, []);
  return progress;
}
