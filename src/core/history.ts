/**
 * Command-based Undo/Redo History Manager
 * Supports infinite/configurable history stack with visual history inspector.
 */

import { Annotation } from './types';
import { store } from './store';

export interface Command {
  id: string;
  description: string;
  timestamp: number;
  execute(): void;
  undo(): void;
}

class HistoryManager {
  private _undoStack: Command[] = [];
  private _redoStack: Command[] = [];
  private _maxStackSize: number = 150;
  private _docHistories: Map<string, { undoStack: Command[]; redoStack: Command[] }> = new Map();
  private _currentDocId: string | null = null;

  public switchDocument(docId: string | null) {
    // Idempotent: this is invoked from store listeners, so notifying when the
    // active document has not actually changed would recurse indefinitely.
    if (this._currentDocId === docId) return;

    if (this._currentDocId) {
      this._docHistories.set(this._currentDocId, {
        undoStack: [...this._undoStack],
        redoStack: [...this._redoStack]
      });
    }

    this._currentDocId = docId;
    if (docId && this._docHistories.has(docId)) {
      const saved = this._docHistories.get(docId)!;
      this._undoStack = [...saved.undoStack];
      this._redoStack = [...saved.redoStack];
    } else {
      this._undoStack = [];
      this._redoStack = [];
    }
    store.notify();
  }

  public removeDocument(docId: string) {
    this._docHistories.delete(docId);
    if (this._currentDocId === docId) {
      this._undoStack = [];
      this._redoStack = [];
      this._currentDocId = null;
    }
  }

  public execute(command: Command) {
    command.execute();
    this._undoStack.push(command);
    this._redoStack = []; // Clear redo stack on new action
    if (this._undoStack.length > this._maxStackSize) {
      this._undoStack.shift();
    }
    if (this._currentDocId) {
      this._docHistories.set(this._currentDocId, {
        undoStack: [...this._undoStack],
        redoStack: [...this._redoStack]
      });
    }
    store.notify();
  }

  public undo(): boolean {
    const cmd = this._undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this._redoStack.push(cmd);
    if (this._currentDocId) {
      this._docHistories.set(this._currentDocId, {
        undoStack: [...this._undoStack],
        redoStack: [...this._redoStack]
      });
    }
    store.notify();
    return true;
  }

  public redo(): boolean {
    const cmd = this._redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this._undoStack.push(cmd);
    if (this._currentDocId) {
      this._docHistories.set(this._currentDocId, {
        undoStack: [...this._undoStack],
        redoStack: [...this._redoStack]
      });
    }
    store.notify();
    return true;
  }

  get canUndo(): boolean {
    return this._undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  get historyList(): Array<{ id: string; description: string; timestamp: number; isCurrent: boolean }> {
    return this._undoStack.map((cmd, index) => ({
      id: cmd.id,
      description: cmd.description,
      timestamp: cmd.timestamp,
      isCurrent: index === this._undoStack.length - 1
    }));
  }

  public clear() {
    this._undoStack = [];
    this._redoStack = [];
    this._docHistories.clear();
    this._currentDocId = null;
  }
}

export const history = new HistoryManager();

/**
 * Command Helpers for Annotation Operations
 */

export class AddAnnotationCommand implements Command {
  id: string = Math.random().toString(36).substring(2, 9);
  description: string;
  timestamp: number = Date.now();

  constructor(
    private pageIndex: number,
    private annotation: Annotation
  ) {
    this.description = `Add ${annotation.type} to page ${pageIndex + 1}`;
  }

  execute(): void {
    const doc = store.activeDocument;
    if (!doc) return;
    if (!doc.annotations[this.pageIndex]) {
      doc.annotations[this.pageIndex] = [];
    }
    doc.annotations[this.pageIndex].push(this.annotation);
    doc.lastModifiedAt = Date.now();
  }

  undo(): void {
    const doc = store.activeDocument;
    if (!doc || !doc.annotations[this.pageIndex]) return;
    doc.annotations[this.pageIndex] = doc.annotations[this.pageIndex].filter(
      a => a.id !== this.annotation.id
    );
    doc.lastModifiedAt = Date.now();
  }
}

export class DeleteAnnotationsCommand implements Command {
  id: string = Math.random().toString(36).substring(2, 9);
  description: string;
  timestamp: number = Date.now();

  constructor(
    private pageIndex: number,
    private deletedAnnotations: Annotation[]
  ) {
    this.description = `Delete ${deletedAnnotations.length} annotation(s) on page ${pageIndex + 1}`;
  }

  execute(): void {
    const doc = store.activeDocument;
    if (!doc || !doc.annotations[this.pageIndex]) return;
    const deletedIds = new Set(this.deletedAnnotations.map(a => a.id));
    doc.annotations[this.pageIndex] = doc.annotations[this.pageIndex].filter(
      a => !deletedIds.has(a.id)
    );
    doc.lastModifiedAt = Date.now();
  }

  undo(): void {
    const doc = store.activeDocument;
    if (!doc) return;
    if (!doc.annotations[this.pageIndex]) {
      doc.annotations[this.pageIndex] = [];
    }
    doc.annotations[this.pageIndex].push(...this.deletedAnnotations);
    doc.lastModifiedAt = Date.now();
  }
}

export class ReplaceAnnotationsCommand implements Command {
  id: string = Math.random().toString(36).substring(2, 9);
  description: string = 'Pixel/Segment Erase';
  timestamp: number = Date.now();

  constructor(
    private pageIndex: number,
    private toRemove: Annotation[],
    private toAdd: Annotation[]
  ) {}

  execute(): void {
    const doc = store.activeDocument;
    if (!doc) return;
    if (!doc.annotations[this.pageIndex]) doc.annotations[this.pageIndex] = [];
    const removeIds = new Set(this.toRemove.map(a => a.id));
    doc.annotations[this.pageIndex] = doc.annotations[this.pageIndex]
      .filter(a => !removeIds.has(a.id))
      .concat(this.toAdd);
    doc.lastModifiedAt = Date.now();
  }

  undo(): void {
    const doc = store.activeDocument;
    if (!doc || !doc.annotations[this.pageIndex]) return;
    const addedIds = new Set(this.toAdd.map(a => a.id));
    doc.annotations[this.pageIndex] = doc.annotations[this.pageIndex]
      .filter(a => !addedIds.has(a.id))
      .concat(this.toRemove);
    doc.lastModifiedAt = Date.now();
  }
}

export class ModifyAnnotationCommand implements Command {
  id: string = Math.random().toString(36).substring(2, 9);
  description: string;
  timestamp: number = Date.now();

  constructor(
    private pageIndex: number,
    private previousState: Annotation,
    private newState: Annotation
  ) {
    this.description = `Modify ${newState.type}`;
  }

  execute(): void {
    this.applyState(this.newState);
  }

  undo(): void {
    this.applyState(this.previousState);
  }

  private applyState(state: Annotation) {
    const doc = store.activeDocument;
    if (!doc || !doc.annotations[this.pageIndex]) return;
    const idx = doc.annotations[this.pageIndex].findIndex(a => a.id === state.id);
    if (idx !== -1) {
      doc.annotations[this.pageIndex][idx] = { ...state, updatedAt: Date.now() };
      doc.lastModifiedAt = Date.now();
    }
  }
}
