/**
 * Master Canvas & Annotation Engine
 * Coordinates multi-layer rendering, background paper patterns, and tool dispatching.
 */

import { Annotation, BackgroundPattern, ShapeAnnotation, PenAnnotation } from '../core/types';

/**
 * Whether a shape paints its outline stroke. Lines and arrows ARE their
 * outline, so the toggle only applies to closed shapes (fill-only mode).
 * Pure helper, unit-tested.
 */
export function shapeHasOutline(ann: Pick<ShapeAnnotation, 'type' | 'outline'>): boolean {
  if (ann.type === 'line' || ann.type === 'arrow') return true;
  return ann.outline !== false;
}
import { store } from '../core/store';
import { renderSmoothStroke } from './spline';
import { textTool } from './tools/text';
import { stampTool } from './tools/stamp';
import { measureTool } from './tools/measure';
import { calloutTool } from './tools/callout';
import { signatureTool } from './tools/signature';
import { redactionTool } from './tools/redaction';
import { stickyNoteTool } from './tools/sticky-note';

export class AnnotationEngine {
  /**
   * Renders background paper patterns (grid, dots, isometric, lined).
   */
  public renderBackgroundPattern(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    pattern: BackgroundPattern,
    scale: number = 1.0,
    gridSize: number = 24
  ): void {
    if (pattern === 'none') return;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.scale(scale, scale);

    const step = gridSize;
    const isDark = store.appSettings.theme === 'dark';
    const strokeColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';

    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = 1;

    if (pattern === 'grid') {
      ctx.beginPath();
      for (let x = 0; x <= width / scale; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height / scale);
      }
      for (let y = 0; y <= height / scale; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(width / scale, y);
      }
      ctx.stroke();
    } else if (pattern === 'dots') {
      for (let x = step; x < width / scale; x += step) {
        for (let y = step; y < height / scale; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (pattern === 'lined') {
      ctx.beginPath();
      for (let y = step * 1.5; y < height / scale; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(width / scale, y);
      }
      ctx.stroke();
    } else if (pattern === 'isometric') {
      ctx.beginPath();
      const h = step * Math.sin(Math.PI / 3);
      for (let y = 0; y < height / scale; y += h) {
        ctx.moveTo(0, y);
        ctx.lineTo(width / scale, y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Renders all committed annotations onto the page's annotation canvas.
   */
  public renderCommittedAnnotations(
    ctx: CanvasRenderingContext2D,
    annotations: Annotation[],
    layers: any[],
    scale: number = 1.0
  ): void {
    for (const ann of annotations) {
      ctx.save();
      // Highlighter ink already carries its translucency in the color alpha;
      // applying `opacity` again would double-fade it (and diverge from the
      // live preview). Every other type uses opacity as the single source.
      ctx.globalAlpha = ann.type === 'highlighter' ? 1.0 : (ann.opacity ?? 1.0);
      if (ann.blendMode && ann.type !== 'highlighter') ctx.globalCompositeOperation = ann.blendMode;
      this.renderSingleAnnotation(ctx, ann, scale);
      ctx.restore();
    }
  }

  public renderAnnotationsToCanvas(
    ctx: CanvasRenderingContext2D,
    pageIndex: number,
    scale: number = 1.0
  ): void {
    const doc = store.activeDocument;
    if (!doc) return;

    ctx.imageSmoothingEnabled = true;
    // Layers were removed as a user-facing feature. Every stored annotation
    // renders so legacy documents cannot lose content to orphan layer state.
    const visibleAnnotations = doc.annotations[pageIndex] || [];

    for (const ann of visibleAnnotations) {
      ctx.save();
      // Highlighter ink already carries its translucency in the color alpha;
      // applying `opacity` again would double-fade it (and diverge from the
      // live preview). Every other type uses opacity as the single source.
      ctx.globalAlpha = ann.type === 'highlighter' ? 1.0 : (ann.opacity ?? 1.0);
      if (ann.blendMode && ann.type !== 'highlighter') {
        // Highlighters always render with translucent source-over (see
        // spline.ts): legacy annotations may still carry `multiply`, which
        // cannot blend across the separate overlay/PDF canvases.
        ctx.globalCompositeOperation = ann.blendMode;
      }

      this.renderSingleAnnotation(ctx, ann, scale);
      ctx.restore();
    }
  }

  /**
   * Dispatches rendering of a single annotation to its specific renderer,
   * rotating about the box center when `ann.rotation` is set. All per-type
   * renderers (and therefore export, which reuses them) stay untouched.
   */
  public renderSingleAnnotation(
    ctx: CanvasRenderingContext2D,
    ann: Annotation,
    scale: number = 1.0
  ): void {
    const rotation = ann.rotation || 0;
    if (!rotation) {
      this.renderUnrotated(ctx, ann, scale);
      return;
    }
    ctx.save();
    ctx.scale(scale, scale);
    const cx = ann.box.x + ann.box.width / 2;
    const cy = ann.box.y + ann.box.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.translate(-cx, -cy);
    // Already in page units: inner renderers must not scale again.
    this.renderUnrotated(ctx, ann, 1);
    ctx.restore();
  }

  private renderUnrotated(
    ctx: CanvasRenderingContext2D,
    ann: Annotation,
    scale: number = 1.0
  ): void {
    switch (ann.type) {
      case 'pen': {
        const penAnn = ann as PenAnnotation;
        ctx.save();
        ctx.scale(scale, scale);
        renderSmoothStroke(
          ctx,
          penAnn.points,
          penAnn.color,
          penAnn.strokeWidth,
          penAnn.pressureCurve || 'linear',
          false,
          penAnn.pressureEnabled !== false,
          penAnn.pressureStrength || 'balanced',
          'round',
          penAnn.strokeSmoothing || 'medium'
        );
        ctx.restore();
        break;
      }

      case 'highlighter':
        ctx.save();
        ctx.scale(scale, scale);
        renderSmoothStroke(ctx, ann.points, ann.color, ann.strokeWidth, 'linear', true, false, 'balanced', ann.tipShape || 'round');
        ctx.restore();
        break;

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'polygon':
      case 'freeform-shape':
        this.renderShapeAnnotation(ctx, ann, scale);
        break;

      case 'text':
        textTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'stamp':
        stampTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        measureTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'callout':
        calloutTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'signature':
        signatureTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'redaction':
        redactionTool.renderToCanvas(ctx, ann, scale);
        break;

      case 'sticky-note':
        stickyNoteTool.renderToCanvas(ctx, ann as any, scale);
        break;
    }
  }

  private renderShapeAnnotation(ctx: CanvasRenderingContext2D, ann: any, scale: number) {
    ctx.save();
    ctx.scale(scale, scale);

    ctx.strokeStyle = ann.strokeColor;
    ctx.fillStyle = ann.fillColor || 'transparent';
    ctx.lineWidth = ann.strokeWidth;

    if (ann.strokeStyle === 'dashed') {
      ctx.setLineDash([8, 6]);
    } else if (ann.strokeStyle === 'dotted') {
      ctx.setLineDash([3, 4]);
    } else {
      ctx.setLineDash([]);
    }

    const b = ann.box;
    const outline = shapeHasOutline(ann);

    if (ann.type === 'rectangle') {
      if (ann.fillColor && ann.fillColor !== 'transparent') {
        ctx.fillRect(b.x, b.y, b.width, b.height);
      }
      if (outline) ctx.strokeRect(b.x, b.y, b.width, b.height);
    } else if (ann.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        b.x + b.width / 2,
        b.y + b.height / 2,
        Math.max(1, b.width / 2),
        Math.max(1, b.height / 2),
        0,
        0,
        Math.PI * 2
      );
      if (ann.fillColor && ann.fillColor !== 'transparent') {
        ctx.fill();
      }
      if (outline) ctx.stroke();
    } else if ((ann.type === 'line' || ann.type === 'arrow') && ann.points?.length >= 2) {
      // Supports connected multi-point polylines (see "Connect Lines"), not
      // just two-point segments.
      const pts = ann.points;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();

      if (ann.type === 'arrow') {
        const prev = pts[pts.length - 2];
        const tip = pts[pts.length - 1];
        const headLen = Math.max(12, ann.strokeWidth * 4);
        const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(
          tip.x - headLen * Math.cos(angle - Math.PI / 6),
          tip.y - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          tip.x - headLen * Math.cos(angle + Math.PI / 6),
          tip.y - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = ann.strokeColor;
        ctx.fill();
      }
    } else if (ann.points && ann.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(ann.points[i].x, ann.points[i].y);
      }
      if (ann.type === 'freeform-shape' || ann.type === 'polygon') {
        ctx.closePath();
      }
      if (ann.fillColor && ann.fillColor !== 'transparent') {
        ctx.fill();
      }
      if (outline) ctx.stroke();
    }

    ctx.restore();
  }
}

export const annotationEngine = new AnnotationEngine();
