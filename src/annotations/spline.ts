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
 * Filters micro-jitter, deduplicates overlapping sample points,
 * smoothes stylus pressure transitions, and applies subtle moving average
 * to prevent jagged, scratched or broken freehand ink lines.
 */
export function smoothStrokePoints(
  points: StrokePoint[],
  smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium'
): StrokePoint[] {
  if (points.length <= 2) return points;

  // 1. Filter out points that are too close (< 0.8px) to avoid tangent blowup and micro-dots
  const minDistance = 0.8;
  const deduped: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = deduped[deduped.length - 1];
    const dist = Math.hypot(points[i].x - last.x, points[i].y - last.y);
    if (dist >= minDistance) {
      deduped.push(points[i]);
    }
  }
  deduped.push(points[points.length - 1]);

  if (deduped.length <= 2) return deduped;

  // 2. Smooth pressure with 3-point rolling average
  const smoothedPressure: StrokePoint[] = deduped.map((pt, i, arr) => {
    if (i === 0 || i === arr.length - 1) return { ...pt };
    const prevP = arr[i - 1].pressure ?? 0.5;
    const currP = pt.pressure ?? 0.5;
    const nextP = arr[i + 1].pressure ?? 0.5;
    const p = prevP * 0.25 + currP * 0.5 + nextP * 0.25;
    return { ...pt, pressure: p };
  });

  if (smoothing === 'none') return smoothedPressure;

  // 3. Coordinate smoothing passes
  const passes = smoothing === 'high' ? 2 : 1;
  const weight = smoothing === 'subtle' ? 0.06 : (smoothing === 'medium' ? 0.10 : 0.14);

  let current = smoothedPressure;
  for (let p = 0; p < passes; p++) {
    const next: StrokePoint[] = [current[0]];
    for (let i = 1; i < current.length - 1; i++) {
      const prev = current[i - 1];
      const curr = current[i];
      const after = current[i + 1];
      next.push({
        ...curr,
        x: curr.x * (1 - 2 * weight) + prev.x * weight + after.x * weight,
        y: curr.y * (1 - 2 * weight) + prev.y * weight + after.y * weight,
      });
    }
    next.push(current[current.length - 1]);
    current = next;
  }

  return current;
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

    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    let cp1x: number;
    let cp1y: number;
    let cp2x: number;
    let cp2y: number;

    if (chord < 0.001) {
      cp1x = p1.x;
      cp1y = p1.y;
      cp2x = p2.x;
      cp2y = p2.y;
    } else {
      const d1 = Math.max(0.001, Math.hypot(p1.x - p0.x, p1.y - p0.y) ** alpha);
      const d2 = Math.max(0.001, chord ** alpha);
      const d3 = Math.max(0.001, Math.hypot(p3.x - p2.x, p3.y - p2.y) ** alpha);

      // Raw Catmull-Rom tangents
      cp1x = p1.x + (d2 * (p1.x - p0.x) / d1 + (2 * d1 + d2) * (p2.x - p1.x) / (d1 + d2)) / 3;
      cp1y = p1.y + (d2 * (p1.y - p0.y) / d1 + (2 * d1 + d2) * (p2.y - p1.y) / (d1 + d2)) / 3;

      cp2x = p2.x - (d2 * (p3.x - p2.x) / d3 + (d2 + 2 * d3) * (p2.x - p1.x) / (d2 + d3)) / 3;
      cp2y = p2.y - (d2 * (p3.y - p2.y) / d3 + (d2 + 2 * d3) * (p2.y - p1.y) / (d2 + d3)) / 3;

      // Clamp control points to max distance from endpoints (at most half chord length).
      // This strictly prevents Catmull-Rom tangent blowup, loops, and sharp thorn spikes.
      const maxDist = chord * 0.5;

      const v1x = cp1x - p1.x;
      const v1y = cp1y - p1.y;
      const dist1 = Math.hypot(v1x, v1y);
      if (dist1 > maxDist && dist1 > 0.0001) {
        const scale1 = maxDist / dist1;
        cp1x = p1.x + v1x * scale1;
        cp1y = p1.y + v1y * scale1;
      }

      const v2x = cp2x - p2.x;
      const v2y = cp2y - p2.y;
      const dist2 = Math.hypot(v2x, v2y);
      if (dist2 > maxDist && dist2 > 0.0001) {
        const scale2 = maxDist / dist2;
        cp2x = p2.x + v2x * scale2;
        cp2y = p2.y + v2y * scale2;
      }
    }

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
 * Sub-pixel width floor for the ink ribbon. A stroke whose pressure/taper tail
 * drops below one device pixel rasterises as a broken line of grey dashes —
 * the "chalky" look — so the outline never narrows past this.
 */
const MIN_INK_WIDTH = 0.75;

/**
 * Half-width floor for a single point, so a tap still stamps a visible dot.
 */
const MIN_DOT_WIDTH = 1.4;

interface RibbonSample {
  x: number;
  y: number;
  w: number;
}

/**
 * Flattens the cubic segments into a polyline of centerline samples, each
 * carrying the interpolated stroke width at that parameter. Sampling density
 * follows the chord length so long curves stay smooth without over-tessellating
 * short ones.
 */
function sampleRibbonCenterline(segments: CurveSegment[]): RibbonSample[] {
  const samples: RibbonSample[] = [];

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const chord = Math.hypot(seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y);
    const steps = Math.max(4, Math.min(32, Math.ceil(chord / 2)));
    // Skip the first sample of every segment after the first: it duplicates the
    // previous segment's endpoint and would produce a zero-length tangent.
    const from = s === 0 ? 0 : 1;

    for (let i = from; i <= steps; i++) {
      const t = i / steps;
      const it = 1 - t;
      const a = it * it * it;
      const b = 3 * it * it * t;
      const c = 3 * it * t * t;
      const d = t * t * t;
      samples.push({
        x: a * seg.p0.x + b * seg.cp1.x + c * seg.cp2.x + d * seg.p1.x,
        y: a * seg.p0.y + b * seg.cp1.y + c * seg.cp2.y + d * seg.p1.y,
        w: seg.widthStart + (seg.widthEnd - seg.widthStart) * t
      });
    }
  }

  return samples;
}

/**
 * Emits a sampled round cap as line segments. The swept arc runs from the
 * ribbon's `n` edge, around the tip along `d`, to the opposite edge.
 */
function emitRoundCap(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  half: number,
  nx: number,
  ny: number,
  dx: number,
  dy: number
): void {
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * Math.PI;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    ctx.lineTo(cx + half * (cos * nx + sin * dx), cy + half * (cos * ny + sin * dy));
  }
}

/**
 * Builds ONE closed outline for the whole stroke: the variable-width ribbon
 * (left edge forward, round cap, right edge backward, round cap).
 *
 * The pen used to stroke every cubic segment separately, which banded the width
 * at each junction and re-composited the overlap — the chalky, seamed look. A
 * single filled outline has no seams and gets proper coverage anti-aliasing
 * from the rasteriser along its whole boundary.
 *
 * Returns false when there is nothing to draw.
 */
function buildInkRibbon(ctx: CanvasRenderingContext2D, segments: CurveSegment[]): boolean {
  const samples = sampleRibbonCenterline(segments);
  if (samples.length === 0) return false;

  ctx.beginPath();

  if (samples.length === 1) {
    const s = samples[0];
    ctx.arc(s.x, s.y, Math.max(MIN_DOT_WIDTH, s.w) / 2, 0, Math.PI * 2);
    return true;
  }

  const count = samples.length;
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  const dirs: Array<{ dx: number; dy: number }> = [];

  for (let i = 0; i < count; i++) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(count - 1, i + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      // Degenerate tangent (coincident samples): reuse the previous direction.
      const prevDir = dirs[i - 1] || { dx: 1, dy: 0 };
      dx = prevDir.dx;
      dy = prevDir.dy;
    } else {
      dx /= len;
      dy /= len;
    }
    dirs.push({ dx, dy });

    const half = Math.max(MIN_INK_WIDTH, samples[i].w) / 2;
    const nx = -dy;
    const ny = dx;
    left.push({ x: samples[i].x + nx * half, y: samples[i].y + ny * half });
    right.push({ x: samples[i].x - nx * half, y: samples[i].y - ny * half });
  }

  const last = count - 1;

  // Left edge, forward.
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < count; i++) {
    ctx.lineTo(left[i].x, left[i].y);
  }

  // End cap: left edge -> tip -> right edge.
  emitRoundCap(
    ctx,
    samples[last].x,
    samples[last].y,
    Math.max(MIN_INK_WIDTH, samples[last].w) / 2,
    -dirs[last].dy,
    dirs[last].dx,
    dirs[last].dx,
    dirs[last].dy
  );

  // Right edge, backward.
  for (let i = last; i >= 0; i--) {
    ctx.lineTo(right[i].x, right[i].y);
  }

  // Start cap: right edge -> tail -> left edge.
  emitRoundCap(
    ctx,
    samples[0].x,
    samples[0].y,
    Math.max(MIN_INK_WIDTH, samples[0].w) / 2,
    dirs[0].dy,
    -dirs[0].dx,
    -dirs[0].dx,
    -dirs[0].dy
  );

  ctx.closePath();
  return true;
}

/**
 * Draws variable-width ink as a single filled ribbon. Shared by the committed
 * and live renderers so the preview and the final ink are identical.
 */
export function renderInkRibbon(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  color: string,
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): void {
  if (points.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = color;

  if (points.length === 1) {
    const p = points[0];
    const w = calculateStrokeWidth(baseWidth, p.pressure, pressureCurve, pressureEnabled, strength);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(MIN_DOT_WIDTH, w) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const segments = generateSmoothSegments(points, baseWidth, pressureCurve, pressureEnabled, strength);
  if (buildInkRibbon(ctx, segments)) {
    ctx.fill();
  }
  ctx.restore();
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
export function normalizeHighlighterColor(color: string, alpha = 0.3): string {
  const c = color.trim();
  const clampedAlpha = Math.min(0.95, Math.max(0.05, alpha));
  const hexMatch = c.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }
  const rgbaMatch = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgbaMatch) {
    const r = rgbaMatch[1];
    const g = rgbaMatch[2];
    const b = rgbaMatch[3];
    const a = rgbaMatch[4] !== undefined ? Math.min(0.95, Math.max(0.05, parseFloat(rgbaMatch[4]))) : clampedAlpha;
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
  tipShape: 'chisel' | 'round' = 'round',
  smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium'
): void {
  if (points.length === 0) return;

  // Finalized pen points are already smoothed in real-time as drawn; the
  // highlighter still benefits from a light pass to settle jitter.
  const pts = isHighlighter ? smoothStrokePoints(points, smoothing === 'none' ? 'none' : 'subtle') : points;

  ctx.save();
  ctx.lineCap = tipShape === 'chisel' ? 'square' : 'round';
  ctx.lineJoin = tipShape === 'chisel' ? 'miter' : 'round';
  ctx.imageSmoothingEnabled = true;

  if (pts.length === 1) {
    const w = isHighlighter
      ? baseWidth
      : calculateStrokeWidth(baseWidth, pts[0].pressure, pressureCurve, pressureEnabled, strength);
    ctx.fillStyle = isHighlighter ? normalizeHighlighterColor(color) : color;
    ctx.beginPath();
    // Pen taps get the same minimum radius as the ribbon so a light touch still
    // leaves a round dot instead of a pixel of grey.
    ctx.arc(pts[0].x, pts[0].y, (isHighlighter ? w : Math.max(MIN_DOT_WIDTH, w)) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (isHighlighter) {
    // NOTE: annotations render on a transparent overlay canvas above the PDF,
    // so `multiply` cannot blend with the page below (it only blends within
    // the overlay itself, darkening self-overlaps). Use normal alpha blending
    // with a translucent color instead — text stays readable. A single
    // continuous cubic path keeps translucent ink from darkening at seams.
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = normalizeHighlighterColor(color);
    ctx.lineWidth = baseWidth;
    const segs = generateSmoothSegments(pts, baseWidth, pressureCurve, false, strength);
    ctx.beginPath();
    ctx.moveTo(segs[0].p0.x, segs[0].p0.y);
    for (const seg of segs) {
      ctx.bezierCurveTo(seg.cp1.x, seg.cp1.y, seg.cp2.x, seg.cp2.y, seg.p1.x, seg.p1.y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Pen: one filled ribbon for the whole stroke, so nothing bands at the
  // segment junctions (see buildInkRibbon). Whether or not pressure is enabled
  // the path is the same centripetal Catmull-Rom fit — calculateStrokeWidth
  // simply returns baseWidth when pressure is off.
  ctx.restore();
  renderInkRibbon(ctx, points, color, baseWidth, pressureCurve, pressureEnabled, strength);
}

/**
 * Live stroke renderer for active drawing feedback. Delegates to the same
 * ribbon builder as the committed renderer, so the ink under the pen and the
 * ink left on the page are pixel-identical and nothing "snaps" on release.
 */
export function renderLiveStroke(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  color: string,
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): void {
  renderInkRibbon(ctx, points, color, baseWidth, pressureCurve, pressureEnabled, strength);
}

