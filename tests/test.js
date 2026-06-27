/**
 * Edge Workspace Manager - 数据层单元测试
 * 验证工作区、标签页、分组、导入等核心 API
 */

(function () {
  'use strict';

  const resultsEl = document.getElementById('results');
  const summaryEl = document.getElementById('summary');
  let passCount = 0;
  let failCount = 0;

  /**
   * 断言辅助函数
   */
  function assert(condition, message) {
    if (condition) {
      passCount++;
      log(`PASS: ${message}`, 'pass');
    } else {
      failCount++;
      log(`FAIL: ${message}`, 'fail');
      console.log('[TEST_FAIL]', message);
    }
  }

  /**
   * 在页面输出日志
   */
  function log(message, className) {
    const div = document.createElement('div');
    div.className = `log ${className}`;
    div.textContent = message;
    resultsEl.appendChild(div);
  }

  /**
   * 运行所有测试
   */
  async function runTests() {
    log('开始运行测试...', '');

    // 清理存储
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });

    // 测试 1：创建工作区
    const ws = await createWorkspace('测试工作区');
    assert(ws && ws.name === '测试工作区', 'createWorkspace 返回正确名称');
    assert(ws.tabs.length === 0, '新工作区标签页为空');
    assert(ws.groups.length === 0, '新工作区分组为空');

    // 测试 2：加载工作区
    const data = await loadWorkspaces();
    assert(data.workspaces.length === 1, 'loadWorkspaces 加载到 1 个工作区');
    assert(data.workspaces[0].id === ws.id, '加载到的工作区 ID 一致');

    // 测试 3：添加标签页
    const tab = await addTabToWorkspace(ws.id, 'https://www.bing.com', 'Bing');
    assert(tab && tab.url === 'https://www.bing.com', 'addTabToWorkspace 返回正确 URL');
    assert(tab.title === 'Bing', 'addTabToWorkspace 使用传入标题');

    // 测试 4：自动补全协议前缀的标签页标题
    const tab2 = await addTabToWorkspace(ws.id, 'example.com');
    assert(tab2 && tab2.url === 'example.com', 'addTabToWorkspace 保留原始 URL（数据层不补全）');

    // 测试 5：创建分组
    const group = await createGroup(ws.id, '开发工具');
    assert(group && group.name === '开发工具', 'createGroup 返回正确分组名称');
    assert(group.color && group.color.startsWith('#'), 'createGroup 分配颜色');

    // 测试 6：分配标签页到分组
    const assigned = await assignTabToGroup(ws.id, tab.id, group.id);
    assert(assigned === true, 'assignTabToGroup 分配成功');
    const dataAfterAssign = await loadWorkspaces();
    const storedTab = dataAfterAssign.workspaces[0].tabs.find(t => t.id === tab.id);
    assert(storedTab && storedTab.groupId === group.id, '标签页已记录分组 ID');

    // 测试 7：取消分组
    const unassigned = await assignTabToGroup(ws.id, tab.id, null);
    assert(unassigned === true, 'assignTabToGroup 取消分组成功');

    // 测试 8：强制创建窗口打开工作区
    const openedWs = await forceCreateWorkspaceWindow(ws.id);
    assert(openedWs && openedWs.windowId, 'forceCreateWorkspaceWindow 创建窗口并记录 windowId');
    assert(openedWs.tabs.every(t => typeof t.realTabId === 'number'), '打开窗口后所有标签页记录 realTabId');

    // 测试 9：关闭工作区窗口
    const closed = await closeWorkspace(ws.id);
    assert(closed === true, 'closeWorkspace 关闭成功');
    const dataAfterClose = await loadWorkspaces();
    assert(dataAfterClose.workspaces[0].windowId === null, '关闭后 windowId 清空');

    // 测试 10：导入当前窗口
    const imported = await importCurrentWindow('导入测试');
    assert(imported && imported.name === '导入测试', 'importCurrentWindow 使用指定名称');
    assert(imported.tabs.length >= 1, '导入当前窗口至少包含 1 个标签页');
    assert(imported.tabs[0].realTabId, '导入的标签页记录 realTabId');

    // 测试 11：导入所有窗口（应过滤 popup 类型）
    const allImported = await importAllWindows();
    assert(allImported.length === 2, 'importAllWindows 导入 2 个普通窗口，过滤 popup');
    assert(allImported.some(w => w.tabs[0].url === 'https://github.com'), '导入结果包含 GitHub 窗口');
    assert(allImported.some(w => w.tabs[0].url === 'https://www.bing.com'), '导入结果包含 Bing 窗口');

    // 测试 12：获取可导入窗口列表
    const openWindows = await getOpenWindows();
    assert(openWindows.length === 2, 'getOpenWindows 返回 2 个普通窗口');
    assert(openWindows.every(w => w.id && w.tabCount > 0), '窗口信息包含 id 与 tabCount');

    // 测试 13：手动选择导入指定窗口
    await saveWorkspaces({ version: '1.0.0', workspaces: [] }); // 清空以便计数
    const selectedImported = await importSelectedWindows([openWindows[0].id]);
    assert(selectedImported.length === 1, 'importSelectedWindows 仅导入选中的 1 个窗口');
    const dataAfterSelected = await loadWorkspaces();
    assert(dataAfterSelected.workspaces.length === 1, '清空后导入 1 个工作区');

    // 测试 14：打开工作区后强制同步
    const syncWs = dataAfterSelected.workspaces[0];
    const openedSyncWs = await forceCreateWorkspaceWindow(syncWs.id);
    assert(openedSyncWs && openedSyncWs.windowId, '同步测试前工作区窗口已打开');

    // 在 mock 窗口中新增一个标签页（模拟用户在浏览器中打开新标签）
    const originalTabCount = openedSyncWs.tabs.length;
    chrome.tabs.create({ url: 'https://sync-test.com', windowId: openedSyncWs.windowId });

    const synced = await syncWorkspaceFromWindow(syncWs.id);
    assert(synced === true, 'syncWorkspaceFromWindow 同步成功');
    const dataAfterSync = await loadWorkspaces();
    const syncedWs = dataAfterSync.workspaces.find(w => w.id === syncWs.id);
    assert(syncedWs.tabs.length === originalTabCount + 1, '同步后标签页数量增加 1');
    assert(syncedWs.tabs.some(t => t.url === 'https://sync-test.com'), '同步后包含新增标签页');

    // 测试 15：工作区内标签页拖拽排序
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const orderWs = await createWorkspace('排序测试');
    const tabA = await addTabToWorkspace(orderWs.id, 'https://a.com', 'A');
    const tabB = await addTabToWorkspace(orderWs.id, 'https://b.com', 'B');
    const tabC = await addTabToWorkspace(orderWs.id, 'https://c.com', 'C');

    const reordered = await reorderTab(orderWs.id, tabC.id, 0);
    assert(reordered === true, 'reorderTab 返回成功');
    const dataAfterReorder = await loadWorkspaces();
    const reorderedWs = dataAfterReorder.workspaces.find(w => w.id === orderWs.id);
    assert(reorderedWs.tabs[0].id === tabC.id, '标签页 C 移动到第一位');
    assert(reorderedWs.tabs[1].id === tabA.id, '标签页 A 移动到第二位');
    assert(reorderedWs.tabs[2].id === tabB.id, '标签页 B 移动到第三位');

    // 测试 16：跨工作区移动标签页
    const sourceWs = await createWorkspace('源工作区');
    const targetWs = await createWorkspace('目标工作区');
    const moveTab = await addTabToWorkspace(sourceWs.id, 'https://move-test.com', 'Move Tab');

    const moved = await moveTabToWorkspace(moveTab.id, sourceWs.id, targetWs.id);
    assert(moved === true, 'moveTabToWorkspace 返回成功');
    const dataAfterMove = await loadWorkspaces();
    const sourceAfterMove = dataAfterMove.workspaces.find(w => w.id === sourceWs.id);
    const targetAfterMove = dataAfterMove.workspaces.find(w => w.id === targetWs.id);
    assert(sourceAfterMove.tabs.length === 0, '源工作区标签页已移除');
    assert(targetAfterMove.tabs.length === 1, '目标工作区标签页已增加');
    assert(targetAfterMove.tabs[0].id === moveTab.id, '移动的标签页 ID 一致');
    assert(targetAfterMove.tabs[0].groupId === null, '跨区移动后分组关联已清除');

    // 测试 17：关联当前聚焦窗口到未打开的工作区
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const assocWs = await createWorkspace('待关联工作区');
    await addTabToWorkspace(assocWs.id, 'https://github.com', 'GitHub');

    const associated = await associateCurrentWindow(assocWs.id);
    assert(associated === true, 'associateCurrentWindow 返回成功');
    const dataAfterAssoc = await loadWorkspaces();
    const assocWsAfter = dataAfterAssoc.workspaces.find(w => w.id === assocWs.id);
    assert(assocWsAfter.windowId !== null, '工作区已关联窗口 ID');
    assert(assocWsAfter.tabs[0].realTabId !== undefined, '标签页已记录真实标签页 ID');

    const finalData = await loadWorkspaces();
    assert(finalData.workspaces.length === 1, '最终存在 1 个工作区');

    // 测试 18：URL 规范化
    assert(normalizeUrl('https://Example.COM/Page#section') === 'https://example.com/page', 'normalizeUrl 忽略大小写与 fragment');
    assert(normalizeUrl('https://example.com/page/') === 'https://example.com/page', 'normalizeUrl 移除尾部斜杠');
    assert(normalizeUrl('edge://newtab/') === null, 'normalizeUrl 忽略新建标签页');

    // 测试 19：窗口与工作区匹配度计算
    const scoreWindow = {
      id: 9999,
      tabs: [
        { url: 'https://github.com', title: 'GitHub' },
        { url: 'https://www.bing.com', title: 'Bing' }
      ]
    };
    const scoreWsFull = {
      tabs: [
        { url: 'https://github.com' },
        { url: 'https://www.bing.com' }
      ]
    };
    const scoreWsPartial = {
      tabs: [
        { url: 'https://github.com' },
        { url: 'https://example.com' }
      ]
    };
    assert(calculateWindowMatchScore(scoreWindow, scoreWsFull) === 1, '完全匹配返回 1');
    assert(calculateWindowMatchScore(scoreWindow, scoreWsPartial) === 0.5, '一半匹配返回 0.5');

    // 测试 20：扫描已打开窗口并自动关联
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const scanWs = await createWorkspace('扫描匹配工作区');
    await addTabToWorkspace(scanWs.id, 'https://github.com', 'GitHub');

    const scanResult = await scanOpenWindowsAndAssociate();
    assert(scanResult.associated >= 1, 'scanOpenWindowsAndAssociate 至少关联 1 个窗口');
    const dataAfterScan = await loadWorkspaces();
    const scanWsAfter = dataAfterScan.workspaces.find(w => w.id === scanWs.id);
    assert(scanWsAfter.windowId !== null, '扫描后工作区已关联窗口');

    // 测试 21：openWorkspace 复用已存在的匹配窗口，而非创建新窗口
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const reuseWs = await createWorkspace('复用窗口测试');
    await addTabToWorkspace(reuseWs.id, 'https://www.bing.com', 'Bing');

    // mock-chrome 中 windowB 已包含 https://www.bing.com
    const openedReuseWs = await openWorkspace(reuseWs.id);
    assert(openedReuseWs && openedReuseWs.windowId, 'openWorkspace 返回已关联窗口');
    assert(openedReuseWs.tabs.some(t => t.url === 'https://www.bing.com'), '复用窗口包含匹配标签页');

    // 测试 22：openWorkspace 无匹配窗口时入队，不创建伪窗口
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations(); // 清空全部待执行操作
    const queueWs = await createWorkspace('入队测试');
    await addTabToWorkspace(queueWs.id, 'https://unique-test.com', 'Unique');

    const queuedOpen = await openWorkspace(queueWs.id);
    assert(queuedOpen && !queuedOpen.windowId, 'openWorkspace 未创建窗口时返回无 windowId');
    const pendingOps = await getPendingOperations(queueWs.id);
    assert(pendingOps.length === 1 && pendingOps[0].type === 'OPEN', 'openWorkspace 已入队 OPEN 操作');

    // 测试 23：syncWorkspaceToWindow 为关联窗口创建缺失标签页
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const syncToWindowWs = await createWorkspace('反向同步测试');
    await addTabToWorkspace(syncToWindowWs.id, 'https://github.com', 'GitHub');
    await addTabToWorkspace(syncToWindowWs.id, 'https://new-tab-test.com', 'New Tab');

    // 关联到包含 GitHub 的真实窗口（mock 中窗口 ID 不固定，动态查找）
    // 注意：addTabToWorkspace 已把数据写入存储，这里重新加载以确保对象状态最新
    const syncToWindowData = await loadWorkspaces();
    const syncToWindowWsFresh = syncToWindowData.workspaces.find(w => w.id === syncToWindowWs.id);
    const allSyncWindows = await chrome.windows.getAll({ populate: true });
    const windowA = allSyncWindows.find(w =>
      w.type === 'normal' &&
      w.tabs &&
      w.tabs.some(t => normalizeUrl(t.url) === normalizeUrl('https://github.com'))
    );
    associateWindowWithWorkspaceInternal(windowA, syncToWindowWsFresh);
    syncToWindowWsFresh.updatedAt = nowIso();
    await saveWorkspaces({ version: '1.0.0', workspaces: [syncToWindowWsFresh] });

    const syncedToWindow = await syncWorkspaceToWindow(syncToWindowWs.id);
    assert(syncedToWindow === true, 'syncWorkspaceToWindow 返回成功');
    const dataAfterSyncToWindow = await loadWorkspaces();
    const syncToWindowWsAfter = dataAfterSyncToWindow.workspaces.find(w => w.id === syncToWindowWs.id);
    assert(syncToWindowWsAfter.tabs.length === 2, '反向同步后工作区保留 2 个标签页');
    assert(syncToWindowWsAfter.tabs.every(t => typeof t.realTabId === 'number'), '所有标签页都映射到真实标签页');

    // 测试 24：applyPendingOperations 在窗口关联后自动执行 OPEN
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const applyWs = await createWorkspace('自动应用测试');
    await addTabToWorkspace(applyWs.id, 'https://www.bing.com', 'Bing');
    await queuePendingOperation(applyWs.id, 'OPEN');

    // 扫描应关联到 windowB 并自动应用待执行操作
    const applyScanResult = await scanOpenWindowsAndAssociate();
    assert(applyScanResult.associated >= 1, '扫描关联到窗口');
    const opsAfterApply = await getPendingOperations(applyWs.id);
    assert(opsAfterApply.length === 0, '待执行操作已清空');
    const dataAfterApply = await loadWorkspaces();
    const applyWsAfter = dataAfterApply.workspaces.find(w => w.id === applyWs.id);
    assert(applyWsAfter.windowId !== null, '工作区已关联窗口');
    assert(applyWsAfter.tabs.some(t => t.realTabId), '标签页已同步到窗口');

    // 测试 25：两个工作区都关闭时移动标签页，打开窗口后自动同步
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const closedSourceWs = await createWorkspace('关闭源工作区');
    const closedTargetWs = await createWorkspace('关闭目标工作区');
    await addTabToWorkspace(closedSourceWs.id, 'https://note.ms/test', 'Note.ms');
    // 目标工作区保留一个原有标签页，使扫描时能通过 URL 匹配到用户打开的目标窗口
    await addTabToWorkspace(closedTargetWs.id, 'https://other.example.com', 'Other');

    // 重新加载工作区数据以获取 addTabToWorkspace 后的真实状态
    // 因为 chrome.storage.local 的序列化/反序列化会生成新的对象引用
    const dataBeforeMove = await loadWorkspaces();
    const sourceWsFresh = dataBeforeMove.workspaces.find(w => w.id === closedSourceWs.id);
    const targetWsFresh = dataBeforeMove.workspaces.find(w => w.id === closedTargetWs.id);
    const movedClosedTab = sourceWsFresh.tabs[0];

    // 模拟两个工作区均已关闭，无 windowId 与真实标签页映射
    sourceWsFresh.windowId = null;
    delete movedClosedTab.realTabId;
    targetWsFresh.windowId = null;
    targetWsFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [sourceWsFresh, targetWsFresh] });

    const movedClosed = await moveTabToWorkspace(movedClosedTab.id, sourceWsFresh.id, targetWsFresh.id);
    assert(movedClosed === true, '关闭状态下 moveTabToWorkspace 返回成功');

    // 验证源/目标工作区均产生待执行操作
    const sourcePending = await getPendingOperations(closedSourceWs.id);
    const targetPending = await getPendingOperations(closedTargetWs.id);
    assert(sourcePending.length === 1 && sourcePending[0].type === 'SYNC', '源工作区已入队 SYNC 操作');
    assert(targetPending.length === 1 && targetPending[0].type === 'OPEN', '目标工作区已入队 OPEN 操作');

    // 模拟用户通过 Edge 原生按钮打开源窗口（仍包含已移出的 notems）和目标窗口（不包含 notems）
    const sourceWindow = await chrome.windows.create({ url: ['https://note.ms/test'], focused: false });
    const targetWindow = await chrome.windows.create({ url: ['https://other.example.com'], focused: false });

    // 扫描关联并自动应用待执行操作
    const scanClosedResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] scan associated', scanClosedResult.associated, 'unmatched', scanClosedResult.unmatchedWindows.map(w => ({ id: w.id, tabs: w.tabs.map(t => t.url) })));
    const dataAfterScanClosed = await loadWorkspaces();
    console.log('[TEST_DEBUG] workspaces after scan', JSON.stringify(dataAfterScanClosed.workspaces.map(w => ({ id: w.id, windowId: w.windowId, tabs: w.tabs.map(t => ({ id: t.id, url: t.url, realTabId: t.realTabId })), pendingCleanup: w.pendingCleanup }))));
    assert(scanClosedResult.associated >= 2, '扫描至少关联 2 个工作区');

    // 验证源窗口中已移出的标签页被关闭
    const sourceWindowAfter = await chrome.windows.get(sourceWindow.id, { populate: true });
    console.log('[TEST_DEBUG] sourceWindowAfter', sourceWindowAfter.id, sourceWindowAfter.tabs.map(t => t.url));
    assert(sourceWindowAfter.tabs.every(t => normalizeUrl(t.url) !== normalizeUrl('https://note.ms/test')), '源窗口中已移出的标签页已关闭');

    // 验证目标窗口中已创建移入的标签页
    const targetWindowAfter = await chrome.windows.get(targetWindow.id, { populate: true });
    console.log('[TEST_DEBUG] targetWindowAfter', targetWindowAfter.id, targetWindowAfter.tabs.map(t => t.url));
    assert(targetWindowAfter.tabs.some(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')), '目标窗口中已创建移入的标签页');

    // 验证同步完成后源工作区的 pendingCleanup 已清除
    const dataAfterClosedMove = await loadWorkspaces();
    const sourceAfterClosedMove = dataAfterClosedMove.workspaces.find(w => w.id === closedSourceWs.id);
    console.log('[TEST_DEBUG] sourceAfterClosedMove pendingCleanup', JSON.stringify(sourceAfterClosedMove.pendingCleanup));
    assert(!sourceAfterClosedMove.pendingCleanup, '同步后源工作区 pendingCleanup 已清除');

    // 输出汇总
    summaryEl.textContent = `测试完成：通过 ${passCount} 项，失败 ${failCount} 项`;
    summaryEl.className = failCount === 0 ? 'pass' : 'fail';

    // 暴露结果供浏览器自动化读取
    window.__testResults = {
      pass: passCount,
      fail: failCount,
      total: passCount + failCount,
      success: failCount === 0
    };
    console.log('[TEST_RESULT]', JSON.stringify(window.__testResults));
  }

  // 页面加载后执行测试
  runTests().catch((error) => {
    log(`测试执行异常: ${error.message}`, 'fail');
    summaryEl.textContent = '测试执行异常';
    summaryEl.className = 'fail';
    window.__testResults = { pass: passCount, fail: failCount + 1, total: passCount + failCount + 1, success: false, error: error.message };
    console.log('[TEST_RESULT]', JSON.stringify(window.__testResults));
  });
})();
