/**
 * Touch Gesture Engine
 * Multi-touch two-finger pinch-to-zoom and two-finger pan.
 */

import { Point } from '../core/types';
import { distance } from '../utils/geometry';

export interface GestureCallbacks {
  onPinchZoom: (scaleDelta: number, center: Point) => void;
  onPan: (dx: number, dy: number) => void;
}

export class GestureEngine {
  private _activeTouches: Map<number, Point> = new Map();
  private _initialDistance: number = 0;
  private _lastMidpoint: Point | null = null;
  private _isGestureActive: boolean = false;

  public handlePointerDown(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false;

    this._activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._activeTouches.size === 2) {
      this._isGestureActive = true;
      const pts = Array.from(this._activeTouches.values());
      this._initialDistance = distance(pts[0], pts[1]);
      this._lastMidpoint = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
      return true; // Gesture started, consume event
    }

    return false;
  }

  public handlePointerMove(e: PointerEvent, callbacks: GestureCallbacks): boolean {
    if (!this._activeTouches.has(e.pointerId)) return false;

    this._activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._isGestureActive && this._activeTouches.size === 2) {
      const pts = Array.from(this._activeTouches.values());
      const currentDist = distance(pts[0], pts[1]);
      const currentMid: Point = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };

      if (this._initialDistance > 0 && Math.abs(currentDist - this._initialDistance) > 4) {
        const scaleFactor = currentDist / this._initialDistance;
        callbacks.onPinchZoom(scaleFactor, currentMid);
        this._initialDistance = currentDist;
      }

      if (this._lastMidpoint) {
        const dx = currentMid.x - this._lastMidpoint.x;
        const dy = currentMid.y - this._lastMidpoint.y;
        if (Math.hypot(dx, dy) > 2) {
          callbacks.onPan(dx, dy);
        }
      }

      this._lastMidpoint = currentMid;
      return true; // Gesture consumed
    }

    return false;
  }

  public handlePointerUp(e: PointerEvent): boolean {
    const had = this._activeTouches.delete(e.pointerId);
    const wasActive = this._isGestureActive;
    if (this._activeTouches.size < 2) {
      this._isGestureActive = false;
      this._initialDistance = 0;
      this._lastMidpoint = null;
    }
    return had && wasActive;
  }

  get isGestureActive(): boolean {
    return this._isGestureActive;
  }
}

export const gestureEngine = new GestureEngine();
