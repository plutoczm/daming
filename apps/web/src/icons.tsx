// Hand-drawn stroke icon set (24×24, 1.7 stroke, currentColor).
// Why: the previous navigation used text glyphs (▤ ◫ ⌘ ⛬ …), which render at
// different weights per platform and read as placeholder art. These share one
// optical grid so the rail, the quick-launch tiles and the palette all feel
// like the same instrument.
import type { ReactElement } from 'react';

export type IconName =
  | 'overview' | 'inbox' | 'portfolio' | 'tasks' | 'projects'
  | 'providers' | 'agents' | 'routing' | 'crew' | 'automation'
  | 'gateway' | 'notifications' | 'platform' | 'settings' | 'help' | 'command'
  | 'sun' | 'moon';

const PATHS: Record<IconName, ReactElement> = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13h4.2l1.3 2.6h6l1.3-2.6h4.2" />
      <path d="M5.6 4.5h12.8l2.1 8.5v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V13l2.1-8.5Z" />
    </>
  ),
  portfolio: (
    <>
      <path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z" />
      <path d="M3.5 12.5 12 17l8.5-4.5" />
      <path d="M3.5 16.5 12 21l8.5-4.5" />
    </>
  ),
  tasks: (
    <>
      <rect x="3.5" y="4" width="5" height="16" rx="1.8" />
      <rect x="10.2" y="4" width="5" height="10.5" rx="1.8" />
      <rect x="16.9" y="4" width="3.6" height="13.5" rx="1.6" />
    </>
  ),
  projects: (
    <>
      <path d="M3.5 7.2a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.2Z" />
      <path d="M3.5 10.4h17" />
    </>
  ),
  providers: (
    <>
      <path d="M12 3.2 4.4 7.1v9.8L12 20.8l7.6-3.9V7.1L12 3.2Z" />
      <path d="M4.4 7.1 12 11l7.6-3.9M12 11v9.8" />
    </>
  ),
  agents: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2.4" />
      <path d="M10 3.4v3.4M14 3.4v3.4M10 17.2v3.4M14 17.2v3.4M3.4 10h3.4M3.4 14h3.4M17.2 10h3.4M17.2 14h3.4" />
    </>
  ),
  routing: (
    <>
      <circle cx="6" cy="18" r="2.6" />
      <circle cx="18" cy="6" r="2.6" />
      <path d="M8.6 18H14a4 4 0 0 0 4-4V8.6" />
    </>
  ),
  crew: (
    <>
      <circle cx="9" cy="8.2" r="3.1" />
      <path d="M3.4 19.6a5.8 5.8 0 0 1 11.2 0" />
      <path d="M16.2 5.6a3 3 0 0 1 0 5.4" />
      <path d="M18.4 19.6a6.2 6.2 0 0 0-3-5.1" />
    </>
  ),
  automation: (
    <>
      <path d="M20.2 12a8.2 8.2 0 1 1-2.7-6.1" />
      <path d="M20.4 4.2v4.2h-4.2" />
    </>
  ),
  gateway: <path d="M3 12h4.2l2.6-6.2 3.9 12.4L16 12h5" />,
  notifications: (
    <>
      <path d="M6.2 9.6a5.8 5.8 0 0 1 11.6 0c0 3.9 1.4 5.4 2 5.9H4.2c.6-.5 2-2 2-5.9Z" />
      <path d="M9.8 18.8a2.3 2.3 0 0 0 4.4 0" />
    </>
  ),
  platform: (
    <>
      <rect x="4" y="4.2" width="16" height="6.6" rx="2" />
      <rect x="4" y="13.2" width="16" height="6.6" rx="2" />
      <path d="M7.6 7.5h.02M7.6 16.5h.02" />
    </>
  ),
  settings: (
    <>
      <path d="M4 8.2h9.2M18 8.2h2M4 15.8h4.2M12.6 15.8H20" />
      <circle cx="15.8" cy="8.2" r="2.1" />
      <circle cx="10.4" cy="15.8" r="2.1" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.3" />
      <path d="M12 16.8h.02" />
    </>
  ),
  command: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <path d="M8.6 8.6h6.8v6.8H8.6z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.4M12 19v2.4M2.6 12H5M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7" />
    </>
  ),
  moon: <path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z" />
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}