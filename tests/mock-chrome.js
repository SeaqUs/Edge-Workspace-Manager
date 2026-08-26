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

  // 事件监听器集合，用于模拟 Chrome 扩展事件
  const tabsOnCreatedListeners = [];
  const tabsOnUpdatedListeners = [];
  const tabsOnDetachedListeners = [];
  const tabsOnAttachedListeners = [];
  const tabsOnMovedListeners = [];
  const windowsOnCreatedListeners = [];

  /**
   * 触发 tabs.onCreated 事件
   */
  function fireTabsOnCreated(tab) {
    tabsOnCreatedListeners.forEach(listener => {
      try {
        listener({ ...tab });
      } catch (e) {
        console.error('[mock-chrome] tabs.onCreated listener error:', e);
      }
    });
  }

  /**
   * 触发 tabs.onUpdated 事件（status=complete）
   */
  function fireTabsOnUpdated(tab) {
    tabsOnUpdatedListeners.forEach(listener => {
      try {
        listener(tab.id, { status: 'complete' }, { ...tab });
      } catch (e) {
        console.error('[mock-chrome] tabs.onUpdated listener error:', e);
      }
    });
  }

  /**
   * 触发 windows.onCreated 事件
   */
  function fireWindowsOnCreated(win) {
    windowsOnCreatedListeners.forEach(listener => {
      try {
        listener({ ...win });
      } catch (e) {
        console.error('[mock-chrome] windows.onCreated listener error:', e);
      }
    });
  }

  /**
   * 触发 tabs.onDetached 事件（标签页从窗口分离，跨窗口移动第一步）
   */
  function fireTabsOnDetached(tab, detachInfo) {
    tabsOnDetachedListeners.forEach(listener => {
      try {
        listener(tab.id, detachInfo);
      } catch (e) {
        console.error('[mock-chrome] tabs.onDetached listener error:', e);
      }
    });
  }

  /**
   * 触发 tabs.onAttached 事件（标签页附加到窗口，跨窗口移动第二步）
   */
  function fireTabsOnAttached(tab, attachInfo) {
    tabsOnAttachedListeners.forEach(listener => {
      try {
        listener(tab.id, attachInfo);
      } catch (e) {
        console.error('[mock-chrome] tabs.onAttached listener error:', e);
      }
    });
  }

  /**
   * 触发 tabs.onMoved 事件（标签页在同一窗口内重排序）
   */
  function fireTabsOnMoved(tab, moveInfo) {
    tabsOnMovedListeners.forEach(listener => {
      try {
        listener(tab.id, moveInfo);
      } catch (e) {
        console.error('[mock-chrome] tabs.onMoved listener error:', e);
      }
    });
  }

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
          const result = {};
          if (keys === null || keys === undefined) {
            Object.keys(localStorage).forEach((key) => {
              result[key] = JSON.parse(JSON.stringify(localStorage[key]));
            });
          } else {
            const keyArray = Array.isArray(keys) ? keys : [keys];
            keyArray.forEach((key) => {
              if (localStorage[key] !== undefined) {
                result[key] = JSON.parse(JSON.stringify(localStorage[key]));
              }
            });
          }
          return Promise.resolve(result);
        },
        set(items) {
          Object.keys(items).forEach((key) => {
            localStorage[key] = JSON.parse(JSON.stringify(items[key]));
          });
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener() {}
      }
    },

    runtime: {
      getURL(path) {
        return `http://localhost:8765/${path}`;
      },
      onMessage: {
        addListener() {}
      }
    },

    action: {
      onClicked: {
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
        // 模拟真实浏览器窗口创建事件
        setTimeout(() => fireWindowsOnCreated(win), 0);
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
      },

      onCreated: {
        addListener(listener) {
          windowsOnCreatedListeners.push(listener);
        }
      },
      onRemoved: {
        addListener() {}
      },
      onFocusChanged: {
        addListener() {}
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
        // 模拟真实浏览器：创建标签页后触发 onCreated，随后页面加载完成触发 onUpdated
        setTimeout(() => fireTabsOnCreated(tab), 0);
        setTimeout(() => {
          tab.title = options.url;
          fireTabsOnUpdated(tab);
        }, 10);
        return Promise.resolve(tab);
      },

      get(tabId) {
        for (const win of windows.values()) {
          const tab = win.tabs.find(t => t.id === tabId);
          if (tab) return Promise.resolve(JSON.parse(JSON.stringify(tab)));
        }
        return Promise.resolve(null);
      },

      move(tabId, options) {
        // 查找标签页当前所在窗口
        let sourceWin = null;
        let tab = null;
        for (const win of windows.values()) {
          const idx = win.tabs.findIndex(t => t.id === tabId);
          if (idx !== -1) { sourceWin = win; tab = win.tabs[idx]; break; }
        }
        if (!tab) return Promise.reject(new Error('tab not found: ' + tabId));

        const targetWin = windows.get(options.windowId);
        if (!targetWin) return Promise.reject(new Error('target window not found: ' + options.windowId));

        const oldWindowId = sourceWin.id;
        const oldIndex = tab.index;

        // 从源窗口移除并重算 index
        sourceWin.tabs.splice(sourceWin.tabs.findIndex(t => t.id === tabId), 1);
        sourceWin.tabs.forEach((t, i) => { t.index = i; });

        const newIndex = options.index !== undefined && options.index >= 0
          ? Math.min(options.index, targetWin.tabs.length)
          : targetWin.tabs.length;
        tab.windowId = options.windowId;

        if (oldWindowId === options.windowId) {
          // 同一窗口内移动：重排序并触发 onMoved
          targetWin.tabs.splice(newIndex, 0, tab);
          targetWin.tabs.forEach((t, i) => { t.index = i; });
          setTimeout(() => fireTabsOnMoved(tab, { windowId: options.windowId, fromIndex: oldIndex, toIndex: tab.index }), 0);
        } else {
          // 跨窗口移动：先触发 onDetached，再触发 onAttached
          setTimeout(() => fireTabsOnDetached(tab, { oldWindowId: oldWindowId, oldPosition: oldIndex }), 0);
          setTimeout(() => {
            targetWin.tabs.splice(newIndex, 0, tab);
            targetWin.tabs.forEach((t, i) => { t.index = i; });
            fireTabsOnAttached(tab, { newWindowId: options.windowId, newPosition: tab.index });
          }, 5);
        }

        return Promise.resolve({ id: tabId, windowId: options.windowId, index: tab.index });
      },

      remove(tabId) {
        for (const win of windows.values()) {
          const index = win.tabs.findIndex(t => t.id === tabId);
          if (index !== -1) {
            win.tabs.splice(index, 1);
            // 重新计算后续标签页的 index
            win.tabs.forEach((t, i) => { t.index = i; });
            break;
          }
        }
        return Promise.resolve();
      },

      onCreated: {
        addListener(listener) {
          tabsOnCreatedListeners.push(listener);
        }
      },
      onUpdated: {
        addListener(listener) {
          tabsOnUpdatedListeners.push(listener);
        }
      },
      onRemoved: {
        addListener() {}
      },
      onDetached: {
        addListener(listener) {
          tabsOnDetachedListeners.push(listener);
        }
      },
      onAttached: {
        addListener(listener) {
          tabsOnAttachedListeners.push(listener);
        }
      },
      onMoved: {
        addListener(listener) {
          tabsOnMovedListeners.push(listener);
        }
      }
    }
  };
})();
