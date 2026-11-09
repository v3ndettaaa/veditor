import { describe, it, expect } from 'vitest';
import {
  extractPageTextLayout,
  getTextRangeRects,
  getSelectedTextFromRange,
  hitTestPageTextPoint,
  findMatchesInPageLayout,
  getWordOrMathRangeAtPoint,
} from '../src/core/pdf-text-layout';
import { store } from '../src/core/store';
import type { DocumentSession } from '../src/core/types';

function createMockPdfPage() {
  // Standard 612 x 792 PDF page (top-left viewport transform: [1, 0, 0, -1, 0, 792])
  const viewport = {
    width: 612,
    height: 792,
    transform: [1, 0, 0, -1, 0, 792],
  };

  const textContent = {
    items: [
      {
        str: 'Hello World',
        width: 110,
        height: 12,
        // Baseline at (72, 700) in PDF space -> y = 92 in top-left page space
        transform: [12, 0, 0, 12, 72, 700],
        hasEOL: true,
      },
      {
        str: 'Second line of text',
        width: 190,
        height: 12,
        // Baseline at (72, 680) in PDF space -> y = 112 in top-left page space
        transform: [12, 0, 0, 12, 72, 680],
        hasEOL: false,
      },
    ],
  };

  const page = {
    rotate: 0,
    getViewport: () => viewport,
    getTextContent: async () => textContent,
  };

  return {
    getPage: async () => page,
  };
}

function createMockMathPdfPage() {
  const viewport = {
    width: 612,
    height: 792,
    transform: [1, 0, 0, -1, 0, 792],
  };

  // Simulates LaTeX equation: x^2 + y_i = 0 where superscript '2' is raised by 5pt
  // and subscript 'i' is lowered by 3.5pt on the same visual line (main baseline y=700 in PDF space -> y=92 in viewport)
  const textContent = {
    items: [
      { str: 'x', width: 7, height: 12, transform: [12, 0, 0, 12, 100, 700], hasEOL: false },
      { str: '2', width: 5, height: 8, transform: [8, 0, 0, 8, 107.5, 705], hasEOL: false },
      { str: '+', width: 8, height: 12, transform: [12, 0, 0, 12, 116, 700], hasEOL: false },
      { str: 'y', width: 7, height: 12, transform: [12, 0, 0, 12, 127, 700], hasEOL: false },
      { str: 'i', width: 4, height: 8, transform: [8, 0, 0, 8, 134.5, 696.5], hasEOL: false },
      { str: '=0', width: 14, height: 12, transform: [12, 0, 0, 12, 142, 700], hasEOL: true },
    ],
  };

  const page = {
    rotate: 0,
    getViewport: () => viewport,
    getTextContent: async () => textContent,
  };

  return {
    getPage: async () => page,
  };
}

describe('Mathematical PDF Text Layout Engine', () => {
  it('extracts page runs with accurate unscaled top-left coordinates', async () => {
    const mockPage = createMockPdfPage();
    const layout = await extractPageTextLayout(mockPage as any, 0, 0);

    expect(layout.pageIndex).toBe(0);
    expect(layout.runs.length).toBe(2);
    expect(layout.fullText).toBe('Hello World\nSecond line of text');

    const firstRun = layout.runs[0];
    expect(firstRun.str).toBe('Hello World');
    expect(firstRun.box.x).toBeCloseTo(72, 2);
    expect(firstRun.box.width).toBeCloseTo(110, 2);
    expect(firstRun.box.height).toBeGreaterThan(10);
    // Baseline is at y = 792 - 700 = 92; top y is above baseline (~82)
    expect(firstRun.box.y).toBeLessThan(92);
    expect(firstRun.box.y + firstRun.box.height).toBeGreaterThan(92);
  });

  it('finds all substring matches with exact bounding rects and snippets', async () => {
    const mockPage = createMockPdfPage();
    const layout = await extractPageTextLayout(mockPage as any, 2, 0);

    const matches = findMatchesInPageLayout(layout, 'world');
    expect(matches.length).toBe(1);
    expect(matches[0].pageIndex).toBe(2);
    expect(matches[0].rects.length).toBe(1);
    // 'World' starts at char 6 of 'Hello World' (after 'Hello ')
    expect(matches[0].rects[0].x).toBeGreaterThan(120);
    expect(matches[0].rects[0].x).toBeLessThan(140);
    expect(matches[0].rects[0].x + matches[0].rects[0].width).toBeCloseTo(72 + 110, 1);
    expect(matches[0].snippetMatch).toBe('World');
    expect(matches[0].snippetPre).toContain('Hello');
  });

  it('hit-tests points over text runs and computes multi-line selection rects', async () => {
    const mockPage = createMockPdfPage();
    const layout = await extractPageTextLayout(mockPage as any, 0, 0);

    // Hit inside 'Hello' around x = 85, y = 86
    const hitStart = hitTestPageTextPoint(layout, 85, 86, 4, false);
    expect(hitStart).not.toBeNull();
    expect(hitStart!.runIndex).toBe(0);

    // Hit empty space far away with snapNearest = false -> null
    const miss = hitTestPageTextPoint(layout, 400, 400, 4, false);
    expect(miss).toBeNull();

    // Select across both lines ('World\nSecond')
    const rects = getTextRangeRects(layout, 6, 18);
    expect(rects.length).toBe(2);
    const selectedText = getSelectedTextFromRange(layout, 6, 18);
    expect(selectedText).toBe('World\nSecond');
  });

  it('groups math superscripts and subscripts into a single visual line without false line breaks', async () => {
    const mockMathPage = createMockMathPdfPage();
    const layout = await extractPageTextLayout(mockMathPage as any, 0, 0);

    // Must not split superscript '2' or subscript 'i' onto separate lines with '\n'
    expect(layout.fullText).not.toContain('\n');
    expect(layout.fullText.replace(/\s+/g, '')).toBe('x2+yi=0');

    // Selecting the entire math expression merges into a single smooth coplanar line rect
    const rects = getTextRangeRects(layout, 0, layout.fullText.length);
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeGreaterThan(45);
  });

  it('selects a word or connected math expression on double-click via getWordOrMathRangeAtPoint', async () => {
    const mockPage = createMockPdfPage();
    const proseLayout = await extractPageTextLayout(mockPage as any, 0, 0);

    // Double-click on 'Hello' (x=85, y=88)
    const wordSel = getWordOrMathRangeAtPoint(proseLayout, 85, 88);
    expect(wordSel).not.toBeNull();
    expect(wordSel!.text).toBe('Hello');

    // Double-click on math expression (x=120, y=88)
    const mockMathPage = createMockMathPdfPage();
    const mathLayout = await extractPageTextLayout(mockMathPage as any, 0, 0);
    const mathSel = getWordOrMathRangeAtPoint(mathLayout, 120, 88);
    expect(mathSel).not.toBeNull();
    expect(mathSel!.text.replace(/\s+/g, '')).toBe('x2+yi=0');
  });

  it('auto-closes sidebar when exiting PDF and supports custom user bookmarks', () => {
    const doc: DocumentSession = {
      id: 'test-doc-bm',
      name: 'MathBook.pdf',
      pageCount: 10,
      pages: [],
      bookmarks: [],
      annotations: {},
      layers: {},
      activePageIndex: 3,
      createdAt: Date.now(),
      lastModifiedAt: Date.now(),
    };

    store.setActiveDocument(doc);
    store.toggleSidebar('outline');
    expect(store.sidebarOpen).toBe(true);

    store.addUserBookmark(3, 'Chapter 1: Calculus');
    expect(store.activeDocument?.userBookmarks?.length).toBe(1);
    expect(store.activeDocument?.userBookmarks?.[0].title).toBe('Chapter 1: Calculus');

    const bmId = store.activeDocument!.userBookmarks![0].id;
    store.removeUserBookmark(bmId);
    expect(store.activeDocument?.userBookmarks?.length).toBe(0);

    // Exiting PDF to landing page must automatically close the sidebar
    store.setActiveDocument(null);
    expect(store.sidebarOpen).toBe(false);
  });

  it('highlights the right visual side for the start of a Persian (RTL) word and left side for the end', async () => {
    const viewport = {
      width: 612,
      height: 792,
      transform: [1, 0, 0, -1, 0, 792],
    };
    // Persian word "سلام" spanning x=200..280 (width 80)
    // In RTL reading order: "س" (start of word) is at the right edge (x=260..280),
    // and "م" (end of word) is at the left edge (x=200..220).
    const mockRtlPage = {
      getPage: async () => ({
        rotate: 0,
        getViewport: () => viewport,
        getTextContent: async () => ({
          items: [
            { str: 'سلام', width: 80, height: 14, transform: [14, 0, 0, 14, 200, 700], hasEOL: true },
          ],
        }),
      }),
    };

    const layout = await extractPageTextLayout(mockRtlPage as any, 0, 0);
    const startMatches = findMatchesInPageLayout(layout, 'سل');
    const endMatches = findMatchesInPageLayout(layout, 'ام');

    expect(startMatches.length).toBe(1);
    expect(endMatches.length).toBe(1);

    const startRect = startMatches[0].rects[0];
    const endRect = endMatches[0].rects[0];

    // Start of Persian word ("سل") must highlight the RIGHT side ending at x=280
    expect(startRect.x + startRect.width).toBeCloseTo(280, 1);
    expect(startRect.x).toBeGreaterThan(230);

    // End of Persian word ("ام") must highlight the LEFT side starting at x=200
    expect(endRect.x).toBeCloseTo(200, 1);
    expect(endRect.x + endRect.width).toBeCloseTo(startRect.x, 1);
  });

  it('selects the exact clicked word in mixed Persian and English lines without cross-script bleed', async () => {
    const viewport = {
      width: 612,
      height: 792,
      transform: [1, 0, 0, -1, 0, 792],
    };
    // Mixed line: English run "Vector" at x=100..160 and Persian run "کتاب" at x=180..260
    const mockMixedPage = {
      getPage: async () => ({
        rotate: 0,
        getViewport: () => viewport,
        getTextContent: async () => ({
          items: [
            { str: 'Vector', width: 60, height: 12, transform: [12, 0, 0, 12, 100, 700], hasEOL: false },
            { str: 'کتاب', width: 80, height: 12, transform: [12, 0, 0, 12, 180, 700], hasEOL: true },
          ],
        }),
      }),
    };

    const layout = await extractPageTextLayout(mockMixedPage as any, 0, 0);

    // Clicking inside English run (x=125, y=88) selects "Vector"
    const engSel = getWordOrMathRangeAtPoint(layout, 125, 88);
    expect(engSel).not.toBeNull();
    expect(engSel!.text).toBe('Vector');

    // Clicking inside Persian run (x=210, y=88) selects "کتاب"
    const faSel = getWordOrMathRangeAtPoint(layout, 210, 88);
    expect(faSel).not.toBeNull();
    expect(faSel!.text).toBe('کتاب');
  });
});

