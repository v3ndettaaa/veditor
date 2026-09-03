import { describe, it, expect, beforeEach } from 'vitest';
import { eraserTool } from '../src/annotations/tools/eraser';
import { PenAnnotation } from '../src/core/types';

describe('EraserTool Modes & Pixel Slicing', () => {
  const createStroke = (id: string, xCoords: number[]): PenAnnotation => ({
    id,
    pageIndex: 0,
    layerId: 'default',
    type: 'pen',
    color: '#000000',
    strokeWidth: 2,
    opacity: 1,
    box: { x: Math.min(...xCoords), y: 0, width: Math.max(...xCoords) - Math.min(...xCoords), height: 10 },
    points: xCoords.map(x => ({ x, y: 5 })),
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  it('erases whole stroke in stroke mode', () => {
    eraserTool.start({ x: 50, y: 5 }, 10, 'stroke');
    const stroke = createStroke('stroke-1', [10, 20, 30, 40, 50, 60, 70, 80]);
    const res = eraserTool.testErase({ x: 50, y: 5 }, [stroke]);

    expect(res.toRemove.length).toBe(1);
    expect(res.toRemove[0].id).toBe('stroke-1');
    expect(res.toAdd.length).toBe(0);
  });

  it('erases entire object in object mode', () => {
    eraserTool.start({ x: 15, y: 5 }, 5, 'object');
    const stroke = createStroke('obj-1', [10, 20, 30, 40]);
    const res = eraserTool.testErase({ x: 15, y: 5 }, [stroke]);

    expect(res.toRemove.length).toBe(1);
    expect(res.toRemove[0].id).toBe('obj-1');
    expect(res.toAdd.length).toBe(0);
  });

  it('slices stroke into two sub-strokes in pixel mode when hitting the middle', () => {
    // Points along y=5 from x=0 to x=100 with step of 10
    const pointsX = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stroke = createStroke('pixel-test', pointsX);

    // Eraser touches x=50 with radius 8 (erases x=50, leaving [0,10,20,30,40] and [60,70,80,90,100])
    eraserTool.start({ x: 50, y: 5 }, 8, 'pixel');
    const res = eraserTool.testErase({ x: 50, y: 5 }, [stroke]);

    expect(res.toRemove.length).toBe(1);
    expect(res.toRemove[0].id).toBe('pixel-test');

    // Should have split into 2 distinct surviving strokes!
    expect(res.toAdd.length).toBe(2);

    const sub1 = res.toAdd[0] as PenAnnotation;
    const sub2 = res.toAdd[1] as PenAnnotation;

    expect(sub1.points.map(p => p.x)).toEqual([0, 10, 20, 30, 40]);
    expect(sub2.points.map(p => p.x)).toEqual([60, 70, 80, 90, 100]);
  });

  it('trims the end of a stroke in pixel mode when hitting the tip', () => {
    const pointsX = [10, 20, 30, 40, 50];
    const stroke = createStroke('trim-test', pointsX);

    // Erase x=50 (the tip)
    eraserTool.start({ x: 50, y: 5 }, 5, 'pixel');
    const res = eraserTool.testErase({ x: 50, y: 5 }, [stroke]);

    expect(res.toRemove.length).toBe(1);
    expect(res.toAdd.length).toBe(1);

    const surviving = res.toAdd[0] as PenAnnotation;
    expect(surviving.points.map(p => p.x)).toEqual([10, 20, 30, 40]);
  });
});
