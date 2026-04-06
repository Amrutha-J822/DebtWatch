import type { Appearance } from './appearance';

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 14.5A8.5 8.5 0 0110.5 4a8.45 8.45 0 013.29.66 7 7 0 1010.21 9.84z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ThemeToggleProps = {
  value: Appearance;
  onChange: (next: Appearance) => void;
};

/** Pill track + sliding indigo thumb (Aikido-style), sun for light / moon for dark. */
export function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  const isDark = value === 'dark';
  return (
    <button
      type="button"
      className={`dw-theme-toggle${isDark ? ' dw-theme-toggle--dark' : ''}`}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => onChange(isDark ? 'light' : 'dark')}
    >
      <span className="dw-theme-toggle__track">
        <span className="dw-theme-toggle__thumb">
          {isDark ? <MoonIcon /> : <SunIcon />}
        </span>
        <SunIcon className="dw-theme-toggle__icon dw-theme-toggle__icon--sun" />
        <MoonIcon className="dw-theme-toggle__icon dw-theme-toggle__icon--moon" />
      </span>
    </button>
  );
}
