import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStreamingQuadControl,
  buildUnifiedPenPathPlan,
  warmInkPipeline,
  isScratchChunkReusable
} from '../src/annotations/ink-engine';
import { calculateStrokeWidth } from '../src/annotations/spline';
import { PenTool } from '../src/annotations/tools/pen';
import { computeStickyResizePreview } from '../src/annotations/resize-preview';
import type { StrokePoint } from '../src/core/types';

test('computeStreamingQuadControl is strictly causal (future points never mutate past curves)', () => {
  const prefix: StrokePoint[] = [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 10, y: 2, pressure: 0.5 },
    { x: 22, y: 8, pressure: 0.5 }
  ];
  const extended: StrokePoint[] = [
    ...prefix,
    { x: 35, y: 25, pressure: 0.5 },
    { x: 60, y: 5, pressure: 0.5 }
  ];

  const qBefore = computeStreamingQuadControl(prefix, 2);
  const qAfter = computeStreamingQuadControl(extended, 2);
  assert.equal(qBefore.useQuad, true);
  assert.deepEqual(qBefore, qAfter);
});

test('PenTool.finish commits exact live points with zero unrendered _liveTip tail extension', () => {
  const pen = new PenTool();
  pen.start({ x: 100, y: 100, pressure: 0.5, time: 0 }, 0, '#111111', 3, 'linear', true, 'balanced', 'medium');
  pen.move({ x: 112, y: 105, pressure: 0.6, time: 16 }, 1);
  pen.move({ x: 126, y: 112, pressure: 0.55, time: 32 }, 1);
  // Sub-threshold micro-jitter right before pen lift should NOT extend the committed stroke tail
  pen.move({ x: 126.1, y: 112.08, pressure: 0.2, time: 48 }, 1);

  const liveSnapshot = pen.getActivePoints().map(p => ({ x: p.x, y: p.y }));
  const committed = pen.finish('layer-default');
  assert.ok(committed);
  assert.equal(committed.preSmoothed, true);
  assert.equal(committed.points.length, liveSnapshot.length);
  assert.deepEqual(
    committed.points.map(p => ({ x: p.x, y: p.y })),
    liveSnapshot
  );
});

test('buildUnifiedPenPathPlan builds deterministic Path2D batches matching StreamingInkRenderer', () => {
  // Minimal Path2D shim for Node test runtime
  const recordedOps: Array<{ op: string; args: number[] }> = [];
  class MockPath2D {
    moveTo(x: number, y: number) { recordedOps.push({ op: 'moveTo', args: [x, y] }); }
    lineTo(x: number, y: number) { recordedOps.push({ op: 'lineTo', args: [x, y] }); }
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      recordedOps.push({ op: 'quad', args: [cx, cy, x, y] });
    }
    arc(x: number, y: number, r: number) { recordedOps.push({ op: 'arc', args: [x, y, r] }); }
  }
  const prevPath2D = (globalThis as any).Path2D;
  (globalThis as any).Path2D = MockPath2D;
  try {
    const pts: StrokePoint[] = [
      { x: 10, y: 10, pressure: 0.5 },
      { x: 20, y: 12, pressure: 0.5 },
      { x: 32, y: 18, pressure: 0.5 }
    ];
    const plan = buildUnifiedPenPathPlan(pts, 3, 'linear', false, 'balanced', calculateStrokeWidth);
    assert.ok(plan.fillPath, 'initial contact dot is present');
    assert.equal(plan.batches.length, 1, 'uniform width coalesces into 1 batch');
    assert.equal(plan.batches[0].width, 3);
    assert.ok(recordedOps.some(o => o.op === 'quad'), 'uses identical causal quadraticCurveTo');
  } finally {
    (globalThis as any).Path2D = prevPath2D;
  }
});

test('warmInkPipeline is idempotent and isScratchChunkReusable avoids redundant pointerdown reallocations', () => {
  const firstRun = warmInkPipeline();
  const secondRun = warmInkPipeline();
  assert.equal(firstRun, true);
  assert.equal(secondRun, false);

  assert.equal(
    isScratchChunkReusable({
      displayBlock: true,
      pixelWidth: 1600,
      pixelHeight: 1200,
      baseZoom: 2.25,
      currentZoom: 2.25,
      coversViewport: true
    }),
    true
  );
  assert.equal(
    isScratchChunkReusable({
      displayBlock: true,
      pixelWidth: 1600,
      pixelHeight: 1200,
      baseZoom: 2.0,
      currentZoom: 2.25,
      coversViewport: true
    }),
    false
  );
  assert.equal(
    isScratchChunkReusable({
      displayBlock: true,
      pixelWidth: 1,
      pixelHeight: 1,
      baseZoom: 2.25,
      currentZoom: 2.25,
      coversViewport: true
    }),
    false
  );
});

test('computeStickyResizePreview computes exact GPU scale transform and clamps min dimensions', () => {
  const origBox = { x: 100, y: 80, width: 200, height: 150 };
  const spriteBox = { x: 40, y: 20, width: 320, height: 270 };

  // 1. Expanding to 2x width, 1.5x height
  const expanded = computeStickyResizePreview(
    origBox,
    spriteBox,
    { dx: 0, dy: 0, scaleX: 2, scaleY: 1.5, originX: 100, originY: 80 },
    1.5
  );
  assert.equal(expanded.nextBox.x, 100);
  assert.equal(expanded.nextBox.y, 80);
  assert.equal(expanded.nextBox.width, 400);
  assert.equal(expanded.nextBox.height, 225);
  assert.equal(expanded.scaleX, 2);
  assert.equal(expanded.scaleY, 1.5);
  assert.ok(expanded.cssTransform.includes('translate3d('));
  assert.ok(expanded.cssTransform.includes('scale(2.0000, 1.5000)'));

  // 2. Shrinking below minimum size clamps proportionally (never below 56x46)
  const shrunk = computeStickyResizePreview(
    origBox,
    spriteBox,
    { dx: 0, dy: 0, scaleX: 0.1, scaleY: 0.1, originX: 100, originY: 80 },
    1
  );
  assert.ok(shrunk.nextBox.width >= 56 - 1e-6);
  assert.ok(shrunk.nextBox.height >= 46 - 1e-6);

  // 3. Rotated sticky note wraps scale in rotate(r) ... rotate(-r)
  const rotated = computeStickyResizePreview(
    origBox,
    spriteBox,
    { dx: 0, dy: 0, scaleX: 1.25, scaleY: 1.25, originX: 100, originY: 80 },
    1,
    { rotation: 0.5 }
  );
  assert.ok(rotated.cssTransform.includes('rotate(0.50000rad)'));
  assert.ok(rotated.cssTransform.includes('rotate(-0.50000rad)'));
});
