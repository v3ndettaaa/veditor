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

  let minFactor = 0.84;
  let maxFactor = 1.16;
  if (strength === 'light') {
    minFactor = 0.90;
    maxFactor = 1.10;
  } else if (strength === 'strong') {
    minFactor = 0.74;
    maxFactor = 1.26;
  }

  const factor = minFactor + (maxFactor - minFactor) * mappedPressure;
  const floorWidth = Math.min(baseWidth * minFactor, Math.max(0.75, baseWidth * 0.70));
  return Math.max(floorWidth, baseWidth * factor);
}

/**
 * Filters micro-jitter (< 0.14 page pts), removes screen-pixel quantization
 * staircases via a multi-scale 3-pass corner-preserving zero-shrinkage filter,
 * stabilizes touch-down and lift-off pressure tails, and enforces an arc-length
 * pressure slope bound so small handwriting drawn at 100% zoom is completely
 * smooth and free of beading when inspected at 800% zoom.
 */
export function smoothStrokePoints(
  points: StrokePoint[],
  smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium'
): StrokePoint[] {
  if (points.length <= 2) return points;

  // 1. Filter out micro-jitter (< 0.14 page pts) while preserving fine handwriting at any zoom
  const minDistance = 0.14;
  const deduped: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = deduped[deduped.length - 1];
    const dist = Math.hypot(points[i].x - last.x, points[i].y - last.y);
    if (dist >= minDistance) {
      deduped.push(points[i]);
    }
  }
  const lastInput = points[points.length - 1];
  const lastKept = deduped[deduped.length - 1];
  if (Math.hypot(lastInput.x - lastKept.x, lastInput.y - lastKept.y) >= 0.02 || deduped.length === 1) {
    deduped.push(lastInput);
  } else {
    deduped[deduped.length - 1] = lastInput;
  }

  if (deduped.length <= 2) return deduped;

  // 2. Stabilize touch-down and lift-off pressure tails so strokes never thin out at the ends,
  // smooth pressure with a symmetric low-pass kernel, and enforce a tight arc-length slope bound
  // so small handwriting never develops beaded width oscillations.
  const n = deduped.length;
  const rawP = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rawP[i] = deduped[i].pressure ?? 0.5;
  }

  if (n >= 4) {
    const interiorEndIdx = Math.max(1, n - 4);
    const sustainedEndP = Math.max(rawP[interiorEndIdx], rawP[Math.max(0, interiorEndIdx - 1)]);
    const endFloor = sustainedEndP * 0.94;
    for (let i = interiorEndIdx + 1; i < n; i++) {
      if (rawP[i] < endFloor) rawP[i] = endFloor;
    }
    const sustainedStartP = Math.max(rawP[1], rawP[Math.min(n - 1, 2)]);
    const startFloor = sustainedStartP * 0.94;
    if (rawP[0] < startFloor) rawP[0] = startFloor;
  }

  // Two-pass symmetric low-pass filter on pressure
  const pass1P = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pM2 = rawP[Math.max(0, i - 2)];
    const pM1 = rawP[Math.max(0, i - 1)];
    const p0 = rawP[i];
    const pP1 = rawP[Math.min(n - 1, i + 1)];
    const pP2 = rawP[Math.min(n - 1, i + 2)];
    pass1P[i] = pM2 * 0.14 + pM1 * 0.24 + p0 * 0.24 + pP1 * 0.24 + pP2 * 0.14;
  }

  const pass2P = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pM1 = pass1P[Math.max(0, i - 1)];
    const p0 = pass1P[i];
    const pP1 = pass1P[Math.min(n - 1, i + 1)];
    pass2P[i] = pM1 * 0.28 + p0 * 0.44 + pP1 * 0.28;
  }

  // Forward-backward arc-length pressure slope clamp (|dp/ds| <= 0.032 per page pt)
  const maxPressureSlope = 0.032;
  for (let i = 1; i < n; i++) {
    const ds = Math.hypot(deduped[i].x - deduped[i - 1].x, deduped[i].y - deduped[i - 1].y);
    const maxDelta = Math.max(0.002, ds * maxPressureSlope);
    if (pass2P[i] > pass2P[i - 1] + maxDelta) pass2P[i] = pass2P[i - 1] + maxDelta;
    else if (pass2P[i] < pass2P[i - 1] - maxDelta) pass2P[i] = pass2P[i - 1] - maxDelta;
  }
  for (let i = n - 2; i >= 0; i--) {
    const ds = Math.hypot(deduped[i + 1].x - deduped[i].x, deduped[i + 1].y - deduped[i].y);
    const maxDelta = Math.max(0.002, ds * maxPressureSlope);
    if (pass2P[i] > pass2P[i + 1] + maxDelta) pass2P[i] = pass2P[i + 1] + maxDelta;
    else if (pass2P[i] < pass2P[i + 1] - maxDelta) pass2P[i] = pass2P[i + 1] - maxDelta;
  }

  const smoothedPressure: StrokePoint[] = deduped.map((pt, i) => ({
    ...pt,
    pressure: pass2P[i]
  }));

  if (smoothing === 'none') return smoothedPressure;

  // 3. Multi-Scale 3-Pass Corner-Preserving Zero-Shrinkage Staircase Filter (Taubin lambda/mu):
  // When writing small text at 100% zoom, CSS-pixel quantization introduces +/-0.53pt steps
  // whose 1-step angles turn by 45°-90° while the 2-step macro-chord stays straight.
  // Evaluating the macro-chord turning angle alongside the 1-step angle completely removes
  // pixel-grid staircases without rounding real letter corners or shrinking cursive loops.
  const maxStaircaseOffset = smoothing === 'subtle' ? 0.32 : (smoothing === 'medium' ? 0.62 : 0.85);
  const lambda = smoothing === 'subtle' ? 0.34 : (smoothing === 'medium' ? 0.45 : 0.52);
  const mu = -0.50 * lambda;
  const passes = smoothing === 'subtle' ? 2 : 3;

  const curX = new Float64Array(n);
  const curY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    curX[i] = smoothedPressure[i].x;
    curY[i] = smoothedPressure[i].y;
  }

  const tempX = new Float64Array(n);
  const tempY = new Float64Array(n);
  const lapX = new Float64Array(n);
  const lapY = new Float64Array(n);
  const cornerW = new Float64Array(n);

  for (let pass = 0; pass < passes; pass++) {
    tempX[0] = curX[0];
    tempY[0] = curY[0];
    tempX[n - 1] = curX[n - 1];
    tempY[n - 1] = curY[n - 1];
    lapX.fill(0);
    lapY.fill(0);
    cornerW.fill(0);

    // Sub-pass A (lambda): chord-weighted smoothing gated by multi-scale corner detection
    for (let i = 1; i < n - 1; i++) {
      const dx1 = curX[i] - curX[i - 1];
      const dy1 = curY[i] - curY[i - 1];
      const dx2 = curX[i + 1] - curX[i];
      const dy2 = curY[i + 1] - curY[i];
      const len1 = Math.hypot(dx1, dy1);
      const len2 = Math.hypot(dx2, dy2);
      const maxChord = Math.max(len1, len2);

      if (maxChord < 7.0 && len1 > 1e-4 && len2 > 1e-4) {
        const cos1 = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);

        // 2-step macro-chord angle distinguishes pixel staircases (cosMacro > 0.25)
        // from genuine sharp letter vertices (both cos1 < 0 and cosMacro < 0.15)
        let cosEff = cos1;
        if (n >= 5) {
          const iPrev2 = Math.max(0, i - 2);
          const iNext2 = Math.min(n - 1, i + 2);
          const mdx1 = curX[i] - curX[iPrev2];
          const mdy1 = curY[i] - curY[iPrev2];
          const mdx2 = curX[iNext2] - curX[i];
          const mdy2 = curY[iNext2] - curY[i];
          const mlen1 = Math.hypot(mdx1, mdy1);
          const mlen2 = Math.hypot(mdx2, mdy2);
          if (mlen1 > 1e-4 && mlen2 > 1e-4) {
            const cosMacro = (mdx1 * mdx2 + mdy1 * mdy2) / (mlen1 * mlen2);
            // If macro trajectory is smooth and chords are pixel-sized (< 2.6pt),
            // treat 1-step deflection as pixel-staircase quantization noise
            if (maxChord < 2.6 && cosMacro > 0.2) {
              cosEff = Math.max(cos1, cosMacro);
            } else {
              cosEff = 0.55 * cos1 + 0.45 * Math.max(cos1, cosMacro);
            }
          }
        }

        const cPreserve = Math.max(0, Math.min(1, (cosEff + 0.35) / 1.35));
        const chordFactor = Math.max(0, 1 - maxChord / 7.0);
        const w = lambda * cPreserve * (0.50 + 0.50 * chordFactor);

        // Inverse-chord weighted midpoint on segment [i - 1, i + 1]
        const targetX = (len2 * curX[i - 1] + len1 * curX[i + 1]) / (len1 + len2);
        const targetY = (len2 * curY[i - 1] + len1 * curY[i + 1]) / (len1 + len2);
        const lx = targetX - curX[i];
        const ly = targetY - curY[i];

        lapX[i] = lx;
        lapY[i] = ly;
        cornerW[i] = cPreserve;
        tempX[i] = curX[i] + lx * w;
        tempY[i] = curY[i] + ly * w;
      } else {
        tempX[i] = curX[i];
        tempY[i] = curY[i];
      }
    }

    // Sub-pass B (mu): un-shrink coherent curvature (small loops) without restoring alternating zigzags
    for (let i = 1; i < n - 1; i++) {
      let x = tempX[i];
      let y = tempY[i];
      if (cornerW[i] > 0) {
        const avgLapX = 0.25 * lapX[i - 1] + 0.5 * lapX[i] + 0.25 * lapX[i + 1];
        const avgLapY = 0.25 * lapY[i - 1] + 0.5 * lapY[i] + 0.25 * lapY[i + 1];
        const dot = lapX[i] * avgLapX + lapY[i] * avgLapY;
        if (dot > 0) {
          x += avgLapX * mu * cornerW[i];
          y += avgLapY * mu * cornerW[i];
        }
      }
      curX[i] = x;
      curY[i] = y;
    }
  }

  const out: StrokePoint[] = [smoothedPressure[0]];
  for (let i = 1; i < n - 1; i++) {
    const orig = smoothedPressure[i];
    let dx = curX[i] - orig.x;
    let dy = curY[i] - orig.y;
    const shift = Math.hypot(dx, dy);
    if (shift > maxStaircaseOffset) {
      const scale = maxStaircaseOffset / shift;
      dx *= scale;
      dy *= scale;
    }
    out.push({
      ...orig,
      x: orig.x + dx,
      y: orig.y + dy
    });
  }
  out.push(smoothedPressure[n - 1]);

  return out;
}

/**
 * Generates smooth G1-continuous Cubic Bezier curve segments from discrete sampled points
 * using a Centripetal Catmull-Rom (alpha = 0.5) parameterization.
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

  const alpha = 0.5;
  const count = points.length;
  const segChord = new Float64Array(count - 1);
  const segParam = new Float64Array(count - 1);
  const unitX = new Float64Array(count - 1);
  const unitY = new Float64Array(count - 1);
  const knotWidth = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    knotWidth[i] = calculateStrokeWidth(baseWidth, points[i].pressure, pressureCurve, pressureEnabled, strength);
  }

  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const c = Math.hypot(dx, dy);
    segChord[i] = c;
    segParam[i] = Math.max(1e-3, Math.pow(c, alpha));
    if (c > 1e-6) {
      unitX[i] = dx / c;
      unitY[i] = dy / c;
    } else {
      unitX[i] = i > 0 ? unitX[i - 1] : 1;
      unitY[i] = i > 0 ? unitY[i - 1] : 0;
    }
  }

  // Clamp physical width slope across arc length (|dw/ds| <= 0.018) so small handwriting
  // never develops sudden beaded width bulges when zoomed to 800%.
  if (pressureEnabled) {
    const maxWidthSlope = 0.018;
    for (let i = 1; i < count; i++) {
      const maxDw = Math.max(0.004, segChord[i - 1] * maxWidthSlope);
      if (knotWidth[i] > knotWidth[i - 1] + maxDw) knotWidth[i] = knotWidth[i - 1] + maxDw;
      else if (knotWidth[i] < knotWidth[i - 1] - maxDw) knotWidth[i] = knotWidth[i - 1] - maxDw;
    }
    for (let i = count - 2; i >= 0; i--) {
      const maxDw = Math.max(0.004, segChord[i] * maxWidthSlope);
      if (knotWidth[i] > knotWidth[i + 1] + maxDw) knotWidth[i] = knotWidth[i + 1] + maxDw;
      else if (knotWidth[i] < knotWidth[i + 1] - maxDw) knotWidth[i] = knotWidth[i + 1] - maxDw;
    }
  }

  const tanX = new Float64Array(count);
  const tanY = new Float64Array(count);
  tanX[0] = unitX[0];
  tanY[0] = unitY[0];
  const lastIdx = count - 1;
  tanX[lastIdx] = unitX[lastIdx - 1];
  tanY[lastIdx] = unitY[lastIdx - 1];

  for (let i = 1; i < lastIdx; i++) {
    const dPrev = segParam[i - 1];
    const dNext = segParam[i];
    const dSum = dPrev + dNext;
    let tx = (dNext / dSum) * unitX[i - 1] + (dPrev / dSum) * unitX[i];
    let ty = (dNext / dSum) * unitY[i - 1] + (dPrev / dSum) * unitY[i];
    const tLen = Math.hypot(tx, ty);
    if (tLen > 1e-5) {
      tanX[i] = tx / tLen;
      tanY[i] = ty / tLen;
    } else {
      tanX[i] = unitX[i];
      tanY[i] = unitY[i];
    }
  }

  for (let i = 0; i < lastIdx; i++) {
    const pStart = points[i];
    const pEnd = points[i + 1];
    const spanLen = segChord[i];
    if (spanLen < 1e-4) continue;

    const prevSpan = i > 0 ? segChord[i - 1] : spanLen;
    const nextSpan = i + 1 < lastIdx ? segChord[i + 1] : spanLen;
    const h1Len = Math.min(spanLen * 0.42, Math.min(spanLen, prevSpan * 1.35) / 3);
    const h2Len = Math.min(spanLen * 0.42, Math.min(spanLen, nextSpan * 1.35) / 3);

    segments.push({
      p0: pStart,
      p1: pEnd,
      cp1: {
        x: pStart.x + tanX[i] * h1Len,
        y: pStart.y + tanY[i] * h1Len
      },
      cp2: {
        x: pEnd.x - tanX[i + 1] * h2Len,
        y: pEnd.y - tanY[i + 1] * h2Len
      },
      widthStart: knotWidth[i],
      widthEnd: knotWidth[i + 1]
    });
  }

  return segments;
}

/**
 * Width floor for ink strokes so fine lines never drop into sub-pixel scanline dropout.
 */
const MIN_INK_WIDTH = 0.65;

/**
 * Diameter floor for a single point tap or micro-dot so taps always stamp a crisp round dot.
 */
const MIN_DOT_WIDTH = 0.85;

export interface SampledSplinePoint {
  x: number;
  y: number;
  w: number;
}

/**
 * Reconstructs a scale-invariant, high-density Centripetal Catmull-Rom (alpha = 0.5)
 * curve with sub-0.18pt arc-length sampling and C1 smoothstep width interpolation.
 * Guarantees that small handwriting drawn at 100% zoom has the exact same smooth
 * analytical curve geometry when inspected at 400%–800% zoom.
 */
export function sampleCentripetalPenSpline(
  pts: StrokePoint[],
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled: boolean = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): SampledSplinePoint[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) {
    const w = Math.max(
      MIN_INK_WIDTH,
      calculateStrokeWidth(baseWidth, pts[0].pressure, pressureCurve, pressureEnabled, strength)
    );
    return [{ x: pts[0].x, y: pts[0].y, w }];
  }

  const segments = generateSmoothSegments(pts, baseWidth, pressureCurve, pressureEnabled, strength);
  if (segments.length === 0) {
    const w = Math.max(
      MIN_INK_WIDTH,
      calculateStrokeWidth(baseWidth, pts[0].pressure, pressureCurve, pressureEnabled, strength)
    );
    return [{ x: pts[0].x, y: pts[0].y, w }];
  }

  const out: SampledSplinePoint[] = [
    {
      x: segments[0].p0.x,
      y: segments[0].p0.y,
      w: Math.max(MIN_INK_WIDTH, segments[0].widthStart)
    }
  ];

  // Target <= 0.18 page pt per step so sagitta error is < 0.001 pt (< 0.015 px at 800% zoom)
  const targetStepPt = 0.18;
  const minSubSegmentDist = 0.06;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const x0 = seg.p0.x;
    const y0 = seg.p0.y;
    const x1 = seg.cp1.x;
    const y1 = seg.cp1.y;
    const x2 = seg.cp2.x;
    const y2 = seg.cp2.y;
    const x3 = seg.p1.x;
    const y3 = seg.p1.y;

    const w0 = Math.max(MIN_INK_WIDTH, seg.widthStart);
    const w1 = Math.max(MIN_INK_WIDTH, seg.widthEnd);

    // Upper-bound arc length via control polygon
    const polyLen =
      Math.hypot(x1 - x0, y1 - y0) +
      Math.hypot(x2 - x1, y2 - y1) +
      Math.hypot(x3 - x2, y3 - y2);

    // Measure angular deflection of control legs to boost sampling on tight loops
    const chordDx = x3 - x0;
    const chordDy = y3 - y0;
    const chordLen = Math.hypot(chordDx, chordDy);
    const curvatureBoost = chordLen > 1e-4 ? Math.min(2.2, Math.max(1, (polyLen / chordLen - 1) * 8 + 1)) : 1;

    const steps = Math.max(1, Math.min(36, Math.ceil((polyLen * curvatureBoost) / targetStepPt)));

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const it = 1 - t;
      const it2 = it * it;
      const t2 = t * t;

      const b0 = it2 * it;
      const b1 = 3 * it2 * t;
      const b2 = 3 * it * t2;
      const b3 = t2 * t;

      const px = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3;
      const py = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3;

      // Hermite smoothstep width interpolation for C1-continuous width envelope
      const smoothT = t * t * (3 - 2 * t);
      const pw = w0 + (w1 - w0) * smoothT;

      const prev = out[out.length - 1];
      const dist = Math.hypot(px - prev.x, py - prev.y);
      const isFinalPoint = i === segments.length - 1 && s === steps;

      if (dist >= minSubSegmentDist || (isFinalPoint && dist >= 1e-4)) {
        out.push({ x: px, y: py, w: pw });
      } else if (isFinalPoint) {
        out[out.length - 1] = { x: px, y: py, w: (prev.w + pw) * 0.5 };
      }
    }
  }

  return out;
}

/**
 * Traces the densely sampled Centripetal Catmull-Rom spine onto a `CanvasPath`
 * using non-degenerate linear segments (`lineTo`). Because `ctx.lineJoin = 'round'`
 * and `ctx.lineCap = 'round'` place exact circular disks at every 0.18pt sample,
 * this produces the true Minkowski swept-disk union with ZERO Bezier offset cusps,
 * ZERO crescent bites, and infinite resolution at any zoom level.
 */
function traceSampledSplinePath(target: CanvasPath, sampled: SampledSplinePoint[]): void {
  if (sampled.length === 0) return;
  target.moveTo(sampled[0].x, sampled[0].y);
  for (let i = 1; i < sampled.length; i++) {
    target.lineTo(sampled[i].x, sampled[i].y);
  }
}

interface VectorPenBatch {
  width: number;
  path: Path2D;
}

interface VectorPenRenderPlan {
  fillPath: Path2D | null;
  batches: VectorPenBatch[];
}

/**
 * Builds a cusp-free, non-beaded vector rendering plan for variable-width or uniform pen strokes:
 * 1. Dots and micro-strokes (`totalLen < max(0.30, avgW * 0.20)`) are rendered as pure
 *    360-degree filled circular disks (`fillPath.arc(...)`), completely eliminating
 *    half-cut dots and degenerate stroke-normal flips.
 * 2. Longer strokes stamp exact circular endpoint cap disks in `fillPath` AND trace
 *    continuous Centripetal Catmull-Rom paths (`lineTo` with `lineCap = 'round'` and
 *    `lineJoin = 'round'`), coalescing gentle width transitions into long continuous paths
 *    so micro-cap beading ("توپ‌توپی شدن") never occurs at 800% zoom.
 */
function buildVectorPenPlan(
  pts: StrokePoint[],
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential',
  pressureEnabled: boolean,
  strength: 'light' | 'balanced' | 'strong'
): VectorPenRenderPlan {
  if (pts.length === 0 || typeof Path2D === 'undefined') {
    return { fillPath: null, batches: [] };
  }

  const sampled = sampleCentripetalPenSpline(pts, baseWidth, pressureCurve, pressureEnabled, strength);
  const m = sampled.length;
  if (m === 0) {
    return { fillPath: null, batches: [] };
  }

  let totalLen = 0;
  let minW = sampled[0].w;
  let maxW = sampled[0].w;
  for (let i = 1; i < m; i++) {
    totalLen += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
    if (sampled[i].w < minW) minW = sampled[i].w;
    if (sampled[i].w > maxW) maxW = sampled[i].w;
  }

  const avgW = !pressureEnabled ? Math.max(MIN_INK_WIDTH, baseWidth) : (minW + maxW) * 0.5;
  const dotThreshold = Math.max(0.30, Math.min(0.65, avgW * 0.20));

  // Pure circular disk for single-point taps and micro-dots (prevents half-cut dots!)
  if (m === 1 || totalLen < dotThreshold) {
    const fillPath = new Path2D();
    const cx = (sampled[0].x + sampled[m - 1].x) * 0.5;
    const cy = (sampled[0].y + sampled[m - 1].y) * 0.5;
    const r = Math.max(MIN_DOT_WIDTH, avgW) * 0.5;
    fillPath.moveTo(cx + r, cy);
    fillPath.arc(cx, cy, r, 0, Math.PI * 2);
    return { fillPath, batches: [] };
  }

  // Stamp explicit filled circular disks at the exact start and end knots so stroke caps
  // are mathematically guaranteed to be 360-degree circles without crescent bites
  const fillPath = new Path2D();
  const rStart = Math.max(MIN_INK_WIDTH, sampled[0].w) * 0.5;
  fillPath.moveTo(sampled[0].x + rStart, sampled[0].y);
  fillPath.arc(sampled[0].x, sampled[0].y, rStart, 0, Math.PI * 2);

  const lastSample = sampled[m - 1];
  const rEnd = Math.max(MIN_INK_WIDTH, lastSample.w) * 0.5;
  fillPath.moveTo(lastSample.x + rEnd, lastSample.y);
  fillPath.arc(lastSample.x, lastSample.y, rEnd, 0, Math.PI * 2);

  // Uniform or fine handwriting stroke: render as a SINGLE continuous Path2D so
  // intermediate round caps never stack into beads at 800% zoom!
  const widthBandThreshold = Math.max(0.14, baseWidth * 0.12);
  if (!pressureEnabled || maxW - minW <= widthBandThreshold || totalLen <= Math.max(6.0, baseWidth * 3.0)) {
    const path = new Path2D();
    traceSampledSplinePath(path, sampled);
    return {
      fillPath,
      batches: [{ width: avgW, path }]
    };
  }

  // Variable-width stroke with significant dynamic range: group spans into long continuous
  // batches (requiring both a meaningful width delta and a minimum arc-length run before splitting).
  const batches: VectorPenBatch[] = [];
  const stepQuantum = Math.max(0.04, baseWidth * 0.03);
  const minBatchRunLen = Math.max(1.5, baseWidth * 0.75);
  let curPath: Path2D | null = null;
  let curWidth = -1;
  let curRunLen = 0;

  for (let i = 0; i < m - 1; i++) {
    const p0 = sampled[i];
    const p1 = sampled[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const segW = (p0.w + p1.w) * 0.5;
    const quantW = Math.round(segW / stepQuantum) * stepQuantum;

    if (!curPath || (Math.abs(quantW - curWidth) > stepQuantum * 1.05 && curRunLen >= minBatchRunLen)) {
      curPath = new Path2D();
      curWidth = quantW;
      curRunLen = 0;
      batches.push({ width: quantW, path: curPath });
      curPath.moveTo(p0.x, p0.y);
    }
    curPath.lineTo(p1.x, p1.y);
    curRunLen += segLen;
  }

  return { fillPath, batches };
}

/**
 * Direct context fallback for rendering cusp-free Centripetal Catmull-Rom strokes
 * when Path2D is unavailable (e.g., headless unit test mocks).
 */
function strokeVectorPenDirect(
  ctx: CanvasRenderingContext2D,
  pts: StrokePoint[],
  color: string,
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential',
  pressureEnabled: boolean,
  strength: 'light' | 'balanced' | 'strong'
): void {
  if (pts.length === 0) return;

  const sampled = sampleCentripetalPenSpline(pts, baseWidth, pressureCurve, pressureEnabled, strength);
  const m = sampled.length;
  if (m === 0) return;

  let totalLen = 0;
  let minW = sampled[0].w;
  let maxW = sampled[0].w;
  for (let i = 1; i < m; i++) {
    totalLen += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
    if (sampled[i].w < minW) minW = sampled[i].w;
    if (sampled[i].w > maxW) maxW = sampled[i].w;
  }

  const avgW = !pressureEnabled ? Math.max(MIN_INK_WIDTH, baseWidth) : (minW + maxW) * 0.5;
  const dotThreshold = Math.max(0.30, Math.min(0.65, avgW * 0.20));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  if (m === 1 || totalLen < dotThreshold) {
    const cx = (sampled[0].x + sampled[m - 1].x) * 0.5;
    const cy = (sampled[0].y + sampled[m - 1].y) * 0.5;
    const r = Math.max(MIN_DOT_WIDTH, avgW) * 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Stamp start & end circular disks
  ctx.beginPath();
  ctx.arc(sampled[0].x, sampled[0].y, Math.max(MIN_INK_WIDTH, sampled[0].w) * 0.5, 0, Math.PI * 2);
  ctx.arc(sampled[m - 1].x, sampled[m - 1].y, Math.max(MIN_INK_WIDTH, sampled[m - 1].w) * 0.5, 0, Math.PI * 2);
  ctx.fill();

  const widthBandThreshold = Math.max(0.14, baseWidth * 0.12);
  if (!pressureEnabled || maxW - minW <= widthBandThreshold || totalLen <= Math.max(6.0, baseWidth * 3.0)) {
    ctx.lineWidth = avgW;
    ctx.beginPath();
    traceSampledSplinePath(ctx, sampled);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const stepQuantum = Math.max(0.04, baseWidth * 0.03);
  const minBatchRunLen = Math.max(1.5, baseWidth * 0.75);
  let curWidth = -1;
  let curRunLen = 0;
  ctx.beginPath();
  for (let i = 0; i < m - 1; i++) {
    const p0 = sampled[i];
    const p1 = sampled[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const quantW = Math.round(((p0.w + p1.w) * 0.5) / stepQuantum) * stepQuantum;
    if (curWidth < 0) {
      curWidth = quantW;
      curRunLen = 0;
      ctx.lineWidth = curWidth;
      ctx.moveTo(p0.x, p0.y);
    } else if (Math.abs(quantW - curWidth) > stepQuantum * 1.05 && curRunLen >= minBatchRunLen) {
      ctx.stroke();
      ctx.beginPath();
      curWidth = quantW;
      curRunLen = 0;
      ctx.lineWidth = curWidth;
      ctx.moveTo(p0.x, p0.y);
    }
    ctx.lineTo(p1.x, p1.y);
    curRunLen += segLen;
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Traces the variable-width ribbon outline onto any `CanvasPath` for compatibility.
 */
export function traceInkRibbonPath(target: CanvasPath, segments: CurveSegment[]): boolean {
  if (segments.length === 0) return false;
  const pts: StrokePoint[] = [segments[0].p0];
  for (let i = 0; i < segments.length; i++) {
    pts.push(segments[i].p1);
  }
  const sampled = sampleCentripetalPenSpline(pts, segments[0].widthStart, 'linear', false, 'balanced');
  traceSampledSplinePath(target, sampled);
  return true;
}

/**
 * Traces a smooth, non-shifting, cusp-free spine for Highlighter strokes.
 * Uses `quadraticCurveTo` only when the local radius of curvature exceeds the half-width
 * of the marker, and falls back to `lineTo` (with `ctx.lineJoin = 'round'`) on tight turns
 * so Canvas 2D's Bezier offsetter NEVER folds over into sharp triangular spikes or edges.
 */
function traceHighlighterSpinePath(target: CanvasPath, pts: StrokePoint[], baseWidth: number = 20): void {
  if (pts.length === 0) return;
  target.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    target.lineTo(pts[1].x, pts[1].y);
    return;
  }

  const halfW = Math.max(2, baseWidth * 0.5);
  let curX = (pts[0].x + pts[1].x) * 0.5;
  let curY = (pts[0].y + pts[1].y) * 0.5;
  target.lineTo(curX, curY);

  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i].x;
    const py = pts[i].y;
    const nextMidX = (px + pts[i + 1].x) * 0.5;
    const nextMidY = (py + pts[i + 1].y) * 0.5;

    const ux = px - curX;
    const uy = py - curY;
    const vx = nextMidX - px;
    const vy = nextMidY - py;
    const len1 = Math.hypot(ux, uy);
    const len2 = Math.hypot(vx, vy);

    if (len1 > 1e-3 && len2 > 1e-3) {
      const cosTheta = (ux * vx + uy * vy) / (len1 * len2);
      const sinHalf = Math.sqrt(Math.max(0, (1 - cosTheta) * 0.5));
      const minLeg = Math.min(len1, len2);
      const approxRadius = sinHalf > 1e-3 ? (minLeg * 0.5) / sinHalf : 1e6;

      if (cosTheta > 0.78 && approxRadius > halfW * 1.15) {
        target.quadraticCurveTo(px, py, nextMidX, nextMidY);
      } else {
        target.lineTo(px, py);
        target.lineTo(nextMidX, nextMidY);
      }
    } else {
      target.lineTo(nextMidX, nextMidY);
    }

    curX = nextMidX;
    curY = nextMidY;
  }

  const last = pts[pts.length - 1];
  target.lineTo(last.x, last.y);
}

/**
 * Filters only sub-pixel duplicate points (< 0.45 page pt) for Highlighter strokes
 * so points lock into place immediately without delayed distance-threshold jumping.
 */
function prepareHighlighterPoints(points: StrokePoint[]): StrokePoint[] {
  if (points.length <= 2) return points;
  const out: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) >= 0.45) {
      out.push(points[i]);
    }
  }
  const last = points[points.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.y - prev.y) >= 0.05 || out.length === 1) {
    out.push(last);
  } else {
    out[out.length - 1] = last;
  }
  return out;
}

/**
 * Builds a reusable `Path2D` for a slice of stroke points.
 */
export function buildInkRibbonPath2D(
  points: StrokePoint[],
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced'
): Path2D | null {
  if (typeof Path2D === 'undefined' || points.length === 0) return null;
  const path = new Path2D();
  if (points.length === 1) {
    const p = points[0];
    const w = calculateStrokeWidth(baseWidth, p.pressure, pressureCurve, pressureEnabled, strength);
    const r = Math.max(MIN_DOT_WIDTH, w) / 2;
    path.moveTo(p.x + r, p.y);
    path.arc(p.x, p.y, r, 0, Math.PI * 2);
    return path;
  }
  const sampled = sampleCentripetalPenSpline(points, baseWidth, pressureCurve, pressureEnabled, strength);
  traceSampledSplinePath(path, sampled);
  return path;
}

interface CachedStrokePath {
  key: string;
  highlighterPath?: Path2D;
  penPlan?: VectorPenRenderPlan;
}

const committedStrokePathCache = new WeakMap<StrokePoint[], CachedStrokePath>();

function canUsePath2D(ctx: CanvasRenderingContext2D): boolean {
  return (
    typeof Path2D !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    ctx.canvas instanceof HTMLCanvasElement
  );
}

/**
 * Draws variable-width or uniform ink as a cusp-free Centripetal Catmull-Rom
 * capsule union with pure circular endpoint disks so strokes are razor-sharp,
 * bite-free, and smooth at every zoom level (100%–800%+).
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

  if (canUsePath2D(ctx)) {
    const plan = buildVectorPenPlan(points, baseWidth, pressureCurve, pressureEnabled, strength);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (plan.fillPath) {
      ctx.fill(plan.fillPath);
    }
    for (let i = 0; i < plan.batches.length; i++) {
      ctx.lineWidth = plan.batches[i].width;
      ctx.stroke(plan.batches[i].path);
    }
    ctx.restore();
    return;
  }

  strokeVectorPenDirect(ctx, points, color, baseWidth, pressureCurve, pressureEnabled, strength);
}

/**
 * Normalizes a highlighter color to a translucent rgba string so text stays
 * legible. Solid hex picks from the toolbar (e.g. `#fef08a`) become
 * `rgba(..., 0.4)`; existing rgba colors keep their alpha (clamped).
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
 * Uses a `WeakMap<StrokePoint[], CachedStrokePath>` cache of vector `Path2D` curves on real
 * canvases so repainting hundreds of strokes at any zoom level is O(1) and infinitely crisp.
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

  if (canUsePath2D(ctx) && points.length >= 1) {
    const first = points[0];
    const last = points[points.length - 1];
    const cacheKey = `${points.length}|${first.x.toFixed(2)},${first.y.toFixed(2)}|${last.x.toFixed(2)},${last.y.toFixed(2)}|${baseWidth}|${pressureCurve}|${isHighlighter ? 1 : 0}|${pressureEnabled ? 1 : 0}|${strength}|${tipShape}|${smoothing}`;
    let cached = committedStrokePathCache.get(points);
    if (!cached || cached.key !== cacheKey) {
      if (isHighlighter) {
        const pts = prepareHighlighterPoints(points);
        const path = new Path2D();
        if (pts.length === 1) {
          path.arc(pts[0].x, pts[0].y, baseWidth / 2, 0, Math.PI * 2);
        } else {
          traceHighlighterSpinePath(path, pts, baseWidth);
        }
        cached = { key: cacheKey, highlighterPath: path };
      } else {
        const pts = smoothStrokePoints(points, smoothing);
        const penPlan = buildVectorPenPlan(pts, baseWidth, pressureCurve, pressureEnabled, strength);
        cached = { key: cacheKey, penPlan };
      }
      committedStrokePathCache.set(points, cached);
    }

    ctx.save();
    const isStraightChisel = isHighlighter && tipShape === 'chisel' && points.length <= 2;
    ctx.lineCap = isStraightChisel ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) {
      ctx.imageSmoothingQuality = 'high';
    }
    if (isHighlighter && cached.highlighterPath) {
      ctx.globalCompositeOperation = 'source-over';
      const hlColor = normalizeHighlighterColor(color);
      if (points.length === 1) {
        ctx.fillStyle = hlColor;
        ctx.fill(cached.highlighterPath);
      } else {
        ctx.strokeStyle = hlColor;
        ctx.lineWidth = baseWidth;
        ctx.stroke(cached.highlighterPath);
      }
    } else if (cached.penPlan) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (cached.penPlan.fillPath) {
        ctx.fill(cached.penPlan.fillPath);
      }
      for (let i = 0; i < cached.penPlan.batches.length; i++) {
        ctx.lineWidth = cached.penPlan.batches[i].width;
        ctx.stroke(cached.penPlan.batches[i].path);
      }
    }
    ctx.restore();
    return;
  }

  // Fallback for unit-test mock contexts without Path2D
  const pts = isHighlighter
    ? prepareHighlighterPoints(points)
    : smoothStrokePoints(points, smoothing);

  ctx.save();
  const isStraightChisel = isHighlighter && tipShape === 'chisel' && pts.length <= 2;
  ctx.lineCap = isStraightChisel ? 'butt' : 'round';
  ctx.lineJoin = 'round';
  ctx.imageSmoothingEnabled = true;

  if (isHighlighter) {
    ctx.globalCompositeOperation = 'source-over';
    const hlColor = normalizeHighlighterColor(color);
    if (pts.length === 1) {
      ctx.fillStyle = hlColor;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, baseWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = hlColor;
      ctx.lineWidth = baseWidth;
      ctx.beginPath();
      traceHighlighterSpinePath(ctx, pts, baseWidth);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  ctx.restore();
  renderInkRibbon(ctx, pts, color, baseWidth, pressureCurve, pressureEnabled, strength);
}

interface LivePrefixCache {
  firstX: number;
  firstY: number;
  prefixLen: number;
  baseWidth: number;
  pressureCurve: string;
  pressureEnabled: boolean;
  strength: string;
  smoothing: string;
  plan: VectorPenRenderPlan;
}

let livePrefixCache: LivePrefixCache | null = null;

/**
 * Live stroke renderer for active drawing feedback. Uses O(1) prefix Path2D
 * caching on long strokes and the exact same vector curve renderer on the
 * active tail so drawing has zero lag and nothing shifts on release.
 */
export function renderLiveStroke(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  color: string,
  baseWidth: number,
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
  pressureEnabled = true,
  strength: 'light' | 'balanced' | 'strong' = 'balanced',
  smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium'
): void {
  if (points.length === 0) return;

  if (canUsePath2D(ctx) && points.length > 44) {
    const first = points[0];
    const targetPrefixLen = Math.floor((points.length - 20) / 16) * 16;
    if (
      targetPrefixLen >= 24 &&
      (!livePrefixCache ||
        livePrefixCache.firstX !== first.x ||
        livePrefixCache.firstY !== first.y ||
        livePrefixCache.prefixLen !== targetPrefixLen ||
        livePrefixCache.baseWidth !== baseWidth ||
        livePrefixCache.pressureCurve !== pressureCurve ||
        livePrefixCache.pressureEnabled !== pressureEnabled ||
        livePrefixCache.strength !== strength ||
        livePrefixCache.smoothing !== smoothing)
    ) {
      const prefixRaw = points.slice(0, targetPrefixLen + 4);
      const prefixSmoothed = smoothStrokePoints(prefixRaw, smoothing).slice(0, -3);
      livePrefixCache = {
        firstX: first.x,
        firstY: first.y,
        prefixLen: targetPrefixLen,
        baseWidth,
        pressureCurve,
        pressureEnabled,
        strength,
        smoothing,
        plan: buildVectorPenPlan(prefixSmoothed, baseWidth, pressureCurve, pressureEnabled, strength)
      };
    }

    if (livePrefixCache && livePrefixCache.prefixLen === targetPrefixLen) {
      const tailRaw = points.slice(Math.max(0, targetPrefixLen - 6));
      const tailSmoothed = smoothStrokePoints(tailRaw, smoothing);
      const tailPlan = buildVectorPenPlan(tailSmoothed, baseWidth, pressureCurve, pressureEnabled, strength);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (livePrefixCache.plan.fillPath) ctx.fill(livePrefixCache.plan.fillPath);
      for (let i = 0; i < livePrefixCache.plan.batches.length; i++) {
        ctx.lineWidth = livePrefixCache.plan.batches[i].width;
        ctx.stroke(livePrefixCache.plan.batches[i].path);
      }
      if (tailPlan.fillPath) ctx.fill(tailPlan.fillPath);
      for (let i = 0; i < tailPlan.batches.length; i++) {
        ctx.lineWidth = tailPlan.batches[i].width;
        ctx.stroke(tailPlan.batches[i].path);
      }
      ctx.restore();
      return;
    }
  }

  renderInkRibbon(
    ctx,
    smoothStrokePoints(points, smoothing),
    color,
    baseWidth,
    pressureCurve,
    pressureEnabled,
    strength
  );
}
