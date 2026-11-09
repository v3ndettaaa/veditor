import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BoundingBox } from './types';

export interface PdfTextCharBox {
  charIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfTextRun {
  index: number;
  str: string;
  startOffset: number;
  endOffset: number;
  box: BoundingBox;
  baselineY: number;
  fontSize: number;
  angle: number;
  chars: PdfTextCharBox[];
}

export interface PageTextLayout {
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
  fullText: string;
  runs: PdfTextRun[];
}

export interface PdfSearchMatch {
  id: string;
  pageIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  snippetPre: string;
  snippetMatch: string;
  snippetPost: string;
  rects: BoundingBox[];
  bounds: BoundingBox;
}

export interface PdfTextSelection {
  pageIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  rects: BoundingBox[];
  bounds: BoundingBox;
}

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface PositionedRawRun {
  str: string;
  hasEOL: boolean;
  baselineX: number;
  baselineY: number;
  fontHeight: number;
  angle: number;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  originalOrder: number;
}

function normalizeRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

const MATH_CHAR_REGEX = /[=+\-−×÷*/^_<>≤≥≠≈≡±∓∞∑∏∫∮√∂∇∈∉⊂⊃⊆⊇∪∩∀∃⇒⇔↔→←α-ωΑ-ΩπθλμσΔΣΠΩ0-9()[\]{}|]/;
const RTL_CHAR_REGEX = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR_REGEX = /[A-Za-z0-9]/;

export function isMathLikeText(str: string): boolean {
  return MATH_CHAR_REGEX.test(str);
}

export function isRtlText(str: string): boolean {
  return RTL_CHAR_REGEX.test(str);
}

function countDirectionalChars(str: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const ch of str) {
    if (RTL_CHAR_REGEX.test(ch)) rtl++;
    else if (LTR_CHAR_REGEX.test(ch)) ltr++;
  }
  return { rtl, ltr };
}

/**
 * Computes per-character visual bounding boxes within `[boxX, boxX + boxW]`.
 * - For LTR strings, characters progress from left (`boxX`) to right (`boxX + boxW`).
 * - For RTL strings (Persian/Arabic), logical character index 0 is on the RIGHT
 *   (`boxX + boxW - charW`) and progresses right-to-left toward `boxX`, while
 *   keeping any embedded LTR number/word sub-run ordered left-to-right within its span.
 */
function buildRunCharBoxes(
  str: string,
  cursorOffset: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number
): PdfTextCharBox[] {
  const weights = Array.from(str).map((ch) => getGlyphRelativeWeight(ch));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || Math.max(1, str.length);
  const charWidths = weights.map((w) => (w / totalWeight) * boxW);

  const { rtl } = countDirectionalChars(str);
  if (rtl === 0) {
    const chars: PdfTextCharBox[] = [];
    let accX = boxX;
    for (let c = 0; c < str.length; c++) {
      const w = charWidths[c];
      chars.push({
        charIndex: cursorOffset + c,
        x: accX,
        y: boxY,
        width: Math.max(0.5, w),
        height: boxH,
      });
      accX += w;
    }
    return chars;
  }

  // RTL string: partition into directional sub-segments so RTL letters flow
  // right-to-left from (boxX + boxW) down to boxX, while embedded LTR runs
  // (e.g. numbers/Latin inside an RTL token) flow left-to-right inside their slot.
  interface BiDiSegment {
    start: number;
    end: number;
    isLtrIsland: boolean;
  }
  const segments: BiDiSegment[] = [];
  let i = 0;
  while (i < str.length) {
    const isLtr = LTR_CHAR_REGEX.test(str[i]);
    let j = i + 1;
    while (j < str.length && LTR_CHAR_REGEX.test(str[j]) === isLtr) {
      j++;
    }
    segments.push({ start: i, end: j, isLtrIsland: isLtr });
    i = j;
  }

  const chars: PdfTextCharBox[] = new Array(str.length);
  let curRight = boxX + boxW;

  for (const seg of segments) {
    let segWidth = 0;
    for (let c = seg.start; c < seg.end; c++) {
      segWidth += charWidths[c];
    }

    if (seg.isLtrIsland) {
      let ltrX = curRight - segWidth;
      for (let c = seg.start; c < seg.end; c++) {
        const w = charWidths[c];
        chars[c] = {
          charIndex: cursorOffset + c,
          x: Math.max(boxX, ltrX),
          y: boxY,
          width: Math.max(0.5, w),
          height: boxH,
        };
        ltrX += w;
      }
      curRight -= segWidth;
    } else {
      for (let c = seg.start; c < seg.end; c++) {
        const w = charWidths[c];
        curRight -= w;
        chars[c] = {
          charIndex: cursorOffset + c,
          x: Math.max(boxX, curRight),
          y: boxY,
          width: Math.max(0.5, w),
          height: boxH,
        };
      }
    }
  }

  return chars;
}

/**
 * Extracts exact text runs and character bounding boxes in unscaled (scale=1)
 * top-left viewport coordinates for a 0-based `pageIndex`, using full 2D affine
 * matrix composition (M = V * T), BiDi-aware line ordering, and math-aware
 * sub/superscript grouping.
 */
export async function extractPageTextLayout(
  pdfDoc: PDFDocumentProxy,
  pageIndex: number,
  userRotation: number = 0
): Promise<PageTextLayout> {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const totalRotation = normalizeRotation((page.rotate || 0) + userRotation);
  const viewport = page.getViewport({ scale: 1.0, rotation: totalRotation });
  const textContent = await page.getTextContent();
  const viewportScale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;

  // Step 1: Transform raw PDF.js text items into viewport space
  const rawRuns: PositionedRawRun[] = [];
  let orderCounter = 0;

  for (const raw of textContent.items) {
    if (!('str' in raw)) continue;
    const item = raw as unknown as RawTextItem;
    const str = item.str ?? '';
    if (str.length === 0) {
      if (item.hasEOL && rawRuns.length > 0) {
        rawRuns[rawRuns.length - 1].hasEOL = true;
      }
      continue;
    }

    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const matrixFontH = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || 0;
    const itemFontH = Math.abs(item.height || 0) * viewportScale;
    const fontHeight = Math.max(matrixFontH, itemFontH, 8);
    const angle = Math.atan2(m[1], m[0]);

    const advanceWidth = Math.max(
      Math.abs(item.width || 0) * viewportScale,
      fontHeight * (str.length === 1 && isMathLikeText(str) ? 0.45 : 0.35) * str.length
    );

    const ascent = fontHeight * 0.78;
    const descent = fontHeight * 0.22;
    const totalBoxHeight = ascent + descent;

    const baselineX = m[4];
    const baselineY = m[5];

    let boxX = baselineX;
    let boxY = baselineY - ascent;
    let boxW = advanceWidth;
    let boxH = totalBoxHeight;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    if (Math.abs(sinA) > 0.05) {
      const corners = [
        { x: baselineX, y: baselineY - ascent },
        { x: baselineX + advanceWidth * cosA, y: baselineY + advanceWidth * sinA - ascent },
        { x: baselineX + advanceWidth * cosA, y: baselineY + advanceWidth * sinA + descent },
        { x: baselineX, y: baselineY + descent },
      ];
      const minX = Math.min(...corners.map((c) => c.x));
      const maxX = Math.max(...corners.map((c) => c.x));
      const minY = Math.min(...corners.map((c) => c.y));
      const maxY = Math.max(...corners.map((c) => c.y));
      boxX = minX;
      boxY = minY;
      boxW = Math.max(2, maxX - minX);
      boxH = Math.max(2, maxY - minY);
    }

    boxX = Math.max(0, Math.min(viewport.width - 1, boxX));
    boxY = Math.max(0, Math.min(viewport.height - 1, boxY));
    boxW = Math.max(1, Math.min(viewport.width - boxX, boxW));
    boxH = Math.max(1, Math.min(viewport.height - boxY, boxH));

    rawRuns.push({
      str,
      hasEOL: Boolean(item.hasEOL),
      baselineX,
      baselineY,
      fontHeight,
      angle,
      boxX,
      boxY,
      boxW,
      boxH,
      originalOrder: orderCounter++,
    });
  }

  // Step 2: Group consecutive runs into visual line bands so math sub/superscripts
  // stay on the same line without ever merging two separate paragraph lines.
  interface VisualLineBand {
    items: PositionedRawRun[];
    anchorBaselineY: number;
    maxFontSize: number;
    minY: number;
    maxY: number;
  }

  const lineBands: VisualLineBand[] = [];
  for (const r of rawRuns) {
    if (lineBands.length === 0) {
      lineBands.push({
        items: [r],
        anchorBaselineY: r.baselineY,
        maxFontSize: r.fontHeight,
        minY: r.boxY,
        maxY: r.boxY + r.boxH,
      });
      continue;
    }

    const band = lineBands[lineBands.length - 1];
    const prevItem = band.items[band.items.length - 1];
    const refFont = Math.max(band.maxFontSize, r.fontHeight, 10);
    const baselineDiff = Math.abs(r.baselineY - band.anchorBaselineY);

    // Same baseline tolerance (handles minor baseline differences between Persian and Latin fonts on the same line)
    const sameBaseline = baselineDiff <= refFont * 0.36;

    // Math sub/superscript or inline symbol tolerance: smaller font or math token close horizontally
    const horizDist = Math.max(
      0,
      r.boxX > prevItem.boxX + prevItem.boxW
        ? r.boxX - (prevItem.boxX + prevItem.boxW)
        : prevItem.boxX > r.boxX + r.boxW
          ? prevItem.boxX - (r.boxX + r.boxW)
          : 0
    );
    const isMathSubOrSup =
      !isRtlText(r.str) &&
      !isRtlText(prevItem.str) &&
      horizDist <= refFont * 2.2 &&
      baselineDiff <= refFont * 0.82 &&
      (r.fontHeight < band.maxFontSize * 0.88 ||
        prevItem.fontHeight < band.maxFontSize * 0.88 ||
        isMathLikeText(r.str) ||
        isMathLikeText(prevItem.str));

    if (sameBaseline || isMathSubOrSup) {
      band.items.push(r);
      if (r.fontHeight >= band.maxFontSize * 0.85) {
        band.anchorBaselineY = (band.anchorBaselineY * 0.7) + (r.baselineY * 0.3);
        band.maxFontSize = Math.max(band.maxFontSize, r.fontHeight);
      }
      band.minY = Math.min(band.minY, r.boxY);
      band.maxY = Math.max(band.maxY, r.boxY + r.boxH);
    } else {
      lineBands.push({
        items: [r],
        anchorBaselineY: r.baselineY,
        maxFontSize: r.fontHeight,
        minY: r.boxY,
        maxY: r.boxY + r.boxH,
      });
    }
  }

  // Step 3: Order runs within each visual line band using BiDi-aware sorting
  const runs: PdfTextRun[] = [];
  const textParts: string[] = [];
  let cursorOffset = 0;

  for (let bIdx = 0; bIdx < lineBands.length; bIdx++) {
    const band = lineBands[bIdx];
    const allUnrotated = band.items.every((it) => Math.abs(Math.sin(it.angle)) <= 0.05);

    let orderedItems = band.items;
    if (allUnrotated && band.items.length > 1) {
      // First sort geometrically left-to-right
      const ltrSorted = [...band.items].sort((a, b) => {
        const dx = a.boxX - b.boxX;
        if (Math.abs(dx) > 1.8) return dx;
        return a.originalOrder - b.originalOrder;
      });

      // Check if the visual line is RTL-dominant (Persian/Arabic line)
      let bandRtl = 0;
      let bandLtr = 0;
      for (const it of ltrSorted) {
        const counts = countDirectionalChars(it.str);
        bandRtl += counts.rtl;
        bandLtr += counts.ltr;
      }

      if (bandRtl > 0 && bandRtl >= bandLtr) {
        // RTL-dominant line: primary reading flow is right-to-left, while
        // contiguous LTR islands (English words/numbers) stay left-to-right.
        const rev = [...ltrSorted].reverse();
        const biDiOrdered: PositionedRawRun[] = [];
        let k = 0;
        while (k < rev.length) {
          const curCounts = countDirectionalChars(rev[k].str);
          const isPureLtrRun = curCounts.rtl === 0 && curCounts.ltr > 0;
          if (!isPureLtrRun) {
            biDiOrdered.push(rev[k]);
            k++;
          } else {
            let m = k + 1;
            while (m < rev.length) {
              const mc = countDirectionalChars(rev[m].str);
              if (mc.rtl === 0 && (mc.ltr > 0 || isMathLikeText(rev[m].str))) {
                m++;
              } else {
                break;
              }
            }
            // Reverse the LTR island back to left-to-right
            const island = rev.slice(k, m).reverse();
            biDiOrdered.push(...island);
            k = m;
          }
        }
        orderedItems = biDiOrdered;
      } else {
        orderedItems = ltrSorted;
      }
    }

    if (bIdx > 0 && cursorOffset > 0) {
      const lastPart = textParts[textParts.length - 1] ?? '';
      if (!lastPart.endsWith('\n')) {
        textParts.push('\n');
        cursorOffset += 1;
      }
    }

    for (let i = 0; i < orderedItems.length; i++) {
      const item = orderedItems[i];
      const str = item.str;

      if (i > 0) {
        const prevItem = orderedItems[i - 1];
        const prevText = textParts[textParts.length - 1] ?? '';
        if (!prevText.endsWith(' ') && !prevText.endsWith('\n') && !str.startsWith(' ')) {
          const horizGap = Math.max(
            item.boxX - (prevItem.boxX + prevItem.boxW),
            prevItem.boxX - (item.boxX + item.boxW)
          );
          const scriptSwitch = isRtlText(prevItem.str) !== isRtlText(str) &&
            (LTR_CHAR_REGEX.test(prevItem.str) || LTR_CHAR_REGEX.test(str));
          const isSubOrSup =
            Math.abs(item.baselineY - prevItem.baselineY) > Math.min(item.fontHeight, prevItem.fontHeight) * 0.18 ||
            Math.abs(item.fontHeight - prevItem.fontHeight) > Math.max(item.fontHeight, prevItem.fontHeight) * 0.15;
          const spaceThreshold = isSubOrSup
            ? Math.max(prevItem.fontHeight * 0.32, 2.8)
            : Math.max(prevItem.fontHeight * 0.14, 1.2);
          if (horizGap > spaceThreshold || (scriptSwitch && horizGap > -1.5)) {
            textParts.push(' ');
            cursorOffset += 1;
          }
        }
      }

      const chars = buildRunCharBoxes(
        str,
        cursorOffset,
        item.boxX,
        item.boxY,
        item.boxW,
        item.boxH
      );

      const startOffset = cursorOffset;
      const endOffset = cursorOffset + str.length;
      textParts.push(str);
      cursorOffset = endOffset;

      runs.push({
        index: runs.length,
        str,
        startOffset,
        endOffset,
        box: { x: item.boxX, y: item.boxY, width: item.boxW, height: item.boxH },
        baselineY: item.baselineY,
        fontSize: item.fontHeight,
        angle: item.angle,
        chars,
      });
    }
  }

  return {
    pageIndex,
    width: viewport.width,
    height: viewport.height,
    rotation: totalRotation,
    fullText: textParts.join(''),
    runs,
  };
}

function getGlyphRelativeWeight(ch: string): number {
  if ('\u200c\u200d\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652'.includes(ch)) return 0.08;
  if ('ilI1!|.,:;\'"` اآإأدذرزژو'.includes(ch)) return 0.58;
  if ('mwMW@%&QGO∑∏∫شصضطظعغفقکگلمنهی'.includes(ch)) return 1.22;
  if ('frtJ()[]{}'.includes(ch)) return 0.72;
  return 1.0;
}

export function getRunSliceRect(
  run: PdfTextRun,
  sliceStartOffset: number,
  sliceEndOffset: number
): BoundingBox | null {
  const clampedStart = Math.max(run.startOffset, sliceStartOffset);
  const clampedEnd = Math.min(run.endOffset, sliceEndOffset);
  if (clampedEnd <= clampedStart) return null;

  const firstIdx = clampedStart - run.startOffset;
  const lastIdx = clampedEnd - run.startOffset - 1;
  if (run.chars.length === 0) {
    return { ...run.box };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  for (let idx = Math.max(0, firstIdx); idx <= Math.min(run.chars.length - 1, lastIdx); idx++) {
    const ch = run.chars[idx];
    if (!ch) continue;
    if (ch.x < minX) minX = ch.x;
    if (ch.x + ch.width > maxX) maxX = ch.x + ch.width;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { ...run.box };
  }

  return {
    x: minX,
    y: run.box.y,
    width: Math.max(1, maxX - minX),
    height: run.box.height,
  };
}

export function mergeCoplanarLineRects(rects: BoundingBox[]): BoundingBox[] {
  if (rects.length <= 1) return rects.map((r) => ({ ...r }));

  // Sort rects on the same visual line by X before merging so RTL/BiDi slices merge cleanly
  const sorted = rects.map((r) => ({ ...r }));
  const merged: BoundingBox[] = [];
  for (const r of sorted) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const prev = merged[merged.length - 1];
    const prevMidY = prev.y + prev.height / 2;
    const curMidY = r.y + r.height / 2;
    const maxH = Math.max(prev.height, r.height, 8);
    const minH = Math.min(prev.height, r.height);
    const overlapTop = Math.max(prev.y, r.y);
    const overlapBot = Math.min(prev.y + prev.height, r.y + r.height);
    const verticalOverlap = overlapBot - overlapTop;

    const sameLine =
      Math.abs(prevMidY - curMidY) <= maxH * 0.78 ||
      verticalOverlap >= minH * 0.2;
    const gapRight = r.x - (prev.x + prev.width);
    const gapLeft = prev.x - (r.x + r.width);
    const horizDist = Math.max(gapRight, gapLeft);

    if (sameLine && horizDist <= maxH * 2.2) {
      const minX = Math.min(prev.x, r.x);
      const minY = Math.min(prev.y, r.y);
      const maxX = Math.max(prev.x + prev.width, r.x + r.width);
      const maxY = Math.max(prev.y + prev.height, r.y + r.height);
      prev.x = minX;
      prev.y = minY;
      prev.width = maxX - minX;
      prev.height = maxY - minY;
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}

export function computeUnionBounds(rects: BoundingBox[]): BoundingBox {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function getTextRangeRects(
  layout: PageTextLayout,
  offsetA: number,
  offsetB: number
): BoundingBox[] {
  const start = Math.max(0, Math.min(offsetA, offsetB));
  const end = Math.min(layout.fullText.length, Math.max(offsetA, offsetB));
  if (end <= start) return [];

  const rawRects: BoundingBox[] = [];
  for (const run of layout.runs) {
    if (run.endOffset <= start) continue;
    if (run.startOffset >= end) break;
    const rect = getRunSliceRect(run, start, end);
    if (rect) rawRects.push(rect);
  }

  return mergeCoplanarLineRects(rawRects);
}

export function getSelectedTextFromRange(
  layout: PageTextLayout,
  offsetA: number,
  offsetB: number
): string {
  const start = Math.max(0, Math.min(offsetA, offsetB));
  const end = Math.min(layout.fullText.length, Math.max(offsetA, offsetB));
  if (end <= start) return '';
  return layout.fullText.slice(start, end);
}

/**
 * Hit-tests a point in unscaled page space against text runs.
 * Supports both LTR and RTL character boxes by finding the exact character box
 * containing or closest to `pageX`.
 */
export function hitTestPageTextPoint(
  layout: PageTextLayout,
  pageX: number,
  pageY: number,
  padding: number = 3,
  snapNearest: boolean = false
): { runIndex: number; charOffset: number } | null {
  if (layout.runs.length === 0) return null;

  let bestDirectRun: PdfTextRun | null = null;
  let bestDirectDist = Infinity;

  for (const run of layout.runs) {
    const b = run.box;
    if (
      pageX >= b.x - padding &&
      pageX <= b.x + b.width + padding &&
      pageY >= b.y - padding &&
      pageY <= b.y + b.height + padding
    ) {
      const dx = pageX < b.x ? b.x - pageX : pageX > b.x + b.width ? pageX - (b.x + b.width) : 0;
      const dy = pageY < b.y ? b.y - pageY : pageY > b.y + b.height ? pageY - (b.y + b.height) : 0;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDirectDist) {
        bestDirectDist = dist;
        bestDirectRun = run;
      }
    }
  }

  const targetRun = bestDirectRun ?? (snapNearest ? findNearestRun(layout, pageX, pageY) : null);
  if (!targetRun || targetRun.chars.length === 0) return null;

  // Find the character box in targetRun that contains pageX, or whose center is closest to pageX
  let bestChar = targetRun.chars[0];
  let bestCharDist = Infinity;
  for (let i = 0; i < targetRun.chars.length; i++) {
    const ch = targetRun.chars[i];
    if (pageX >= ch.x && pageX <= ch.x + ch.width) {
      bestChar = ch;
      bestCharDist = 0;
      break;
    }
    const midX = ch.x + ch.width / 2;
    const dist = Math.abs(pageX - midX);
    if (dist < bestCharDist) {
      bestCharDist = dist;
      bestChar = ch;
    }
  }

  const runIsRtl = isRtlText(targetRun.str);
  if (!snapNearest) {
    // Direct click/hover: return the exact character index inside targetRun
    return { runIndex: targetRun.index, charOffset: bestChar.charIndex };
  }

  // Drag selection boundary: advance past character midpoint in reading direction
  const midX = bestChar.x + bestChar.width / 2;
  const pastMidpoint = runIsRtl ? pageX < midX : pageX > midX;
  return {
    runIndex: targetRun.index,
    charOffset: pastMidpoint ? Math.min(targetRun.endOffset, bestChar.charIndex + 1) : bestChar.charIndex,
  };
}

function findNearestRun(layout: PageTextLayout, pageX: number, pageY: number): PdfTextRun | null {
  let bestRun: PdfTextRun | null = null;
  let bestScore = Infinity;

  for (const run of layout.runs) {
    const b = run.box;
    const dx = pageX < b.x ? b.x - pageX : pageX > b.x + b.width ? pageX - (b.x + b.width) : 0;
    const dy = pageY < b.y ? b.y - pageY : pageY > b.y + b.height ? pageY - (b.y + b.height) : 0;
    const score = dy * 2.8 + dx;
    if (score < bestScore) {
      bestScore = score;
      bestRun = run;
    }
  }
  return bestRun;
}

/**
 * Selects the word or connected mathematical expression at `(pageX, pageY)` on double-click.
 * Strictly keeps the pivot inside the clicked run and respects Persian/Arabic vs Latin script boundaries.
 */
export function getWordOrMathRangeAtPoint(
  layout: PageTextLayout,
  pageX: number,
  pageY: number
): PdfTextSelection | null {
  const hit = hitTestPageTextPoint(layout, pageX, pageY, 6, false);
  if (!hit || !layout.fullText) return null;

  const text = layout.fullText;
  const len = text.length;
  const clickedRun = layout.runs[hit.runIndex];
  const minRunOffset = clickedRun ? clickedRun.startOffset : 0;
  const maxRunOffset = clickedRun ? Math.max(clickedRun.startOffset, clickedRun.endOffset - 1) : len - 1;
  let pivot = Math.min(Math.max(minRunOffset, hit.charOffset), Math.min(maxRunOffset, len - 1));

  // If clicked on a space inside the run, step to adjacent non-space inside the same run
  if (/\s/.test(text[pivot])) {
    if (pivot > minRunOffset && !/\s/.test(text[pivot - 1])) {
      pivot -= 1;
    } else if (pivot < maxRunOffset && !/\s/.test(text[pivot + 1])) {
      pivot += 1;
    }
  }
  if (/\s/.test(text[pivot])) return null;

  const pivotChar = text[pivot];
  const pivotIsRtl = RTL_CHAR_REGEX.test(pivotChar);

  // Script-aware word character predicates (includes ZWNJ \u200C for Persian words like «می‌شود»)
  const isRtlWordChar = (ch: string) => /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u200C\u200D]/u.test(ch);
  const isLtrWordChar = (ch: string) => /[A-Za-z0-9_'-]/.test(ch);
  const isSameScriptWordChar = (ch: string) => (pivotIsRtl ? isRtlWordChar(ch) : isLtrWordChar(ch));

  const isMathTokenChar = (ch: string) =>
    !RTL_CHAR_REGEX.test(ch) &&
    /[\p{L}\p{N}_+\-−×÷*/^=<>≤≥≠≈≡±∓∞∑∏∫∮√∂∇∈∉⊂⊃⊆⊇∪∩∀∃⇒⇔↔→←()[\]{}.,:|]/u.test(ch);

  // Check if the surrounding window looks like a math expression (only when not clicking Persian text)
  const winStart = Math.max(0, pivot - 8);
  const winEnd = Math.min(len, pivot + 9);
  const windowStr = text.slice(winStart, winEnd);
  const neighborRunA = layout.runs[hit.runIndex - 1];
  const neighborRunB = layout.runs[hit.runIndex + 1];
  const hasBaselineShiftNeighbor = Boolean(
    clickedRun &&
    ((neighborRunA && Math.abs(neighborRunA.baselineY - clickedRun.baselineY) > 1.2 && Math.abs(neighborRunA.baselineY - clickedRun.baselineY) < clickedRun.fontSize * 0.85) ||
     (neighborRunB && Math.abs(neighborRunB.baselineY - clickedRun.baselineY) > 1.2 && Math.abs(neighborRunB.baselineY - clickedRun.baselineY) < clickedRun.fontSize * 0.85))
  );

  const mathMode =
    !pivotIsRtl &&
    isMathLikeText(windowStr) &&
    (hasBaselineShiftNeighbor || /[=+\-−×÷*/^_<>≤≥≠≈≡±∓∞∑∏∫∮√∂∇∈∉⊂⊃∪∩()]/.test(windowStr));

  let start = pivot;
  let end = pivot + 1;

  if (mathMode) {
    while (start > 0) {
      const prev = text[start - 1];
      if (prev === '\n' || RTL_CHAR_REGEX.test(prev)) break;
      if (isMathTokenChar(prev)) {
        start--;
      } else if (prev === ' ' && start >= 2 && isMathTokenChar(text[start - 2]) && /[=+\-−×÷*/^<>≤≥≠≈≡±∓∈⊂⊃∪∩]/.test(`${text[start - 2]}${text[start]}`)) {
        start--;
      } else {
        break;
      }
    }
    while (end < len) {
      const cur = text[end];
      if (cur === '\n' || RTL_CHAR_REGEX.test(cur)) break;
      if (isMathTokenChar(cur)) {
        end++;
      } else if (cur === ' ' && end + 1 < len && isMathTokenChar(text[end + 1]) && /[=+\-−×÷*/^<>≤≥≠≈≡±∓∈⊂⊃∪∩]/.test(`${text[end - 1]}${text[end + 1]}`)) {
        end++;
      } else {
        break;
      }
    }
    while (end > start + 1 && /[.,;:]/.test(text[end - 1])) {
      end--;
    }
  } else if (isSameScriptWordChar(pivotChar)) {
    while (start > 0 && isSameScriptWordChar(text[start - 1])) start--;
    while (end < len && isSameScriptWordChar(text[end])) end++;
  } else {
    while (start > 0 && !/\s/.test(text[start - 1]) && !isRtlWordChar(text[start - 1]) && !isLtrWordChar(text[start - 1])) start--;
    while (end < len && !/\s/.test(text[end]) && !isRtlWordChar(text[end]) && !isLtrWordChar(text[end])) end++;
  }

  const selectedText = getSelectedTextFromRange(layout, start, end).trim();
  if (!selectedText) return null;

  const rects = getTextRangeRects(layout, start, end);
  if (rects.length === 0) return null;

  return {
    pageIndex: layout.pageIndex,
    startOffset: start,
    endOffset: end,
    text: selectedText,
    rects,
    bounds: computeUnionBounds(rects),
  };
}

/**
 * Finds all case-insensitive occurrences of `query` in `layout` and computes
 * their exact merged line rectangles and context snippets.
 */
export function findMatchesInPageLayout(
  layout: PageTextLayout,
  query: string
): PdfSearchMatch[] {
  const cleanQuery = query.trim();
  if (!cleanQuery || !layout.fullText) return [];

  const lowerFull = layout.fullText.toLowerCase();
  const lowerQuery = cleanQuery.toLowerCase();
  const qLen = lowerQuery.length;
  const matches: PdfSearchMatch[] = [];

  let searchFrom = 0;
  let matchIdx = 0;

  while (searchFrom <= lowerFull.length - qLen) {
    const idx = lowerFull.indexOf(lowerQuery, searchFrom);
    if (idx === -1) break;

    const startOffset = idx;
    const endOffset = idx + qLen;
    const rects = getTextRangeRects(layout, startOffset, endOffset);

    if (rects.length > 0) {
      const bounds = computeUnionBounds(rects);
      const preStart = Math.max(0, startOffset - 28);
      const postEnd = Math.min(layout.fullText.length, endOffset + 34);
      const rawPre = layout.fullText.slice(preStart, startOffset).replace(/\s+/g, ' ');
      const rawMatch = layout.fullText.slice(startOffset, endOffset).replace(/\s+/g, ' ');
      const rawPost = layout.fullText.slice(endOffset, postEnd).replace(/\s+/g, ' ');

      matches.push({
        id: `search-${layout.pageIndex}-${matchIdx++}`,
        pageIndex: layout.pageIndex,
        startOffset,
        endOffset,
        text: rawMatch,
        snippetPre: (preStart > 0 ? '…' : '') + rawPre,
        snippetMatch: rawMatch,
        snippetPost: rawPost + (postEnd < layout.fullText.length ? '…' : ''),
        rects,
        bounds,
      });
    }

    searchFrom = idx + Math.max(1, qLen);
  }

  return matches;
}
