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

    // 测试 8：打开工作区窗口
    const openedWs = await openWorkspace(ws.id);
    assert(openedWs && openedWs.windowId, 'openWorkspace 创建窗口并记录 windowId');
    assert(openedWs.tabs.every(t => typeof t.realTabId === 'number'), '打开窗口后所有标签页记录 realTabId');

    // 测试 9：关闭工作区窗口
    const closed = await closeWorkspace(ws.id);
    assert(closed === true, 'closeWorkspace 关闭成功');
    const dataAfterClose = await loadWorkspaces();
    assert(dataAfterClose.workspaces[0].windowId === null, '关闭后 windowId 清空');

    // 测试 10：导入当前窗口
    const imported = await importCurrentWindow('导入测试');
    assert(imported && imported.name === '导入测试', 'importCurrentWindow 使用指定名称');
    assert(imported.tabs.length === 2, '导入当前窗口包含 2 个标签页');
    assert(imported.tabs[0].realTabId, '导入的标签页记录 realTabId');

    const finalData = await loadWorkspaces();
    assert(finalData.workspaces.length === 2, '最终存在 2 个工作区');

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
  }

  // 页面加载后执行测试
  runTests().catch((error) => {
    log(`测试执行异常: ${error.message}`, 'fail');
    summaryEl.textContent = '测试执行异常';
    summaryEl.className = 'fail';
    window.__testResults = { pass: passCount, fail: failCount + 1, total: passCount + failCount + 1, success: false, error: error.message };
  });
})();
