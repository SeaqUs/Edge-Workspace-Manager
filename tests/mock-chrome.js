/**
 * Edge Workspace Manager - 测试用 mock chrome API
 * 在浏览器测试页中模拟 chrome.storage / windows / tabs 行为
 */

(function () {
  'use strict';

  // 内存存储，模拟 chrome.storage.local
  const localStorage = {};

  // 窗口与标签页计数器
  let nextWindowId = 1000;
  let nextTabId = 1;
  const windows = new Map();

  window.chrome = {
    storage: {
      local: {
        get(keys) {
          return Promise.resolve({
            workspaceData: localStorage.workspaceData
          });
        },
        set(items) {
          if (items.workspaceData) {
            localStorage.workspaceData = JSON.parse(JSON.stringify(items.workspaceData));
          }
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener() {}
      }
    },

    windows: {
      create(options) {
        const windowId = nextWindowId++;
        const tabs = (options.url || []).map((url, index) => ({
          id: nextTabId++,
          url: url,
          title: 'Tab ' + nextTabId,
          windowId: windowId,
          index: index,
          pinned: false,
          favIconUrl: null
        }));
        const win = {
          id: windowId,
          tabs: tabs,
          focused: options.focused || false,
          type: 'normal'
        };
        windows.set(windowId, win);
        return Promise.resolve(win);
      },

      remove(windowId) {
        windows.delete(windowId);
        return Promise.resolve();
      },

      update(windowId, options) {
        const win = windows.get(windowId);
        if (win && options.focused) win.focused = true;
        return Promise.resolve(win);
      },

      getLastFocused(options) {
        // 返回一个模拟的当前窗口，包含两个标签页
        const windowId = nextWindowId++;
        const tabs = [
          {
            id: nextTabId++,
            url: 'https://github.com',
            title: 'GitHub',
            windowId: windowId,
            index: 0,
            pinned: false,
            favIconUrl: 'https://github.com/favicon.ico'
          },
          {
            id: nextTabId++,
            url: 'https://example.com',
            title: 'Example Domain',
            windowId: windowId,
            index: 1,
            pinned: false,
            favIconUrl: null
          }
        ];
        const win = {
          id: windowId,
          tabs: tabs,
          focused: true,
          type: 'normal'
        };
        windows.set(windowId, win);
        return Promise.resolve(win);
      }
    },

    tabs: {
      create(options) {
        const tabId = nextTabId++;
        const win = windows.get(options.windowId);
        const tab = {
          id: tabId,
          url: options.url,
          title: 'New Tab',
          windowId: options.windowId,
          index: win ? win.tabs.length : 0,
          pinned: false,
          favIconUrl: null
        };
        if (win) win.tabs.push(tab);
        return Promise.resolve(tab);
      },

      move(tabId, options) {
        return Promise.resolve({ id: tabId, windowId: options.windowId, index: options.index });
      },

      remove(tabId) {
        return Promise.resolve();
      }
    }
  };
})();
