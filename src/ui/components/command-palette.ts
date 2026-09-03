/**
 * Command Palette (Cmd + K / Ctrl + K)
 * Instant fuzzy action search for power users.
 */

import { store } from '../../core/store';
import { viewportManager } from '../../core/viewport';
import { pdfExporter } from '../../io/export-pdf';
import { dataExporter } from '../../io/export-data';
import { showToast } from './toast';
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

      { id: 'view-fit-width', title: 'Fit to Width', category: 'View', action: () => viewportManager.fitToWidth() },
      { id: 'view-fit-page', title: 'Fit to Page', category: 'View', action: () => viewportManager.fitToPage() },
      { id: 'view-zoom-in', title: 'Zoom In', category: 'View', shortcut: 'Ctrl +', action: () => store.setZoom(store.zoom * 1.2) },
      { id: 'view-zoom-out', title: 'Zoom Out', category: 'View', shortcut: 'Ctrl -', action: () => store.setZoom(store.zoom / 1.2) },
      { id: 'view-continuous', title: 'View: Continuous Vertical Scroll', category: 'View', action: () => store.setViewMode('continuous') },
      { id: 'view-single', title: 'View: Single Page Mode', category: 'View', action: () => store.setViewMode('single') },
      { id: 'view-twopage', title: 'View: Two-Page Facing Mode', category: 'View', action: () => store.setViewMode('two-page') },
      { id: 'view-focus', title: 'Toggle Focus Mode', category: 'View', action: () => store.toggleFocusMode() },

      {
        id: 'export-pdf',
        title: 'Export Annotated PDF Document',
        category: 'File',
        action: async () => {
          try {
            showToast('Generating PDF export...');
            const bytes = await pdfExporter.exportPDF({ flatten: true, dpi: 150, applyRedactions: true });
            await pdfExporter.saveToFile(bytes, store.activeDocument?.name || 'document.pdf');
            showToast(t('toast.exported'));
          } catch (e: any) {
            showToast(`Export error: ${e.message}`);
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
          showToast('Annotations JSON exported');
        }
      },

      {
        id: 'theme-toggle',
        title: `Switch Theme to ${store.appSettings.theme === 'dark' ? 'Light' : 'Dark'} Mode`,
        category: 'Settings',
        action: () => {
          const next = store.appSettings.theme === 'dark' ? 'light' : 'dark';
          store.updateAppSettings({ theme: next });
          document.body.className = `theme-${next}`;
        }
      },
      {
        id: 'lang-toggle',
        title: `Switch Language to ${store.appSettings.language === 'en' ? 'فارسی (Persian)' : 'English'}`,
        category: 'Settings',
        action: () => {
          const next = store.appSettings.language === 'en' ? 'fa' : 'en';
          store.updateAppSettings({ language: next });
          document.documentElement.setAttribute('dir', next === 'fa' ? 'rtl' : 'ltr');
          document.documentElement.setAttribute('lang', next);
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
        <div class="modal-dialog" style="max-width:560px;">
          <div style="padding:14px 16px; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; gap:10px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="palette-input" placeholder="Type a command or search tools..." autofocus style="
              flex:1; background:transparent; border:none; color:var(--text-primary); font-size:14px; outline:none; font-family:inherit;
            ">
            <span style="font-size:11px; color:var(--text-muted); background:var(--bg-surface-elevated); padding:2px 6px; border-radius:4px;">ESC</span>
          </div>

          <div id="palette-list" style="max-height:360px; overflow-y:auto; padding:8px;"></div>
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
        list.innerHTML = `<div style="padding:24px; text-align:center; font-size:13px; color:var(--text-muted);">No commands found</div>`;
        return;
      }

      list.innerHTML = this._filteredCommands.map((c, idx) => `
        <div class="palette-item" data-idx="${idx}" style="
          display:flex; align-items:center; justify-content:space-between; padding:9px 12px; border-radius:6px;
          cursor:pointer; font-size:13px; background:${idx === this._selectedIndex ? 'var(--bg-surface-active)' : 'transparent'};
          color:${idx === this._selectedIndex ? 'var(--text-primary)' : 'var(--text-secondary)'};
        ">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:10px; text-transform:uppercase; color:var(--text-muted); font-weight:600;">${c.category}</span>
            <span style="font-weight:500;">${c.title}</span>
          </div>
          ${c.shortcut ? `<span style="font-size:11px; background:var(--bg-surface-hover); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-family:monospace;">${c.shortcut}</span>` : ''}
        </div>
      `).join('');

      list.querySelectorAll('.palette-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.getAttribute('data-idx') || '0', 10);
          this.executeCommand(this._filteredCommands[idx]);
        });
      });
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
