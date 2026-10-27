/**
 * 子代理互发消息：落盘回执 / 去重 / 增量拉取 / 限流 / 收件箱上限 / TTL / 任务状态机。
 *   node --test src/core/context-bus-agentmsg.test.js
 *
 * 覆盖（对应需求 1~4）：
 *   ① 先落盘再回执：返回 messageId 时磁盘上已经有这条消息；重启后读得到；
 *   ② 去重：显式 dedupeKey 与内容哈希都在 10 分钟窗口内返回原 id，窗口过了才允许新入队；
 *   ③ 收件箱：读不自动标已读、unreadCount、since 支持 messageId 与时间戳、未知 id 明确报错；
 *   ④ 限流（每发送方每分钟 N 条）与收件箱未读上限（INBOX_FULL），去重不占配额；
 *   ⑤ 任务 TTL：12 小时没做完惰性变 cancelled（reason=ttl），文本消息不受影响；
 *   ⑥ 任务状态流转、只有接收方能改、终态不能回退、result 只收引用（2000 字上限）。
 *
 * 全部用真实临时文件（不 mock 存储），限制值通过构造参数压小，避免真等 10 分钟 / 12 小时。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ContextBus } from "./context-bus.js";

const A = "win-aaa";
const B = "win-bbb";
const C = "win-ccc";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 每个测试一个独立临时目录：先起总线 + 一个包含 A/B/C 的组。 */
function tempBus(limits = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "windrise-agentmsg-"));
  const file = path.join(dir, "context-bus.json");
  const bus = new ContextBus({ file, limits });
  return {
    dir,
    file,
    bus,
    limits,
    async init() {
      const group = await bus.createGroup({ name: "测试组", members: [A, B, C] });
      return group;
    },
    async reopen() {
      await bus.dispose();
      const next = new ContextBus({ file, limits });
      await next.initialize();
      return next;
    },
    async close() {
      await bus.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 跑一次并拿错误（成功返回 null）。 */
async function errorOf(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

test("先落盘再回执：拿到 messageId 时磁盘上已经有了；重启后还在", async () => {
  const t = tempBus();
  try {
    const group = await t.init();
    const sent = await t.bus.send({ groupId: group.id, from: A, to: B, text: "先写盘，再回执" });

    assert.equal(sent.deduplicated, false);
    assert.match(sent.id, /^m_/);
    // 关键：返回值产生的同时，磁盘文件里必须已经有这条消息（不是等进程退出才 flush）。
    const onDisk = JSON.parse(readFileSync(t.file, "utf8"));
    assert.ok(onDisk.messages.some(message => message.id === sent.id), "返回 messageId 时消息必须已经在磁盘上");
    assert.equal(onDisk.messages.find(message => message.id === sent.id).kind, "text");

    const reopened = await t.reopen();
    const page = await reopened.inboxPage({ profileId: B });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].id, sent.id);
    assert.equal(page.messages[0].text, "先写盘，再回执");
    assert.equal(page.unreadCount, 1);
  } finally {
    await t.close();
  }
});

test("去重：显式 dedupeKey 与内容哈希都在窗口内返回原 id，窗口过了才新入队；跨重启成立", async () => {
  const t = tempBus({ dedupeWindowMs: 60_000, rateLimitPerMinute: 100 });
  try {
    const group = await t.init();

    const first = await t.bus.send({ groupId: group.id, from: A, to: B, text: "第一次", dedupeKey: "job-42" });
    const retry = await t.bus.send({ groupId: group.id, from: A, to: B, text: "内容改了也算同一次", dedupeKey: "job-42" });
    assert.equal(retry.id, first.id);
    assert.equal(retry.deduplicated, true);

    // 不给 dedupeKey → 内容哈希。同内容同收件人重复发，仍返回原 id。
    const byContent = await t.bus.send({ groupId: group.id, from: A, to: B, text: "同样的话" });
    const byContentAgain = await t.bus.send({ groupId: group.id, from: A, to: B, text: "同样的话" });
    assert.equal(byContentAgain.id, byContent.id);
    assert.equal(byContentAgain.deduplicated, true);

    // 内容相同但收件人不同 → 不是同一次发送。
    const toOther = await t.bus.send({ groupId: group.id, from: A, to: C, text: "同样的话" });
    assert.notEqual(toOther.id, byContent.id);

    // 去重记录在磁盘上：重启后重试仍返回原 id，不会因为进程重启重复入队。
    const reopened = await t.reopen();
    const afterRestart = await reopened.send({ groupId: group.id, from: A, to: B, text: "第一次", dedupeKey: "job-42" });
    assert.equal(afterRestart.id, first.id);
    assert.equal(afterRestart.deduplicated, true);

    const page = await reopened.inboxPage({ profileId: B, limit: 50 });
    assert.equal(page.messages.filter(message => message.id === first.id).length, 1);
    await reopened.dispose();
  } finally {
    await t.close();
  }
});

test("去重窗口过期后允许再次入队", async () => {
  const t = tempBus({ dedupeWindowMs: 40, rateLimitPerMinute: 100 });
  try {
    const group = await t.init();
    const first = await t.bus.send({ groupId: group.id, from: A, to: B, text: "窗口内" });
    await sleep(70);
    const second = await t.bus.send({ groupId: group.id, from: A, to: B, text: "窗口内" });
    assert.notEqual(second.id, first.id);
    assert.equal(second.deduplicated, false);
    const page = await t.bus.inboxPage({ profileId: B, limit: 50 });
    assert.equal(page.messages.length, 2);
  } finally {
    await t.close();
  }
});

test("收件箱：读不自动标已读、unreadCount、since 支持 messageId 与时间戳", async () => {
  const t = tempBus({ rateLimitPerMinute: 100 });
  try {
    const group = await t.init();
    const first = await t.bus.send({ groupId: group.id, from: A, to: B, text: "一" });
    const second = await t.bus.send({ groupId: group.id, from: A, to: B, text: "二" });
    const third = await t.bus.send({ groupId: group.id, from: A, to: B, text: "三" });

    // 读两次也不会变成已读：只有 markRead 能改已读状态。
    const readOnce = await t.bus.inboxPage({ profileId: B });
    await t.bus.inboxPage({ profileId: B });
    assert.equal(readOnce.unreadCount, 3);
    const afterReads = await t.bus.inboxPage({ profileId: B });
    assert.equal(afterReads.unreadCount, 3);
    assert.ok(afterReads.messages.every(message => message.readBy.length === 0));

    // messageId 增量：取 second 之后追加的消息，正好只有 third。
    const sinceId = await t.bus.inboxPage({ profileId: B, since: second.id });
    assert.deepEqual(sinceId.messages.map(message => message.id), [third.id]);
    assert.equal(sinceId.nextSince, third.id);
    assert.equal(sinceId.unreadCount, 3);

    // 时间戳增量：0 表示全量；未来时间表示没有新消息。
    const all = await t.bus.inboxPage({ profileId: B, since: 0, limit: 50 });
    assert.equal(all.messages.length, 3);
    const none = await t.bus.inboxPage({ profileId: B, since: Date.now() + 60_000 });
    assert.equal(none.messages.length, 0);

    // 未知 messageId 必须明确报错，不能静默当成全量。
    const unknown = await errorOf(() => t.bus.inboxPage({ profileId: B, since: "m_not_exists" }));
    assert.equal(unknown?.code, "UNKNOWN_SINCE");

    // 显式确认后未读数下降。
    const marked = await t.bus.markRead({ profileId: B, messageIds: [first.id] });
    assert.equal(marked.marked, 1);
    assert.equal(marked.unreadCount, 2);
    const afterMark = await t.bus.inboxPage({ profileId: B, unreadOnly: true });
    assert.equal(afterMark.messages.length, 2);
    assert.equal(afterMark.unreadCount, 2);
  } finally {
    await t.close();
  }
});

test("限流：每个发送方每分钟 N 条，去重不占配额", async () => {
  const t = tempBus({ rateLimitPerMinute: 2, maxUnreadPerInbox: 100 });
  try {
    const group = await t.init();
    await t.bus.send({ groupId: group.id, from: A, to: B, text: "第一条" });
    await t.bus.send({ groupId: group.id, from: A, to: B, text: "第二条" });

    // 重试同一条不算新消息，也不该被自己的限流挡住。
    const retry = await t.bus.send({ groupId: group.id, from: A, to: B, text: "第一条" });
    assert.equal(retry.deduplicated, true);

    const limited = await errorOf(() => t.bus.send({ groupId: group.id, from: A, to: B, text: "第三条" }));
    assert.equal(limited?.code, "RATE_LIMITED");
    assert.match(limited.message, /RATE_LIMITED/);

    // 限流按发送方算：另一个发送方不受影响。
    const other = await t.bus.send({ groupId: group.id, from: C, to: B, text: "别人可以发" });
    assert.equal(other.deduplicated, false);
  } finally {
    await t.close();
  }
});

test("收件箱未读上限：达到上限拒绝并返回 INBOX_FULL，标已读后恢复", async () => {
  const t = tempBus({ maxUnreadPerInbox: 2, rateLimitPerMinute: 100 });
  try {
    const group = await t.init();
    const first = await t.bus.send({ groupId: group.id, from: A, to: B, text: "一" });
    await t.bus.send({ groupId: group.id, from: A, to: B, text: "二" });

    const full = await errorOf(() => t.bus.send({ groupId: group.id, from: A, to: B, text: "三" }));
    assert.equal(full?.code, "INBOX_FULL");
    assert.match(full.message, /INBOX_FULL/);

    // 广播的每个成员都要检查：B 的收件箱满了，广播同样被拒。
    const broadcast = await errorOf(() => t.bus.send({ groupId: group.id, from: A, text: "广播也发不出去" }));
    assert.equal(broadcast?.code, "INBOX_FULL");

    await t.bus.markRead({ profileId: B, messageIds: [first.id] });
    const recovered = await t.bus.send({ groupId: group.id, from: A, to: B, text: "三" });
    assert.equal(recovered.deduplicated, false);

    const page = await t.bus.inboxPage({ profileId: B });
    assert.equal(page.unreadCount, 2);
    assert.equal(page.messages.length, 3, "默认返回全部消息（含已读），未读只有 2 条");
    const unreadPage = await t.bus.inboxPage({ profileId: B, unreadOnly: true });
    assert.equal(unreadPage.messages.length, 2);
  } finally {
    await t.close();
  }
});

test("任务 TTL：12 小时没完成惰性变 cancelled（reason=ttl），文本消息不受影响", async () => {
  const t = tempBus({ taskTtlMs: 40, rateLimitPerMinute: 100 });
  try {
    const group = await t.init();
    const task = await t.bus.send({ groupId: group.id, from: A, to: B, text: "核对订单", kind: "task" });
    const text = await t.bus.send({ groupId: group.id, from: A, to: B, text: "普通消息不受 TTL 影响" });
    assert.equal(task.status, "working");
    assert.equal(task.kind, "task");
    assert.equal(text.status, null);

    await sleep(70);

    const page = await t.bus.inboxPage({ profileId: B });
    const taskView = page.messages.find(message => message.id === task.id);
    const textView = page.messages.find(message => message.id === text.id);
    assert.equal(taskView.status, "cancelled");
    assert.equal(taskView.reason, "ttl");
    assert.equal(taskView.ttlExpired, true);
    assert.equal(textView.status, null);

    // 发送方查任务也看到同样的终态。
    const tasks = await t.bus.tasks({ profileId: A });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "cancelled");
    assert.equal(tasks[0].reason, "ttl");

    // 过期之后不能再改回 working / completed。
    const late = await errorOf(() => t.bus.updateTask({ profileId: B, taskId: task.id, status: "completed", result: "done.txt" }));
    assert.equal(late?.code, "BAD_TRANSITION");
  } finally {
    await t.close();
  }
});

test("任务状态流转：只有接收方能改，终态不能回退，result 只收引用且 ≤2000 字", async () => {
  const t = tempBus({ rateLimitPerMinute: 100 });
  try {
    const group = await t.init();
    const task = await t.bus.send({ groupId: group.id, from: A, to: B, text: "跑一遍下单流程", kind: "task" });

    // 第三个窗口、以及发送方自己都不能改接收方的任务。
    const outsider = await errorOf(() => t.bus.updateTask({ profileId: C, taskId: task.id, status: "working" }));
    assert.equal(outsider?.code, "not_assignee");
    const sender = await errorOf(() => t.bus.updateTask({ profileId: A, taskId: task.id, status: "cancelled" }));
    assert.equal(sender?.code, "not_assignee");

    const waiting = await t.bus.updateTask({
      profileId: B, taskId: task.id, status: "input_required", result: "logs/step1.txt",
    });
    assert.equal(waiting.status, "input_required");
    assert.equal(waiting.result, "logs/step1.txt");

    const working = await t.bus.updateTask({ profileId: B, taskId: task.id, status: "working" });
    assert.equal(working.status, "working");
    assert.equal(working.result, "logs/step1.txt", "不给 result 时保留上次的值");

    // 2000 字是上限（含边界），2001 字拒绝。
    const boundary = "a".repeat(2000);
    const done = await t.bus.updateTask({
      profileId: B, taskId: task.id, status: "completed", result: boundary,
    });
    assert.equal(done.status, "completed");
    assert.equal(done.result.length, 2000);

    const tooLong = await errorOf(() => t.bus.updateTask({
      profileId: B, taskId: task.id, status: "completed", result: "b".repeat(2001),
    }));
    assert.equal(tooLong?.code, "result_too_long");

    // 同状态 + 同结果 = 幂等重试；同状态 + 改结果 = 拒绝。
    const idempotent = await t.bus.updateTask({
      profileId: B, taskId: task.id, status: "completed", result: boundary,
    });
    assert.equal(idempotent.status, "completed");
    const rewrite = await errorOf(() => t.bus.updateTask({
      profileId: B, taskId: task.id, status: "completed", result: "改一下",
    }));
    assert.equal(rewrite?.code, "BAD_TRANSITION");

    const rewind = await errorOf(() => t.bus.updateTask({ profileId: B, taskId: task.id, status: "working" }));
    assert.equal(rewind?.code, "BAD_TRANSITION");

    const badStatus = await errorOf(() => t.bus.updateTask({ profileId: B, taskId: task.id, status: "done" }));
    assert.equal(badStatus?.code, "bad_status");

    // 普通文本消息不是任务。
    const text = await t.bus.send({ groupId: group.id, from: A, to: B, text: "这不是任务" });
    const notTask = await errorOf(() => t.bus.updateTask({ profileId: B, taskId: text.id, status: "completed" }));
    assert.equal(notTask?.code, "no_such_task");

    // 发送方能查到终态与结果引用；重启后仍在磁盘上。
    const reopened = await t.reopen();
    const tasks = await reopened.tasks({ profileId: A, taskId: task.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "completed");
    assert.equal(tasks[0].result, boundary);
    const byStatus = await reopened.tasks({ profileId: A, status: "completed" });
    assert.equal(byStatus.length, 1);
    const filteredOut = await reopened.tasks({ profileId: A, status: "working" });
    assert.equal(filteredOut.length, 0);
    await reopened.dispose();
  } finally {
    await t.close();
  }
});
