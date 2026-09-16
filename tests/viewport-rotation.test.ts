import { describe, it, expect, vi } from 'vitest';
import { rotatedPageSize, ViewportManager } from '../src/core/viewport';
import { store } from '../src/core/store';

const A4 = { originalWidth: 595, originalHeight: 842 };

it('clears PDF geometry on home and preserves vertical home scrolling during resize', () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const scroll = { addEventListener: vi.fn(), scrollLeft: 900, scrollTop: 240 };
  const wrapper = { style: { width: '2400px', height: '9000px', minWidth: '100%', transform: 'scale(2)', transformOrigin: '0 0' } };
  const viewport = new ViewportManager();
  const previous = store.activeDocument;
  try {
    store.setActiveDocument(null);
    viewport.init(scroll as unknown as HTMLElement, wrapper as unknown as HTMLElement, vi.fn());
    viewport.updateLayout();
    expect(wrapper.style).toEqual({ width: '', height: '', minWidth: '', transform: '', transformOrigin: '' });
    expect(scroll.scrollLeft).toBe(0);
    expect(scroll.scrollTop).toBe(240);
    expect(viewport.getLayout(0)).toBeUndefined();
    viewport.updateLayout();
    expect(scroll.scrollTop).toBe(240);
  } finally {
    store.setActiveDocument(previous);
    vi.unstubAllGlobals();
  }
});

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
