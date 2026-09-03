import { en } from './en';
import { fa } from './fa';
import { store } from '../../core/store';

export type TranslationKey = keyof typeof en;

export function t(path: string): string {
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

  return typeof curr === 'string' ? curr : path;
}
