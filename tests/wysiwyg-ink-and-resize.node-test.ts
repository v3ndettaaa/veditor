import test from 'node:test';
import assert from 'node:assert/strict';
import { PenTool } from '../src/annotations/tools/pen';
import {
  UnifiedPenPlanBuilder,
  buildUnifiedPenPathPlan,
  quantizePenSegmentWidth,
  computeStreamingQuadControl
} from '../src/annotations/ink-engine';
import { calculateStrokeWidth } from '../src/annotations/spline';
import { EraserTool } from '../src/annotations/tools/eraser';
import { getStickyNoteLayoutMetrics } from '../src/annotations/tools/sticky-note';
import type { Annotation, PenAnnotation, StrokePoint } from '../src/core/types';

// Minimal Path2D mock for Node environment so UnifiedPenPlanBuilder can be verified deterministically
class MockPath2D {
  public ops: string[] = [];
  moveTo(x: number, y: number) {
    this.ops.push(`M ${x.toFixed(3)} ${y.toFixed(3)}`);
  }
  lineTo(x: number, y: number) {
    this.ops.push(`L ${x.toFixed(3)} ${y.toFixed(3)}`);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    this.ops.push(`Q ${cpx.toFixed(3)} ${cpy.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)}`);
  }
  arc(x: number, y: number, r: number, s: number, e: number) {
    this.ops.push(`A ${x.toFixed(3)} ${y.toFixed(3)} ${r.toFixed(3)} ${s.toFixed(2)} ${e.toFixed(2)}`);
  }
}

function withMockPath2D<T>(fn: () => T): T {
  const prev = (globalThis as any).Path2D;
  (globalThis as any).Path2D = MockPath2D;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete (globalThis as any).Path2D;
    } else {
      (globalThis as any).Path2D = prev;
    }
  }
}

function makePenStroke(id: string, pts: StrokePoint[], strokeWidth = 3): PenAnnotation {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    id,
    pageIndex: 0,
    layerId: 'layer-default',
    type: 'pen',
    box: {
      x: minX - strokeWidth,
      y: minY - strokeWidth,
      width: (maxX - minX) + strokeWidth * 2,
      height: (maxY - minY) + strokeWidth * 2
    },
    points: pts,
    color: '#111827',
    strokeWidth,
    pressureEnabled: true,
    pressureCurve: 'linear',
    pressureStrength: 'balanced',
    strokeSmoothing: 'medium',
    preSmoothed: true,
    opacity: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

test('PenTool.move keeps already-rendered settled point pressure strictly immutable on micro-jitter', () => {
  const pen = new PenTool();
  pen.start({ x: 100, y: 100, pressure: 0.4, time: 0 }, 0, '#000', 3, 'linear', true, 'balanced', 'medium');
  pen.move({ x: 112, y: 105, pressure: 0.65, time: 16 }, 1);
  const settledBefore = pen.getActivePoints()[pen.getActivePoints().length - 1];
  const pressureBefore = settledBefore.pressure;
  const xBefore = settledBefore.x;
  const yBefore = settledBefore.y;

  // Sub-threshold jitter with wildly different pressure must NOT mutate the already-rendered point
  pen.move({ x: xBefore + 0.04, y: yBefore + 0.03, pressure: 0.98, time: 20 }, 1);
  pen.move({ x: xBefore + 0.02, y: yBefore - 0.02, pressure: 0.08, time: 24 }, 1);

  const settledAfter = pen.getActivePoints()[pen.getActivePoints().length - 1];
  assert.equal(settledAfter.pressure, pressureBefore);
  assert.equal(settledAfter.x, xBefore);
  assert.equal(settledAfter.y, yBefore);
});

test('UnifiedPenPlanBuilder produces bit-identical paths when streamed incrementally vs built in one shot', () => {
  withMockPath2D(() => {
    const pts: StrokePoint[] = [];
    for (let i = 0; i < 40; i++) {
      pts.push({
        x: 50 + i * 6.5,
        y: 120 + Math.sin(i * 0.35) * 18,
        pressure: 0.3 + 0.5 * (0.5 + 0.5 * Math.cos(i * 0.28)),
        time: i * 8
      });
    }

    for (const pressureEnabled of [true, false]) {
      const incremental = new UnifiedPenPlanBuilder();
      for (let k = 1; k <= pts.length; k++) {
        incremental.appendUpTo(
          pts.slice(0, k),
          3.2,
          'linear',
          pressureEnabled,
          'balanced',
          calculateStrokeWidth
        );
      }
      const incPlan = incremental.toPlan();
      const oneShotPlan = buildUnifiedPenPathPlan(
        pts,
        3.2,
        'linear',
        pressureEnabled,
        'balanced',
        calculateStrokeWidth
      );

      assert.deepEqual(
        (incPlan.fillPath as unknown as MockPath2D)?.ops,
        (oneShotPlan.fillPath as unknown as MockPath2D)?.ops
      );
      assert.equal(incPlan.batches.length, oneShotPlan.batches.length);
      for (let i = 0; i < oneShotPlan.batches.length; i++) {
        assert.equal(incPlan.batches[i].width, oneShotPlan.batches[i].width);
        assert.deepEqual(
          (incPlan.batches[i].path as unknown as MockPath2D).ops,
          (oneShotPlan.batches[i].path as unknown as MockPath2D).ops
        );
      }
    }

    // Verify helper exports remain pure and deterministic
    assert.equal(quantizePenSegmentWidth(2.4, 2.45, 3), quantizePenSegmentWidth(2.45, 2.4, 3));
    const q = computeStreamingQuadControl(pts, 5);
    assert.equal(typeof q.useQuad, 'boolean');
  });
});

test('EraserTool.testEraseBatch handles stroke/pixel modes, interpolates fast sweeps, and scales cleanly', () => {
  const eraser = new EraserTool();
  const verticalLine = makePenStroke('v1', [
    { x: 200, y: 50, pressure: 0.5 },
    { x: 200, y: 150, pressure: 0.5 },
    { x: 200, y: 250, pressure: 0.5 }
  ], 3);
  const untouched = makePenStroke('u1', [
    { x: 500, y: 50, pressure: 0.5 },
    { x: 500, y: 250, pressure: 0.5 }
  ], 3);

  // Fast sweep from x=150 to x=250 in one frame (jumps right across x=200)
  eraser.start({ x: 150, y: 150 }, 10, 'stroke');
  const strokeRes = eraser.testEraseBatch(
    [{ x: 150, y: 150 }, { x: 250, y: 150 }],
    [verticalLine, untouched]
  );
  assert.equal(strokeRes.toRemove.length, 1);
  assert.equal(strokeRes.toRemove[0].id, 'v1');
  assert.equal(strokeRes.toAdd.length, 0);

  // Pixel mode slices a horizontal stroke cleanly into two surviving pieces
  const horizPts: StrokePoint[] = [];
  for (let i = 0; i <= 20; i++) {
    horizPts.push({ x: 100 + i * 10, y: 100, pressure: 0.5 });
  }
  const horiz = makePenStroke('h1', horizPts, 3);
  eraser.start({ x: 200, y: 100 }, 15, 'pixel');
  const pixelRes = eraser.testEraseBatch([{ x: 195, y: 100 }, { x: 205, y: 100 }], [horiz, untouched]);
  assert.equal(pixelRes.toRemove.length, 1);
  assert.equal(pixelRes.toRemove[0].id, 'h1');
  assert.equal(pixelRes.toAdd.length, 2);

  // Performance budget: 500 strokes x 30 pts with batch of 8 eraser samples must stay fast (< 25ms)
  const many: Annotation[] = [];
  for (let s = 0; s < 500; s++) {
    const row = Math.floor(s / 25);
    const col = s % 25;
    const pts: StrokePoint[] = [];
    for (let k = 0; k < 30; k++) {
      pts.push({ x: col * 30 + k * 0.8, y: row * 30 + Math.sin(k) * 3, pressure: 0.5 });
    }
    many.push(makePenStroke(`s_${s}`, pts, 2.5));
  }
  eraser.start({ x: 100, y: 100 }, 12, 'stroke');
  const sweep = Array.from({ length: 8 }, (_, i) => ({ x: 100 + i * 5, y: 100 + i * 2 }));
  const t0 = performance.now();
  const perfRes = eraser.testEraseBatch(sweep, many);
  const elapsedMs = performance.now() - t0;
  assert.ok(perfRes.toRemove.length >= 1, 'should erase at least one intersected stroke');
  assert.ok(elapsedMs < 25, `expected vectorized batch erase < 25ms, got ${elapsedMs.toFixed(2)}ms`);
});

test('getStickyNoteLayoutMetrics preserves fixed header on standard notes and crisp proportional floor on flattened 379x72 notes', () => {
  const normal = getStickyNoteLayoutMetrics({ x: 100, y: 100, width: 210, height: 210 });
  const wide = getStickyNoteLayoutMetrics({ x: 100, y: 100, width: 379, height: 120 });
  const tall = getStickyNoteLayoutMetrics({ x: 100, y: 100, width: 140, height: 260 });

  assert.equal(normal.headerHeight, 32);
  assert.equal(normal.btnSize, 22);
  assert.equal(wide.headerHeight, 32);
  assert.equal(wide.btnSize, 22);
  assert.equal(tall.headerHeight, 32);
  assert.equal(tall.btnSize, 22);

  // Flattened wide note (matching user's 379x72 screenshot) keeps clean proportional header & readable square button
  const flat = getStickyNoteLayoutMetrics({ x: 100, y: 100, width: 379, height: 72 });
  assert.ok(flat.headerHeight >= 20 && flat.headerHeight <= 32, `headerHeight=${flat.headerHeight}`);
  assert.ok(flat.btnSize >= 15 && flat.btnSize <= 22, `btnSize=${flat.btnSize}`);
  assert.ok(flat.btnCenterY > 100 && flat.btnCenterY < 100 + flat.headerHeight);
  assert.ok(flat.btnCenterX > 100 + 379 - 40 && flat.btnCenterX < 100 + 379);
});
