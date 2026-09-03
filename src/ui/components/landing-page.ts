/**
 * World-Class Landing Page Component for veditor
 * Renders an Obsidian OLED hero view with instant sample loader, recent files, and feature guide.
 */

import { getRecentDocuments, getDocumentSession } from '../../io/storage';
import { generateSamplePDF, createBlankNotebook } from '../../io/sample-pdf';
import { getIconSvg } from '../../utils/icons';

export interface LandingPageCallbacks {
  onOpenFile: () => void;
  onOpenBytes: (name: string, bytes: Uint8Array) => Promise<void>;
  onOpenRecent: (docId: string) => Promise<void>;
}

export class LandingPageComponent {
  private _container: HTMLElement;
  private _callbacks: LandingPageCallbacks;

  constructor(container: HTMLElement, callbacks: LandingPageCallbacks) {
    this._container = container;
    this._callbacks = callbacks;
  }

  public async render(): Promise<void> {
    let recentDocs: Array<{ id: string; name: string; pageCount: number; lastOpenedAt: number }> = [];
    try {
      recentDocs = await getRecentDocuments();
    } catch (_) {}

    this._container.innerHTML = `
      <div class="landing-container">
        <!-- Hero Section -->
        <div class="landing-hero">
          <div class="landing-badge">
            <span class="landing-badge-dot"></span>
            veditor v1.0 • Offline & Private
          </div>
          <h1 class="landing-title">Precision PDF Annotation & Freehand Ink</h1>
          <p class="landing-subtitle">
            Zero cloud telemetry, real stylus pressure curves, vector-perfect editing, and ultra-fast double-buffered rendering designed for large documents.
          </p>
        </div>

        <!-- Interactive Dropzone & Action Center -->
        <div class="landing-dropzone" id="landing-dropzone">
          <div class="dropzone-icon-wrapper">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>
          </div>
          <div class="dropzone-prompt">Drop your PDF file here, or click to browse</div>
          <div class="dropzone-hint">Supports all standard PDF documents, textbooks, and forms • 100% Client-Side</div>
          
          <div class="dropzone-actions" id="dropzone-actions-group">
            <button class="landing-btn-primary" id="landing-open-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              Open Local PDF
            </button>

            <button class="landing-btn-secondary" id="landing-sample-btn" title="Try veditor immediately with an interactive sample PDF">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Try Sample PDF
            </button>

            <button class="landing-btn-secondary" id="landing-notebook-btn" title="Create a fresh lined notebook">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              New Notebook
            </button>
          </div>
        </div>

        <!-- Recent Documents Shelf -->
        ${recentDocs.length > 0 ? `
          <div class="landing-section">
            <div class="landing-section-header">
              <div class="landing-section-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Recent Documents
              </div>
            </div>
            <div class="recent-grid">
              ${recentDocs.slice(0, 6).map(doc => `
                <div class="recent-card" data-recent-id="${doc.id}">
                  <div class="recent-card-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div class="recent-card-info">
                    <div class="recent-card-name" title="${doc.name}">${doc.name}</div>
                    <div class="recent-card-meta">${doc.pageCount ? doc.pageCount + ' pages • ' : ''}${this.formatRelativeTime(doc.lastOpenedAt)}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Feature Showcase -->
        <div class="features-grid">
          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(99,102,241,0.15); color:#818cf8;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>
            </div>
            <div class="feature-box-title">Apple Pencil & Stylus Support</div>
            <p class="feature-box-desc">Sub-pixel coalesced pointer events, natural tilt sensitivity, cubic Hermite spline smoothing, and adjustable pressure response curves.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(16,185,129,0.15); color:#34d399;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </div>
            <div class="feature-box-title">Zero-Flicker Double Buffering</div>
            <p class="feature-box-desc">Offscreen canvas rendering pipeline delivers silky-smooth continuous scrolling and instant page switching across 500+ page books.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(244,114,182,0.15); color:#f472b6;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
            </div>
            <div class="feature-box-title">Pixel & Segment Eraser</div>
            <p class="feature-box-desc">Choose between whole Stroke Erasing, Object Erasing, or surgical Pixel Slicing that divides ink strokes at exact contact points.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(59,130,246,0.15); color:#60a5fa;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div class="feature-box-title">100% Private & Offline</div>
            <p class="feature-box-desc">Runs entirely inside your browser sandbox. No server uploads, no analytics, no external tracking. Your documents never leave your machine.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(245,158,11,0.15); color:#fbbf24;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </div>
            <div class="feature-box-title">Vector-Perfect Export</div>
            <p class="feature-box-desc">Export annotated PDFs with native vector streams. Your notes and drawings stay razor-sharp when printed or zoomed on high-resolution screens.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(139,92,246,0.15); color:#a78bfa;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h8"/><path d="M6 16h.001"/></svg>
            </div>
            <div class="feature-box-title">Keyboard-First Flow</div>
            <p class="feature-box-desc">Blazing-fast single-key shortcuts for all tools, quick zoom presets, full Undo/Redo history, and instant command palette.</p>
          </div>
        </div>

        <!-- Shortcuts Quick Cheat Sheet -->
        <div class="shortcuts-sheet">
          <div style="font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 8px;">
            Keyboard Shortcuts Cheat Sheet
          </div>
          <div class="shortcuts-sheet-grid">
            <div class="shortcut-item"><span>Pen</span> <kbd class="shortcut-kbd">P</kbd></div>
            <div class="shortcut-item"><span>Highlighter</span> <kbd class="shortcut-kbd">H</kbd></div>
            <div class="shortcut-item"><span>Eraser</span> <kbd class="shortcut-kbd">E</kbd></div>
            <div class="shortcut-item"><span>Select</span> <kbd class="shortcut-kbd">V</kbd></div>
            <div class="shortcut-item"><span>Rectangle</span> <kbd class="shortcut-kbd">R</kbd></div>
            <div class="shortcut-item"><span>Ellipse</span> <kbd class="shortcut-kbd">O</kbd></div>
            <div class="shortcut-item"><span>Undo</span> <kbd class="shortcut-kbd">Ctrl+Z</kbd></div>
            <div class="shortcut-item"><span>Redo</span> <kbd class="shortcut-kbd">Ctrl+Y</kbd></div>
            <div class="shortcut-item"><span>Open File</span> <kbd class="shortcut-kbd">Ctrl+O</kbd></div>
            <div class="shortcut-item"><span>Export PDF</span> <kbd class="shortcut-kbd">Ctrl+S</kbd></div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    const dropzone = this._container.querySelector('#landing-dropzone');
    const openBtn = this._container.querySelector('#landing-open-btn');
    const sampleBtn = this._container.querySelector('#landing-sample-btn');
    const notebookBtn = this._container.querySelector('#landing-notebook-btn');

    // Click dropzone or open button
    openBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._callbacks.onOpenFile();
    });

    dropzone?.addEventListener('click', (e) => {
      // If clicked inside the buttons group, let button handlers run
      if ((e.target as HTMLElement).closest('#dropzone-actions-group')) return;
      this._callbacks.onOpenFile();
    });

    // Sample PDF loader
    sampleBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const bytes = await generateSamplePDF();
        await this._callbacks.onOpenBytes('Welcome to veditor.pdf', bytes);
      } catch (err: any) {
        console.error('Error generating sample PDF:', err);
      }
    });

    // Blank Notebook loader
    notebookBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const bytes = await createBlankNotebook('lined', 3);
        await this._callbacks.onOpenBytes('Blank Notebook.pdf', bytes);
      } catch (err: any) {
        console.error('Error generating blank notebook:', err);
      }
    });

    // Dropzone drag & drop
    dropzone?.addEventListener('dragover', (e: Event) => {
      const dragEvt = e as DragEvent;
      dragEvt.preventDefault();
      dropzone.classList.add('is-dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });

    dropzone?.addEventListener('drop', async (e: Event) => {
      const dragEvt = e as DragEvent;
      dragEvt.preventDefault();
      dropzone.classList.remove('is-dragover');
      if (dragEvt.dataTransfer?.files && dragEvt.dataTransfer.files[0]) {
        const file = dragEvt.dataTransfer.files[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this._callbacks.onOpenBytes(file.name, bytes);
      }
    });

    // Recent cards clicks
    this._container.querySelectorAll('[data-recent-id]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-recent-id');
        if (id) {
          await this._callbacks.onOpenRecent(id);
        }
      });
    });
  }

  private formatRelativeTime(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }
}
