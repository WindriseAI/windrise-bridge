import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";

import { createAuditEvent } from "./handoff.js";
import { createCallLog } from "./call-log.js";

import {
  DEFAULT_IDLE_MINUTES,
  MEMORY_FLOOR_BYTES,
  REAP_EVENT_TYPES,
  REAP_REASONS,
  SESSION_GONE_GRACE_MS,
  decideIdleAction,
  parseIdleMinutes,
  planMemoryRelief,
} from "./space-autoclose.js";

const require = createRequire(import.meta.url);
const { SpaceReaper } = require("../../electron/space-reaper.cjs");
const { BrowserOsProfiles } = require("../../electron/browseros-profiles.cjs");

const MINUTE = 60_000;
const NOW = 10_000_000;
const AI_SPACE = { gridId: "grid1", spaceId: "sp1", name: "整理邮件", owner: "ai", tabAlive: true };

test("idleMinutes 只认 5 / 10 / 30 / 0，坏值回落默认 10", () => {
  assert.equal(parseIdleMinutes(5), 5);
  assert.equal(parseIdleMinutes(30), 30);
  assert.equal(parseIdleMinutes(0), 0);
  assert.equal(parseIdleMinutes("10"), 10);
  assert.equal(parseIdleMinutes(undefined), DEFAULT_IDLE_MINUTES);
  assert.equal(parseIdleMinutes(7), DEFAULT_IDLE_MINUTES);
  assert.equal(parseIdleMinutes("abc"), DEFAULT_IDLE_MINUTES);
});

test("空闲到点关闭，不到点不动", () => {
  const due = decideIdleAction({ ...AI_SPACE, lastAiActivityAt: NOW - 11 * MINUTE }, { now: NOW, idleMinutes: 10 });
  assert.deepEqual(due, { action: "close", reason: REAP_REASONS.IDLE });
  const early = decideIdleAction({ ...AI_SPACE, lastAiActivityAt: NOW - 9 * MINUTE }, { now: NOW, idleMinutes: 10 });
  assert.equal(early.action, "none");
});

test("keep:true 只卸载不关闭；没有标签页时什么都不做", () => {
  const keep = decideIdleAction({ ...AI_SPACE, keep: true, lastAiActivityAt: NOW - 11 * MINUTE }, { now: NOW, idleMinutes: 10 });
  assert.deepEqual(keep, { action: "discard", reason: REAP_REASONS.IDLE });
  const empty = decideIdleAction({ ...AI_SPACE, keep: true, tabAlive: false, lastAiActivityAt: NOW - 11 * MINUTE }, { now: NOW, idleMinutes: 10 });
  assert.equal(empty.action, "none");
});

test("需要你 / 人已接管 / 交接中 / 暂停都不关", () => {
  for (const controlState of ["needs_help", "human_control", "returning", "paused", "awaiting_approval"]) {
    const decision = decideIdleAction(
      { ...AI_SPACE, controlState, lastAiActivityAt: NOW - 60 * MINUTE },
      { now: NOW, idleMinutes: 5 },
    );
    assert.equal(decision.action, "none", `状态 ${controlState} 不该动`);
  }
  // 人点了控制条「接管 / 终止任务」：接管模块的标记，哪怕不是前台也不动
  const held = decideIdleAction(
    { ...AI_SPACE, held: true, lastAiActivityAt: NOW - 60 * MINUTE },
    { now: NOW, idleMinutes: 5 },
  );
  assert.equal(held.action, "none");
  const running = decideIdleAction(
    { ...AI_SPACE, controlState: "ai_running", lastAiActivityAt: NOW - 60 * MINUTE },
    { now: NOW, idleMinutes: 5 },
  );
  assert.equal(running.action, "close");
});

test("人在看的前台标签不关、不卸载；「我的」永远不碰", () => {
  const watching = decideIdleAction(
    { ...AI_SPACE, foreground: true, lastAiActivityAt: NOW - 60 * MINUTE },
    { now: NOW, idleMinutes: 5 },
  );
  assert.equal(watching.action, "none");
  const watchingKeep = decideIdleAction(
    { ...AI_SPACE, keep: true, foreground: true, lastAiActivityAt: NOW - 60 * MINUTE },
    { now: NOW, idleMinutes: 5 },
  );
  assert.equal(watchingKeep.action, "none");
  const mine = decideIdleAction(
    { ...AI_SPACE, owner: "human", lastAiActivityAt: NOW - 60 * MINUTE },
    { now: NOW, idleMinutes: 5 },
  );
  assert.equal(mine.action, "none");
});

test("会话断开满 2 分钟立刻判断，不等 idleMinutes；没满不动", () => {
  const fresh = { ...AI_SPACE, lastAiActivityAt: NOW - MINUTE };
  const before = decideIdleAction({ ...fresh, sessionGoneAt: NOW - SESSION_GONE_GRACE_MS + 1_000 }, { now: NOW, idleMinutes: 30 });
  assert.equal(before.action, "none");
  const after = decideIdleAction({ ...fresh, sessionGoneAt: NOW - SESSION_GONE_GRACE_MS }, { now: NOW, idleMinutes: 30 });
  assert.deepEqual(after, { action: "close", reason: REAP_REASONS.SESSION_GONE });
  const keepAfter = decideIdleAction({ ...fresh, keep: true, sessionGoneAt: NOW - SESSION_GONE_GRACE_MS }, { now: NOW, idleMinutes: 10 });
  assert.deepEqual(keepAfter, { action: "discard", reason: REAP_REASONS.SESSION_GONE });
  // 会话回来了（sessionGoneAt 被清掉）就不再按断开处理
  const returned = decideIdleAction({ ...fresh, sessionGoneAt: 0 }, { now: NOW, idleMinutes: 30 });
  assert.equal(returned.action, "none");
});

test("「永不」只卸载不关闭", () => {
  const decision = decideIdleAction({ ...AI_SPACE, lastAiActivityAt: NOW - 60 * MINUTE }, { now: NOW, idleMinutes: 0 });
  assert.deepEqual(decision, { action: "discard", reason: REAP_REASONS.IDLE });
});

test("内存闸门：按最久没用排序，只挑 AI 空间的后台标签页", () => {
  const spaces = [
    { gridId: "g", spaceId: "mine", name: "我的", owner: "human", tabAlive: true, lastAiActivityAt: 1 },
    { gridId: "g", spaceId: "new", name: "新的", owner: "ai", tabAlive: true, lastAiActivityAt: NOW - MINUTE },
    { gridId: "g", spaceId: "old", name: "旧的", owner: "ai", tabAlive: true, lastAiActivityAt: NOW - 30 * MINUTE },
    { gridId: "g", spaceId: "look", name: "人看着的", owner: "ai", tabAlive: true, foreground: true, lastAiActivityAt: NOW - 90 * MINUTE },
    { gridId: "g", spaceId: "kept", name: "留着的", owner: "ai", keep: true, tabAlive: true, lastAiActivityAt: NOW - 20 * MINUTE },
    { gridId: "g", spaceId: "held", name: "人接管了", owner: "ai", tabAlive: true, held: true, lastAiActivityAt: NOW - 100 * MINUTE },
    { gridId: "g", spaceId: "empty", name: "没标签页", owner: "ai", tabAlive: false, lastAiActivityAt: NOW - 120 * MINUTE },
  ];
  const plan = planMemoryRelief(spaces, { availableBytes: 1 * 1024 ** 3, floorBytes: MEMORY_FLOOR_BYTES });
  assert.deepEqual(plan.map((item) => item.spaceId), ["old", "kept", "new"]);
  assert.ok(plan.every((item) => item.reason === REAP_REASONS.LOW_MEMORY));
  assert.deepEqual(
    planMemoryRelief(spaces, { availableBytes: 4 * 1024 ** 3, floorBytes: MEMORY_FLOOR_BYTES }),
    [],
    "内存够的时候什么都不卸载",
  );
});

test("审计：自动关闭写成 call-log 的一等事件，只有空间名 / 原因 / 标签页数，没有网址", async () => {
  const dir = path.join(process.cwd(), ".tmp", `space-audit-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const log = createCallLog({ dir });
    const event = createAuditEvent({
      type: REAP_EVENT_TYPES.CLOSE,
      space: "整理邮件",
      reason: REAP_REASONS.IDLE,
      tabs: 3,
      at: new Date(NOW),
    });
    assert.deepEqual(event, {
      type: "space_auto_close",
      space: "整理邮件",
      from: null,
      to: null,
      reason: "idle",
      at: new Date(NOW).toISOString(),
      tabs: 3,
    });
    await log.record({ event });
    const name = (await readdir(dir)).find((file) => file.startsWith("mcp-calls-"));
    const line = JSON.parse((await readFile(path.join(dir, name), "utf8")).trim().split("\n").at(-1));
    assert.equal(line.type, "space_auto_close");
    assert.equal(line.space, "整理邮件");
    assert.equal(line.reason, "idle");
    assert.equal(line.tabs, 3);
    assert.ok(!("url" in line) && !("title" in line), "审计里不许有网址 / 页面内容");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- SpaceReaper：把策略接上假后端 ---------------- */

function makeBackend(rows, { closedTabs = 2, discarded = 1 } = {}) {
  const state = { rows: rows.map((row) => ({ ...row })), closed: [], discarded: [], sessionGone: [] };
  const backend = {
    spacesForAutoClose: () => state.rows.map((row) => ({ ...row })),
    async spaceClose(gridId, spaceId) {
      state.closed.push({ gridId, spaceId });
      const row = state.rows.find((item) => item.gridId === gridId && item.spaceId === spaceId);
      state.rows = state.rows.filter((item) => !(item.gridId === gridId && item.spaceId === spaceId));
      return { gridId, spaceId, name: row?.name, closed: true, closedTabs };
    },
    async spaceDiscard(gridId, spaceId) {
      state.discarded.push({ gridId, spaceId });
      return { gridId, spaceId, discarded };
    },
    noteSessionGone(sessionId, at) {
      state.sessionGone.push({ sessionId, at });
      return state.rows.filter((row) => row.sessionId === sessionId).length;
    },
    clearSessionGone() { return 0; },
  };
  return { backend, state };
}

function makeReaper(backend, { now = NOW, idleMinutes = 10, memory = 8 * 1024 ** 3, foreground = () => false, held = () => false } = {}) {
  const audit = [];
  const timer = { delays: [], setTimeout: (fn, delay) => { timer.delays.push(delay); return { fn }; }, clearTimeout: () => {} };
  const reaper = new SpaceReaper({
    backend,
    audit: (event) => { audit.push(event); },
    isForeground: foreground,
    isHeld: held,
    getIdleMinutes: () => idleMinutes,
    getAvailableMemoryBytes: () => (typeof memory === "function" ? memory() : memory),
    now: () => now,
    intervalMs: MINUTE,
    timerApi: timer,
  });
  return { reaper, audit, timer };
}

test("自动收摊：idle 到点关闭并写审计（空间名 + 原因 + 标签页数）", async () => {
  const { backend, state } = makeBackend([
    { ...AI_SPACE, controlState: "ai_running", lastAiActivityAt: NOW - 11 * MINUTE },
    { ...AI_SPACE, spaceId: "sp2", name: "还在用", lastAiActivityAt: NOW - MINUTE },
  ]);
  const { reaper, audit } = makeReaper(backend);
  const summary = await reaper.runOnce({ now: NOW });
  assert.deepEqual(summary.closed, ["sp1"]);
  assert.deepEqual(state.closed, [{ gridId: "grid1", spaceId: "sp1" }]);
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], { type: REAP_EVENT_TYPES.CLOSE, space: "整理邮件", reason: REAP_REASONS.IDLE, tabs: 2 });
  assert.ok(!audit[0].url, "审计里不能有网址");
});

test("自动收摊：keep 空间只卸载不关", async () => {
  const { backend, state } = makeBackend([
    { ...AI_SPACE, keep: true, lastAiActivityAt: NOW - 11 * MINUTE },
  ]);
  const { reaper, audit } = makeReaper(backend);
  await reaper.runOnce({ now: NOW });
  assert.equal(state.closed.length, 0);
  assert.deepEqual(state.discarded, [{ gridId: "grid1", spaceId: "sp1" }]);
  assert.deepEqual(audit[0], { type: REAP_EVENT_TYPES.DISCARD, space: "整理邮件", reason: REAP_REASONS.IDLE, tabs: 1 });
});

test("自动收摊：需要你 / 接管中 / 人在看的前台都不动", async () => {
  const { backend, state } = makeBackend([
    { ...AI_SPACE, spaceId: "needs", controlState: "needs_help", lastAiActivityAt: NOW - 60 * MINUTE },
    { ...AI_SPACE, spaceId: "human", controlState: "human_control", lastAiActivityAt: NOW - 60 * MINUTE },
    { ...AI_SPACE, spaceId: "returning", controlState: "returning", lastAiActivityAt: NOW - 60 * MINUTE },
    { ...AI_SPACE, spaceId: "watched", lastAiActivityAt: NOW - 60 * MINUTE },
    { ...AI_SPACE, spaceId: "held", lastAiActivityAt: NOW - 60 * MINUTE },
    { ...AI_SPACE, spaceId: "mine", name: "我的", owner: "human", lastAiActivityAt: NOW - 60 * MINUTE },
  ]);
  const { reaper, audit } = makeReaper(backend, {
    foreground: (gridId, spaceId) => spaceId === "watched",
    held: (gridId, spaceId) => spaceId === "held",
  });
  const summary = await reaper.runOnce({ now: NOW });
  assert.deepEqual(state.closed, []);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(summary.closed, []);
  assert.equal(audit.length, 0);
});

test("自动收摊：人在看的判断拿不到时当人在看，不误关", async () => {
  const { backend, state } = makeBackend([{ ...AI_SPACE, lastAiActivityAt: NOW - 60 * MINUTE }]);
  const { reaper } = makeReaper(backend, { foreground: () => null });
  await reaper.runOnce({ now: NOW });
  assert.deepEqual(state.closed, []);
});

test("自动收摊：会话断开 2 分钟就触发（lastAiActivity 还新）；会话回来了不触发", async () => {
  const goneRows = [
    { ...AI_SPACE, spaceId: "gone", sessionId: "s1", sessionGoneAt: NOW - SESSION_GONE_GRACE_MS, lastAiActivityAt: NOW - MINUTE },
  ];
  const first = makeBackend(goneRows);
  const { reaper } = makeReaper(first.backend);
  await reaper.runOnce({ now: NOW });
  assert.deepEqual(first.state.closed, [{ gridId: "grid1", spaceId: "gone" }]);

  const backRows = [
    { ...AI_SPACE, spaceId: "back", sessionId: "s1", sessionGoneAt: 0, lastAiActivityAt: NOW - MINUTE },
  ];
  const second = makeBackend(backRows);
  const secondReaper = makeReaper(second.backend);
  await secondReaper.reaper.runOnce({ now: NOW });
  assert.deepEqual(second.state.closed, []);
});

test("会话断开：记到空间上，并安排 2 分钟后的检查", async () => {
  const { backend, state } = makeBackend([{ ...AI_SPACE, sessionId: "s1", lastAiActivityAt: NOW - MINUTE }]);
  const { reaper, timer } = makeReaper(backend, { idleMinutes: 30 });
  reaper.start();
  const firstDelay = timer.delays.at(-1);
  assert.equal(firstDelay, MINUTE, "平时每分钟检查一次");
  reaper.noteSessionClosed("s1");
  assert.deepEqual(state.sessionGone, [{ sessionId: "s1", at: NOW }]);
  assert.equal(timer.delays.at(-1), SESSION_GONE_GRACE_MS, "会话断开后插一次满 2 分钟的检查");
  reaper.stop();
});

test("内存闸门：只卸载不关闭、不碰「我的」；回到下限以上就停", async () => {
  let available = 1 * 1024 ** 3;
  const { backend, state } = makeBackend([
    { ...AI_SPACE, spaceId: "older", name: "更老", owner: "ai", lastAiActivityAt: NOW - 20 * MINUTE },
    { ...AI_SPACE, spaceId: "old", name: "老", owner: "ai", lastAiActivityAt: NOW - 15 * MINUTE },
    { ...AI_SPACE, spaceId: "newer", name: "新", owner: "ai", lastAiActivityAt: NOW - MINUTE },
    { ...AI_SPACE, spaceId: "mine", name: "我的", owner: "human", lastAiActivityAt: 1 },
    { ...AI_SPACE, spaceId: "watched", name: "人看着", owner: "ai", lastAiActivityAt: NOW - 25 * MINUTE },
  ]);
  const { reaper, audit } = makeReaper(backend, {
    idleMinutes: 30, // 这一拍只测内存闸门，别让空闲收摊先把它们关掉
    // 每次读内存都比上次多 0.2 GB：两次卸载后（1.4 → 1.6 GB）回到下限以上
    memory: () => { const value = available; available += 0.2 * 1024 ** 3; return value; },
    foreground: (_grid, spaceId) => spaceId === "watched",
  });
  const summary = await reaper.runOnce({ now: NOW });
  assert.equal(state.closed.length, 0, "内存闸门绝不关闭空间");
  assert.deepEqual(state.discarded.map((item) => item.spaceId), ["older", "old"]);
  assert.deepEqual(summary.discarded.sort(), ["old", "older"]);
  assert.ok(audit.every((event) => event.type === REAP_EVENT_TYPES.DISCARD && event.reason === REAP_REASONS.LOW_MEMORY));
  assert.ok(!state.discarded.some((item) => item.spaceId === "mine"), "「我的」不许碰");
});

test("space_close 返回关闭数量：插件报的 removed 就是标签页数（含新开的标签页）", async () => {
  const dir = path.join(process.cwd(), ".tmp", `space-close-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const profiles = new BrowserOsProfiles({
      dataHome: dir,
      engine: { defaultUserDataDir: (home, id) => path.join(home, "browseros", "profiles", String(id)) },
      tabModule: {},
    });
    const sent = [];
    const tab = { isDestroyed: () => false, dispose: () => {} };
    const record = {
      id: "sp1",
      name: "整理邮件",
      owner: "ai",
      createdAt: Date.now(),
      control: { state: "ai_running" },
      tab,
      window: {},
      groupId: 7,
      chromeTabId: 101,
      keep: false,
      lastAiActivityAt: Date.now(),
      sessionId: null,
      sessionGoneAt: null,
    };
    profiles.entriesMap.set("grid1", {
      id: "grid1",
      profile: { name: "格子 1" },
      tab,
      handle: {
        gridBinding: { sessionId: "worker-1" },
        conn: {
          send: async (_method, params) => {
            sent.push(params.expression);
            return { result: { value: { removed: 3, tabIds: [101, 102, 103] } } };
          },
        },
      },
      policy: { workerSessionId: "worker-1" },
      spaces: new Map([["sp1", record]]),
    });

    const result = await profiles.spaceClose("grid1", "sp1");
    assert.equal(result.closedTabs, 3);
    assert.equal(result.closed, true);
    assert.ok(
      sent.some((expression) => expression.includes("closeGroupTabs") && expression.includes('"groupId":7')),
      "按标签组关闭，页面新开的标签页跟着一起关",
    );
    assert.ok(!profiles.entriesMap.get("grid1").spaces.has("sp1"), "记录已经删掉");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("space_close 拿不到插件时按主标签页估 1 个", async () => {
  const dir = path.join(process.cwd(), ".tmp", `space-close-fallback-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const profiles = new BrowserOsProfiles({
      dataHome: dir,
      engine: { defaultUserDataDir: (home, id) => path.join(home, "browseros", "profiles", String(id)) },
      tabModule: {},
    });
    const tab = { isDestroyed: () => false, dispose: () => {} };
    profiles.entriesMap.set("grid1", {
      id: "grid1",
      profile: { name: "格子 1" },
      tab,
      handle: {
        gridBinding: { sessionId: "worker-1" },
        conn: { send: async () => { throw new Error("插件没连上"); } },
      },
      policy: { workerSessionId: "worker-1" },
      spaces: new Map([["sp1", {
        id: "sp1",
        name: "整理邮件",
        owner: "ai",
        createdAt: Date.now(),
        control: { state: "ai_running" },
        tab,
        window: {},
        groupId: 7,
        chromeTabId: 101,
        keep: false,
        lastAiActivityAt: Date.now(),
        sessionId: null,
        sessionGoneAt: null,
      }]]),
    });
    const result = await profiles.spaceClose("grid1", "sp1");
    assert.equal(result.closedTabs, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
