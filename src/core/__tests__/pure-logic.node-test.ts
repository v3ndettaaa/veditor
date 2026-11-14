import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAngleDegrees, computeMeasurementValue } from '../../annotations/tools/measure';
import { replaceFileExtension } from '../../ui/components/save-as-dialog';
import { buildAnnotationsMarkdownSummary, describeAnnotationItem } from '../annotations-summary';

describe('Pure Logic Verification (node:test)', () => {
  it('computes 3-point angle degrees and area measurements accurately', () => {
    assert.equal(Math.round(computeAngleDegrees({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 })), 90);
    const areaRes = computeMeasurementValue(
      'measure-area',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      'cm',
      0.1
    );
    // 100x100 = 10000 px^2 * (0.1)^2 = 100 cm^2
    assert.ok(Math.abs(areaRes.measuredValue - 100) < 1e-6);
    assert.equal(areaRes.label, '100.00 cm²');
  });

  it('replaces file extensions cleanly for all supported export formats', () => {
    assert.equal(replaceFileExtension('report.pdf', 'png'), 'report.png');
    assert.equal(replaceFileExtension('report.pdf', 'jpeg'), 'report.jpg');
    assert.equal(replaceFileExtension('report.pdf', 'xfdf'), 'report.xfdf');
    assert.equal(replaceFileExtension('report.pdf', 'json'), 'report.json');
  });

  it('formats Markdown summary with bookmarks and annotations', () => {
    const md = buildAnnotationsMarkdownSummary({
      name: 'Sample.pdf',
      pageCount: 2,
      userBookmarks: [{ id: 'b1', title: 'Intro', pageIndex: 0, createdAt: 1 }],
      annotations: {
        0: [
          {
            id: 'a1',
            pageIndex: 0,
            layerId: 'default',
            type: 'measure-angle',
            box: { x: 0, y: 0, width: 50, height: 50 },
            color: '#ef4444',
            opacity: 1,
            points: [{ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }],
            strokeWidth: 2,
            scaleRatio: 1,
            unit: 'cm',
            measuredValue: 90,
            label: '90.0°',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    }, 'en');
    assert.ok(md.includes('# Sample.pdf'));
    assert.ok(md.includes('**[Page 1] Intro**'));
    assert.ok(md.includes('Angle: 90.0°'));
    const info = describeAnnotationItem({
      id: 'a1',
      pageIndex: 0,
      layerId: 'default',
      type: 'measure-area',
      box: { x: 0, y: 0, width: 50, height: 50 },
      color: '#ef4444',
      opacity: 1,
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }],
      strokeWidth: 2,
      scaleRatio: 1,
      unit: 'cm',
      measuredValue: 12.5,
      label: '12.50 cm²',
      createdAt: 1,
      updatedAt: 1
    }, 'en');
    assert.equal(info.icon, 'measureArea');
  });
});
