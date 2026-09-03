/**
 * Digital Signature Dialog Component
 * In-browser vector signature drawing pad with persistent signature library.
 */

import { store } from '../../core/store';
import { history, AddAnnotationCommand } from '../../core/history';
import { signatureTool } from '../../annotations/tools/signature';
import { renderSmoothStroke } from '../../annotations/spline';
import { StrokePoint } from '../../core/types';
import { getIconSvg } from '../../utils/icons';

export class SignatureDialogComponent {
  private _container: HTMLElement;
  private _strokes: StrokePoint[][] = [];
  private _currentStroke: StrokePoint[] = [];
  private _isDrawing = false;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
  }

  public render(): void {
    if (!store.signatureModalOpen) {
      this._container.innerHTML = '';
      return;
    }

    this._container.innerHTML = `
      <div class="modal-overlay" id="sig-overlay">
        <div class="modal-dialog" style="max-width:480px;">
          <div class="panel-header">
            <span>Create Digital Signature</span>
            <button id="close-sig-btn" class="header-btn" style="padding:4px;">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <div class="panel-body" style="padding:20px; display:flex; flex-direction:column; gap:16px;">
            <div style="
              width:100%; height:180px; background:#ffffff; border:1px solid var(--border-medium);
              border-radius:8px; position:relative; overflow:hidden; touch-action:none;
            ">
              <canvas id="sig-canvas" width="440" height="180" style="width:100%; height:100%; cursor:crosshair;"></canvas>
              <div style="position:absolute; bottom:28px; left:20px; right:20px; border-bottom:1px dashed #cbd5e1; pointer-events:none;"></div>
              <span style="position:absolute; bottom:8px; left:20px; font-size:11px; color:#94a3b8; pointer-events:none;">Sign above the line</span>
            </div>

            <div style="display:flex; justify-content:space-between; gap:10px;">
              <button id="clear-sig-btn" class="secondary-btn" style="margin-bottom:0; flex:1;">
                Clear Pad
              </button>
              <button id="insert-sig-btn" class="primary-btn" style="margin-bottom:0; flex:2;">
                Insert Signature
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const canvas = this._container.querySelector('#sig-canvas') as HTMLCanvasElement;
    const ctx = canvas?.getContext('2d');

    const redraw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const st of this._strokes) {
        renderSmoothStroke(ctx, st, '#0f172a', 3, 'linear', false);
      }
      if (this._currentStroke.length > 0) {
        renderSmoothStroke(ctx, this._currentStroke, '#0f172a', 3, 'linear', false);
      }
    };

    canvas?.addEventListener('pointerdown', (e) => {
      this._isDrawing = true;
      const rect = canvas.getBoundingClientRect();
      const pt: StrokePoint = {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
        pressure: e.pressure || 0.5
      };
      this._currentStroke = [pt];
      redraw();
    });

    canvas?.addEventListener('pointermove', (e) => {
      if (!this._isDrawing) return;
      const rect = canvas.getBoundingClientRect();
      const pt: StrokePoint = {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
        pressure: e.pressure || 0.5
      };
      this._currentStroke.push(pt);
      redraw();
    });

    const finishStroke = () => {
      if (!this._isDrawing) return;
      this._isDrawing = false;
      if (this._currentStroke.length > 0) {
        this._strokes.push([...this._currentStroke]);
        this._currentStroke = [];
      }
      redraw();
    };

    canvas?.addEventListener('pointerup', finishStroke);
    canvas?.addEventListener('pointercancel', finishStroke);

    this._container.querySelector('#clear-sig-btn')?.addEventListener('click', () => {
      this._strokes = [];
      this._currentStroke = [];
      redraw();
    });

    this._container.querySelector('#insert-sig-btn')?.addEventListener('click', () => {
      if (this._strokes.length === 0) return;

      const pageIndex = store.activePageIndex;
      const defaultLayerId = 'layer-default';
      const sigAnn = signatureTool.createSignatureAnnotation(
        { x: 150, y: 150 },
        pageIndex,
        defaultLayerId,
        this._strokes,
        '#0f172a'
      );

      history.execute(new AddAnnotationCommand(pageIndex, sigAnn));
      store.selectAnnotation(sigAnn.id);
      store.setSignatureModalOpen(false);
      store.setActivePageIndex(pageIndex);
    });

    this._container.querySelector('#close-sig-btn')?.addEventListener('click', () => {
      store.setSignatureModalOpen(false);
    });
  }
}
