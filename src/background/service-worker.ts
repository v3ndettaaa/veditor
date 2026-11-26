/**
 * Background Service Worker for veditor
 * Handles context menus, tab orchestration, and initial setup.
 */

import { isLikelyWebPdfUrl, resolveWebPdfUrl, uint8ArrayToBase64 } from '../utils/pdf-url';

export const AUTO_OPEN_PDF_STORAGE_KEY = 'veditor_auto_open_pdfs';

/**
 * Pure URL matcher: returns true when `autoOpenEnabled` is active and `url`
 * points to a direct web PDF document (`http:` / `https:`) rather than an
 * already-open extension tab, blob, data URI, or non-PDF page.
 */
export function shouldAutoOpenPdfUrl(url: string | undefined | null, autoOpenEnabled: boolean): boolean {
  if (!autoOpenEnabled || !url || typeof url !== 'string') return false;
  return isLikelyWebPdfUrl(url);
}

const chromeApi = typeof chrome !== 'undefined' ? chrome : undefined;

if (chromeApi) {
  // Click on extension toolbar icon launches full editor / landing page tab directly
  const actionApi = chromeApi.action || (chromeApi as any).browserAction;
  if (actionApi && actionApi.onClicked) {
    actionApi.onClicked.addListener((tab?: any) => {
      const tabUrl = typeof tab?.url === 'string' ? resolveWebPdfUrl(tab.url) : '';
      const target = isLikelyWebPdfUrl(tabUrl)
        ? chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(tabUrl)}`)
        : chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url: target });
    });
  }

  const setupContextMenus = () => {
    if (!chromeApi.contextMenus) return;
    const createMenus = () => {
      try {
        chromeApi.contextMenus.create({
          id: 'veditor-open-link',
          title: 'Open PDF in veditor',
          contexts: ['link'],
          targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.PDF*', '*://arxiv.org/pdf/*', '*://*/*pdf*']
        });

        chromeApi.contextMenus.create({
          id: 'veditor-open-page-pdf',
          title: 'Open this PDF in veditor',
          contexts: ['page', 'frame'],
          documentUrlPatterns: [
            '*://*/*.pdf*',
            '*://*/*.PDF*',
            '*://arxiv.org/pdf/*',
            'file:///*.pdf*',
            'file:///*.PDF*'
          ]
        });

        chromeApi.contextMenus.create({
          id: 'veditor-open-app',
          title: 'Open veditor App',
          contexts: ['page', 'action']
        });
      } catch (err) {
        console.error('Error creating context menus:', err);
      }
    };

    try {
      if (typeof chromeApi.contextMenus.removeAll === 'function') {
        chromeApi.contextMenus.removeAll(() => createMenus());
      } else {
        createMenus();
      }
    } catch (err) {
      console.error('Error resetting context menus:', err);
    }
  };

  // Setup context menus upon installation and browser startup
  chromeApi.runtime?.onInstalled?.addListener(() => setupContextMenus());
  chromeApi.runtime?.onStartup?.addListener?.(() => setupContextMenus());

  // Handle context menu clicks
  chromeApi.contextMenus?.onClicked?.addListener((info: any, tab: any) => {
    if (info.menuItemId === 'veditor-open-link' && info.linkUrl) {
      const targetUrl = resolveWebPdfUrl(String(info.linkUrl));
      const editorUrl = chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(targetUrl)}`);
      chromeApi.tabs.create({ url: editorUrl });
    } else if (info.menuItemId === 'veditor-open-page-pdf') {
      const rawUrl = info.frameUrl || info.pageUrl || tab?.url || '';
      const targetUrl = resolveWebPdfUrl(String(rawUrl));
      const editorUrl = targetUrl
        ? chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(targetUrl)}`)
        : chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url: editorUrl });
    } else if (info.menuItemId === 'veditor-open-app') {
      const tabUrl = typeof tab?.url === 'string' ? resolveWebPdfUrl(tab.url) : '';
      const editorUrl = isLikelyWebPdfUrl(tabUrl)
        ? chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(tabUrl)}`)
        : chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url: editorUrl });
    }
  });

  // Message listener for opening editor or proxying web PDF fetches
  chromeApi.runtime?.onMessage?.addListener((message: any, _sender: any, sendResponse: (response: any) => void) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'OPEN_VEDITOR') {
      const targetUrl = message.pdfUrl ? resolveWebPdfUrl(String(message.pdfUrl)) : '';
      const url = targetUrl
        ? chromeApi.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(targetUrl)}`)
        : chromeApi.runtime.getURL('index.html');
      chromeApi.tabs.create({ url });
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'FETCH_PDF_BYTES' && typeof message.url === 'string') {
      const targetUrl = resolveWebPdfUrl(message.url);
      (async () => {
        try {
          let res: Response;
          try {
            res = await fetch(targetUrl, { credentials: 'include', redirect: 'follow' });
            if (!res.ok) {
              const retry = await fetch(targetUrl, { credentials: 'omit', redirect: 'follow' });
              if (retry.ok) res = retry;
            }
          } catch {
            res = await fetch(targetUrl, { credentials: 'omit', redirect: 'follow' });
          }

          if (!res.ok) {
            sendResponse({ ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText || ''}`.trim() });
            return;
          }

          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          sendResponse({
            ok: true,
            base64: uint8ArrayToBase64(bytes),
            contentType: res.headers.get('content-type') || '',
            finalUrl: res.url || targetUrl
          });
        } catch (err: any) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
      })();
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


