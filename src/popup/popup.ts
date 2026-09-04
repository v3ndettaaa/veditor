import { extensionApi } from '../utils/browser-compat';
import { getIconSvg } from '../utils/icons';
import { escapeHtml } from '../utils/html';
import { applySavedAppearance } from '../ui/theme';

document.addEventListener('DOMContentLoaded', async () => {
  // Match the editor's saved theme and accent (same origin, same localStorage).
  applySavedAppearance();

  const openAppBtn = document.getElementById('open-app-btn');
  const openFileBtn = document.getElementById('open-file-btn');
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const recentList = document.getElementById('recent-list');
  const shortcutsLink = document.getElementById('shortcuts-link');

  openAppBtn?.addEventListener('click', () => {
    const url = extensionApi.runtime.getURL('index.html');
    extensionApi.tabs.create({ url });
    window.close();
  });

  openFileBtn?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async () => {
    if (fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      const arrayBuffer = await file.arrayBuffer();
      // Store temporarily in indexedDB or session storage then open app
      const { openDocumentSession } = await import('../io/storage');
      const docId = await openDocumentSession(file.name, new Uint8Array(arrayBuffer));
      const url = extensionApi.runtime.getURL(`index.html?docId=${docId}`);
      extensionApi.tabs.create({ url });
      window.close();
    }
  });

  const openShortcuts = () => {
    const url = extensionApi.runtime.getURL('index.html?showShortcuts=true');
    extensionApi.tabs.create({ url });
    window.close();
  };

  shortcutsLink?.addEventListener('click', openShortcuts);
  shortcutsLink?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openShortcuts();
    }
  });

  // Load recent files list
  try {
    const { getRecentDocuments } = await import('../io/storage');
    const recents = await getRecentDocuments();
    if (recentList) {
      if (recents.length === 0) {
        recentList.innerHTML = '<div class="empty-state">No recent documents</div>';
      } else {
        recentList.innerHTML = '';
        recents.slice(0, 4).forEach((doc: { id: string; name: string; pageCount?: number }) => {
          const li = document.createElement('li');
          li.className = 'recent-item';
          li.innerHTML = `
            <span class="recent-item-icon">${getIconSvg('fileText', 14)}</span>
            <span class="recent-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
            <span class="recent-pages">${doc.pageCount ? doc.pageCount + 'p' : ''}</span>
          `;
          li.addEventListener('click', () => {
            const url = extensionApi.runtime.getURL(`index.html?docId=${doc.id}`);
            extensionApi.tabs.create({ url });
            window.close();
          });
          recentList.appendChild(li);
        });
      }
    }
  } catch (err) {
    if (recentList) {
      recentList.innerHTML = '<div class="empty-state">No recent documents</div>';
    }
  }
});
