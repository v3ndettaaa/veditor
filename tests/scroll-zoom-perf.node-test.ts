import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePlaceholderShellRange,
  stepZoomGestureTransform,
  computeZoomCommitTarget,
  ZoomGestureTransformState
} from '../src/core/viewport';

test('computePlaceholderShellRange mounts all pages for <=120-page documents', () => {
  assert.deepEqual(computePlaceholderShellRange(0, 0), { start: 0, end: -1 });
  assert.deepEqual(computePlaceholderShellRange(0, 1), { start: 0, end: 0 });
  assert.deepEqual(computePlaceholderShellRange(15, 64), { start: 0, end: 63 });
  assert.deepEqual(computePlaceholderShellRange(119, 120), { start: 0, end: 119 });
});

test('computePlaceholderShellRange uses a clamped sliding window for huge documents', () => {
  assert.deepEqual(computePlaceholderShellRange(0, 500, 40), { start: 0, end: 40 });
  assert.deepEqual(computePlaceholderShellRange(250, 500, 40), { start: 210, end: 290 });
  assert.deepEqual(computePlaceholderShellRange(495, 500, 40), { start: 455, end: 499 });
  assert.deepEqual(computePlaceholderShellRange(999, 500, 40), { start: 459, end: 499 });
  assert.deepEqual(computePlaceholderShellRange(-10, 500, 40), { start: 0, end: 40 });
});

test('stepZoomGestureTransform holds cursor content point stationary across multi-step zoom', () => {
  const scrollLeft = 180;
  const scrollTop = 2400;
  const focalX = 640;
  const focalY = 410;
  const initialContentX = scrollLeft + focalX;
  const initialContentY = scrollTop + focalY;

  let state: ZoomGestureTransformState = { baseZoom: 1.25, scale: 1, panX: 0, panY: 0 };
  const factors = [1.12, 1.15, 1.08, 1.2, 0.92, 0.88, 1.05];
  for (const f of factors) {
    state = stepZoomGestureTransform(state, f, focalX, focalY, scrollLeft, scrollTop, 0.25, 8);
    // Where does the initial content point map on screen (relative to viewport)?
    const mappedViewportX = initialContentX * state.scale + state.panX - scrollLeft;
    const mappedViewportY = initialContentY * state.scale + state.panY - scrollTop;
    assert.ok(Math.abs(mappedViewportX - focalX) < 1e-6, `X drifted: ${mappedViewportX} vs ${focalX}`);
    assert.ok(Math.abs(mappedViewportY - focalY) < 1e-6, `Y drifted: ${mappedViewportY} vs ${focalY}`);
  }

  const commit = computeZoomCommitTarget(state, focalX, focalY, scrollLeft, scrollTop);
  assert.ok(Math.abs(commit.baseContentX - initialContentX) < 1e-6);
  assert.ok(Math.abs(commit.baseContentY - initialContentY) < 1e-6);
});

test('stepZoomGestureTransform tracks moving cursor + simultaneous pan and inverts cleanly at commit', () => {
  const scrollLeft = 0;
  const scrollTop = 1200;
  let state: ZoomGestureTransformState = { baseZoom: 1.0, scale: 1, panX: 0, panY: 0 };

  // Step 1: zoom in at (300, 200)
  state = stepZoomGestureTransform(state, 1.5, 300, 200, scrollLeft, scrollTop, 0.25, 8);
  // Step 2: two-finger pan by (+45, -30)
  state = { ...state, panX: state.panX + 45, panY: state.panY - 30 };
  // Step 3: cursor moves to (500, 350); find content point currently under (500, 350)
  const before = computeZoomCommitTarget(state, 500, 350, scrollLeft, scrollTop);
  // Step 4: zoom in further at (500, 350)
  state = stepZoomGestureTransform(state, 1.4, 500, 350, scrollLeft, scrollTop, 0.25, 8);
  const after = computeZoomCommitTarget(state, 500, 350, scrollLeft, scrollTop);

  assert.ok(Math.abs(after.baseContentX - before.baseContentX) < 1e-6);
  assert.ok(Math.abs(after.baseContentY - before.baseContentY) < 1e-6);
  assert.ok(Math.abs(after.finalZoom - 2.1) < 1e-6);
});

test('stepZoomGestureTransform respects MIN_ZOOM and MAX_ZOOM clamps without drifting pan', () => {
  const scrollLeft = 50;
  const scrollTop = 400;
  let state: ZoomGestureTransformState = { baseZoom: 4.0, scale: 1, panX: 0, panY: 0 };
  state = stepZoomGestureTransform(state, 3.0, 400, 300, scrollLeft, scrollTop, 0.25, 8);
  assert.equal(state.baseZoom * state.scale, 8);
  const panAfterHit = { panX: state.panX, panY: state.panY };
  // Additional zoom past MAX_ZOOM must be a no-op
  state = stepZoomGestureTransform(state, 2.0, 400, 300, scrollLeft, scrollTop, 0.25, 8);
  assert.equal(state.scale, 2);
  assert.equal(state.panX, panAfterHit.panX);
  assert.equal(state.panY, panAfterHit.panY);
});
