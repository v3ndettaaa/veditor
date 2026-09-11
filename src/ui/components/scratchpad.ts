/**
 * Floating Scratchpad / Draft Overlay.
 * Viewport-fixed panel (sibling of the scroll container, never inside the
 * zoom-scaled pages wrapper) for quick rough notes, formulas, and scribbles.
 * Strokes are normalized (0..1) so panel resizes never distort content, and
 * are scoped per document tab. Explicit Insert sends them to the active page
 * as real pen annotations (single undo step per stroke); PNG export downloads
 * the pad as an image.
 */

import { store } from '../../core/store';
import { history, AddAnnotationCommand } from '../../core/history';
import { getIconSvg } from '../../utils/icons';
import { showToast } from './toast';
import { t } from '../i18n';
import type { PenAnnotation, StrokePoint } from '../../core/types';
import { computePointsBoundingBox } from '../../utils/geometry';

interface PadStroke {
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

interface PadGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GEOM_KEY = 'veditor_scratchpad_geom';
const DEFAULT_GEOM: PadGeom = { x: -340, y: 70, w: 300, h: 380 };
const MIN_W = 200;
const MIN_H = 160;

function loadGeom(): PadGeom {
  try {
    const raw = localStorage.getItem(GEOM_KEY);
    if (raw) {
      const g = JSON.parse(raw) as Partial<PadGeom>;
      return {
        x: typeof g.x === 'number' ? g.x : DEFAULT_GEOM.x,
        y: typeof g.y === 'number' ? g.y : DEFAULT_GEOM.y,
        w: Math.max(MIN_W, typeof g.w === 'number' ? g.w : DEFAULT_GEOM.w),
        h: Math.max(MIN_H, typeof g.h === 'number' ? g.h : DEFAULT_GEOM.h)
      };
    }
  } catch (_) {}
  return { ...DEFAULT_GEOM };
}

export class ScratchpadComponent {
  private _container: HTMLElement;
  private _built = false;
  private _docId: string | null = null;
  private _strokesByDoc = new Map<string, PadStroke[]>();
  private _mode: 'pen' | 'eraser' = 'pen';
  private _drawing = false;
  private _activeStroke: Array<{ x: number; y: number }> | null = null;
  private _geom: PadGeom = loadGeom();

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.sync());
    this.render();
  }

  private get strokes(): PadStroke[] {
    const id = store.activeDocument?.id;
    if (!id) return [];
    let list = this._strokesByDoc.get(id);
    if (!list) {
      list = [];
      this._strokesByDoc.set(id, list);
    }
    return list;
  }

  public render(): void {
    if (this._built) {
      this.sync();
      return;
    }
    this._container.innerHTML = `
      <div id="scratchpad-panel" class="scratchpad-panel" style="display:none;">
        <div id="scratchpad-header" class="scratchpad-header">
          <span class="scratchpad-title">${getIconSvg('scratchpad', 14)}<span>${t('tools.scratchpad')}</span></span>
          <div class="scratchpad-header-btns">
            <button id="scratchpad-pen-btn" class="view-btn active" title="Pen">${getIconSvg('pen', 14)}</button>
            <button id="scratchpad-eraser-btn" class="view-btn" title="Eraser">${getIconSvg('eraser', 14)}</button>
            <button id="scratchpad-min-btn" class="view-btn" title="Minimize">–</button>
            <button id="scratchpad-close-btn" class="view-btn" title="Close">✕</button>
          </div>
        </div>
        <div class="scratchpad-body">
          <canvas id="scratchpad-canvas" class="scratchpad-canvas"></canvas>
          <div id="scratchpad-resize" class="scratchpad-resize" title="Resize"></div>
        </div>
        <div class="scratchpad-footer">
          <div class="scratchpad-widths">
            <button data-pad-w="2" class="pad-pill">2</button>
            <button data-pad-w="4" class="pad-pill active">4</button>
            <button data-pad-w="8" class="pad-pill">8</button>
          </div>
          <div class="scratchpad-actions">
            <button id="scratchpad-clear-btn" class="header-btn" title="Clear pad">${getIconSvg('trash', 13)}</button>
            <button id="scratchpad-export-btn" class="header-btn" title="Export as PNG">${getIconSvg('download', 13)}</button>
            <button id="scratchpad-insert-btn" class="header-btn primary" title="Insert into active page">Insert</button>
          </div>
        </div>
      </div>
    `;
    this._built = true;
    this.bindChrome();
    this.bindCanvas();
    this.applyGeom();
    this.sync();
  }

  private get panel(): HTMLElement | null {
    return this._container.querySelector<HTMLElement>('#scratchpad-panel');
  }

  private get canvas(): HTMLCanvasElement | null {
    return this._container.querySelector<HTMLCanvasElement>('#scratchpad-canvas');
  }

  private _padWidth = 4;
  private _padColor = '#f8fafc';

  /** Visibility + button states only — never rebuilds the canvas element. */
  private sync(): void {
    const panel = this.panel;
    if (!panel) return;
    const doc = store.activeDocument;
    const visible = store.scratchpadOpen && !store.scratchpadMinimized && !!doc;
    panel.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    if (this._docId !== (doc?.id ?? null)) {
      this._docId = doc?.id ?? null;
      this._activeStroke = null;
      this._drawing = false;
      this.fitCanvas();
      this.redraw();
    }
    this._container.querySelector('#scratchpad-pen-btn')?.classList.toggle('active', this._mode === 'pen');
    this._container.querySelector('#scratchpad-eraser-btn')?.classList.toggle('active', this._mode === 'eraser');
  }

  private persistGeom(): void {
    try {
      localStorage.setItem(GEOM_KEY, JSON.stringify(this._geom));
    } catch (_) {}
  }

  private applyGeom(): void {
    const panel = this.panel;
    if (!panel) return;
    const host = this._container.parentElement;
    const hostW = host?.clientWidth || window.innerWidth;
    // Negative x docks from the right edge (robust across viewport sizes).
    const left = this._geom.x < 0 ? Math.max(8, hostW + this._geom.x - this._geom.w) : this._geom.x;
    panel.style.left = `${Math.max(0, left)}px`;
    panel.style.top = `${Math.max(0, this._geom.y)}px`;
    panel.style.width = `${this._geom.w}px`;
    panel.style.height = `${this._geom.h}px`;
    this.fitCanvas();
    this.redraw();
  }

  private fitCanvas(): void {
    const canvas = this.canvas;
    const panel = this.panel;
    if (!canvas || !panel) return;
    const body = panel.querySelector<HTMLElement>('.scratchpad-body');
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${Math.max(1, Math.floor(rect.width))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(rect.height))}px`;
  }

  private toNorm(e: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    };
  }

  private redraw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const draw = (pts: Array<{ x: number; y: number }>, color: string, width: number) => {
      if (pts.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath();
      if (pts.length === 1) {
        const x = pts[0].x * canvas.width;
        const y = pts[0].y * canvas.height;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 0.01, y + 0.01);
      } else {
        ctx.moveTo(pts[0].x * canvas.width, pts[0].y * canvas.height);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * canvas.width, pts[i].y * canvas.height);
        }
      }
      ctx.stroke();
    };
    for (const s of this.strokes) draw(s.points, s.color, s.width);
    if (this._drawing && this._activeStroke && this._activeStroke.length > 0) {
      draw(this._activeStroke, this._padColor, this._padWidth);
    }
  }

  private bindChrome(): void {
    const header = this._container.querySelector<HTMLElement>('#scratchpad-header');
    const panel = this.panel;
    // Drag to move (header only so canvas strokes never move the panel).
    header?.addEventListener('pointerdown', (e) => {
      if (!panel || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      try {
        header.setPointerCapture(e.pointerId);
      } catch (_) {}
      const host = this._container.parentElement;
      const hostW = host?.clientWidth || window.innerWidth;
      const startX = e.clientX;
      const startY = e.clientY;
      const origLeft = panel.offsetLeft;
      const origTop = panel.offsetTop;
      const move = (ev: PointerEvent) => {
        const nl = Math.min(Math.max(0, origLeft + ev.clientX - startX), Math.max(0, hostW - 80));
        const nt = Math.max(0, origTop + ev.clientY - startY);
        panel.style.left = `${nl}px`;
        panel.style.top = `${nt}px`;
      };
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', up);
        // Store docked-from-right when near it so resizes keep it docked.
        const left = panel.offsetLeft;
        this._geom.x = left + this._geom.w > hostW - 60 ? left - hostW + this._geom.w : left;
        this._geom.y = panel.offsetTop;
        this.persistGeom();
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
    });

    // Corner resize.
    const grip = this._container.querySelector<HTMLElement>('#scratchpad-resize');
    grip?.addEventListener('pointerdown', (e) => {
      if (!panel) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {}
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = this._geom.w;
      const startH = this._geom.h;
      const move = (ev: PointerEvent) => {
        this._geom.w = Math.max(MIN_W, startW + ev.clientX - startX);
        this._geom.h = Math.max(MIN_H, startH + ev.clientY - startY);
        panel.style.width = `${this._geom.w}px`;
        panel.style.height = `${this._geom.h}px`;
        this.fitCanvas();
        this.redraw();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        this.persistGeom();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });

    this._container.querySelector('#scratchpad-pen-btn')?.addEventListener('click', () => {
      this._mode = 'pen';
      this.sync();
    });
    this._container.querySelector('#scratchpad-eraser-btn')?.addEventListener('click', () => {
      this._mode = 'eraser';
      this.sync();
    });
    this._container.querySelector('#scratchpad-min-btn')?.addEventListener('click', () => {
      store.setScratchpadMinimized(true);
    });
    this._container.querySelector('#scratchpad-close-btn')?.addEventListener('click', () => {
      store.setScratchpadOpen(false);
    });
    this._container.querySelectorAll('[data-pad-w]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._padWidth = Number((btn as HTMLElement).dataset.padW) || 4;
        this._container.querySelectorAll('[data-pad-w]').forEach(b => b.classList.toggle('active', b === btn));
        this._mode = 'pen';
        this.sync();
      });
    });
    this._container.querySelector('#scratchpad-clear-btn')?.addEventListener('click', () => {
      if (this.strokes.length === 0) return;
      if (!window.confirm('Clear the scratchpad?')) return;
      this.strokes.length = 0;
      this.redraw();
    });
    this._container.querySelector('#scratchpad-export-btn')?.addEventListener('click', () => {
      const canvas = this.canvas;
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (!blob) {
          showToast('Nothing to export', 'error');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scratchpad.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showToast('Scratchpad exported as PNG', 'success');
      }, 'image/png');
    });
    this._container.querySelector('#scratchpad-insert-btn')?.addEventListener('click', () => {
      this.insertIntoPage();
    });
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      const pt = this.toNorm(e);
      if (!pt) return;
      if (this._mode === 'eraser') {
        this._drawing = true;
        this.eraseAt(pt);
        return;
      }
      this._drawing = true;
      this._activeStroke = [pt];
      this.redraw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._drawing) return;
      e.preventDefault();
      const events = (e as any).getCoalescedEvents ? (e as any).getCoalescedEvents() : [e];
      if (this._mode === 'eraser') {
        for (const ev of events) {
          const pt = this.toNorm(ev);
          if (pt) this.eraseAt(pt);
        }
        return;
      }
      if (!this._activeStroke) return;
      for (const ev of events) {
        const pt = this.toNorm(ev);
        if (!pt) continue;
        const prev = this._activeStroke[this._activeStroke.length - 1];
        if (!prev || Math.abs(pt.x - prev.x) + Math.abs(pt.y - prev.y) > 0.0015) {
          this._activeStroke.push(pt);
        }
      }
      this.redraw();
    });
    const finish = (e: PointerEvent) => {
      if (!this._drawing) return;
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      this._drawing = false;
      if (this._mode === 'pen' && this._activeStroke && this._activeStroke.length > 0) {
        this.strokes.push({ color: this._padColor, width: this._padWidth, points: this._activeStroke });
      }
      this._activeStroke = null;
      this.redraw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  private eraseAt(pt: { x: number; y: number }): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const list = this.strokes;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      for (const p of s.points) {
        const dx = (p.x - pt.x) * rect.width;
        const dy = (p.y - pt.y) * rect.height;
        if (Math.hypot(dx, dy) <= 12) {
          list.splice(i, 1);
          break;
        }
      }
    }
    this.redraw();
  }

  /** Sends pad strokes to the active page as real pen annotations. */
  private insertIntoPage(): void {
    const doc = store.activeDocument;
    if (!doc) {
      showToast('Open a PDF first', 'error');
      return;
    }
    const list = this.strokes;
    if (list.length === 0) {
      showToast('Scratchpad is empty', 'error');
      return;
    }
    const pageIndex = Math.min(doc.pageCount - 1, Math.max(0, store.activePageIndex));
    const page = doc.pages[pageIndex];
    if (!page) return;
    // Fit the pad rect into the page with a 24pt inset, preserving aspect.
    const margin = 24;
    const availW = Math.max(32, page.originalWidth - margin * 2);
    const availH = Math.max(32, page.originalHeight - margin * 2);
    const s = Math.min(availW, availH);
    const ox = (page.originalWidth - s) / 2;
    const oy = margin;
    const canvas = this.canvas;
    const padW = canvas ? Math.max(1, canvas.getBoundingClientRect().width) : 300;
    let inserted = 0;
    for (const stroke of list) {
      if (stroke.points.length === 0) continue;
      const pts: StrokePoint[] = stroke.points.map(p => ({
        x: ox + p.x * s,
        y: oy + p.y * s,
        pressure: 0.5
      }));
      const width = Math.max(0.5, stroke.width * (s / padW));
      const ann: PenAnnotation = {
        id: Math.random().toString(36).substring(2, 9),
        pageIndex,
        layerId: 'layer-default',
        type: 'pen',
        box: computePointsBoundingBox(pts, width),
        points: pts,
        color: stroke.color === '#f8fafc' ? '#0f172a' : stroke.color,
        strokeWidth: width,
        opacity: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      history.execute(new AddAnnotationCommand(pageIndex, ann));
      inserted++;
    }
    if (inserted > 0) {
      doc.lastModifiedAt = Date.now();
      showToast(`Inserted ${inserted} stroke${inserted === 1 ? '' : 's'} into page ${pageIndex + 1}`, 'success');
    }
  }
}
