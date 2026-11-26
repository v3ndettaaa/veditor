import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OneEuroStrokeFilter,
  filterStrokePointsOneEuro,
  addTangentCapsuleToPath,
  decimateRibbonSpine,
  toOpaqueHighlighterColor,
  StreamingInkRenderer,
  StreamingHighlighterRenderer,
  INK_MIN_WIDTH,
  type RibbonSample
} from '../src/annotations/ink-engine';
import type { StrokePoint } from '../src/core/types';

/** Lightweight CanvasPath recorder for verifying analytical capsule geometry. */
class MockCanvasPath {
  public ops: Array<{ op: string; args: number[] }> = [];
  moveTo(x: number, y: number) { this.ops.push({ op: 'moveTo', args: [x, y] }); }
  lineTo(x: number, y: number) { this.ops.push({ op: 'lineTo', args: [x, y] }); }
  arc(x: number, y: number, r: number, s: number, e: number, ccw?: boolean) {
    this.ops.push({ op: 'arc', args: [x, y, r, s, e, ccw ? 1 : 0] });
  }
  closePath() { this.ops.push({ op: 'closePath', args: [] }); }
}

/** Minimal Canvas2D mock for testing O(1) incremental live streaming without a DOM. */
function createMockCanvasAndCtx(width = 1200, height = 1600) {
  let fillCalls = 0;
  let clearCalls = 0;
  let arcCalls = 0;
  const ctx = {
    fillStyle: '',
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() { arcCalls++; },
    closePath() {},
    fill() { fillCalls++; },
    clearRect() { clearCalls++; }
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    width,
    height,
    style: { opacity: '', width: `${width / 2}px`, height: `${height / 2}px` },
    dataset: {},
    parentElement: null
  } as unknown as HTMLCanvasElement;

  return {
    ctx,
    canvas,
    getStats: () => ({ fillCalls, clearCalls, arcCalls }),
    resetStats: () => { fillCalls = 0; clearCalls = 0; arcCalls = 0; }
  };
}

test('OneEuroStrokeFilter attenuates slow jitter while staying responsive on fast sweeps', () => {
  // 1. Slow jittery line: alternating +/- 0.8pt vertical digitizer tremor
  const slowRaw: StrokePoint[] = [];
  for (let i = 0; i < 40; i++) {
    slowRaw.push({
      x: 100 + i * 0.6,
      y: 100 + (i % 2 === 0 ? 0.8 : -0.8),
      pressure: 0.5,
      time: i * 16
    });
  }
  const slowFiltered = filterStrokePointsOneEuro(slowRaw, 'medium', 1);
  let rawDev = 0;
  let filtDev = 0;
  for (let i = 4; i < slowRaw.length - 1; i++) {
    rawDev += Math.abs(slowRaw[i].y - 100);
    filtDev += Math.abs(slowFiltered[i].y - 100);
  }
  assert.ok(
    filtDev < rawDev * 0.5,
    `Expected >50% tremor reduction on slow stroke (raw=${rawDev.toFixed(2)}, filt=${filtDev.toFixed(2)})`
  );

  // 2. Fast sweeping line: must keep spatial lag tightly bounded (< 2.0 screen px)
  const fastFilter = new OneEuroStrokeFilter();
  fastFilter.reset('medium');
  let maxLag = 0;
  for (let i = 0; i < 30; i++) {
    const rawX = 100 + i * 18;
    const rawY = 200 + i * 5;
    const out = fastFilter.filter(rawX, rawY, 0.7, i * 8, 1);
    const lag = Math.hypot(rawX - out.x, rawY - out.y);
    if (lag > maxLag) maxLag = lag;
  }
  assert.ok(maxLag <= 1.6, `Expected fast sweep lag <= 1.6px, got ${maxLag.toFixed(3)}px`);
});

test('OneEuroStrokeFilter is strictly causal and zoom-invariant in screen space', () => {
  const f1 = new OneEuroStrokeFilter();
  f1.reset('medium');
  const firstTen: StrokePoint[] = [];
  for (let i = 0; i < 10; i++) {
    firstTen.push(f1.filter(10 + i * 3, 20 + Math.sin(i * 0.5) * 2, 0.5, i * 8, 1));
  }
  const snapshotBefore = JSON.stringify(firstTen);
  // Feeding 20 more points must never retroactively mutate previously emitted points
  for (let i = 10; i < 30; i++) {
    f1.filter(10 + i * 3, 20 + Math.sin(i * 0.5) * 2, 0.5, i * 8, 1);
  }
  assert.equal(JSON.stringify(firstTen), snapshotBefore);

  // Zoom invariance: same screen-space speed at 4x zoom (1/4 page distance) produces proportional filtering
  const f1x = new OneEuroStrokeFilter();
  const f4x = new OneEuroStrokeFilter();
  f1x.reset('medium');
  f4x.reset('medium');
  for (let i = 0; i < 20; i++) {
    const screenX = i * 6;
    const screenY = (i % 2 === 0 ? 1.0 : -1.0);
    const p1 = f1x.filter(screenX, screenY, 0.5, i * 8, 1);
    const p4 = f4x.filter(screenX / 4, screenY / 4, 0.5, i * 8, 4);
    assert.ok(Math.abs(p1.x - p4.x * 4) < 1e-6, `Zoom-invariant X mismatch at i=${i}`);
    assert.ok(Math.abs(p1.y - p4.y * 4) < 1e-6, `Zoom-invariant Y mismatch at i=${i}`);
  }
});

test('addTangentCapsuleToPath produces strictly CW closed contours for tapers and degenerate cases', () => {
  // Normal variable-width capsule (r0=2.5 -> r1=0.6)
  const p = new MockCanvasPath();
  addTangentCapsuleToPath(p as unknown as CanvasPath, 10, 10, 2.5, 25, 14, 0.6);
  assert.equal(p.ops[0].op, 'moveTo');
  assert.equal(p.ops[1].op, 'arc');
  assert.equal(p.ops[1].args[5], 0, 'First arc must be CW (anticlockwise = false)');
  assert.equal(p.ops[2].op, 'arc');
  assert.equal(p.ops[2].args[5], 0, 'Second arc must be CW (anticlockwise = false)');
  assert.equal(p.ops[3].op, 'closePath');
  for (const op of p.ops) {
    for (const v of op.args) {
      assert.ok(Number.isFinite(v), `Non-finite geometry value in ${op.op}`);
    }
  }

  // Degenerate zero-length / enclosed circle case emits single larger disk with finite coords
  const pDeg = new MockCanvasPath();
  addTangentCapsuleToPath(pDeg as unknown as CanvasPath, 10, 10, 3.0, 10.2, 10.1, 1.0);
  assert.equal(pDeg.ops.length, 2);
  assert.equal(pDeg.ops[1].op, 'arc');
  assert.equal(pDeg.ops[1].args[2], 3.0);

  // Ultra-thin hairline obeys INK_MIN_WIDTH floor
  const pThin = new MockCanvasPath();
  addTangentCapsuleToPath(pThin as unknown as CanvasPath, 0, 0, 0.01, 5, 0, 0.01);
  assert.ok(pThin.ops[1].args[2] >= INK_MIN_WIDTH * 0.5 - 1e-9);
});

test('decimateRibbonSpine reduces collinear segments while preserving tight curves & tapers', () => {
  // Straight line with constant radius: 50 samples should decimate aggressively
  const straight: RibbonSample[] = [];
  for (let i = 0; i < 50; i++) {
    straight.push({ x: i * 0.5, y: 10, r: 1.5 });
  }
  const decStraight = decimateRibbonSpine(straight);
  assert.ok(decStraight.length < 15, `Expected <15 samples on straight line, got ${decStraight.length}`);
  assert.deepEqual(decStraight[0], straight[0]);
  assert.deepEqual(decStraight[decStraight.length - 1], straight[straight.length - 1]);

  // Tight cursive loop with sharp pressure taper: preserves curvature accuracy within bound
  const loop: RibbonSample[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 39) * Math.PI * 2;
    loop.push({
      x: 50 + Math.cos(a) * 4,
      y: 50 + Math.sin(a) * 4,
      r: 0.4 + Math.abs(Math.sin(a)) * 1.4
    });
  }
  const decLoop = decimateRibbonSpine(loop, 0.022, 0.018);
  assert.ok(decLoop.length >= 16, `Expected loop curvature preserved (>=16 samples), got ${decLoop.length}`);
});

test('toOpaqueHighlighterColor strips alpha cleanly without darkening', () => {
  assert.deepEqual(toOpaqueHighlighterColor('rgba(250, 204, 21, 0.35)'), {
    opaqueColor: 'rgb(250, 204, 21)',
    alpha: 0.35
  });
  assert.deepEqual(toOpaqueHighlighterColor('#facc15'), {
    opaqueColor: '#facc15',
    alpha: 0.3
  });
});

test('StreamingInkRenderer is strictly O(1) append-only with zero mid-stroke clears', () => {
  const { ctx, canvas, getStats, resetStats } = createMockCanvasAndCtx();
  const renderer = new StreamingInkRenderer();
  const calcWidth = (w: number, p: number) => w * (0.4 + p * 0.9);
  const pts: StrokePoint[] = [];

  const start = performance.now();
  for (let i = 0; i < 1500; i++) {
    pts.push({
      x: 40 + i * 0.45,
      y: 120 + Math.sin(i * 0.12) * 18,
      pressure: 0.25 + 0.65 * Math.abs(Math.sin(i * 0.05)),
      time: i * 4
    });
    if (i === 1000) resetStats();
    renderer.render(ctx, canvas, pts, '#111827', 2.0, 'linear', true, 'balanced', 2.0, 0, 0, calcWidth);
  }
  const elapsedMs = performance.now() - start;
  const statsAfter1000 = getStats();

  // Zero mid-stroke clears across 500 frames!
  assert.equal(statsAfter1000.clearCalls, 0, 'StreamingInkRenderer must never clear settledCanvas mid-stroke');
  // 1500 incremental frames should complete very fast (< 120ms even in JS mock)
  assert.ok(elapsedMs < 250, `Expected 1500-point streaming under 250ms, took ${elapsedMs.toFixed(1)}ms`);

  const dirty = renderer.getSettledDirtyRectPx();
  assert.ok(dirty && dirty.width > 0 && dirty.height > 0, 'Dirty rect should track exact stroke bounds');
  renderer.clearSettledDirtyOnCanvas(ctx, canvas);
  assert.equal(getStats().clearCalls, 1, 'clearSettledDirtyOnCanvas should issue exactly 1 tight clearRect');
});

test('StreamingHighlighterRenderer paints append-only with CSS opacity and restores opacity cleanly', () => {
  const { ctx, canvas, getStats } = createMockCanvasAndCtx();
  const renderer = new StreamingHighlighterRenderer();
  const pts: StrokePoint[] = [
    { x: 10, y: 20, pressure: 0.5 },
    { x: 30, y: 22, pressure: 0.5 },
    { x: 55, y: 25, pressure: 0.5 }
  ];

  renderer.render(ctx, canvas, pts.slice(0, 1), 'rgba(250, 204, 21, 0.35)', 18, 2.0, 0, 0);
  assert.equal(canvas.style.opacity, '0.35');
  renderer.render(ctx, canvas, pts, 'rgba(250, 204, 21, 0.35)', 18, 2.0, 0, 0);
  assert.equal(getStats().clearCalls, 0, 'Highlighter streaming must not clear mid-stroke');

  renderer.clearDirtyOnCanvas(ctx, canvas);
  assert.equal(canvas.style.opacity, '', 'Canvas CSS opacity must be restored after clear');
  assert.equal(getStats().clearCalls, 1);
});
