import type { ToolType } from '../core/types';

export type ShortcutAction = Extract<ToolType,
  'select' | 'hand' | 'lasso' | 'pen' | 'highlighter' | 'eraser' |
  'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'text' | 'stamp' | 'redaction'>;

const STORAGE_KEY = 'veditor_shortcuts_v1';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  select: 'v', hand: 'space', lasso: 'q', pen: 'p', highlighter: 'h',
  eraser: 'e', rectangle: 'r', ellipse: 'o', line: 'l', arrow: 'a',
  polygon: 'g', text: 't', stamp: 'm', redaction: 'x'
};

function normalize(key: string): string {
  return key.toLowerCase().replace(/\s+/g, '');
}

class ShortcutManager {
  private bindings: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS };

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
        if (typeof saved[action] === 'string') this.bindings[action] = normalize(saved[action]);
      }
    } catch (_) {}
  }

  all(): Readonly<Record<ShortcutAction, string>> { return this.bindings; }
  actionForEvent(event: KeyboardEvent): ShortcutAction | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const key = normalize(event.key === ' ' ? 'space' : event.key);
    return (Object.keys(this.bindings) as ShortcutAction[])
      .find(action => this.bindings[action] === key) ?? null;
  }
  set(action: ShortcutAction, key: string): ShortcutAction | null {
    const normalized = normalize(key);
    const conflict = (Object.keys(this.bindings) as ShortcutAction[])
      .find(other => other !== action && this.bindings[other] === normalized) ?? null;
    if (conflict) return conflict;
    this.bindings[action] = normalized;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    return null;
  }
  reset(): void {
    this.bindings = { ...DEFAULT_SHORTCUTS };
    localStorage.removeItem(STORAGE_KEY);
  }
}

export const shortcutManager = new ShortcutManager();
