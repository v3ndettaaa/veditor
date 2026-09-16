/**
 * Floating Context Menu for File Explorer Nodes (PIPE_6)
 * Actions: Reveal (native shell/explorer), Rename (fs_rename), Delete (fs_remove).
 * Dismisses on outside pointerdown or Escape keypress.
 * Prevents XSS by escaping file names before DOM insertion.
 */

import { nativeRenameFile, nativeRemoveFile, FileNode } from '../../io/native-fs';
import { showToast } from './toast';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export class FSContextMenu {
  private element: HTMLElement | null = null;
  private activeDismissListener: ((e: PointerEvent) => void) | null = null;
  private activeKeydownListener: ((e: KeyboardEvent) => void) | null = null;

  public show(
    event: MouseEvent,
    node: FileNode,
    options: {
      onReloadNeeded?: () => void;
      onOpenFile?: (path: string) => void;
    } = {}
  ): void {
    event.preventDefault();
    event.stopPropagation();

    this.dismiss();

    const menu = document.createElement('div');
    menu.className = 'context-menu fs-context-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex = '99999';

    const safeName = escapeHtml(node.name);

    menu.innerHTML = `
      <div class="menu-item menu-header-title"><strong>${safeName}</strong></div>
      <div class="menu-divider"></div>
      <button class="menu-item" id="ctx-action-open">Open</button>
      <button class="menu-item" id="ctx-action-reveal">Reveal in Explorer</button>
      <button class="menu-item" id="ctx-action-rename">Rename</button>
      <button class="menu-item danger" id="ctx-action-delete">Delete</button>
    `;

    document.body.appendChild(menu);
    this.element = menu;

    // Viewport bounds positioning
    const { clientX: x, clientY: y } = event;
    const menuWidth = 180;
    const menuHeight = 160;
    const posX = x + menuWidth > window.innerWidth ? Math.max(10, window.innerWidth - menuWidth - 10) : x;
    const posY = y + menuHeight > window.innerHeight ? Math.max(10, window.innerHeight - menuHeight - 10) : y;

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;

    // Action bindings
    menu.querySelector('#ctx-action-open')?.addEventListener('click', () => {
      this.dismiss();
      if (!node.isDirectory && options.onOpenFile) {
        options.onOpenFile(node.path);
      }
    });

    menu.querySelector('#ctx-action-reveal')?.addEventListener('click', async () => {
      this.dismiss();
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('plugin:shell|open', { path: node.path });
      } catch (err) {
        showToast(`Could not reveal path: ${node.path}`, 'info');
      }
    });

    menu.querySelector('#ctx-action-rename')?.addEventListener('click', async () => {
      this.dismiss();
      const newName = window.prompt('Enter new filename:', node.name);
      if (!newName || newName === node.name) return;

      const parentDir = node.path.substring(0, Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\')));
      const newPath = `${parentDir}/${newName}`;

      const renamed = await nativeRenameFile(node.path, newPath);
      if (renamed) {
        showToast(`Renamed to ${newName}`, 'success');
        if (options.onReloadNeeded) options.onReloadNeeded();
      } else {
        showToast('Could not rename file', 'error');
      }
    });

    menu.querySelector('#ctx-action-delete')?.addEventListener('click', async () => {
      this.dismiss();
      const confirmed = window.confirm(`Are you sure you want to delete "${node.name}"?`);
      if (!confirmed) return;

      const removed = await nativeRemoveFile(node.path);
      if (removed) {
        showToast(`Deleted ${node.name}`, 'success');
        if (options.onReloadNeeded) options.onReloadNeeded();
      } else {
        showToast('Could not delete file', 'error');
      }
    });

    // Dismiss listeners
    this.activeDismissListener = (e: PointerEvent) => {
      if (this.element && !this.element.contains(e.target as Node)) {
        this.dismiss();
      }
    };
    this.activeKeydownListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.dismiss();
      }
    };

    window.addEventListener('pointerdown', this.activeDismissListener, { capture: true });
    window.addEventListener('keydown', this.activeKeydownListener, { capture: true });
  }

  public dismiss(): void {
    if (this.activeDismissListener) {
      window.removeEventListener('pointerdown', this.activeDismissListener, { capture: true });
      this.activeDismissListener = null;
    }
    if (this.activeKeydownListener) {
      window.removeEventListener('keydown', this.activeKeydownListener, { capture: true });
      this.activeKeydownListener = null;
    }
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
      this.element = null;
    }
  }
}

export const fsContextMenu = new FSContextMenu();
