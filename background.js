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

// 窗口关联流程互斥锁，防止 tryAssociateWindowWithWorkspace 与 scanOpenWindowsAndAssociate 并发执行导致状态混乱
let windowAssociationLock = Promise.resolve();

/**
 * 获取窗口关联流程的互斥锁
 * @returns {Promise<function>} 释放锁的函数
 */
async function acquireAssociationLock() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const previous = windowAssociationLock;
  windowAssociationLock = windowAssociationLock.then(() => promise);
  await previous;
  return release;
}

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
  // 注意：若同一个 URL 也被标记为移入当前工作区，则该 URL 对当前工作区是合法的，
  // 不应被排除（例如同一 URL 被分别移入 A 和 C 时，A 和 C 都应保留该 URL 用于匹配）。
  if (allWorkspaces && !hasPendingCleanup(ws)) {
    const movedInUrls = new Set();
    const cleanupUrlsFromOthers = new Set();
    allWorkspaces.forEach(other => {
      if (other.id !== ws.id && hasPendingCleanup(other)) {
        getPendingCleanupItems(other).forEach(item => {
          const normalized = normalizeUrl(item.url);
          if (!normalized) return;
          if (item.targetWorkspaceId === ws.id) {
            movedInUrls.add(normalized);
          } else if (!item.targetWorkspaceId || item.targetWorkspaceId !== ws.id) {
            cleanupUrlsFromOthers.add(normalized);
          }
        });
      }
    });
    // 从待排除集合中移除合法移入当前工作区的 URL
    movedInUrls.forEach(url => cleanupUrlsFromOthers.delete(url));
    wsUrls = wsUrls.filter(url => !cleanupUrlsFromOthers.has(url));
    logPayload.excludedCleanupUrls = Array.from(cleanupUrlsFromOthers);
    logPayload.movedInUrls = Array.from(movedInUrls);
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
        console.log('[calculateWindowMatchScore]', logPayload);
        return 0;
      }

      // 源工作区自身还有保留标签页时，要求窗口至少匹配到一个保留标签页，
      // 避免只含被移出 URL 的窗口被错认为源窗口。
      if (wsUrls.length > 0) {
        const hasMatchingTab = wsUrls.some(url => windowUrlSet.has(url));
        if (!hasMatchingTab) {
          logPayload.result = 'noRetainedTabMatched';
          console.log('[calculateWindowMatchScore]', logPayload);
          return 0;
        }
      }

      wsUrls = wsUrls.concat(cleanupUrls);
    }
  }

  if (windowUrls.length === 0 || wsUrls.length === 0) {
    logPayload.result = 'emptyUrls';
    // 空 URL 场景较常见，仅在调试时关注；避免大样本测试日志爆炸
    return 0;
  }

  const matched = windowUrls.filter(url => wsUrls.includes(url)).length;
  const score = matched / Math.max(windowUrls.length, wsUrls.length);
  logPayload.matchedCount = matched;
  logPayload.score = score.toFixed(4);
  logPayload.finalWsUrls = wsUrls;
  // 仅当存在匹配或涉及待清理 URL 时输出，避免无意义日志淹没控制台
  if (score > 0 || hasPendingCleanup(ws)) {
    console.log('[calculateWindowMatchScore]', logPayload);
  }
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

  const releaseLock = await acquireAssociationLock();
  const associateStartTime = performance.now();
  try {
    const data = await loadWorkspaces();

    // 若窗口已与其他工作区关联，则不再尝试重新关联，避免多个工作区绑定同一窗口。
    const associatedWindowIds = new Set(data.workspaces.map(ws => ws.windowId).filter(Boolean));
    if (associatedWindowIds.has(chromeWindow.id)) {
      console.log(`[tryAssociateWindowWithWorkspace] 窗口 ${chromeWindow.id} 已关联其他工作区，跳过`);
      return false;
    }

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
      const associateElapsed = (performance.now() - associateStartTime).toFixed(2);
      console.log(`[Edge Workspace Manager] 窗口 ${chromeWindow.id} 已自动关联到工作区 ${bestMatch.id}，匹配度 ${(bestScore * 100).toFixed(0)}%，耗时 ${associateElapsed}ms`);
      // 若此前用户通过面板触发了“打开”等操作，现在应用待执行队列
      await applyPendingOperations(bestMatch.id);
      return true;
    }

    const associateElapsed = (performance.now() - associateStartTime).toFixed(2);
    console.log(`[tryAssociateWindowWithWorkspace] 窗口 ${chromeWindow.id} 未找到匹配工作区，耗时 ${associateElapsed}ms`);
    return false;
  } finally {
    releaseLock();
  }
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
  const releaseLock = await acquireAssociationLock();
  const scanStartTime = performance.now();
  try {
    const data = await loadWorkspaces();
    const unassociatedWorkspaces = data.workspaces.filter(ws => !ws.windowId);
    console.log(`[scanOpenWindowsAndAssociate] 开始扫描，未关联工作区 ${unassociatedWorkspaces.length} 个`);
    if (unassociatedWorkspaces.length === 0) {
      return { associated: 0, unmatchedWindows: [] };
    }

    const allWindows = await chrome.windows.getAll({ populate: true });
    // 排除已与其他工作区关联的窗口，避免未关联工作区抢占已有窗口，
    // 这在多工作区移入/移出后分次打开时尤为重要。
    const associatedWindowIds = new Set(data.workspaces.map(ws => ws.windowId).filter(Boolean));
    const normalWindows = allWindows.filter(w => w.type === 'normal' && w.tabs && w.tabs.length > 0 && !associatedWindowIds.has(w.id));

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

    // 第二轮：处理普通工作区（目标工作区），使用当前标签页 URL 匹配（已排除其他工作区待清理 URL）。
    // 为避免多个目标工作区竞争同一窗口导致串绑，先计算所有候选配对并按匹配度降序排序，
    // 为每个窗口选择匹配度最高的工作区；同时提高阈值到严格阈值，降低误关联概率。
    const targetMatchCandidates = [];
    for (const ws of unassociatedWorkspaces) {
      if (ws.windowId || matchedWindowIds.has(ws.windowId)) continue;

      for (const chromeWindow of normalWindows) {
        if (matchedWindowIds.has(chromeWindow.id)) continue;

        const score = calculateWindowMatchScore(chromeWindow, ws, false, data.workspaces);
        if (score >= WINDOW_MATCH_THRESHOLD_STRICT) {
          targetMatchCandidates.push({ ws, chromeWindow, score });
        }
      }
    }

    // 按匹配度降序处理，确保高匹配度的工作区优先占用窗口
    targetMatchCandidates.sort((a, b) => b.score - a.score);
    for (const { ws, chromeWindow, score } of targetMatchCandidates) {
      if (ws.windowId || matchedWindowIds.has(ws.windowId) || matchedWindowIds.has(chromeWindow.id)) continue;

      associateWindowWithWorkspaceInternal(chromeWindow, ws);
      ws.updatedAt = nowIso();
      matchedWindowIds.add(chromeWindow.id);
      associatedCount++;
      console.log(`[scanOpenWindowsAndAssociate] 目标工作区 ${ws.id} 以匹配度 ${(score * 100).toFixed(0)}% 关联到窗口 ${chromeWindow.id}`);
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
      // 必须使用至少 WINDOW_MATCH_THRESHOLD 的匹配度，防止仅有单个 URL 相同就抢占窗口，
      // 这在多工作区间标签页 URL 部分重叠时尤为重要。
      if (bestMatch && bestScore >= WINDOW_MATCH_THRESHOLD) {
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

    const scanElapsed = (performance.now() - scanStartTime).toFixed(2);
    console.log(`[scanOpenWindowsAndAssociate] 扫描完成，关联 ${associatedCount} 个工作区，剩余未匹配窗口 ${unmatchedWindows.length} 个，耗时 ${scanElapsed}ms`);
    return { associated: associatedCount, unmatchedWindows };
  } catch (error) {
    console.error('[Edge Workspace Manager] 扫描窗口关联失败:', error);
    return { associated: 0, unmatchedWindows: [] };
  } finally {
    releaseLock();
  }
}

/**
 * 创建新工作区从 chrome.storage.local 读取工作区数据
 * @returns {Promise<object>} 完整工作区数据对象
 */
async function loadWorkspaces() {
  const loadStartTime = performance.now();
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    // 若无数据则返回默认结构副本
    if (!result[STORAGE_KEY]) {
      return { ...DEFAULT_DATA };
    }
    const loadElapsed = performance.now() - loadStartTime;
    // 仅当读取耗时超过 1ms 时输出性能日志，避免大样本测试日志爆炸
    if (loadElapsed > 1) {
      console.log(`[loadWorkspaces] 读取存储完成，工作区数 ${result[STORAGE_KEY].workspaces.length}，耗时 ${loadElapsed.toFixed(2)}ms`);
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
  const saveStartTime = performance.now();
  try {
    data.lastUpdated = nowIso();
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
    const saveElapsed = performance.now() - saveStartTime;
    // 仅当保存耗时超过 1ms 时输出性能日志，避免大样本测试日志爆炸
    if (saveElapsed > 1) {
      console.log(`[saveWorkspaces] 保存存储完成，工作区数 ${data.workspaces.length}，标签页总数 ${data.workspaces.reduce((sum, ws) => sum + (ws.tabs ? ws.tabs.length : 0), 0)}，耗时 ${saveElapsed.toFixed(2)}ms`);
    }
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
  console.log(`[queuePendingOperation] 工作区 ${workspaceId} 准备入队操作 ${type}`);
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
  const startTime = performance.now();
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
  const elapsed = (performance.now() - startTime).toFixed(2);
  console.log(`[createWorkspace] 已创建工作区 ${newWorkspace.id}（${newWorkspace.name}），当前工作区总数 ${data.workspaces.length}，耗时 ${elapsed}ms`);
  return newWorkspace;
}

/**
 * 根据 ID 删除工作区，若窗口已打开则关闭窗口
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function deleteWorkspace(workspaceId) {
  const startTime = performance.now();
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) {
    console.warn(`[deleteWorkspace] 未找到工作区 ${workspaceId}`);
    return false;
  }

  // 若窗口仍打开，尝试关闭浏览器窗口
  if (ws.windowId) {
    try {
      await chrome.windows.remove(ws.windowId);
      console.log(`[deleteWorkspace] 已关闭工作区 ${workspaceId} 关联的窗口 ${ws.windowId}`);
    } catch (error) {
      // 窗口可能已被用户手动关闭，忽略异常
      console.warn('[Edge Workspace Manager] 关闭窗口失败，可能已关闭:', error);
    }
  }

  data.workspaces = data.workspaces.filter(w => w.id !== workspaceId);
  await saveWorkspaces(data);
  const elapsed = (performance.now() - startTime).toFixed(2);
  console.log(`[deleteWorkspace] 已删除工作区 ${workspaceId}（${ws.name}），剩余工作区 ${data.workspaces.length}，耗时 ${elapsed}ms`);
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
  if (!ws) {
    console.warn(`[updateWorkspaceName] 未找到工作区 ${workspaceId}`);
    return null;
  }

  const oldName = ws.name;
  ws.name = newName.trim() || ws.name;
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  console.log(`[updateWorkspaceName] 工作区 ${workspaceId} 名称从 "${oldName}" 更新为 "${ws.name}"`);
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
  if (!url || !url.trim()) {
    console.warn('[addTabToWorkspace] URL 为空，跳过添加');
    return null;
  }

  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) {
    console.warn(`[addTabToWorkspace] 未找到工作区 ${workspaceId}`);
    return null;
  }

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
  console.log(`[addTabToWorkspace] 已向工作区 ${workspaceId} 添加标签页 ${newTab.id}（${newTab.url}），当前标签页数 ${ws.tabs.length}`);

  // 若工作区窗口已打开，实际在窗口中创建标签页
  if (ws.windowId) {
    try {
      await chrome.tabs.create({ url: newTab.url, windowId: ws.windowId });
      console.log(`[addTabToWorkspace] 已在工作区 ${workspaceId} 的窗口中创建真实标签页`);
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
  if (!ws) {
    console.warn(`[removeTabFromWorkspace] 未找到工作区 ${workspaceId}`);
    return false;
  }

  const tabIndex = ws.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) {
    console.warn(`[removeTabFromWorkspace] 工作区 ${workspaceId} 中未找到标签页 ${tabId}`);
    return false;
  }

  const [removedTab] = ws.tabs.splice(tabIndex, 1);
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  console.log(`[removeTabFromWorkspace] 已从工作区 ${workspaceId} 移除标签页 ${tabId}（${removedTab.url}），剩余标签页 ${ws.tabs.length}`);

  // 若窗口已打开，尝试关闭对应的真实标签页
  if (ws.windowId && removedTab.realTabId) {
    try {
      await chrome.tabs.remove(removedTab.realTabId);
      console.log(`[removeTabFromWorkspace] 已关闭真实标签页 ${removedTab.realTabId}`);
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

  const moveStartTime = performance.now();
  console.log(`[moveTabToWorkspace] 开始移动标签页 ${tabId} 从 ${sourceWorkspaceId} 到 ${targetWorkspaceId}`);

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

  const moveElapsed = (performance.now() - moveStartTime).toFixed(2);
  console.log(`[moveTabToWorkspace] 标签页 ${tabId} 移动完成，耗时 ${moveElapsed}ms`);
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

  const startTime = performance.now();
  console.log(`[moveTabsToWorkspaces] 开始批量移动，共 ${moves.length} 条移动计划`);

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

  if (movesBySource.size === 0) {
    console.log('[moveTabsToWorkspaces] 没有有效的移动计划，结束');
    return false;
  }

  console.log(`[moveTabsToWorkspaces] 涉及 ${movesBySource.size} 个源工作区`);
  for (const [sourceId, sourceMoves] of movesBySource) {
    console.log(`[moveTabsToWorkspaces] 源工作区 ${sourceId} 将移动 ${sourceMoves.length} 个标签页`);
  }

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
  console.log(`[moveTabsToWorkspaces] 影子数据已保存，影响源工作区 ${affectedSourceIds.size} 个，目标工作区 ${affectedTargetIds.size} 个`);

  // 对已打开的受影响工作区执行反向同步，立即反映移动结果
  const syncStartTime = performance.now();
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

  const syncElapsed = (performance.now() - syncStartTime).toFixed(2);
  const totalElapsed = (performance.now() - startTime).toFixed(2);
  console.log(`[moveTabsToWorkspaces] 窗口同步完成，同步耗时 ${syncElapsed}ms，总耗时 ${totalElapsed}ms`);

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
  if (!ws || !ws.tabs) {
    console.warn(`[reorderTab] 未找到工作区 ${workspaceId}`);
    return false;
  }

  const currentIndex = ws.tabs.findIndex(t => t.id === tabId);
  if (currentIndex === -1) {
    console.warn(`[reorderTab] 未找到标签页 ${tabId}`);
    return false;
  }

  // 限制目标索引范围
  const safeIndex = Math.max(0, Math.min(targetIndex, ws.tabs.length - 1));
  if (currentIndex === safeIndex) return true;

  const [movedTab] = ws.tabs.splice(currentIndex, 1);
  ws.tabs.splice(safeIndex, 0, movedTab);
  ws.updatedAt = nowIso();

  await saveWorkspaces(data);
  console.log(`[reorderTab] 工作区 ${workspaceId} 标签页 ${tabId} 从索引 ${currentIndex} 移动到 ${safeIndex}`);
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
  if (!ws) {
    console.warn(`[createGroup] 未找到工作区 ${workspaceId}`);
    return null;
  }

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
  console.log(`[createGroup] 已在工作区 ${workspaceId} 创建分组 ${newGroup.id}（${newGroup.name}）`);
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
  if (!ws) {
    console.warn(`[assignTabToGroup] 未找到工作区 ${workspaceId}`);
    return false;
  }

  // 校验分组存在性（groupId 为 null 表示取消分组）
  if (groupId && !ws.groups.find(g => g.id === groupId)) {
    console.warn(`[assignTabToGroup] 工作区 ${workspaceId} 中未找到分组 ${groupId}`);
    return false;
  }

  const tab = ws.tabs.find(t => t.id === tabId);
  if (!tab) {
    console.warn(`[assignTabToGroup] 工作区 ${workspaceId} 中未找到标签页 ${tabId}`);
    return false;
  }

  const previousGroupId = tab.groupId;
  tab.groupId = groupId || null;
  ws.updatedAt = nowIso();
  await saveWorkspaces(data);
  console.log(`[assignTabToGroup] 工作区 ${workspaceId} 标签页 ${tabId} 分组从 ${previousGroupId} 更新为 ${tab.groupId}`);
  return true;
}

/**
 * 打开工作区：创建或聚焦对应浏览器窗口
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<object|null>} 更新后的工作区对象
 */
async function openWorkspace(workspaceId) {
  const startTime = performance.now();
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) {
    console.warn(`[openWorkspace] 未找到工作区 ${workspaceId}`);
    return null;
  }

  // 窗口已存在则聚焦
  if (ws.windowId) {
    try {
      await chrome.windows.update(ws.windowId, { focused: true });
      console.log(`[openWorkspace] 工作区 ${workspaceId} 已聚焦到窗口 ${ws.windowId}`);
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
      const elapsed = (performance.now() - startTime).toFixed(2);
      console.log(`[openWorkspace] 工作区 ${ws.id} 已关联到已存在窗口 ${bestMatch.id}，匹配度 ${(bestScore * 100).toFixed(0)}%，耗时 ${elapsed}ms`);
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
  const elapsed = (performance.now() - startTime).toFixed(2);
  console.log(`[openWorkspace] 工作区 ${workspaceId} 未找到匹配窗口，已入队 OPEN 意图，耗时 ${elapsed}ms`);
  return ws;
}

/**
 * 强制立即创建新窗口来打开工作区
 * 适用于用户明确需要扩展创建窗口的场景
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<object|null>} 更新后的工作区对象
 */
async function forceCreateWorkspaceWindow(workspaceId) {
  const startTime = performance.now();
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws) {
    console.warn(`[forceCreateWorkspaceWindow] 未找到工作区 ${workspaceId}`);
    return null;
  }

  if (ws.windowId) {
    try {
      await chrome.windows.update(ws.windowId, { focused: true });
      console.log(`[forceCreateWorkspaceWindow] 工作区 ${workspaceId} 已聚焦到窗口 ${ws.windowId}`);
      return ws;
    } catch (error) {
      ws.windowId = null;
    }
  }

  // 创建新窗口（惰性打开：仅活动页 eager 加载，其余标签页创建后立即挂起）
  const urls = ws.tabs.length > 0 ? ws.tabs.map(t => t.url) : ['edge://newtab/'];

  // 加锁防止 tabs.onCreated/onUpdated 在标签页创建期间干扰影子库
  if (syncWorkspaceLocks.has(workspaceId)) {
    console.log(`[forceCreateWorkspaceWindow] 工作区 ${workspaceId} 正在创建窗口，跳过重复调用`);
    return null;
  }
  syncWorkspaceLocks.add(workspaceId);

  try {
    let newWindow = null;
    let restored = false;

    // 优先尝试高保真恢复：sessions.restore 保留窗口位置/尺寸、固定标签页与原生分组
    if (ws.lastSessionId) {
      try {
        newWindow = await chrome.sessions.restore(ws.lastSessionId);
        restored = true;
        console.log(`[forceCreateWorkspaceWindow] 已通过 sessions.restore 高保真恢复窗口 ${newWindow.id}`);
      } catch (error) {
        console.warn('[forceCreateWorkspaceWindow] sessions.restore 失败，回退常规创建:', error);
        newWindow = null;
      }
    }

    if (restored && newWindow) {
      // 恢复路径：按 URL 映射 realTabId，并补齐缺失标签页
      ws.windowId = newWindow.id;
      const usedIds = new Set();
      ws.tabs.forEach(tab => {
        const matched = (newWindow.tabs || []).find(t => !usedIds.has(t.id) && normalizeUrl(t.url) === normalizeUrl(tab.url));
        if (matched) {
          tab.realTabId = matched.id;
          usedIds.add(matched.id);
        } else {
          delete tab.realTabId;
        }
      });
      for (const tab of ws.tabs) {
        if (tab.realTabId) continue;
        try {
          const created = await chrome.tabs.create({ windowId: newWindow.id, url: tab.url, active: false });
          tab.realTabId = created.id;
          try {
            await chrome.tabs.discard(created.id);
          } catch (error) {
            // 忽略 discard 失败
          }
        } catch (error) {
          console.error('[Edge Workspace Manager] 恢复窗口补齐标签页失败:', error);
        }
      }
      ws.lastSessionId = null; // 会话一次性使用后清除
    } else {
      // 常规创建路径（惰性打开：仅活动页 eager 加载，其余标签页创建后立即挂起）
      newWindow = await chrome.windows.create({
        url: [urls[0]],
        focused: true
      });
      ws.windowId = newWindow.id;

      // 映射活动页真实标签页 ID
      if (newWindow.tabs && newWindow.tabs.length > 0 && ws.tabs[0]) {
        ws.tabs[0].realTabId = newWindow.tabs[0].id;
      }

      // 其余标签页：创建为后台标签页后立即 discard 卸载，点击时才真正加载
      for (let i = 1; i < urls.length; i++) {
        try {
          const created = await chrome.tabs.create({
            windowId: newWindow.id,
            url: urls[i],
            active: false
          });
          if (ws.tabs[i]) {
            ws.tabs[i].realTabId = created.id;
          }
          try {
            await chrome.tabs.discard(created.id);
          } catch (error) {
            // 环境不支持 discard 时忽略，标签页仍以后台方式加载
          }
        } catch (error) {
          console.error('[Edge Workspace Manager] 创建延迟标签页失败:', error);
        }
      }
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
    // 恢复路径下窗口已自带原生分组，仅常规创建路径需要重新应用影子分组
    if (!restored) {
      await applyShadowGroupsToWindow(workspaceId);
    }
    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(`[forceCreateWorkspaceWindow] 工作区 ${workspaceId} 已创建窗口 ${ws.windowId}，标签页数 ${ws.tabs.length}，耗时 ${elapsed}ms`);
    return ws;
  } catch (error) {
    console.error('[Edge Workspace Manager] 创建工作区窗口失败:', error);
    return null;
  } finally {
    syncWorkspaceLocks.delete(workspaceId);
  }
}

/**
 * 将 chrome 窗口对象转换为扩展内部工作区对象
 * @param {object} chromeWindow - chrome.windows API 返回的窗口对象
 * @param {string} [name] - 工作区名称，缺省使用窗口标题或时间
 * @returns {object|null} 转换后的工作区对象
 */
async function convertChromeWindowToWorkspace(chromeWindow, name) {
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

  // 捕获原生标签页组（方向：原生 → 影子库），保留分组名称/颜色/折叠/成员关系
  const nativeGroupMap = new Map(); // 原生 groupId -> 影子 groupId
  try {
    const nativeGroups = await chrome.tabGroups.query({ windowId: chromeWindow.id });
    for (const ng of nativeGroups) {
      const shadowGroup = {
        id: generateId('group'),
        name: ng.title || '未命名分组',
        color: nativeColorToHex(ng.color),
        collapsed: !!ng.collapsed,
        parentGroupId: null,
        nativeGroupId: ng.id
      };
      workspace.groups.push(shadowGroup);
      nativeGroupMap.set(ng.id, shadowGroup.id);
    }
  } catch (error) {
    // tabGroups API 不可用或不支持时忽略，分组保持为空
  }

  // 将 chrome 标签页转换为影子标签页，并记录真实标签页 ID 与分组归属
  workspace.tabs = chromeWindow.tabs.map((chromeTab) => {
    let hostname = '';
    try {
      if (chromeTab.url) {
        hostname = new URL(chromeTab.url).hostname;
      }
    } catch (error) {
      // 忽略无效 URL
    }

    // 将原生分组映射为影子分组
    let shadowGroupId = null;
    if (chromeTab.groupId !== undefined && chromeTab.groupId !== null && nativeGroupMap.has(chromeTab.groupId)) {
      shadowGroupId = nativeGroupMap.get(chromeTab.groupId);
    }

    return {
      id: generateId('tab'),
      url: chromeTab.url || 'edge://newtab/',
      title: chromeTab.title || chromeTab.url || '新标签页',
      favIconUrl: chromeTab.favIconUrl || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
      groupId: shadowGroupId,
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
    const newWorkspace = await convertChromeWindowToWorkspace(currentWindow, name);
    if (!newWorkspace) {
      console.warn('[Edge Workspace Manager] 当前窗口无标签页，无法导入');
      return null;
    }

    const data = await loadWorkspaces();
    data.workspaces.push(newWorkspace);
    await saveWorkspaces(data);
    console.log(`[importCurrentWindow] 已导入当前窗口为工作区 ${newWorkspace.id}（${newWorkspace.name}），标签页数 ${newWorkspace.tabs.length}`);
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

    for (const [index, chromeWindow] of normalWindows.entries()) {
      const newWorkspace = await convertChromeWindowToWorkspace(
        chromeWindow,
        `导入工作区 ${index + 1}`
      );
      if (newWorkspace) {
        data.workspaces.push(newWorkspace);
        importedWorkspaces.push(newWorkspace);
      }
    }

    await saveWorkspaces(data);
    console.log(`[importAllWindows] 已导入 ${importedWorkspaces.length} 个窗口，当前工作区总数 ${data.workspaces.length}`);
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
    const result = allWindows
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
    console.log(`[getOpenWindows] 获取到 ${result.length} 个可导入窗口`);
    return result;
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
  if (!windowIds || windowIds.length === 0) {
    console.warn('[importSelectedWindows] 未提供窗口 ID');
    return [];
  }

  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    const selectedWindows = allWindows.filter(w => windowIds.includes(w.id));

    if (selectedWindows.length === 0) {
      console.warn('[Edge Workspace Manager] 未找到选中的窗口');
      return [];
    }

    const data = await loadWorkspaces();
    const importedWorkspaces = [];

    for (const chromeWindow of selectedWindows) {
      const newWorkspace = await convertChromeWindowToWorkspace(
        chromeWindow,
        `导入工作区 ${data.workspaces.length + importedWorkspaces.length + 1}`
      );
      if (newWorkspace) {
        data.workspaces.push(newWorkspace);
        importedWorkspaces.push(newWorkspace);
      }
    }

    await saveWorkspaces(data);
    console.log(`[importSelectedWindows] 已导入 ${importedWorkspaces.length} 个选中窗口，当前工作区总数 ${data.workspaces.length}`);
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
  const startTime = performance.now();
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
      console.log(`[syncWorkspaceFromWindow] 工作区 ${workspaceId} 关联窗口已不存在，已解除关联`);
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
    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(`[syncWorkspaceFromWindow] 工作区 ${workspaceId} 已从窗口 ${ws.windowId} 同步 ${ws.tabs.length} 个标签页，耗时 ${elapsed}ms`);
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

  const syncStartTime = performance.now();
  try {
    const data = await loadWorkspaces();
    const ws = data.workspaces.find(w => w.id === workspaceId);
    if (!ws || !ws.windowId) {
      console.warn('[Edge Workspace Manager] 工作区未关联窗口，无法反向同步');
      return false;
    }

    console.log(`[syncWorkspaceToWindow] 开始同步工作区 ${workspaceId} 到窗口 ${ws.windowId}，标签页数 ${ws.tabs.length}`);

    const chromeWindow = await chrome.windows.get(ws.windowId, { populate: true });
    if (!chromeWindow || !chromeWindow.tabs) {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
      ws.updatedAt = nowIso();
      await saveWorkspaces(data);
      return false;
    }

    // 建立真实标签页索引：优先按 realTabId 复用，再按规范化 URL 复用。
    // 这样即使 Edge 原生工作区刚打开、标签页 URL 尚未完全加载（如 edge://newtab），
    // 也能通过关联阶段记录的 realTabId 正确映射，避免重复创建标签页。
    const realTabsById = new Map();
    const realTabsByUrl = new Map();
    chromeWindow.tabs.forEach(tab => {
      realTabsById.set(tab.id, tab);
      const key = normalizeUrl(tab.url);
      if (key) {
        if (!realTabsByUrl.has(key)) {
          realTabsByUrl.set(key, []);
        }
        realTabsByUrl.get(key).push(tab);
      }
    });

    const updatedTabs = [];
    let reusedCount = 0;
    let createdCount = 0;

    // 确保工作区中的每个标签页都存在于真实窗口
    for (const wsTab of ws.tabs) {
      let reused = false;

      // 优先按 realTabId 复用：关联阶段已根据 URL 建立映射，优先保证同一标签页不被重复创建
      if (wsTab.realTabId && realTabsById.has(wsTab.realTabId)) {
        const realTab = realTabsById.get(wsTab.realTabId);
        wsTab.realTabId = realTab.id;
        wsTab.title = realTab.title || wsTab.title;
        wsTab.favIconUrl = realTab.favIconUrl || wsTab.favIconUrl;
        updatedTabs.push(wsTab);
        reusedCount++;

        // 将该真实标签页从 URL 索引中移除，避免后续被重复复用或误关闭
        const key = normalizeUrl(realTab.url);
        if (key && realTabsByUrl.has(key)) {
          const realTabs = realTabsByUrl.get(key);
          const idx = realTabs.findIndex(t => t.id === realTab.id);
          if (idx !== -1) realTabs.splice(idx, 1);
          if (realTabs.length === 0) realTabsByUrl.delete(key);
        }
        realTabsById.delete(realTab.id);
        reused = true;
      }

      if (!reused) {
        const key = normalizeUrl(wsTab.url);
        if (key && realTabsByUrl.has(key) && realTabsByUrl.get(key).length > 0) {
          // 取出一个同 URL 的真实标签页进行复用
          const realTabs = realTabsByUrl.get(key);
          const realTab = realTabs.shift();
          wsTab.realTabId = realTab.id;
          wsTab.title = realTab.title || wsTab.title;
          wsTab.favIconUrl = realTab.favIconUrl || wsTab.favIconUrl;
          updatedTabs.push(wsTab);
          reusedCount++;
          if (realTabs.length === 0) {
            realTabsByUrl.delete(key);
          }
          realTabsById.delete(realTab.id);
        } else {
          // 在真实窗口中创建缺失标签页
          const newTab = await chrome.tabs.create({
            windowId: ws.windowId,
            url: wsTab.url,
            active: false
          });
          wsTab.realTabId = newTab.id;
          updatedTabs.push(wsTab);
          createdCount++;
        }
      }
    }
    console.log(`[syncWorkspaceToWindow] 工作区 ${workspaceId} 标签页映射完成，复用 ${reusedCount} 个，创建 ${createdCount} 个`);

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
    if (ws.pendingCleanup) {
      delete ws.pendingCleanup;
      console.log(`[syncWorkspaceToWindow] 工作区 ${workspaceId} 的 pendingCleanup 已清除`);
    }
    await saveWorkspaces(data);
    const syncElapsed = (performance.now() - syncStartTime).toFixed(2);
    console.log(`[syncWorkspaceToWindow] 工作区 ${workspaceId} 的影子数据已同步到窗口 ${ws.windowId}，复用 ${reusedCount} 个标签页，创建 ${createdCount} 个标签页，耗时 ${syncElapsed}ms`);
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

  const applyStartTime = performance.now();
  console.log(`[applyPendingOperations] 工作区 ${workspaceId} 开始应用 ${operations.length} 条待执行操作:`, operations.map(op => op.type));

  let success = true;
  // 连续的 OPEN/SYNC 操作本质都是反向同步一次，合并执行避免重复调用。
  let needsSync = false;
  for (const op of operations) {
    if (op.type === 'OPEN' || op.type === 'SYNC') {
      needsSync = true;
    }
    // 后续可扩展更多操作类型，如 REMOVE_TAB、REORDER 等
  }

  if (needsSync) {
    try {
      const synced = await syncWorkspaceToWindow(workspaceId);
      if (!synced) success = false;
    } catch (error) {
      console.error(`[Edge Workspace Manager] 应用待执行操作（同步）失败:`, error);
      success = false;
    }
  }

  await clearPendingOperations(workspaceId);
  const applyElapsed = (performance.now() - applyStartTime).toFixed(2);
  console.log(`[applyPendingOperations] 工作区 ${workspaceId} 待执行操作应用完成，结果 ${success}，耗时 ${applyElapsed}ms`);
  return success;
}

/**
 * 将当前聚焦的浏览器窗口关联到指定工作区
 * 用于 Edge 原生按钮打开窗口后，手动建立扩展工作区与窗口的映射
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否关联成功
 */
async function associateCurrentWindow(workspaceId) {
  const startTime = performance.now();
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || ws.windowId) {
    console.warn(`[associateCurrentWindow] 工作区 ${workspaceId} 不存在或已关联窗口`);
    return false;
  }

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
    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(`[associateCurrentWindow] 工作区 ${workspaceId} 已关联到窗口 ${currentWindow.id}，标签页数 ${currentWindow.tabs.length}，耗时 ${elapsed}ms`);
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
  const startTime = performance.now();
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.windowId) {
    console.warn(`[closeWorkspace] 工作区 ${workspaceId} 未关联窗口，无需关闭`);
    return false;
  }

  try {
    await chrome.windows.remove(ws.windowId);
    const removedWindowId = ws.windowId;
    ws.windowId = null;
    ws.tabs.forEach(tab => delete tab.realTabId);

    // 捕获刚关闭窗口的会话 ID，供下次 sessions.restore 高保真恢复（保留窗口位置/尺寸/分组/固定标签页）
    try {
      const recent = await chrome.sessions.getRecentlyClosed();
      const closedWin = recent.find(s => s.window && s.window.sessionId);
      if (closedWin) {
        ws.lastSessionId = closedWin.window.sessionId;
      }
    } catch (error) {
      // sessions API 不可用时忽略
    }

    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(`[closeWorkspace] 工作区 ${workspaceId} 已关闭窗口 ${removedWindowId}，耗时 ${elapsed}ms`);
    return true;
  } catch (error) {
    console.error('[Edge Workspace Manager] 关闭工作区窗口失败:', error);
    return false;
  }
}

/**
 * 导出全部工作区数据为 JSON 字符串
 * 用于数据备份与迁移
 * @returns {Promise<string>} JSON 字符串
 */
async function exportWorkspacesData() {
  const data = await loadWorkspaces();
  return JSON.stringify(data, null, 2);
}

/**
 * 从 JSON 字符串导入工作区数据（替换现有全部工作区）
 * 导入前清理运行时字段（windowId/realTabId/会话 ID 等），确保以干净状态重新打开
 * @param {string|object} input - JSON 字符串或已解析对象
 * @returns {Promise<object>} 导入后的完整数据对象
 */
async function importWorkspacesData(input) {
  let parsed;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new Error('无效的 JSON 数据');
  }
  if (!parsed || !Array.isArray(parsed.workspaces)) {
    throw new Error('数据格式不正确：缺少 workspaces 数组');
  }

  const cleanWorkspaces = parsed.workspaces.map(ws => ({
    id: ws.id || generateId('ws'),
    name: ws.name || '未命名工作区',
    icon: ws.icon || null,
    createdAt: ws.createdAt || nowIso(),
    updatedAt: nowIso(),
    windowId: null, // 运行时字段，导入后重新打开
    tabs: (ws.tabs || []).map(tab => ({
      id: tab.id || generateId('tab'),
      url: tab.url || 'edge://newtab/',
      title: tab.title || tab.url || '新标签页',
      favIconUrl: tab.favIconUrl || null,
      groupId: tab.groupId || null,
      pinned: !!tab.pinned,
      createdAt: tab.createdAt || nowIso()
    })),
    groups: (ws.groups || []).map(g => ({
      id: g.id || generateId('group'),
      name: g.name || '未命名分组',
      color: g.color || getRandomColor(),
      collapsed: !!g.collapsed,
      parentGroupId: g.parentGroupId || null
    })),
    layout: ws.layout || { sortBy: 'title', sortOrder: 'asc' }
  }));

  const data = await loadWorkspaces();
  data.workspaces = cleanWorkspaces;
  data.lastUpdated = nowIso();
  await saveWorkspaces(data);
  return data;
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

/**
 * 影子库分组颜色（十六进制）与原生 tabGroups 枚举颜色之间的映射表
 */
const NATIVE_COLOR_MAP = [
  { native: 'grey', hex: '#9AA0A6' },
  { native: 'blue', hex: '#4285F4' },
  { native: 'red', hex: '#EA4335' },
  { native: 'yellow', hex: '#FBBC05' },
  { native: 'green', hex: '#34A853' },
  { native: 'pink', hex: '#F06292' },
  { native: 'purple', hex: '#AA00FF' },
  { native: 'cyan', hex: '#00BCD4' },
  { native: 'orange', hex: '#FF6D00' }
];

/**
 * 将原生 tabGroups 枚举颜色转换为十六进制颜色
 * @param {string} nativeColor - 原生枚举颜色（如 'blue'）
 * @returns {string} 十六进制颜色值
 */
function nativeColorToHex(nativeColor) {
  const found = NATIVE_COLOR_MAP.find(c => c.native === nativeColor);
  return found ? found.hex : '#4285F4';
}

/**
 * 将十六进制颜色转换为原生 tabGroups 枚举颜色
 * @param {string} hex - 十六进制颜色值
 * @returns {string|undefined} 原生枚举颜色，未匹配时返回 undefined（使用浏览器默认色）
 */
function hexToNativeColor(hex) {
  const normalized = (hex || '').toLowerCase();
  const found = NATIVE_COLOR_MAP.find(c => c.hex.toLowerCase() === normalized);
  return found ? found.native : undefined;
}

/**
 * 将影子库的分组应用到窗口的原生标签页组（方向：影子库 → 原生）
 * 用于打开工作区后还原分组结构（名称/颜色/折叠/成员）
 * @param {string} workspaceId - 工作区 ID
 * @returns {Promise<boolean>} 是否成功应用
 */
async function applyShadowGroupsToWindow(workspaceId) {
  const data = await loadWorkspaces();
  const ws = data.workspaces.find(w => w.id === workspaceId);
  if (!ws || !ws.windowId) return false;
  if (!ws.groups || ws.groups.length === 0) return false;

  for (const group of ws.groups) {
    const memberTabIds = ws.tabs
      .filter(t => t.groupId === group.id && t.realTabId)
      .map(t => t.realTabId);
    if (memberTabIds.length === 0) continue;

    try {
      // 将成员标签页编组，返回原生分组 ID
      const nativeGroupId = await chrome.tabs.group({
        tabIds: memberTabIds,
        createProperties: { windowId: ws.windowId }
      });

      // 应用分组的名称/颜色/折叠状态
      const updateProps = { collapsed: !!group.collapsed };
      if (group.name) updateProps.title = group.name;
      const nativeColor = hexToNativeColor(group.color);
      if (nativeColor) updateProps.color = nativeColor;
      await chrome.tabGroups.update(nativeGroupId, updateProps);

      group.nativeGroupId = nativeGroupId;
      ws.updatedAt = nowIso();
    } catch (error) {
      console.warn('[Edge Workspace Manager] 应用原生分组失败:', error);
    }
  }

  await saveWorkspaces(data);
  return true;
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
    applyShadowGroupsToWindow,
    nativeColorToHex,
    hexToNativeColor,
    exportWorkspacesData,
    importWorkspacesData,
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

      // 若该工作区正在反向同步，跳过更新事件，避免与 syncWorkspaceToWindow 的数据竞争。
      if (syncWorkspaceLocks.has(ws.id)) {
        console.log(`[Edge Workspace Manager] 标签页 ${tabId} 更新事件被忽略：工作区 ${ws.id} 正在反向同步`);
        continue;
      }

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

    // 若该工作区正在执行反向同步（syncWorkspaceToWindow），则跳过此事件。
    // syncWorkspaceToWindow 会自行维护标签页映射，此处处理会导致重复写入或数据竞争。
    if (syncWorkspaceLocks.has(ws.id)) {
      console.log(`[Edge Workspace Manager] 标签页 ${tab.id} 创建事件被忽略：工作区 ${ws.id} 正在反向同步`);
      return;
    }

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
 * 监听标签页分离事件（跨窗口移动的第一步）：
 * 用户将标签页从工作区窗口拖出时，立即从影子数据库的源工作区移除。
 * 注意：扩展自身使用 create/close 而非 move，故此事件仅由用户原生操作触发。
 */
chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  try {
    const data = await loadWorkspaces();
    const sourceWs = data.workspaces.find(w => w.windowId === detachInfo.oldWindowId);
    if (!sourceWs) return;

    const tabIndex = sourceWs.tabs.findIndex(t => t.realTabId === tabId);
    if (tabIndex === -1) return;

    sourceWs.tabs.splice(tabIndex, 1);
    sourceWs.updatedAt = nowIso();
    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 标签页 ${tabId} 已从窗口 ${detachInfo.oldWindowId} 分离，移出工作区 ${sourceWs.id}`);
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页分离事件失败:', error);
  }
});

/**
 * 监听标签页附加事件（跨窗口移动的第二步）：
 * 用户将标签页拖入工作区窗口时，立即把该标签页加入目标工作区的影子数据库。
 */
chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try {
    const data = await loadWorkspaces();
    const targetWs = data.workspaces.find(w => w.windowId === attachInfo.newWindowId);
    if (!targetWs) return;

    // 去重：若影子数据库已记录该真实标签页，则不重复追加
    if (targetWs.tabs.some(t => t.realTabId === tabId)) return;

    // 获取标签页详情（URL/标题/favicon），失败时使用占位值，后续由 onUpdated 补全
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      // 标签页可能尚在移动中，忽略获取失败
    }

    let hostname = '';
    if (tab && tab.url) {
      try {
        hostname = new URL(tab.url).hostname;
      } catch (error) {
        // 忽略无效 URL
      }
    }

    targetWs.tabs.push({
      id: generateId('tab'),
      url: (tab && tab.url) || 'edge://newtab/',
      title: (tab && tab.title) || (tab && tab.url) || '新标签页',
      favIconUrl: (tab && tab.favIconUrl) || (hostname ? `https://www.google.com/s2/favicons?domain=${hostname}` : null),
      groupId: null,
      pinned: (tab && tab.pinned) || false,
      realTabId: tabId,
      createdAt: nowIso()
    });
    targetWs.updatedAt = nowIso();
    await saveWorkspaces(data);
    console.log(`[Edge Workspace Manager] 标签页 ${tabId} 已附加到窗口 ${attachInfo.newWindowId}，加入工作区 ${targetWs.id}`);
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页附加事件失败:', error);
  }
});

/**
 * 监听标签页在同一窗口内的移动事件：同步更新影子数据库中的标签页顺序。
 * 采用尽力而为的重排序（浏览器 index 与影子数组顺序近似对齐），
 * 顺序偏差不影响正确性，仅影响重新打开工作区时的标签页排列。
 */
chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  try {
    const data = await loadWorkspaces();
    const ws = data.workspaces.find(w => w.windowId === moveInfo.windowId);
    if (!ws) return;

    const fromIndex = ws.tabs.findIndex(t => t.realTabId === tabId);
    if (fromIndex === -1) return;

    const [moved] = ws.tabs.splice(fromIndex, 1);
    const toIndex = Math.max(0, Math.min(moveInfo.toIndex, ws.tabs.length));
    ws.tabs.splice(toIndex, 0, moved);
    ws.updatedAt = nowIso();
    await saveWorkspaces(data);
  } catch (error) {
    console.error('[Edge Workspace Manager] 处理标签页移动事件失败:', error);
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

      case 'EXPORT_DATA': {
        const json = await exportWorkspacesData();
        sendResponse({ success: true, data: json });
        break;
      }

      case 'IMPORT_DATA': {
        const data = await importWorkspacesData(request.data);
        sendResponse({ success: true, workspaceCount: data.workspaces.length });
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
