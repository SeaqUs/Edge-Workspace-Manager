/**
 * Edge Workspace Manager - 数据存储层
 * 基于 chrome.storage.local 维护本地“影子数据库”
 * 所有工作区、标签页、分组数据均由扩展自主管理
 */

// 存储键名常量，统一使用避免拼写错误
const STORAGE_KEY = 'workspaceData';

// 默认空数据结构模板
const DEFAULT_DATA = {
  version: '1.0.0',
  lastUpdated: null,
  workspaces: []
};

/**
 * 生成唯一 ID
 * @param {string} prefix - ID 前缀，例如 'ws' / 'tab' / 'group'
 * @returns {string} 唯一标识字符串
 */
function generateId(prefix = 'id') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * 获取当前 ISO 格式时间字符串
 * @returns {string} ISO 8601 时间字符串
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 从 chrome.storage.local 读取工作区数据
 * @returns {Promise<object>} 完整工作区数据对象
 */
async function loadWorkspaces() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    // 若无数据则返回默认结构副本
    if (!result[STORAGE_KEY]) {
      return { ...DEFAULT_DATA };
    }
    return result[STORAGE_KEY];
  } catch (error) {
    console.error('[Edge Workspace Manager] 读取存储失败:', error);
    return { ...DEFAULT_DATA };
  }
}

/**
 * 保存工作区数据到 chrome.storage.local
 * @param {object} data - 完整工作区数据对象
 * @returns {Promise<void>}
 */
async function saveWorkspaces(data) {
  try {
    data.lastUpdated = nowIso();
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  } catch (error) {
    console.error('[Edge Workspace Manager] 保存存储失败:', error);
    throw error;
  }
}

/**
 * 创建新工作区
 * @param {string} name - 工作区名称
 * @returns {Promise<object>} 新建的工作区对象
 */
async function createWorkspace(name) {
  const data = await loadWorkspaces();
  const newWorkspace = {
    id: generateId('ws'),
    name: name.trim() || '未命名工作区',
    icon: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    windowId: null,
    tabs: [],
    groups: [],
    layout: {
      sortBy: 'title',
      sortOrder: 'asc'
    }
  };
  data.workspaces.push(newWorkspace);
  await saveWorkspaces(data);
  return newWorkspace;
}

/**
 * 根据 ID 删除工作区，若窗口已打开则关闭窗口
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function deleteWorkspace(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return false;

  // 若窗口仍打开，尝试关闭浏览器窗口
  if (ws.windowId) {
    try {
      await chrome.windows.remove(ws.windowId);
    } catch (error) {
      // 窗口可能已被用户手动关闭，忽略异常
      console.warn('[Edge Workspace Manager] 关闭窗口失败，可能已关闭:', error);
    }
  }

  data.workspaces = data.workspaces.filter(w => w.id !== workspaceId);
  await saveWorkspaces(data);
  return true;
}

/**
 * 更新工作区名称
 * @param {string} workspaceId - 工作区 ID
 * @param {string} newName - 新名称
 * @returns {Promise<object|null>} 更新后的工作区对象
 */
async function updateWorkspaceName(workspaceId, newName) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;

  ws.name = newName.trim() || ws.name;
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  return ws;
}

/**
 * 添加标签页到指定工作区
 * @param {string} workspaceId - 工作区 ID
 * @param {string} url - 标签页 URL
 * @param {string} [title] - 标签页标题，缺省使用 URL
 * @returns {Promise<object|null>} 新建的标签页对象
 */
async function addTabToWorkspace(workspaceId, url, title) {
  if (!url || !url.trim()) return null;

  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;

  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    // URL 不合法时跳过 favicon 生成
    console.warn('[Edge Workspace Manager] URL 解析失败:', error);
  }

  const newTab = {
    id: generateId('tab'),
    url: url.trim(),
    title: title ? title.trim() : url.trim(),
    favIconUrl: hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null,
    groupId: null,
    pinned: false,
    createdAt: nowIso()
  };

  ws.tabs.push(newTab);
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);

  // 若工作区窗口已打开，实际在窗口中创建标签页
  if (ws.windowId) {
    try {
      await chrome.tabs.create({ url: newTab.url, windowId: ws.windowId });
    } catch (error) {
      console.error('[Edge Workspace Manager] 在窗口中创建标签页失败:', error);
    }
  }

  return newTab;
}

/**
 * 从工作区中移除标签页
 * @param {string} workspaceId - 工作区 ID
 * @param {string} tabId - 标签页内部 ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function removeTabFromWorkspace(workspaceId, tabId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return false;

  const tabIndex = ws.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return false;

  const [removedTab] = ws.tabs.splice(tabIndex, 1);
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);

  // 若窗口已打开，尝试关闭对应的真实标签页
  if (ws.windowId && removedTab.realTabId) {
    try {
      await chrome.tabs.remove(removedTab.realTabId);
    } catch (error) {
      console.warn('[Edge Workspace Manager] 关闭真实标签页失败:', error);
    }
  }

  return true;
}

/**
 * 移动标签页到另一个工作区
 * @param {string} tabId - 标签页内部 ID
 * @param {string} sourceWorkspaceId - 源工作区 ID
 * @param {string} targetWorkspaceId - 目标工作区 ID
 * @returns {Promise<boolean>} 是否移动成功
 */
async function moveTabToWorkspace(tabId, sourceWorkspaceId, targetWorkspaceId) {
  if (sourceWorkspaceId === targetWorkspaceId) return false;

  const data = await loadWorkspaces();
  const sourceWs = data.workspaces.find(w => w.id === sourceWorkspaceId);
  const targetWs = data.workspaces.find(w => w.id === targetWorkspaceId);
  if (!sourceWs || !targetWs) return false;

  const tabIndex = sourceWs.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return false;

  const [movedTab] = sourceWs.tabs.splice(tabIndex, 1);
  movedTab.groupId = null; // 移动到新区后清除原分组关联
  targetWs.tabs.push(movedTab);
  sourceWs.updatedAt = nowIso();
  targetWs.updatedAt = nowIso();

  // 若两个窗口均打开，尝试实际移动浏览器标签页
  if (sourceWs.windowId && targetWs.windowId && movedTab.realTabId) {
    try {
      await chrome.tabs.move(movedTab.realTabId, {
        windowId: targetWs.windowId,
        index: -1
      });
    } catch (error) {
      console.error('[Edge Workspace Manager] 移动真实标签页失败:', error);
    }
  }

  await saveWorkspaces(data);
  return true;
}

/**
 * 调整标签页在工作区内的顺序
 * @param {string} workspaceId - 工作区 ID
 * @param {string} tabId - 标签页内部 ID
 * @param {number} targetIndex - 目标位置索引
 * @returns {Promise<boolean>} 是否排序成功
 */
async function reorderTab(workspaceId, tabId, targetIndex) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.tabs) return false;

  const currentIndex = ws.tabs.findIndex(t => t.id === tabId);
  if (currentIndex === -1) return false;

  // 限制目标索引范围
  const safeIndex = Math.max(0, Math.min(targetIndex, ws.tabs.length - 1));
  if (currentIndex === safeIndex) return true;

  const [movedTab] = ws.tabs.splice(currentIndex, 1);
  ws.tabs.splice(safeIndex, 0, movedTab);
  ws.updatedAt = nowIso();

  await saveWorkspaces(data);
  return true;
}

/**
 * 为工作区创建分组
 * @param {string} workspaceId - 工作区 ID
 * @param {string} groupName - 分组名称
 * @param {string|null} [parentGroupId] - 父分组 ID，支持嵌套
 * @returns {Promise<object|null>} 新建的分组对象
 */
async function createGroup(workspaceId, groupName, parentGroupId = null) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;

  const newGroup = {
    id: generateId('group'),
    name: groupName.trim() || '未命名分组',
    color: getRandomColor(),
    collapsed: false,
    parentGroupId: parentGroupId
  };

  ws.groups.push(newGroup);
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  return newGroup;
}

/**
 * 将标签页分配到分组
 * @param {string} workspaceId - 工作区 ID
 * @param {string} tabId - 标签页内部 ID
 * @param {string|null} groupId - 分组 ID，传 null 表示取消分组
 * @returns {Promise<boolean>} 是否分配成功
 */
async function assignTabToGroup(workspaceId, tabId, groupId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return false;

  // 校验分组存在性（groupId 为 null 表示取消分组）
  if (groupId && !ws.groups.find(g => g.id === groupId)) return false;

  const tab = ws.tabs.find(t => t.id === tabId);
  if (!tab) return false;

  tab.groupId = groupId || null;
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  return true;
}

/**
 * 打开工作区：创建或聚焦对应浏览器窗口
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<object|null>} 更新后的工作区对象
 */
async function openWorkspace(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;

  // 窗口已存在则聚焦
  if (ws.windowId) {
    try {
      await chrome.windows.update(ws.windowId, { focused: true });
      return ws;
    } catch (error) {
      // 窗口可能已关闭，重置 windowId 后继续创建
      console.warn('[Edge Workspace Manager] 聚焦窗口失败，尝试重建:', error);
      ws.windowId = null;
    }
  }

  // 根据标签页 URL 列表创建新窗口
  const urls = ws.tabs.length > 0 ? ws.tabs.map(t => t.url) : ['edge://newtab/'];
  try {
    const newWindow = await chrome.windows.create({
      url: urls,
      focused: true
    });

    // 记录窗口 ID 与真实标签页 ID 的映射
    ws.windowId = newWindow.id;
    if (newWindow.tabs) {
      newWindow.tabs.forEach((chromeTab, index) => {
        if (ws.tabs[index]) {
          ws.tabs[index].realTabId = chromeTab.id;
        }
      });
    }
    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
    return ws;
  } catch (error) {
    console.error('[Edge Workspace Manager] 创建工作区窗口失败:', error);
    return null;
  }
}

/**
 * 将 chrome 窗口对象转换为扩展内部工作区对象
 * @param {object} chromeWindow - chrome.windows API 返回的窗口对象
 * @param {string} [name] - 工作区名称，缺省使用窗口标题或时间
 * @returns {object|null} 转换后的工作区对象
 */
function convertChromeWindowToWorkspace(chromeWindow, name) {
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) {
    return null;
  }

  const workspace = {
    id: generateId('ws'),
    name: name ? name.trim() : (chromeWindow.title || `导入工作区 ${new Date().toLocaleString('zh-CN')}`),
    icon: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    windowId: chromeWindow.id, // 直接关联原始窗口
    tabs: [],
    groups: [],
    layout: {
      sortBy: 'title',
      sortOrder: 'asc'
    }
  };

  // 将 chrome 标签页转换为影子标签页，并记录真实标签页 ID
  workspace.tabs = chromeWindow.tabs.map((chromeTab) => {
    let hostname = '';
    try {
      if (chromeTab.url) {
        hostname = new URL(chromeTab.url).hostname;
      }
    } catch (error) {
      // 忽略无效 URL
    }

    return {
      id: generateId('tab'),
      url: chromeTab.url || 'edge://newtab/',
      title: chromeTab.title || chromeTab.url || '新标签页',
      favIconUrl: chromeTab.favIconUrl || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
      groupId: null,
      pinned: chromeTab.pinned || false,
      realTabId: chromeTab.id,
      createdAt: nowIso()
    };
  });

  return workspace;
}

/**
 * 从当前浏览器窗口导入为工作区
 * 读取当前活动窗口的所有标签页，创建一个新的影子工作区
 * @param {string} [name] - 工作区名称，缺省使用窗口标题或当前时间
 * @returns {Promise<object|null>} 新建的工作区对象
 */
async function importCurrentWindow(name) {
  try {
    // 获取最近一次聚焦的窗口（popup 打开前的活动窗口），包含标签页信息
    const currentWindow = await chrome.windows.getLastFocused({ populate: true });
    const newWorkspace = convertChromeWindowToWorkspace(currentWindow, name);
    if (!newWorkspace) {
      console.warn('[Edge Workspace Manager] 当前窗口无标签页，无法导入');
      return null;
    }

    const data = await loadWorkspaces();
    data.workspaces.push(newWorkspace);
    await saveWorkspaces(data);
    return newWorkspace;
  } catch (error) {
    console.error('[Edge Workspace Manager] 导入当前窗口失败:', error);
    return null;
  }
}

/**
 * 导入所有打开的浏览器窗口为扩展工作区
 * 仅导入 type 为 'normal' 的窗口，排除弹出窗/开发者工具等
 * @returns {Promise<object[]>} 新建的工作区对象数组
 */
async function importAllWindows() {
  try {
    // 获取所有窗口，包含标签页信息
    const allWindows = await chrome.windows.getAll({ populate: true });
    const normalWindows = allWindows.filter(w => w.type === 'normal' && w.tabs && w.tabs.length > 0);

    if (normalWindows.length === 0) {
      console.warn('[Edge Workspace Manager] 未发现可导入的普通窗口');
      return [];
    }

    const data = await loadWorkspaces();
    const importedWorkspaces = [];

    normalWindows.forEach((chromeWindow, index) => {
      const newWorkspace = convertChromeWindowToWorkspace(
        chromeWindow,
        `导入工作区 ${index + 1}`
      );
      if (newWorkspace) {
        data.workspaces.push(newWorkspace);
        importedWorkspaces.push(newWorkspace);
      }
    });

    await saveWorkspaces(data);
    return importedWorkspaces;
  } catch (error) {
    console.error('[Edge Workspace Manager] 导入所有窗口失败:', error);
    return [];
  }
}

/**
 * 获取当前所有可导入的浏览器窗口列表
 * 用于手动选择导入，返回简化的窗口信息供 UI 展示
 * @returns {Promise<object[]>} 窗口信息数组，每项包含 id、title、tabCount、tabs 摘要
 */
async function getOpenWindows() {
  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    return allWindows
      .filter(w => w.type === 'normal' && w.tabs && w.tabs.length > 0)
      .map(w => ({
        id: w.id,
        title: w.title || `窗口 ${w.id}`,
        tabCount: w.tabs.length,
        tabs: w.tabs.map(t => ({
          url: t.url,
          title: t.title || t.url || '新标签页',
          favIconUrl: t.favIconUrl
        }))
      }));
  } catch (error) {
    console.error('[Edge Workspace Manager] 获取打开窗口失败:', error);
    return [];
  }
}

/**
 * 根据用户选择的窗口 ID 列表导入为工作区
 * @param {number[]} windowIds - 要导入的窗口 ID 数组
 * @returns {Promise<object[]>} 新建的工作区对象数组
 */
async function importSelectedWindows(windowIds) {
  if (!windowIds || windowIds.length === 0) return [];

  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    const selectedWindows = allWindows.filter(w => windowIds.includes(w.id));

    if (selectedWindows.length === 0) {
      console.warn('[Edge Workspace Manager] 未找到选中的窗口');
      return [];
    }

    const data = await loadWorkspaces();
    const importedWorkspaces = [];

    selectedWindows.forEach((chromeWindow, index) => {
      const newWorkspace = convertChromeWindowToWorkspace(
        chromeWindow,
        `导入工作区 ${data.workspaces.length + importedWorkspaces.length + 1}`
      );
      if (newWorkspace) {
        data.workspaces.push(newWorkspace);
        importedWorkspaces.push(newWorkspace);
      }
    });

    await saveWorkspaces(data);
    return importedWorkspaces;
  } catch (error) {
    console.error('[Edge Workspace Manager] 导入选中窗口失败:', error);
    return [];
  }
}

/**
 * 将工作区的影子数据与对应 Edge 窗口的实际标签页强制同步
 * 适用于自动同步遗漏、手动调整后回写等场景
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否同步成功
 */
async function syncWorkspaceFromWindow(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.windowId) {
    console.warn('[Edge Workspace Manager] 工作区未关联窗口，无法同步');
    return false;
  }

  try {
    const chromeWindow = await chrome.windows.get(ws.windowId, { populate: true });
    if (!chromeWindow || !chromeWindow.tabs) {
      // 窗口已不存在，解除关联
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      return false;
    }

    // 保留原有分组分配与内部 ID 映射
    const existingTabsByRealId = new Map();
    ws.tabs.forEach(tab => {
      if (tab.realTabId) {
        existingTabsByRealId.set(tab.realTabId, tab);
      }
    });

    ws.tabs = chromeWindow.tabs.map((chromeTab) => {
      const existing = existingTabsByRealId.get(chromeTab.id);
      let hostname = '';
      try {
        if (chromeTab.url) {
          hostname = new URL(chromeTab.url).hostname;
        }
      } catch (error) {
        // 忽略无效 URL
      }

      return {
        id: existing ? existing.id : generateId('tab'),
        url: chromeTab.url || 'edge://newtab/',
        title: chromeTab.title || chromeTab.url || '新标签页',
        favIconUrl: chromeTab.favIconUrl || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
        groupId: existing ? existing.groupId : null,
        pinned: chromeTab.pinned || false,
        realTabId: chromeTab.id,
        createdAt: existing ? existing.createdAt : nowIso()
      };
    });

    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
    return true;
  } catch (error) {
    console.error('[Edge Workspace Manager] 同步工作区失败:', error);
    return false;
  }
}

/**
 * 关闭工作区对应的浏览器窗口
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否关闭成功
 */
async function closeWorkspace(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.windowId) return false;

  try {
    await chrome.windows.remove(ws.windowId);
    ws.windowId = null;
    ws.tabs.forEach(tab => delete tab.realTabId);
    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
    return true;
  } catch (error) {
    console.error('[Edge Workspace Manager] 关闭工作区窗口失败:', error);
    return false;
  }
}

/**
 * 生成随机分组颜色
 * @returns {string} 十六进制颜色值
 */
function getRandomColor() {
  const colors = [
    '#4285F4', '#EA4335', '#FBBC05', '#34A853',
    '#AA00FF', '#FF6D00', '#00BCD4', '#795548'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// 导出模块供 popup / background 使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadWorkspaces,
    saveWorkspaces,
    createWorkspace,
    deleteWorkspace,
    updateWorkspaceName,
    addTabToWorkspace,
    removeTabFromWorkspace,
    moveTabToWorkspace,
    reorderTab,
    createGroup,
    assignTabToGroup,
    openWorkspace,
    closeWorkspace,
    importCurrentWindow,
    importAllWindows,
    getOpenWindows,
    importSelectedWindows,
    syncWorkspaceFromWindow,
    generateId,
    nowIso
  };
}
