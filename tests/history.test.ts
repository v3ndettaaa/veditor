import { describe, it, expect, beforeEach } from 'vitest';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ModifyAnnotationCommand, ReplaceAnnotationsCommand } from '../src/core/history';
import { store } from '../src/core/store';
import { PenAnnotation, DocumentSession } from '../src/core/types';

describe('Undo / Redo History System', () => {
  beforeEach(() => {
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
});
