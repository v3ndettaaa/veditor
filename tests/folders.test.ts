import { describe, it, expect, beforeEach } from 'vitest';
import { getFolders, saveFolder, deleteFolder, resetFoldersCache, DEFAULT_FOLDERS } from '../src/io/storage';
import { PDFFolder } from '../src/core/types';

describe('PDF Folder Categorization System', () => {
  beforeEach(() => {
    resetFoldersCache();
  });

  it('returns default folders when no folders exist', async () => {
    const folders = await getFolders();
    expect(folders.length).toBeGreaterThanOrEqual(3);
    expect(folders.some(f => f.name.includes('Work'))).toBe(true);
    expect(folders.some(f => f.name.includes('Study'))).toBe(true);
    expect(folders.some(f => f.name.includes('Starred'))).toBe(true);
  });

  it('adds a new folder with custom color and icon', async () => {
    const newFolder: PDFFolder = {
      id: 'folder-custom-1',
      name: 'Financial Invoices',
      color: '#10b981',
      icon: 'tag',
      createdAt: Date.now()
    };

    await saveFolder(newFolder);
    const folders = await getFolders();
    const found = folders.find(f => f.id === 'folder-custom-1');
    expect(found).toBeDefined();
    expect(found?.name).toBe('Financial Invoices');
    expect(found?.color).toBe('#10b981');
    expect(found?.icon).toBe('tag');
  });

  it('updates an existing folder', async () => {
    const folder: PDFFolder = {
      id: 'folder-update-test',
      name: 'Old Name',
      color: '#3b82f6',
      icon: 'folder',
      createdAt: Date.now()
    };

    await saveFolder(folder);
    folder.name = 'Renamed Category';
    folder.color = '#ef4444';
    await saveFolder(folder);

    const folders = await getFolders();
    const updated = folders.find(f => f.id === 'folder-update-test');
    expect(updated?.name).toBe('Renamed Category');
    expect(updated?.color).toBe('#ef4444');
  });

  it('deletes a folder properly', async () => {
    const folder: PDFFolder = {
      id: 'folder-to-delete',
      name: 'Temporary',
      color: '#f59e0b',
      icon: 'star',
      createdAt: Date.now()
    };

    await saveFolder(folder);
    let folders = await getFolders();
    expect(folders.some(f => f.id === 'folder-to-delete')).toBe(true);

    await deleteFolder('folder-to-delete');
    folders = await getFolders();
    expect(folders.some(f => f.id === 'folder-to-delete')).toBe(false);
  });
});
