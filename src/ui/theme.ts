/**
 * Appearance application - the single owner of the document-level presentation
 * state (theme, accent hue, density, language direction and page chrome).
 *
 * Every control that changes appearance routes through `applyAppearance` so the
 * classes stay consistent. Assigning `body.className` directly from individual
 * components used to drop whichever flags that component did not know about.
 */

import { store } from '../core/store';
import { AppSettings } from '../core/types';

export const DEFAULT_ACCENT = '#6366f1';

/** Body classes owned by `applyAppearance`; anything else on body is preserved. */
const OWNED_CLASSES = [
  'theme-dark',
  'theme-light',
  'density-compact',
  'no-page-shadows',
  'focus-mode'
];

export interface AppearanceOverrides {
  focusMode?: boolean;
}

/**
 * Reflects the saved settings onto <html> and <body>.
 *
 * The accent is set on the document element as an inline custom property. The
 * theme blocks in tokens.css intentionally never declare `--accent`, so this
 * override cascades into the whole document and all accent-derived tokens
 * (hover, subtle, glow, border, gradient) recompute from it.
 */
function applyAppearance(settings: AppSettings, overrides: AppearanceOverrides = {}): void {
  const root = document.documentElement;
  const body = document.body;

  root.style.setProperty('--accent', settings.accentColor || DEFAULT_ACCENT);

  root.setAttribute('dir', settings.language === 'fa' ? 'rtl' : 'ltr');
  root.setAttribute('lang', settings.language);

  body.classList.remove(...OWNED_CLASSES);
  body.classList.add(`theme-${settings.theme}`);
  if (settings.uiDensity === 'compact') body.classList.add('density-compact');
  if (!settings.showPageShadows) body.classList.add('no-page-shadows');
  if (overrides.focusMode) body.classList.add('focus-mode');
}

/**
 * Reflects the store onto the document once, then on every store change.
 *
 * Components therefore only have to update the store - `updateAppSettings`,
 * `toggleFocusMode` - and the presentation follows automatically.
 */
export function initAppearanceSync(): void {
  const sync = () => applyAppearance(store.appSettings, { focusMode: store.focusMode });
  sync();
  store.subscribe(sync);
}

/**
 * One-shot variant for surfaces that never mutate settings, such as the browser
 * action popup. The popup shares an origin with the editor, so the store has
 * already restored the same persisted theme and accent from localStorage.
 */
export function applySavedAppearance(): void {
  applyAppearance(store.appSettings);
}
