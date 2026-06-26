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
  let initialWindowsCreated = false;

  /**
   * 创建初始模拟窗口，仅执行一次
   * 包含两个 normal 窗口和一个 popup 窗口
   */
  function ensureInitialWindows() {
    if (initialWindowsCreated) return;
    initialWindowsCreated = true;

    const windowAId = nextWindowId++;
    const windowBId = nextWindowId++;
    const popupWindowId = nextWindowId++;

    const windowA = {
      id: windowAId,
      tabs: [
        {
          id: nextTabId++,
          url: 'https://github.com',
          title: 'GitHub',
          windowId: windowAId,
          index: 0,
          pinned: false,
          favIconUrl: 'https://github.com/favicon.ico'
        }
      ],
      focused: true,
      type: 'normal'
    };

    const windowB = {
      id: windowBId,
      tabs: [
        {
          id: nextTabId++,
          url: 'https://www.bing.com',
          title: 'Bing',
          windowId: windowBId,
          index: 0,
          pinned: false,
          favIconUrl: null
        }
      ],
      focused: false,
      type: 'normal'
    };

    const popupWindow = {
      id: popupWindowId,
      tabs: [
        {
          id: nextTabId++,
          url: 'https://popup.example.com',
          title: 'Popup',
          windowId: popupWindowId,
          index: 0,
          pinned: false,
          favIconUrl: null
        }
      ],
      focused: false,
      type: 'popup'
    };

    windows.set(windowAId, windowA);
    windows.set(windowBId, windowB);
    windows.set(popupWindowId, popupWindow);
  }

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

      get(windowId, options) {
        const win = windows.get(windowId);
        // 深拷贝 tabs 避免外部修改影响 mock 内部状态
        const cloned = win ? JSON.parse(JSON.stringify(win)) : null;
        return Promise.resolve(cloned);
      },

      getLastFocused(options) {
        ensureInitialWindows();
        // 返回第一个普通窗口作为当前焦点窗口
        const firstNormal = Array.from(windows.values()).find(w => w.type === 'normal');
        return Promise.resolve(firstNormal ? JSON.parse(JSON.stringify(firstNormal)) : null);
      },

      getAll(options) {
        ensureInitialWindows();
        const allWindows = Array.from(windows.values());
        return Promise.resolve(JSON.parse(JSON.stringify(allWindows)));
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
