const groupRoot = document.querySelector("#groups");
const groupTemplate = document.querySelector("#group-template");
const itemTemplate = document.querySelector("#item-template");
const searchInput = document.querySelector("#search-input");
const aggregateButton = document.querySelector("#aggregate-button");
const dedupeButton = document.querySelector("#dedupe-button");
const themeButton = document.querySelector("#theme-button");
const settingsButton = document.querySelector("#settings-button");
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

const isPreviewMode =
  new URLSearchParams(window.location.search).has("preview") ||
  !globalThis.chrome?.runtime?.id;

let dashboard = {
  tabs: [],
  settings: { topSize: 3, recentMinVisibleSeconds: 5, statsWindowMode: "rolling-active-24h" }
};
let aggregateMode = false;
const expandedAggregates = new Set();

applyTheme("system");
init().catch((error) => showError(error));

async function init() {
  dashboard = await loadDashboard();
  applyTheme(dashboard.settings.themeMode || "system");
  updateSummary();
  render();

  themeButton.addEventListener("click", handleThemeToggle);
  systemTheme.addEventListener("change", () => {
    if ((dashboard.settings.themeMode || "system") === "system") {
      applyTheme("system");
    }
  });
  searchInput.addEventListener("input", render);
  aggregateButton.addEventListener("click", () => {
    aggregateMode = !aggregateMode;
    if (!aggregateMode) {
      expandedAggregates.clear();
    }
    aggregateButton.setAttribute("aria-pressed", String(aggregateMode));
    aggregateButton.textContent = aggregateMode ? "已聚合" : "聚合";
    render();
  });
  dedupeButton.addEventListener("click", handleDedupe);

  settingsButton.addEventListener("click", async () => {
    if (isPreviewMode) {
      showNotice("预览模式不会打开扩展设置页。");
      return;
    }

    try {
      await chrome.runtime.sendMessage({ type: "open-options" });
    } catch (error) {
      showError(error);
    }
  });
}

async function handleThemeToggle() {
  const previousMode = dashboard.settings.themeMode || "system";
  const nextMode = document.documentElement.dataset.theme === "dark" ? "light" : "dark";

  dashboard.settings.themeMode = nextMode;
  applyTheme(nextMode);

  if (isPreviewMode) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "save-settings",
      settings: dashboard.settings
    });
    if (!response?.ok) {
      throw new Error(response?.error || "theme-save-failed");
    }
    dashboard.settings = response.settings;
  } catch (error) {
    dashboard.settings.themeMode = previousMode;
    applyTheme(previousMode);
    showError(error);
  }
}

function applyTheme(mode) {
  const resolved = mode === "system" ? (systemTheme.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;

  if (!themeButton) {
    return;
  }

  const isDark = resolved === "dark";
  themeButton.querySelector(".theme-icon").textContent = isDark ? "\u263e" : "\u2600";
  themeButton.title = isDark ? "切换到浅色主题" : "切换到深色主题";
  themeButton.setAttribute("aria-label", themeButton.title);
}

async function loadDashboard() {
  const response = isPreviewMode
    ? buildPreviewDashboard()
    : await chrome.runtime.sendMessage({ type: "get-dashboard" });

  if (!response?.ok) {
    throw new Error(response?.error || "dashboard-load-failed");
  }

  return response;
}

function updateSummary() {
  const duplicateGroups = countExactDuplicateGroups(dashboard.tabs);
  const duplicateLabel = duplicateGroups ? ` · ${duplicateGroups} 组完全重复` : "";
  const windowLabel = isRollingWindowMode() ? "过去 24h 滚动统计" : "北京时间今日统计";
  summary.textContent = `${dashboard.tabs.length} 个可定位页面 · ${windowLabel}${duplicateLabel}`;
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase("zh-CN");
  const tabs = dashboard.tabs.filter((tab) => matchesQuery(tab, query));
  const groups = query ? buildSearchGroups(tabs) : buildDefaultGroups(tabs);

  groupRoot.innerHTML = "";
  notice.hidden = true;

  if (!groups.length || groups.every((group) => group.items.length === 0)) {
    groupRoot.innerHTML = '<div class="empty">没有找到匹配的已打开页面</div>';
    return;
  }

  for (const group of groups) {
    if (!group.items.length) {
      continue;
    }
    groupRoot.appendChild(renderGroup(group));
  }
}

function buildSearchGroups(tabs) {
  const items = aggregateMode
    ? aggregateTabs(tabs, activityScore)
    : [...tabs].sort((a, b) => activityScore(b) - activityScore(a));

  return [
    {
      key: "search",
      title: "搜索结果",
      description: aggregateMode ? "按域名聚合并按活跃度排序" : "按综合活跃度排序",
      items: items.slice(0, 50)
    }
  ];
}

function buildDefaultGroups(tabs) {
  const topSize = dashboard.settings.topSize || 3;
  const pinned = tabs.filter((tab) => tab.pinned);
  const labels = getWindowLabels();
  const definitions = [
    {
      key: "recent",
      title: "最近在看",
      description: `连续显示超过 ${dashboard.settings.recentMinVisibleSeconds} 秒`,
      filter: (tab) => tab.lastQualifiedVisibleAt > 0,
      score: (tab) => tab.lastQualifiedVisibleAt
    },
    {
      key: "dwell",
      title: labels.dwellTitle,
      description: labels.dwellDescription,
      filter: (tab) => tab.todayDwellMs > 0,
      score: (tab) => tab.todayDwellMs
    },
    {
      key: "work",
      title: labels.workTitle,
      description: labels.workDescription,
      filter: (tab) => tab.todayWorkMs > 0,
      score: (tab) => tab.todayWorkMs
    }
  ];

  const groups = [];
  if (pinned.length) {
    groups.push({
      key: "pinned",
      title: "置顶",
      description: "固定关注的已打开页面",
      items: [...pinned].sort((a, b) => activityScore(b) - activityScore(a))
    });
  }

  for (const definition of definitions) {
    const candidates = tabs.filter(definition.filter);
    const ranked = aggregateMode
      ? aggregateTabs(candidates, definition.score)
      : [...candidates].sort((a, b) => definition.score(b) - definition.score(a));
    groups.push({ ...definition, items: ranked.slice(0, topSize) });
  }

  return groups;
}

function renderGroup(group) {
  const fragment = groupTemplate.content.cloneNode(true);
  fragment.querySelector("h2").textContent = group.title;
  fragment.querySelector("p").textContent = group.description;
  fragment.querySelector(".group-count").textContent = `${group.items.length} 页`;

  const itemsRoot = fragment.querySelector(".items");
  for (const item of group.items) {
    itemsRoot.appendChild(renderItem(group.key, item));
  }
  return fragment;
}

function renderItem(groupKey, item) {
  const fragment = itemTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".tab-item");
  const openButton = fragment.querySelector(".open-tab");
  const pinButton = fragment.querySelector(".pin-button");
  const toggleButton = fragment.querySelector(".aggregate-toggle");
  const childRoot = fragment.querySelector(".aggregate-children");
  const icon = fragment.querySelector(".favicon");
  const count = fragment.querySelector(".aggregate-count");

  icon.src = item.favIconUrl || fallbackIcon();
  fragment.querySelector(".title").textContent = item.title;
  fragment.querySelector(".url").textContent = item.aggregateHost || simplifyUrl(item.url);
  fragment.querySelector(".stats").textContent = buildStats(groupKey, item);

  const canExpand =
    item.aggregateCount > 1 &&
    Array.isArray(item.aggregateItems) &&
    item.aggregateItems.length > 1;

  if (canExpand) {
    count.hidden = false;
    count.textContent = `${item.aggregateCount} 页`;

    const aggregateKey = getAggregateItemKey(groupKey, item);
    const expanded = expandedAggregates.has(aggregateKey);
    toggleButton.hidden = false;
    toggleButton.textContent = expanded ? "收起" : "展开";
    toggleButton.setAttribute("aria-expanded", String(expanded));
    toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAggregate(groupKey, item);
    });

    if (expanded) {
      childRoot.hidden = false;
      for (const child of item.aggregateItems) {
        childRoot.appendChild(renderAggregateChild(groupKey, child));
      }
      article.classList.add("is-expanded");
    }
  } else {
    toggleButton.remove();
    childRoot.remove();
  }

  setPinButton(pinButton, item.pinned);
  openButton.addEventListener("click", () => activateTab(item.tabId));
  pinButton.addEventListener("click", () => togglePin(item.tabId));
  return fragment;
}

function renderAggregateChild(groupKey, item) {
  const button = document.createElement("button");
  button.className = "aggregate-child";
  button.type = "button";

  const icon = document.createElement("img");
  icon.className = "favicon";
  icon.alt = "";
  icon.src = item.favIconUrl || fallbackIcon();

  const meta = document.createElement("span");
  meta.className = "meta";

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = item.title;

  const url = document.createElement("span");
  url.className = "url";
  url.textContent = simplifyUrl(item.url);

  const stats = document.createElement("span");
  stats.className = "stats";
  stats.textContent = buildStats(groupKey, item);

  meta.append(title, url, stats);
  button.append(icon, meta);
  button.addEventListener("click", () => activateTab(item.tabId));
  return button;
}

function toggleAggregate(groupKey, item) {
  const aggregateKey = getAggregateItemKey(groupKey, item);
  if (expandedAggregates.has(aggregateKey)) {
    expandedAggregates.delete(aggregateKey);
  } else {
    expandedAggregates.add(aggregateKey);
  }
  render();
}

function getAggregateItemKey(groupKey, item) {
  return `${groupKey}:${item.aggregateHost || getHostname(item.url)}`;
}

async function activateTab(tabId) {
  if (isPreviewMode) {
    showNotice(`预览模式下不会真的跳转标签页（tabId: ${tabId}）。`);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "activate-tab", tabId });
  if (!response?.ok) {
    dashboard.tabs = dashboard.tabs.filter((tab) => tab.tabId !== tabId);
    updateSummary();
    render();
    showNotice("该页面已经关闭，已从列表移除。");
    return;
  }

  window.close();
}

async function togglePin(tabId) {
  if (isPreviewMode) {
    const target = dashboard.tabs.find((tab) => tab.tabId === tabId);
    if (target) {
      target.pinned = !target.pinned;
    }
    updateSummary();
    render();
    showNotice("预览模式下已本地切换置顶状态。");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "toggle-pin", tabId });
  if (!response?.ok) {
    showNotice("置顶操作失败，页面可能已经关闭。");
    return;
  }

  const target = dashboard.tabs.find((tab) => tab.tabId === tabId);
  if (target) {
    target.pinned = response.pinned;
  }
  updateSummary();
  render();
}

async function handleDedupe() {
  const idleLabel = "去重";
  dedupeButton.disabled = true;
  dedupeButton.textContent = "去重中...";
  expandedAggregates.clear();

  try {
    const response = isPreviewMode
      ? closePreviewDuplicates()
      : await chrome.runtime.sendMessage({ type: "close-duplicates" });

    if (!response?.ok) {
      throw new Error(response?.error || "dedupe-failed");
    }

    if (response.dashboard) {
      dashboard = response.dashboard;
    }

    updateSummary();
    render();
    showNotice(response.message || formatDedupeMessage(response.result));
  } catch (error) {
    showError(error);
  } finally {
    dedupeButton.disabled = false;
    dedupeButton.textContent = idleLabel;
  }
}

function closePreviewDuplicates() {
  const result = dedupeTabsLocally(dashboard.tabs);
  dashboard = {
    ...dashboard,
    tabs: result.tabs
  };

  return {
    ok: true,
    dashboard,
    result,
    message: formatDedupeMessage(result)
  };
}

function dedupeTabsLocally(tabs) {
  const buckets = new Map();
  for (const tab of tabs) {
    const key = canonicalizeUrl(tab.url);
    const bucket = buckets.get(key) || [];
    bucket.push(tab);
    buckets.set(key, bucket);
  }

  const nextTabs = [];
  let groupCount = 0;
  let closedCount = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      nextTabs.push(bucket[0]);
      continue;
    }

    groupCount += 1;
    const sorted = [...bucket].sort(compareDuplicateTabs);
    nextTabs.push(sorted[0]);
    closedCount += sorted.length - 1;
  }

  return {
    tabs: nextTabs.sort((a, b) => activityScore(b) - activityScore(a)),
    groupCount,
    closedCount,
    keptCount: groupCount
  };
}

function compareDuplicateTabs(a, b) {
  const aWorkAt = a.lastInteractionAt || 0;
  const bWorkAt = b.lastInteractionAt || 0;
  const aHasWork = aWorkAt > 0;
  const bHasWork = bWorkAt > 0;

  if (aHasWork !== bHasWork) {
    return aHasWork ? -1 : 1;
  }
  if (aWorkAt !== bWorkAt) {
    return bWorkAt - aWorkAt;
  }

  const aOpenedAt = a.createdAt || a.lastSeenAt || a.lastQualifiedVisibleAt || 0;
  const bOpenedAt = b.createdAt || b.lastSeenAt || b.lastQualifiedVisibleAt || 0;
  if (aOpenedAt !== bOpenedAt) {
    return bOpenedAt - aOpenedAt;
  }

  const aVisibleAt = a.lastQualifiedVisibleAt || 0;
  const bVisibleAt = b.lastQualifiedVisibleAt || 0;
  if (aVisibleAt !== bVisibleAt) {
    return bVisibleAt - aVisibleAt;
  }

  return (b.tabId || 0) - (a.tabId || 0);
}

function formatDedupeMessage(result = {}) {
  if (!result.closedCount) {
    return "没有发现完全相同的重复页面。";
  }

  return `已关闭 ${result.closedCount} 个重复页面，保留 ${result.groupCount} 组里的最新页面（优先按最近工作，其次按最近打开）。`;
}

function aggregateTabs(tabs, scorer) {
  const buckets = new Map();
  for (const tab of tabs) {
    const host = getHostname(tab.url);
    const bucket = buckets.get(host) || [];
    bucket.push(tab);
    buckets.set(host, bucket);
  }

  return [...buckets.entries()]
    .map(([host, items]) => {
      const aggregateItems = [...items].sort((a, b) => scorer(b) - scorer(a));
      const representative = aggregateItems[0];
      return {
        ...representative,
        aggregateHost: host,
        aggregateCount: items.length,
        aggregateItems,
        todayDwellMs: sum(items, "todayDwellMs"),
        todayWorkMs: sum(items, "todayWorkMs"),
        lastQualifiedVisibleAt: Math.max(...items.map((entry) => entry.lastQualifiedVisibleAt || 0)),
        aggregateScore: items.reduce((total, entry) => total + scorer(entry), 0),
        pinned: items.some((entry) => entry.pinned)
      };
    })
    .sort((a, b) => b.aggregateScore - a.aggregateScore);
}

function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] || 0), 0);
}

function activityScore(tab) {
  const recencyHours = tab.lastQualifiedVisibleAt
    ? Math.max(0, 24 - (Date.now() - tab.lastQualifiedVisibleAt) / 3600000)
    : 0;
  return (tab.todayWorkMs || 0) * 2 + (tab.todayDwellMs || 0) + recencyHours * 60000;
}

function matchesQuery(tab, query) {
  if (!query) {
    return true;
  }

  return `${tab.title} ${tab.url} ${getHostname(tab.url)}`
    .toLocaleLowerCase("zh-CN")
    .includes(query);
}

function countExactDuplicateGroups(tabs) {
  const counts = new Map();
  for (const tab of tabs) {
    const key = canonicalizeUrl(tab.url);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function buildStats(groupKey, item) {
  const labels = getWindowLabels();
  if (groupKey === "recent") {
    return `最近显示 ${formatRelative(item.lastQualifiedVisibleAt)} · ${labels.workShort} ${formatDuration(item.todayWorkMs)}`;
  }
  if (groupKey === "dwell") {
    return `${labels.dwellShort} ${formatDuration(item.todayDwellMs)} · ${labels.workShort} ${formatDuration(item.todayWorkMs)}`;
  }
  if (groupKey === "work") {
    return `${labels.workShort} ${formatDuration(item.todayWorkMs)} · ${labels.dwellShort} ${formatDuration(item.todayDwellMs)}`;
  }
  return `${labels.dwellShort} ${formatDuration(item.todayDwellMs)} · ${labels.workShort} ${formatDuration(item.todayWorkMs)}`;
}

function setPinButton(button, pinned) {
  button.textContent = pinned ? "★" : "☆";
  button.classList.toggle("is-pinned", pinned);
  button.title = pinned ? "取消置顶" : "置顶此页面";
  button.setAttribute("aria-label", button.title);
}

function simplifyUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "未知域名";
  }
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function formatDuration(ms = 0) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`;
  }
  return `${Math.floor(totalMinutes / 60)} 小时 ${totalMinutes % 60} 分钟`;
}

function formatRelative(timestamp) {
  if (!timestamp) {
    return "未记录";
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  return `${Math.floor(minutes / 60)} 小时前`;
}

function fallbackIcon() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18'%3E%3Crect width='18' height='18' rx='3' fill='%23d9dee5'/%3E%3C/svg%3E";
}

function isRollingWindowMode() {
  return dashboard.settings.statsWindowMode === "rolling-active-24h";
}

function getWindowLabels() {
  if (isRollingWindowMode()) {
    return {
      dwellTitle: "过去 24h 停留",
      dwellDescription: "按最近 24 小时浏览器活跃窗口的前台停留时长排序，会自动跳过整天未打开浏览器的空白日",
      workTitle: "过去 24h 工作",
      workDescription: "按最近 24 小时浏览器活跃窗口的工作时长排序，优先反映连续工作轨迹",
      dwellShort: "停留",
      workShort: "工作"
    };
  }

  return {
    dwellTitle: "今日停留",
    dwellDescription: "按北京时间今日前台停留时长排序",
    workTitle: "今日工作",
    workDescription: "按北京时间今日前台且近期有交互的活跃时长排序",
    dwellShort: "停留",
    workShort: "工作"
  };
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function showError(error) {
  console.error(error);
  showNotice("加载失败，请在扩展管理页重新加载插件后重试。");
}

function buildPreviewDashboard() {
  const now = Date.now();

  return {
    ok: true,
    generatedAt: now,
    settings: {
      topSize: 3,
      recentMinVisibleSeconds: 5,
      statsWindowMode: "rolling-active-24h"
    },
    tabs: [
      buildPreviewTab({
        tabId: 101,
        title: "Tab Compass 设计稿 - Figma",
        url: "https://www.figma.com/file/tab-compass",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=figma.com",
        createdAt: now - 6 * 60 * 60 * 1000,
        lastSeenAt: now - 5 * 60 * 1000,
        lastInteractionAt: now - 15 * 60 * 1000,
        lastQualifiedVisibleAt: now - 5 * 60 * 1000,
        todayDwellMs: 58 * 60 * 1000,
        todayWorkMs: 42 * 60 * 1000,
        pinned: true
      }),
      buildPreviewTab({
        tabId: 109,
        title: "Tab Compass 设计稿 - Figma（旧副本）",
        url: "https://www.figma.com/file/tab-compass",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=figma.com",
        createdAt: now - 60 * 60 * 1000,
        lastSeenAt: now - 20 * 60 * 1000,
        lastInteractionAt: now - 90 * 60 * 1000,
        lastQualifiedVisibleAt: now - 20 * 60 * 1000,
        todayDwellMs: 15 * 60 * 1000,
        todayWorkMs: 10 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 106,
        title: "Tab Compass 原型页 - Figma",
        url: "https://www.figma.com/proto/tab-compass",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=figma.com",
        createdAt: now - 2 * 60 * 60 * 1000,
        lastSeenAt: now - 7 * 60 * 1000,
        lastInteractionAt: now - 24 * 60 * 1000,
        lastQualifiedVisibleAt: now - 7 * 60 * 1000,
        todayDwellMs: 31 * 60 * 1000,
        todayWorkMs: 24 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 102,
        title: "Chrome Extensions Docs",
        url: "https://developer.chrome.com/docs/extensions/",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=developer.chrome.com",
        createdAt: now - 9 * 60 * 60 * 1000,
        lastSeenAt: now - 22 * 60 * 1000,
        lastInteractionAt: now - 30 * 60 * 1000,
        lastQualifiedVisibleAt: now - 22 * 60 * 1000,
        todayDwellMs: 26 * 60 * 1000,
        todayWorkMs: 18 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 103,
        title: "产品需求文档 - Notion",
        url: "https://www.notion.so/workspace/product-spec",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=notion.so",
        createdAt: now - 8 * 60 * 60 * 1000,
        lastSeenAt: now - 80 * 60 * 1000,
        lastInteractionAt: now - 45 * 60 * 1000,
        lastQualifiedVisibleAt: now - 80 * 60 * 1000,
        todayDwellMs: 2 * 60 * 60 * 1000 + 5 * 60 * 1000,
        todayWorkMs: 76 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 107,
        title: "本周迭代记录 - Notion",
        url: "https://www.notion.so/workspace/sprint-notes",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=notion.so",
        createdAt: now - 4 * 60 * 60 * 1000,
        lastSeenAt: now - 95 * 60 * 1000,
        lastInteractionAt: now - 55 * 60 * 1000,
        lastQualifiedVisibleAt: now - 95 * 60 * 1000,
        todayDwellMs: 72 * 60 * 1000,
        todayWorkMs: 52 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 104,
        title: "Sprint Board - Linear",
        url: "https://linear.app/team/board",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=linear.app",
        createdAt: now - 3 * 60 * 60 * 1000,
        lastSeenAt: now - 12 * 60 * 1000,
        lastInteractionAt: now - 18 * 60 * 1000,
        lastQualifiedVisibleAt: now - 12 * 60 * 1000,
        todayDwellMs: 88 * 60 * 1000,
        todayWorkMs: 64 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 105,
        title: "预算表 - Google Sheets",
        url: "https://docs.google.com/spreadsheets/d/demo/edit",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=docs.google.com",
        createdAt: now - 5 * 60 * 60 * 1000,
        lastSeenAt: now - 3 * 60 * 60 * 1000,
        lastInteractionAt: 0,
        lastQualifiedVisibleAt: now - 3 * 60 * 60 * 1000,
        todayDwellMs: 34 * 60 * 1000,
        todayWorkMs: 8 * 60 * 1000
      }),
      buildPreviewTab({
        tabId: 110,
        title: "预算表 - Google Sheets（新副本）",
        url: "https://docs.google.com/spreadsheets/d/demo/edit",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=docs.google.com",
        createdAt: now - 30 * 60 * 1000,
        lastSeenAt: now - 25 * 60 * 1000,
        lastInteractionAt: 0,
        lastQualifiedVisibleAt: now - 25 * 60 * 1000,
        todayDwellMs: 12 * 60 * 1000,
        todayWorkMs: 0
      }),
      buildPreviewTab({
        tabId: 108,
        title: "路线图排期 - Google Sheets",
        url: "https://docs.google.com/spreadsheets/d/roadmap/edit",
        favIconUrl: "https://www.google.com/s2/favicons?sz=64&domain=docs.google.com",
        createdAt: now - 90 * 60 * 1000,
        lastSeenAt: now - 130 * 60 * 1000,
        lastInteractionAt: now - 135 * 60 * 1000,
        lastQualifiedVisibleAt: now - 130 * 60 * 1000,
        todayDwellMs: 55 * 60 * 1000,
        todayWorkMs: 14 * 60 * 1000
      })
    ]
  };
}

function buildPreviewTab(overrides) {
  return {
    tabId: 0,
    windowId: 1,
    title: "",
    url: "",
    favIconUrl: "",
    createdAt: 0,
    lastSeenAt: 0,
    lastInteractionAt: 0,
    lastQualifiedVisibleAt: 0,
    todayDwellMs: 0,
    todayWorkMs: 0,
    pinned: false,
    ...overrides
  };
}
