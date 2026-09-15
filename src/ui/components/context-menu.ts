/**
 * Themed annotation context menu shown on right-click.
 * Uses the same store/history pipeline as keyboard shortcuts so every action
 * remains undoable and visually consistent with the application theme.
 */

import { store } from '../../core/store';
import {
  history,
  BulkAddAnnotationsCommand,
  DeleteAnnotationsCommand,
  ReorderAnnotationsCommand
} from '../../core/history';
import {
  Annotation,
  Point
} from '../../core/types';
import {
  cloneAnnotation,
  getAnnotationSelectionBox,
  moveAnnotationsInZOrder,
  offsetAnnotation,
  selectionManager
} from '../../annotations/selection';
import { mergeBoundingBoxes } from '../../utils/geometry';
import { getIconSvg } from '../../utils/icons';
import { showToast } from './toast';

export interface AnnotationMenuTarget {
  pageIndex: number;
  point: Point;
  onRepaint: (pageIndex: number) => void;
}

interface MenuAction {
  kind: 'action';
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

interface MenuSeparator {
  kind: 'separator';
}

type MenuEntry = MenuAction | MenuSeparator;

function makeAnnotationId(): string {
  return `ann_${Math.random().toString(36).substring(2, 10)}`;
}

export class AnnotationContextMenu {
  private _root: HTMLDivElement | null = null;
  private _cleanup: (() => void) | null = null;

  constructor(private _parent: ParentNode = document.body) {}

  /**
   * Builds and shows a menu for a canvas right-click. Returns false when no
   * contextual action applies, allowing the browser menu to remain available.
   */
  public handleCanvasContextMenu(e: MouseEvent, target: AnnotationMenuTarget): boolean {
    const doc = store.activeDocument;
    if (!doc) return false;

    const annotations = doc.annotations[target.pageIndex] || [];
    const hit = selectionManager.findAnnotationAtPoint(target.point, annotations);

    if (hit && !store.selectedAnnotationIds.has(hit.id)) {
      store.setSuppressAutoPanels(true);
      store.selectAnnotation(hit.id);
      store.setSuppressAutoPanels(false);
    }

    const selectedOnPage = annotations.filter(a => store.selectedAnnotationIds.has(a.id));
    const selection = hit && selectedOnPage.length > 0 ? selectedOnPage : hit ? [hit] : [];
    const clipboard = store.clipboardAnnotations;

    if (selection.length === 0 && clipboard.length === 0) return false;

    const entries: MenuEntry[] = [];
    if (selection.length > 0) {
      entries.push(
        { kind: 'action', id: 'cut', label: 'Cut', icon: 'cut', run: () => this.cutSelection(target, selection) },
        { kind: 'action', id: 'copy', label: 'Copy', icon: 'copy', run: () => this.copySelection(selection) },
        { kind: 'action', id: 'duplicate', label: 'Duplicate', icon: 'plus', shortcut: 'Ctrl+D', run: () => this.duplicateSelection(target, selection) },
        { kind: 'separator' },
        { kind: 'action', id: 'front', label: 'Bring to front', icon: 'arrowUp', run: () => this.reorderSelection(target, selection, 'front') },
        { kind: 'action', id: 'back', label: 'Send to back', icon: 'arrowDown', run: () => this.reorderSelection(target, selection, 'back') },
        { kind: 'separator' },
        { kind: 'action', id: 'properties', label: 'Properties', icon: 'sliders', run: () => this.openProperties(selection) },
        { kind: 'action', id: 'delete', label: selection.length > 1 ? `Delete ${selection.length} items` : 'Delete', icon: 'trash', danger: true, shortcut: 'Del', run: () => this.deleteSelection(target, selection) }
      );
    }
    if (clipboard.length > 0) {
      if (entries.length > 0) entries.push({ kind: 'separator' });
      entries.push({
        kind: 'action',
        id: 'paste',
        label: `Paste ${clipboard.length > 1 ? `${clipboard.length} items` : 'item'}`,
        icon: 'clipboard',
        run: () => this.pasteClipboard(target)
      });
    }

    this.open(e.clientX, e.clientY, entries);
    return true;
  }

  public close(): void {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
    this._root?.remove();
    this._root = null;
  }

  private copySelection(selection: Annotation[]): void {
    store.setClipboard(selection.map(cloneAnnotation));
    showToast(selection.length > 1 ? `${selection.length} annotations copied` : 'Annotation copied', 'success');
  }

  private cutSelection(target: AnnotationMenuTarget, selection: Annotation[]): void {
    this.copySelection(selection);
    history.execute(new DeleteAnnotationsCommand(target.pageIndex, selection.map(cloneAnnotation)));
    store.clearSelection();
    target.onRepaint(target.pageIndex);
    showToast(selection.length > 1 ? `${selection.length} annotations cut` : 'Annotation cut', 'success');
  }

  private pasteClipboard(target: AnnotationMenuTarget): void {
    const source = store.clipboardAnnotations;
    if (source.length === 0) return;
    const sourceBox = mergeBoundingBoxes(source.map(getAnnotationSelectionBox));
    const dx = target.point.x - sourceBox.x;
    const dy = target.point.y - sourceBox.y;
    const now = Date.now();
    const clones = source.map(item => {
      const next = offsetAnnotation(item, dx, dy);
      next.id = makeAnnotationId();
      next.pageIndex = target.pageIndex;
      next.createdAt = now;
      next.updatedAt = now;
      return next;
    });

    history.execute(new BulkAddAnnotationsCommand(target.pageIndex, clones));
    store.setSelectedAnnotationIds(clones.map(a => a.id));
    target.onRepaint(target.pageIndex);
    showToast(clones.length > 1 ? `${clones.length} annotations pasted` : 'Annotation pasted', 'success');
  }

  private duplicateSelection(target: AnnotationMenuTarget, selection: Annotation[]): void {
    const now = Date.now();
    const clones = selection.map(item => {
      const next = offsetAnnotation(item, 12, 12);
      next.id = makeAnnotationId();
      next.pageIndex = target.pageIndex;
      next.createdAt = now;
      next.updatedAt = now;
      return next;
    });
    history.execute(new BulkAddAnnotationsCommand(
      target.pageIndex,
      clones,
      clones.length > 1 ? `Duplicate ${clones.length} annotations` : 'Duplicate annotation'
    ));
    store.setSelectedAnnotationIds(clones.map(a => a.id));
    target.onRepaint(target.pageIndex);
    showToast(clones.length > 1 ? `${clones.length} annotations duplicated` : 'Annotation duplicated', 'success');
  }

  private deleteSelection(target: AnnotationMenuTarget, selection: Annotation[]): void {
    history.execute(new DeleteAnnotationsCommand(target.pageIndex, selection.map(cloneAnnotation)));
    store.clearSelection();
    target.onRepaint(target.pageIndex);
    showToast(selection.length > 1 ? `${selection.length} annotations deleted` : 'Annotation deleted', 'success');
  }

  private reorderSelection(target: AnnotationMenuTarget, selection: Annotation[], position: 'front' | 'back'): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const before = [...(doc.annotations[target.pageIndex] || [])];
    const after = moveAnnotationsInZOrder(before, selection.map(a => a.id), position);
    if (after.map(a => a.id).join(',') === before.map(a => a.id).join(',')) return;
    history.execute(new ReorderAnnotationsCommand(
      target.pageIndex,
      before.map(cloneAnnotation),
      after.map(cloneAnnotation),
      position === 'front' ? 'Bring annotation(s) to front' : 'Send annotation(s) to back'
    ));
    target.onRepaint(target.pageIndex);
  }

  private openProperties(selection: Annotation[]): void {
    store.setSelectedAnnotationIds(selection.map(a => a.id));
    store.setPropertiesPanelOpen(true);
  }

  private open(x: number, y: number, entries: MenuEntry[]): void {
    this.close();
    const root = document.createElement('div');
    root.className = 'annotation-context-menu';
    root.setAttribute('role', 'menu');
    root.innerHTML = entries.map(entry => entry.kind === 'separator'
      ? '<div class="annotation-context-separator" role="separator"></div>'
      : `
        <button type="button" class="annotation-context-item${entry.danger ? ' is-danger' : ''}" data-menu-action="${entry.id}" role="menuitem">
          <span class="annotation-context-icon">${getIconSvg(entry.icon, 14)}</span>
          <span class="annotation-context-label">${entry.label}</span>
          ${entry.shortcut ? `<span class="annotation-context-shortcut">${entry.shortcut}</span>` : ''}
        </button>
      `).join('');
    this._parent.appendChild(root);
    this._root = root;

    root.querySelectorAll<HTMLButtonElement>('[data-menu-action]').forEach(button => {
      const entry = entries.find(item => item.kind === 'action' && item.id === button.dataset.menuAction) as MenuAction | undefined;
      if (!entry) return;
      button.addEventListener('click', () => {
        this.close();
        try {
          entry.run();
        } catch (err) {
          console.error('Context menu action failed:', err);
          showToast('That action could not be completed', 'error');
        }
      });
    });

    const position = () => {
      const width = root.offsetWidth || 220;
      const height = root.offsetHeight || entries.length * 34;
      const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };
    position();
    requestAnimationFrame(position);

    const onPointerDown = (event: PointerEvent) => {
      if (root.contains(event.target as Node)) return;
      this.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.close();
    };
    const onViewportChange = () => this.close();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.getElementById('document-scroll-container')?.addEventListener('scroll', onViewportChange, { passive: true });
    window.addEventListener('resize', onViewportChange);
    this._cleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.getElementById('document-scroll-container')?.removeEventListener('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
    };

    root.querySelector<HTMLButtonElement>('[data-menu-action]')?.focus({ preventScroll: true });
  }
}
