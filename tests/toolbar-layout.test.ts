import { describe, it, expect } from 'vitest';
import { store } from '../src/core/store';
import { DEFAULT_TOOLBAR_ORDER, classifyToolbarDock, toolbarFamily, ToolType } from '../src/core/types';

describe('Toolbar layout customization', () => {
  it('defaults to every known tool visible in default order', () => {
    store.resetToolbarLayout();
    const layout = store.toolbarLayout;
    expect(layout.map(l => l.id)).toEqual(DEFAULT_TOOLBAR_ORDER);
    expect(layout.every(l => l.visible)).toBe(true);
  });

  it('drops unknown ids and appends missing tools on reorder', () => {
    store.setToolbarOrder(['signature', 'pen', 'nope' as ToolType]);
    const ids = store.toolbarLayout.map(l => l.id);
    expect(ids.slice(0, 2)).toEqual(['signature', 'pen']);
    expect(ids).not.toContain('nope');
    // Every known tool still present exactly once.
    expect([...ids].sort()).toEqual([...DEFAULT_TOOLBAR_ORDER].sort());
    store.resetToolbarLayout();
  });

  it('hides tools and filters unknown hidden ids', () => {
    store.setToolbarHidden(['signature', 'ghost' as ToolType]);
    const hidden = store.toolbarLayout.filter(l => !l.visible).map(l => l.id);
    expect(hidden).toEqual(['signature']);
    store.resetToolbarLayout();
  });

  it('remembers the selected dock edge', () => {
    store.updateAppSettings({ toolbarDock: 'left' });
    expect(store.appSettings.toolbarDock).toBe('left');
    store.updateAppSettings({ toolbarDock: 'top' });
  });

  it('classifies drag releases by the nearest window edge', () => {
    expect(classifyToolbarDock(10, 400, 1000, 800)).toBe('left');
    expect(classifyToolbarDock(990, 400, 1000, 800)).toBe('right');
    expect(classifyToolbarDock(500, 10, 1000, 800)).toBe('top');
    expect(classifyToolbarDock(500, 790, 1000, 800)).toBe('bottom');
  });

  it('groups tools into stable families for separators', () => {
    expect(toolbarFamily('select')).toBe('nav');
    expect(toolbarFamily('lasso')).toBe('nav');
    expect(toolbarFamily('pen')).toBe('ink');
    expect(toolbarFamily('rectangle')).toBe('shapes');
    expect(toolbarFamily('signature')).toBe('annotate');
  });
});
