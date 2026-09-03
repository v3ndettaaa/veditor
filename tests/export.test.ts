import { describe, it, expect, beforeEach } from 'vitest';
import { dataExporter } from '../src/io/export-data';
import { store } from '../src/core/store';
import { DocumentSession, PenAnnotation } from '../src/core/types';

describe('Data Export & Import', () => {
  beforeEach(() => {
    const mockDoc: DocumentSession = {
      id: 'doc-export-test',
      name: 'annual_report.pdf',
      pageCount: 3,
      pages: [],
      bookmarks: [],
      annotations: {
        0: [
          {
            id: 'pen-1',
            pageIndex: 0,
            layerId: 'layer-default',
            type: 'pen',
            box: { x: 10, y: 10, width: 50, height: 50 },
            points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 60, y: 60, pressure: 0.8 }],
            color: '#ef4444',
            strokeWidth: 3,
            opacity: 1,
            createdAt: 1000,
            updatedAt: 1000
          } as PenAnnotation
        ]
      },
      layers: {},
      activePageIndex: 0,
      createdAt: Date.now(),
      lastModifiedAt: Date.now()
    };
    store.setActiveDocument(mockDoc);
  });

  it('exports annotations to valid JSON format', () => {
    const json = dataExporter.exportToJSON();
    const parsed = JSON.parse(json);

    expect(parsed.generator).toBe('veditor');
    expect(parsed.documentName).toBe('annual_report.pdf');
    expect(parsed.annotations[0].length).toBe(1);
    expect(parsed.annotations[0][0].type).toBe('pen');
  });

  it('imports annotations from valid JSON format', () => {
    const importedJson = JSON.stringify({
      version: '1.0.0',
      generator: 'veditor',
      annotations: {
        1: [
          {
            id: 'imported-pen-1',
            pageIndex: 1,
            layerId: 'layer-default',
            type: 'pen',
            box: { x: 5, y: 5, width: 20, height: 20 },
            points: [],
            color: '#10b981',
            strokeWidth: 2,
            opacity: 1,
            createdAt: 2000,
            updatedAt: 2000
          }
        ]
      }
    });

    const success = dataExporter.importFromJSON(importedJson);
    expect(success).toBe(true);
    expect(store.activeDocument?.annotations[1].length).toBe(1);
  });

  it('exports annotations to valid XFDF format with XML structure', () => {
    const xfdf = dataExporter.exportToXFDF();
    expect(xfdf).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xfdf).toContain('<xfdf xmlns="http://ns.adobe.com/xfdf/"');
    expect(xfdf).toContain('<ink page="0"');
    expect(xfdf).toContain('color="#ef4444"');
  });
});
