const STORAGE_KEY = "tabCompassState";
const ALARM_NAME = "tab-compass-tick";
const BEIJING_TIME_ZONE = "Asia/Shanghai";
const TICK_MINUTES = 1;
const MAX_ACCOUNTING_GAP_MS = 2 * 60 * 1000;
const HISTORY_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

const STATS_WINDOW_MODE = {
  CALENDAR_DAY: "calendar-day",
  ROLLING_ACTIVE_24H: "rolling-active-24h"
};

const WORK_ACTIVITY_KIND = {
  POINTER: "pointer",
  TYPING: "typing",
  SCROLL: "scroll",
  SELECTION: "selection",
  CLIPBOARD: "clipboard"
};

const DEFAULT_WORK_ACTIVITY_KINDS = [
  WORK_ACTIVITY_KIND.POINTER,
  WORK_ACTIVITY_KIND.TYPING,
  WORK_ACTIVITY_KIND.SCROLL,
  WORK_ACTIVITY_KIND.SELECTION,
  WORK_ACTIVITY_KIND.CLIPBOARD
];

const DEFAULT_SETTINGS = {
  topSize: 3,
  recentMinVisibleSeconds: 5,
  workActivityKinds: [...DEFAULT_WORK_ACTIVITY_KINDS],
  pointerWorkThreshold: 5,
  statsWindowMode: STATS_WINDOW_MODE.ROLLING_ACTIVE_24H,
  allowlist: "",
  blocklist: "",
  customLogoDataUrl: "",
  themeMode: "system"
};

let state = createEmptyState();
let initialized = false;
let qualificationTimer = null;

boot().catch((error) => console.error("Tab Compass boot failed", error));

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_MINUTES });
  runSafely(applyActionIcon, "Apply default icon failed");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_MINUTES });
  runSafely(applyActionIcon, "Apply startup icon failed");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  runSafely(handleTick, "Tick failed");
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  runSafely(() => handleTabActivated(tabId, windowId), "Activation failed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url && !changeInfo.title) {
    return;
  }

  runSafely(async () => {
    upsertTab(tab);
    await saveState();
  }, "Update failed");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runSafely(() => removeTab(tabId), "Removal failed");
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  runSafely(() => handleWindowFocusChanged(windowId), "Focus update failed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("Message handling failed", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

async function runSafely(operation, label) {
  try {
    await ensureReady();
    await operation();
  } catch (error) {
    console.error(label, error);
  }
}

async function handleMessage(message, sender) {
  await ensureReady();

  switch (message?.type) {
    case "user-activity": {
      const tabId = sender.tab?.id;
      if (typeof tabId === "number") {
        await recordUserActivity(tabId, message.at || Date.now(), message.kind);
      }
      return { ok: true };
    }
    case "get-dashboard":
      await refreshSnapshot();
      return { ok: true, ...buildDashboardPayload() };
    case "activate-tab":
      await activateTab(message.tabId);
      return { ok: true };
    case "toggle-pin":
      return { ok: true, pinned: await togglePin(message.tabId) };
    case "close-duplicates": {
      const result = await closeDuplicateTabs();
      return { ok: true, result, dashboard: buildDashboardPayload() };
    }
    case "get-settings":
      return { ok: true, settings: state.settings };
    case "save-settings":
      state.settings = sanitizeSettings(message.settings);
      scheduleQualification();
      await saveState();
      await applyActionIcon();
      return { ok: true, settings: state.settings };
    case "open-options":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: "unknown-message" };
  }
}

async function boot() {
  await ensureReady();
  await applyActionIcon();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_MINUTES });
  await refreshSnapshot();
}

async function ensureReady() {
  if (initialized) {
    return;
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = hydrateState(stored[STORAGE_KEY]);

  // A service worker restart must not count the time while it was asleep.
  state.active = createInactiveSession();
  initialized = true;
  await saveState();
}

function createEmptyState() {
  return {
    tabs: {},
    pinnedUrls: [],
    settings: { ...DEFAULT_SETTINGS },
    active: createInactiveSession()
  };
}

function createInactiveSession() {
  return {
    tabId: null,
    windowId: null,
    browserFocused: false,
    startedAt: 0,
    lastAccountedAt: 0,
    workStartedAt: 0,
    pointerActivityCount: 0
  };
}

function hydrateState(raw) {
  if (!raw || typeof raw !== "object") {
    return createEmptyState();
  }

  return {
    tabs: hydrateTabs(raw.tabs),
    pinnedUrls: Array.isArray(raw.pinnedUrls) ? raw.pinnedUrls : [],
    settings: sanitizeSettings(raw.settings),
    active: createInactiveSession()
  };
}

function hydrateTabs(rawTabs) {
  if (!rawTabs || typeof rawTabs !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rawTabs).map(([tabId, rawTab]) => [tabId, hydrateTabRecord(Number(tabId), rawTab)])
  );
}

function hydrateTabRecord(tabId, rawTab) {
  const base = createTabRecord(tabId);
  if (!rawTab || typeof rawTab !== "object") {
    return base;
  }

  const migratedHistory = buildMigratedHistory(rawTab);

  return {
    ...base,
    ...rawTab,
    tabId,
    activityHistory: Array.isArray(rawTab.activityHistory)
      ? rawTab.activityHistory
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            at: Number(entry.at) || 0,
            dwellMs: Number(entry.dwellMs) || 0,
            workMs: Number(entry.workMs) || 0
          }))
      : migratedHistory
  };
}

function buildMigratedHistory(rawTab) {
  const dwellMs = Number(rawTab.todayDwellMs) || 0;
  const workMs = Number(rawTab.todayWorkMs) || 0;
  if (dwellMs <= 0 && workMs <= 0) {
    return [];
  }

  return [
    {
      at: Number(rawTab.lastSeenAt) || Date.now(),
      dwellMs,
      workMs
    }
  ];
}

function sanitizeSettings(input = {}) {
  return {
    topSize: clampNumber(input.topSize, 1, 10, DEFAULT_SETTINGS.topSize),
    recentMinVisibleSeconds: clampNumber(
      input.recentMinVisibleSeconds,
      1,
      60,
      DEFAULT_SETTINGS.recentMinVisibleSeconds
    ),
    workActivityKinds: sanitizeWorkActivityKinds(input.workActivityKinds),
    pointerWorkThreshold: sanitizePointerWorkThreshold(input.pointerWorkThreshold),
    statsWindowMode: sanitizeStatsWindowMode(input.statsWindowMode),
    allowlist: typeof input.allowlist === "string" ? input.allowlist.trim() : "",
    blocklist: typeof input.blocklist === "string" ? input.blocklist.trim() : "",
    customLogoDataUrl: sanitizeCustomLogoDataUrl(input.customLogoDataUrl),
    themeMode: sanitizeThemeMode(input.themeMode)
  };
}

function sanitizeThemeMode(value) {
  return ["system", "light", "dark"].includes(value) ? value : DEFAULT_SETTINGS.themeMode;
}

function sanitizeCustomLogoDataUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return trimmed.startsWith("data:image/") ? trimmed : "";
}

function sanitizeStatsWindowMode(value) {
  return Object.values(STATS_WINDOW_MODE).includes(value)
    ? value
    : DEFAULT_SETTINGS.statsWindowMode;
}

function sanitizeWorkActivityKinds(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SETTINGS.workActivityKinds];
  }

  return [...new Set(
    value.filter((kind) => Object.values(WORK_ACTIVITY_KIND).includes(kind))
  )];
}

function sanitizePointerWorkThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_SETTINGS.pointerWorkThreshold;
  }

  return Math.max(1, Math.round(number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function getBeijingDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function saveState() {
  pruneAllHistory();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function refreshSnapshot() {
  const now = Date.now();
  accountActiveSession(now);

  const openTabs = await chrome.tabs.query({});
  const openIds = new Set(openTabs.map((tab) => tab.id).filter(Number.isInteger));

  for (const tabId of Object.keys(state.tabs)) {
    if (!openIds.has(Number(tabId))) {
      delete state.tabs[tabId];
    }
  }

  for (const tab of openTabs) {
    upsertTab(tab);
  }

  const focusedWindow = await chrome.windows.getLastFocused();
  if (!focusedWindow.focused) {
    endActiveSession(now);
  } else {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: focusedWindow.id
    });
    if (activeTab?.id !== state.active.tabId) {
      await beginActiveSession(activeTab, now);
    }
  }

  await saveState();
}

function upsertTab(tab) {
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const existing = state.tabs[tab.id] || createTabRecord(tab.id);
  existing.tabId = tab.id;
  existing.windowId = Number.isInteger(tab.windowId) ? tab.windowId : existing.windowId;
  existing.createdAt = existing.createdAt || Date.now();
  existing.title = tab.title || existing.title || "Untitled";
  existing.url = tab.url || existing.url || "";
  existing.favIconUrl = tab.favIconUrl || existing.favIconUrl || "";
  existing.lastSeenAt = Date.now();
  existing.activityHistory = Array.isArray(existing.activityHistory) ? existing.activityHistory : [];
  state.tabs[tab.id] = existing;
}

function createTabRecord(tabId) {
  return {
    tabId,
    windowId: null,
    createdAt: Date.now(),
    title: "Untitled",
    url: "",
    favIconUrl: "",
    lastSeenAt: Date.now(),
    lastQualifiedVisibleAt: 0,
    lastInteractionAt: 0,
    activityHistory: []
  };
}

async function handleTabActivated(tabId, windowId) {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(windowId);
  upsertTab(tab);

  if (!window.focused) {
    await saveState();
    return;
  }

  await beginActiveSession(tab, Date.now());
  await saveState();
}

async function handleWindowFocusChanged(windowId) {
  const now = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    endActiveSession(now);
    await saveState();
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  await beginActiveSession(activeTab, now);
  await saveState();
}

async function beginActiveSession(tab, now) {
  if (!tab || typeof tab.id !== "number") {
    endActiveSession(now);
    return;
  }

  if (state.active.tabId === tab.id && state.active.browserFocused) {
    return;
  }

  endActiveSession(now);
  upsertTab(tab);
  state.active = {
    tabId: tab.id,
    windowId: tab.windowId,
    browserFocused: true,
    startedAt: now,
    lastAccountedAt: now,
    workStartedAt: 0,
    pointerActivityCount: 0
  };
  scheduleQualification();
}

function endActiveSession(now) {
  accountActiveSession(now);
  clearQualificationTimer();
  state.active = createInactiveSession();
}

function accountActiveSession(now = Date.now()) {
  const active = state.active;
  if (!active.browserFocused || typeof active.tabId !== "number") {
    return;
  }

  const tabInfo = state.tabs[active.tabId];
  if (!tabInfo) {
    return;
  }

  qualifyVisibleSession(now);

  const rawDelta = Math.max(0, now - active.lastAccountedAt);
  const delta = Math.min(rawDelta, MAX_ACCOUNTING_GAP_MS);
  if (!delta) {
    return;
  }

  const sliceStartedAt = now - delta;
  active.lastAccountedAt = now;
  if (!isAllowedUrl(tabInfo.url)) {
    return;
  }

  let workDelta = 0;
  if (active.workStartedAt > 0) {
    const workFrom = Math.max(sliceStartedAt, active.workStartedAt);
    workDelta = Math.max(0, now - workFrom);
  }

  appendActivitySlice(tabInfo, now, delta, workDelta);
}

function qualifyVisibleSession(now = Date.now()) {
  const active = state.active;
  if (!active.browserFocused || typeof active.tabId !== "number") {
    return;
  }

  const tabInfo = state.tabs[active.tabId];
  const thresholdMs = state.settings.recentMinVisibleSeconds * 1000;
  if (tabInfo && isAllowedUrl(tabInfo.url) && now - active.startedAt >= thresholdMs) {
    tabInfo.lastQualifiedVisibleAt = now;
  }
}

function scheduleQualification() {
  clearQualificationTimer();
  if (!state.active.browserFocused) {
    return;
  }

  const thresholdMs = state.settings.recentMinVisibleSeconds * 1000;
  const remaining = Math.max(0, state.active.startedAt + thresholdMs - Date.now());
  qualificationTimer = setTimeout(() => {
    qualifyVisibleSession();
    saveState().catch((error) => console.error("Qualification save failed", error));
  }, remaining);
}

function clearQualificationTimer() {
  if (qualificationTimer !== null) {
    clearTimeout(qualificationTimer);
    qualificationTimer = null;
  }
}

function appendActivitySlice(tabInfo, now, dwellMs, workMs) {
  if (!Array.isArray(tabInfo.activityHistory)) {
    tabInfo.activityHistory = [];
  }

  tabInfo.activityHistory.push({
    at: now,
    dwellMs,
    workMs
  });

  pruneTabHistory(tabInfo, now);
}

function pruneAllHistory(now = Date.now()) {
  for (const tabInfo of Object.values(state.tabs)) {
    pruneTabHistory(tabInfo, now);
  }
}

function pruneTabHistory(tabInfo, now = Date.now()) {
  if (!Array.isArray(tabInfo.activityHistory)) {
    tabInfo.activityHistory = [];
    return;
  }

  const cutoff = now - HISTORY_RETENTION_MS;
  tabInfo.activityHistory = tabInfo.activityHistory.filter(
    (entry) => (entry.at || 0) >= cutoff && ((entry.dwellMs || 0) > 0 || (entry.workMs || 0) > 0)
  );
}

async function recordUserActivity(tabId, timestamp, kind) {
  const tabInfo = state.tabs[tabId];
  if (!tabInfo || !isAllowedUrl(tabInfo.url)) {
    return;
  }

  const active = state.active;
  const normalizedAt = Math.max(
    Number(timestamp) || Date.now(),
    active.tabId === tabId ? active.lastAccountedAt || 0 : 0
  );

  if (active.browserFocused && active.tabId === tabId) {
    const shouldStartOrContinueWork = classifyWorkActivity(kind);
    if (shouldStartOrContinueWork) {
      accountActiveSession(normalizedAt);
      if (!active.workStartedAt) {
        active.workStartedAt = Math.max(active.startedAt || 0, normalizedAt);
      }
      tabInfo.lastInteractionAt = normalizedAt;
    }
  }

  tabInfo.lastSeenAt = Date.now();
  await saveState();
}

function classifyWorkActivity(kind) {
  if (!state.settings.workActivityKinds.includes(kind)) {
    return false;
  }

  if (kind !== WORK_ACTIVITY_KIND.POINTER) {
    return true;
  }

  state.active.pointerActivityCount = (state.active.pointerActivityCount || 0) + 1;
  return state.active.pointerActivityCount >= state.settings.pointerWorkThreshold;
}

async function removeTab(tabId) {
  if (state.active.tabId === tabId) {
    endActiveSession(Date.now());
  }
  delete state.tabs[tabId];
  await saveState();
}

async function handleTick() {
  accountActiveSession(Date.now());
  await refreshSnapshot();
}

async function activateTab(tabId) {
  if (!Number.isInteger(tabId) || !state.tabs[tabId]) {
    throw new Error("tab-not-found");
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    delete state.tabs[tabId];
    await saveState();
    throw new Error("tab-not-found");
  }
}

async function togglePin(tabId) {
  const tabInfo = state.tabs[tabId];
  if (!tabInfo) {
    throw new Error("tab-not-found");
  }

  const key = canonicalizeUrl(tabInfo.url);
  const index = state.pinnedUrls.indexOf(key);
  if (index >= 0) {
    state.pinnedUrls.splice(index, 1);
    await saveState();
    return false;
  }

  state.pinnedUrls.unshift(key);
  await saveState();
  return true;
}

async function closeDuplicateTabs() {
  await refreshSnapshot();

  const buckets = new Map();
  for (const tabInfo of Object.values(state.tabs)) {
    if (!isAllowedUrl(tabInfo.url)) {
      continue;
    }

    const key = canonicalizeUrl(tabInfo.url);
    const bucket = buckets.get(key) || [];
    bucket.push(tabInfo);
    buckets.set(key, bucket);
  }

  const duplicateGroups = [...buckets.values()].filter((bucket) => bucket.length > 1);
  if (!duplicateGroups.length) {
    return { closedCount: 0, keptCount: 0, groupCount: 0 };
  }

  const toClose = [];
  for (const group of duplicateGroups) {
    const sorted = [...group].sort(compareDuplicateTabs);
    toClose.push(...sorted.slice(1));
  }

  let closedCount = 0;
  for (const tabInfo of toClose) {
    try {
      await chrome.tabs.remove(tabInfo.tabId);
      closedCount += 1;
    } catch (error) {
      console.warn("Failed to close duplicate tab", tabInfo.tabId, error);
    }

    if (state.active.tabId === tabInfo.tabId) {
      endActiveSession(Date.now());
    }
    delete state.tabs[tabInfo.tabId];
  }

  await refreshSnapshot();
  return {
    closedCount,
    keptCount: duplicateGroups.length,
    groupCount: duplicateGroups.length
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

  return b.tabId - a.tabId;
}

function buildDashboardPayload() {
  accountActiveSession(Date.now());
  const metricsByTabId = buildMetricsByTabId(Date.now());
  const tabs = Object.values(state.tabs)
    .filter((tab) => isAllowedUrl(tab.url))
    .map((tab) => ({
      tabId: tab.tabId,
      windowId: tab.windowId,
      title: tab.title || "Untitled",
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      lastQualifiedVisibleAt: tab.lastQualifiedVisibleAt || 0,
      lastInteractionAt: tab.lastInteractionAt || 0,
      createdAt: tab.createdAt || 0,
      lastSeenAt: tab.lastSeenAt || 0,
      todayDwellMs: metricsByTabId.get(tab.tabId)?.dwellMs || 0,
      todayWorkMs: metricsByTabId.get(tab.tabId)?.workMs || 0,
      pinned: state.pinnedUrls.includes(canonicalizeUrl(tab.url))
    }));

  return {
    generatedAt: Date.now(),
    settings: state.settings,
    tabs
  };
}

function buildMetricsByTabId(now = Date.now()) {
  const openTabs = Object.values(state.tabs).filter((tab) => isAllowedUrl(tab.url));

  if (state.settings.statsWindowMode === STATS_WINDOW_MODE.CALENDAR_DAY) {
    return buildCalendarDayMetrics(openTabs, now);
  }

  return buildRollingActiveMetrics(openTabs);
}

function buildCalendarDayMetrics(tabs, now = Date.now()) {
  const todayKey = getBeijingDayKey(new Date(now));
  const metrics = new Map();

  for (const tab of tabs) {
    const totals = { dwellMs: 0, workMs: 0 };
    for (const entry of tab.activityHistory || []) {
      if (getBeijingDayKey(new Date(entry.at)) !== todayKey) {
        continue;
      }
      totals.dwellMs += entry.dwellMs || 0;
      totals.workMs += entry.workMs || 0;
    }
    metrics.set(tab.tabId, totals);
  }

  return metrics;
}

function buildRollingActiveMetrics(tabs) {
  const metrics = new Map();
  const slices = [];

  for (const tab of tabs) {
    metrics.set(tab.tabId, { dwellMs: 0, workMs: 0 });
    for (const entry of tab.activityHistory || []) {
      if ((entry.dwellMs || 0) <= 0) {
        continue;
      }
      slices.push({
        tabId: tab.tabId,
        at: entry.at || 0,
        dwellMs: entry.dwellMs || 0,
        workMs: entry.workMs || 0
      });
    }
  }

  slices.sort((a, b) => b.at - a.at);

  let remainingWindowMs = ROLLING_WINDOW_MS;
  for (const slice of slices) {
    if (remainingWindowMs <= 0) {
      break;
    }

    const usedDwellMs = Math.min(slice.dwellMs, remainingWindowMs);
    const ratio = slice.dwellMs > 0 ? usedDwellMs / slice.dwellMs : 0;
    const metric = metrics.get(slice.tabId) || { dwellMs: 0, workMs: 0 };
    metric.dwellMs += usedDwellMs;
    metric.workMs += Math.round(slice.workMs * ratio);
    metrics.set(slice.tabId, metric);
    remainingWindowMs -= usedDwellMs;
  }

  return metrics;
}

function isAllowedUrl(url) {
  if (typeof url !== "string" || !/^https?:/i.test(url)) {
    return false;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  const blocked = parseDomainList(state.settings.blocklist);
  if (blocked.some((domain) => matchesDomain(hostname, domain))) {
    return false;
  }

  const allowed = parseDomainList(state.settings.allowlist);
  return allowed.length === 0 || allowed.some((domain) => matchesDomain(hostname, domain));
}

function parseDomainList(value) {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0])
    .filter(Boolean);
}

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
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

async function applyActionIcon() {
  if (!chrome.action?.setIcon) {
    return;
  }

  if (state.settings.customLogoDataUrl) {
    const imageData = await buildIconImageDataSet(state.settings.customLogoDataUrl);
    await chrome.action.setIcon({ imageData });
    return;
  }

  await chrome.action.setIcon({ path: buildDefaultIconPathSet() });
}

async function buildIconImageDataSet(dataUrl) {
  const source = await loadImageBitmapFromDataUrl(dataUrl);
  const sizes = [16, 32, 48, 128];
  const imageData = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { alpha: true });
    context.clearRect(0, 0, size, size);
    context.drawImage(source, 0, 0, size, size);
    imageData[size] = context.getImageData(0, 0, size, size);
  }

  source.close?.();
  return imageData;
}

async function loadImageBitmapFromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function buildDefaultIconPathSet() {
  return {
    16: "assets/icons/icon16.png",
    32: "assets/icons/icon32.png",
    48: "assets/icons/icon48.png",
    128: "assets/icons/icon128.png"
  };
}
