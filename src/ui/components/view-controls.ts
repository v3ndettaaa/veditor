/**
 * Floating View & Zoom Controls Component
 * Page navigation with interactive page-jump input field,
 * zoom presets, multi-angle rotation, and OLED dark document inversion.
 */

import { store } from '../../core/store';
import { viewportManager } from '../../core/viewport';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';

export class ViewControlsComponent {
  private _container: HTMLElement;
  private _invertDocument: boolean = false;
  private _isInitialized: boolean = false;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const doc = store.activeDocument;
    if (!doc) {
      this._container.style.display = 'none';
      this._isInitialized = false;
      return;
    }

    this._container.style.display = 'flex';
    const zoomPct = Math.round(store.zoom * 100);
    const currentPage = store.activePageIndex + 1;
    const totalPages = doc.pageCount;
    const currentRot = store.pageRotations[store.activePageIndex] || 0;

    // If already initialized in DOM, update selectively to avoid interrupting active user typing
    if (this._isInitialized && this._container.querySelector('#view-page-input')) {
      this.updateState(currentPage, totalPages, zoomPct, currentRot);
      return;
    }

    const inputWidth = Math.max(34, (String(totalPages).length + 1) * 9 + 10);

    this._container.innerHTML = `
      <button id="view-prev-page" class="view-btn" ${currentPage <= 1 ? 'disabled style="opacity:0.4;"' : ''} title="Previous Page">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>

      <div class="view-page-jump-box" style="display:flex; align-items:center; gap:4px; padding:0 2px;">
        <input
          id="view-page-input"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          value="${currentPage}"
          title="Type page number and press Enter to jump (1-${totalPages})"
          aria-label="Current page number"
          style="
            width: ${inputWidth}px;
            height: 24px;
            padding: 0 4px;
            font-size: 12px;
            font-weight: 600;
            text-align: center;
            border-radius: 4px;
            border: 1px solid var(--border-medium);
            background: var(--bg-surface-elevated);
            color: var(--text-primary);
            outline: none;
            transition: all 0.15s ease;
          "
        />
        <span style="font-size:12px; font-weight:600; color:var(--text-tertiary);">/</span>
        <span id="view-total-pages" style="font-size:12px; font-weight:600; color:var(--text-secondary); min-width:14px; text-align:center;">${totalPages}</span>
      </div>

      <button id="view-next-page" class="view-btn" ${currentPage >= totalPages ? 'disabled style="opacity:0.4;"' : ''} title="Next Page">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </button>

      <div class="toolbar-separator" style="height:16px;"></div>

      <button id="view-zoom-out" class="view-btn" title="Zoom Out (Ctrl -)">
        ${getIconSvg('zoomOut', 15)}
      </button>

      <span class="view-zoom-text">${zoomPct}%</span>

      <button id="view-zoom-in" class="view-btn" title="Zoom In (Ctrl +)">
        ${getIconSvg('zoomIn', 15)}
      </button>

      <div class="toolbar-separator" style="height:16px;"></div>

      <button id="view-fit-width" class="view-btn" title="${t('view.fitWidth')} (0)">
        ${getIconSvg('fitWidth', 15)}
      </button>

      <button id="view-fit-page" class="view-btn" title="${t('view.fitPage')}">
        ${getIconSvg('fitPage', 15)}
      </button>

      <div class="toolbar-separator" style="height:16px;"></div>

      <!-- Rotate CCW -->
      <button id="view-rotate-ccw" class="view-btn" title="Rotate 90° Counter-Clockwise">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      </button>

      <!-- Rotate CW -->
      <button id="view-rotate-cw" class="view-btn" title="Rotate 90° Clockwise (Shift+Click to rotate all)">
        ${getIconSvg('rotate', 15)}
        <span id="view-rotate-badge" style="position:absolute; bottom:2px; right:4px; font-size:8px; font-weight:700; color:var(--accent); ${currentRot === 0 ? 'display:none;' : ''}">${currentRot}°</span>
      </button>

      <div class="toolbar-separator" style="height:16px;"></div>

      <!-- OLED Dark Document Inversion Toggle -->
      <button id="view-invert-doc" class="view-btn ${this._invertDocument ? 'active' : ''}" title="Toggle Dark OLED Document Reading Mode">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z"/></svg>
      </button>
    `;

    this.bindEvents(totalPages);
    this._isInitialized = true;
  }

  private updateState(currentPage: number, totalPages: number, zoomPct: number, currentRot: number): void {
    const pageInput = this._container.querySelector<HTMLInputElement>('#view-page-input');
    const totalPagesSpan = this._container.querySelector<HTMLElement>('#view-total-pages');
    const prevBtn = this._container.querySelector<HTMLButtonElement>('#view-prev-page');
    const nextBtn = this._container.querySelector<HTMLButtonElement>('#view-next-page');
    const zoomSpan = this._container.querySelector<HTMLElement>('.view-zoom-text');
    const rotBadge = this._container.querySelector<HTMLElement>('#view-rotate-badge');
    const invertBtn = this._container.querySelector<HTMLElement>('#view-invert-doc');

    // Only update input value if user is not actively typing/focused in it
    if (pageInput && document.activeElement !== pageInput) {
      pageInput.value = String(currentPage);
      const inputWidth = Math.max(34, (String(totalPages).length + 1) * 9 + 10);
      pageInput.style.width = `${inputWidth}px`;
    }

    if (totalPagesSpan) {
      totalPagesSpan.textContent = String(totalPages);
    }

    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
      prevBtn.style.opacity = currentPage <= 1 ? '0.4' : '1';
    }

    if (nextBtn) {
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.style.opacity = currentPage >= totalPages ? '0.4' : '1';
    }

    if (zoomSpan) {
      zoomSpan.textContent = `${zoomPct}%`;
    }

    if (rotBadge) {
      rotBadge.textContent = `${currentRot}°`;
      rotBadge.style.display = currentRot === 0 ? 'none' : 'block';
    }

    if (invertBtn) {
      invertBtn.classList.toggle('active', this._invertDocument);
    }
  }

  private bindEvents(totalPages: number): void {
    const pageInput = this._container.querySelector<HTMLInputElement>('#view-page-input');

    const commitPageJump = () => {
      if (!pageInput) return;
      const raw = pageInput.value.trim();
      const num = parseInt(raw, 10);
      if (!isNaN(num)) {
        const clamped = Math.max(1, Math.min(totalPages, num));
        pageInput.value = String(clamped);
        if (clamped - 1 !== store.activePageIndex) {
          viewportManager.scrollToPage(clamped - 1);
        }
      } else {
        pageInput.value = String(store.activePageIndex + 1);
      }
    };

    if (pageInput) {
      pageInput.addEventListener('focus', () => {
        pageInput.select();
        pageInput.style.borderColor = 'var(--accent)';
        pageInput.style.boxShadow = '0 0 0 2px var(--accent-subtle)';
      });

      pageInput.addEventListener('blur', () => {
        pageInput.style.borderColor = 'var(--border-medium)';
        pageInput.style.boxShadow = 'none';
        commitPageJump();
      });

      pageInput.addEventListener('keydown', (e: KeyboardEvent) => {
        // Prevent triggering document tool shortcuts (p, e, v, 0, etc.)
        e.stopPropagation();

        if (e.key === 'Enter') {
          e.preventDefault();
          commitPageJump();
          pageInput.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          pageInput.value = String(store.activePageIndex + 1);
          pageInput.blur();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (store.activePageIndex > 0) {
            viewportManager.scrollToPage(store.activePageIndex - 1);
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (store.activePageIndex < totalPages - 1) {
            viewportManager.scrollToPage(store.activePageIndex + 1);
          }
        }
      });
    }

    this._container.querySelector('#view-prev-page')?.addEventListener('click', () => {
      if (store.activePageIndex > 0) {
        viewportManager.scrollToPage(store.activePageIndex - 1);
      }
    });

    this._container.querySelector('#view-next-page')?.addEventListener('click', () => {
      if (store.activePageIndex < totalPages - 1) {
        viewportManager.scrollToPage(store.activePageIndex + 1);
      }
    });

    this._container.querySelector('#view-zoom-in')?.addEventListener('click', () => {
      store.setZoom(store.zoom * 1.15);
      viewportManager.updateLayout(true);
    });

    this._container.querySelector('#view-zoom-out')?.addEventListener('click', () => {
      store.setZoom(store.zoom / 1.15);
      viewportManager.updateLayout(true);
    });

    this._container.querySelector('#view-fit-width')?.addEventListener('click', () => {
      viewportManager.fitToWidth();
    });

    this._container.querySelector('#view-fit-page')?.addEventListener('click', () => {
      viewportManager.fitToPage();
    });

    this._container.querySelector('#view-rotate-cw')?.addEventListener('click', (e: MouseEvent) => {
      const doc = store.activeDocument;
      if (e.shiftKey && doc) {
        for (let i = 0; i < doc.pageCount; i++) {
          store.rotatePage(i, 90);
        }
      } else {
        store.rotatePage(store.activePageIndex, 90);
      }
      viewportManager.updateLayout(true);
    });

    this._container.querySelector('#view-rotate-ccw')?.addEventListener('click', (e: MouseEvent) => {
      const doc = store.activeDocument;
      if (e.shiftKey && doc) {
        for (let i = 0; i < doc.pageCount; i++) {
          store.rotatePage(i, -90);
        }
      } else {
        store.rotatePage(store.activePageIndex, -90);
      }
      viewportManager.updateLayout(true);
    });

    this._container.querySelector('#view-invert-doc')?.addEventListener('click', () => {
      this._invertDocument = !this._invertDocument;
      document.body.classList.toggle('invert-pdf-document', this._invertDocument);
      const invertBtn = this._container.querySelector<HTMLElement>('#view-invert-doc');
      invertBtn?.classList.toggle('active', this._invertDocument);
    });
  }
}
