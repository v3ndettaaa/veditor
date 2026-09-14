/**
 * Tiny RAF tween helper for short UI morphs (e.g. raw stroke -> fitted shape).
 * Cancellable and dependency-free; falls back to an immediate commit when
 * `requestAnimationFrame` is unavailable.
 */

export interface TweenHandle {
  cancel(): void;
}

export type EasingFn = (t: number) => number;

/** Standard ease-out cubic. */
export const easeOutCubic: EasingFn = (t) => 1 - Math.pow(1 - t, 3);

export interface TweenOptions {
  durationMs: number;
  easing?: EasingFn;
  onUpdate: (t: number) => void;
  onComplete?: () => void;
}

export function tween({ durationMs, easing = easeOutCubic, onUpdate, onComplete }: TweenOptions): TweenHandle {
  const hasRaf = typeof requestAnimationFrame === 'function';
  if (!hasRaf || durationMs <= 0) {
    onUpdate(1);
    onComplete?.();
    return { cancel() {} };
  }

  let rafId: number | null = null;
  let cancelled = false;
  const start = performance.now();

  const step = (now: number) => {
    if (cancelled) return;
    const raw = Math.min(1, (now - start) / durationMs);
    onUpdate(easing(raw));
    if (raw < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      rafId = null;
      onComplete?.();
    }
  };

  rafId = requestAnimationFrame(step);

  return {
    cancel() {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}
