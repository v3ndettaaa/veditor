import { describe, it, expect } from 'vitest';
import { rotatedPageSize } from '../src/core/viewport';

const A4 = { originalWidth: 595, originalHeight: 842 };

describe('Rotation-aware page sizing', () => {
  it('keeps dimensions without user rotation', () => {
    expect(rotatedPageSize(A4, 0)).toEqual({ width: 595, height: 842 });
  });

  it('swaps dimensions at 90 and 270 degrees', () => {
    expect(rotatedPageSize(A4, 90)).toEqual({ width: 842, height: 595 });
    expect(rotatedPageSize(A4, 270)).toEqual({ width: 842, height: 595 });
    expect(rotatedPageSize(A4, -90)).toEqual({ width: 842, height: 595 });
  });

  it('keeps dimensions at 180 degrees', () => {
    expect(rotatedPageSize(A4, 180)).toEqual({ width: 595, height: 842 });
  });
});
