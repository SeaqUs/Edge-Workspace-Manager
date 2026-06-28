/**
 * Edge Workspace Manager - Service Worker
 * 负责监听浏览器窗口/标签页事件，保持影子数据库与浏览器状态同步
 */


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

// 防止 syncWorkspaceToWindow 并发执行的锁集合
const syncWorkspaceLocks = new Set();

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
 * 获取工作区的待清理项目列表
 * 兼容旧结构（urls 为字符串数组）与新结构（urls 为对象数组，含 url 与 targetWorkspaceId）
 * @param {object} ws - 工作区对象
 * @returns {Array<{url:string, targetWorkspaceId:string|null}>}
 */
function getPendingCleanupItems(ws) {
  if (!ws || !ws.pendingCleanup || !Array.isArray(ws.pendingCleanup.urls)) return [];
  return ws.pendingCleanup.urls.map(item => {
    if (typeof item === 'string') {
      return { url: item, targetWorkspaceId: null };
    }
    return { url: item.url, targetWorkspaceId: item.targetWorkspaceId || null };
  }).filter(item => item.url);
}

/**
 * 判断工作区是否有待清理 URL
 * @param {object} ws - 工作区对象
 * @returns {boolean}
 */
function hasPendingCleanup(ws) {
  return getPendingCleanupItems(ws).length > 0;
}

/**
 * 计算浏览器窗口与工作区的标签页 URL 匹配度
 * @param {object} chromeWindow - 包含 tabs 的窗口对象
 * @param {object} ws - 工作区对象
 * @param {boolean} [includePendingCleanup=false] - 是否将待清理 URL 纳入匹配
 * @param {object[]} [allWorkspaces=null] - 全局工作区列表，用于排除移入标签页对匹配的干扰
 * @returns {number} 匹配度分数，范围 0-1
 */
function calculateWindowMatchScore(chromeWindow, ws, includePendingCleanup = false, allWorkspaces = null) {
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) return 0;
  if (!ws) return 0;

  const windowUrls = chromeWindow.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
  let wsUrls = (ws.tabs || []).map(t => normalizeUrl(t.url)).filter(Boolean);

  const logPayload = {
    windowId: chromeWindow.id,
    workspaceId: ws.id,
    includePendingCleanup,
    windowUrls,
    originalWsUrls: wsUrls
  };

  // 当提供全局工作区列表时，若当前工作区本身没有待清理 URL，
  // 则从当前工作区的匹配 URL 中排除"属于其他源工作区、且目标不是当前工作区"的 URL。
  // 这样可以避免目标工作区用刚移入的标签页去抢占源工作区窗口，
  // 同时保证标签页的合法目标工作区仍能正常匹配。
  if (allWorkspaces && !hasPendingCleanup(ws)) {
    const cleanupUrlsFromOthers = new Set();
    allWorkspaces.forEach(other => {
      if (other.id !== ws.id && hasPendingCleanup(other)) {
        getPendingCleanupItems(other).forEach(item => {
          // 只排除目标不是当前工作区的 URL；若目标为 null（旧数据兼容）也排除
          if (!item.targetWorkspaceId || item.targetWorkspaceId !== ws.id) {
            const normalized = normalizeUrl(item.url);
            if (normalized) cleanupUrlsFromOthers.add(normalized);
          }
        });
      }
    });
    wsUrls = wsUrls.filter(url => !cleanupUrlsFromOthers.has(url));
    logPayload.excludedCleanupUrls = Array.from(cleanupUrlsFromOthers);
  }

  // 仅在明确需要时把待清理 URL 纳入匹配，帮助识别原窗口
  if (includePendingCleanup && hasPendingCleanup(ws)) {
    // 从当前工作区标签页中排除从其他源移入的 URL。
    // 这些 URL 的源工作区 pendingCleanup 中目标指向当前工作区，
    // 在当前工作区的源窗口打开时这些标签页还不存在，
    // 因此不应作为识别源窗口的保留标签页要求。
    if (allWorkspaces) {
      const movedInUrls = new Set();
      allWorkspaces.forEach(other => {
        if (other.id === ws.id) return;
        if (hasPendingCleanup(other)) {
          getPendingCleanupItems(other).forEach(item => {
            if (item.targetWorkspaceId === ws.id) {
              const normalized = normalizeUrl(item.url);
              if (normalized) movedInUrls.add(normalized);
            }
          });
        }
      });
      wsUrls = wsUrls.filter(url => !movedInUrls.has(url));
      logPayload.movedInUrls = Array.from(movedInUrls);
    }

    const cleanupItems = getPendingCleanupItems(ws);
    const cleanupUrls = cleanupItems.map(item => normalizeUrl(item.url)).filter(Boolean);
    logPayload.cleanupUrls = cleanupUrls;

    if (cleanupUrls.length > 0) {
      const windowUrlSet = new Set(windowUrls);
      // 源工作区匹配时，要求窗口必须包含所有待清理 URL，
      // 避免只含部分移出标签页的窗口被错误关联为源窗口。
      const allCleanupMatched = cleanupUrls.every(url => windowUrlSet.has(url));
      if (!allCleanupMatched) {
        logPayload.result = 'allCleanupNotMatched';
        // // console.log('[calculateWindowMatchScore]', logPayload);
        return 0;
      }

      // 源工作区自身还有保留标签页时，要求窗口至少匹配到一个保留标签页，
      // 避免只含被移出 URL 的窗口被错认为源窗口。
      if (wsUrls.length > 0) {
        const hasMatchingTab = wsUrls.some(url => windowUrlSet.has(url));
        if (!hasMatchingTab) {
          logPayload.result = 'noRetainedTabMatched';
          // console.log('[calculateWindowMatchScore]', logPayload);
          return 0;
        }
      }

      wsUrls = wsUrls.concat(cleanupUrls);
    }
  }

  if (windowUrls.length === 0 || wsUrls.length === 0) {
    logPayload.result = 'emptyUrls';
    // console.log('[calculateWindowMatchScore]', logPayload);
    return 0;
  }

  const matched = windowUrls.filter(url => wsUrls.includes(url)).length;
  const score = matched / Math.max(windowUrls.length, wsUrls.length);
  logPayload.matchedCount = matched;
  logPayload.score = score.toFixed(4);
  logPayload.finalWsUrls = wsUrls;
  // console.log('[calculateWindowMatchScore]', logPayload);
  return score;
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

  // 记录每个规范化 URL 已使用过的真实标签页 ID，
  // 避免多个同 URL 影子标签页映射到同一个真实标签页。
  const usedRealTabIds = new Set();
  ws.tabs.forEach((tab) => {
    const chromeTab = chromeWindow.tabs.find(t => {
      const matched = normalizeUrl(t.url) === normalizeUrl(tab.url);
      return matched && !usedRealTabIds.has(t.id);
    });
    if (chromeTab) {
      tab.realTabId = chromeTab.id;
      usedRealTabIds.add(chromeTab.id);
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

  // 优先处理有待清理 URL 的工作区，避免目标工作区抢占原窗口。
  const unassociatedWorkspaces = data.workspaces.filter(ws => !ws.windowId);
  const sortedWorkspaces = unassociatedWorkspaces.slice().sort((a, b) => {
    return (hasPendingCleanup(b) ? 1 : 0) - (hasPendingCleanup(a) ? 1 : 0);
  });

  let bestMatch = null;
  let bestScore = 0;

  for (const ws of sortedWorkspaces) {
    // 使用统一匹配函数，传入全局工作区列表以自动排除移入标签页干扰
    const score = calculateWindowMatchScore(chromeWindow, ws, true, data.workspaces);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ws;
    }
  }

  // 匹配度达到阈值即可建立关联。由于 calculateWindowMatchScore 已排除
  // 目标工作区用移入标签页抢占源窗口的情况，因此可以使用 >= 阈值。
  if (bestMatch && bestScore >= WINDOW_MATCH_THRESHOLD) {
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
  const cleanupItems = getPendingCleanupItems(ws);
  if (cleanupItems.length === 0) return false;
  if (!chromeWindow || !chromeWindow.tabs || chromeWindow.tabs.length === 0) return false;

  const windowUrls = chromeWindow.tabs.map(t => normalizeUrl(t.url)).filter(Boolean);
  const cleanupUrls = cleanupItems.map(item => normalizeUrl(item.url)).filter(Boolean);
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

    // 第一轮：优先处理有待清理 URL 的工作区（标签页移出后的原工作区）。
    // 传入全局工作区列表后，calculateWindowMatchScore 对源工作区会纳入待清理 URL，
    // 对非源工作区会排除其他工作区待清理的 URL，避免目标工作区抢占原窗口。
    const workspacesWithCleanup = unassociatedWorkspaces.filter(ws => hasPendingCleanup(ws));
    for (const ws of workspacesWithCleanup) {
      let bestMatch = null;
      let bestScore = 0;

      for (const chromeWindow of normalWindows) {
        if (matchedWindowIds.has(chromeWindow.id)) continue;

        const score = calculateWindowMatchScore(chromeWindow, ws, true, data.workspaces);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = chromeWindow;
        }
      }

      // 源工作区达到阈值即可关联。由于非源工作区的移入 URL 已被排除，
      // 不会再出现目标工作区用单个移入 URL 抢占原窗口的情况。
      if (bestMatch && bestScore >= WINDOW_MATCH_THRESHOLD) {
        associateWindowWithWorkspaceInternal(bestMatch, ws);
        ws.updatedAt = nowIso();
        matchedWindowIds.add(bestMatch.id);
        associatedCount++;
      }
    }

    // 第二轮：处理普通工作区，使用当前标签页 URL 匹配（已排除其他工作区待清理 URL）。
    for (const ws of unassociatedWorkspaces) {
      if (ws.windowId || matchedWindowIds.has(ws.windowId)) continue;

      let bestMatch = null;
      let bestScore = 0;

      for (const chromeWindow of normalWindows) {
        if (matchedWindowIds.has(chromeWindow.id)) continue;

        const score = calculateWindowMatchScore(chromeWindow, ws, false, data.workspaces);
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

    // 第三轮 fallback：对于仍有待执行操作且未关联的工作区，
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

        const score = calculateWindowMatchScore(chromeWindow, ws, true, data.workspaces);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = chromeWindow;
        }
      }

      // 没有 URL 线索时不强行关联，避免误连到不相关的窗口。
      // 带 pendingCleanup 的源工作区仍使用严格大于阈值，避免抢占目标窗口。
      const hasCleanupMatch = bestMatch && windowContainsPendingCleanupUrls(bestMatch, ws);
      if (bestMatch && (bestScore > WINDOW_MATCH_THRESHOLD || (!hasCleanupMatch && bestScore > 0))) {
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
  // 标签页已属于新工作区，旧的 realTabId 必须清除，
  // 后续由 syncWorkspaceToWindow 根据目标窗口重新建立映射
  delete movedTab.realTabId;
  targetWs.tabs.push(movedTab);
  sourceWs.updatedAt = nowIso();
  targetWs.updatedAt = nowIso();

  // 源窗口未打开时，记录待清理 URL 及目标工作区 ID，并入队 SYNC 意图，
  // 等源窗口被检测到后自动关闭已移出的标签页。
  if (!sourceWs.windowId) {
    if (!sourceWs.pendingCleanup) {
      sourceWs.pendingCleanup = { urls: [], createdAt: nowIso() };
    }
    sourceWs.pendingCleanup.urls.push({ url: movedTab.url, targetWorkspaceId: targetWorkspaceId });
    sourceWs.pendingCleanup.createdAt = nowIso();
    console.log(`[moveTabToWorkspace] 源工作区 ${sourceWs.id} 待清理项更新:`, sourceWs.pendingCleanup);
    if (!(await hasPendingOperations(sourceWorkspaceId))) {
      await queuePendingOperation(sourceWorkspaceId, 'SYNC', { reason: 'tabs_moved_out' });
    }
  }

  // 目标窗口未打开且有待同步内容时，入队 OPEN 意图，
  // 等目标窗口被检测到后自动创建移入的标签页。
  if (!targetWs.windowId && targetWs.tabs.length > 0 && !(await hasPendingOperations(targetWorkspaceId))) {
    await queuePendingOperation(targetWorkspaceId, 'OPEN', { reason: 'tabs_moved_in' });
  }

  // 先保存影子数据库，确保后续 syncWorkspaceToWindow 读到的是已移动后的状态
  await saveWorkspaces(data);

  // 若源/目标窗口已经打开，直接通过反向同步创建或关闭真实标签页。
  // 这种方式统一使用“创建/关闭”而非 chrome.tabs.move，避免 tabs 事件干扰。
  if (sourceWs.windowId) {
    try {
      await syncWorkspaceToWindow(sourceWorkspaceId);
    } catch (error) {
      console.error('[Edge Workspace Manager] 同步源工作区窗口失败:', error);
    }
  }

  if (targetWs.windowId) {
    try {
      await syncWorkspaceToWindow(targetWorkspaceId);
    } catch (error) {
      console.error('[Edge Workspace Manager] 同步目标工作区窗口失败:', error);
    }
  }

  return true;
}

/**
 * 批量移动标签页到另一个工作区
 * 适用于从同一个源工作区一次性移动多个标签页到同一目标工作区
 * @param {string[]} tabIds - 标签页内部 ID 数组
 * @param {string} sourceWorkspaceId - 源工作区 ID
 * @param {string} targetWorkspaceId - 目标工作区 ID
 * @returns {Promise<boolean>} 是否全部移动成功
 */
async function moveTabsToWorkspace(tabIds, sourceWorkspaceId, targetWorkspaceId) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return false;
  if (sourceWorkspaceId === targetWorkspaceId) return false;

  const moves = tabIds.map(tabId => ({
    tabId,
    sourceWorkspaceId,
    targetWorkspaceId
  }));
  return moveTabsToWorkspaces(moves);
}

/**
 * 批量移动标签页到多个目标工作区
 * 支持一对多（同一源到多目标）、多对一（多源到同一目标）以及多对多等组合
 * @param {Array<{tabId:string, sourceWorkspaceId:string, targetWorkspaceId:string}>} moves - 移动计划
 * @returns {Promise<boolean>} 是否至少有一条移动成功
 */
async function moveTabsToWorkspaces(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return false;

  const data = await loadWorkspaces();
  const affectedSourceIds = new Set();
  const affectedTargetIds = new Set();
  const queuedSyncIds = new Set();
  const queuedOpenIds = new Set();

  // 按源工作区分组，并按原索引倒序处理，避免多次 splice 相互影响
  const movesBySource = new Map();
  const moveKeySet = new Set();

  for (const move of moves) {
    if (!move || move.sourceWorkspaceId === move.targetWorkspaceId) continue;

    const sourceWs = data.workspaces.find(w => w.id === move.sourceWorkspaceId);
    const targetWs = data.workspaces.find(w => w.id === move.targetWorkspaceId);
    if (!sourceWs || !targetWs) continue;

    const tab = sourceWs.tabs.find(t => t.id === move.tabId);
    if (!tab) continue;

    // 去重：同一标签页在同一源工作区只能移动一次
    const key = `${move.sourceWorkspaceId}:${move.tabId}`;
    if (moveKeySet.has(key)) continue;
    moveKeySet.add(key);

    if (!movesBySource.has(move.sourceWorkspaceId)) {
      movesBySource.set(move.sourceWorkspaceId, []);
    }
    movesBySource.get(move.sourceWorkspaceId).push({ move, sourceWs, targetWs, tab });
  }

  if (movesBySource.size === 0) return false;

  for (const [, sourceMoves] of movesBySource) {
    sourceMoves.sort((a, b) => {
      const idxA = a.sourceWs.tabs.indexOf(a.tab);
      const idxB = b.sourceWs.tabs.indexOf(b.tab);
      return idxB - idxA;
    });

    for (const { move, sourceWs, targetWs, tab } of sourceMoves) {
      const tabIndex = sourceWs.tabs.indexOf(tab);
      if (tabIndex === -1) continue;

      sourceWs.tabs.splice(tabIndex, 1);
      tab.groupId = null; // 移动到新区后清除原分组关联
      // 标签页已属于新工作区，旧的 realTabId 必须清除
      delete tab.realTabId;
      targetWs.tabs.push(tab);
      sourceWs.updatedAt = nowIso();
      targetWs.updatedAt = nowIso();

      // 源窗口未打开时，记录待清理 URL 及目标工作区 ID，
      // 等源窗口被检测到后自动关闭已移出的标签页。
      if (!sourceWs.windowId) {
        if (!sourceWs.pendingCleanup) {
          sourceWs.pendingCleanup = { urls: [], createdAt: nowIso() };
        }
        sourceWs.pendingCleanup.urls.push({ url: tab.url, targetWorkspaceId: move.targetWorkspaceId });
        sourceWs.pendingCleanup.createdAt = nowIso();
        console.log(`[moveTabsToWorkspaces] 源工作区 ${sourceWs.id} 待清理项更新:`, sourceWs.pendingCleanup);
      }

      // 目标窗口未打开时，仅入队一次 OPEN 意图
      if (!targetWs.windowId && !queuedOpenIds.has(targetWs.id)) {
        if (!(await hasPendingOperations(targetWs.id))) {
          await queuePendingOperation(targetWs.id, 'OPEN', { reason: 'tabs_moved_in' });
        }
        queuedOpenIds.add(targetWs.id);
      }

      affectedSourceIds.add(sourceWs.id);
      affectedTargetIds.add(targetWs.id);
    }

    // 源工作区未打开时，仅入队一次 SYNC 意图，用于后续关闭已移出标签页
    const firstSourceMove = sourceMoves[0];
    const sourceWs = firstSourceMove.sourceWs;
    if (!sourceWs.windowId && !queuedSyncIds.has(sourceWs.id)) {
      if (!(await hasPendingOperations(sourceWs.id))) {
        await queuePendingOperation(sourceWs.id, 'SYNC', { reason: 'tabs_moved_out' });
      }
      queuedSyncIds.add(sourceWs.id);
    }
  }

  await saveWorkspaces(data);

  // 对已打开的受影响工作区执行反向同步，立即反映移动结果
  for (const sourceId of affectedSourceIds) {
    const ws = data.workspaces.find(w => w.id === sourceId);
    if (ws && ws.windowId) {
      try {
        await syncWorkspaceToWindow(sourceId);
      } catch (error) {
        console.error('[Edge Workspace Manager] 批量移动后同步源工作区窗口失败:', error);
      }
    }
  }

  for (const targetId of affectedTargetIds) {
    const ws = data.workspaces.find(w => w.id === targetId);
    if (ws && ws.windowId) {
      try {
        await syncWorkspaceToWindow(targetId);
      } catch (error) {
        console.error('[Edge Workspace Manager] 批量移动后同步目标工作区窗口失败:', error);
      }
    }
  }

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
  // 防止多个流程同时反向同步同一个工作区，避免重复创建标签页
  if (syncWorkspaceLocks.has(workspaceId)) {
    console.log(`[Edge Workspace Manager] 工作区 ${workspaceId} 反向同步已在进行中，跳过本次调用`);
    return false;
  }
  syncWorkspaceLocks.add(workspaceId);

  try {
    const data = await loadWorkspaces();
    const ws = data.workspaces.find(w => w.id === workspaceId);
    if (!ws || !ws.windowId) {
      console.warn('[Edge Workspace Manager] 工作区未关联窗口，无法反向同步');
      return false;
    }

    const chromeWindow = await chrome.windows.get(ws.windowId, { populate: true });
    if (!chromeWindow || !chromeWindow.tabs) {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      return false;
    }

    // 按规范化 URL 建立真实标签页索引，每个 URL 可能对应多个真实标签页
    const realTabsByUrl = new Map();
    chromeWindow.tabs.forEach(tab => {
      const key = normalizeUrl(tab.url);
      if (key) {
        if (!realTabsByUrl.has(key)) {
          realTabsByUrl.set(key, []);
        }
        realTabsByUrl.get(key).push(tab);
      }
    });

    const updatedTabs = [];

    // 确保工作区中的每个标签页都存在于真实窗口
    console.log('[TEST_DEBUG] syncWorkspaceToWindow start', workspaceId, 'windowId', ws.windowId, 'realTabs', chromeWindow.tabs.map(t => t.url), 'wsTabs', ws.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })));
    for (const wsTab of ws.tabs) {
      const key = normalizeUrl(wsTab.url);
      console.log('[TEST_DEBUG] syncWorkspaceToWindow processing', wsTab.url, 'key', key, 'realTabsByUrl count', realTabsByUrl.has(key) ? realTabsByUrl.get(key).length : 0);
      if (key && realTabsByUrl.has(key) && realTabsByUrl.get(key).length > 0) {
        // 取出一个同 URL 的真实标签页进行复用
        const realTabs = realTabsByUrl.get(key);
        const realTab = realTabs.shift();
        wsTab.realTabId = realTab.id;
        wsTab.title = realTab.title || wsTab.title;
        wsTab.favIconUrl = realTab.favIconUrl || wsTab.favIconUrl;
        updatedTabs.push(wsTab);
        console.log('[TEST_DEBUG] syncWorkspaceToWindow reuse realTab', realTab.id, realTab.url, 'for', wsTab.url);
        if (realTabs.length === 0) {
          realTabsByUrl.delete(key);
        }
      } else {
        // 在真实窗口中创建缺失标签页
        console.log('[TEST_DEBUG] syncWorkspaceToWindow create tab', wsTab.url, 'in window', ws.windowId);
        const newTab = await chrome.tabs.create({
          windowId: ws.windowId,
          url: wsTab.url,
          active: false
        });
        wsTab.realTabId = newTab.id;
        updatedTabs.push(wsTab);
        console.log('[TEST_DEBUG] syncWorkspaceToWindow created tab', newTab.id, newTab.url, 'in window', newTab.windowId);
      }
    }

    // 关闭真实窗口中不在工作区内的普通标签页（保留新标签页等空白页）
    for (const [url, realTabs] of realTabsByUrl) {
      for (const realTab of realTabs) {
        if (realTab.url && realTab.url !== 'edge://newtab/' && realTab.url !== 'about:blank' && !realTab.url.startsWith('chrome://newtab')) {
          await chrome.tabs.remove(realTab.id);
        }
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
  } finally {
    syncWorkspaceLocks.delete(workspaceId);
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
    moveTabsToWorkspace,
    moveTabsToWorkspaces,
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

/**
 * 监听窗口创建事件：尝试将新窗口与未关联的工作区自动匹配
 * 当用户通过 Edge 原生按钮打开工作区时，窗口会恢复为普通窗口，
 * 我们按标签页 URL 相似度进行启发式关联
 */
chrome.windows.onCreated.addListener(async (chromeWindow) => {
  try {
    if (!chromeWindow || !chromeWindow.id) return;

    // 跳过管理面板窗口
    const panelUrlPrefix = chrome.runtime.getURL('popup.html');
    if (chromeWindow.tabs && chromeWindow.tabs.some(t => t.url && t.url.startsWith(panelUrlPrefix))) {
      return;
    }

    // 延迟获取完整标签页信息，创建事件触发时 tabs 可能尚未完全加载
    setTimeout(async () => {
      try {
        const fullWindow = await chrome.windows.get(chromeWindow.id, { populate: true });
        await tryAssociateWindowWithWorkspace(fullWindow);
      } catch (error) {
        console.warn('[Edge Workspace Manager] 获取新建窗口详情失败:', error);
      }
    }, 500);
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理窗口创建事件失败:', error);
  }
});

// 焦点切换扫描防抖定时器
let focusScanTimeout = null;

/**
 * 监听窗口焦点变化：当存在未关联的工作区时，尝试自动扫描当前打开窗口
 * 这对用户通过 Edge 原生工作区按钮切换窗口的场景尤为重要
 */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  // 防抖：频繁切换时只在最后一次停顿后执行
  if (focusScanTimeout) clearTimeout(focusScanTimeout);
  focusScanTimeout = setTimeout(async () => {
    try {
      const data = await loadWorkspaces();
      const hasUnassociated = data.workspaces.some(ws => !ws.windowId);
      if (!hasUnassociated) return;

      const result = await scanOpenWindowsAndAssociate();
      if (result.associated > 0) {
        console.log(`[Edge Workspace Manager] 焦点切换后自动关联 ${result.associated} 个窗口`);
      }
    } catch (error) {
      console.error('[Edge Workspace Manager] 焦点切换扫描失败:', error);
    }
  }, 300);
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
      } else {
        // 未找到已记录的真实标签页，可能是同步期间创建的标签页尚未设置 realTabId，
        // 或是用户新建标签页后首次完成加载。尝试按 URL 补录，避免重复创建。
        const normalizedUrl = normalizeUrl(tab.url);
        const matchingUrlTab = normalizedUrl
          ? ws.tabs.find(t => !t.realTabId && normalizeUrl(t.url) === normalizedUrl)
          : null;
        if (matchingUrlTab) {
          matchingUrlTab.realTabId = tab.id;
          matchingUrlTab.title = tab.title || matchingUrlTab.title;
          matchingUrlTab.favIconUrl = tab.favIconUrl || matchingUrlTab.favIconUrl;
          matchingUrlTab.url = tab.url || matchingUrlTab.url;
          matchingUrlTab.updatedAt = nowIso();
          ws.updatedAt = nowIso();
          changed = true;
        } else if (tab.url && normalizedUrl) {
          // 确为新增标签页，补充到影子数据库
          let hostname = '';
          try {
            hostname = new URL(tab.url).hostname;
          } catch (error) {
            // 忽略无效 URL
          }
          ws.tabs.push({
            id: generateId('tab'),
            url: tab.url,
            title: tab.title || tab.url || '新标签页',
            favIconUrl: tab.favIconUrl || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
            groupId: null,
            pinned: tab.pinned || false,
            realTabId: tab.id,
            createdAt: nowIso()
          });
          ws.updatedAt = nowIso();
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
 * 监听标签页创建事件：在工作区窗口中新增标签页时同步到影子数据库
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.windowId) return;

  try {
    const data = await loadWorkspaces();
    const ws = data.workspaces.find(w => w.windowId === tab.windowId);
    if (!ws) return;

    // 去重：若影子数据库中已存在相同真实标签页 ID，则不再追加。
    const existingById = ws.tabs.find(t => t.realTabId === tab.id);
    if (existingById) {
      return;
    }

    // 若标签页刚创建且 URL 尚未确定（例如通过 chrome.tabs.create 创建但尚未加载），
    // 不立即写入影子数据库，避免与 syncWorkspaceToWindow 创建的标签页产生重复。
    // 后续由 tabs.onUpdated 在页面加载完成后再补充。
    const normalizedNewUrl = normalizeUrl(tab.url);
    if (!normalizedNewUrl) {
      console.log(`[Edge Workspace Manager] 标签页 ${tab.id} 创建时 URL 未就绪，延迟处理`);
      return;
    }

    // 若存在相同 URL 但尚未记录真实标签页 ID 的影子标签页，
    // 则把该真实标签页 ID 补录进去，避免 syncWorkspaceToWindow 再次创建。
    const matchingUrlTab = ws.tabs.find(t => !t.realTabId && normalizeUrl(t.url) === normalizedNewUrl);
    if (matchingUrlTab) {
      matchingUrlTab.realTabId = tab.id;
      matchingUrlTab.title = tab.title || matchingUrlTab.title;
      matchingUrlTab.favIconUrl = tab.favIconUrl || matchingUrlTab.favIconUrl;
      matchingUrlTab.updatedAt = nowIso();
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      return;
    }

    let hostname = '';
    try {
      if (tab.url) {
        hostname = new URL(tab.url).hostname;
      }
    } catch (error) {
      // 忽略无效 URL
    }

    ws.tabs.push({
      id: generateId('tab'),
      url: tab.url || 'edge://newtab/',
      title: tab.title || tab.url || '新标签页',
      favIconUrl: tab.favIconUrl || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
      groupId: null,
      pinned: tab.pinned || false,
      realTabId: tab.id,
      createdAt: nowIso()
    });
    ws.updatedAt = nowIso();

    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 标签页 ${tab.id} 已创建，同步更新影子数据库`);
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页创建事件失败:', error);
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
        const pending = ws ? await hasPendingOperations(request.workspaceId) : false;
        sendResponse({ success: !!ws, workspace: ws, pending });
        break;
      }

      case 'FORCE_CREATE_WORKSPACE_WINDOW': {
        const ws = await forceCreateWorkspaceWindow(request.workspaceId);
        sendResponse({ success: !!ws, workspace: ws });
        break;
      }

      case 'CLOSE_WORKSPACE': {
        const ok = await closeWorkspace(request.workspaceId);
        sendResponse({ success: ok });
        break;
      }

      case 'GET_PENDING_OPERATIONS': {
        const ops = await getPendingOperations(request.workspaceId);
        sendResponse({ success: true, operations: ops });
        break;
      }

      case 'GET_ALL_PENDING_WORKSPACE_IDS': {
        const ops = await loadPendingOperations();
        const ids = Object.keys(ops).filter(id => ops[id] && ops[id].length > 0);
        sendResponse({ success: true, workspaceIds: ids });
        break;
      }

      case 'CLEAR_PENDING_OPERATIONS': {
        await clearPendingOperations(request.workspaceId);
        sendResponse({ success: true });
        break;
      }

      case 'ASSOCIATE_CURRENT_WINDOW': {
        const ok = await associateCurrentWindow(request.workspaceId);
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

      case 'MOVE_TABS': {
        const ok = await moveTabsToWorkspaces(request.moves);
        sendResponse({ success: ok });
        break;
      }

      case 'REORDER_TAB': {
        const ok = await reorderTab(
          request.workspaceId,
          request.tabId,
          request.targetIndex
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

      case 'IMPORT_ALL_WINDOWS': {
        const imported = await importAllWindows();
        sendResponse({ success: imported.length > 0, workspaces: imported, count: imported.length });
        break;
      }

      case 'GET_OPEN_WINDOWS': {
        const windows = await getOpenWindows();
        sendResponse({ success: true, windows });
        break;
      }

      case 'IMPORT_SELECTED_WINDOWS': {
        const imported = await importSelectedWindows(request.windowIds);
        sendResponse({ success: imported.length > 0, workspaces: imported, count: imported.length });
        break;
      }

      case 'SYNC_WORKSPACE': {
        const ok = await syncWorkspaceFromWindow(request.workspaceId);
        sendResponse({ success: ok });
        break;
      }

      case 'SCAN_AND_ASSOCIATE_WINDOWS': {
        const result = await scanOpenWindowsAndAssociate();
        sendResponse({
          success: true,
          associated: result.associated,
          unmatchedWindows: result.unmatchedWindows
        });
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

/**
 * 点击扩展图标时，在独立窗口中打开管理面板
 * 使用新窗口替代默认 popup，以获得更大操作空间
 */
chrome.action.onClicked.addListener(async () => {
  try {
    const panelUrl = chrome.runtime.getURL('popup.html');

    // 若已有管理面板窗口，则聚焦而不是重复创建
    const existing = await chrome.windows.getAll({ populate: true });
    const panelWindow = existing.find(w =>
      w.tabs && w.tabs.some(t => t.url && t.url.startsWith(panelUrl))
    );

    if (panelWindow) {
      await chrome.windows.update(panelWindow.id, { focused: true });
      return;
    }

    await chrome.windows.create({
      url: panelUrl,
      type: 'normal',
      width: 900,
      height: 700,
      focused: true
    });
  } catch (error) {
    console.error('[Edge Workspace Manager] 打开管理窗口失败:', error);
  }
});
