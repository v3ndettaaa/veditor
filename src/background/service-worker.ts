/**
 * Background Service Worker for veditor
 * Handles context menus, tab orchestration, and initial setup.
 */

// Click on extension toolbar icon launches full editor / landing page tab directly
const actionApi = chrome.action || (chrome as any).browserAction;
if (actionApi && actionApi.onClicked) {
  actionApi.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  });
}

// Setup context menus upon installation
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'veditor-open-link',
      title: 'Open PDF in veditor',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.PDF*']
    });

    chrome.contextMenus.create({
      id: 'veditor-open-app',
      title: 'Open veditor App',
      contexts: ['page', 'action']
    });
  } catch (err) {
    console.error('Error creating context menus:', err);
  }
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'veditor-open-link' && info.linkUrl) {
    const editorUrl = chrome.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(info.linkUrl)}`);
    chrome.tabs.create({ url: editorUrl });
  } else if (info.menuItemId === 'veditor-open-app') {
    const editorUrl = chrome.runtime.getURL('index.html');
    chrome.tabs.create({ url: editorUrl });
  }
});

// Message listener for opening editor or managing tabs
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OPEN_VEDITOR') {
    const url = message.pdfUrl
      ? chrome.runtime.getURL(`index.html?pdfUrl=${encodeURIComponent(message.pdfUrl)}`)
      : chrome.runtime.getURL('index.html');
    chrome.tabs.create({ url });
    sendResponse({ success: true });
    return true;
  }
});
