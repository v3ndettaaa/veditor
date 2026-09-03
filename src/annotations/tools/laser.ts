/**
 * Presentation Laser Pointer Tool
 * Renders glowing trail that decays smoothly over 1.2 seconds.
 */

import { Point } from '../../core/types';

interface LaserPoint extends Point {
  time: number;
}

export class LaserPointerTool {
  private _trail: LaserPoint[] = [];
  private _active: boolean = false;
  private _animFrameId: number | null = null;
  private _onUpdate: (() => void) | null = null;

  public start(point: Point, onUpdate: () => void) {
    this._active = true;
    this._onUpdate = onUpdate;
    this._trail = [{ ...point, time: Date.now() }];
    this.startAnimationLoop();
  }

  public move(point: Point) {
    if (!this._active) return;
    this._trail.push({ ...point, time: Date.now() });
  }

  public stop() {
    this._active = false;
  }

  private startAnimationLoop() {
    const loop = () => {
      const now = Date.now();
      const maxAge = 1000; // 1s decay

      this._trail = this._trail.filter(p => now - p.time < maxAge);
      this._onUpdate?.();

      if (this._trail.length > 0 || this._active) {
        this._animFrameId = requestAnimationFrame(loop);
      } else {
        this._animFrameId = null;
      }
    };

    if (!this._animFrameId) {
      this._animFrameId = requestAnimationFrame(loop);
    }
  }

  public render(ctx: CanvasRenderingContext2D, scale: number) {
    if (this._trail.length === 0) return;

    ctx.save();
    ctx.scale(scale, scale);

    const now = Date.now();
    const maxAge = 1000;

    for (let i = 0; i < this._trail.length; i++) {
      const p = this._trail[i];
      const age = now - p.time;
      const opacity = Math.max(0, 1 - age / maxAge);
      const radius = 6 * opacity;

      // Glow outer circle
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(239, 68, 68, ${opacity * 0.3})`;
      ctx.fill();

      // Bright center core
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, radius), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${opacity * 0.9})`;
      ctx.fill();
    }

    ctx.restore();
  }
}

export const laserTool = new LaserPointerTool();
