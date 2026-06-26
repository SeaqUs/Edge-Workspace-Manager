/**
 * Edge Workspace Manager - Service Worker
 * 负责监听浏览器窗口/标签页事件，保持影子数据库与浏览器状态同步
 */

// 导入数据层（Manifest V3 service worker 中通过 importScripts 引入）
importScripts('js/dataStore.js');

/**
 * 扩展安装时初始化默认数据结构
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Edge Workspace Manager] 扩展已安装，原因:', details.reason);

  try {
    const data = await loadWorkspaces();
    if (!data.version) {
      data.version = '1.0.0';
      data.workspaces = data.workspaces || [];
      await saveWorkspaces(data);
    }
  } catch (error) {
    console.error('[Edge Workspace Manager] 安装初始化失败:', error);
  }
});

/**
 * 监听窗口关闭事件：当工作区对应窗口被关闭时，清空 windowId 关联
 */
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const data = await loadWorkspaces();
    const ws = data.workspaces.find(w => w.windowId === windowId);
    if (ws) {
      ws.windowId = null;
      // 清除真实标签页 ID 映射，下次打开时重新建立
      ws.tabs.forEach(tab => delete tab.realTabId);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      console.log(`[Edge Workspace Manager] 窗口 ${windowId} 已关闭，解除工作区 ${ws.id} 关联`);
    }
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理窗口关闭事件失败:', error);
  }
});

/**
 * 监听标签页移除事件：当工作区窗口中的真实标签页被关闭时，同步移除影子数据
 */
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  try {
    const data = await loadWorkspaces();
    let changed = false;

    for (const ws of data.workspaces) {
      if (ws.windowId !== removeInfo.windowId) continue;

      const tabIndex = ws.tabs.findIndex(t => t.realTabId === tabId);
      if (tabIndex !== -1) {
        ws.tabs.splice(tabIndex, 1);
        ws.updatedAt = nowIso();
        changed = true;
      }
    }

    if (changed) {
      await saveWorkspaces(data);
      console.log(`[Edge Workspace Manager] 标签页 ${tabId} 已移除，同步更新影子数据库`);
    }
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页移除事件失败:', error);
  }
});

/**
 * 监听标签页更新事件：同步更新标题与 favicon
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 仅在页面完成加载且有关联窗口时处理，减少频繁写入
  if (changeInfo.status !== 'complete') return;

  try {
    const data = await loadWorkspaces();
    let changed = false;

    for (const ws of data.workspaces) {
      if (ws.windowId !== tab.windowId) continue;

      const storedTab = ws.tabs.find(t => t.realTabId === tabId);
      if (storedTab) {
        if (tab.title && tab.title !== storedTab.title) {
          storedTab.title = tab.title;
          changed = true;
        }
        if (tab.favIconUrl && tab.favIconUrl !== storedTab.favIconUrl) {
          storedTab.favIconUrl = tab.favIconUrl;
          changed = true;
        }
        if (tab.url && tab.url !== storedTab.url) {
          storedTab.url = tab.url;
          changed = true;
        }
      }
    }

    if (changed) {
      await saveWorkspaces(data);
      console.log(`[Edge Workspace Manager] 标签页 ${tabId} 信息已更新`);
    }
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页更新事件失败:', error);
  }
});

/**
 * 监听存储变化，向所有 popup 页面广播刷新消息
 */
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[STORAGE_KEY]) {
    chrome.runtime.sendMessage({ type: 'WORKSPACE_DATA_CHANGED' }).catch(() => {
      // popup 未打开时无需处理
    });
  }
});

/**
 * 响应 popup / 其他脚本的消息请求
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 使用异步处理 + 返回 true 保持 sendResponse 可用
  handleMessage(request, sender, sendResponse);
  return true;
});

/**
 * 消息路由处理函数
 * @param {object} request - 消息体
 * @param {object} sender - 发送者信息
 * @param {function} sendResponse - 回调函数
 */
async function handleMessage(request, sender, sendResponse) {
  try {
    switch (request.type) {
      case 'GET_WORKSPACES': {
        const data = await loadWorkspaces();
        sendResponse({ success: true, data });
        break;
      }

      case 'CREATE_WORKSPACE': {
        const ws = await createWorkspace(request.name);
        sendResponse({ success: true, workspace: ws });
        break;
      }

      case 'DELETE_WORKSPACE': {
        const ok = await deleteWorkspace(request.workspaceId);
        sendResponse({ success: ok });
        break;
      }

      case 'RENAME_WORKSPACE': {
        const ws = await updateWorkspaceName(request.workspaceId, request.name);
        sendResponse({ success: !!ws, workspace: ws });
        break;
      }

      case 'OPEN_WORKSPACE': {
        const ws = await openWorkspace(request.workspaceId);
        sendResponse({ success: !!ws, workspace: ws });
        break;
      }

      case 'CLOSE_WORKSPACE': {
        const ok = await closeWorkspace(request.workspaceId);
        sendResponse({ success: ok });
        break;
      }

      case 'ADD_TAB': {
        const tab = await addTabToWorkspace(request.workspaceId, request.url, request.title);
        sendResponse({ success: !!tab, tab });
        break;
      }

      case 'REMOVE_TAB': {
        const ok = await removeTabFromWorkspace(request.workspaceId, request.tabId);
        sendResponse({ success: ok });
        break;
      }

      case 'MOVE_TAB': {
        const ok = await moveTabToWorkspace(
          request.tabId,
          request.sourceWorkspaceId,
          request.targetWorkspaceId
        );
        sendResponse({ success: ok });
        break;
      }

      case 'CREATE_GROUP': {
        const group = await createGroup(request.workspaceId, request.groupName, request.parentGroupId);
        sendResponse({ success: !!group, group });
        break;
      }

      case 'ASSIGN_TAB_TO_GROUP': {
        const ok = await assignTabToGroup(request.workspaceId, request.tabId, request.groupId);
        sendResponse({ success: ok });
        break;
      }

      case 'IMPORT_CURRENT_WINDOW': {
        const ws = await importCurrentWindow(request.name);
        sendResponse({ success: !!ws, workspace: ws });
        break;
      }

      default:
        sendResponse({ success: false, error: '未知消息类型' });
    }
  } catch (error) {
    console.error('[Edge Workspace Manager] 消息处理失败:', error);
    sendResponse({ success: false, error: error.message });
  }
}
