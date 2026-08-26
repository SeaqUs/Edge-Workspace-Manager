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
   * 清理所有已打开的浏览器窗口，避免历史窗口影响后续 scanOpenWindowsAndAssociate 性能
   */
  async function clearAllWindows() {
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      try {
        await chrome.windows.remove(win.id);
      } catch (e) {
        // 忽略清理失败
      }
    }
  }

  /**
   * 运行所有测试
   */
  async function runTests() {
    try {
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

    // 测试 20：扫描已打开窗口并自动关联。
    // 由于前面测试已关闭 windowA，当前仅剩 mock-chrome 初始窗口 B（https://www.bing.com），
    // 因此为扫描工作区添加匹配 windowB 的标签页。
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    const scanWs = await createWorkspace('扫描匹配工作区');
    await addTabToWorkspace(scanWs.id, 'https://www.bing.com', 'Bing');

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

    // 测试 26：两个相同 URL 标签页从关闭源工作区移到关闭目标工作区，打开后不重复创建
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const dupSourceWs = await createWorkspace('重复 URL 源工作区');
    const dupTargetWs = await createWorkspace('重复 URL 目标工作区');
    await addTabToWorkspace(dupSourceWs.id, 'https://note.ms/test', 'Note.ms A');
    await addTabToWorkspace(dupSourceWs.id, 'https://note.ms/test', 'Note.ms B');

    const dupDataBeforeMove = await loadWorkspaces();
    const dupSourceFresh = dupDataBeforeMove.workspaces.find(w => w.id === dupSourceWs.id);
    const dupTargetFresh = dupDataBeforeMove.workspaces.find(w => w.id === dupTargetWs.id);
    dupSourceFresh.windowId = null;
    dupSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    dupTargetFresh.windowId = null;
    dupTargetFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [dupSourceFresh, dupTargetFresh] });

    // 逐个移动两个相同 URL 的标签页
    const dupTabA = dupSourceFresh.tabs[0];
    const dupTabB = dupSourceFresh.tabs[1];
    assert(await moveTabToWorkspace(dupTabA.id, dupSourceFresh.id, dupTargetFresh.id) === true, '第一个重复 URL 标签页移动成功');
    assert(await moveTabToWorkspace(dupTabB.id, dupSourceFresh.id, dupTargetFresh.id) === true, '第二个重复 URL 标签页移动成功');

    const dupDataAfterMove = await loadWorkspaces();
    const dupTargetAfterMove = dupDataAfterMove.workspaces.find(w => w.id === dupTargetFresh.id);
    console.log('[TEST_DEBUG] dupTargetAfterMove tabs', dupTargetAfterMove.tabs.map(t => t.url));
    assert(dupTargetAfterMove.tabs.length === 2, '目标工作区包含 2 个 note.ms 标签页');

    // 模拟用户打开源和目标窗口
    const dupSourceWindow = await chrome.windows.create({ url: ['https://note.ms/test', 'https://note.ms/test'], focused: false });
    const dupTargetWindow = await chrome.windows.create({ url: ['https://note.ms/test'], focused: false });
    console.log('[TEST_DEBUG] dupSourceWindow id', dupSourceWindow.id, 'tabs', dupSourceWindow.tabs.map(t => t.url));
    console.log('[TEST_DEBUG] dupTargetWindow id', dupTargetWindow.id, 'tabs', dupTargetWindow.tabs.map(t => t.url));

    // 清理 mock 中此前测试遗留的窗口，避免 scanOpenWindowsAndAssociate 关联到错误窗口
    const allWindowsBeforeDupScan = await chrome.windows.getAll({ populate: true });
    for (const win of allWindowsBeforeDupScan) {
      if (win.id !== dupSourceWindow.id && win.id !== dupTargetWindow.id) {
        try {
          await chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }

    const dupScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] dup scan associated', dupScanResult.associated);
    const dupDataAfterScan = await loadWorkspaces();
    console.log('[TEST_DEBUG] dup workspaces after scan', JSON.stringify(dupDataAfterScan.workspaces.map(w => ({ id: w.id, windowId: w.windowId, tabs: w.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })) }))));
    assert(dupScanResult.associated >= 2, '扫描至少关联 2 个工作区');

    // 等待 mock 中 tabs.onCreated / tabs.onUpdated 事件处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    // 源窗口中两个 note.ms 都应被关闭
    const dupSourceWindowAfter = await chrome.windows.get(dupSourceWindow.id, { populate: true });
    console.log('[TEST_DEBUG] dupSourceWindowAfter tabs', dupSourceWindowAfter.tabs.map(t => t.url));
    assert(dupSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 0, '源窗口中两个 note.ms 都已关闭');

    // 目标窗口中应恰好有 2 个 note.ms，不能重复
    const dupTargetWindowAfter = await chrome.windows.get(dupTargetWindow.id, { populate: true });
    console.log('[TEST_DEBUG] dupTargetWindowAfter tabs', dupTargetWindowAfter.tabs.map(t => t.url));
    assert(dupTargetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 2, '目标窗口中恰好有 2 个 note.ms');

    const dupDataFinal = await loadWorkspaces();
    const dupTargetFinal = dupDataFinal.workspaces.find(w => w.id === dupTargetFresh.id);
    console.log('[TEST_DEBUG] dupTargetFinal tabs', dupTargetFinal.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })));
    assert(dupTargetFinal.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 2, '目标工作区影子数据中恰好有 2 个 note.ms');
    // 真实窗口与影子数据库标签页数量应保持一致
    assert(dupTargetFinal.tabs.length === dupTargetWindowAfter.tabs.length, '目标工作区影子标签页数与真实窗口标签页数一致');

    // 测试 27：目标窗口已通过 Edge 原生按钮恢复并包含 2 个 note.ms，同步后不应出现第三个
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const nativeSourceWs = await createWorkspace('原生恢复源工作区');
    const nativeTargetWs = await createWorkspace('原生恢复目标工作区');
    await addTabToWorkspace(nativeSourceWs.id, 'https://note.ms/test', 'Note.ms A');
    await addTabToWorkspace(nativeSourceWs.id, 'https://note.ms/test', 'Note.ms B');

    const nativeDataBeforeMove = await loadWorkspaces();
    const nativeSourceFresh = nativeDataBeforeMove.workspaces.find(w => w.id === nativeSourceWs.id);
    const nativeTargetFresh = nativeDataBeforeMove.workspaces.find(w => w.id === nativeTargetWs.id);
    nativeSourceFresh.windowId = null;
    nativeSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    nativeTargetFresh.windowId = null;
    nativeTargetFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [nativeSourceFresh, nativeTargetFresh] });

    const nativeTabA = nativeSourceFresh.tabs[0];
    const nativeTabB = nativeSourceFresh.tabs[1];
    assert(await moveTabToWorkspace(nativeTabA.id, nativeSourceFresh.id, nativeTargetFresh.id) === true, '原生恢复场景第一个 note.ms 移动成功');
    assert(await moveTabToWorkspace(nativeTabB.id, nativeSourceFresh.id, nativeTargetFresh.id) === true, '原生恢复场景第二个 note.ms 移动成功');

    const nativeDataAfterMove = await loadWorkspaces();
    const nativeTargetAfterMove = nativeDataAfterMove.workspaces.find(w => w.id === nativeTargetFresh.id);
    assert(nativeTargetAfterMove.tabs.length === 2, '原生恢复场景目标工作区包含 2 个 note.ms 标签页');

    // 模拟 Edge 原生按钮恢复出的源窗口和目标窗口，均包含 2 个 note.ms
    const nativeSourceWindow = await chrome.windows.create({ url: ['https://note.ms/test', 'https://note.ms/test'], focused: false });
    const nativeTargetWindow = await chrome.windows.create({ url: ['https://note.ms/test', 'https://note.ms/test'], focused: false });
    console.log('[TEST_DEBUG] nativeSourceWindow id', nativeSourceWindow.id, 'tabs', nativeSourceWindow.tabs.map(t => t.url));
    console.log('[TEST_DEBUG] nativeTargetWindow id', nativeTargetWindow.id, 'tabs', nativeTargetWindow.tabs.map(t => t.url));

    // 清理 mock 中此前测试遗留的窗口
    const allWindowsBeforeNativeScan = await chrome.windows.getAll({ populate: true });
    for (const win of allWindowsBeforeNativeScan) {
      if (win.id !== nativeSourceWindow.id && win.id !== nativeTargetWindow.id) {
        try {
          await chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }

    const nativeScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] native scan associated', nativeScanResult.associated);
    const nativeDataAfterScan = await loadWorkspaces();
    console.log('[TEST_DEBUG] native workspaces after scan', JSON.stringify(nativeDataAfterScan.workspaces.map(w => ({ id: w.id, windowId: w.windowId, tabs: w.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })) }))));
    assert(nativeScanResult.associated >= 2, '原生恢复场景扫描至少关联 2 个工作区');

    // 等待 mock 中 tabs.onCreated / tabs.onUpdated 事件处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    const nativeSourceWindowAfter = await chrome.windows.get(nativeSourceWindow.id, { populate: true });
    console.log('[TEST_DEBUG] nativeSourceWindowAfter tabs', nativeSourceWindowAfter.tabs.map(t => t.url));
    assert(nativeSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 0, '原生恢复场景源窗口中两个 note.ms 都已关闭');

    const nativeTargetWindowAfter = await chrome.windows.get(nativeTargetWindow.id, { populate: true });
    console.log('[TEST_DEBUG] nativeTargetWindowAfter tabs', nativeTargetWindowAfter.tabs.map(t => t.url));
    assert(nativeTargetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 2, '原生恢复场景目标窗口中恰好有 2 个 note.ms');

    const nativeDataFinal = await loadWorkspaces();
    const nativeTargetFinal = nativeDataFinal.workspaces.find(w => w.id === nativeTargetFresh.id);
    console.log('[TEST_DEBUG] nativeTargetFinal tabs', nativeTargetFinal.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })));
    assert(nativeTargetFinal.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://note.ms/test')).length === 2, '原生恢复场景目标工作区影子数据中恰好有 2 个 note.ms');
    assert(nativeTargetFinal.tabs.length === nativeTargetWindowAfter.tabs.length, '原生恢复场景目标工作区影子标签页数与真实窗口标签页数一致');

    // 测试 28：从 A 分别移动两个不同页面到 B 和 C，打开三个工作区后互不干扰
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const multiSourceWs = await createWorkspace('多目标源工作区 A');
    const multiTargetB = await createWorkspace('多目标目标工作区 B');
    const multiTargetC = await createWorkspace('多目标目标工作区 C');
    const pageA = await addTabToWorkspace(multiSourceWs.id, 'https://page-a.example.com', 'Page A');
    const pageB = await addTabToWorkspace(multiSourceWs.id, 'https://page-b.example.com', 'Page B');

    const multiDataBeforeMove = await loadWorkspaces();
    const multiSourceFresh = multiDataBeforeMove.workspaces.find(w => w.id === multiSourceWs.id);
    const multiTargetBFresh = multiDataBeforeMove.workspaces.find(w => w.id === multiTargetB.id);
    const multiTargetCFresh = multiDataBeforeMove.workspaces.find(w => w.id === multiTargetC.id);
    multiSourceFresh.windowId = null;
    multiSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    multiTargetBFresh.windowId = null;
    multiTargetBFresh.tabs.forEach(tab => delete tab.realTabId);
    multiTargetCFresh.windowId = null;
    multiTargetCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [multiSourceFresh, multiTargetBFresh, multiTargetCFresh] });

    assert(await moveTabToWorkspace(pageA.id, multiSourceFresh.id, multiTargetBFresh.id) === true, '多目标场景 pageA 移动到 B 成功');
    assert(await moveTabToWorkspace(pageB.id, multiSourceFresh.id, multiTargetCFresh.id) === true, '多目标场景 pageB 移动到 C 成功');

    const multiDataAfterMove = await loadWorkspaces();
    const multiSourceAfterMove = multiDataAfterMove.workspaces.find(w => w.id === multiSourceFresh.id);
    const multiTargetBAfterMove = multiDataAfterMove.workspaces.find(w => w.id === multiTargetBFresh.id);
    const multiTargetCAfterMove = multiDataAfterMove.workspaces.find(w => w.id === multiTargetCFresh.id);
    assert(multiSourceAfterMove.tabs.length === 0, '多目标场景源工作区 A 标签页为空');
    assert(multiSourceAfterMove.pendingCleanup && multiSourceAfterMove.pendingCleanup.urls.length === 2, '多目标场景源工作区 A 待清理 URL 为 2 个');
    assert(multiTargetBAfterMove.tabs.length === 1, '多目标场景目标工作区 B 有 1 个标签页');
    assert(multiTargetCAfterMove.tabs.length === 1, '多目标场景目标工作区 C 有 1 个标签页');

    // 模拟 Edge 原生按钮恢复出的三个窗口
    const multiSourceWindow = await chrome.windows.create({ url: ['https://page-a.example.com', 'https://page-b.example.com'], focused: false });
    const multiTargetBWindow = await chrome.windows.create({ url: ['https://page-a.example.com'], focused: false });
    const multiTargetCWindow = await chrome.windows.create({ url: ['https://page-b.example.com'], focused: false });
    console.log('[TEST_DEBUG] multiSourceWindow id', multiSourceWindow.id, 'tabs', multiSourceWindow.tabs.map(t => t.url));
    console.log('[TEST_DEBUG] multiTargetBWindow id', multiTargetBWindow.id, 'tabs', multiTargetBWindow.tabs.map(t => t.url));
    console.log('[TEST_DEBUG] multiTargetCWindow id', multiTargetCWindow.id, 'tabs', multiTargetCWindow.tabs.map(t => t.url));

    // 清理其他窗口
    const allWindowsBeforeMultiScan = await chrome.windows.getAll({ populate: true });
    for (const win of allWindowsBeforeMultiScan) {
      if (win.id !== multiSourceWindow.id && win.id !== multiTargetBWindow.id && win.id !== multiTargetCWindow.id) {
        try {
          await chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }

    const multiScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] multi scan associated', multiScanResult.associated);
    const multiDataAfterScan = await loadWorkspaces();
    console.log('[TEST_DEBUG] multi workspaces after scan', JSON.stringify(multiDataAfterScan.workspaces.map(w => ({ id: w.id, windowId: w.windowId, tabs: w.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })) }))));
    assert(multiScanResult.associated >= 3, '多目标场景扫描至少关联 3 个工作区');

    // 等待 mock 事件处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    const multiSourceWindowAfter = await chrome.windows.get(multiSourceWindow.id, { populate: true });
    console.log('[TEST_DEBUG] multiSourceWindowAfter tabs', multiSourceWindowAfter.tabs.map(t => t.url));
    assert(multiSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://page-a.example.com')).length === 0, '多目标场景源窗口中 pageA 已关闭');
    assert(multiSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://page-b.example.com')).length === 0, '多目标场景源窗口中 pageB 已关闭');

    const multiTargetBWindowAfter = await chrome.windows.get(multiTargetBWindow.id, { populate: true });
    console.log('[TEST_DEBUG] multiTargetBWindowAfter tabs', multiTargetBWindowAfter.tabs.map(t => t.url));
    assert(multiTargetBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://page-a.example.com')).length === 1, '多目标场景 B 窗口中恰好有 1 个 pageA');

    const multiTargetCWindowAfter = await chrome.windows.get(multiTargetCWindow.id, { populate: true });
    console.log('[TEST_DEBUG] multiTargetCWindowAfter tabs', multiTargetCWindowAfter.tabs.map(t => t.url));
    assert(multiTargetCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://page-b.example.com')).length === 1, '多目标场景 C 窗口中恰好有 1 个 pageB');

    const multiDataFinal = await loadWorkspaces();
    const multiSourceFinal = multiDataFinal.workspaces.find(w => w.id === multiSourceFresh.id);
    const multiTargetBFinal = multiDataFinal.workspaces.find(w => w.id === multiTargetBFresh.id);
    const multiTargetCFinal = multiDataFinal.workspaces.find(w => w.id === multiTargetCFresh.id);
    assert(multiSourceFinal.tabs.length === 0, '多目标场景源工作区 A 最终标签页为空');
    assert(multiSourceFinal.pendingCleanup === undefined, '多目标场景源工作区 A pendingCleanup 已清除');
    assert(multiTargetBFinal.tabs.length === multiTargetBWindowAfter.tabs.length, '多目标场景 B 影子标签页数与真实窗口一致');
    assert(multiTargetCFinal.tabs.length === multiTargetCWindowAfter.tabs.length, '多目标场景 C 影子标签页数与真实窗口一致');

    // 测试 29：源工作区 A 未打开时，scan 不应把 A 关联到 B 或 C 的窗口
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const orphanSourceWs = await createWorkspace('未打开源工作区 A');
    const orphanTargetB = await createWorkspace('已打开目标工作区 B');
    const orphanTargetC = await createWorkspace('已打开目标工作区 C');
    const orphanPageA = await addTabToWorkspace(orphanSourceWs.id, 'https://orphan-a.example.com', 'Orphan A');
    const orphanPageB = await addTabToWorkspace(orphanSourceWs.id, 'https://orphan-b.example.com', 'Orphan B');

    const orphanDataBeforeMove = await loadWorkspaces();
    const orphanSourceFresh = orphanDataBeforeMove.workspaces.find(w => w.id === orphanSourceWs.id);
    const orphanTargetBFresh = orphanDataBeforeMove.workspaces.find(w => w.id === orphanTargetB.id);
    const orphanTargetCFresh = orphanDataBeforeMove.workspaces.find(w => w.id === orphanTargetC.id);
    orphanSourceFresh.windowId = null;
    orphanSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    orphanTargetBFresh.windowId = null;
    orphanTargetBFresh.tabs.forEach(tab => delete tab.realTabId);
    orphanTargetCFresh.windowId = null;
    orphanTargetCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [orphanSourceFresh, orphanTargetBFresh, orphanTargetCFresh] });

    assert(await moveTabToWorkspace(orphanPageA.id, orphanSourceFresh.id, orphanTargetBFresh.id) === true, '未打开源场景 pageA 移动到 B 成功');
    assert(await moveTabToWorkspace(orphanPageB.id, orphanSourceFresh.id, orphanTargetCFresh.id) === true, '未打开源场景 pageB 移动到 C 成功');

    // 只创建 B 和 C 窗口，不创建 A 窗口
    const orphanTargetBWindow = await chrome.windows.create({ url: ['https://orphan-a.example.com'], focused: false });
    const orphanTargetCWindow = await chrome.windows.create({ url: ['https://orphan-b.example.com'], focused: false });
    console.log('[TEST_DEBUG] orphanTargetBWindow id', orphanTargetBWindow.id, 'tabs', orphanTargetBWindow.tabs.map(t => t.url));
    console.log('[TEST_DEBUG] orphanTargetCWindow id', orphanTargetCWindow.id, 'tabs', orphanTargetCWindow.tabs.map(t => t.url));

    // 清理其他窗口
    const allWindowsBeforeOrphanScan = await chrome.windows.getAll({ populate: true });
    for (const win of allWindowsBeforeOrphanScan) {
      if (win.id !== orphanTargetBWindow.id && win.id !== orphanTargetCWindow.id) {
        try {
          await chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }

    const orphanScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] orphan scan associated', orphanScanResult.associated);
    const orphanDataAfterScan = await loadWorkspaces();
    console.log('[TEST_DEBUG] orphan workspaces after scan', JSON.stringify(orphanDataAfterScan.workspaces.map(w => ({ id: w.id, windowId: w.windowId, tabs: w.tabs.map(t => ({ url: t.url, realTabId: t.realTabId })) }))));

    const orphanSourceAfterScan = orphanDataAfterScan.workspaces.find(w => w.id === orphanSourceFresh.id);
    const orphanTargetBAfterScan = orphanDataAfterScan.workspaces.find(w => w.id === orphanTargetBFresh.id);
    const orphanTargetCAfterScan = orphanDataAfterScan.workspaces.find(w => w.id === orphanTargetCFresh.id);
    assert(orphanSourceAfterScan.windowId === null, '未打开源场景源工作区 A 不应被关联到 B/C 窗口');
    assert(orphanSourceAfterScan.pendingCleanup && orphanSourceAfterScan.pendingCleanup.urls.length === 2, '未打开源场景源工作区 A pendingCleanup 应保留');
    assert(orphanTargetBAfterScan.windowId === orphanTargetBWindow.id, '未打开源场景目标工作区 B 关联到 B 窗口');
    assert(orphanTargetCAfterScan.windowId === orphanTargetCWindow.id, '未打开源场景目标工作区 C 关联到 C 窗口');

    // 等待 mock 事件处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    const orphanTargetBWindowAfter = await chrome.windows.get(orphanTargetBWindow.id, { populate: true });
    console.log('[TEST_DEBUG] orphanTargetBWindowAfter tabs', orphanTargetBWindowAfter.tabs.map(t => t.url));
    assert(orphanTargetBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://orphan-a.example.com')).length === 1, '未打开源场景 B 窗口仍保留 pageA');

    const orphanTargetCWindowAfter = await chrome.windows.get(orphanTargetCWindow.id, { populate: true });
    console.log('[TEST_DEBUG] orphanTargetCWindowAfter tabs', orphanTargetCWindowAfter.tabs.map(t => t.url));
    assert(orphanTargetCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://orphan-b.example.com')).length === 1, '未打开源场景 C 窗口仍保留 pageB');

    // 测试 30：批量移动 API - 将源工作区多个标签页一次性移到同一目标工作区
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const batchSourceWs = await createWorkspace('批量源工作区 A');
    const batchTargetWs = await createWorkspace('批量目标工作区 B');
    const batchPage1 = await addTabToWorkspace(batchSourceWs.id, 'https://batch-page1.example.com', 'Batch Page 1');
    const batchPage2 = await addTabToWorkspace(batchSourceWs.id, 'https://batch-page2.example.com', 'Batch Page 2');

    const batchDataBeforeMove = await loadWorkspaces();
    const batchSourceFresh = batchDataBeforeMove.workspaces.find(w => w.id === batchSourceWs.id);
    const batchTargetFresh = batchDataBeforeMove.workspaces.find(w => w.id === batchTargetWs.id);
    batchSourceFresh.windowId = null;
    batchSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    batchTargetFresh.windowId = null;
    batchTargetFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [batchSourceFresh, batchTargetFresh] });

    const batchMoveResult = await moveTabsToWorkspace(
      [batchPage1.id, batchPage2.id],
      batchSourceFresh.id,
      batchTargetFresh.id
    );
    assert(batchMoveResult === true, '批量移动 API 一次性移动两个标签页成功');

    const batchDataAfterMove = await loadWorkspaces();
    const batchSourceAfterMove = batchDataAfterMove.workspaces.find(w => w.id === batchSourceFresh.id);
    const batchTargetAfterMove = batchDataAfterMove.workspaces.find(w => w.id === batchTargetFresh.id);
    assert(batchSourceAfterMove.tabs.length === 0, '批量移动后源工作区 A 标签页为空');
    assert(batchTargetAfterMove.tabs.length === 2, '批量移动后目标工作区 B 包含 2 个标签页');
    assert(batchTargetAfterMove.tabs.some(t => t.url === 'https://batch-page1.example.com'), '批量移动后 B 包含 page1');
    assert(batchTargetAfterMove.tabs.some(t => t.url === 'https://batch-page2.example.com'), '批量移动后 B 包含 page2');

    // 测试 31：批量移动 API - 一对多（同一源工作区分别移动到多个目标工作区）
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const multiBatchSource = await createWorkspace('批量一对多源 A');
    const multiBatchTargetB = await createWorkspace('批量一对多目标 B');
    const multiBatchTargetC = await createWorkspace('批量一对多目标 C');
    const multiPageA = await addTabToWorkspace(multiBatchSource.id, 'https://multi-a.example.com', 'Multi A');
    const multiPageB = await addTabToWorkspace(multiBatchSource.id, 'https://multi-b.example.com', 'Multi B');

    const multiBatchDataBefore = await loadWorkspaces();
    const multiBatchSourceFresh = multiBatchDataBefore.workspaces.find(w => w.id === multiBatchSource.id);
    const multiBatchTargetBFresh = multiBatchDataBefore.workspaces.find(w => w.id === multiBatchTargetB.id);
    const multiBatchTargetCFresh = multiBatchDataBefore.workspaces.find(w => w.id === multiBatchTargetC.id);
    multiBatchSourceFresh.windowId = null;
    multiBatchSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    multiBatchTargetBFresh.windowId = null;
    multiBatchTargetBFresh.tabs.forEach(tab => delete tab.realTabId);
    multiBatchTargetCFresh.windowId = null;
    multiBatchTargetCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [multiBatchSourceFresh, multiBatchTargetBFresh, multiBatchTargetCFresh] });

    const multiBatchMoves = [
      { tabId: multiPageA.id, sourceWorkspaceId: multiBatchSourceFresh.id, targetWorkspaceId: multiBatchTargetBFresh.id },
      { tabId: multiPageB.id, sourceWorkspaceId: multiBatchSourceFresh.id, targetWorkspaceId: multiBatchTargetCFresh.id }
    ];
    assert(await moveTabsToWorkspaces(multiBatchMoves) === true, '批量一对多移动成功');

    const multiBatchSourceWindow = await chrome.windows.create({ url: ['https://multi-a.example.com', 'https://multi-b.example.com'], focused: false });
    const multiBatchTargetBWindow = await chrome.windows.create({ url: ['https://multi-a.example.com'], focused: false });
    const multiBatchTargetCWindow = await chrome.windows.create({ url: ['https://multi-b.example.com'], focused: false });

    // 清理其他窗口
    const allWindowsBeforeMultiBatchScan = await chrome.windows.getAll({ populate: true });
    for (const win of allWindowsBeforeMultiBatchScan) {
      if (win.id !== multiBatchSourceWindow.id && win.id !== multiBatchTargetBWindow.id && win.id !== multiBatchTargetCWindow.id) {
        try {
          await chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }

    const multiBatchScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] multi batch scan associated', multiBatchScanResult.associated);
    assert(multiBatchScanResult.associated >= 3, '批量一对多扫描至少关联 3 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    const multiBatchSourceWindowAfter = await chrome.windows.get(multiBatchSourceWindow.id, { populate: true });
    assert(multiBatchSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://multi-a.example.com')).length === 0, '批量一对多源窗口中 pageA 已关闭');
    assert(multiBatchSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://multi-b.example.com')).length === 0, '批量一对多源窗口中 pageB 已关闭');

    const multiBatchTargetBWindowAfter = await chrome.windows.get(multiBatchTargetBWindow.id, { populate: true });
    assert(multiBatchTargetBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://multi-a.example.com')).length === 1, '批量一对多 B 窗口中恰好有 1 个 pageA');

    const multiBatchTargetCWindowAfter = await chrome.windows.get(multiBatchTargetCWindow.id, { populate: true });
    assert(multiBatchTargetCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://multi-b.example.com')).length === 1, '批量一对多 C 窗口中恰好有 1 个 pageB');

    // 测试 32：批量移动 API - 多对一（多个源工作区标签页移到同一目标工作区）
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const manySourceA = await createWorkspace('多对一源 A');
    const manySourceB = await createWorkspace('多对一源 B');
    const manyTargetC = await createWorkspace('多对一目标 C');
    const manyPageA = await addTabToWorkspace(manySourceA.id, 'https://many-a.example.com', 'Many A');
    const manyPageB = await addTabToWorkspace(manySourceB.id, 'https://many-b.example.com', 'Many B');

    const manyDataBefore = await loadWorkspaces();
    const manySourceAFresh = manyDataBefore.workspaces.find(w => w.id === manySourceA.id);
    const manySourceBFresh = manyDataBefore.workspaces.find(w => w.id === manySourceB.id);
    const manyTargetCFresh = manyDataBefore.workspaces.find(w => w.id === manyTargetC.id);
    manySourceAFresh.windowId = null;
    manySourceAFresh.tabs.forEach(tab => delete tab.realTabId);
    manySourceBFresh.windowId = null;
    manySourceBFresh.tabs.forEach(tab => delete tab.realTabId);
    manyTargetCFresh.windowId = null;
    manyTargetCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [manySourceAFresh, manySourceBFresh, manyTargetCFresh] });

    const manyToOneMoves = [
      { tabId: manyPageA.id, sourceWorkspaceId: manySourceAFresh.id, targetWorkspaceId: manyTargetCFresh.id },
      { tabId: manyPageB.id, sourceWorkspaceId: manySourceBFresh.id, targetWorkspaceId: manyTargetCFresh.id }
    ];
    assert(await moveTabsToWorkspaces(manyToOneMoves) === true, '多对一批量移动成功');

    const manyDataAfterMove = await loadWorkspaces();
    const manySourceAAfterMove = manyDataAfterMove.workspaces.find(w => w.id === manySourceAFresh.id);
    const manySourceBAfterMove = manyDataAfterMove.workspaces.find(w => w.id === manySourceBFresh.id);
    const manyTargetCAfterMove = manyDataAfterMove.workspaces.find(w => w.id === manyTargetCFresh.id);
    assert(manySourceAAfterMove.tabs.length === 0, '多对一源 A 标签页为空');
    assert(manySourceBAfterMove.tabs.length === 0, '多对一源 B 标签页为空');
    assert(manyTargetCAfterMove.tabs.length === 2, '多对一目标 C 包含 2 个标签页');
    assert(manyTargetCAfterMove.tabs.some(t => t.url === 'https://many-a.example.com'), '多对一目标 C 包含 pageA');
    assert(manyTargetCAfterMove.tabs.some(t => t.url === 'https://many-b.example.com'), '多对一目标 C 包含 pageB');

    // 测试 33：多对多 - 工作区既是源又是目标（A→B，C→A），全部关闭后打开
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const m2mA = await createWorkspace('多对多 A');
    const m2mB = await createWorkspace('多对多 B');
    const m2mC = await createWorkspace('多对多 C');
    const m2mPageA1 = await addTabToWorkspace(m2mA.id, 'https://m2m-a1.example.com', 'M2M A1');
    await addTabToWorkspace(m2mA.id, 'https://m2m-a2.example.com', 'M2M A2');
    const m2mPageB1 = await addTabToWorkspace(m2mB.id, 'https://m2m-b1.example.com', 'M2M B1');
    const m2mPageC1 = await addTabToWorkspace(m2mC.id, 'https://m2m-c1.example.com', 'M2M C1');

    const m2mDataBefore = await loadWorkspaces();
    const m2mAFresh = m2mDataBefore.workspaces.find(w => w.id === m2mA.id);
    const m2mBFresh = m2mDataBefore.workspaces.find(w => w.id === m2mB.id);
    const m2mCFresh = m2mDataBefore.workspaces.find(w => w.id === m2mC.id);
    m2mAFresh.windowId = null;
    m2mAFresh.tabs.forEach(tab => delete tab.realTabId);
    m2mBFresh.windowId = null;
    m2mBFresh.tabs.forEach(tab => delete tab.realTabId);
    m2mCFresh.windowId = null;
    m2mCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [m2mAFresh, m2mBFresh, m2mCFresh] });

    const m2mMoves = [
      { tabId: m2mPageA1.id, sourceWorkspaceId: m2mAFresh.id, targetWorkspaceId: m2mBFresh.id },
      { tabId: m2mPageC1.id, sourceWorkspaceId: m2mCFresh.id, targetWorkspaceId: m2mAFresh.id }
    ];
    assert(await moveTabsToWorkspaces(m2mMoves) === true, '多对多批量移动成功');

    // 模拟 Edge 按原生状态恢复三个窗口：源窗口仍含被移出的标签页，目标窗口不含被移入的标签页
    const m2mAWindow = await chrome.windows.create({ url: ['https://m2m-a1.example.com', 'https://m2m-a2.example.com'], focused: false });
    const m2mBWindow = await chrome.windows.create({ url: ['https://m2m-b1.example.com'], focused: false });
    const m2mCWindow = await chrome.windows.create({ url: ['https://m2m-c1.example.com'], focused: false });

    const m2mScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] m2m scan associated', m2mScanResult.associated);
    assert(m2mScanResult.associated >= 3, '多对多扫描至少关联 3 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    const m2mAWindowAfter = await chrome.windows.get(m2mAWindow.id, { populate: true });
    console.log('[TEST_DEBUG] m2mAWindowAfter tabs', m2mAWindowAfter.tabs.map(t => t.url));
    assert(m2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://m2m-a1.example.com')).length === 0, '多对多 A 窗口中 a1 已关闭');
    assert(m2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://m2m-c1.example.com')).length === 1, '多对多 A 窗口中恰好有 1 个 c1');

    const m2mBWindowAfter = await chrome.windows.get(m2mBWindow.id, { populate: true });
    console.log('[TEST_DEBUG] m2mBWindowAfter tabs', m2mBWindowAfter.tabs.map(t => t.url));
    assert(m2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://m2m-b1.example.com')).length === 1, '多对多 B 窗口保留原 b1');
    assert(m2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://m2m-a1.example.com')).length === 1, '多对多 B 窗口中恰好有 1 个 a1');

    const m2mCWindowAfter = await chrome.windows.get(m2mCWindow.id, { populate: true });
    console.log('[TEST_DEBUG] m2mCWindowAfter tabs', m2mCWindowAfter.tabs.map(t => t.url));
    assert(m2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://m2m-c1.example.com')).length === 0, '多对多 C 窗口中 c1 已关闭');

    // 模拟面板显示数据验证：根据 popup.js 的渲染逻辑，面板会读取 workspaceData 并展示工作区名称、标签页列表与打开状态
    const m2mDataForPanel = await loadWorkspaces();
    const m2mAPanel = m2mDataForPanel.workspaces.find(w => w.id === m2mAFresh.id);
    const m2mBPanel = m2mDataForPanel.workspaces.find(w => w.id === m2mBFresh.id);
    const m2mCPanel = m2mDataForPanel.workspaces.find(w => w.id === m2mCFresh.id);

    // A 工作区：原 a1 移出到 B，c1 从 C 移入；面板应显示 a2 与 c1
    assert(m2mAPanel.windowId === m2mAWindow.id, '面板：A 工作区关联到原 A 窗口');
    assert(m2mAPanel.tabs.length === 2, '面板：A 工作区显示 2 个标签页');
    assert(m2mAPanel.tabs.some(t => t.url === 'https://m2m-a2.example.com'), '面板：A 工作区显示保留标签页 a2');
    assert(m2mAPanel.tabs.some(t => t.url === 'https://m2m-c1.example.com'), '面板：A 工作区显示移入标签页 c1');
    assert(!m2mAPanel.tabs.some(t => t.url === 'https://m2m-a1.example.com'), '面板：A 工作区不再显示已移出的 a1');
    assert(m2mAPanel.pendingCleanup === undefined, '面板：A 工作区 pendingCleanup 已清除');

    // B 工作区：原 b1 保留，a1 从 A 移入；面板应显示 b1 与 a1
    assert(m2mBPanel.windowId === m2mBWindow.id, '面板：B 工作区关联到原 B 窗口');
    assert(m2mBPanel.tabs.length === 2, '面板：B 工作区显示 2 个标签页');
    assert(m2mBPanel.tabs.some(t => t.url === 'https://m2m-b1.example.com'), '面板：B 工作区显示保留标签页 b1');
    assert(m2mBPanel.tabs.some(t => t.url === 'https://m2m-a1.example.com'), '面板：B 工作区显示移入标签页 a1');
    assert(m2mBPanel.pendingCleanup === undefined, '面板：B 工作区 pendingCleanup 已清除');

    // C 工作区：原 c1 移出到 A；面板应显示为空
    assert(m2mCPanel.windowId === m2mCWindow.id, '面板：C 工作区关联到原 C 窗口');
    assert(m2mCPanel.tabs.length === 0, '面板：C 工作区显示 0 个标签页');
    assert(m2mCPanel.pendingCleanup === undefined, '面板：C 工作区 pendingCleanup 已清除');

    // 测试 34：多对多边界 - A 仅含一个被移出的标签页且不含任何保留标签页，A 窗口仅含该移出 URL
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const edgeA = await createWorkspace('边界 A');
    const edgeB = await createWorkspace('边界 B');
    const edgeC = await createWorkspace('边界 C');
    const edgePageA1 = await addTabToWorkspace(edgeA.id, 'https://edge-a1.example.com', 'Edge A1');
    const edgePageB1 = await addTabToWorkspace(edgeB.id, 'https://edge-b1.example.com', 'Edge B1');
    const edgePageC1 = await addTabToWorkspace(edgeC.id, 'https://edge-c1.example.com', 'Edge C1');

    const edgeDataBefore = await loadWorkspaces();
    const edgeAFresh = edgeDataBefore.workspaces.find(w => w.id === edgeA.id);
    const edgeBFresh = edgeDataBefore.workspaces.find(w => w.id === edgeB.id);
    const edgeCFresh = edgeDataBefore.workspaces.find(w => w.id === edgeC.id);
    edgeAFresh.windowId = null;
    edgeAFresh.tabs.forEach(tab => delete tab.realTabId);
    edgeBFresh.windowId = null;
    edgeBFresh.tabs.forEach(tab => delete tab.realTabId);
    edgeCFresh.windowId = null;
    edgeCFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [edgeAFresh, edgeBFresh, edgeCFresh] });

    const edgeMoves = [
      { tabId: edgePageA1.id, sourceWorkspaceId: edgeAFresh.id, targetWorkspaceId: edgeBFresh.id },
      { tabId: edgePageC1.id, sourceWorkspaceId: edgeCFresh.id, targetWorkspaceId: edgeAFresh.id }
    ];
    assert(await moveTabsToWorkspaces(edgeMoves) === true, '边界多对多批量移动成功');

    // A 窗口仅含被移出的 a1，B 窗口仅含原 b1，C 窗口仅含被移出的 c1
    const edgeAWindow = await chrome.windows.create({ url: ['https://edge-a1.example.com'], focused: false });
    const edgeBWindow = await chrome.windows.create({ url: ['https://edge-b1.example.com'], focused: false });
    const edgeCWindow = await chrome.windows.create({ url: ['https://edge-c1.example.com'], focused: false });

    const edgeScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] edge scan associated', edgeScanResult.associated);
    assert(edgeScanResult.associated >= 3, '边界多对多扫描至少关联 3 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    const edgeAWindowAfter = await chrome.windows.get(edgeAWindow.id, { populate: true });
    console.log('[TEST_DEBUG] edgeAWindowAfter tabs', edgeAWindowAfter.tabs.map(t => t.url));
    assert(edgeAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://edge-a1.example.com')).length === 0, '边界 A 窗口中 a1 已关闭');
    assert(edgeAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://edge-c1.example.com')).length === 1, '边界 A 窗口中恰好有 1 个 c1');

    const edgeBWindowAfter = await chrome.windows.get(edgeBWindow.id, { populate: true });
    console.log('[TEST_DEBUG] edgeBWindowAfter tabs', edgeBWindowAfter.tabs.map(t => t.url));
    assert(edgeBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://edge-b1.example.com')).length === 1, '边界 B 窗口保留原 b1');
    assert(edgeBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://edge-a1.example.com')).length === 1, '边界 B 窗口中恰好有 1 个 a1');

    const edgeCWindowAfter = await chrome.windows.get(edgeCWindow.id, { populate: true });
    console.log('[TEST_DEBUG] edgeCWindowAfter tabs', edgeCWindowAfter.tabs.map(t => t.url));
    assert(edgeCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://edge-c1.example.com')).length === 0, '边界 C 窗口中 c1 已关闭');

    // 测试 35：大样本一对多 - 1 个源工作区移动 5 个标签页到 5 个不同目标工作区
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const largeSource = await createWorkspace('大样本一对多源');
    const largeTargets = [];
    const largePages = [];
    for (let i = 1; i <= 5; i++) {
      largeTargets.push(await createWorkspace(`大样本一对多目标 ${i}`));
      largePages.push(await addTabToWorkspace(largeSource.id, `https://large1-n${i}.example.com`, `Large 1-N${i}`));
    }

    const largeDataBefore = await loadWorkspaces();
    const largeSourceFresh = largeDataBefore.workspaces.find(w => w.id === largeSource.id);
    const largeTargetFreshs = largeTargets.map(t => largeDataBefore.workspaces.find(w => w.id === t.id));
    largeSourceFresh.windowId = null;
    largeSourceFresh.tabs.forEach(tab => delete tab.realTabId);
    largeTargetFreshs.forEach(t => {
      t.windowId = null;
      t.tabs.forEach(tab => delete tab.realTabId);
    });
    await saveWorkspaces({ version: '1.0.0', workspaces: [largeSourceFresh, ...largeTargetFreshs] });

    const largeOneToManyMoves = largePages.map((page, idx) => ({
      tabId: page.id,
      sourceWorkspaceId: largeSourceFresh.id,
      targetWorkspaceId: largeTargetFreshs[idx].id
    }));
    assert(await moveTabsToWorkspaces(largeOneToManyMoves) === true, '大样本一对多批量移动成功');

    const largeDataAfterMove = await loadWorkspaces();
    const largeSourceAfterMove = largeDataAfterMove.workspaces.find(w => w.id === largeSourceFresh.id);
    assert(largeSourceAfterMove.tabs.length === 0, '大样本一对多源工作区为空');
    assert(largeSourceAfterMove.pendingCleanup && largeSourceAfterMove.pendingCleanup.urls.length === 5, '大样本一对多源工作区待清理 URL 为 5 个');
    for (let i = 0; i < 5; i++) {
      const target = largeDataAfterMove.workspaces.find(w => w.id === largeTargetFreshs[i].id);
      assert(target.tabs.length === 1, `大样本一对多目标 ${i + 1} 有 1 个标签页`);
      assert(target.tabs[0].url === `https://large1-n${i + 1}.example.com`, `大样本一对多目标 ${i + 1} 包含正确标签页`);
    }

    const largeSourceWindow = await chrome.windows.create({
      url: largePages.map(p => p.url),
      focused: false
    });
    const largeTargetWindows = [];
    for (let i = 0; i < 5; i++) {
      largeTargetWindows.push(await chrome.windows.create({ url: [largePages[i].url], focused: false }));
    }

    const largeScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] large one-to-many scan associated', largeScanResult.associated);
    assert(largeScanResult.associated >= 6, '大样本一对多扫描至少关联 6 个工作区');

    console.log('[TEST_DEBUG] large one-to-many before setTimeout');
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('[TEST_DEBUG] large one-to-many after setTimeout');

    console.log('[TEST_DEBUG] large one-to-many before get largeSourceWindow', largeSourceWindow.id);
    const largeSourceWindowAfter = await chrome.windows.get(largeSourceWindow.id, { populate: true });
    console.log('[TEST_DEBUG] large one-to-many after get largeSourceWindow', largeSourceWindowAfter);
    console.log('[TEST_DEBUG] largeSourceWindowAfter tabs', largeSourceWindowAfter.tabs.map(t => t.url));
    for (const page of largePages) {
      assert(largeSourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(page.url)).length === 0, `大样本一对多源窗口中 ${page.url} 已关闭`);
    }

    for (let i = 0; i < 5; i++) {
      const targetWindowAfter = await chrome.windows.get(largeTargetWindows[i].id, { populate: true });
      console.log(`[TEST_DEBUG] largeTargetWindowAfter ${i + 1} tabs`, targetWindowAfter.tabs.map(t => t.url));
      assert(targetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(largePages[i].url)).length === 1, `大样本一对多目标 ${i + 1} 窗口中恰好有 1 个 ${largePages[i].url}`);
    }

    const largeDataFinal = await loadWorkspaces();
    const largeSourceFinal = largeDataFinal.workspaces.find(w => w.id === largeSourceFresh.id);
    assert(largeSourceFinal.tabs.length === 0, '大样本一对多源工作区最终为空');
    assert(largeSourceFinal.pendingCleanup === undefined, '大样本一对多源工作区 pendingCleanup 已清除');

    // 测试 36：大样本多对一 - 5 个源工作区各移动 1 个标签页到同一个目标工作区
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const largeSources = [];
    const largeSourcePages = [];
    for (let i = 1; i <= 5; i++) {
      const ws = await createWorkspace(`大样本多对一源 ${i}`);
      largeSources.push(ws);
      largeSourcePages.push(await addTabToWorkspace(ws.id, `https://largem1-s${i}.example.com`, `Large M1-S${i}`));
    }
    const largeManyToOneTarget = await createWorkspace('大样本多对一目标');
    await addTabToWorkspace(largeManyToOneTarget.id, 'https://largem1-base.example.com', 'Large M1 Base');

    const largeM1DataBefore = await loadWorkspaces();
    const largeM1SourceFreshs = largeSources.map(s => largeM1DataBefore.workspaces.find(w => w.id === s.id));
    const largeM1TargetFresh = largeM1DataBefore.workspaces.find(w => w.id === largeManyToOneTarget.id);
    largeM1SourceFreshs.forEach(s => {
      s.windowId = null;
      s.tabs.forEach(tab => delete tab.realTabId);
    });
    largeM1TargetFresh.windowId = null;
    largeM1TargetFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [...largeM1SourceFreshs, largeM1TargetFresh] });

    const largeManyToOneMoves = largeSourcePages.map((page, idx) => ({
      tabId: page.id,
      sourceWorkspaceId: largeM1SourceFreshs[idx].id,
      targetWorkspaceId: largeM1TargetFresh.id
    }));
    assert(await moveTabsToWorkspaces(largeManyToOneMoves) === true, '大样本多对一批量移动成功');

    const largeM1DataAfterMove = await loadWorkspaces();
    for (let i = 0; i < 5; i++) {
      const source = largeM1DataAfterMove.workspaces.find(w => w.id === largeM1SourceFreshs[i].id);
      assert(source.tabs.length === 0, `大样本多对一源 ${i + 1} 为空`);
    }
    const largeM1TargetAfterMove = largeM1DataAfterMove.workspaces.find(w => w.id === largeM1TargetFresh.id);
    assert(largeM1TargetAfterMove.tabs.length === 6, '大样本多对一目标工作区包含 6 个标签页');
    for (const page of largeSourcePages) {
      assert(largeM1TargetAfterMove.tabs.some(t => t.url === page.url), `大样本多对一目标包含 ${page.url}`);
    }

    const largeM1SourceWindows = [];
    for (let i = 0; i < 5; i++) {
      largeM1SourceWindows.push(await chrome.windows.create({ url: [largeSourcePages[i].url], focused: false }));
    }
    const largeM1TargetWindow = await chrome.windows.create({ url: ['https://largem1-base.example.com', ...largeSourcePages.map(p => p.url)], focused: false });

    const largeM1ScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] large many-to-one scan associated', largeM1ScanResult.associated);
    assert(largeM1ScanResult.associated >= 6, '大样本多对一扫描至少关联 6 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    for (let i = 0; i < 5; i++) {
      const sourceWindowAfter = await chrome.windows.get(largeM1SourceWindows[i].id, { populate: true });
      console.log(`[TEST_DEBUG] largeM1SourceWindowAfter ${i + 1} tabs`, sourceWindowAfter.tabs.map(t => t.url));
      assert(sourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(largeSourcePages[i].url)).length === 0, `大样本多对一源 ${i + 1} 窗口中标签页已关闭`);
    }

    const largeM1TargetWindowAfter = await chrome.windows.get(largeM1TargetWindow.id, { populate: true });
    console.log('[TEST_DEBUG] largeM1TargetWindowAfter tabs', largeM1TargetWindowAfter.tabs.map(t => t.url));
    assert(largeM1TargetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem1-base.example.com')).length === 1, '大样本多对一目标窗口保留 base');
    for (const page of largeSourcePages) {
      assert(largeM1TargetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(page.url)).length === 1, `大样本多对一目标窗口包含 ${page.url}`);
    }

    // 测试 37：大样本多对多 - 3 个工作区互相移动，均既是源又是目标
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const largeM2mA = await createWorkspace('大样本多对多 A');
    const largeM2mB = await createWorkspace('大样本多对多 B');
    const largeM2mC = await createWorkspace('大样本多对多 C');
    const largeM2mPagesA = [];
    const largeM2mPagesB = [];
    const largeM2mPagesC = [];
    for (let i = 1; i <= 3; i++) {
      largeM2mPagesA.push(await addTabToWorkspace(largeM2mA.id, `https://largem2m-a${i}.example.com`, `Large M2M A${i}`));
      largeM2mPagesB.push(await addTabToWorkspace(largeM2mB.id, `https://largem2m-b${i}.example.com`, `Large M2M B${i}`));
      largeM2mPagesC.push(await addTabToWorkspace(largeM2mC.id, `https://largem2m-c${i}.example.com`, `Large M2M C${i}`));
    }

    const largeM2mDataBefore = await loadWorkspaces();
    const largeM2mAFresh = largeM2mDataBefore.workspaces.find(w => w.id === largeM2mA.id);
    const largeM2mBFresh = largeM2mDataBefore.workspaces.find(w => w.id === largeM2mB.id);
    const largeM2mCFresh = largeM2mDataBefore.workspaces.find(w => w.id === largeM2mC.id);
    [largeM2mAFresh, largeM2mBFresh, largeM2mCFresh].forEach(ws => {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
    });
    await saveWorkspaces({ version: '1.0.0', workspaces: [largeM2mAFresh, largeM2mBFresh, largeM2mCFresh] });

    const largeM2mMoves = [
      ...largeM2mPagesA.slice(0, 2).map(p => ({ tabId: p.id, sourceWorkspaceId: largeM2mAFresh.id, targetWorkspaceId: largeM2mBFresh.id })),
      ...largeM2mPagesB.slice(0, 2).map(p => ({ tabId: p.id, sourceWorkspaceId: largeM2mBFresh.id, targetWorkspaceId: largeM2mCFresh.id })),
      ...largeM2mPagesC.slice(0, 2).map(p => ({ tabId: p.id, sourceWorkspaceId: largeM2mCFresh.id, targetWorkspaceId: largeM2mAFresh.id }))
    ];
    assert(await moveTabsToWorkspaces(largeM2mMoves) === true, '大样本多对多批量移动成功');

    const largeM2mDataAfterMove = await loadWorkspaces();
    const largeM2mAAfterMove = largeM2mDataAfterMove.workspaces.find(w => w.id === largeM2mAFresh.id);
    const largeM2mBAfterMove = largeM2mDataAfterMove.workspaces.find(w => w.id === largeM2mBFresh.id);
    const largeM2mCAfterMove = largeM2mDataAfterMove.workspaces.find(w => w.id === largeM2mCFresh.id);
    assert(largeM2mAAfterMove.tabs.length === 3, '大样本多对多 A 包含 3 个标签页（1 保留 + 2 移入）');
    assert(largeM2mAAfterMove.tabs.some(t => t.url === 'https://largem2m-a3.example.com'), '大样本多对多 A 保留 a3');
    assert(largeM2mAAfterMove.tabs.some(t => t.url === 'https://largem2m-c1.example.com'), '大样本多对多 A 移入 c1');
    assert(largeM2mAAfterMove.tabs.some(t => t.url === 'https://largem2m-c2.example.com'), '大样本多对多 A 移入 c2');
    assert(largeM2mBAfterMove.tabs.length === 3, '大样本多对多 B 包含 3 个标签页（1 保留 + 2 移入）');
    assert(largeM2mBAfterMove.tabs.some(t => t.url === 'https://largem2m-b3.example.com'), '大样本多对多 B 保留 b3');
    assert(largeM2mBAfterMove.tabs.some(t => t.url === 'https://largem2m-a1.example.com'), '大样本多对多 B 移入 a1');
    assert(largeM2mBAfterMove.tabs.some(t => t.url === 'https://largem2m-a2.example.com'), '大样本多对多 B 移入 a2');
    assert(largeM2mCAfterMove.tabs.length === 3, '大样本多对多 C 包含 3 个标签页（1 保留 + 2 移入）');
    assert(largeM2mCAfterMove.tabs.some(t => t.url === 'https://largem2m-c3.example.com'), '大样本多对多 C 保留 c3');
    assert(largeM2mCAfterMove.tabs.some(t => t.url === 'https://largem2m-b1.example.com'), '大样本多对多 C 移入 b1');
    assert(largeM2mCAfterMove.tabs.some(t => t.url === 'https://largem2m-b2.example.com'), '大样本多对多 C 移入 b2');

    const largeM2mAWindow = await chrome.windows.create({ url: largeM2mPagesA.map(p => p.url), focused: false });
    const largeM2mBWindow = await chrome.windows.create({ url: largeM2mPagesB.map(p => p.url), focused: false });
    const largeM2mCWindow = await chrome.windows.create({ url: largeM2mPagesC.map(p => p.url), focused: false });

    const largeM2mScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_DEBUG] large m2m scan associated', largeM2mScanResult.associated);
    assert(largeM2mScanResult.associated >= 3, '大样本多对多扫描至少关联 3 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    const largeM2mAWindowAfter = await chrome.windows.get(largeM2mAWindow.id, { populate: true });
    console.log('[TEST_DEBUG] largeM2mAWindowAfter tabs', largeM2mAWindowAfter.tabs.map(t => t.url));
    assert(largeM2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-a1.example.com')).length === 0, '大样本多对多 A 窗口中 a1 已关闭');
    assert(largeM2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-a2.example.com')).length === 0, '大样本多对多 A 窗口中 a2 已关闭');
    assert(largeM2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-a3.example.com')).length === 1, '大样本多对多 A 窗口保留 a3');
    assert(largeM2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-c1.example.com')).length === 1, '大样本多对多 A 窗口包含 c1');
    assert(largeM2mAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-c2.example.com')).length === 1, '大样本多对多 A 窗口包含 c2');

    const largeM2mBWindowAfter = await chrome.windows.get(largeM2mBWindow.id, { populate: true });
    console.log('[TEST_DEBUG] largeM2mBWindowAfter tabs', largeM2mBWindowAfter.tabs.map(t => t.url));
    assert(largeM2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-b1.example.com')).length === 0, '大样本多对多 B 窗口中 b1 已关闭');
    assert(largeM2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-b2.example.com')).length === 0, '大样本多对多 B 窗口中 b2 已关闭');
    assert(largeM2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-b3.example.com')).length === 1, '大样本多对多 B 窗口保留 b3');
    assert(largeM2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-a1.example.com')).length === 1, '大样本多对多 B 窗口包含 a1');
    assert(largeM2mBWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-a2.example.com')).length === 1, '大样本多对多 B 窗口包含 a2');

    const largeM2mCWindowAfter = await chrome.windows.get(largeM2mCWindow.id, { populate: true });
    console.log('[TEST_DEBUG] largeM2mCWindowAfter tabs', largeM2mCWindowAfter.tabs.map(t => t.url));
    assert(largeM2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-c1.example.com')).length === 0, '大样本多对多 C 窗口中 c1 已关闭');
    assert(largeM2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-c2.example.com')).length === 0, '大样本多对多 C 窗口中 c2 已关闭');
    assert(largeM2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-c3.example.com')).length === 1, '大样本多对多 C 窗口保留 c3');
    assert(largeM2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-b1.example.com')).length === 1, '大样本多对多 C 窗口包含 b1');
    assert(largeM2mCWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://largem2m-b2.example.com')).length === 1, '大样本多对多 C 窗口包含 b2');

    const largeM2mDataFinal = await loadWorkspaces();
    const largeM2mAFinal = largeM2mDataFinal.workspaces.find(w => w.id === largeM2mAFresh.id);
    const largeM2mBFinal = largeM2mDataFinal.workspaces.find(w => w.id === largeM2mBFresh.id);
    const largeM2mCFinal = largeM2mDataFinal.workspaces.find(w => w.id === largeM2mCFresh.id);
    assert(largeM2mAFinal.pendingCleanup === undefined, '大样本多对多 A pendingCleanup 已清除');
    assert(largeM2mBFinal.pendingCleanup === undefined, '大样本多对多 B pendingCleanup 已清除');
    assert(largeM2mCFinal.pendingCleanup === undefined, '大样本多对多 C pendingCleanup 已清除');

    // 测试 38：2 源 7 目标随机移动
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const perfSourceA = await createWorkspace('性能测试源 A');
    const perfSourceB = await createWorkspace('性能测试源 B');
    const perfTargets = [];
    for (let i = 1; i <= 7; i++) {
      perfTargets.push(await createWorkspace(`性能测试目标 ${i}`));
    }

    // 为每个源工作区创建 10 个标签页
    const perfSourceAPages = [];
    const perfSourceBPages = [];
    for (let i = 1; i <= 10; i++) {
      perfSourceAPages.push(await addTabToWorkspace(perfSourceA.id, `https://perf38-a${i}.example.com`, `Perf38 A${i}`));
      perfSourceBPages.push(await addTabToWorkspace(perfSourceB.id, `https://perf38-b${i}.example.com`, `Perf38 B${i}`));
    }

    const perfDataBefore = await loadWorkspaces();
    const perfSourceAFresh = perfDataBefore.workspaces.find(w => w.id === perfSourceA.id);
    const perfSourceBFresh = perfDataBefore.workspaces.find(w => w.id === perfSourceB.id);
    const perfTargetFreshs = perfTargets.map(t => perfDataBefore.workspaces.find(w => w.id === t.id));
    [perfSourceAFresh, perfSourceBFresh, ...perfTargetFreshs].forEach(ws => {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
    });
    await saveWorkspaces({ version: '1.0.0', workspaces: [perfSourceAFresh, perfSourceBFresh, ...perfTargetFreshs] });

    // 随机移动：从 A 和 B 中各随机选 7 个标签页，随机分配到 7 个目标
    const perf38Moves = [];
    const shuffledAPages = perfSourceAPages.sort(() => Math.random() - 0.5).slice(0, 7);
    const shuffledBPages = perfSourceBPages.sort(() => Math.random() - 0.5).slice(0, 7);
    for (let i = 0; i < 7; i++) {
      perf38Moves.push({ tabId: shuffledAPages[i].id, sourceWorkspaceId: perfSourceAFresh.id, targetWorkspaceId: perfTargetFreshs[i].id });
      perf38Moves.push({ tabId: shuffledBPages[i].id, sourceWorkspaceId: perfSourceBFresh.id, targetWorkspaceId: perfTargetFreshs[(i + 3) % 7].id });
    }

    console.log('[TEST_PERF] 测试38开始，移动数量', perf38Moves.length);
    const perf38Start = performance.now();
    assert(await moveTabsToWorkspaces(perf38Moves) === true, '性能测试 2 源 7 目标随机移动成功');
    console.log('[TEST_PERF] 测试38 moveTabsToWorkspaces 完成，耗时', (performance.now() - perf38Start).toFixed(2), 'ms');

    const perf38DataAfterMove = await loadWorkspaces();
    const perf38SourceAAfter = perf38DataAfterMove.workspaces.find(w => w.id === perfSourceAFresh.id);
    const perf38SourceBAfter = perf38DataAfterMove.workspaces.find(w => w.id === perfSourceBFresh.id);
    assert(perf38SourceAAfter.tabs.length === 3, '测试38 源 A 剩余 3 个标签页');
    assert(perf38SourceBAfter.tabs.length === 3, '测试38 源 B 剩余 3 个标签页');
    for (let i = 0; i < 7; i++) {
      const target = perf38DataAfterMove.workspaces.find(w => w.id === perfTargetFreshs[i].id);
      assert(target.tabs.length === 2, `测试38 目标 ${i + 1} 包含 2 个标签页`);
    }

    // 模拟窗口
    const perf38SourceWindowA = await chrome.windows.create({ url: perf38SourceAAfter.tabs.map(t => t.url), focused: false });
    const perf38SourceWindowB = await chrome.windows.create({ url: perf38SourceBAfter.tabs.map(t => t.url), focused: false });
    const perf38TargetWindows = [];
    for (let i = 0; i < 7; i++) {
      const target = perf38DataAfterMove.workspaces.find(w => w.id === perfTargetFreshs[i].id);
      perf38TargetWindows.push(await chrome.windows.create({ url: target.tabs.map(t => t.url), focused: false }));
    }

    const perf38ScanStart = performance.now();
    const perf38ScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_PERF] 测试38 scanOpenWindowsAndAssociate 完成，耗时', (performance.now() - perf38ScanStart).toFixed(2), 'ms');
    assert(perf38ScanResult.associated >= 9, '测试38 扫描至少关联 9 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证源窗口中移出的标签页已关闭
    const perf38SourceWindowAAfter = await chrome.windows.get(perf38SourceWindowA.id, { populate: true });
    for (const page of shuffledAPages) {
      assert(perf38SourceWindowAAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(page.url)).length === 0, `测试38 源 A 窗口中 ${page.url} 已关闭`);
    }
    const perf38SourceWindowBAfter = await chrome.windows.get(perf38SourceWindowB.id, { populate: true });
    for (const page of shuffledBPages) {
      assert(perf38SourceWindowBAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(page.url)).length === 0, `测试38 源 B 窗口中 ${page.url} 已关闭`);
    }

    // 验证目标窗口
    for (let i = 0; i < 7; i++) {
      const targetWindowAfter = await chrome.windows.get(perf38TargetWindows[i].id, { populate: true });
      const target = perf38DataAfterMove.workspaces.find(w => w.id === perfTargetFreshs[i].id);
      for (const tab of target.tabs) {
        assert(targetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(tab.url)).length === 1, `测试38 目标 ${i + 1} 窗口包含 ${tab.url}`);
      }
    }

    // 测试 39：13 源 1 目标，每个源移动数量不同
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const perf39Sources = [];
    for (let i = 1; i <= 13; i++) {
      perf39Sources.push(await createWorkspace(`性能测试39源 ${i}`));
    }
    const perf39Target = await createWorkspace('性能测试39目标');

    const perf39SourcePages = [];
    for (let i = 0; i < 13; i++) {
      const pages = [];
      for (let j = 1; j <= i + 1; j++) {
        pages.push(await addTabToWorkspace(perf39Sources[i].id, `https://perf39-s${i + 1}-p${j}.example.com`, `Perf39 S${i + 1} P${j}`));
      }
      perf39SourcePages.push(pages);
    }

    const perf39DataBefore = await loadWorkspaces();
    const perf39SourceFreshs = perf39Sources.map(s => perf39DataBefore.workspaces.find(w => w.id === s.id));
    const perf39TargetFresh = perf39DataBefore.workspaces.find(w => w.id === perf39Target.id);
    perf39SourceFreshs.forEach(ws => {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
    });
    perf39TargetFresh.windowId = null;
    perf39TargetFresh.tabs.forEach(tab => delete tab.realTabId);
    await saveWorkspaces({ version: '1.0.0', workspaces: [...perf39SourceFreshs, perf39TargetFresh] });

    const perf39Moves = [];
    for (let i = 0; i < 13; i++) {
      for (const page of perf39SourcePages[i]) {
        perf39Moves.push({ tabId: page.id, sourceWorkspaceId: perf39SourceFreshs[i].id, targetWorkspaceId: perf39TargetFresh.id });
      }
    }

    console.log('[TEST_PERF] 测试39开始，移动数量', perf39Moves.length);
    const perf39Start = performance.now();
    assert(await moveTabsToWorkspaces(perf39Moves) === true, '性能测试 13 源 1 目标移动成功');
    console.log('[TEST_PERF] 测试39 moveTabsToWorkspaces 完成，耗时', (performance.now() - perf39Start).toFixed(2), 'ms');

    const perf39DataAfterMove = await loadWorkspaces();
    const perf39TargetAfter = perf39DataAfterMove.workspaces.find(w => w.id === perf39TargetFresh.id);
    assert(perf39TargetAfter.tabs.length === 91, '测试39 目标工作区包含 91 个标签页');
    for (let i = 0; i < 13; i++) {
      const source = perf39DataAfterMove.workspaces.find(w => w.id === perf39SourceFreshs[i].id);
      assert(source.tabs.length === 0, `测试39 源 ${i + 1} 为空`);
    }

    // 模拟窗口
    const perf39SourceWindows = [];
    for (let i = 0; i < 13; i++) {
      perf39SourceWindows.push(await chrome.windows.create({ url: perf39SourcePages[i].map(p => p.url), focused: false }));
    }
    const perf39TargetWindow = await chrome.windows.create({ url: perf39TargetAfter.tabs.map(t => t.url), focused: false });

    const perf39ScanStart = performance.now();
    const perf39ScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_PERF] 测试39 scanOpenWindowsAndAssociate 完成，耗时', (performance.now() - perf39ScanStart).toFixed(2), 'ms');
    assert(perf39ScanResult.associated >= 14, '测试39 扫描至少关联 14 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证源窗口中移出的标签页已关闭
    for (let i = 0; i < 13; i++) {
      const sourceWindowAfter = await chrome.windows.get(perf39SourceWindows[i].id, { populate: true });
      assert(sourceWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(`https://perf39-s${i + 1}-p1.example.com`)).length === 0, `测试39 源 ${i + 1} 窗口中标签页已关闭`);
    }

    // 验证目标窗口包含所有 91 个标签页
    const perf39TargetWindowAfter = await chrome.windows.get(perf39TargetWindow.id, { populate: true });
    for (let i = 0; i < 13; i++) {
      for (const page of perf39SourcePages[i]) {
        assert(perf39TargetWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(page.url)).length === 1, `测试39 目标窗口包含 ${page.url}`);
      }
    }

    // 测试 40：31 工作区随机移动，总共不少于 100 个标签页，每个工作区都有操作
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const perf40Workspaces = [];
    for (let i = 1; i <= 31; i++) {
      perf40Workspaces.push(await createWorkspace(`性能测试40工作区 ${i}`));
    }

    // 为每个工作区创建 5 个标签页
    const perf40Pages = [];
    for (let i = 0; i < 31; i++) {
      const pages = [];
      for (let j = 1; j <= 5; j++) {
        pages.push(await addTabToWorkspace(perf40Workspaces[i].id, `https://perf40-w${i + 1}-p${j}.example.com`, `Perf40 W${i + 1} P${j}`));
      }
      perf40Pages.push(pages);
    }

    const perf40DataBefore = await loadWorkspaces();
    const perf40WorkspaceFreshs = perf40Workspaces.map(w => perf40DataBefore.workspaces.find(ws => ws.id === w.id));
    perf40WorkspaceFreshs.forEach(ws => {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
    });
    await saveWorkspaces({ version: '1.0.0', workspaces: perf40WorkspaceFreshs });

    // 生成随机移动计划：确保每个工作区至少移出或移入一次，总移动数 >= 100
    const perf40Moves = [];
    const involvedWorkspaceIds = new Set();
    // 记录每个源工作区已移出的标签页索引集合
    const movedOutTabIdsBySource = new Array(31).fill(null).map(() => new Set());

    // 先为每个工作区生成至少一次移出操作
    for (let i = 0; i < 31; i++) {
      const sourceIdx = i;
      const targetIdx = (i + 1) % 31;
      const page = perf40Pages[sourceIdx][0];
      perf40Moves.push({ tabId: page.id, sourceWorkspaceId: perf40WorkspaceFreshs[sourceIdx].id, targetWorkspaceId: perf40WorkspaceFreshs[targetIdx].id });
      involvedWorkspaceIds.add(perf40WorkspaceFreshs[sourceIdx].id);
      involvedWorkspaceIds.add(perf40WorkspaceFreshs[targetIdx].id);
      movedOutTabIdsBySource[sourceIdx].add(page.id);
    }

    // 再随机补充移动，直到总移动数 >= 100，且每个源工作区至少保留 1 个标签页
    let moveIdCounter = 0;
    while (perf40Moves.length < 100) {
      const sourceIdx = Math.floor(Math.random() * 31);
      const targetIdx = Math.floor(Math.random() * 31);
      if (sourceIdx === targetIdx) continue;

      // 源工作区最多移出 4 个标签页，保留至少 1 个
      if (movedOutTabIdsBySource[sourceIdx].size >= 4) continue;

      // 从源工作区中选择一个尚未被移出的标签页
      const sourcePages = perf40Pages[sourceIdx];
      const availablePages = sourcePages.filter(p => !movedOutTabIdsBySource[sourceIdx].has(p.id));
      if (availablePages.length === 0) continue;
      const page = availablePages[Math.floor(Math.random() * availablePages.length)];

      perf40Moves.push({ tabId: page.id, sourceWorkspaceId: perf40WorkspaceFreshs[sourceIdx].id, targetWorkspaceId: perf40WorkspaceFreshs[targetIdx].id });
      involvedWorkspaceIds.add(perf40WorkspaceFreshs[sourceIdx].id);
      involvedWorkspaceIds.add(perf40WorkspaceFreshs[targetIdx].id);
      movedOutTabIdsBySource[sourceIdx].add(page.id);
      moveIdCounter++;
      if (moveIdCounter > 500) break; // 防止死循环
    }

    console.log('[TEST_PERF] 测试40开始，工作区数 31，移动数量', perf40Moves.length);
    const perf40Start = performance.now();
    assert(await moveTabsToWorkspaces(perf40Moves) === true, '性能测试 31 工作区随机移动成功');
    console.log('[TEST_PERF] 测试40 moveTabsToWorkspaces 完成，耗时', (performance.now() - perf40Start).toFixed(2), 'ms');

    const perf40DataAfterMove = await loadWorkspaces();
    assert(perf40DataAfterMove.workspaces.length === 31, '测试40 工作区总数仍为 31');
    for (const ws of perf40DataAfterMove.workspaces) {
      assert(involvedWorkspaceIds.has(ws.id), '测试40 每个工作区都参与了移动');
    }

    // 统计总移动标签页数
    const totalMovedTabs = perf40Moves.length;
    assert(totalMovedTabs >= 100, `测试40 总移动标签页数 ${totalMovedTabs} >= 100`);

    // 模拟所有工作区窗口
    const perf40Windows = [];
    for (let i = 0; i < 31; i++) {
      const ws = perf40DataAfterMove.workspaces.find(w => w.id === perf40WorkspaceFreshs[i].id);
      const urls = ws.tabs.map(t => t.url);
      if (urls.length === 0) {
        urls.push('edge://newtab/');
      }
      perf40Windows.push(await chrome.windows.create({ url: urls, focused: false }));
    }

    const perf40ScanStart = performance.now();
    const perf40ScanResult = await scanOpenWindowsAndAssociate();
    console.log('[TEST_PERF] 测试40 scanOpenWindowsAndAssociate 完成，耗时', (performance.now() - perf40ScanStart).toFixed(2), 'ms');
    assert(perf40ScanResult.associated >= 31, '测试40 扫描至少关联 31 个工作区');

    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证每个工作区窗口中的标签页与影子数据一致
    for (let i = 0; i < 31; i++) {
      const ws = perf40DataAfterMove.workspaces.find(w => w.id === perf40WorkspaceFreshs[i].id);
      const windowAfter = await chrome.windows.get(perf40Windows[i].id, { populate: true });
      assert(windowAfter.tabs.length === ws.tabs.length, `测试40 工作区 ${i + 1} 窗口标签页数与影子数据一致`);
      for (const tab of ws.tabs) {
        assert(windowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl(tab.url)).length === 1, `测试40 工作区 ${i + 1} 窗口包含 ${tab.url}`);
      }
    }

    // 测试 41：模拟 Edge 原生工作区分次打开 - 先从 B 移出两个标签页到 A 和 C，然后只打开 A
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const nativeA = await createWorkspace('原生 A');
    const nativeB = await createWorkspace('原生 B');
    const nativeC = await createWorkspace('原生 C');
    const nativeAOriginal = await addTabToWorkspace(nativeA.id, 'https://native-a.example.com', 'Native A');
    const nativeBTab1 = await addTabToWorkspace(nativeB.id, 'https://native-b1.example.com', 'Native B1');
    const nativeBTab2 = await addTabToWorkspace(nativeB.id, 'https://native-b2.example.com', 'Native B2');
    const nativeCOriginal = await addTabToWorkspace(nativeC.id, 'https://native-c.example.com', 'Native C');

    const nativeDataBefore = await loadWorkspaces();
    const nativeAFresh = nativeDataBefore.workspaces.find(w => w.id === nativeA.id);
    const nativeBFresh = nativeDataBefore.workspaces.find(w => w.id === nativeB.id);
    const nativeCFresh = nativeDataBefore.workspaces.find(w => w.id === nativeC.id);
    [nativeAFresh, nativeBFresh, nativeCFresh].forEach(ws => {
      ws.windowId = null;
      ws.tabs.forEach(tab => delete tab.realTabId);
    });
    await saveWorkspaces({ version: '1.0.0', workspaces: [nativeAFresh, nativeBFresh, nativeCFresh] });

    const nativeMoves = [
      { tabId: nativeBTab1.id, sourceWorkspaceId: nativeBFresh.id, targetWorkspaceId: nativeAFresh.id },
      { tabId: nativeBTab2.id, sourceWorkspaceId: nativeBFresh.id, targetWorkspaceId: nativeCFresh.id }
    ];
    assert(await moveTabsToWorkspaces(nativeMoves) === true, '原生场景批量移动成功');

    // 模拟 Edge 原生只打开工作区 A：窗口仅包含 A 的原始标签页（不含已移入的 b1）
    const nativeAWindow = await chrome.windows.create({ url: ['https://native-a.example.com'], focused: false });

    // 等待窗口创建监听器（500ms）和焦点扫描监听器（300ms）完成
    await new Promise(resolve => setTimeout(resolve, 700));

    await new Promise(resolve => setTimeout(resolve, 200));

    const nativeAWindowAfter = await chrome.windows.get(nativeAWindow.id, { populate: true });
    console.log('[TEST_DEBUG] nativeAWindowAfter tabs', nativeAWindowAfter.tabs.map(t => t.url));
    assert(nativeAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://native-a.example.com')).length === 1, '原生 A 窗口保留原 a');
    assert(nativeAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://native-b1.example.com')).length === 1, '原生 A 窗口恰好有 1 个 b1');
    assert(nativeAWindowAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://native-c.example.com')).length === 0, '原生 A 窗口不含 C 的原标签页');

    const nativeOnlyDataFinal = await loadWorkspaces();
    const nativeAFinal = nativeOnlyDataFinal.workspaces.find(w => w.id === nativeAFresh.id);
    const nativeBFinal = nativeOnlyDataFinal.workspaces.find(w => w.id === nativeBFresh.id);
    const nativeCFinal = nativeOnlyDataFinal.workspaces.find(w => w.id === nativeCFresh.id);
    assert(nativeAFinal.windowId === nativeAWindow.id, '原生 A 工作区关联到 A 窗口');
    assert(nativeBFinal.windowId === null, '原生 B 工作区未关联（未打开）');
    assert(nativeCFinal.windowId === null, '原生 C 工作区未关联（未打开）');

    // 测试 42：用户原生拖拽跨窗口移动标签页（tabs.onDetached/onAttached 事件驱动同步）
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const moveSrc = await createWorkspace('移动源');
    const moveDst = await createWorkspace('移动目标');
    await addTabToWorkspace(moveSrc.id, 'https://move-src.example.com', 'Move Src');
    await addTabToWorkspace(moveDst.id, 'https://move-dst.example.com', 'Move Dst');
    await forceCreateWorkspaceWindow(moveSrc.id);
    const openedMoveDst = await forceCreateWorkspaceWindow(moveDst.id);

    const moveDataBefore = await loadWorkspaces();
    const moveSrcTab = moveDataBefore.workspaces.find(w => w.id === moveSrc.id).tabs[0];
    // 用户将源工作区的标签页拖到目标工作区窗口
    await chrome.tabs.move(moveSrcTab.realTabId, { windowId: openedMoveDst.windowId, index: -1 });
    // 等待 onDetached/onAttached 事件处理完成
    await new Promise(resolve => setTimeout(resolve, 80));

    const moveDataAfter = await loadWorkspaces();
    const moveSrcAfter = moveDataAfter.workspaces.find(w => w.id === moveSrc.id);
    const moveDstAfter = moveDataAfter.workspaces.find(w => w.id === moveDst.id);
    assert(moveSrcAfter.tabs.length === 0, '跨窗口移动后源工作区标签页被移除');
    assert(moveDstAfter.tabs.filter(t => normalizeUrl(t.url) === normalizeUrl('https://move-src.example.com')).length === 1, '跨窗口移动后目标工作区包含移入标签页');
    assert(moveDstAfter.tabs.length === 2, '跨窗口移动后目标工作区共 2 个标签页');

    // 测试 43：惰性打开——仅活动页 eager 加载，其余标签页 discard 挂起
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const lazyWs = await createWorkspace('惰性打开');
    await addTabToWorkspace(lazyWs.id, 'https://lazy-1.example.com', 'Lazy 1');
    await addTabToWorkspace(lazyWs.id, 'https://lazy-2.example.com', 'Lazy 2');
    await addTabToWorkspace(lazyWs.id, 'https://lazy-3.example.com', 'Lazy 3');
    const openedLazy = await forceCreateWorkspaceWindow(lazyWs.id);
    assert(openedLazy && openedLazy.windowId, '惰性打开创建窗口成功');

    const lazyWindow = await chrome.windows.get(openedLazy.windowId, { populate: true });
    assert(lazyWindow.tabs.length === 3, '惰性打开窗口共 3 个标签页');
    assert(lazyWindow.tabs[0].discarded !== true, '活动页未被挂起');
    assert(lazyWindow.tabs[1].discarded === true, '第二个标签页被挂起（惰性）');
    assert(lazyWindow.tabs[2].discarded === true, '第三个标签页被挂起（惰性）');

    // 测试 44：原生标签页组——打开工作区时应用影子分组到原生分组（影子 → 原生）
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const groupWs = await createWorkspace('分组应用');
    const gTab1 = await addTabToWorkspace(groupWs.id, 'https://group-1.example.com', 'G1');
    const gTab2 = await addTabToWorkspace(groupWs.id, 'https://group-2.example.com', 'G2');
    await addTabToWorkspace(groupWs.id, 'https://group-3.example.com', 'G3');
    const shadowGroup = await createGroup(groupWs.id, '开发工具');
    await assignTabToGroup(groupWs.id, gTab1.id, shadowGroup.id);
    await assignTabToGroup(groupWs.id, gTab2.id, shadowGroup.id);

    const openedGroup = await forceCreateWorkspaceWindow(groupWs.id);
    assert(openedGroup && openedGroup.windowId, '分组应用创建窗口成功');
    const groupWindow = await chrome.windows.get(openedGroup.windowId, { populate: true });
    const groupedTabs = groupWindow.tabs.filter(t => t.groupId !== undefined && t.groupId !== null);
    assert(groupedTabs.length === 2, '原生分组包含 2 个标签页');
    const nativeGroups = await chrome.tabGroups.query({ windowId: openedGroup.windowId });
    assert(nativeGroups.length === 1, '窗口中有 1 个原生分组');
    assert(nativeGroups[0].title === '开发工具', '原生分组名称已应用');

    // 测试 45：原生标签页组——导入窗口时捕获原生分组到影子库（原生 → 影子）
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const nativeWin = await chrome.windows.create({
      url: ['https://native-group-a.example.com', 'https://native-group-b.example.com', 'https://native-ungrouped.example.com'],
      focused: false
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    const ngId = await chrome.tabs.group({
      tabIds: [nativeWin.tabs[0].id, nativeWin.tabs[1].id],
      createProperties: { windowId: nativeWin.id }
    });
    await chrome.tabGroups.update(ngId, { title: '原生分组', color: 'green' });

    const capturedWs = await importCurrentWindow('捕获分组');
    assert(capturedWs && capturedWs.groups.length === 1, '捕获到 1 个原生分组');
    assert(capturedWs.groups[0].name === '原生分组', '捕获的分组名称正确');
    assert(capturedWs.tabs.filter(t => t.groupId === capturedWs.groups[0].id).length === 2, '分组包含 2 个标签页');
    assert(capturedWs.tabs.filter(t => !t.groupId).length === 1, '未分组标签页 1 个');

    // 测试 46：sessions.restore 高保真恢复——关闭后重开走会话恢复
    await clearAllWindows();
    await saveWorkspaces({ version: '1.0.0', workspaces: [] });
    await clearPendingOperations();
    const sessWs = await createWorkspace('会话恢复');
    await addTabToWorkspace(sessWs.id, 'https://sess-1.example.com', 'S1');
    await addTabToWorkspace(sessWs.id, 'https://sess-2.example.com', 'S2');
    const openedSess = await forceCreateWorkspaceWindow(sessWs.id);
    assert(openedSess && openedSess.windowId, '会话恢复：首次打开窗口成功');

    await closeWorkspace(sessWs.id);
    const afterClose = await loadWorkspaces();
    const closedSess = afterClose.workspaces.find(w => w.id === sessWs.id);
    assert(closedSess.lastSessionId !== undefined && closedSess.lastSessionId !== null, '关闭后记录会话 ID');

    const reopenedSess = await forceCreateWorkspaceWindow(sessWs.id);
    assert(reopenedSess && reopenedSess.windowId, '会话恢复：重开窗口成功');
    const reopenedData = await loadWorkspaces();
    const reopenedWs = reopenedData.workspaces.find(w => w.id === sessWs.id);
    assert(reopenedWs.tabs.length === 2, '恢复后影子库保留 2 个标签页');
    assert(reopenedWs.tabs.every(t => typeof t.realTabId === 'number'), '恢复后所有标签页映射 realTabId');
    assert(!reopenedWs.lastSessionId, '会话 ID 一次性使用后清除');

    } catch (error) {
      log(`测试执行异常: ${error.message}`, 'fail');
      console.error('[TEST_EXCEPTION]', error);
    }

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
