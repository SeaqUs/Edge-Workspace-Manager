/**
 * Edge Workspace Manager - Popup 面板交互逻辑
 * 负责渲染工作区列表、处理用户操作并调用后台消息接口
 */

(function () {
  'use strict';

  // DOM 元素引用
  const workspaceListEl = document.getElementById('workspace-list');
  const emptyStateEl = document.getElementById('empty-state');
  const createPanelEl = document.getElementById('create-panel');
  const inputWorkspaceNameEl = document.getElementById('input-workspace-name');
  const btnCreateWorkspaceEl = document.getElementById('btn-create-workspace');
  const btnConfirmCreateEl = document.getElementById('btn-confirm-create');
  const btnCancelCreateEl = document.getElementById('btn-cancel-create');
  const btnScanWindowsEl = document.getElementById('btn-scan-windows');
  const errorMessageEl = document.getElementById('error-message');

  // 手动导入面板相关元素
  const importPanelEl = document.getElementById('import-panel');
  const importWindowListEl = document.getElementById('import-window-list');
  const btnCloseImportEl = document.getElementById('btn-close-import');
  const btnSelectAllEl = document.getElementById('btn-select-all');
  const btnDeselectAllEl = document.getElementById('btn-deselect-all');
  const btnConfirmImportEl = document.getElementById('btn-confirm-import');

  // 侧边栏导航
  const navWorkspacesEl = document.getElementById('nav-workspaces');
  const navImportEl = document.getElementById('nav-import');
  const statWorkspaceCountEl = document.getElementById('stat-workspace-count');
  const statOpenedEl = document.getElementById('stat-opened');
  const statTabsEl = document.getElementById('stat-tabs');

  // 数据迁移相关元素
  const btnExportDataEl = document.getElementById('btn-export-data');
  const btnImportDataEl = document.getElementById('btn-import-data');
  const inputImportFileEl = document.getElementById('input-import-file');

  // 回收站相关元素
  const navTrashEl = document.getElementById('nav-trash');
  const trashPanelEl = document.getElementById('trash-panel');
  const trashListEl = document.getElementById('trash-list');
  const trashEmptyEl = document.getElementById('trash-empty');
  const btnEmptyTrashEl = document.getElementById('btn-empty-trash');

  // 搜索
  const inputSearchEl = document.getElementById('input-search');

  // 当前数据缓存
  let workspaceData = { workspaces: [] };
  // 搜索关键字
  let searchQuery = '';
  // 当前可导入窗口缓存
  let importableWindows = [];
  // 存在待执行操作的工作区 ID 集合
  let pendingWorkspaceIds = new Set();
  // 当前多选中的标签页集合，键格式为 "workspaceId:tabId"
  const selectedTabs = new Set();

  /**
   * 页面加载完成后初始化
   */
  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadAndRender();

    // 监听后台数据变化消息
    chrome.runtime.onMessage.addListener((request) => {
      if (request && request.type === 'WORKSPACE_DATA_CHANGED') {
        loadAndRender();
      }
    });
  });

  /**
   * 绑定界面事件
   */
  function bindEvents() {
    btnCreateWorkspaceEl.addEventListener('click', showCreatePanel);
    btnConfirmCreateEl.addEventListener('click', confirmCreateWorkspace);
    btnCancelCreateEl.addEventListener('click', hideCreatePanel);
    btnScanWindowsEl.addEventListener('click', scanOpenWindows);

    inputWorkspaceNameEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        confirmCreateWorkspace();
      }
    });

    // 手动导入面板事件
    btnCloseImportEl.addEventListener('click', () => switchView('workspaces'));
    btnSelectAllEl.addEventListener('click', () => setAllImportCheckboxes(true));
    btnDeselectAllEl.addEventListener('click', () => setAllImportCheckboxes(false));
    btnConfirmImportEl.addEventListener('click', confirmImportSelected);

    // 侧边栏导航
    navWorkspacesEl.addEventListener('click', () => switchView('workspaces'));
    navImportEl.addEventListener('click', () => switchView('import'));
    navTrashEl.addEventListener('click', () => switchView('trash'));

    // 数据迁移事件
    btnExportDataEl.addEventListener('click', exportData);
    btnImportDataEl.addEventListener('click', () => inputImportFileEl.click());
    inputImportFileEl.addEventListener('change', importDataFromFile);

    // 回收站事件
    btnEmptyTrashEl.addEventListener('click', emptyTrash);

    // 搜索事件
    inputSearchEl.addEventListener('input', (event) => {
      searchQuery = (event.target.value || '').trim().toLowerCase();
      renderWorkspaceList();
    });
  }

  /**
   * 导出全部工作区数据为 JSON 文件（数据备份）
   */
  async function exportData() {
    try {
      const response = await sendMessage({ type: 'EXPORT_DATA' });
      if (!response || !response.success) {
        showError(response && response.error ? response.error : '导出失败');
        return;
      }
      const blob = new Blob([response.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edge-workspace-manager-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      showError(`导出失败: ${error.message}`);
    }
  }

  /**
   * 从 JSON 文件导入工作区数据（替换现有全部工作区）
   * @param {Event} event - 文件输入的 change 事件
   */
  async function importDataFromFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!confirm('导入将替换当前所有工作区数据，是否继续？')) {
      inputImportFileEl.value = '';
      return;
    }
    try {
      const text = await file.text();
      const response = await sendMessage({ type: 'IMPORT_DATA', data: text });
      if (response && response.success) {
        await loadAndRender();
        showError(`已导入 ${response.workspaceCount} 个工作区`);
      } else {
        showError(response && response.error ? response.error : '导入失败');
      }
    } catch (error) {
      showError(`导入失败: ${error.message}`);
    } finally {
      inputImportFileEl.value = '';
    }
  }

  /**
   * 加载并渲染回收站列表
   */
  async function loadTrashView() {
    try {
      const response = await sendMessage({ type: 'GET_DELETED_WORKSPACES' });
      const deleted = (response && response.success && response.workspaces) || [];
      trashListEl.innerHTML = '';
      trashEmptyEl.classList.toggle('hidden', deleted.length > 0);

      deleted.forEach((ws) => {
        const item = document.createElement('div');
        item.className = 'import-window-item';

        const info = document.createElement('div');
        info.className = 'import-window-info';

        const title = document.createElement('div');
        title.className = 'import-window-title';
        title.textContent = ws.name || '未命名工作区';

        const meta = document.createElement('div');
        meta.className = 'import-window-meta';
        meta.textContent = `${ws.tabs ? ws.tabs.length : 0} 个标签页`;

        info.appendChild(title);
        info.appendChild(meta);

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn-small btn-primary';
        restoreBtn.type = 'button';
        restoreBtn.textContent = '恢复';
        restoreBtn.addEventListener('click', () => restoreWorkspaceFromTrash(ws.id));

        item.appendChild(info);
        item.appendChild(restoreBtn);
        trashListEl.appendChild(item);
      });
    } catch (error) {
      showError(`加载回收站失败: ${error.message}`);
    }
  }

  /**
   * 从回收站恢复单个工作区
   * @param {string} workspaceId - 工作区 ID
   */
  async function restoreWorkspaceFromTrash(workspaceId) {
    try {
      const response = await sendMessage({ type: 'RESTORE_WORKSPACE', workspaceId });
      if (response && response.success) {
        await loadTrashView();
      } else {
        showError(response && response.error ? response.error : '恢复失败');
      }
    } catch (error) {
      showError(`恢复失败: ${error.message}`);
    }
  }

  /**
   * 清空回收站
   */
  async function emptyTrash() {
    if (!confirm('确定清空回收站吗？此操作不可恢复。')) {
      return;
    }
    try {
      const response = await sendMessage({ type: 'EMPTY_TRASH' });
      if (response && response.success) {
        await loadTrashView();
      } else {
        showError(response && response.error ? response.error : '清空失败');
      }
    } catch (error) {
      showError(`清空失败: ${error.message}`);
    }
  }

  /**
   * 显示新建工作区输入面板
   */
  function showCreatePanel() {
    createPanelEl.classList.remove('hidden');
    inputWorkspaceNameEl.value = '';
    inputWorkspaceNameEl.focus();
  }

  /**
   * 隐藏新建工作区输入面板
   */
  function hideCreatePanel() {
    createPanelEl.classList.add('hidden');
    inputWorkspaceNameEl.value = '';
  }

  /**
   * 切换侧边栏导航视图
   * @param {'workspaces'|'import'|'trash'} view - 目标视图
   */
  async function switchView(view) {
    // 重置所有导航状态
    navWorkspacesEl.classList.remove('active');
    navImportEl.classList.remove('active');
    navTrashEl.classList.remove('active');
    importPanelEl.classList.add('hidden');
    trashPanelEl.classList.add('hidden');
    workspaceListEl.classList.add('hidden');
    emptyStateEl.classList.add('hidden');
    createPanelEl.classList.add('hidden');

    if (view === 'workspaces') {
      navWorkspacesEl.classList.add('active');
      workspaceListEl.classList.remove('hidden');
      emptyStateEl.classList.toggle('hidden', workspaceData.workspaces.length > 0);
      await loadAndRender();
    } else if (view === 'import') {
      navImportEl.classList.add('active');
      importPanelEl.classList.remove('hidden');
      await loadAndRenderImportableWindows();
    } else if (view === 'trash') {
      navTrashEl.classList.add('active');
      trashPanelEl.classList.remove('hidden');
      await loadTrashView();
    }
  }

  /**
   * 显示手动导入面板并加载可导入窗口
   */
  async function showImportPanel() {
    await switchView('import');
  }

  /**
   * 隐藏手动导入面板
   */
  function hideImportPanel() {
    switchView('workspaces');
  }

  /**
   * 从后台加载所有可导入的浏览器窗口并渲染
   */
  async function loadAndRenderImportableWindows() {
    try {
      const response = await sendMessage({ type: 'GET_OPEN_WINDOWS' });
      if (response && response.success) {
        importableWindows = response.windows || [];
        renderImportableWindows();
      } else {
        showError(response && response.error ? response.error : '加载窗口列表失败');
      }
    } catch (error) {
      showError(`加载窗口列表失败: ${error.message}`);
    }
  }

  /**
   * 渲染可导入窗口列表
   */
  function renderImportableWindows() {
    importWindowListEl.innerHTML = '';

    if (importableWindows.length === 0) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'import-window-item';
      emptyItem.textContent = '未发现可导入的普通窗口';
      importWindowListEl.appendChild(emptyItem);
      return;
    }

    importableWindows.forEach((win) => {
      const item = document.createElement('label');
      item.className = 'import-window-item';
      item.htmlFor = `import-win-${win.id}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `import-win-${win.id}`;
      checkbox.value = win.id;
      checkbox.dataset.windowId = win.id;

      const info = document.createElement('div');
      info.className = 'import-window-info';

      const title = document.createElement('div');
      title.className = 'import-window-title';
      title.textContent = win.title || `窗口 ${win.id}`;

      const tabs = document.createElement('div');
      tabs.className = 'import-window-meta';
      tabs.textContent = `${win.tabCount} 个标签页`;

      info.appendChild(title);
      info.appendChild(tabs);
      item.appendChild(checkbox);
      item.appendChild(info);

      // 点击整行切换复选框
      item.addEventListener('click', (event) => {
        if (event.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
      });

      importWindowListEl.appendChild(item);
    });
  }

  /**
   * 设置所有导入复选框状态
   * @param {boolean} checked - 是否选中
   */
  function setAllImportCheckboxes(checked) {
    const checkboxes = importWindowListEl.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = checked; });
  }

  /**
   * 确认导入选中的窗口
   */
  async function confirmImportSelected() {
    const checkboxes = importWindowListEl.querySelectorAll('input[type="checkbox"]:checked');
    const windowIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.windowId, 10));

    if (windowIds.length === 0) {
      showError('请至少选择一个窗口');
      return;
    }

    try {
      const response = await sendMessage({
        type: 'IMPORT_SELECTED_WINDOWS',
        windowIds
      });
      if (response && response.success) {
        hideImportPanel();
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '导入失败');
      }
    } catch (error) {
      showError(`导入失败: ${error.message}`);
    }
  }

  /**
   * 确认创建新工作区
   */
  async function confirmCreateWorkspace() {
    const name = inputWorkspaceNameEl.value.trim();
    if (!name) {
      showError('请输入工作区名称');
      return;
    }

    try {
      const response = await sendMessage({ type: 'CREATE_WORKSPACE', name });
      if (response && response.success) {
        hideCreatePanel();
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '创建工作区失败');
      }
    } catch (error) {
      showError(`创建工作区失败: ${error.message}`);
    }
  }

  /**
   * 从后台加载工作区数据并渲染
   */
  async function loadAndRender() {
    try {
      const [workspacesResponse, pendingResponse] = await Promise.all([
        sendMessage({ type: 'GET_WORKSPACES' }),
        sendMessage({ type: 'GET_ALL_PENDING_WORKSPACE_IDS' })
      ]);

      if (workspacesResponse && workspacesResponse.success) {
        workspaceData = workspacesResponse.data;
        pendingWorkspaceIds = new Set((pendingResponse && pendingResponse.success ? pendingResponse.workspaceIds : []) || []);
        renderWorkspaceList();
        updateSidebarStats();
        hideError();
      } else {
        showError(workspacesResponse && workspacesResponse.error ? workspacesResponse.error : '加载数据失败');
      }
    } catch (error) {
      showError(`加载数据失败: ${error.message}`);
    }
  }

  /**
   * 更新侧边栏统计数据
   */
  function updateSidebarStats() {
    const workspaces = workspaceData.workspaces || [];
    const openedCount = workspaces.filter(ws => ws.windowId).length;
    const totalTabs = workspaces.reduce((sum, ws) => sum + (ws.tabs ? ws.tabs.length : 0), 0);

    statWorkspaceCountEl.textContent = workspaces.length;
    statOpenedEl.textContent = openedCount;
    statTabsEl.textContent = totalTabs;
  }

  /**
   * 渲染工作区列表
   */
  function renderWorkspaceList() {
    workspaceListEl.innerHTML = '';

    if (!workspaceData.workspaces || workspaceData.workspaces.length === 0) {
      emptyStateEl.classList.remove('hidden');
      return;
    }

    emptyStateEl.classList.add('hidden');

    // 按搜索关键字过滤工作区（匹配工作区名称或标签页标题/URL）
    const filtered = workspaceData.workspaces.filter((ws) => {
      if (!searchQuery) return true;
      if ((ws.name || '').toLowerCase().includes(searchQuery)) return true;
      return (ws.tabs || []).some(tab =>
        (tab.title || '').toLowerCase().includes(searchQuery) ||
        (tab.url || '').toLowerCase().includes(searchQuery)
      );
    });

    if (filtered.length === 0 && searchQuery) {
      emptyStateEl.classList.remove('hidden');
      return;
    }

    filtered.forEach((ws) => {
      const card = buildWorkspaceCard(ws);
      workspaceListEl.appendChild(card);
    });
  }

  /**
   * 构建单个工作区卡片 DOM
   * @param {object} ws - 工作区数据对象
   * @returns {HTMLElement} 卡片根元素
   */
  function buildWorkspaceCard(ws) {
    const isPending = pendingWorkspaceIds.has(ws.id);
    const card = document.createElement('div');
    card.className = `workspace-card${isPending ? ' pending' : ''}`;
    card.dataset.workspaceId = ws.id;

    // 工作区卡片作为跨工作区拖拽放置目标
    card.addEventListener('dragover', handleWorkspaceDragOver);
    card.addEventListener('dragleave', handleWorkspaceDragLeave);
    card.addEventListener('drop', handleWorkspaceDrop);

    // 头部：名称、状态与操作按钮
    const header = document.createElement('div');
    header.className = 'workspace-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'workspace-title';

    const nameEl = document.createElement('button');
    nameEl.className = 'workspace-name';
    nameEl.type = 'button';
    nameEl.textContent = ws.name;
    nameEl.title = ws.windowId ? '点击关闭工作区窗口' : '点击打开工作区';
    nameEl.addEventListener('click', () => toggleWorkspace(ws.id));

    const statusEl = document.createElement('span');
    if (isPending) {
      statusEl.className = 'workspace-status pending';
      statusEl.innerHTML = '<span class="status-dot"></span>等待原生工作区';
    } else {
      statusEl.className = `workspace-status ${ws.windowId ? 'open' : 'closed'}`;
      statusEl.innerHTML = `<span class="status-dot"></span>${ws.windowId ? '已打开' : '未打开'}`;
    }

    titleEl.appendChild(nameEl);
    titleEl.appendChild(statusEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'workspace-actions';

    if (isPending) {
      // 等待原生工作区打开中：允许立即强制创建窗口或取消等待
      const forceCreateBtn = document.createElement('button');
      forceCreateBtn.className = 'btn btn-small btn-secondary';
      forceCreateBtn.type = 'button';
      forceCreateBtn.textContent = '立即创建';
      forceCreateBtn.title = '不等原生工作区，直接创建新窗口打开';
      forceCreateBtn.addEventListener('click', () => forceCreateWorkspace(ws.id));
      actionsEl.appendChild(forceCreateBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-small btn-text';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消等待';
      cancelBtn.title = '取消待执行的打开操作';
      cancelBtn.addEventListener('click', () => cancelPendingOperations(ws.id));
      actionsEl.appendChild(cancelBtn);
    } else if (ws.windowId) {
      // 窗口已打开：显示关闭与同步按钮
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-small btn-secondary';
      closeBtn.type = 'button';
      closeBtn.textContent = '关闭';
      closeBtn.title = '关闭该窗口';
      closeBtn.addEventListener('click', () => toggleWorkspace(ws.id));
      actionsEl.appendChild(closeBtn);

      const syncBtn = document.createElement('button');
      syncBtn.className = 'btn btn-small btn-secondary';
      syncBtn.type = 'button';
      syncBtn.textContent = '同步';
      syncBtn.title = '将扩展工作区与当前窗口标签页强制同步';
      syncBtn.addEventListener('click', () => syncWorkspace(ws.id));
      actionsEl.appendChild(syncBtn);
    } else {
      // 窗口未打开：显示打开与关联当前窗口按钮
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-small btn-secondary';
      openBtn.type = 'button';
      openBtn.textContent = '打开';
      openBtn.title = '等待对应的 Edge 原生工作区窗口打开后自动同步';
      openBtn.addEventListener('click', () => toggleWorkspace(ws.id));
      actionsEl.appendChild(openBtn);

      const associateBtn = document.createElement('button');
      associateBtn.className = 'btn btn-small btn-secondary';
      associateBtn.type = 'button';
      associateBtn.textContent = '关联当前窗口';
      associateBtn.title = '将当前聚焦的 Edge 窗口关联到此扩展工作区';
      associateBtn.addEventListener('click', () => associateCurrentWindowToWorkspace(ws.id));
      actionsEl.appendChild(associateBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small btn-text';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => deleteWorkspace(ws.id));
    actionsEl.appendChild(deleteBtn);
    header.appendChild(titleEl);
    header.appendChild(actionsEl);

    // 主体区域
    const body = document.createElement('div');
    body.className = 'workspace-body';

    // 元信息：标签页数量、分组数量与更新时间
    const meta = document.createElement('div');
    meta.className = 'workspace-meta';
    const groupCount = ws.groups ? ws.groups.length : 0;
    meta.innerHTML = `
      <div class="workspace-meta-left">
        <span>${ws.tabs ? ws.tabs.length : 0} 标签页</span>
        <span>${groupCount} 分组</span>
      </div>
      <span>${formatDate(ws.updatedAt)}</span>
    `;

    // 标签页列表
    const tabList = document.createElement('div');
    tabList.className = 'tab-list';
    tabList.dataset.workspaceId = ws.id;

    // 标签页列表支持同工作区内拖拽排序
    tabList.addEventListener('dragover', handleTabListDragOver);
    tabList.addEventListener('dragleave', handleTabListDragLeave);
    tabList.addEventListener('drop', handleTabListDrop);

    if (ws.tabs && ws.tabs.length > 0) {
      ws.tabs.forEach((tab) => {
        const tabItem = buildTabItem(ws, tab);
        tabList.appendChild(tabItem);
      });
    } else {
      const emptyTabs = document.createElement('div');
      emptyTabs.className = 'empty-tabs';
      emptyTabs.textContent = '暂无标签页，点击下方添加';
      tabList.appendChild(emptyTabs);
    }

    // 分组区域
    const groupSection = buildGroupSection(ws);

    // 添加标签页输入区
    const addTabForm = document.createElement('div');
    addTabForm.className = 'add-tab-form';

    const tabInput = document.createElement('input');
    tabInput.type = 'text';
    tabInput.placeholder = '输入 URL 添加标签页';
    tabInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        addTab(ws.id, tabInput.value.trim());
        tabInput.value = '';
      }
    });

    const addTabBtn = document.createElement('button');
    addTabBtn.className = 'btn btn-primary btn-small';
    addTabBtn.type = 'button';
    addTabBtn.textContent = '添加';
    addTabBtn.addEventListener('click', () => {
      addTab(ws.id, tabInput.value.trim());
      tabInput.value = '';
    });

    addTabForm.appendChild(tabInput);
    addTabForm.appendChild(addTabBtn);

    body.appendChild(meta);
    body.appendChild(tabList);
    body.appendChild(groupSection);
    body.appendChild(addTabForm);

    card.appendChild(header);
    card.appendChild(body);

    return card;
  }

  /**
   * 构建工作区分组区域 DOM
   * @param {object} ws - 工作区数据对象
   * @returns {HTMLElement} 分组区域根元素
   */
  function buildGroupSection(ws) {
    const section = document.createElement('div');
    section.className = 'group-section';

    // 分组标题行
    const headerRow = document.createElement('div');
    headerRow.className = 'group-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'group-name';
    const colorDot = document.createElement('span');
    colorDot.className = 'group-color';
    colorDot.style.backgroundColor = '#cbd5e1';
    const title = document.createElement('span');
    title.textContent = '分组';
    nameEl.appendChild(colorDot);
    nameEl.appendChild(title);

    const createGroupBtn = document.createElement('button');
    createGroupBtn.className = 'btn btn-text btn-small';
    createGroupBtn.type = 'button';
    createGroupBtn.textContent = '新建分组';
    createGroupBtn.addEventListener('click', () => {
      const name = prompt('请输入分组名称');
      if (name && name.trim()) {
        createGroup(ws.id, name.trim());
      }
    });

    headerRow.appendChild(nameEl);
    headerRow.appendChild(createGroupBtn);
    section.appendChild(headerRow);

    // 分组列表
    if (ws.groups && ws.groups.length > 0) {
      const list = document.createElement('div');
      list.className = 'group-tabs';

      ws.groups.forEach((group) => {
        const groupItem = document.createElement('div');
        groupItem.className = 'tab-item';
        groupItem.style.cursor = 'default';

        const gColorDot = document.createElement('span');
        gColorDot.className = 'group-color';
        gColorDot.style.backgroundColor = group.color || '#999999';

        const groupName = document.createElement('span');
        groupName.className = 'tab-title';
        groupName.textContent = group.name;

        const tabCount = ws.tabs.filter(t => t.groupId === group.id).length;
        const countBadge = document.createElement('span');
        countBadge.className = 'tab-group-select';
        countBadge.textContent = `${tabCount} 标签页`;

        groupItem.appendChild(gColorDot);
        groupItem.appendChild(groupName);
        groupItem.appendChild(countBadge);
        list.appendChild(groupItem);
      });

      section.appendChild(list);
    }

    return section;
  }

  /**
   * 构建单个标签页 DOM
   * @param {object} ws - 标签页所属工作区对象
   * @param {object} tab - 标签页数据对象
   * @returns {HTMLElement} 标签页根元素
   */
  function buildTabItem(ws, tab) {
    const selectionKey = `${ws.id}:${tab.id}`;
    const isSelected = selectedTabs.has(selectionKey);

    const item = document.createElement('div');
    item.className = `tab-item${isSelected ? ' selected' : ''}`;
    item.draggable = true;
    item.dataset.tabId = tab.id;
    item.dataset.workspaceId = ws.id;

    // 拖拽事件绑定
    item.addEventListener('dragstart', handleTabDragStart);
    item.addEventListener('dragend', handleTabDragEnd);

    // 多选复选框
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-select';
    checkbox.checked = isSelected;
    checkbox.title = '选择该标签页以批量移动';
    checkbox.addEventListener('change', (event) => {
      event.stopPropagation();
      toggleTabSelection(ws.id, tab.id, checkbox.checked);
      // 同步更新当前项的选中样式
      item.classList.toggle('selected', checkbox.checked);
    });

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favIconUrl || 'icons/icon.svg';
    favicon.alt = '';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;
    title.title = tab.url;

    // 分组选择下拉框
    const groupSelect = document.createElement('select');
    groupSelect.className = 'tab-group-select';
    groupSelect.title = '分配到分组';

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '未分组';
    groupSelect.appendChild(emptyOption);

    if (ws.groups && ws.groups.length > 0) {
      ws.groups.forEach((group) => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        if (tab.groupId === group.id) {
          option.selected = true;
        }
        groupSelect.appendChild(option);
      });
    }

    groupSelect.addEventListener('change', () => {
      assignTabToGroup(ws.id, tab.id, groupSelect.value || null);
    });

    const actionsEl = document.createElement('div');
    actionsEl.className = 'tab-actions';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-text btn-small';
    removeBtn.type = 'button';
    removeBtn.textContent = '移除';
    removeBtn.title = '移除标签页';
    removeBtn.addEventListener('click', () => removeTab(ws.id, tab.id));

    actionsEl.appendChild(groupSelect);
    actionsEl.appendChild(removeBtn);

    item.appendChild(checkbox);
    item.appendChild(favicon);
    item.appendChild(title);
    item.appendChild(actionsEl);

    return item;
  }

  /**
   * 切换单个标签页的选中状态
   * @param {string} workspaceId - 工作区 ID
   * @param {string} tabId - 标签页 ID
   * @param {boolean} selected - 是否选中
   */
  function toggleTabSelection(workspaceId, tabId, selected) {
    const key = `${workspaceId}:${tabId}`;
    if (selected) {
      selectedTabs.add(key);
    } else {
      selectedTabs.delete(key);
    }
  }

  /**
   * 获取指定工作区中当前已选中的标签页 ID 列表（按工作区标签页顺序）
   * @param {string} workspaceId - 工作区 ID
   * @returns {string[]} 选中的标签页 ID 数组
   */
  function getSelectedTabIdsForWorkspace(workspaceId) {
    const ws = workspaceData.workspaces.find(w => w.id === workspaceId);
    if (!ws || !ws.tabs) return [];
    return ws.tabs
      .filter(tab => selectedTabs.has(`${workspaceId}:${tab.id}`))
      .map(tab => tab.id);
  }

  /**
   * 打开或关闭工作区窗口
   * @param {string} workspaceId - 工作区 ID
   */
  async function toggleWorkspace(workspaceId) {
    try {
      const ws = workspaceData.workspaces.find(w => w.id === workspaceId);
      const messageType = ws && ws.windowId ? 'CLOSE_WORKSPACE' : 'OPEN_WORKSPACE';
      const response = await sendMessage({ type: messageType, workspaceId });
      if (response && response.success) {
        if (messageType === 'OPEN_WORKSPACE' && response.pending) {
          showError('已加入等待队列，请在 Edge 中打开对应原生工作区，扩展将自动同步标签页。');
        }
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '操作失败');
      }
    } catch (error) {
      showError(`操作工作区失败: ${error.message}`);
    }
  }

  /**
   * 不等原生工作区，直接强制创建新窗口打开工作区
   * @param {string} workspaceId - 工作区 ID
   */
  async function forceCreateWorkspace(workspaceId) {
    try {
      const response = await sendMessage({ type: 'FORCE_CREATE_WORKSPACE_WINDOW', workspaceId });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '强制创建窗口失败');
      }
    } catch (error) {
      showError(`强制创建窗口失败: ${error.message}`);
    }
  }

  /**
   * 取消指定工作区的待执行操作
   * @param {string} workspaceId - 工作区 ID
   */
  async function cancelPendingOperations(workspaceId) {
    try {
      const response = await sendMessage({ type: 'CLEAR_PENDING_OPERATIONS', workspaceId });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError('取消等待失败');
      }
    } catch (error) {
      showError(`取消等待失败: ${error.message}`);
    }
  }

  /**
   * 将当前聚焦的浏览器窗口关联到指定扩展工作区
   * 用于 Edge 原生按钮打开窗口后手动建立映射
   * @param {string} workspaceId - 工作区 ID
   */
  async function associateCurrentWindowToWorkspace(workspaceId) {
    try {
      const response = await sendMessage({ type: 'ASSOCIATE_CURRENT_WINDOW', workspaceId });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError('关联失败，请确保目标窗口已打开且不是管理面板窗口');
      }
    } catch (error) {
      showError(`关联窗口失败: ${error.message}`);
    }
  }

  /**
   * 删除工作区
   * @param {string} workspaceId - 工作区 ID
   */
  async function deleteWorkspace(workspaceId) {
    if (!confirm('确定要删除该扩展工作区吗？此操作不可恢复。')) {
      return;
    }

    try {
      const response = await sendMessage({ type: 'DELETE_WORKSPACE', workspaceId });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '删除失败');
      }
    } catch (error) {
      showError(`删除工作区失败: ${error.message}`);
    }
  }

  /**
   * 添加标签页
   * @param {string} workspaceId - 工作区 ID
   * @param {string} url - 标签页 URL
   */
  async function addTab(workspaceId, url) {
    if (!url) {
      showError('请输入标签页 URL');
      return;
    }

    // 自动补全协议前缀
    let normalizedUrl = url;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    try {
      const response = await sendMessage({
        type: 'ADD_TAB',
        workspaceId,
        url: normalizedUrl
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '添加标签页失败');
      }
    } catch (error) {
      showError(`添加标签页失败: ${error.message}`);
    }
  }

  /**
   * 移除标签页
   * @param {string} workspaceId - 工作区 ID
   * @param {string} tabId - 标签页内部 ID
   */
  async function removeTab(workspaceId, tabId) {
    try {
      const response = await sendMessage({
        type: 'REMOVE_TAB',
        workspaceId,
        tabId
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '移除标签页失败');
      }
    } catch (error) {
      showError(`移除标签页失败: ${error.message}`);
    }
  }

  /**
   * 创建分组
   * @param {string} workspaceId - 工作区 ID
   * @param {string} groupName - 分组名称
   */
  async function createGroup(workspaceId, groupName) {
    try {
      const response = await sendMessage({
        type: 'CREATE_GROUP',
        workspaceId,
        groupName
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '创建分组失败');
      }
    } catch (error) {
      showError(`创建分组失败: ${error.message}`);
    }
  }

  /**
   * 分配标签页到分组
   * @param {string} workspaceId - 工作区 ID
   * @param {string} tabId - 标签页内部 ID
   * @param {string|null} groupId - 分组 ID
   */
  async function assignTabToGroup(workspaceId, tabId, groupId) {
    try {
      const response = await sendMessage({
        type: 'ASSIGN_TAB_TO_GROUP',
        workspaceId,
        tabId,
        groupId
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '分配分组失败');
      }
    } catch (error) {
      showError(`分配分组失败: ${error.message}`);
    }
  }

  /**
   * 导入当前浏览器窗口为工作区
   */
  async function importCurrentWindow() {
    const name = prompt('请输入导入工作区的名称（可留空使用默认名称）');
    if (name === null) return; // 用户取消

    try {
      const response = await sendMessage({
        type: 'IMPORT_CURRENT_WINDOW',
        name: name.trim()
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '导入当前窗口失败');
      }
    } catch (error) {
      showError(`导入当前窗口失败: ${error.message}`);
    }
  }

  /**
   * 导入所有打开的浏览器窗口为工作区
   * 适用于一次性迁移 Edge 原生工作区（以窗口形式存在）
   */
  async function importAllWindows() {
    if (!confirm('确定导入所有打开的窗口吗？每个窗口将生成一个独立工作区。')) {
      return;
    }

    try {
      const response = await sendMessage({ type: 'IMPORT_ALL_WINDOWS' });
      if (response && response.success) {
        alert(`成功导入 ${response.count} 个窗口为工作区。`);
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '未找到可导入的窗口');
      }
    } catch (error) {
      showError(`导入所有窗口失败: ${error.message}`);
    }
  }

  /**
   * 扫描当前已打开的普通窗口，尝试自动关联到未打开的扩展工作区
   * 用于识别用户通过 Edge 原生工作区按钮打开的窗口
   */
  async function scanOpenWindows() {
    try {
      const response = await sendMessage({ type: 'SCAN_AND_ASSOCIATE_WINDOWS' });
      if (response && response.success) {
        const associated = response.associated || 0;
        const unmatched = (response.unmatchedWindows || []).length;
        if (associated > 0) {
          await loadAndRender();
          showError(`已关联 ${associated} 个窗口到扩展工作区`);
        } else if (unmatched > 0) {
          showError(`未发现可关联的匹配窗口，但有 ${unmatched} 个未匹配窗口可导入`);
        } else {
          showError('当前没有可关联的已打开窗口');
        }
      } else {
        showError(response && response.error ? response.error : '扫描失败');
      }
    } catch (error) {
      showError(`扫描窗口失败: ${error.message}`);
    }
  }

  /**
   * 同步工作区与对应 Edge 窗口的标签页
   * @param {string} workspaceId - 工作区 ID
   */
  async function syncWorkspace(workspaceId) {
    try {
      const response = await sendMessage({ type: 'SYNC_WORKSPACE', workspaceId });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '同步失败，请确认工作区窗口已打开');
      }
    } catch (error) {
      showError(`同步失败: ${error.message}`);
    }
  }

  // ==================== 拖拽排序与跨区移动 ====================

  // 当前正在拖拽的标签页信息
  // 单条模式：{ mode: 'single', tabId, workspaceId }
  // 批量模式：{ mode: 'batch', tabIds: string[], workspaceId }
  let draggedTabInfo = null;

  /**
   * 标签页拖拽开始
   * 若被拖拽项已选中，则批量拖拽该工作区下所有选中标签页；否则为单条拖拽
   */
  function handleTabDragStart(event) {
    const item = event.currentTarget;
    const workspaceId = item.dataset.workspaceId;
    const tabId = item.dataset.tabId;
    const isSelected = selectedTabs.has(`${workspaceId}:${tabId}`);

    if (isSelected) {
      const selectedTabIds = getSelectedTabIdsForWorkspace(workspaceId);
      draggedTabInfo = {
        mode: 'batch',
        tabIds: selectedTabIds,
        workspaceId
      };
    } else {
      draggedTabInfo = {
        mode: 'single',
        tabId,
        workspaceId
      };
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(draggedTabInfo));
    item.classList.add('dragging');
  }

  /**
   * 标签页拖拽结束
   */
  function handleTabDragEnd(event) {
    const item = event.currentTarget;
    item.classList.remove('dragging');
    draggedTabInfo = null;
    clearDropIndicators();
  }

  /**
   * 清除所有拖拽指示线
   */
  function clearDropIndicators() {
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  /**
   * 在工作区内标签页列表上方拖拽时，计算插入位置并显示指示线
   */
  function handleTabListDragOver(event) {
    event.preventDefault();
    if (!draggedTabInfo) return;

    const tabList = event.currentTarget;
    const targetWorkspaceId = tabList.dataset.workspaceId;

    // 仅允许在同工作区内单条排序；批量拖拽不支持同工作区排序
    if (targetWorkspaceId !== draggedTabInfo.workspaceId || draggedTabInfo.mode === 'batch') return;

    const afterElement = getDragAfterElement(tabList, event.clientY);
    const indicator = getOrCreateDropIndicator();

    if (afterElement) {
      tabList.insertBefore(indicator, afterElement);
    } else {
      tabList.appendChild(indicator);
    }
  }

  /**
   * 获取拖拽后应插入位置的下一个元素
   */
  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.tab-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  /**
   * 获取或创建拖拽指示线元素
   */
  function getOrCreateDropIndicator() {
    let indicator = document.querySelector('.drop-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
    }
    return indicator;
  }

  /**
   * 标签页列表拖拽离开
   */
  function handleTabListDragLeave(event) {
    // 当离开列表区域时清除指示线，但进入子元素不处理
    const tabList = event.currentTarget;
    if (!tabList.contains(event.relatedTarget)) {
      clearDropIndicators();
    }
  }

  /**
   * 在工作区内标签页列表上释放：执行排序
   */
  async function handleTabListDrop(event) {
    event.preventDefault();
    if (!draggedTabInfo) return;

    const tabList = event.currentTarget;
    const targetWorkspaceId = tabList.dataset.workspaceId;

    // 仅处理同工作区单条排序；批量拖拽不支持同工作区排序
    if (targetWorkspaceId !== draggedTabInfo.workspaceId || draggedTabInfo.mode === 'batch') return;

    const afterElement = getDragAfterElement(tabList, event.clientY);
    const children = [...tabList.querySelectorAll('.tab-item')];
    const draggedElement = tabList.querySelector('.tab-item.dragging');
    const currentIndex = draggedElement ? children.indexOf(draggedElement) : -1;

    let targetIndex;
    if (!afterElement) {
      // 放置到列表末尾（需减去被拖拽元素自身占用的一个位置）
      targetIndex = children.length - 1;
    } else {
      targetIndex = children.indexOf(afterElement);
      // 若向下拖拽，移除自身后目标索引会前移一位，需补偿
      if (currentIndex !== -1 && currentIndex < targetIndex) {
        targetIndex--;
      }
    }

    clearDropIndicators();

    try {
      const response = await sendMessage({
        type: 'REORDER_TAB',
        workspaceId: targetWorkspaceId,
        tabId: draggedTabInfo.tabId,
        targetIndex
      });
      if (response && response.success) {
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '排序失败');
      }
    } catch (error) {
      showError(`排序失败: ${error.message}`);
    }
  }

  /**
   * 拖拽经过工作区卡片：高亮放置目标
   */
  function handleWorkspaceDragOver(event) {
    event.preventDefault();
    if (!draggedTabInfo) return;

    const card = event.currentTarget;
    const targetWorkspaceId = card.dataset.workspaceId;

    // 不允许拖到自己所在的工作区
    if (targetWorkspaceId === draggedTabInfo.workspaceId) return;

    card.classList.add('drag-over');
    event.dataTransfer.dropEffect = 'move';
  }

  /**
   * 拖拽离开工作区卡片
   */
  function handleWorkspaceDragLeave(event) {
    const card = event.currentTarget;
    if (!card.contains(event.relatedTarget)) {
      card.classList.remove('drag-over');
    }
  }

  /**
   * 在工作区卡片上释放：执行跨工作区移动
   * 支持单条移动与批量移动两种模式
   */
  async function handleWorkspaceDrop(event) {
    event.preventDefault();
    if (!draggedTabInfo) return;

    const card = event.currentTarget;
    const targetWorkspaceId = card.dataset.workspaceId;

    // 同工作区已由标签页列表处理
    if (targetWorkspaceId === draggedTabInfo.workspaceId) {
      card.classList.remove('drag-over');
      return;
    }

    card.classList.remove('drag-over');
    clearDropIndicators();

    try {
      let response;
      if (draggedTabInfo.mode === 'batch') {
        const moves = draggedTabInfo.tabIds.map(tabId => ({
          tabId,
          sourceWorkspaceId: draggedTabInfo.workspaceId,
          targetWorkspaceId
        }));
        response = await sendMessage({ type: 'MOVE_TABS', moves });
      } else {
        response = await sendMessage({
          type: 'MOVE_TAB',
          tabId: draggedTabInfo.tabId,
          sourceWorkspaceId: draggedTabInfo.workspaceId,
          targetWorkspaceId
        });
      }
      if (response && response.success) {
        // 批量移动成功后清空选中状态，避免用户误操作
        if (draggedTabInfo.mode === 'batch') {
          selectedTabs.clear();
        }
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '移动标签页失败');
      }
    } catch (error) {
      showError(`移动标签页失败: ${error.message}`);
    }
  }

  /**
   * 向后台 Service Worker 发送消息
   * @param {object} message - 消息对象
   * @returns {Promise<object>} 响应对象
   */
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('当前环境不支持 chrome.runtime 消息'));
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * 显示错误提示
   * @param {string} message - 错误信息
   */
  function showError(message) {
    errorMessageEl.textContent = message;
    errorMessageEl.classList.remove('hidden');
    setTimeout(() => {
      errorMessageEl.classList.add('hidden');
    }, 5000);
  }

  /**
   * 隐藏错误提示
   */
  function hideError() {
    errorMessageEl.classList.add('hidden');
    errorMessageEl.textContent = '';
  }

  /**
   * 格式化 ISO 时间为易读字符串
   * @param {string} isoString - ISO 8601 时间字符串
   * @returns {string} 格式化后的时间
   */
  function formatDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (isToday) {
      return `今天 ${timeStr}`;
    }
    return `${date.toLocaleDateString('zh-CN')} ${timeStr}`;
  }
})();
