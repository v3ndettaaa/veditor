/**
 * Browser Compatibility Adapter
 * Unifies chrome.* and browser.* WebExtension APIs across Chrome and Firefox.
 */

declare const browser: any;

export const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

export const extensionApi = {
  runtime: {
    getURL(path: string): string {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
      }
      if (typeof browser !== 'undefined' && browser.runtime?.getURL) {
        return browser.runtime.getURL(path);
      }
      return path;
    },
    sendMessage(message: any): Promise<any> {
      return new Promise((resolve, reject) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
              resolve(null); // graceful fallback
            } else {
              resolve(response);
            }
          });
        } else if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
          browser.runtime.sendMessage(message).then(resolve).catch(() => resolve(null));
        } else {
          resolve(null);
        }
      });
    },
    onMessage: {
      addListener(callback: (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void) {
        if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
          chrome.runtime.onMessage.addListener(callback);
        } else if (typeof browser !== 'undefined' && browser.runtime?.onMessage) {
          browser.runtime.onMessage.addListener(callback);
        }
      }
    }
  },
  tabs: {
    async create(createProperties: { url: string; active?: boolean }): Promise<any> {
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        return new Promise((resolve) => {
          chrome.tabs.create(createProperties, resolve);
        });
      }
      if (typeof browser !== 'undefined' && browser.tabs?.create) {
        return browser.tabs.create(createProperties);
      }
      window.open(createProperties.url, '_blank');
      return null;
    }
  },
  storage: {
    async get(keys: string | string[] | Record<string, any>): Promise<Record<string, any>> {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(keys, resolve);
        });
      }
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        return browser.storage.local.get(keys);
      }
      return {};
    },
    async set(items: Record<string, any>): Promise<void> {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        return new Promise((resolve) => {
          chrome.storage.local.set(items, resolve);
        });
      }
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        return browser.storage.local.set(items);
      }
    }
  }
};
