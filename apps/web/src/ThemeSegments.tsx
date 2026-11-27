// One visual option row reused by the settings page and the top bar.
// The pattern is the segment control from magpie's settings (seg-track /
// seg-thumb): a small, calm, single-line choice instead of a select box.
import type { ThemePreference } from './theme.ts';
import { THEME_LABELS } from './theme.ts';

const OPTIONS: ThemePreference[] = ['day', 'night', 'auto'];

export function ThemeSegments({
  preference,
  onChange,
  compact = false
}: {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
  compact?: boolean;
}) {
  return (
    <div className={`seg${compact ? ' seg--compact' : ''}`} role="radiogroup" aria-label="主题">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={preference === option}
          className={preference === option ? 'on' : ''}
          onClick={() => onChange(option)}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
