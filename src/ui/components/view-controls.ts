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
  /** Lens state the current DOM was built for (chip visibility). */
  private _lensActiveRendered: boolean = false;
  /** Document the bound listeners / clamped totals belong to. */
  private _boundDocId: string | null = null;
  /** Set while Enter commits, so the ensuing blur doesn't commit twice. */
  private _enterCommitted: boolean = false;

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
      this._boundDocId = null;
      return;
    }

    // A new / switched document changes the page count: bound listeners close
    // over the old total, so force a full rebuild + rebind instead of the
    // selective-update path (stale clamps sent jumps to the wrong page).
    if (this._boundDocId !== null && this._boundDocId !== doc.id) {
      this._isInitialized = false;
    }

    this._container.style.display = 'flex';
    const zoomPct = Math.round(store.zoom * 100);
    const currentPage = store.activePageIndex + 1;
    const totalPages = doc.pageCount;
    const currentRot = store.pageRotations[store.activePageIndex] || 0;

    // If already initialized in DOM, update selectively to avoid interrupting active user typing
    if (this._isInitialized && this._container.querySelector('#view-page-input') &&
        this._lensActiveRendered === store.zoomLensActive) {
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

      <input
        id="view-zoom-input"
        class="view-zoom-text view-zoom-input"
        type="text"
        inputmode="decimal"
        value="${zoomPct}%"
        title="Type zoom % (20-800) and press Enter"
        aria-label="Zoom percent"
        style="background:transparent; border:1px solid transparent; border-radius:4px; outline:none; width:52px;"
      />

      <button id="view-zoom-in" class="view-btn" title="Zoom In (Ctrl +)">
        ${getIconSvg('zoomIn', 15)}
      </button>

      ${store.zoomLensActive ? `
        <button id="view-exit-lens" class="view-btn active" title="Exit zoom and restore ${Math.round((store.zoomLensBase ?? store.zoom) * 100)}% (Esc)">
          ${getIconSvg('zoomOut', 15)}
        </button>
      ` : ''}

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

    this.bindEvents();
    this._isInitialized = true;
    this._boundDocId = doc.id;
    this._lensActiveRendered = store.zoomLensActive;
  }

  private updateState(currentPage: number, totalPages: number, zoomPct: number, currentRot: number): void {
    const pageInput = this._container.querySelector<HTMLInputElement>('#view-page-input');
    const totalPagesSpan = this._container.querySelector<HTMLElement>('#view-total-pages');
    const prevBtn = this._container.querySelector<HTMLButtonElement>('#view-prev-page');
    const nextBtn = this._container.querySelector<HTMLButtonElement>('#view-next-page');
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

    const zoomInput = this._container.querySelector<HTMLInputElement>('#view-zoom-input');
    if (zoomInput && document.activeElement !== zoomInput) {
      zoomInput.value = `${zoomPct}%`;
    }

    if (rotBadge) {
      rotBadge.textContent = `${currentRot}°`;
      rotBadge.style.display = currentRot === 0 ? 'none' : 'block';
    }

    if (invertBtn) {
      invertBtn.classList.toggle('active', this._invertDocument);
    }
  }

  private bindEvents(): void {
    const pageInput = this._container.querySelector<HTMLInputElement>('#view-page-input');
    // Page totals come from the LIVE document, never a bind-time closure
    // (stale totals after tab switches clamped jumps to the wrong page).
    const liveTotalPages = () => store.activeDocument?.pageCount ?? 1;

    const commitPageJump = () => {
      if (!pageInput) return;
      const total = liveTotalPages();
      const raw = pageInput.value.trim();
      const num = parseInt(raw, 10);
      if (!isNaN(num)) {
        const clamped = Math.max(1, Math.min(total, num));
        pageInput.value = String(clamped);
        // scrollToPage is robust across view modes (activates + lays out the
        // target spread first when its layout is missing).
        viewportManager.scrollToPage(clamped - 1);
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
        // Enter already committed; skip so the jump isn't issued twice.
        if (this._enterCommitted) {
          this._enterCommitted = false;
          return;
        }
        // Clicking away with an unchanged value is not a jump.
        if (pageInput.value.trim() !== String(store.activePageIndex + 1)) {
          commitPageJump();
        }
      });

      pageInput.addEventListener('keydown', (e: KeyboardEvent) => {
        // Prevent triggering document tool shortcuts (p, e, v, 0, etc.)
        e.stopPropagation();

        if (e.key === 'Enter') {
          e.preventDefault();
          this._enterCommitted = true;
          commitPageJump();
          pageInput.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this._enterCommitted = true;
          pageInput.value = String(store.activePageIndex + 1);
          pageInput.blur();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (store.activePageIndex > 0) {
            viewportManager.scrollToPage(store.activePageIndex - 1);
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (store.activePageIndex < liveTotalPages() - 1) {
            viewportManager.scrollToPage(store.activePageIndex + 1);
          }
        }
      });
    }

    const zoomInput = this._container.querySelector<HTMLInputElement>('#view-zoom-input');
    const commitZoom = () => {
      if (!zoomInput) return;
      const num = parseFloat(zoomInput.value.replace('%', '').trim());
      if (!isNaN(num)) {
        const clamped = Math.max(20, Math.min(800, num));
        store.setZoom(clamped / 100);
        viewportManager.updateLayout(true);
      }
      zoomInput.value = `${Math.round(store.zoom * 100)}%`;
    };

    if (zoomInput) {
      zoomInput.addEventListener('focus', () => {
        zoomInput.select();
        zoomInput.style.borderColor = 'var(--accent)';
      });
      zoomInput.addEventListener('blur', () => {
        zoomInput.style.borderColor = 'transparent';
        if (zoomInput.value.trim() !== `${Math.round(store.zoom * 100)}%`) {
          commitZoom();
        }
      });
      zoomInput.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitZoom();
          zoomInput.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          zoomInput.value = `${Math.round(store.zoom * 100)}%`;
          zoomInput.blur();
        }
      });
    }

    this._container.querySelector('#view-prev-page')?.addEventListener('click', () => {
      if (store.activePageIndex > 0) {
        viewportManager.scrollToPage(store.activePageIndex - 1);
      }
    });

    this._container.querySelector('#view-next-page')?.addEventListener('click', () => {
      const total = store.activeDocument?.pageCount ?? 1;
      if (store.activePageIndex < total - 1) {
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

    this._container.querySelector('#view-exit-lens')?.addEventListener('click', () => {
      store.exitZoomLens();
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
