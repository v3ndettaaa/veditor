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
        <div class="modal-dialog form-dialog" role="dialog" aria-modal="true" aria-label="Create digital signature">
          <div class="panel-header">
            <span class="panel-header-title">
              ${getIconSvg('signature', 16)}
              Create Digital Signature
            </span>
            <button id="close-sig-btn" class="icon-btn is-small" title="Close" aria-label="Close">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <div class="form-dialog-body">
            <div class="sig-pad">
              <canvas id="sig-canvas" width="440" height="180" class="sig-pad-canvas"></canvas>
              <div class="sig-pad-baseline"></div>
              <span class="sig-pad-hint">Sign above the line</span>
            </div>

            <div class="sig-pad-actions">
              <button id="clear-sig-btn" class="secondary-btn">Clear Pad</button>
              <button id="insert-sig-btn" class="primary-btn">Insert Signature</button>
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
