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

    // Grouped so the reference scans by purpose rather than as one long list.
    const groups: Array<{ title: string; icon: string; items: Array<{ key: string; desc: string }> }> = [
      {
        title: 'Tools',
        icon: 'pen',
        items: [
          { key: 'V', desc: 'Select & transform' },
          { key: 'Space (hold)', desc: 'Hand — drag to pan' },
          { key: 'Esc', desc: 'Exit zoom lens / cancel marquee' },
          { key: 'P', desc: 'Freehand pen' },
          { key: 'H', desc: 'Highlighter' },
          { key: 'E', desc: 'Eraser' },
          { key: 'T', desc: 'Text box' },
          { key: 'M', desc: 'Stamp / image' },
          { key: 'C', desc: 'Callout bubble' },
          { key: 'K', desc: 'Signature' },
          { key: 'X', desc: 'Redaction' },
          { key: 'Z', desc: 'Laser pointer' }
        ]
      },
      {
        title: 'Shapes',
        icon: 'rectangle',
        items: [
          { key: 'R', desc: 'Rectangle' },
          { key: 'O', desc: 'Ellipse' },
          { key: 'L', desc: 'Line' },
          { key: 'A', desc: 'Arrow' },
          { key: 'G', desc: 'Polygon' }
        ]
      },
      {
        title: 'View & navigation',
        icon: 'eye',
        items: [
          { key: 'Ctrl / Cmd  +', desc: 'Zoom in' },
          { key: 'Ctrl / Cmd  −', desc: 'Zoom out' },
          { key: '0', desc: 'Fit to width' },
          { key: 'F', desc: 'Toggle focus mode' }
        ]
      },
      {
        title: 'Editing & app',
        icon: 'command',
        items: [
          { key: 'Ctrl / Cmd  Z', desc: 'Undo' },
          { key: 'Ctrl / Cmd  ⇧ Z', desc: 'Redo' },
          { key: 'Ctrl / Cmd  K', desc: 'Command palette' },
          { key: '?', desc: 'This reference' },
          { key: 'Esc', desc: 'Dismiss / deselect' },
          { key: 'Del / ⌫', desc: 'Delete selection' }
        ]
      }
    ];

    this._container.innerHTML = `
      <div class="modal-overlay" id="shortcuts-overlay">
        <div class="modal-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-label="${t('shortcuts.title')}">
          <div class="panel-header">
            <span>${t('shortcuts.title')}</span>
            <button id="close-shortcuts-btn" class="icon-btn" title="Close" aria-label="Close">
              ${getIconSvg('close', 14)}
            </button>
          </div>
          <div class="panel-body shortcuts-body">
            ${groups.map(g => `
              <section class="shortcuts-group">
                <h3 class="shortcuts-group-title">
                  <span class="shortcuts-group-icon">${getIconSvg(g.icon, 13)}</span>
                  ${g.title}
                </h3>
                <div class="panel-stack">
                  ${g.items.map(s => `
                    <div class="shortcut-row">
                      <span>${s.desc}</span>
                      <span class="kbd">${s.key}</span>
                    </div>
                  `).join('')}
                </div>
              </section>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const overlay = this._container.querySelector('#shortcuts-overlay');
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setShortcutsModalOpen(false);
    });

    this._container.querySelector<HTMLElement>('#close-shortcuts-btn')?.focus();

    this._container.querySelector('#close-shortcuts-btn')?.addEventListener('click', () => {
      store.setShortcutsModalOpen(false);
    });
  }
}
