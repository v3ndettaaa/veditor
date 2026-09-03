/**
 * Floating View & Zoom Controls Component
 * Page navigation, zoom presets, multi-angle rotation, and OLED dark document inversion.
 */

import { store } from '../../core/store';
import { viewportManager } from '../../core/viewport';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';

export class ViewControlsComponent {
  private _container: HTMLElement;
  private _invertDocument: boolean = false;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const doc = store.activeDocument;
    if (!doc) {
      this._container.style.display = 'none';
      return;
    }

    this._container.style.display = 'flex';
    const zoomPct = Math.round(store.zoom * 100);
    const currentPage = store.activePageIndex + 1;
    const totalPages = doc.pageCount;
    const currentRot = store.pageRotations[store.activePageIndex] || 0;

    this._container.innerHTML = `
      <button id="view-prev-page" class="view-btn" ${currentPage <= 1 ? 'disabled style="opacity:0.4;"' : ''} title="Previous Page">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>

      <span style="font-size:12px; font-weight:600; padding:0 4px; color:var(--text-secondary);">
        ${currentPage} / ${totalPages}
      </span>

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
        ${currentRot !== 0 ? `<span style="position:absolute; bottom:2px; right:4px; font-size:8px; font-weight:700; color:var(--accent);">${currentRot}°</span>` : ''}
      </button>

      <div class="toolbar-separator" style="height:16px;"></div>

      <!-- OLED Dark Document Inversion Toggle -->
      <button id="view-invert-doc" class="view-btn ${this._invertDocument ? 'active' : ''}" title="Toggle Dark OLED Document Reading Mode">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z"/></svg>
      </button>
    `;

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
      this.render();
    });
  }
}
