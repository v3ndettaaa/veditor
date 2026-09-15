import { en } from './en';
import { fa } from './fa';
import { store } from '../../core/store';

export type TranslationKey = keyof typeof en;

/**
 * Looks up a dotted key and substitutes `{name}` placeholders. Unknown keys
 * fall back to the key itself so a missing translation is visible rather than
 * blank.
 */
export function t(path: string, params?: Record<string, string | number>): string {
  const lang = store.appSettings.language;
  const dict = lang === 'fa' ? fa : en;

  const parts = path.split('.');
  let curr: any = dict;

  for (const part of parts) {
    if (curr && typeof curr === 'object' && part in curr) {
      curr = curr[part];
    } else {
      return path;
    }
  }

  if (typeof curr !== 'string') return path;
  if (!params) return curr;

  return curr.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}
