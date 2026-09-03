import { extensionApi } from '../utils/browser-compat';

document.addEventListener('DOMContentLoaded', async () => {
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

  shortcutsLink?.addEventListener('click', () => {
    const url = extensionApi.runtime.getURL('index.html?showShortcuts=true');
    extensionApi.tabs.create({ url });
    window.close();
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
            <span class="recent-name" title="${doc.name}">${doc.name}</span>
            <span style="font-size:11px; color:var(--text-secondary);">${doc.pageCount ? doc.pageCount + 'p' : ''}</span>
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
