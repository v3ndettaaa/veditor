import { describe, it, expect } from 'vitest';
import { isPdfDisplayedDark } from '../src/io/save-policy';

describe('Save As theme preselection', () => {
  it('matches the PDF view when inversion is on', () => {
    expect(isPdfDisplayedDark(true, false)).toBe(true);
    expect(isPdfDisplayedDark(false, true)).toBe(true);
    expect(isPdfDisplayedDark(true, true)).toBe(true);
  });

  it('matches the PDF view when inversion is off', () => {
    expect(isPdfDisplayedDark(false, false)).toBe(false);
  });
});
