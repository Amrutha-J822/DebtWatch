export type Appearance = 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'debtwatch-appearance';

export function readStoredAppearance(): Appearance {
  try {
    const s = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}
