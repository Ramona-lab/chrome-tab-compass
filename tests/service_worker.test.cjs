const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function eventStub() {
  return { addListener() {} };
}

const chrome = {
  alarms: {
    create() {},
    onAlarm: eventStub()
  },
  runtime: {
    onInstalled: eventStub(),
    onStartup: eventStub(),
    onMessage: eventStub(),
    async openOptionsPage() {}
  },
  tabs: {
    onActivated: eventStub(),
    onUpdated: eventStub(),
    onRemoved: eventStub(),
    async query() {
      return [];
    },
    async get() {
      throw new Error("not mocked");
    },
    async update() {},
    async remove() {}
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: eventStub(),
    async getLastFocused() {
      return { id: 1, focused: false };
    },
    async get() {
      return { focused: false };
    },
    async update() {}
  },
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {}
    }
  }
};

const context = vm.createContext({
  chrome,
  console,
  Date,
  Intl,
  URL,
  setTimeout,
  clearTimeout
});

const workerPath = path.join(__dirname, "..", "service_worker.js");
vm.runInContext(fs.readFileSync(workerPath, "utf8"), context, { filename: workerPath });

async function run() {
  await new Promise((resolve) => setImmediate(resolve));

  const beforeMidnight = vm.runInContext(
    'getBeijingDayKey(new Date("2026-06-10T15:59:59.000Z"))',
    context
  );
  const afterMidnight = vm.runInContext(
    'getBeijingDayKey(new Date("2026-06-10T16:00:00.000Z"))',
    context
  );
  assert.equal(beforeMidnight, "2026-06-10");
  assert.equal(afterMidnight, "2026-06-11");

  vm.runInContext(
    'state.settings = sanitizeSettings({ allowlist: "example.com", blocklist: "private.example.com" })',
    context
  );
  assert.equal(vm.runInContext('isAllowedUrl("https://docs.example.com/a")', context), true);
  assert.equal(vm.runInContext('isAllowedUrl("https://private.example.com/a")', context), false);
  assert.equal(vm.runInContext('isAllowedUrl("https://unrelated.test/a")', context), false);
  assert.equal(
    vm.runInContext('sanitizeSettings({}).statsWindowMode', context),
    "rolling-active-24h"
  );
  assert.deepEqual(
    [...vm.runInContext('sanitizeSettings({}).workActivityKinds', context)],
    ["pointer", "typing", "scroll", "selection", "clipboard"]
  );
  assert.equal(vm.runInContext('sanitizeSettings({}).pointerWorkThreshold', context), 5);

  vm.runInContext(`
    state.settings = sanitizeSettings({ recentMinVisibleSeconds: 5 });
    state.tabs = {
      10: {
        ...createTabRecord(10),
        url: "https://example.com/doc"
      }
    };
    state.active = {
      tabId: 10,
      windowId: 1,
      browserFocused: true,
      startedAt: 10000,
      lastAccountedAt: 10000,
      workStartedAt: 0,
      pointerActivityCount: 0
    };
  `, context);
  vm.runInContext("qualifyVisibleSession(14999)", context);
  assert.equal(vm.runInContext("state.tabs[10].lastQualifiedVisibleAt", context), 0);
  vm.runInContext("qualifyVisibleSession(15000)", context);
  assert.equal(vm.runInContext("state.tabs[10].lastQualifiedVisibleAt", context), 15000);

  vm.runInContext(`
    state.settings = sanitizeSettings({ workActivityKinds: ["typing"] });
    state.tabs = {
      12: {
        ...createTabRecord(12),
        url: "https://example.com/editor"
      }
    };
    state.active = {
      tabId: 12,
      windowId: 1,
      browserFocused: true,
      startedAt: 10000,
      lastAccountedAt: 10000,
      workStartedAt: 0,
      pointerActivityCount: 0
    };
  `, context);
  await vm.runInContext('recordUserActivity(12, 12000, "scroll")', context);
  assert.equal(vm.runInContext("state.active.workStartedAt", context), 0);
  await vm.runInContext('recordUserActivity(12, 13000, "typing")', context);
  assert.equal(vm.runInContext("state.active.workStartedAt", context), 13000);
  vm.runInContext("accountActiveSession(15000)", context);
  assert.equal(vm.runInContext("state.tabs[12].activityHistory.length", context), 1);
  assert.equal(vm.runInContext("state.tabs[12].activityHistory[0].dwellMs", context), 2000);
  assert.equal(vm.runInContext("state.tabs[12].activityHistory[0].workMs", context), 2000);
  assert.equal(vm.runInContext("state.tabs[12].lastInteractionAt", context), 13000);

  vm.runInContext(`
    state.settings = sanitizeSettings({ workActivityKinds: ["pointer"], pointerWorkThreshold: 3 });
    state.tabs = {
      13: {
        ...createTabRecord(13),
        url: "https://example.com/dashboard"
      }
    };
    state.active = {
      tabId: 13,
      windowId: 1,
      browserFocused: true,
      startedAt: 20000,
      lastAccountedAt: 20000,
      workStartedAt: 0,
      pointerActivityCount: 0
    };
  `, context);
  await vm.runInContext('recordUserActivity(13, 21000, "pointer")', context);
  assert.equal(vm.runInContext("state.active.pointerActivityCount", context), 1);
  assert.equal(vm.runInContext("state.active.workStartedAt", context), 0);
  await vm.runInContext('recordUserActivity(13, 22000, "pointer")', context);
  assert.equal(vm.runInContext("state.active.pointerActivityCount", context), 2);
  assert.equal(vm.runInContext("state.active.workStartedAt", context), 0);
  await vm.runInContext('recordUserActivity(13, 23000, "pointer")', context);
  assert.equal(vm.runInContext("state.active.pointerActivityCount", context), 3);
  assert.equal(vm.runInContext("state.active.workStartedAt", context), 23000);
  vm.runInContext("accountActiveSession(25000)", context);
  assert.equal(vm.runInContext("state.tabs[13].activityHistory.length", context), 1);
  assert.equal(vm.runInContext("state.tabs[13].activityHistory[0].dwellMs", context), 2000);
  assert.equal(vm.runInContext("state.tabs[13].activityHistory[0].workMs", context), 2000);

  chrome.tabs.query = async () => [{
    id: 10,
    windowId: 1,
    title: "Open",
    url: "https://example.com/doc",
    favIconUrl: ""
  }];
  chrome.windows.getLastFocused = async () => ({ id: 1, focused: false });
  vm.runInContext("state.tabs[11] = { ...createTabRecord(11), url: 'https://example.com/closed' }", context);
  await vm.runInContext("refreshSnapshot()", context);
  assert.equal(vm.runInContext("Boolean(state.tabs[10])", context), true);
  assert.equal(vm.runInContext("Boolean(state.tabs[11])", context), false);

  vm.runInContext(`
    state.settings = sanitizeSettings({ statsWindowMode: "calendar-day" });
    state.tabs = {
      20: {
        ...createTabRecord(20),
        url: "https://example.com/day",
        activityHistory: [
          { at: Date.parse("2026-06-10T15:59:59.000Z"), dwellMs: 60000, workMs: 30000 },
          { at: Date.parse("2026-06-10T16:00:00.000Z"), dwellMs: 120000, workMs: 90000 }
        ]
      }
    };
  `, context);
  const dayMetrics = vm.runInContext('buildCalendarDayMetrics(Object.values(state.tabs), Date.parse("2026-06-10T16:30:00.000Z"))', context);
  assert.equal(dayMetrics.get(20).dwellMs, 120000);
  assert.equal(dayMetrics.get(20).workMs, 90000);

  vm.runInContext(`
    state.settings = sanitizeSettings({ statsWindowMode: "rolling-active-24h" });
    state.tabs = {
      30: {
        ...createTabRecord(30),
        url: "https://example.com/friday",
        activityHistory: [
          { at: Date.parse("2026-06-05T09:00:00.000Z"), dwellMs: 12 * 60 * 60 * 1000, workMs: 6 * 60 * 60 * 1000 }
        ]
      },
      31: {
        ...createTabRecord(31),
        url: "https://example.com/monday",
        activityHistory: [
          { at: Date.parse("2026-06-08T09:00:00.000Z"), dwellMs: 12 * 60 * 60 * 1000, workMs: 3 * 60 * 60 * 1000 }
        ]
      }
    };
  `, context);
  const rollingMetrics = vm.runInContext('buildRollingActiveMetrics(Object.values(state.tabs))', context);
  assert.equal(rollingMetrics.get(30).dwellMs, 12 * 60 * 60 * 1000);
  assert.equal(rollingMetrics.get(31).dwellMs, 12 * 60 * 60 * 1000);
  assert.equal(rollingMetrics.get(30).workMs, 6 * 60 * 60 * 1000);
  assert.equal(rollingMetrics.get(31).workMs, 3 * 60 * 60 * 1000);

  vm.runInContext(`
    state.tabs = {
      40: {
        ...createTabRecord(40),
        url: "https://example.com/boundary-a",
        activityHistory: [
          { at: 1000, dwellMs: 20 * 60 * 60 * 1000, workMs: 10 * 60 * 60 * 1000 }
        ]
      },
      41: {
        ...createTabRecord(41),
        url: "https://example.com/boundary-b",
        activityHistory: [
          { at: 2000, dwellMs: 10 * 60 * 60 * 1000, workMs: 5 * 60 * 60 * 1000 }
        ]
      }
    };
  `, context);
  const boundaryMetrics = vm.runInContext("buildRollingActiveMetrics(Object.values(state.tabs))", context);
  assert.equal(boundaryMetrics.get(41).dwellMs, 10 * 60 * 60 * 1000);
  assert.equal(boundaryMetrics.get(40).dwellMs, 14 * 60 * 60 * 1000);
  assert.equal(boundaryMetrics.get(40).workMs, 7 * 60 * 60 * 1000);

  console.log("service_worker tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
