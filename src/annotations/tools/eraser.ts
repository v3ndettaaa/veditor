import { Point, StrokePoint, Annotation, EraserMode } from '../../core/types';
import { distance, distanceToSegment, isPointInBox, computePointsBoundingBox } from '../../utils/geometry';
import { rotatePoint, boxCenter, getAnnotationSelectionBox } from '../../annotations/selection';

export interface EraseResult {
  toRemove: Annotation[];
  toAdd: Annotation[];
}

export class EraserTool {
  private _active: boolean = false;
  private _lastPoint: Point | null = null;
  private _radius: number = 12;
  private _mode: EraserMode = 'stroke';

  public start(point: Point, radius: number = 12, mode: EraserMode = 'stroke') {
    this._active = true;
    this._lastPoint = point;
    this._radius = radius;
    this._mode = mode;
  }

  public move(point: Point): void {
    this._lastPoint = point;
  }

  public finish(): void {
    this._active = false;
    this._lastPoint = null;
  }

  public get radius(): number {
    return this._radius;
  }

  public getLiveBoundingBox(point: Point | null = this._lastPoint): { x: number; y: number; width: number; height: number } | null {
    if (!point) return null;
    const pad = this._radius + 4;
    return {
      x: point.x - pad,
      y: point.y - pad,
      width: pad * 2,
      height: pad * 2
    };
  }

  /**
   * Evaluates annotations on page and returns list of annotations that should be removed or replaced.
   */
  public testErase(point: Point, annotations: Annotation[]): EraseResult {
    const toRemove: Annotation[] = [];
    const toAdd: Annotation[] = [];
    const r = this._radius;

    for (const ann of annotations) {
      if (ann.locked) continue;
      const targetBox = getAnnotationSelectionBox(ann);
      // Points and boxes are stored unrotated: test in the local frame.
      const localPt = ann.rotation ? rotatePoint(point, boxCenter(targetBox), -ann.rotation) : point;

      const strokePadding = ((ann as any).strokeWidth || 2) / 2;
      const hitRadius = r + strokePadding;

      // Fast O(1) Axis-Aligned Bounding Box (AABB) rejection before testing dense stroke vertices
      if (
        localPt.x < targetBox.x - hitRadius ||
        localPt.x > targetBox.x + targetBox.width + hitRadius ||
        localPt.y < targetBox.y - hitRadius ||
        localPt.y > targetBox.y + targetBox.height + hitRadius
      ) {
        continue;
      }

      if (this._mode === 'object') {
        // Object Eraser: Delete entire element if hit
        toRemove.push(ann);
      } else if (this._mode === 'stroke') {
        // Stroke Eraser: Erase pen/highlighter if pointer touches any point or segment
        if (ann.type === 'pen' || (ann.type === 'highlighter' && !ann.quadPoints)) {
          let hit = false;
          const pts = ann.points;
          for (let i = 0; i < pts.length; i++) {
            if (distance(localPt, pts[i]) <= hitRadius) {
              hit = true;
              break;
            }
            if (i > 0 && distanceToSegment(localPt, pts[i - 1], pts[i]) <= hitRadius) {
              hit = true;
              break;
            }
          }
          if (hit) {
            toRemove.push(ann);
          }
        } else {
          // Other shapes erased if touched
          if (isPointInBox(localPt, targetBox)) {
            toRemove.push(ann);
          }
        }
      } else if (this._mode === 'pixel') {
        // Pixel / Segment Eraser: Slice freehand strokes into remaining sub-segments
        if (ann.type === 'pen' || (ann.type === 'highlighter' && !ann.quadPoints)) {
          let anyHit = false;
          const pts = ann.points;
          for (let i = 0; i < pts.length; i++) {
            if (distance(localPt, pts[i]) <= hitRadius) {
              anyHit = true;
              break;
            }
            if (i > 0 && distanceToSegment(localPt, pts[i - 1], pts[i]) <= hitRadius) {
              anyHit = true;
              break;
            }
          }

          if (anyHit) {
            toRemove.push(ann);

            // Break points into runs of points outside the eraser circle.
            // Typed as StrokePoint so split pen strokes keep their pressure.
            const runs: StrokePoint[][] = [];
            let currentRun: StrokePoint[] = [];

            for (let i = 0; i < pts.length; i++) {
              const pt = pts[i];
              const isInside = distance(localPt, pt) <= hitRadius;

              if (!isInside) {
                currentRun.push(pt);
              } else if (currentRun.length > 0) {
                runs.push(currentRun);
                currentRun = [];
              }
            }

            if (currentRun.length > 0) {
              runs.push(currentRun);
            }

            // Create new sub-strokes for surviving segments
            for (const run of runs) {
              if (run.length >= 2) {
                toAdd.push({
                  ...ann,
                  id: 'ann_' + Math.random().toString(36).substring(2, 9),
                  points: run,
                  box: computePointsBoundingBox(run, strokePadding),
                  updatedAt: Date.now()
                });
              }
            }
          }
        } else {
          // Other non-pen elements deleted when hit by pixel eraser
          if (isPointInBox(localPt, ann.box)) {
            toRemove.push(ann);
          }
        }
      }
    }

    return { toRemove, toAdd };
  }

  /**
   * Renders circular eraser preview cursor on scratchpad canvas.
   */
  public renderScratchpad(ctx: CanvasRenderingContext2D, point: Point, scale: number): void {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    ctx.lineWidth = 1.5 / Math.max(0.5, scale * 0.5);
    ctx.beginPath();
    ctx.arc(point.x, point.y, this._radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export const eraserTool = new EraserTool();
