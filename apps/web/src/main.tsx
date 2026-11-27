import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// The desktop shell draws its own caption buttons (titleBarOverlay). Mark the
// document so CSS can turn the top bar into a window drag region, then ask the
// shell exactly how wide the native buttons are and reserve that corner — so
// the close/minimise/maximise buttons never sit on top of our own UI.
// The browser build is untouched.
type CaptionInset = { width: number; height: number; side: 'right' | 'left' };

function applyCaptionInset(inset: CaptionInset | null): void {
  if (!inset || !inset.width) return;
  const root = document.documentElement;
  root.dataset.shell = 'desktop';
  root.style.setProperty('--caption-inset', `${Math.round(inset.width)}px`);
  root.style.setProperty('--caption-height', `${Math.round(inset.height)}px`);
  root.dataset.captionSide = inset.side;
}

if (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)) {
  document.documentElement.dataset.shell = 'desktop';
  const bridge = (window as { daming?: { captionInset?: () => Promise<CaptionInset> } }).daming;
  if (bridge?.captionInset) {
    void bridge.captionInset().then(applyCaptionInset).catch(() => undefined);
    window.addEventListener('resize', () => {
      void bridge.captionInset?.().then(applyCaptionInset).catch(() => undefined);
    });
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(<App />);