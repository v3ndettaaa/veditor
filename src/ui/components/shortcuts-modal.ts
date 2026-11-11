/**
 * Keyboard Shortcuts Modal Reference
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';

export class ShortcutsModalComponent {
  private _container: HTMLElement;
  private _wasOpen: boolean = false;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
  }

  public render(): void {
    if (!store.shortcutsModalOpen) {
      if (this._wasOpen) {
        this._wasOpen = false;
        const overlay = this._container.querySelector<HTMLElement>('#shortcuts-overlay');
        if (overlay) {
          overlay.classList.add('is-closing');
          window.setTimeout(() => {
            if (!store.shortcutsModalOpen) this._container.innerHTML = '';
          }, 150);
        } else {
          this._container.innerHTML = '';
        }
      }
      return;
    }
    if (this._wasOpen && this._container.querySelector('#shortcuts-overlay')) {
      return;
    }
    this._wasOpen = true;

    // Grouped so the reference scans by purpose rather than as one long list.
    const groups: Array<{ title: string; icon: string; items: Array<{ key: string; desc: string }> }> = [
      {
        title: tr('Tools', 'ابزارها'),
        icon: 'pen',
        items: [
          { key: 'V', desc: tr('Select & transform', 'انتخاب و تغییر شکل') },
          { key: 'Q', desc: tr('Lasso select', 'انتخاب کمند (آزاد)') },
          { key: 'Alt + drag', desc: tr('Lasso select from any tool', 'انتخاب کمند از درون هر ابزار') },
          { key: 'Space (hold)', desc: tr('Hand — drag to pan', 'ابزار دست — جابه‌جایی صفحه') },
          { key: 'Esc', desc: tr('Cancel marquee / close dialog', 'لغو انتخاب / بستن پنجره') },
          { key: 'P', desc: tr('Freehand pen', 'قلم آزاد') },
          { key: 'H', desc: tr('Highlighter', 'ماژیک هایلایت') },
          { key: 'E', desc: tr('Eraser', 'پاک‌کن') },
          { key: 'T', desc: tr('Text box', 'کادر متن') },
          { key: 'M', desc: tr('Stamp / image', 'مهر و تصویر') },
          { key: 'K', desc: tr('Signature', 'امضای دیجیتال') },
          { key: 'N', desc: tr('Scratchpad', 'چرک‌نویس شناور') }
        ]
      },
      {
        title: tr('Shapes', 'اشکال هندسی'),
        icon: 'rectangle',
        items: [
          { key: 'R', desc: tr('Rectangle', 'مستطیل') },
          { key: 'O', desc: tr('Ellipse', 'دایره / بیضی') },
          { key: 'L', desc: tr('Line', 'خط صاف') },
          { key: 'A', desc: tr('Arrow', 'پیکان (فلش)') },
          { key: 'G', desc: tr('Polygon', 'چندضلعی') }
        ]
      },
      {
        title: tr('View & navigation', 'نمایش و پیمایش'),
        icon: 'eye',
        items: [
          { key: 'Ctrl / Cmd  +', desc: tr('Zoom in', 'بزرگ‌نمایی') },
          { key: 'Ctrl / Cmd  −', desc: tr('Zoom out', 'کوچک‌نمایی') },
          { key: 'Double-click', desc: tr('Toggle 200% / fit width', 'تغییر بین بزرگ‌نمایی ۲۰۰٪ و عرض صفحه') },
          { key: '0', desc: tr('Fit to width', 'تنظیم به عرض صفحه') },
          { key: 'Alt + ←', desc: tr('Jump back to previous page', 'بازگشت به مکان قبلی پس از پرش صفحه') },
          { key: 'F', desc: tr('Toggle focus mode', 'حالت تمرکز') }
        ]
      },
      {
        title: tr('Editing & app', 'ویرایش و برنامه'),
        icon: 'command',
        items: [
          { key: 'Ctrl / Cmd  Z', desc: tr('Undo', 'واگرد (Undo)') },
          { key: 'Ctrl / Cmd  ⇧ Z', desc: tr('Redo', 'ازنو (Redo)') },
          { key: 'Ctrl / Cmd  S', desc: tr('Save', 'ذخیره در فایل فعلی') },
          { key: 'Ctrl / Cmd  ⇧ S', desc: tr('Save As', 'ذخیره به نام دیگر') },
          { key: 'Ctrl / Cmd  D', desc: tr('Duplicate selection', 'تکثیر انتخاب') },
          { key: 'Ctrl / Cmd  K', desc: tr('Command palette', 'پالت فرمان سریع') },
          { key: '?', desc: tr('This reference', 'همین راهنمای میانبرها') },
          { key: 'Esc', desc: tr('Dismiss / deselect', 'لغو انتخاب / بستن') },
          { key: 'Del / ⌫', desc: tr('Delete selection', 'حذف موارد انتخاب‌شده') }
        ]
      }
    ];

    this._container.innerHTML = `
      <div class="modal-overlay" id="shortcuts-overlay">
        <div class="modal-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-label="${t('shortcuts.title')}">
          <div class="panel-header">
            <span>${t('shortcuts.title')}</span>
            <button id="close-shortcuts-btn" class="icon-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">
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
