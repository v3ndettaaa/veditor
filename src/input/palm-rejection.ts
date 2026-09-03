/**
 * Palm Rejection Heuristics Engine
 * Eliminates accidental palm/wrist resting artifacts during stylus drawing.
 */

export class PalmRejectionEngine {
  private _lastPenActivityTime: number = 0;
  private _penActiveThresholdMs: number = 650; // Reject touches within 650ms of pen activity
  private _maxTouchContactSize: number = 22;   // Contact width/height threshold (px)

  public registerPointer(e: PointerEvent): boolean {
    const isPen = e.pointerType === 'pen';

    if (isPen) {
      this._lastPenActivityTime = Date.now();
      return false; // Not a palm, legitimate pen input
    }

    if (e.pointerType === 'touch') {
      const timeSincePen = Date.now() - this._lastPenActivityTime;

      // Rule 1: Reject touch if pen was recently used
      if (timeSincePen < this._penActiveThresholdMs) {
        return true; // Palm rejected!
      }

      // Rule 2: Large contact geometry rejection (palm/wrist contact)
      if ((e.width && e.width > this._maxTouchContactSize) || (e.height && e.height > this._maxTouchContactSize)) {
        return true; // Palm rejected!
      }
    }

    return false; // Allowed input
  }

  public reset() {
    this._lastPenActivityTime = 0;
  }
}

export const palmRejection = new PalmRejectionEngine();
