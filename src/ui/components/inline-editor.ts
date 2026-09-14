/**
 * Lightweight inline text editor overlaying a canvas annotation.
 * A floating textarea committed with Esc/Enter/blur and cancelled with
 * Ctrl+Z-style Tab-out. Used by the callout tool (and reusable for text).
 */

export interface InlineEditorOptions {
  /** Screen-space rect (CSS px) to cover. */
  rect: { left: number; top: number; width: number; height: number };
  value: string;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  placeholder?: string;
  onCommit: (text: string) => void;
  onCancel?: () => void;
}

export function openInlineEditor(options: InlineEditorOptions): void {
  const { rect, value, onCommit, onCancel } = options;
  const area = document.createElement('textarea');
  area.className = 'inline-annotation-editor';
  area.value = value;
  area.spellcheck = false;
  area.placeholder = options.placeholder ?? '';
  Object.assign(area.style, {
    position: 'fixed',
    left: `${Math.max(0, rect.left)}px`,
    top: `${Math.max(0, rect.top)}px`,
    width: `${Math.max(80, rect.width)}px`,
    height: `${Math.max(30, rect.height)}px`,
    zIndex: '2000',
    resize: 'none',
    overflow: 'hidden',
    border: '1px solid var(--accent, #6366f1)',
    borderRadius: '6px',
    padding: '4px 6px',
    background: 'var(--bg-elevated, #1e1e2e)',
    color: options.color || 'var(--text-primary, #e5e7eb)',
    font: `${options.fontSize ?? 14}px "${options.fontFamily ?? 'Inter'}", sans-serif`,
    lineHeight: '1.3',
    outline: 'none',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
  });

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const text = area.value;
    area.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    if (commit) onCommit(text);
    else onCancel?.();
  };

  const autoGrow = () => {
    area.style.height = `${Math.max(30, area.scrollHeight)}px`;
  };

  const onOutside = (e: PointerEvent) => {
    if (!area.contains(e.target as Node)) finish(true);
  };

  area.addEventListener('input', autoGrow);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
    e.stopPropagation();
  });
  // Defer so the click that created the editor doesn't immediately close it.
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);

  document.body.appendChild(area);
  area.focus();
  area.select();
  autoGrow();
}
