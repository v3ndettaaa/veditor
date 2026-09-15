import { describe, it, expect, beforeEach } from 'vitest';
import { history, AddAnnotationCommand, BulkAddAnnotationsCommand, DeleteAnnotationsCommand, ModifyAnnotationCommand, ReorderAnnotationsCommand, ReplaceAnnotationsCommand } from '../src/core/history';
import { store } from '../src/core/store';
import { PenAnnotation, DocumentSession } from '../src/core/types';

describe('Undo / Redo History System', () => {
  beforeEach(() => {
    store.closeAllDocumentTabs();
    history.clear();
    const mockDoc: DocumentSession = {
      id: 'test-doc',
      name: 'test.pdf',
      pageCount: 2,
      pages: [],
      bookmarks: [],
      annotations: { 0: [], 1: [] },
      layers: {},
      activePageIndex: 0,
      createdAt: Date.now(),
      lastModifiedAt: Date.now()
    };
    store.setActiveDocument(mockDoc);
  });

  it('executes AddAnnotationCommand and updates document', () => {
    const ann: PenAnnotation = {
      id: 'ann-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 10, height: 10 },
      points: [{ x: 0, y: 0, pressure: 0.5 }],
      color: '#000000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    history.execute(new AddAnnotationCommand(0, ann));
    expect(store.activeDocument?.annotations[0].length).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    // Undo
    history.undo();
    expect(store.activeDocument?.annotations[0].length).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    // Redo
    history.redo();
    expect(store.activeDocument?.annotations[0].length).toBe(1);
  });

  it('restores the raw stroke on the first undo after shape recognition', () => {
    const raw: PenAnnotation = {
      id: 'raw-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 10, height: 10 },
      points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 10, pressure: 0.5 }],
      color: '#4f46e5',
      strokeWidth: 3,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const shape = {
      id: 'shape-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'rectangle' as const,
      box: { x: 0, y: 0, width: 10, height: 10 },
      strokeColor: '#4f46e5',
      fillColor: 'transparent',
      strokeWidth: 3,
      outline: true,
      strokeStyle: 'solid' as const,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Recognition is a two-step transition: add raw, then replace with shape.
    history.execute(new AddAnnotationCommand(0, raw));
    history.execute(new ReplaceAnnotationsCommand(0, [raw], [shape]));
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['shape-1']);

    // Undo #1: the raw hand-drawn stroke comes back.
    history.undo();
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['raw-1']);

    // Undo #2: the raw stroke is removed.
    history.undo();
    expect(store.activeDocument?.annotations[0].length).toBe(0);
  });

  it('handles DeleteAnnotationsCommand with undo/redo', () => {
    const ann: PenAnnotation = {
      id: 'ann-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 10, height: 10 },
      points: [],
      color: '#000000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    store.activeDocument!.annotations[0] = [ann];
    expect(store.activeDocument?.annotations[0].length).toBe(1);

    history.execute(new DeleteAnnotationsCommand(0, [ann]));
    expect(store.activeDocument?.annotations[0].length).toBe(0);

    // Undo delete
    history.undo();
    expect(store.activeDocument?.annotations[0].length).toBe(1);
  });

  it('handles ReplaceAnnotationsCommand for pixel eraser', () => {
    const original: PenAnnotation = {
      id: 'ann-orig',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 50, height: 10 },
      points: [],
      color: '#000000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const sub1: PenAnnotation = { ...original, id: 'sub-1' };
    const sub2: PenAnnotation = { ...original, id: 'sub-2' };

    store.activeDocument!.annotations[0] = [original];
    history.execute(new ReplaceAnnotationsCommand(0, [original], [sub1, sub2]));

    expect(store.activeDocument?.annotations[0].length).toBe(2);
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['sub-1', 'sub-2']);

    // Undo replace
    history.undo();
    expect(store.activeDocument?.annotations[0].length).toBe(1);
    expect(store.activeDocument?.annotations[0][0].id).toBe('ann-orig');

    // Redo replace
    history.redo();
    expect(store.activeDocument?.annotations[0].length).toBe(2);
  });

  it('pastes multiple annotations as one undoable command', () => {
    const pasted: PenAnnotation[] = [1, 2].map(n => ({
      id: `paste-${n}`,
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: n * 10, y: n * 10, width: 10, height: 10 },
      points: [],
      color: '#000000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));

    history.execute(new BulkAddAnnotationsCommand(0, pasted));
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['paste-1', 'paste-2']);
    history.undo();
    expect(store.activeDocument?.annotations[0].length).toBe(0);
    history.redo();
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['paste-1', 'paste-2']);
  });

  it('reorders annotations and restores z-order on undo', () => {
    const make = (id: string): PenAnnotation => ({
      id,
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 10, height: 10 },
      points: [],
      color: '#000000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const before = [make('a'), make('b'), make('c')];
    store.activeDocument!.annotations[0] = before.map(a => ({ ...a }));
    const after = [before[1], before[2], before[0]];
    history.execute(new ReorderAnnotationsCommand(0, before, after));
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['b', 'c', 'a']);
    history.undo();
    expect(store.activeDocument?.annotations[0].map(a => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('maintains isolated undo/redo stacks when switching document tabs', () => {
    store.closeAllDocumentTabs();
    const docA: DocumentSession = {
      id: 'doc-A',
      name: 'DocA.pdf',
      pageCount: 1,
      pages: [],
      bookmarks: [],
      annotations: { 0: [] },
      layers: {},
      activePageIndex: 0,
      createdAt: Date.now(),
      lastModifiedAt: Date.now()
    };

    const docB: DocumentSession = {
      id: 'doc-B',
      name: 'DocB.pdf',
      pageCount: 1,
      pages: [],
      bookmarks: [],
      annotations: { 0: [] },
      layers: {},
      activePageIndex: 0,
      createdAt: Date.now(),
      lastModifiedAt: Date.now()
    };

    // Open Doc A and perform an edit
    store.setActiveDocument(docA);
    history.switchDocument('doc-A');
    const annA: PenAnnotation = {
      id: 'ann-A',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 0, y: 0, width: 10, height: 10 },
      points: [],
      color: '#ff0000',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    history.execute(new AddAnnotationCommand(0, annA));
    expect(history.canUndo).toBe(true);

    // Open Doc B in a new tab
    store.setActiveDocument(docB);
    history.switchDocument('doc-B');
    // Doc B history must be empty initially
    expect(history.canUndo).toBe(false);

    // Switch back to Doc A tab
    store.switchDocumentTab('doc-A');
    history.switchDocument('doc-A');
    // Doc A history must be fully preserved
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(docA.annotations[0].length).toBe(0);

    // Verify tabs list in store
    expect(store.documentTabs.length).toBe(2);
    expect(store.documentTabs[0].id).toBe('doc-A');
    expect(store.documentTabs[1].id).toBe('doc-B');

    // Close Doc A tab -> automatically switches to Doc B
    store.closeDocumentTab('doc-A');
    expect(store.documentTabs.length).toBe(1);
    expect(store.activeDocument?.id).toBe('doc-B');

    // Close remaining Doc B tab -> returns to landing empty state
    store.closeDocumentTab('doc-B');
    expect(store.documentTabs.length).toBe(0);
    expect(store.activeDocument).toBeNull();
  });
});
