/**
 * High-Precision Ink & Spline Smoothing Engine
 * Generates organic, fluid, pressure-sensitive strokes using Centripetal Catmull-Rom splines.
 */

import { StrokePoint, Point } from '../core/types';

export interface CurveSegment {
  p0: StrokePoint;
  p1: StrokePoint;
  cp1: Point;
  cp2: Point;
  widthStart: number;
  widthEnd: number;
}

/**
 * Calculates stroke width dynamically from pressure, base width, and velocity.
 */
export function calculateStrokeWidth(
  baseWidth: number,
  pressure: number = 0.5,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled: boolean = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): number {
  if (!pressureEnabled) {
    return baseWidth;
  }

  let mappedPressure = pressure;
  if (pressureCurve === 'soft') {
    mappedPressure = Math.sqrt(pressure);
  } else if (pressureCurve === 'firm') {
    mappedPressure = pressure * pressure;
  } else if (pressureCurve === 'exponential') {
    mappedPressure = Math.pow(pressure, 3);
  }

  let minFactor = 0.3;
  let maxFactor = 1.8;
  if (strength === 'light') {
    minFactor = 0.6;
    maxFactor = 1.4;
  } else if (strength === 'strong') {
    minFactor = 0.1;
    maxFactor = 2.4;
  }

  const factor = minFactor + (maxFactor - minFactor) * mappedPressure;
  return Math.max(0.5, baseWidth * factor);
}

/**
 * Generates smooth Bezier curve segments from discrete sampled points.
 */
export function generateSmoothSegments(
  points: StrokePoint[],
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled: boolean = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): CurveSegment[] {
  if (points.length < 2) return [];

  const segments: CurveSegment[] = [];

  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    const w0 = calculateStrokeWidth(baseWidth, p0.pressure, pressureCurve, pressureEnabled, strength);
    const w1 = calculateStrokeWidth(baseWidth, p1.pressure, pressureCurve, pressureEnabled, strength);
    segments.push({
      p0,
      p1,
      cp1: { x: (p0.x * 2 + p1.x) / 3, y: (p0.y * 2 + p1.y) / 3 },
      cp2: { x: (p0.x + p1.x * 2) / 3, y: (p0.y + p1.y * 2) / 3 },
      widthStart: w0,
      widthEnd: w1
    });
    return segments;
  }

  // Centripetal Catmull-Rom to Cubic Bezier conversion
  const alpha = 0.5; // centripetal

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < points.length ? points[i + 2] : p2;

    const d1 = Math.max(0.001, Math.hypot(p1.x - p0.x, p1.y - p0.y) ** alpha);
    const d2 = Math.max(0.001, Math.hypot(p2.x - p1.x, p2.y - p1.y) ** alpha);
    const d3 = Math.max(0.001, Math.hypot(p3.x - p2.x, p3.y - p2.y) ** alpha);

    // Control point 1
    const cp1x = p1.x + (d2 * (p1.x - p0.x) / d1 + (2 * d1 + d2) * (p2.x - p1.x) / (d1 + d2)) / 3;
    const cp1y = p1.y + (d2 * (p1.y - p0.y) / d1 + (2 * d1 + d2) * (p2.y - p1.y) / (d1 + d2)) / 3;

    // Control point 2
    const cp2x = p2.x - (d2 * (p3.x - p2.x) / d3 + (d2 + 2 * d3) * (p2.x - p1.x) / (d2 + d3)) / 3;
    const cp2y = p2.y - (d2 * (p3.y - p2.y) / d3 + (d2 + 2 * d3) * (p2.y - p1.y) / (d2 + d3)) / 3;

    const wStart = calculateStrokeWidth(baseWidth, p1.pressure, pressureCurve, pressureEnabled, strength);
    const wEnd = calculateStrokeWidth(baseWidth, p2.pressure, pressureCurve, pressureEnabled, strength);

    segments.push({
      p0: p1,
      p1: p2,
      cp1: { x: cp1x, y: cp1y },
      cp2: { x: cp2x, y: cp2y },
      widthStart: wStart,
      widthEnd: wEnd
    });
  }

  return segments;
}

/**
 * Normalizes a highlighter color to a translucent rgba string so text stays
 * legible. Solid hex picks from the toolbar (e.g. `#fef08a`) become
 * `rgba(..., 0.4)`; existing rgba colors keep their alpha (clamped).
 *
 * This matters because annotations live on their own transparent canvas
 * stacked above the PDF canvas — `multiply` cannot blend across separate
 * canvas elements, so translucency must come from alpha + `source-over`.
 */
export function normalizeHighlighterColor(color: string, alpha = 0.4): string {
  const c = color.trim();
  const hexMatch = c.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbaMatch = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgbaMatch) {
    const r = rgbaMatch[1];
    const g = rgbaMatch[2];
    const b = rgbaMatch[3];
    const a = rgbaMatch[4] !== undefined ? Math.min(parseFloat(rgbaMatch[4]), 0.55) : alpha;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

/**
 * Draws smooth stroke segments onto a canvas context with variable or uniform line width.
 */
export function renderSmoothStroke(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  color: string,
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  isHighlighter = false,
  pressureEnabled = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced',
  tipShape: 'chisel' | 'round' = 'round'
): void {
  if (points.length === 0) return;

  ctx.save();
  ctx.lineCap = tipShape === 'chisel' ? 'square' : 'round';
  ctx.lineJoin = tipShape === 'chisel' ? 'miter' : 'round';

  if (isHighlighter) {
    // NOTE: annotations render on a transparent overlay canvas above the PDF,
    // so `multiply` cannot blend with the page below (it only blends within
    // the overlay itself, darkening self-overlaps). Use normal alpha blending
    // with a translucent color instead — text stays readable.
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = normalizeHighlighterColor(color);
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      for (let i = 1; i < points.length; i++) {
        const xc = (points[i - 1].x + points[i].x) / 2;
        const yc = (points[i - 1].y + points[i].y) / 2;
        ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, xc, yc);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // When pressure sensitivity is disabled, render clean uniform stroke
  if (!pressureEnabled) {
    if (points.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, baseWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const xc = (points[i - 1].x + points[i].x) / 2;
      const yc = (points[i - 1].y + points[i].y) / 2;
      ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, xc, yc);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Single point dot with pressure
  if (points.length === 1) {
    const p = points[0];
    const w = calculateStrokeWidth(baseWidth, p.pressure, pressureCurve, pressureEnabled, strength);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const segments = generateSmoothSegments(points, baseWidth, pressureCurve, pressureEnabled, strength);

  for (const seg of segments) {
    const avgWidth = (seg.widthStart + seg.widthEnd) / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = avgWidth;
    ctx.beginPath();
    ctx.moveTo(seg.p0.x, seg.p0.y);
    ctx.bezierCurveTo(seg.cp1.x, seg.cp1.y, seg.cp2.x, seg.cp2.y, seg.p1.x, seg.p1.y);
    ctx.stroke();
  }

  ctx.restore();
}
