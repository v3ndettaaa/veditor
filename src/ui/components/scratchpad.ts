/**
 * Floating Infinite Scratchpad / Draft Overlay.
 * Viewport-fixed panel for quick rough notes, formulas, and scribbles.
 * Features:
 * - Persistent memory across sessions until explicitly cleared.
 * - Infinite canvas with pan/scroll (mouse wheel, drag-to-pan, middle-click).
 * - Auto-close when clicking outside anywhere on the page (no X close button needed).
 * - Free resizing (enlarge and shrink) without distorting strokes.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { showToast } from './toast';
import { t } from '../i18n';

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
const STROKES_KEY = 'veditor_scratchpad_strokes_v2';
const DEFAULT_GEOM: PadGeom = { x: -360, y: 70, w: 340, h: 420 };
const MIN_W = 180;
const MIN_H = 140;

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
  private _strokes: PadStroke[] = [];
  private _mode: 'pen' | 'eraser' | 'pan' = 'pen';
  private _drawing = false;
  private _isPanning = false;
  private _panStartX = 0;
  private _panStartY = 0;
  private _panOriginX = 0;
  private _panOriginY = 0;
  private _panX = 0;
  private _panY = 0;
  private _activeStroke: Array<{ x: number; y: number }> | null = null;
  private _geom: PadGeom = loadGeom();
  private _padWidth = 4;
  private _padColor = '#f8fafc';
  private _spacePressed = false;

  constructor(container: HTMLElement) {
    this._container = container;
    this.loadStrokes();
    store.subscribe(() => this.sync());
    this.render();
  }

  private loadStrokes(): void {
    try {
      const raw = localStorage.getItem(STROKES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this._strokes = parsed;
          return;
        }
      }
    } catch (_) {}
    this._strokes = [];
  }

  private persistStrokes(): void {
    try {
      localStorage.setItem(STROKES_KEY, JSON.stringify(this._strokes));
    } catch (_) {}
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
            <button id="scratchpad-pan-btn" class="view-btn" title="Pan / Scroll">${getIconSvg('hand', 14)}</button>
            <button id="scratchpad-recenter-btn" class="view-btn" title="Recenter">${getIconSvg('recenter', 14)}</button>
            <button id="scratchpad-min-btn" class="view-btn" title="Minimize">–</button>
          </div>
        </div>
        <div class="scratchpad-body">
          <canvas id="scratchpad-canvas" class="scratchpad-canvas"></canvas>
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
          </div>
        </div>
        <div id="scratchpad-resize-n" class="scratchpad-resize-edge is-n" title="Resize height"></div>
        <div id="scratchpad-resize-e" class="scratchpad-resize-edge is-e" title="Resize width"></div>
        <div id="scratchpad-resize" class="scratchpad-resize" title="Resize">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="8.5" y1="4.5" x2="4.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="8.5" y1="7.5" x2="7.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
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

  /** Visibility + button states only — never rebuilds the canvas element. */
  private sync(): void {
    const panel = this.panel;
    if (!panel) return;
    const doc = store.activeDocument;
    const open = store.scratchpadOpen && !!doc;
    // Minimized keeps the panel docked: only the header strip stays visible, so
    // the pad is one click away instead of gone until the toolbar reopens it.
    const minimized = open && store.scratchpadMinimized;
    panel.style.display = open ? 'flex' : 'none';
    panel.classList.toggle('is-minimized', minimized);

    const minBtn = this._container.querySelector<HTMLElement>('#scratchpad-min-btn');
    if (minBtn) {
      minBtn.innerHTML = minimized ? getIconSvg('expand', 14) : getIconSvg('compress', 14);
      minBtn.title = minimized ? 'Restore scratchpad' : 'Minimize';
    }

    if (!open) return;
    // While minimized the body is display:none, so measuring it would resize
    // the backing store to 1px and wipe the pad contents.
    if (minimized) return;

    this.fitCanvas();
    this.redraw();

    this._container.querySelector('#scratchpad-pen-btn')?.classList.toggle('active', this._mode === 'pen');
    this._container.querySelector('#scratchpad-eraser-btn')?.classList.toggle('active', this._mode === 'eraser');
    this._container.querySelector('#scratchpad-pan-btn')?.classList.toggle('active', this._mode === 'pan');
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
    // Negative x docks from the right edge.
    const left = this._geom.x < 0 ? Math.max(8, hostW + this._geom.x - this._geom.w) : this._geom.x;
    panel.style.left = `${Math.max(0, left)}px`;
    panel.style.top = `${Math.max(0, this._geom.y)}px`;
    panel.style.width = `${this._geom.w}px`;
    panel.style.height = `${this._geom.h}px`;
    this.fitCanvas();
    this.redraw();
  }

  private bindResizeEdge(
    selector: string,
    edges: { horizontal: 'none' | 'end'; vertical: 'none' | 'start' | 'end' }
  ): void {
    const panel = this.panel;
    const handle = this._container.querySelector<HTMLElement>(selector);
    if (!panel || !handle) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}
      const startX = e.clientX;
      const startY = e.clientY;
      const startGeom = { ...this._geom };
      const startTop = panel.offsetTop;
      const move = (ev: PointerEvent) => {
        if (edges.horizontal === 'end') {
          this._geom.w = Math.max(MIN_W, startGeom.w + ev.clientX - startX);
          panel.style.width = `${this._geom.w}px`;
        }
        if (edges.vertical === 'end') {
          this._geom.h = Math.max(MIN_H, startGeom.h + ev.clientY - startY);
          panel.style.height = `${this._geom.h}px`;
        } else if (edges.vertical === 'start') {
          this._geom.h = Math.max(MIN_H, startGeom.h - (ev.clientY - startY));
          panel.style.height = `${this._geom.h}px`;
          panel.style.top = `${startTop + (startGeom.h - this._geom.h)}px`;
        }
        this.fitCanvas();
        this.redraw();
      };
      const up = (ev: PointerEvent) => {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch (_) {}
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this._geom.y = panel.offsetTop;
        this.persistGeom();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
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

  private updateCursor(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    if (this._isPanning) {
      canvas.style.cursor = 'grabbing';
    } else if (this._mode === 'pan' || this._spacePressed) {
      canvas.style.cursor = 'grab';
    } else if (this._mode === 'eraser') {
      canvas.style.cursor = 'cell';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  private redraw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw subtle infinite dot grid that scrolls with panning
    const gridSize = 24 * dpr;
    const offsetX = (((this._panX * dpr) % gridSize) + gridSize) % gridSize;
    const offsetY = (((this._panY * dpr) % gridSize) + gridSize) % gridSize;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.2)';
    for (let x = offsetX; x < canvas.width; x += gridSize) {
      for (let y = offsetY; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, 1 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Render all strokes in world coordinates offset by pan
    ctx.save();
    ctx.translate(this._panX * dpr, this._panY * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const draw = (pts: Array<{ x: number; y: number }>, color: string, width: number) => {
      if (pts.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
        ctx.lineTo(pts[0].x * dpr + 0.1, pts[0].y * dpr + 0.1);
      } else {
        ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
        for (let i = 1; i < pts.length; i++) {
          const xc = ((pts[i - 1].x + pts[i].x) / 2) * dpr;
          const yc = ((pts[i - 1].y + pts[i].y) / 2) * dpr;
          ctx.quadraticCurveTo(pts[i - 1].x * dpr, pts[i - 1].y * dpr, xc, yc);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x * dpr, last.y * dpr);
      }
      ctx.stroke();
    };

    for (const s of this._strokes) {
      draw(s.points, s.color, s.width);
    }
    if (this._drawing && this._activeStroke && this._activeStroke.length > 0) {
      draw(this._activeStroke, this._padColor, this._padWidth);
    }

    ctx.restore();
  }

  private bindChrome(): void {
    const header = this._container.querySelector<HTMLElement>('#scratchpad-header');
    const panel = this.panel;

    // Drag header to reposition scratchpad panel. While minimized the header is
    // the restore affordance instead of a drag handle.
    header?.addEventListener('pointerdown', (e) => {
      if (!panel || (e.target as HTMLElement).closest('button')) return;
      if (store.scratchpadMinimized) return;
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
        const left = panel.offsetLeft;
        this._geom.x = left + this._geom.w > hostW - 60 ? left - hostW + this._geom.w : left;
        this._geom.y = panel.offsetTop;
        this.persistGeom();
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
    });

    header?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (store.scratchpadMinimized) store.setScratchpadMinimized(false);
    });

    // Free resizing from the north, east, and southeast edges without
    // distorting the canvas contents.
    this.bindResizeEdge('#scratchpad-resize-n', { horizontal: 'none', vertical: 'start' });
    this.bindResizeEdge('#scratchpad-resize-e', { horizontal: 'end', vertical: 'none' });
    this.bindResizeEdge('#scratchpad-resize', { horizontal: 'end', vertical: 'end' });

    // Tool buttons
    this._container.querySelector('#scratchpad-pen-btn')?.addEventListener('click', () => {
      this._mode = 'pen';
      this.updateCursor();
      this.sync();
    });
    this._container.querySelector('#scratchpad-eraser-btn')?.addEventListener('click', () => {
      this._mode = 'eraser';
      this.updateCursor();
      this.sync();
    });
    this._container.querySelector('#scratchpad-pan-btn')?.addEventListener('click', () => {
      this._mode = 'pan';
      this.updateCursor();
      this.sync();
    });
    this._container.querySelector('#scratchpad-recenter-btn')?.addEventListener('click', () => {
      this._panX = 0;
      this._panY = 0;
      this.redraw();
      showToast('Scratchpad view centered', 'info');
    });
    this._container.querySelector('#scratchpad-min-btn')?.addEventListener('click', () => {
      store.setScratchpadMinimized(!store.scratchpadMinimized);
    });

    // Width pills
    this._container.querySelectorAll('[data-pad-w]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._padWidth = Number((btn as HTMLElement).dataset.padW) || 4;
        this._container.querySelectorAll('[data-pad-w]').forEach(b => b.classList.toggle('active', b === btn));
        this._mode = 'pen';
        this.updateCursor();
        this.sync();
      });
    });

    // Clear Pad immediately: no confirmation modal; offer a brief undo toast.
    this._container.querySelector('#scratchpad-clear-btn')?.addEventListener('click', () => {
      if (this._strokes.length === 0) return;
      const cleared: PadStroke[] = this._strokes.map(stroke => ({
        ...stroke,
        points: stroke.points.map(point => ({ ...point }))
      }));
      this._strokes = [];
      this.persistStrokes();
      this.redraw();
      showToast('Scratchpad cleared', 'info', 5000, {
        label: 'Undo',
        onClick: () => {
          this._strokes = cleared;
          this.persistStrokes();
          this.redraw();
        }
      });
    });

    // Export as PNG
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

    // Auto-close on click outside anywhere on the page
    window.addEventListener('pointerdown', (e) => {
      const p = this.panel;
      if (!p || p.style.display === 'none') return;
      // A minimized pad is just a docked strip — clicking the page must not
      // dismiss it, otherwise the restore affordance disappears mid-thought.
      if (store.scratchpadMinimized) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // If clicking inside the scratchpad panel, keep open
      if (p.contains(target)) return;
      // If clicking on the toolbar scratchpad toggle button, let toolbar handle toggle
      if (target.closest('#tool-scratchpad, [data-tool="scratchpad"], .scratchpad-toggle')) return;
      // Clicked outside -> close scratchpad automatically
      store.setScratchpadOpen(false);
    });

    // Spacebar temporary pan shortcut
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this._spacePressed && (e.target as HTMLElement)?.tagName !== 'INPUT' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        const p = this.panel;
        if (p && p.style.display !== 'none' && !store.scratchpadMinimized) {
          this._spacePressed = true;
          this.updateCursor();
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this._spacePressed = false;
        this.updateCursor();
      }
    });
  }

  private getWorldPos(e: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    return {
      x: localX - this._panX,
      y: localY - this._panY
    };
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;

    // Mouse wheel / trackpad 2-finger scroll for infinite canvas navigation
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._panX -= e.deltaX;
        this._panY -= e.deltaY;
        this.redraw();
      },
      { passive: false }
    );

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}

      // Middle click (button 1) or pan mode or space held -> pan
      if (e.button === 1 || this._mode === 'pan' || this._spacePressed) {
        this._isPanning = true;
        this._panStartX = e.clientX;
        this._panStartY = e.clientY;
        this._panOriginX = this._panX;
        this._panOriginY = this._panY;
        this.updateCursor();
        return;
      }

      const pt = this.getWorldPos(e);
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
      e.preventDefault();
      if (this._isPanning) {
        this._panX = this._panOriginX + (e.clientX - this._panStartX);
        this._panY = this._panOriginY + (e.clientY - this._panStartY);
        this.redraw();
        return;
      }

      if (!this._drawing) return;

      const events = (e as any).getCoalescedEvents ? (e as any).getCoalescedEvents() : [e];

      if (this._mode === 'eraser') {
        for (const ev of events) {
          const pt = this.getWorldPos(ev);
          if (pt) this.eraseAt(pt);
        }
        return;
      }

      if (!this._activeStroke) return;
      for (const ev of events) {
        const pt = this.getWorldPos(ev);
        if (!pt) continue;
        const prev = this._activeStroke[this._activeStroke.length - 1];
        if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1.2) {
          this._activeStroke.push(pt);
        }
      }
      this.redraw();
    });

    const finish = (e: PointerEvent) => {
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (this._isPanning) {
        this._isPanning = false;
        this.updateCursor();
        return;
      }

      if (!this._drawing) return;
      this._drawing = false;

      if (this._mode === 'pen' && this._activeStroke && this._activeStroke.length > 0) {
        this._strokes.push({
          color: this._padColor,
          width: this._padWidth,
          points: this._activeStroke
        });
        this.persistStrokes();
      }

      this._activeStroke = null;
      this.redraw();
    };

    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  private eraseAt(pt: { x: number; y: number }): void {
    const list = this._strokes;
    let erased = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      for (const p of s.points) {
        if (Math.hypot(p.x - pt.x, p.y - pt.y) <= 14) {
          list.splice(i, 1);
          erased = true;
          break;
        }
      }
    }
    if (erased) {
      this.persistStrokes();
      this.redraw();
    }
  }
}
