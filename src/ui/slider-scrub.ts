/**
 * Unified Pointer-Scrub Slider Enhancement
 * Gives every <input type="range"> a forgiving 28px hit zone, pointer capture,
 * smooth continuous horizontal tracking even during vertical cursor drift, and a
 * global drag lock so parent popovers/inspectors never hide or rebuild mid-drag.
 */

export interface SliderScrubComputation {
  value: number;
  pct: number;
}

/** Counts decimal places of a numeric step so snapped values avoid float drift. */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const expIdx = s.indexOf('e-');
  if (expIdx >= 0) return Math.max(0, parseInt(s.slice(expIdx + 2), 10) || 0);
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}

/**
 * Pure value/percentage calculation for pointer scrubbing along a range slider.
 * Supports arbitrary min/max/step and RTL horizontal inversion.
 */
export function computeScrubSliderValue(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  min: number,
  max: number,
  step: number = 1,
  isRtl: boolean = false
): SliderScrubComputation {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 1;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const safeW = Math.max(1, rectWidth);

  let ratio = (clientX - rectLeft) / safeW;
  if (!Number.isFinite(ratio)) ratio = 0;
  ratio = Math.max(0, Math.min(1, ratio));
  if (isRtl) ratio = 1 - ratio;

  const raw = safeMin + ratio * (safeMax - safeMin);
  const snappedSteps = Math.round((raw - safeMin) / safeStep);
  const dec = stepDecimals(safeStep);
  const stepped = safeMin + snappedSteps * safeStep;
  const clamped = Math.max(safeMin, Math.min(safeMax, stepped));
  const value = dec > 0 ? Number(clamped.toFixed(dec)) : Math.round(clamped);
  const pct = Math.max(0, Math.min(100, ((value - safeMin) / (safeMax - safeMin)) * 100));

  return { value, pct };
}

let activeSliderDragCount = 0;

/** Returns true while the user is actively dragging any enhanced range slider. */
export function isSliderDragging(): boolean {
  return activeSliderDragCount > 0 || (typeof document !== 'undefined' && document.body?.dataset?.sliderDragging === '1');
}

export interface EnhanceSliderOptions {
  onDragStart?: (slider: HTMLInputElement) => void;
  onDragEnd?: (slider: HTMLInputElement) => void;
}

/**
 * Upgrades all `<input type="range">` controls inside `root` with smooth pointer capture
 * scrubbing. Safe to call repeatedly — skips elements already bound.
 */
export function enhanceRangeSliders(root: ParentNode, opts?: EnhanceSliderOptions): void {
  const sliders = root.querySelectorAll<HTMLInputElement>('input[type="range"]');
  sliders.forEach((slider) => {
    if (slider.dataset.scrubBound === '1') return;
    slider.dataset.scrubBound = '1';

    const min = parseFloat(slider.min || '0');
    const max = parseFloat(slider.max || '100');
    const step = parseFloat(slider.step || '1');
    const initVal = parseFloat(slider.value || String(min));
    if (Number.isFinite(initVal) && max > min) {
      const initPct = Math.max(0, Math.min(100, ((initVal - min) / (max - min)) * 100));
      if (!slider.style.getPropertyValue('--slider-pct')) {
        slider.style.setProperty('--slider-pct', `${initPct}%`);
      }
    }

    const syncFromClientX = (clientX: number) => {
      const rect = slider.getBoundingClientRect();
      if (rect.width <= 1) return;
      const isRtl = getComputedStyle(slider).direction === 'rtl' || document.documentElement.dir === 'rtl';
      const sMin = parseFloat(slider.min || '0');
      const sMax = parseFloat(slider.max || '100');
      const sStep = parseFloat(slider.step || '1');
      const { value, pct } = computeScrubSliderValue(clientX, rect.left, rect.width, sMin, sMax, sStep, isRtl);
      const nextStr = String(value);
      slider.style.setProperty('--slider-pct', `${pct}%`);
      if (slider.value !== nextStr) {
        slider.value = nextStr;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    slider.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // Prevent native range tracking quirks and stop parent container handlers from stealing the drag
      e.preventDefault();
      e.stopPropagation();

      try {
        slider.focus({ preventScroll: true });
      } catch (_) {}

      const wrapper = slider.closest<HTMLElement>('.tool-btn-wrapper');
      wrapper?.classList.add('is-slider-dragging');
      slider.dataset.dragging = '1';
      activeSliderDragCount++;
      document.body.dataset.sliderDragging = '1';
      opts?.onDragStart?.(slider);

      try {
        slider.setPointerCapture(e.pointerId);
      } catch (_) {}

      syncFromClientX(e.clientX);

      let finished = false;
      const cleanup = (ev: PointerEvent, emitChange: boolean) => {
        if (finished) return;
        finished = true;
        slider.removeEventListener('pointermove', onMove);
        slider.removeEventListener('pointerup', onUp);
        slider.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        try {
          if (slider.hasPointerCapture?.(e.pointerId)) {
            slider.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}

        delete slider.dataset.dragging;
        wrapper?.classList.remove('is-slider-dragging');
        activeSliderDragCount = Math.max(0, activeSliderDragCount - 1);
        if (activeSliderDragCount === 0) {
          delete document.body.dataset.sliderDragging;
        }
        if (emitChange && ev.type === 'pointerup') {
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
        opts?.onDragEnd?.(slider);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId && e.pointerType !== 'mouse') return;
        syncFromClientX(ev.clientX);
      };
      const onUp = (ev: PointerEvent) => cleanup(ev, true);
      const onCancel = (ev: PointerEvent) => cleanup(ev, false);

      slider.addEventListener('pointermove', onMove);
      slider.addEventListener('pointerup', onUp);
      slider.addEventListener('pointercancel', onCancel);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  });
}
