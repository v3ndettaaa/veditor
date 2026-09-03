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
      height: 64,
      rotation: -0.12 // slight organic tilt (-7 degrees)
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'stamp',
      box,
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
      height,
      rotation: 0
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

    ctx.translate(cx, cy);
    if (b.rotation) {
      ctx.rotate(b.rotation);
    }
    ctx.translate(-b.width / 2, -b.height / 2);

    if (ann.stampType === 'preset') {
      const preset = STAMP_PRESETS.find(p => p.key === ann.presetKey) || STAMP_PRESETS[0];
      const color = ann.color || preset.color;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3;

      // Outer rounded rect
      this.drawRoundedRect(ctx, 2, 2, b.width - 4, b.height - 4, 8);
      ctx.stroke();

      if (preset.borderStyle === 'double') {
        // Inner rect
        ctx.lineWidth = 1.5;
        this.drawRoundedRect(ctx, 7, 7, b.width - 14, b.height - 14, 5);
        ctx.stroke();
      }

      // Stamp Text
      ctx.font = `bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(preset.label, b.width / 2, b.height / 2);
    } else if (ann.stampType === 'custom' && ann.imageUrl) {
      const img = new Image();
      img.src = ann.imageUrl;
      if (img.complete) {
        ctx.drawImage(img, 0, 0, b.width, b.height);
      }
    }

    ctx.restore();
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
