/**
 * Built-in Sample PDF Generator
 * Provides immediate instant-test capability with interactive internal PDF
 * links, cross-references, external URI links, and PDF Outline bookmarks.
 */

import { PDFDocument, PDFName, PDFNumber, PDFNull, PDFString, rgb, StandardFonts, PDFPage } from 'pdf-lib';

function addInternalLinkAnnotation(
  pdfDoc: PDFDocument,
  sourcePage: PDFPage,
  rect: [number, number, number, number],
  targetPage: PDFPage,
  targetTopY = 760
): void {
  const linkAnnot = pdfDoc.context.register(
    pdfDoc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Link'),
      Rect: rect,
      Border: [0, 0, 0],
      Dest: [targetPage.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(targetTopY), PDFNull],
    })
  );
  appendAnnotToPage(pdfDoc, sourcePage, linkAnnot);
}

function addExternalUriAnnotation(
  pdfDoc: PDFDocument,
  sourcePage: PDFPage,
  rect: [number, number, number, number],
  uri: string
): void {
  const linkAnnot = pdfDoc.context.register(
    pdfDoc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Link'),
      Rect: rect,
      Border: [0, 0, 0],
      A: pdfDoc.context.obj({
        Type: PDFName.of('Action'),
        S: PDFName.of('URI'),
        URI: PDFString.of(uri),
      }),
    })
  );
  appendAnnotToPage(pdfDoc, sourcePage, linkAnnot);
}

function appendAnnotToPage(pdfDoc: PDFDocument, page: PDFPage, annotRef: any): void {
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([annotRef]));
  }
}

function attachSampleOutline(pdfDoc: PDFDocument, pages: PDFPage[]): void {
  if (pages.length < 3) return;
  const outlineRef = pdfDoc.context.nextRef();
  const item1Ref = pdfDoc.context.nextRef();
  const item2Ref = pdfDoc.context.nextRef();
  const item3Ref = pdfDoc.context.nextRef();

  pdfDoc.context.assign(
    item1Ref,
    pdfDoc.context.obj({
      Title: PDFString.of('1. Welcome & Interactive Links'),
      Parent: outlineRef,
      Next: item2Ref,
      Dest: [pages[0].ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(792), PDFNull],
    })
  );

  pdfDoc.context.assign(
    item2Ref,
    pdfDoc.context.obj({
      Title: PDFString.of('2. Meeting & Study Notes'),
      Parent: outlineRef,
      Prev: item1Ref,
      Next: item3Ref,
      Dest: [pages[1].ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(792), PDFNull],
    })
  );

  pdfDoc.context.assign(
    item3Ref,
    pdfDoc.context.obj({
      Title: PDFString.of('3. Reference Appendix & Shortcuts'),
      Parent: outlineRef,
      Prev: item2Ref,
      Dest: [pages[2].ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(792), PDFNull],
    })
  );

  pdfDoc.context.assign(
    outlineRef,
    pdfDoc.context.obj({
      Type: PDFName.of('Outlines'),
      First: item1Ref,
      Last: item3Ref,
      Count: PDFNumber.of(3),
    })
  );

  pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRef);
}

export async function generateSamplePDF(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Create 3 US Letter pages upfront so cross-page link references can target any page
  const page1 = pdfDoc.addPage([612, 792]);
  const page2 = pdfDoc.addPage([612, 792]);
  const page3 = pdfDoc.addPage([612, 792]);
  const { width, height } = page1.getSize();

  // =========================================================================
  // Page 1: Welcome, Interactive Table of Contents & Drawing Sandbox
  // =========================================================================
  page1.drawRectangle({
    x: 40,
    y: height - 115,
    width: width - 80,
    height: 68,
    color: rgb(0.08, 0.08, 0.12),
    borderColor: rgb(0.23, 0.35, 0.95),
    borderWidth: 1.5,
  });

  page1.drawText('Welcome to veditor', {
    x: 58,
    y: height - 82,
    size: 21,
    font: fontBold,
    color: rgb(0.95, 0.95, 1.0),
  });

  page1.drawText('Professional, Private & High-Performance PDF Workspace', {
    x: 58,
    y: height - 102,
    size: 10.5,
    font,
    color: rgb(0.65, 0.70, 0.85),
  });

  // Interactive Table of Contents & Cross-References Card
  const tocBoxY = height - 252;
  page1.drawRectangle({
    x: 40,
    y: tocBoxY,
    width: width - 80,
    height: 122,
    color: rgb(0.95, 0.97, 1.0),
    borderColor: rgb(0.58, 0.68, 0.95),
    borderWidth: 1,
  });

  page1.drawText('Interactive Contents & Links (Click with Select or Hand Tool):', {
    x: 52,
    y: tocBoxY + 98,
    size: 11.5,
    font: fontBold,
    color: rgb(0.14, 0.22, 0.48),
  });

  // Link 1 -> Page 2 (Meeting & Study Notes)
  const link1Y = tocBoxY + 72;
  page1.drawRectangle({
    x: 52,
    y: link1Y - 5,
    width: 245,
    height: 22,
    color: rgb(0.88, 0.92, 1.0),
    borderColor: rgb(0.35, 0.50, 0.95),
    borderWidth: 0.8,
  });
  page1.drawText('-> Go to Section 2: Meeting & Study Notes (Page 2)', {
    x: 60,
    y: link1Y + 2,
    size: 9.5,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page1, [52, link1Y - 5, 297, link1Y + 17], page2, 760);

  // Link 2 -> Page 3 (Reference Appendix & Shortcuts)
  const link2Y = tocBoxY + 42;
  page1.drawRectangle({
    x: 52,
    y: link2Y - 5,
    width: 245,
    height: 22,
    color: rgb(0.88, 0.92, 1.0),
    borderColor: rgb(0.35, 0.50, 0.95),
    borderWidth: 0.8,
  });
  page1.drawText('-> Go to Section 3: Shortcuts & Citations (Page 3)', {
    x: 60,
    y: link2Y + 2,
    size: 9.5,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page1, [52, link2Y - 5, 297, link2Y + 17], page3, 760);

  // Link 3 -> Page 3 Footnote [Ref 2] deep anchor
  page1.drawRectangle({
    x: 310,
    y: link1Y - 5,
    width: 248,
    height: 22,
    color: rgb(0.90, 0.95, 0.98),
    borderColor: rgb(0.30, 0.58, 0.78),
    borderWidth: 0.8,
  });
  page1.drawText('-> Citation [1]: Vector Ink Architecture (Page 3)', {
    x: 318,
    y: link1Y + 2,
    size: 9.5,
    font: fontBold,
    color: rgb(0.12, 0.40, 0.65),
  });
  addInternalLinkAnnotation(pdfDoc, page1, [310, link1Y - 5, 558, link1Y + 17], page3, 420);

  // Link 4 -> External GitHub Repository URI
  page1.drawRectangle({
    x: 310,
    y: link2Y - 5,
    width: 248,
    height: 22,
    color: rgb(0.92, 0.90, 0.99),
    borderColor: rgb(0.48, 0.38, 0.88),
    borderWidth: 0.8,
  });
  page1.drawText('-> External Link: github.com/v3ndettaaa/veditor', {
    x: 318,
    y: link2Y + 2,
    size: 9.5,
    font: fontBold,
    color: rgb(0.35, 0.22, 0.75),
  });
  addExternalUriAnnotation(
    pdfDoc,
    page1,
    [310, link2Y - 5, 558, link2Y + 17],
    'https://github.com/v3ndettaaa/veditor'
  );

  page1.drawText(
    'Tip: After clicking any internal link, use the floating "Back to Page 1" pill (or Alt + Left Arrow) to jump back!',
    {
      x: 52,
      y: tocBoxY + 12,
      size: 8.8,
      font,
      color: rgb(0.32, 0.36, 0.48),
    }
  );

  // Feature Highlights List
  page1.drawText('Key Capabilities to Explore:', {
    x: 45,
    y: tocBoxY - 26,
    size: 13,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.20),
  });

  const features = [
    '• Pen & Highlighter: Smooth vector ink with realistic pressure curves (see Citation [1] on Page 3)',
    '• Merge, Extract & Crop: Drag & drop PDFs into the sidebar or crop page margins non-destructively',
    '• Interactive PDF Links: Click TOC entries & footnotes and jump back instantly with Alt + Left Arrow',
    '• Keyboard-First Workflow: Press "P" for pen, "H" for highlighter, "E" for eraser, "Ctrl+K" for commands',
  ];

  let y = tocBoxY - 48;
  for (const feat of features) {
    page1.drawText(feat, {
      x: 55,
      y,
      size: 10,
      font,
      color: rgb(0.25, 0.25, 0.30),
    });
    y -= 21;
  }

  // Drawing Canvas Area
  page1.drawRectangle({
    x: 45,
    y: 52,
    width: width - 90,
    height: y - 62,
    color: rgb(0.98, 0.98, 1.0),
    borderColor: rgb(0.80, 0.82, 0.90),
    borderWidth: 1,
  });

  page1.drawText('Interactive Drawing Sandbox (Test Your Pen, Shapes & Stamps Here):', {
    x: 55,
    y: y - 30,
    size: 10,
    font: fontBold,
    color: rgb(0.40, 0.45, 0.60),
  });

  // =========================================================================
  // Page 2: Meeting & Study Notes + Cross-Page References
  // =========================================================================
  page2.drawText('2. Meeting & Study Notes', {
    x: 50,
    y: height - 60,
    size: 18,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.15),
  });

  // Top navigation links on Page 2
  page2.drawRectangle({
    x: 340,
    y: height - 66,
    width: 105,
    height: 22,
    color: rgb(0.90, 0.93, 1.0),
    borderColor: rgb(0.35, 0.50, 0.95),
    borderWidth: 0.8,
  });
  page2.drawText('<- Back to Page 1', {
    x: 350,
    y: height - 58,
    size: 9.5,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page2, [340, height - 66, 445, height - 44], page1, 760);

  page2.drawRectangle({
    x: 452,
    y: height - 66,
    width: 110,
    height: 22,
    color: rgb(0.90, 0.93, 1.0),
    borderColor: rgb(0.35, 0.50, 0.95),
    borderWidth: 0.8,
  });
  page2.drawText('Next: Page 3 ->', {
    x: 468,
    y: height - 58,
    size: 9.5,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page2, [452, height - 66, 562, height - 44], page3, 760);

  page2.drawText('Date: ____________________       Topic: ____________________________________', {
    x: 50,
    y: height - 92,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.45),
  });

  // Ruled lines for notes
  for (let lineY = height - 125; lineY >= 90; lineY -= 26) {
    page2.drawLine({
      start: { x: 50, y: lineY },
      end: { x: width - 50, y: lineY },
      thickness: 0.75,
      color: rgb(0.85, 0.88, 0.92),
    });
  }

  // Footer reference link on Page 2
  page2.drawText('See Reference Appendix & Keyboard Shortcuts on Page 3 ->', {
    x: 50,
    y: 55,
    size: 10,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page2, [48, 48, 370, 70], page3, 760);

  // =========================================================================
  // Page 3: Reference Appendix, Citations & Keyboard Shortcuts
  // =========================================================================
  page3.drawText('3. Reference Appendix & Shortcuts', {
    x: 50,
    y: height - 60,
    size: 18,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.15),
  });

  // Return to Page 1 button on Page 3
  page3.drawRectangle({
    x: 430,
    y: height - 66,
    width: 132,
    height: 22,
    color: rgb(0.90, 0.93, 1.0),
    borderColor: rgb(0.35, 0.50, 0.95),
    borderWidth: 0.8,
  });
  page3.drawText('<- Return to Page 1', {
    x: 442,
    y: height - 58,
    size: 9.5,
    font: fontBold,
    color: rgb(0.16, 0.32, 0.82),
  });
  addInternalLinkAnnotation(pdfDoc, page3, [430, height - 66, 562, height - 44], page1, 760);

  page3.drawText('Essential Keyboard Shortcuts:', {
    x: 50,
    y: height - 105,
    size: 13,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.22),
  });

  const shortcuts = [
    ['V / H', 'Select Tool / Hand Pan Tool (enables clicking PDF links)'],
    ['P / M / E', 'Pen Tool / Highlighter / Eraser'],
    ['Alt + Left Arrow', 'Jump back to previous scroll position after clicking a PDF link'],
    ['Ctrl + K', 'Open Command Palette (Crop, Merge, Extract, Export, Themes)'],
    ['Ctrl + Z / Ctrl + Y', 'Undo / Redo annotations and page operations (Merge, Crop, Rotate)'],
  ];

  let sy = height - 135;
  for (const [keys, desc] of shortcuts) {
    page3.drawRectangle({
      x: 50,
      y: sy - 6,
      width: 125,
      height: 22,
      color: rgb(0.93, 0.94, 0.97),
      borderColor: rgb(0.78, 0.81, 0.88),
      borderWidth: 0.8,
    });
    page3.drawText(keys, {
      x: 58,
      y: sy + 1,
      size: 9.5,
      font: fontBold,
      color: rgb(0.18, 0.20, 0.28),
    });
    page3.drawText(desc, {
      x: 190,
      y: sy + 1,
      size: 10,
      font,
      color: rgb(0.25, 0.27, 0.33),
    });
    sy -= 30;
  }

  // Citation [1] target box at Y ~ 400 (targeted by Page 1's deep citation link)
  const citeY = 330;
  page3.drawRectangle({
    x: 50,
    y: citeY,
    width: width - 100,
    height: 95,
    color: rgb(0.95, 0.98, 1.0),
    borderColor: rgb(0.30, 0.58, 0.78),
    borderWidth: 1,
  });

  page3.drawText('Citation [1]: Vector Ink & Non-Destructive Page Operations', {
    x: 62,
    y: citeY + 72,
    size: 11.5,
    font: fontBold,
    color: rgb(0.12, 0.36, 0.58),
  });

  page3.drawText(
    'All pen strokes are fitted to smooth centripetal Catmull-Rom / cubic Bezier splines and saved',
    { x: 62, y: citeY + 50, size: 9.5, font, color: rgb(0.22, 0.26, 0.32) }
  );
  page3.drawText(
    'natively inside standard PDF /Ink and /FreeText dictionaries. Cropping pages updates the PDF',
    { x: 62, y: citeY + 34, size: 9.5, font, color: rgb(0.22, 0.26, 0.32) }
  );
  page3.drawText(
    'MediaBox/CropBox non-destructively so original margins can be restored at any time.',
    { x: 62, y: citeY + 18, size: 9.5, font, color: rgb(0.22, 0.26, 0.32) }
  );

  // Attach PDF Outline bookmarks so the Sidebar Outline tab is populated too
  attachSampleOutline(pdfDoc, [page1, page2, page3]);

  return await pdfDoc.save();
}
