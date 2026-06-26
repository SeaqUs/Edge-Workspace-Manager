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

  // 当前数据缓存
  let workspaceData = { workspaces: [] };

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
        hideError();
      } else {
        showError(response && response.error ? response.error : '加载数据失败');
      }
    } catch (error) {
      showError(`加载数据失败: ${error.message}`);
    }
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

    // 头部：名称与操作按钮
    const header = document.createElement('div');
    header.className = 'workspace-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'workspace-name';
    nameEl.textContent = ws.name;
    nameEl.title = ws.windowId ? '点击关闭工作区窗口' : '点击打开工作区';
    nameEl.addEventListener('click', () => toggleWorkspace(ws.id));

    const actionsEl = document.createElement('div');
    actionsEl.className = 'workspace-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-small btn-primary';
    openBtn.type = 'button';
    openBtn.textContent = ws.windowId ? '关闭' : '打开';
    openBtn.addEventListener('click', () => toggleWorkspace(ws.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small btn-danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => deleteWorkspace(ws.id));

    actionsEl.appendChild(openBtn);
    actionsEl.appendChild(deleteBtn);
    header.appendChild(nameEl);
    header.appendChild(actionsEl);

    // 元信息：标签页数量、分组数量与窗口状态
    const meta = document.createElement('div');
    meta.className = 'workspace-meta';
    const groupCount = ws.groups ? ws.groups.length : 0;
    meta.innerHTML = `
      <span>标签页: ${ws.tabs ? ws.tabs.length : 0}</span>
      <span>分组: ${groupCount}</span>
      <span>状态: ${ws.windowId ? '已打开' : '未打开'}</span>
    `;

    // 分组区域
    const groupSection = buildGroupSection(ws);

    // 标签页列表
    const tabList = document.createElement('div');
    tabList.className = 'tab-list';

    if (ws.tabs && ws.tabs.length > 0) {
      ws.tabs.forEach((tab) => {
        const tabItem = buildTabItem(ws, tab);
        tabList.appendChild(tabItem);
      });
    }

    // 添加标签页输入区
    const addTabRow = document.createElement('div');
    addTabRow.className = 'add-tab-row';

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

    addTabRow.appendChild(tabInput);
    addTabRow.appendChild(addTabBtn);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(groupSection);
    card.appendChild(tabList);
    card.appendChild(addTabRow);

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
    headerRow.className = 'group-header-row';

    const title = document.createElement('span');
    title.className = 'group-section-title';
    title.textContent = '分组';

    const createGroupBtn = document.createElement('button');
    createGroupBtn.className = 'btn btn-small btn-secondary';
    createGroupBtn.type = 'button';
    createGroupBtn.textContent = '新建分组';
    createGroupBtn.addEventListener('click', () => {
      const name = prompt('请输入分组名称');
      if (name && name.trim()) {
        createGroup(ws.id, name.trim());
      }
    });

    headerRow.appendChild(title);
    headerRow.appendChild(createGroupBtn);
    section.appendChild(headerRow);

    // 分组列表
    if (ws.groups && ws.groups.length > 0) {
      const list = document.createElement('div');
      list.className = 'group-list';

      ws.groups.forEach((group) => {
        const groupItem = document.createElement('div');
        groupItem.className = 'group-item';

        const colorDot = document.createElement('span');
        colorDot.className = 'group-color-dot';
        colorDot.style.backgroundColor = group.color || '#999999';

        const groupName = document.createElement('span');
        groupName.className = 'group-name';
        groupName.textContent = group.name;

        const tabCount = ws.tabs.filter(t => t.groupId === group.id).length;
        const countBadge = document.createElement('span');
        countBadge.className = 'group-count';
        countBadge.textContent = `${tabCount} 标签页`;

        groupItem.appendChild(colorDot);
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

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tab-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = '移除标签页';
    removeBtn.addEventListener('click', () => removeTab(ws.id, tab.id));

    item.appendChild(favicon);
    item.appendChild(title);
    item.appendChild(groupSelect);
    item.appendChild(removeBtn);

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
   * 在头部追加“导入当前窗口”按钮
   * 因 popup.js 在 DOM 构建后引入，此处直接操作 header
   */
  const appHeader = document.querySelector('.app-header');
  if (appHeader) {
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-secondary';
    importBtn.type = 'button';
    importBtn.textContent = '导入当前窗口';
    importBtn.style.marginLeft = '8px';
    importBtn.addEventListener('click', importCurrentWindow);
    appHeader.appendChild(importBtn);
  }
})();
