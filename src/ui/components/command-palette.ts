/**
 * Command Palette (Cmd + K / Ctrl + K)
 * Instant fuzzy action search for power users.
 */

import { store } from '../../core/store';
import { viewportManager } from '../../core/viewport';
import { pdfExporter } from '../../io/export-pdf';
import { saveActiveDocument, saveActiveDocumentAs } from '../../io/save';
import { dataExporter } from '../../io/export-data';
import { showToast } from './toast';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { t } from '../i18n';

interface PaletteCommand {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export class CommandPaletteComponent {
  private _container: HTMLElement;
  private _selectedIndex: number = 0;
  private _filteredCommands: PaletteCommand[] = [];

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.setupGlobalShortcut();
  }

  private setupGlobalShortcut() {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.setCommandPaletteOpen(!store.commandPaletteOpen);
      } else if (e.key === 'Escape' && store.commandPaletteOpen) {
        store.setCommandPaletteOpen(false);
      }
    });
  }

  private getAllCommands(): PaletteCommand[] {
    return [
      { id: 'tool-select', title: 'Select & Transform Tool', category: 'Tools', shortcut: 'V', action: () => store.setActiveTool('select') },
      { id: 'tool-hand', title: 'Hand Tool (drag to pan)', category: 'Tools', shortcut: 'Space', action: () => store.setActiveTool('hand') },
      { id: 'tool-zoom-lens', title: 'Zoom to Selection Tool', category: 'Tools', action: () => store.setActiveTool('zoom-lens') },
      { id: 'tool-pen', title: 'Freehand Pen Tool', category: 'Tools', shortcut: 'P', action: () => store.setActiveTool('pen') },
      { id: 'tool-highlighter', title: 'Highlighter Tool', category: 'Tools', shortcut: 'H', action: () => store.setActiveTool('highlighter') },
      { id: 'tool-eraser', title: 'Eraser Tool', category: 'Tools', shortcut: 'E', action: () => store.setActiveTool('eraser') },
      { id: 'tool-rect', title: 'Rectangle Shape Tool', category: 'Tools', shortcut: 'R', action: () => store.setActiveTool('rectangle') },
      { id: 'tool-ellipse', title: 'Ellipse Shape Tool', category: 'Tools', shortcut: 'O', action: () => store.setActiveTool('ellipse') },
      { id: 'tool-line', title: 'Line Tool', category: 'Tools', shortcut: 'L', action: () => store.setActiveTool('line') },
      { id: 'tool-arrow', title: 'Arrow Tool', category: 'Tools', shortcut: 'A', action: () => store.setActiveTool('arrow') },
      { id: 'tool-text', title: 'Text Box Tool', category: 'Tools', shortcut: 'T', action: () => store.setActiveTool('text') },
      { id: 'tool-measure', title: 'Measure Distance Tool', category: 'Tools', action: () => store.setActiveTool('measure-distance') },
      { id: 'tool-laser', title: 'Presentation Laser Pointer', category: 'Tools', shortcut: 'Z', action: () => store.setActiveTool('laser') },
      { id: 'tool-redaction', title: 'Redaction Tool', category: 'Tools', shortcut: 'X', action: () => store.setActiveTool('redaction') },

      { id: 'view-customize-toolbar', title: 'Customize toolbar layout', category: 'View', action: () => { store.setSettingsModalOpen(true); store.settingsTabRequest = 'toolbar'; } },
      { id: 'view-fit-width', title: 'Fit to Width', category: 'View', action: () => viewportManager.fitToWidth() },
      { id: 'view-fit-page', title: 'Fit to Page', category: 'View', action: () => viewportManager.fitToPage() },
      { id: 'view-zoom-in', title: 'Zoom In', category: 'View', shortcut: 'Ctrl +', action: () => store.setZoom(store.zoom * 1.2) },
      { id: 'view-zoom-out', title: 'Zoom Out', category: 'View', shortcut: 'Ctrl -', action: () => store.setZoom(store.zoom / 1.2) },
      { id: 'view-continuous', title: 'View: Continuous Vertical Scroll', category: 'View', action: () => store.setViewMode('continuous') },
      { id: 'view-single', title: 'View: Single Page Mode', category: 'View', action: () => store.setViewMode('single') },
      { id: 'view-twopage', title: 'View: Two-Page Facing Mode', category: 'View', action: () => store.setViewMode('two-page') },
      { id: 'view-focus', title: 'Toggle Focus Mode', category: 'View', action: () => store.toggleFocusMode() },

      {
        id: 'file-save',
        title: 'Save (write into this PDF)',
        category: 'File',
        shortcut: 'Ctrl+S',
        action: () => { void saveActiveDocument(); }
      },
      {
        id: 'file-save-as',
        title: 'Save As (new file/location)',
        category: 'File',
        shortcut: 'Ctrl+Shift+S',
        action: () => { void saveActiveDocumentAs(); }
      },
      {
        id: 'export-pdf',
        title: 'Export Annotated PDF Document',
        category: 'File',
        action: async () => {
          try {
            showToast('Generating PDF export…', 'progress');
            const bytes = await pdfExporter.exportPDF({ flatten: true, dpi: 150, applyRedactions: true });
            await pdfExporter.saveToFile(bytes, store.activeDocument?.name || 'document.pdf');
            showToast(t('toast.exported'), 'success');
          } catch (e: any) {
            showToast(`Export error: ${e.message}`, 'error');
          }
        }
      },
      {
        id: 'export-json',
        title: 'Export Annotations to JSON',
        category: 'File',
        action: () => {
          const json = dataExporter.exportToJSON();
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${store.activeDocument?.name || 'document'}-annotations.json`;
          a.click();
          showToast('Annotations JSON exported', 'success');
        }
      },

      {
        id: 'theme-toggle',
        title: `Switch Theme to ${store.appSettings.theme === 'dark' ? 'Light' : 'Dark'} Mode`,
        category: 'Settings',
        action: () => {
          store.updateAppSettings({ theme: store.appSettings.theme === 'dark' ? 'light' : 'dark' });
        }
      },
      {
        id: 'lang-toggle',
        title: `Switch Language to ${store.appSettings.language === 'en' ? 'فارسی (Persian)' : 'English'}`,
        category: 'Settings',
        action: () => {
          store.updateAppSettings({ language: store.appSettings.language === 'en' ? 'fa' : 'en' });
        }
      },
      { id: 'shortcuts-modal', title: 'Keyboard Shortcuts Reference', category: 'Help', shortcut: '?', action: () => store.setShortcutsModalOpen(true) },
      { id: 'settings-modal', title: 'Open Settings', category: 'Help', action: () => store.setSettingsModalOpen(true) }
    ];
  }

  public render(): void {
    if (!store.commandPaletteOpen) {
      this._container.innerHTML = '';
      return;
    }

    const all = this.getAllCommands();
    this._filteredCommands = all;
    this._selectedIndex = 0;

    this._container.innerHTML = `
      <div class="modal-overlay" id="palette-overlay">
        <div class="modal-dialog palette-dialog" role="dialog" aria-modal="true" aria-label="Command palette">
          <div class="palette-search">
            <span class="palette-search-icon">${getIconSvg('search', 17)}</span>
            <input type="text" id="palette-input" class="palette-input" autofocus
                   placeholder="Search tools, views and commands…" aria-label="Search commands">
            <span class="kbd">Esc</span>
          </div>

          <div id="palette-list" class="palette-list" role="listbox"></div>

          <div class="palette-footer">
            <span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span>
            <span><span class="kbd">↵</span> run</span>
          </div>
        </div>
      </div>
    `;

    const input = this._container.querySelector('#palette-input') as HTMLInputElement;
    const list = this._container.querySelector('#palette-list') as HTMLElement;
    const overlay = this._container.querySelector('#palette-overlay') as HTMLElement;

    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setCommandPaletteOpen(false);
    });

    const updateList = () => {
      const query = input.value.toLowerCase().trim();
      this._filteredCommands = all.filter(c =>
        c.title.toLowerCase().includes(query) || c.category.toLowerCase().includes(query)
      );

      if (this._filteredCommands.length === 0) {
        list.innerHTML = `<div class="empty-note">No commands match “${escapeHtml(input.value.trim())}”</div>`;
        return;
      }

      list.innerHTML = this._filteredCommands.map((c, idx) => `
        <div class="palette-item ${idx === this._selectedIndex ? 'is-selected' : ''}" data-idx="${idx}"
             role="option" aria-selected="${idx === this._selectedIndex}">
          <span class="palette-item-label">
            <span class="palette-item-category">${escapeHtml(c.category)}</span>
            <span class="palette-item-title">${escapeHtml(c.title)}</span>
          </span>
          ${c.shortcut ? `<span class="kbd">${escapeHtml(c.shortcut)}</span>` : ''}
        </div>
      `).join('');

      list.querySelectorAll('.palette-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.getAttribute('data-idx') || '0', 10);
          this.executeCommand(this._filteredCommands[idx]);
        });
      });

      // Keep the keyboard-selected row inside the scroll viewport.
      list.querySelector('.palette-item.is-selected')?.scrollIntoView({ block: 'nearest' });
    };

    input?.addEventListener('input', () => {
      this._selectedIndex = 0;
      updateList();
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex + 1) % this._filteredCommands.length;
        updateList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex - 1 + this._filteredCommands.length) % this._filteredCommands.length;
        updateList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this._filteredCommands[this._selectedIndex]) {
          this.executeCommand(this._filteredCommands[this._selectedIndex]);
        }
      }
    });

    updateList();
    setTimeout(() => input?.focus(), 50);
  }

  private executeCommand(cmd: PaletteCommand) {
    store.setCommandPaletteOpen(false);
    cmd.action();
  }
}
