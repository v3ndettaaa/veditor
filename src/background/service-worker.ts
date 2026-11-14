/**
 * Background Service Worker for veditor
 * Handles context menus, tab orchestration, and initial setup.
 */

export const AUTO_OPEN_PDF_STORAGE_KEY = 'veditor_auto_open_pdfs';

/**
 * Pure URL matcher: returns true when `autoOpenEnabled` is active and `url`
 * points to a direct web PDF document (`http:` / `https:`) rather than an
 * already-open extension tab, blob, data URI, or non-PDF page.
 */
export function shouldAutoOpenPdfUrl(url: string | undefined | null, autoOpenEnabled: boolean): boolean {
  if (!autoOpenEnabled || !url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const cleanPath = url.split(/[?#]/)[0];
  return /\.pdf$/i.test(cleanPath);
}

const chromeApi = typeof chrome !== 'undefined' ? chrome : undefined;

if (chromeApi) {
  // Click on extension toolbar icon launches full editor / landing page tab directly
  const actionApi = chromeApi.action || (chromeApi as any).browserAction;
  if (actionApi && actionApi.onClicked) {
    actionApi.onClicked.addListener(() => {
      chromeApi.tabs.create({ url: chromeApi.runtime.getURL('index.html') });
    });
  }

  // Setup context menus upon installation
  chromeApi.runtime?.onInstalled?.addListener(() => {
    try {
      chromeApi.contextMenus.create({
        id: 'veditor-open-link',
        title: 'Open PDF in veditor',
        contexts: ['link'],
        targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.PDF*']
      });

      chromeApi.contextMenus.create({
        id: 'veditor-open-app',
        title: 'Open veditor App',
        contexts: ['page', 'action']
      });
    } catch (err) {
      console.error('Error creating context menus:', err);
    }
  });

  // Handle context menu clicks
  chromeApi.contextMenus?.onClicked?.addListener((info: any, _tab: any) => {
    if (info.menuItemId === 'veditor-open-link' && info.linkUrl) {
      const editorUrl = chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(info.linkUrl)}`);
      chromeApi.tabs.create({ url: editorUrl });
    } else if (info.menuItemId === 'veditor-open-app') {
      const editorUrl = chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url: editorUrl });
    }
  });

  // Message listener for opening editor or managing tabs
  chromeApi.runtime?.onMessage?.addListener((message: any, _sender: any, sendResponse: (response: any) => void) => {
    if (message.type === 'OPEN_VEDITOR') {
      const url = message.pdfUrl
        ? chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(message.pdfUrl)}`)
        : chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url });
      sendResponse({ success: true });
      return true;
    }
  });

  // Resolve stored toggle cleanly even on MV3 service-worker cold starts
  let autoOpenCached: boolean | null = null;
  let pendingRead: Promise<boolean> | null = null;

  const getAutoOpenSetting = (): Promise<boolean> => {
    if (autoOpenCached !== null) return Promise.resolve(autoOpenCached);
    if (pendingRead) return pendingRead;
    pendingRead = new Promise<boolean>((resolve) => {
      try {
        chromeApi.storage?.local?.get?.([AUTO_OPEN_PDF_STORAGE_KEY], (res: any) => {
          const val = Boolean(res?.[AUTO_OPEN_PDF_STORAGE_KEY]);
          autoOpenCached = val;
          pendingRead = null;
          resolve(val);
        });
      } catch {
        autoOpenCached = false;
        pendingRead = null;
        resolve(false);
      }
    });
    return pendingRead;
  };

  try {
    void getAutoOpenSetting();
    chromeApi.storage?.onChanged?.addListener?.((changes: any, area: string) => {
      if (area === 'local' && changes[AUTO_OPEN_PDF_STORAGE_KEY]) {
        autoOpenCached = Boolean(changes[AUTO_OPEN_PDF_STORAGE_KEY].newValue);
        pendingRead = null;
      }
    });
  } catch (_) {}

  if (chromeApi.tabs?.onUpdated) {
    chromeApi.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
      const candidateUrl = changeInfo.url || (changeInfo.status === 'loading' ? tab?.url : '');
      if (!candidateUrl || typeof candidateUrl !== 'string' || !/^https?:\/\//i.test(candidateUrl)) return;
      void getAutoOpenSetting().then((enabled) => {
        if (!shouldAutoOpenPdfUrl(candidateUrl, enabled)) return;
        const editorUrl = chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(candidateUrl)}`);
        chromeApi.tabs.update(tabId, { url: editorUrl });
      });
    });
  }
}


