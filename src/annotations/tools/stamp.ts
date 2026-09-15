/**
 * Stamp & Image Annotation Tool
 * Provides built-in vector stamps (APPROVED, CONFIDENTIAL, etc.) and custom image insertion.
 */

import { Point, StampAnnotation, BoundingBox } from '../../core/types';

export interface StampPreset {
  key: string;
  label: string;
  color: string;
  borderStyle: 'double' | 'solid';
}

export const STAMP_PRESETS: StampPreset[] = [
  { key: 'APPROVED', label: 'APPROVED', color: '#16a34a', borderStyle: 'double' },
  { key: 'CONFIDENTIAL', label: 'CONFIDENTIAL', color: '#dc2626', borderStyle: 'double' },
  { key: 'DRAFT', label: 'DRAFT', color: '#6b7280', borderStyle: 'solid' },
  { key: 'REVISED', label: 'REVISED', color: '#2563eb', borderStyle: 'solid' },
  { key: 'SIGN_HERE', label: 'SIGN HERE ➔', color: '#d97706', borderStyle: 'solid' },
  { key: 'FINAL', label: 'FINAL', color: '#059669', borderStyle: 'double' },
  { key: 'VOID', label: 'VOID', color: '#e11d48', borderStyle: 'double' },
  { key: 'URGENT', label: 'URGENT', color: '#ea580c', borderStyle: 'double' },
  { key: 'PAID', label: 'PAID', color: '#10b981', borderStyle: 'solid' }
];

export class StampTool {
  public createPresetStamp(
    point: Point,
    pageIndex: number,
    layerId: string,
    presetKey: string = 'APPROVED'
  ): StampAnnotation {
    const preset = STAMP_PRESETS.find(p => p.key === presetKey) || STAMP_PRESETS[0];
    const box: BoundingBox = {
      x: point.x - 90,
      y: point.y - 32,
      width: 180,
      height: 64
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'stamp',
      box,
      // Tilt lives on the annotation rotation (shared with selection math),
      // not on `box.rotation`, so hit-testing and rendering agree.
      rotation: -0.12,
      stampType: 'preset',
      presetKey: preset.key,
      color: preset.color,
      opacity: 0.9,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  public createCustomImageStamp(
    point: Point,
    pageIndex: number,
    layerId: string,
    imageUrl: string,
    width = 200,
    height = 150
  ): StampAnnotation {
    const box: BoundingBox = {
      x: point.x - width / 2,
      y: point.y - height / 2,
      width,
      height
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'stamp',
      box,
      stampType: 'custom',
      imageUrl,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /**
   * Renders stamp onto a canvas context.
   */
  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: StampAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

    const b = ann.box;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;

    // `ann.rotation` is applied by the annotation engine before dispatch, so
    // this renderer always draws in the box's unrotated local frame.
    ctx.translate(cx, cy);
    ctx.translate(-b.width / 2, -b.height / 2);

    if (ann.stampType === 'preset') {
      const preset = STAMP_PRESETS.find(p => p.key === ann.presetKey) || STAMP_PRESETS[0];
      const color = ann.color || preset.color;

      // Scale every visual metric from the box size (base: 180x64) so the
      // label, borders and radii stay proportional when resized.
      const k = b.height / 64;
      const inset = Math.max(1, 2 * k);

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1, 3 * k);
      this.drawRoundedRect(ctx, inset, inset, Math.max(1, b.width - inset * 2), Math.max(1, b.height - inset * 2), Math.max(2, 8 * k));
      ctx.stroke();

      if (preset.borderStyle === 'double') {
        const innerInset = Math.max(1.5, 7 * k);
        ctx.lineWidth = Math.max(0.75, 1.5 * k);
        this.drawRoundedRect(ctx, innerInset, innerInset, Math.max(1, b.width - innerInset * 2), Math.max(1, b.height - innerInset * 2), Math.max(1, 5 * k));
        ctx.stroke();
      }

      // Fit the label to the box: derive from height then shrink to width.
      let fontSize = Math.max(6, b.height * (22 / 64));
      const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif';
      ctx.font = `bold ${fontSize}px ${fontFamily}`;
      const maxTextWidth = Math.max(8, b.width * 0.86);
      const measured = ctx.measureText(preset.label).width;
      if (measured > maxTextWidth && measured > 0) {
        fontSize = Math.max(6, fontSize * (maxTextWidth / measured));
        ctx.font = `bold ${fontSize}px ${fontFamily}`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(preset.label, b.width / 2, b.height / 2);
    } else if (ann.stampType === 'custom' && ann.imageUrl) {
      const img = this.getImage(ann.imageUrl);
      if (img && img.complete && img.naturalWidth > 0) {
        // Aspect-preserving "contain" fit.
        const s = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
        const dw = img.naturalWidth * s;
        const dh = img.naturalHeight * s;
        ctx.drawImage(img, (b.width - dw) / 2, (b.height - dh) / 2, dw, dh);
      }
    }

    ctx.restore();
  }

  /** Cache decoded images so repeated paints don't re-trigger a network load. */
  private _imageCache: Map<string, HTMLImageElement> = new Map();

  /**
   * Seeds the render cache with an already-decoded image so the first paint
   * after an insert (e.g. clipboard paste) draws immediately instead of
   * waiting for a second decode of the same data URL.
   */
  public primeImage(src: string, img: HTMLImageElement): void {
    if (img.complete && img.naturalWidth > 0) this._imageCache.set(src, img);
  }
  private getImage(src: string): HTMLImageElement {
    let img = this._imageCache.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      this._imageCache.set(src, img);
    }
    return img;
  }

  private drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

export const stampTool = new StampTool();
