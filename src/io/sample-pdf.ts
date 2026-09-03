/**
 * Built-in Sample PDF & Blank Notebook Generator
 * Provides immediate instant-test capability without requiring an external PDF file.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export async function generateSamplePDF(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Page 1: Welcome & Overview
  const page1 = pdfDoc.addPage([612, 792]); // Standard US Letter
  const { width, height } = page1.getSize();

  // Header Banner
  page1.drawRectangle({
    x: 40,
    y: height - 120,
    width: width - 80,
    height: 70,
    color: rgb(0.08, 0.08, 0.12),
    borderColor: rgb(0.23, 0.35, 0.95),
    borderWidth: 1.5,
  });

  page1.drawText('Welcome to veditor', {
    x: 60,
    y: height - 85,
    size: 22,
    font: fontBold,
    color: rgb(0.95, 0.95, 1.0),
  });

  page1.drawText('Professional, Private & High-Performance PDF Annotation', {
    x: 60,
    y: height - 105,
    size: 11,
    font,
    color: rgb(0.65, 0.70, 0.85),
  });

  // Feature Highlights Box
  page1.drawText('Key Capabilities to Explore:', {
    x: 45,
    y: height - 160,
    size: 14,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.20),
  });

  const features = [
    '• Pen & Highlighter: Smooth vector ink with realistic pressure curves and tilt',
    '• Pixel & Stroke Erasers: Erase whole strokes or slice segments with surgical precision',
    '• Shapes & Callouts: Rectangles, ellipses, arrows, measurements, and speech bubbles',
    '• Keyboard-First Workflow: Press "P" for pen, "H" for highlighter, "E" for eraser, "Ctrl+Z" to undo',
    '• Zero Cloud Telemetry: Runs 100% locally in your browser sandbox with complete privacy',
    '• Vector Export: Export crisp annotations that stay sharp on any device or printer',
  ];

  let y = height - 190;
  for (const feat of features) {
    page1.drawText(feat, {
      x: 55,
      y,
      size: 10.5,
      font,
      color: rgb(0.25, 0.25, 0.30),
    });
    y -= 24;
  }

  // Drawing Canvas Area
  page1.drawRectangle({
    x: 45,
    y: 60,
    width: width - 90,
    height: y - 80,
    color: rgb(0.98, 0.98, 1.0),
    borderColor: rgb(0.80, 0.82, 0.90),
    borderWidth: 1,
  });

  page1.drawText('Interactive Drawing Sandbox (Test Your Pen & Annotations Here):', {
    x: 55,
    y: y - 50,
    size: 10,
    font: fontBold,
    color: rgb(0.40, 0.45, 0.60),
  });

  // Page 2: Note-taking template
  const page2 = pdfDoc.addPage([612, 792]);
  page2.drawText('Meeting & Study Notes', {
    x: 50,
    y: height - 60,
    size: 18,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.15),
  });

  page2.drawText('Date: ____________________       Topic: ____________________________________', {
    x: 50,
    y: height - 85,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.45),
  });

  // Ruled lines for notes
  for (let lineY = height - 120; lineY >= 80; lineY -= 26) {
    page2.drawLine({
      start: { x: 50, y: lineY },
      end: { x: width - 50, y: lineY },
      thickness: 0.75,
      color: rgb(0.85, 0.88, 0.92),
    });
  }

  return await pdfDoc.save();
}

export async function createBlankNotebook(
  paperStyle: 'blank' | 'lined' | 'grid' = 'lined',
  pageCount: number = 3
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  for (let p = 0; p < pageCount; p++) {
    const page = pdfDoc.addPage([612, 792]);
    const { width, height } = page.getSize();

    if (paperStyle === 'lined') {
      for (let y = 60; y < height - 60; y += 28) {
        page.drawLine({
          start: { x: 50, y },
          end: { x: width - 50, y },
          thickness: 0.6,
          color: rgb(0.85, 0.88, 0.94),
        });
      }
    } else if (paperStyle === 'grid') {
      const step = 20;
      for (let x = 50; x <= width - 50; x += step) {
        page.drawLine({
          start: { x, y: 50 },
          end: { x, y: height - 50 },
          thickness: 0.5,
          color: rgb(0.90, 0.92, 0.96),
        });
      }
      for (let y = 50; y <= height - 50; y += step) {
        page.drawLine({
          start: { x: 50, y },
          end: { x: width - 50, y },
          thickness: 0.5,
          color: rgb(0.90, 0.92, 0.96),
        });
      }
    }
  }

  return await pdfDoc.save();
}
