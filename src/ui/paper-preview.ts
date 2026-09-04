/**
 * Canvas preview of a notebook paper style.
 *
 * Draws from the same `paperGeometry()` the PDF generator uses, so the preview
 * cannot drift from what actually lands in the document.
 */

import { PaperStyle, PageSizeName, PAGE_SIZES } from '../core/types';
import { paperGeometry } from '../io/notebook';

/**
 * Paints `paper` into `canvas`, fitting the given page size. Sizes the canvas
 * backing store for the device pixel ratio so the rules stay crisp.
 */
export function drawPaperPreview(
  canvas: HTMLCanvasElement,
  paper: PaperStyle,
  pageSize: PageSizeName
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const page = PAGE_SIZES[pageSize] ?? PAGE_SIZES.letter;
  const box = canvas.getBoundingClientRect();
  const cssW = box.width || canvas.clientWidth || 200;
  const dpr = window.devicePixelRatio || 1;

  // Keep the preview at the page's aspect ratio.
  const cssH = cssW * (page.height / page.width);
  canvas.style.height = `${cssH}px`;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const scale = w / page.width;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = paper.paperColor;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, page.width, page.height);
  ctx.clip();

  const { lines, dots, marginX } = paperGeometry(paper, page.width, page.height);

  ctx.strokeStyle = paper.lineColor;
  ctx.fillStyle = paper.lineColor;

  // Group by thickness so the whole field is one path per width.
  const byThickness = new Map<number, typeof lines>();
  for (const l of lines) {
    const bucket = byThickness.get(l.thickness) ?? [];
    bucket.push(l);
    byThickness.set(l.thickness, bucket);
  }
  for (const [thickness, bucket] of byThickness) {
    ctx.lineWidth = Math.max(thickness, 0.75 / scale);
    ctx.beginPath();
    for (const l of bucket) {
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
    }
    ctx.stroke();
  }

  for (const d of dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(d.r, 0.6 / scale), 0, Math.PI * 2);
    ctx.fill();
  }

  if (marginX !== null) {
    ctx.strokeStyle = '#e8a0a8';
    ctx.lineWidth = Math.max(0.9, 1 / scale);
    ctx.beginPath();
    ctx.moveTo(marginX, 0);
    ctx.lineTo(marginX, page.height);
    ctx.stroke();
  }

  ctx.restore();
}
