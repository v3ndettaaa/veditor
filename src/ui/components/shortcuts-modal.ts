/**
 * Keyboard Shortcuts Modal Reference
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';

export class ShortcutsModalComponent {
  private _container: HTMLElement;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
  }

  public render(): void {
    if (!store.shortcutsModalOpen) {
      this._container.innerHTML = '';
      return;
    }

    const shortcuts = [
      { key: 'V', desc: 'Select & Transform Tool' },
      { key: 'P', desc: 'Freehand Pen Tool' },
      { key: 'H', desc: 'Highlighter Tool' },
      { key: 'E', desc: 'Eraser Tool' },
      { key: 'R', desc: 'Rectangle Shape' },
      { key: 'O', desc: 'Ellipse Shape' },
      { key: 'L', desc: 'Line Tool' },
      { key: 'A', desc: 'Arrow Tool' },
      { key: 'T', desc: 'Text Box' },
      { key: 'M', desc: 'Stamp / Image' },
      { key: 'C', desc: 'Callout Bubble' },
      { key: 'K', desc: 'Signature Tool' },
      { key: 'X', desc: 'Redaction Tool' },
      { key: 'Z', desc: 'Laser Pointer' },
      { key: 'Ctrl + K / Cmd + K', desc: 'Command Palette' },
      { key: 'Ctrl + Z / Cmd + Z', desc: 'Undo' },
      { key: 'Ctrl + Shift + Z', desc: 'Redo' },
      { key: 'Ctrl + + / -', desc: 'Zoom In / Out' },
      { key: '0', desc: 'Fit to Width' },
      { key: 'F', desc: 'Toggle Focus Mode' },
      { key: '?', desc: 'Show Shortcuts Modal' }
    ];

    this._container.innerHTML = `
      <div class="modal-overlay" id="shortcuts-overlay">
        <div class="modal-dialog" style="max-width:540px;">
          <div class="panel-header">
            <span>${t('shortcuts.title')}</span>
            <button id="close-shortcuts-btn" class="header-btn" style="padding:4px;">
              ${getIconSvg('close', 14)}
            </button>
          </div>
          <div class="panel-body" style="display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:16px;">
            ${shortcuts.map(s => `
              <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--bg-surface-elevated); border-radius:6px; border:1px solid var(--border-subtle); font-size:12px;">
                <span style="color:var(--text-secondary);">${s.desc}</span>
                <span style="font-family:monospace; background:var(--bg-surface-hover); color:var(--text-primary); padding:2px 6px; border-radius:4px; font-weight:600; font-size:11px;">${s.key}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const overlay = this._container.querySelector('#shortcuts-overlay');
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setShortcutsModalOpen(false);
    });

    this._container.querySelector('#close-shortcuts-btn')?.addEventListener('click', () => {
      store.setShortcutsModalOpen(false);
    });
  }
}
