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

  // 当前数据缓存
  let workspaceData = { workspaces: [] };
  // 当前可导入窗口缓存
  let importableWindows = [];

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
   * @param {'workspaces'|'import'} view - 目标视图
   */
  async function switchView(view) {
    if (view === 'workspaces') {
      navWorkspacesEl.classList.add('active');
      navImportEl.classList.remove('active');
      importPanelEl.classList.add('hidden');
      workspaceListEl.classList.remove('hidden');
      emptyStateEl.classList.toggle('hidden', workspaceData.workspaces.length > 0);
      await loadAndRender();
    } else if (view === 'import') {
      navWorkspacesEl.classList.remove('active');
      navImportEl.classList.add('active');
      importPanelEl.classList.remove('hidden');
      workspaceListEl.classList.add('hidden');
      emptyStateEl.classList.add('hidden');
      createPanelEl.classList.add('hidden');
      await loadAndRenderImportableWindows();
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
      const response = await sendMessage({ type: 'GET_WORKSPACES' });
      if (response && response.success) {
        workspaceData = response.data;
        renderWorkspaceList();
        updateSidebarStats();
        hideError();
      } else {
        showError(response && response.error ? response.error : '加载数据失败');
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

    workspaceData.workspaces.forEach((ws) => {
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
    const card = document.createElement('div');
    card.className = 'workspace-card';
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
    statusEl.className = `workspace-status ${ws.windowId ? 'open' : 'closed'}`;
    statusEl.innerHTML = `<span class="status-dot"></span>${ws.windowId ? '已打开' : '未打开'}`;

    titleEl.appendChild(nameEl);
    titleEl.appendChild(statusEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'workspace-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-small btn-secondary';
    openBtn.type = 'button';
    openBtn.textContent = ws.windowId ? '关闭' : '打开';
    openBtn.addEventListener('click', () => toggleWorkspace(ws.id));

    // 仅当窗口已打开时显示同步按钮
    if (ws.windowId) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'btn btn-small btn-secondary';
      syncBtn.type = 'button';
      syncBtn.textContent = '同步';
      syncBtn.title = '将工作区与当前窗口标签页强制同步';
      syncBtn.addEventListener('click', () => syncWorkspace(ws.id));
      actionsEl.appendChild(syncBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small btn-text';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => deleteWorkspace(ws.id));

    actionsEl.appendChild(openBtn);
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
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.draggable = true;
    item.dataset.tabId = tab.id;
    item.dataset.workspaceId = ws.id;

    // 拖拽事件绑定
    item.addEventListener('dragstart', handleTabDragStart);
    item.addEventListener('dragend', handleTabDragEnd);

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

    item.appendChild(favicon);
    item.appendChild(title);
    item.appendChild(actionsEl);

    return item;
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
        await loadAndRender();
      } else {
        showError(response && response.error ? response.error : '操作失败');
      }
    } catch (error) {
      showError(`操作工作区失败: ${error.message}`);
    }
  }

  /**
   * 删除工作区
   * @param {string} workspaceId - 工作区 ID
   */
  async function deleteWorkspace(workspaceId) {
    if (!confirm('确定要删除该工作区吗？此操作不可恢复。')) {
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
  let draggedTabInfo = null;

  /**
   * 标签页拖拽开始
   */
  function handleTabDragStart(event) {
    const item = event.currentTarget;
    draggedTabInfo = {
      tabId: item.dataset.tabId,
      workspaceId: item.dataset.workspaceId
    };
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

    // 仅允许在同工作区内排序
    if (targetWorkspaceId !== draggedTabInfo.workspaceId) return;

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

    // 仅处理同工作区排序
    if (targetWorkspaceId !== draggedTabInfo.workspaceId) return;

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
      const response = await sendMessage({
        type: 'MOVE_TAB',
        tabId: draggedTabInfo.tabId,
        sourceWorkspaceId: draggedTabInfo.workspaceId,
        targetWorkspaceId
      });
      if (response && response.success) {
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
