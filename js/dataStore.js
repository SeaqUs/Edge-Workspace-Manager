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

// URL 关联匹配阈值：窗口与工作区至少有一半标签页 URL 匹配才建立关联
const WINDOW_MATCH_THRESHOLD = 0.5;

// 打开工作区时复用已存在窗口的严格阈值，避免把单标签页窗口误关联到多标签页工作区
const WINDOW_MATCH_THRESHOLD_STRICT = 0.8;

// 待执行操作队列的存储键名
const PENDING_OPS_KEY = 'pendingOperations';

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
 * 规范化 URL，用于窗口与工作区之间的关联匹配
 * 移除尾部斜杠、fragment 并转小写，忽略新建标签页地址
 * @param {string} url - 原始 URL
 * @returns {string|null} 规范化后的 URL
 */
function normalizeUrl(url) {
  if (!url || url === 'edge://newtab/' || url === 'about://newtab/' || url === 'chrome://newtab/') {
    return null;
  }
  try {
    const u = new URL(url.trim());
    // 忽略 fragment
    u.hash = '';
    let result = u.toString().toLowerCase();
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    return result;
  } catch (error) {
    return url.trim().toLowerCase();
  }
}

/**
 * 计算浏览器窗口与工作区的标签页 URL 匹配度
 * @param {object} chromeWindow - 包含 tabs 的窗口对象
 * @param {object} ws - 工作区对象
 * @returns {number} 匹配度分数，范围 0-1
 */
function calculateWindowMatchScore(chromeWindow, ws) {
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) return 0;
  if (!ws) return 0;

  const windowUrls = chromeWindow.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
  let wsUrls = (ws.tabs || []).map(t => normalizeUrl(t.url)).filter(Boolean);

  // 若工作区有待清理 URL，也纳入匹配评分，帮助识别移出标签页后的原窗口
  if (ws.pendingCleanup && ws.pendingCleanup.urls && ws.pendingCleanup.urls.length > 0) {
    const cleanupUrls = ws.pendingCleanup.urls.map(u => normalizeUrl(u)).filter(Boolean);
    wsUrls = wsUrls.concat(cleanupUrls);
  }

  if (windowUrls.length === 0 || wsUrls.length === 0) return 0;

  const matched = windowUrls.filter(url => wsUrls.includes(url)).length;
  return matched / Math.max(windowUrls.length, wsUrls.length);
}

/**
 * 将指定浏览器窗口关联到指定工作区（内部直接操作，不保存存储）
 * 调用方需确保传入的数据对象最终执行 saveWorkspaces
 * @param {object} chromeWindow - 包含 tabs 的窗口对象
 * @param {object} ws - 要关联的工作区对象
 */
function associateWindowWithWorkspaceInternal(chromeWindow, ws) {
  if (!chromeWindow || !chromeWindow.id || !ws) return;

  ws.windowId = chromeWindow.id;
  ws.tabs.forEach((tab) => {
    const chromeTab = chromeWindow.tabs.find(t => normalizeUrl(t.url) === normalizeUrl(tab.url));
    if (chromeTab) {
      tab.realTabId = chromeTab.id;
    } else {
      delete tab.realTabId;
    }
  });
}

/**
 * 尝试将单个浏览器窗口与未关联的工作区进行关联
 * @param {object} chromeWindow - 包含 tabs 的窗口对象
 * @returns {Promise<boolean>} 是否成功关联
 */
async function tryAssociateWindowWithWorkspace(chromeWindow) {
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) return false;

  const data = await loadWorkspaces();
  const windowUrls = chromeWindow.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
  if (windowUrls.length === 0) return false;

  let bestMatch = null;
  let bestScore = 0;

  for (const ws of data.workspaces) {
    if (ws.windowId) continue;

    const wsUrls = ws.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
    if (wsUrls.length === 0) continue;

    const matched = windowUrls.filter(url => wsUrls.includes(url)).length;
    const score = matched / Math.max(windowUrls.length, wsUrls.length);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = ws;
    }
  }

  // 若窗口包含该工作区待清理的 URL，说明这是标签页移出前的原窗口，允许关联。
  // 仅当匹配度达到阈值或存在待清理 URL 线索时才建立关联，避免把无关窗口误识别为工作区。
  const hasCleanupMatch = bestMatch && windowContainsPendingCleanupUrls(chromeWindow, bestMatch);
  const effectiveThreshold = hasCleanupMatch ? 0 : WINDOW_MATCH_THRESHOLD;

  if (bestMatch && (bestScore > effectiveThreshold || hasCleanupMatch)) {
    associateWindowWithWorkspaceInternal(chromeWindow, bestMatch);
    bestMatch.updatedAt = nowIso();
    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 窗口 ${chromeWindow.id} 已自动关联到工作区 ${bestMatch.id}，匹配度 ${(bestScore * 100).toFixed(0)}%`);
    // 若此前用户通过面板触发了“打开”等操作，现在应用待执行队列
    await applyPendingOperations(bestMatch.id);
    return true;
  }

  return false;
}

/**
 * 判断浏览器窗口是否包含工作区待清理的 URL
 * 用于标签页移出后，帮助识别原工作区对应的窗口
 * @param {object} chromeWindow - 包含 tabs 的窗口对象
 * @param {object} ws - 工作区对象
 * @returns {boolean}
 */
function windowContainsPendingCleanupUrls(chromeWindow, ws) {
  if (!ws || !ws.pendingCleanup || !ws.pendingCleanup.urls || ws.pendingCleanup.urls.length === 0) {
    return false;
  }
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) return false;

  const windowUrls = chromeWindow.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
  const cleanupUrls = ws.pendingCleanup.urls.map(u => normalizeUrl(u)).filter(Boolean);
  return cleanupUrls.some(url => windowUrls.includes(url));
}

/**
 * 扫描所有已打开的普通窗口，尝试与未关联的工作区建立关联
 * 适用于 Edge 原生按钮切换/打开工作区后，手动或自动同步扩展状态
 * @returns {Promise<{associated: number, unmatchedWindows: object[]}>}
 */
async function scanOpenWindowsAndAssociate() {
  try {
    const data = await loadWorkspaces();
    const unassociatedWorkspaces = data.workspaces.filter(ws => !ws.windowId);
    if (unassociatedWorkspaces.length === 0) {
      return { associated: 0, unmatchedWindows: [] };
    }

    const allWindows = await chrome.windows.getAll({ populate: true });
    const normalWindows = allWindows.filter(w => w.type === 'normal' && w.tabs && w.tabs.length > 0);

    let associatedCount = 0;
    const matchedWindowIds = new Set();

    for (const ws of unassociatedWorkspaces) {
      let bestMatch = null;
      let bestScore = 0;

      for (const chromeWindow of normalWindows) {
        if (matchedWindowIds.has(chromeWindow.id)) continue;

        const score = calculateWindowMatchScore(chromeWindow, ws);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = chromeWindow;
        }
      }

      if (bestMatch && bestScore >= WINDOW_MATCH_THRESHOLD) {
        associateWindowWithWorkspaceInternal(bestMatch, ws);
        ws.updatedAt = nowIso();
        matchedWindowIds.add(bestMatch.id);
        associatedCount++;
      }
    }

    // 第二轮 fallback：对于仍有待执行操作且未关联的工作区，
    // 允许与剩余未匹配窗口关联，确保延迟操作有机会执行。
    // 为防止把无关窗口误识别为目标工作区，仅当匹配度大于 0，
    // 或窗口包含该工作区待清理 URL 时，才建立关联。
    for (const ws of unassociatedWorkspaces) {
      if (ws.windowId || matchedWindowIds.has(ws.windowId)) continue;
      if (!(await hasPendingOperations(ws.id))) continue;

      let bestMatch = null;
      let bestScore = 0;

      for (const chromeWindow of normalWindows) {
        if (matchedWindowIds.has(chromeWindow.id)) continue;

        const score = calculateWindowMatchScore(chromeWindow, ws);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = chromeWindow;
        }
      }

      // 没有 URL 线索时不强行关联，避免误连到不相关的窗口
      const hasCleanupMatch = bestMatch && windowContainsPendingCleanupUrls(bestMatch, ws);
      if (bestMatch && (bestScore > 0 || hasCleanupMatch)) {
        associateWindowWithWorkspaceInternal(bestMatch, ws);
        ws.updatedAt = nowIso();
        matchedWindowIds.add(bestMatch.id);
        associatedCount++;
      }
    }

    if (associatedCount > 0) {
      await saveWorkspaces(data);
    }

    // 保存完成后再应用待执行操作，确保 applyPendingOperations 能读到最新 windowId
    for (const ws of unassociatedWorkspaces) {
      if (matchedWindowIds.has(ws.windowId)) {
        await applyPendingOperations(ws.id);
      }
    }

    const unmatchedWindows = normalWindows
      .filter(w => !matchedWindowIds.has(w.id))
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

    return { associated: associatedCount, unmatchedWindows };
  } catch (error) {
    console.error('[Edge Workspace Manager] 扫描窗口关联失败:', error);
    return { associated: 0, unmatchedWindows: [] };
  }
}

/**
 * 创建新工作区从 chrome.storage.local 读取工作区数据
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
 * 读取待执行操作队列
 * 结构为 { [workspaceId]: [ { id, type, payload, createdAt } ] }
 * @returns {Promise<object>}
 */
async function loadPendingOperations() {
  try {
    const result = await chrome.storage.local.get([PENDING_OPS_KEY]);
    return result[PENDING_OPS_KEY] || {};
  } catch (error) {
    console.error('[Edge Workspace Manager] 读取待执行操作失败:', error);
    return {};
  }
}

/**
 * 保存待执行操作队列
 * @param {object} operations - 操作队列对象
 * @returns {Promise<void>}
 */
async function savePendingOperations(operations) {
  try {
    await chrome.storage.local.set({ [PENDING_OPS_KEY]: operations });
  } catch (error) {
    console.error('[Edge Workspace Manager] 保存待执行操作失败:', error);
    throw error;
  }
}

/**
 * 向指定工作区添加一条待执行操作
 * @param {string} workspaceId - 工作区 ID
 * @param {string} type - 操作类型，如 'OPEN' / 'SYNC'
 * @param {object} payload - 操作附加数据
 * @returns {Promise<object>} 新增的操作对象
 */
async function queuePendingOperation(workspaceId, type, payload = {}) {
  const operations = await loadPendingOperations();
  const workspaceOps = operations[workspaceId] || [];
  const operation = {
    id: generateId('op'),
    type,
    payload,
    createdAt: nowIso()
  };
  workspaceOps.push(operation);
  operations[workspaceId] = workspaceOps;
  await savePendingOperations(operations);
  console.log(`[Edge Workspace Manager] 工作区 ${workspaceId} 操作 ${type} 已入队`);
  return operation;
}

/**
 * 获取指定工作区的待执行操作
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<object[]>}
 */
async function getPendingOperations(workspaceId) {
  const operations = await loadPendingOperations();
  return (operations[workspaceId] || []).slice();
}

/**
 * 清空指定工作区或所有工作区的待执行操作
 * @param {string} [workspaceId] - 工作区 ID，缺省时清空全部
 * @returns {Promise<void>}
 */
async function clearPendingOperations(workspaceId) {
  if (!workspaceId) {
    await savePendingOperations({});
    return;
  }
  const operations = await loadPendingOperations();
  if (operations[workspaceId]) {
    delete operations[workspaceId];
    await savePendingOperations(operations);
  }
}

/**
 * 检查指定工作区是否存在待执行操作
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>}
 */
async function hasPendingOperations(workspaceId) {
  const operations = await loadPendingOperations();
  return !!operations[workspaceId] && operations[workspaceId].length > 0;
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

  // 同步真实浏览器标签页，避免“数据已移动但窗口里还在”
  if (sourceWs.windowId && movedTab.realTabId) {
    try {
      if (targetWs.windowId && targetWs.windowId !== sourceWs.windowId) {
        // 目标窗口已打开：把真实标签页移动到目标窗口
        await chrome.tabs.move(movedTab.realTabId, {
          windowId: targetWs.windowId,
          index: -1
        });
      } else {
        // 目标窗口未打开：源窗口里的这个标签页已不属于源工作区，直接关闭
        await chrome.tabs.remove(movedTab.realTabId);
        delete movedTab.realTabId;
      }
    } catch (error) {
      console.error('[Edge Workspace Manager] 同步真实标签页失败:', error);
    }
  }

  // 目标窗口未打开时，清除可能过期的 realTabId，避免后续同步把旧窗口误关联回来
  if (!targetWs.windowId) {
    delete movedTab.realTabId;
  }

  // 若目标工作区当前没有窗口，自动将“打开并同步”意图入队，
  // 这样等目标原生工作区窗口被检测到后，会自动把移入的标签页创建出来
  if (!targetWs.windowId && targetWs.tabs.length > 0 && !(await hasPendingOperations(targetWorkspaceId))) {
    await queuePendingOperation(targetWorkspaceId, 'OPEN', { reason: 'tabs_moved_in' });
  }

  // 若源工作区窗口当前未打开，记录待清理的 URL 并入队 SYNC 意图。
  // 这样当源原生工作区窗口被重新打开后，扩展可以凭这些 URL 识别该窗口，
  // 并自动关闭已移出的标签页。
  if (!sourceWs.windowId) {
    if (!sourceWs.pendingCleanup) {
      sourceWs.pendingCleanup = { urls: [], createdAt: nowIso() };
    }
    sourceWs.pendingCleanup.urls.push(movedTab.url);
    sourceWs.pendingCleanup.createdAt = nowIso();
    if (!(await hasPendingOperations(sourceWorkspaceId))) {
      await queuePendingOperation(sourceWorkspaceId, 'SYNC', { reason: 'tabs_moved_out' });
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

  // 在创建新窗口前，先扫描已打开的窗口：
  // 若用户已通过 Edge 原生按钮打开该工作区（窗口 URL 高度匹配），
  // 则直接关联已有窗口，避免重复创建“伪工作区”多标签窗口。
  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    const candidateWindows = allWindows.filter(w => w.type === 'normal' && w.tabs && w.tabs.length > 0);

    let bestMatch = null;
    let bestScore = 0;
    for (const chromeWindow of candidateWindows) {
      const score = calculateWindowMatchScore(chromeWindow, ws);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = chromeWindow;
      }
    }

    if (bestMatch && bestScore >= WINDOW_MATCH_THRESHOLD_STRICT) {
      associateWindowWithWorkspaceInternal(bestMatch, ws);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      console.log(`[Edge Workspace Manager] 工作区 ${ws.id} 已关联到已存在窗口 ${bestMatch.id}，匹配度 ${(bestScore * 100).toFixed(0)}%`);
      // 若此前存在“等待原生工作区打开”的待执行操作，现在应用
      await applyPendingOperations(workspaceId);
      return ws;
    }
  } catch (error) {
    console.warn('[Edge Workspace Manager] 检查已存在窗口失败:', error);
  }

  // 未找到匹配窗口：不创建“伪工作区”多标签窗口，
  // 而是将打开意图入队，等检测到对应原生工作区窗口后再同步。
  await queuePendingOperation(workspaceId, 'OPEN', { reason: 'waiting_for_native_workspace' });
  return ws;
}

/**
 * 强制立即创建新窗口来打开工作区
 * 适用于用户明确需要扩展创建窗口的场景
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<object|null>} 更新后的工作区对象
 */
async function forceCreateWorkspaceWindow(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;

  if (ws.windowId) {
    try {
      await chrome.windows.update(ws.windowId, { focused: true });
      return ws;
    } catch (error) {
      ws.windowId = null;
    }
  }

  // 创建新窗口
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

    // 去重：打开窗口时会触发 tabs.onCreated，可能重复写入标签页
    // 以真实标签页 ID 为键，保留原有顺序中的第一条记录
    const seenRealTabIds = new Set();
    ws.tabs = ws.tabs.filter((tab) => {
      if (!tab.realTabId) return true;
      if (seenRealTabIds.has(tab.realTabId)) {
        return false;
      }
      seenRealTabIds.add(tab.realTabId);
      return true;
    });

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
    // 窗口不存在或权限异常时，解除关联避免状态错误
    try {
      const data = await loadWorkspaces();
      const ws = data.workspaces.find(w => w.id === workspaceId);
      if (ws && ws.windowId) {
        ws.windowId = null;
        ws.tabs.forEach(tab => delete tab.realTabId);
        ws.updatedAt = nowIso();
        await saveWorkspaces(data);
      }
    } catch (clearError) {
      console.error('[Edge Workspace Manager] 清除窗口关联失败:', clearError);
    }
    return false;
  }
}

/**
 * 将工作区的影子数据同步到关联的 Edge 窗口
 * 用于“等待原生工作区打开”场景：窗口被检测到后，自动创建缺失标签页
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否同步成功
 */
async function syncWorkspaceToWindow(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.windowId) {
    console.warn('[Edge Workspace Manager] 工作区未关联窗口，无法反向同步');
    return false;
  }

  try {
    const chromeWindow = await chrome.windows.get(ws.windowId, { populate: true });
    if (!chromeWindow || !chromeWindow.tabs) {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      return false;
    }

    // 按规范化 URL 建立真实标签页索引
    const realTabsByUrl = new Map();
    chromeWindow.tabs.forEach(tab => {
      const key = normalizeUrl(tab.url);
      if (key) realTabsByUrl.set(key, tab);
    });

    const updatedTabs = [];

    // 确保工作区中的每个标签页都存在于真实窗口
    for (const wsTab of ws.tabs) {
      const key = normalizeUrl(wsTab.url);
      if (key && realTabsByUrl.has(key)) {
        const realTab = realTabsByUrl.get(key);
        wsTab.realTabId = realTab.id;
        wsTab.title = realTab.title || wsTab.title;
        wsTab.favIconUrl = realTab.favIconUrl || wsTab.favIconUrl;
        updatedTabs.push(wsTab);
        realTabsByUrl.delete(key);
      } else {
        // 在真实窗口中创建缺失标签页
        const newTab = await chrome.tabs.create({
          windowId: ws.windowId,
          url: wsTab.url,
          active: false
        });
        wsTab.realTabId = newTab.id;
        updatedTabs.push(wsTab);
      }
    }

    // 关闭真实窗口中不在工作区内的普通标签页（保留新标签页等空白页）
    for (const [url, realTab] of realTabsByUrl) {
      if (realTab.url && realTab.url !== 'edge://newtab/' && realTab.url !== 'about:blank' && !realTab.url.startsWith('chrome://newtab')) {
        await chrome.tabs.remove(realTab.id);
      }
    }

    ws.tabs = updatedTabs;
    ws.updatedAt = nowIso();
    // 同步完成后，待清理 URL 已无用，清除避免影响后续匹配
    console.log('[Edge Workspace Manager] syncWorkspaceToWindow cleanup check', workspaceId, ws.pendingCleanup);
    if (ws.pendingCleanup) {
      delete ws.pendingCleanup;
      console.log('[Edge Workspace Manager] syncWorkspaceToWindow pendingCleanup deleted', workspaceId);
    }
    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 工作区 ${workspaceId} 的影子数据已同步到窗口 ${ws.windowId}`);
    return true;
  } catch (error) {
    console.error('[Edge Workspace Manager] 反向同步工作区失败:', error);
    return false;
  }
}

/**
 * 应用指定工作区的所有待执行操作
 * 通常在窗口被关联后调用，实现延迟执行的打开/同步等意图
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否成功应用
 */
async function applyPendingOperations(workspaceId) {
  const operations = await getPendingOperations(workspaceId);
  if (operations.length === 0) return true;

  let success = true;
  for (const op of operations) {
    try {
      if (op.type === 'OPEN' || op.type === 'SYNC') {
        const synced = await syncWorkspaceToWindow(workspaceId);
        if (!synced) success = false;
      }
      // 后续可扩展更多操作类型，如 REMOVE_TAB、REORDER 等
    } catch (error) {
      console.error(`[Edge Workspace Manager] 应用待执行操作 ${op.id} 失败:`, error);
      success = false;
    }
  }

  await clearPendingOperations(workspaceId);
  return success;
}

/**
 * 将当前聚焦的浏览器窗口关联到指定工作区
 * 用于 Edge 原生按钮打开窗口后，手动建立扩展工作区与窗口的映射
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否关联成功
 */
async function associateCurrentWindow(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || ws.windowId) return false;

  try {
    // 获取最近一次聚焦的窗口
    const currentWindow = await chrome.windows.getLastFocused({ populate: true });
    if (!currentWindow || !currentWindow.tabs || currentWindow.tabs.length === 0) {
      console.warn('[Edge Workspace Manager] 未找到可关联的窗口');
      return false;
    }

    // 跳过管理面板窗口
    const panelUrl = chrome.runtime.getURL('popup.html');
    if (currentWindow.tabs.some(t => t.url && t.url.startsWith(panelUrl))) {
      console.warn('[Edge Workspace Manager] 不能关联管理面板窗口');
      return false;
    }

    associateWindowWithWorkspaceInternal(currentWindow, ws);
    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 工作区 ${workspaceId} 已关联到窗口 ${currentWindow.id}`);
    // 若此前有“等待原生工作区打开”的入队操作，立即应用
    await applyPendingOperations(workspaceId);
    return true;
  } catch (error) {
    console.error('[Edge Workspace Manager] 关联当前窗口失败:', error);
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
    syncWorkspaceToWindow,
    associateCurrentWindow,
    normalizeUrl,
    calculateWindowMatchScore,
    associateWindowWithWorkspaceInternal,
    tryAssociateWindowWithWorkspace,
    scanOpenWindowsAndAssociate,
    applyPendingOperations,
    queuePendingOperation,
    getPendingOperations,
    clearPendingOperations,
    hasPendingOperations,
    loadPendingOperations,
    savePendingOperations,
    forceCreateWorkspaceWindow,
    generateId,
    nowIso
  };
}
