#!/usr/bin/env node
/**
 * 共享上下文总线 —— 端到端自检（真的跑，不 mock）。
 *
 * 运行：node src/context-bus-selftest.mjs
 *
 * 覆盖（编号与需求清单一一对应）：
 *   ① 建两个分组、各带不同成员 + 成员去重 / groupsFor
 *   ② 隔离：A 组写的记忆，B 组搜不到
 *   ③ 共享：W1 写进 A 组，W2 从 A 组读得到（含「省略 groupId 跨我加入的组检索」）
 *   ④ 同 key 同来源写两次 = 更新而非堆积；不同来源同 key = 各一条
 *   ⑤ 标签检索 + 子串检索（大小写不敏感）+ key 模糊匹配
 *   ⑥ 消息：私信 / 广播 / 非成员看不到 / markRead 后 unreadOnly 过滤
 *   ⑦ 跨进程持久化：另起一个**新进程**读，数据还在
 *   ⑧ 并发写：同进程 30 个并发 + 4 个**子进程**并发，条数正确、JSON 没坏、无残留临时文件
 *   ⑨ 上限：超长 value / 每组条数 / 每组消息数都被**明确拒绝**（报错可读、数据没动）
 *   ⑩ 过期清理：短 ttl 条目到点读不到，prune 之后磁盘上也没了
 *   ⑪ 真实 MCP 协议：起 Bridge，用 tools/call 调 context_share / context_recall 等
 *   ⑫ 附加：损坏文件隔离、更高版本文件拒读（不毁数据）
 *
 * 纪律：所有结论都来自实际运行输出；跑不通就如实打 FAIL，不粉饰。
 * 副作用隔离：所有数据写在系统临时目录，并且把 BRIDGE_SHARED_DATA_HOME 也指到临时目录，
 * 绝不碰真实的 ~/.bridge-replica 与 ~/.bridge-replica-shared。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContextBus } from "./core/context-bus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

/* ================================================================== *
 * 子进程模式：被父进程 spawn 出来，只干一件事，然后把结果打成一行带标记的 JSON。
 * 用途是证明「跨进程」——持久化（⑦）和并发写（⑧）都必须换进程才算数。
 * ================================================================== */
const [mode, ...childArgs] = process.argv.slice(2);
if (mode === "--child-read" || mode === "--child-write") {
  const emit = (payload) => console.log(`<<<RESULT ${JSON.stringify(payload)} RESULT>>>`);
  try {
    const [file, groupId, profileId, count, tag] = childArgs;
    const bus = new ContextBus({ file });
    await bus.initialize();
    if (mode === "--child-read") {
      const items = await bus.listItems({ groupId, limit: 500 });
      const stats = await bus.stats();
      emit({
        pid: process.pid,
        count: items.length,
        items: items.map(item => ({ key: item.key, value: item.value, source: item.sourceProfileId })),
        stats: { groups: stats.groups, items: stats.items, fileBytes: stats.fileBytes },
      });
    } else {
      const n = Number(count);
      for (let i = 0; i < n; i++) {
        await bus.share({
          groupId,
          key: `child-${tag}-${i}`,
          value: `子进程 ${tag} 写的第 ${i} 条（pid=${process.pid}）`,
          tags: [tag],
          sourceProfileId: profileId,
        });
      }
      const items = await bus.listItems({ groupId, limit: 500 });
      emit({ pid: process.pid, written: n, total: items.length });
    }
    await bus.dispose();
    process.exit(0);
  } catch (error) {
    console.error(`子进程 ${mode} 失败：${error.stack ?? error.message}`);
    emit({ pid: process.pid, error: error.message });
    process.exit(1);
  }
}

/* ================================================================== *
 * 父进程：跑全部检查
 * ================================================================== */

const tmpRoot = path.join(os.tmpdir(), `bridge-context-bus-selftest-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
// 别把测试写进真实用户的共享目录（boot() 会建 WorkspaceHub）
process.env.BRIDGE_SHARED_DATA_HOME = path.join(tmpRoot, "shared");
// 确保环境变量兜底不会意外命中（第 ⑪ 项要验证「没有任何身份来源时报错」）
delete process.env.BRIDGE_PROFILE_ID;

const busFile = path.join(tmpRoot, "context-bus.json");
const W1 = "7f3a91c2";   // 模拟 browser-profiles 生成的 8 位窗口 id
const W2 = "b18d40e7";
const W3 = "c9f2a63b";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 起一个子进程跑本文件，抓回它打的 <<<RESULT ... RESULT>>> 行。 */
function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [thisFile, ...args], { cwd: here, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", error => resolve({ code: -1, stdout, stderr: String(error.message), result: null }));
    child.on("close", code => {
      const match = /<<<RESULT (.*) RESULT>>>/.exec(stdout);
      let result = null;
      if (match) { try { result = JSON.parse(match[1]); } catch { /* 解析失败就留 null，检查会 FAIL */ } }
      resolve({ code, stdout, stderr, result });
    });
  });
}

console.log(`共享上下文总线自检`);
console.log(`  临时目录 : ${tmpRoot}`);
console.log(`  数据文件 : ${busFile}`);
console.log(`  Node     : ${process.version} / ${process.platform}\n`);

const bus = new ContextBus({
  file: busFile,
  log: (line) => console.log(`        [bus] ${line}`),
});
await bus.initialize();

/* ================================================================== *
 * ① 分组
 * ================================================================== */
console.log("=== ① 建两个分组、各带不同成员 ===");
const groupA = await bus.createGroup({ name: "研究组", members: [W1, W2], note: "两个 Agent 协同干活" });
const groupB = await bus.createGroup({ name: "客服组", members: [W3] });
const groups = await bus.listGroups();
check(
  "建了两个分组，成员互不相同",
  groups.length === 2 && groupA.members.length === 2 && groupB.members.length === 1,
  `A=${groupA.id}「${groupA.name}」成员=[${groupA.members.join(", ")}]  B=${groupB.id}「${groupB.name}」成员=[${groupB.members.join(", ")}]`,
);
const forW1 = await bus.groupsFor(W1);
check(
  "groupsFor(W1) 返回数组且只含 A 组",
  Array.isArray(forW1) && forW1.length === 1 && forW1[0].id === groupA.id,
  `返回 ${forW1.length} 个组：${forW1.map(g => g.name).join(", ")}`,
);
const linked = await bus.link(groupA.id, [W1, W3]);
check(
  "link 去重：W1 已在组里 → already；W3 新增 → added",
  linked.added.length === 1 && linked.added[0] === W3 && linked.already.includes(W1) && linked.group.members.length === 3,
  `added=[${linked.added.join(", ")}] already=[${linked.already.join(", ")}] → 成员=[${linked.group.members.join(", ")}]`,
);
const unlinked = await bus.unlink(groupA.id, [W3]);
check(
  "unlink 还原（为后面的隔离检查做准备）",
  unlinked.removed.length === 1 && unlinked.group.members.length === 2,
  `removed=[${unlinked.removed.join(", ")}] → 成员=[${unlinked.group.members.join(", ")}]`,
);

/* ================================================================== *
 * ② 隔离
 * ================================================================== */
console.log("\n=== ② 隔离：A 组写的，B 组搜不到 ===");
const secret = await bus.share({
  groupId: groupA.id,
  key: "验证码位置",
  value: "这站的验证码在 iframe 里，选择器是 #captcha-frame（等 1.5 秒才渲染出来）",
  tags: ["站点:example.com", "坑"],
  sourceProfileId: W1,
});
const bByQuery = await bus.recall({ groupId: groupB.id, query: "验证码" });
const bByTag = await bus.recall({ groupId: groupB.id, tags: ["站点:example.com"] });
const bAll = await bus.listItems({ groupId: groupB.id });
check(
  "B 组三种查法（query / tags / 全量）都搜不到 A 组那条",
  bByQuery.length === 0 && bByTag.length === 0 && bAll.length === 0,
  `B 组 query 命中 ${bByQuery.length} 条、tags 命中 ${bByTag.length} 条、全量 ${bAll.length} 条`,
);
const aByQuery = await bus.recall({ groupId: groupA.id, query: "验证码" });
check(
  "对照：同样的查法在 A 组能命中（证明数据确实写进去了）",
  aByQuery.length === 1 && aByQuery[0].id === secret.id,
  `A 组命中 ${aByQuery.length} 条：key=${aByQuery[0]?.key} 来源=${aByQuery[0]?.sourceProfileId}`,
);

/* ================================================================== *
 * ③ 共享
 * ================================================================== */
console.log("\n=== ③ 共享：W1 写进 A 组，W2 读得到 ===");
const seenByW2 = await bus.recall({ groupId: groupA.id, query: "iframe" });
check(
  "W2 在 A 组读到 W1 写的那条",
  seenByW2.length === 1 && seenByW2[0].sourceProfileId === W1,
  `命中 ${seenByW2.length} 条，来源=${seenByW2[0]?.sourceProfileId}（W1=${W1}），命中位置=${seenByW2[0]?.matchedIn?.join("/")}`,
);
const acrossGroups = await bus.recall({ query: "captcha-frame", profileId: W2 });
check(
  "省略 groupId：按「我加入的组」检索（W2 在 A 组 → 命中）",
  acrossGroups.length === 1,
  `W2 跨组检索命中 ${acrossGroups.length} 条`,
);
const outsider = await bus.recall({ query: "captcha-frame", profileId: W3 });
check(
  "不在 A 组的 W3 跨组检索搜不到（隔离对检索同样生效）",
  outsider.length === 0,
  `W3 跨组检索命中 ${outsider.length} 条`,
);
let memberGuard = null;
try {
  await bus.share({ groupId: groupA.id, key: "越权测试", value: "非成员写入", sourceProfileId: W3 });
} catch (error) { memberGuard = error; }
check(
  "非成员往组里写 → 明确拒绝（不是静默接受）",
  memberGuard?.code === "not_a_member",
  `code=${memberGuard?.code}  message=${memberGuard?.message?.split("\n")[0]}`,
);

/* ================================================================== *
 * ④ 同 key 覆盖
 * ================================================================== */
console.log("\n=== ④ 同 key 同来源 = 更新，不是堆积 ===");
const progress1 = await bus.share({ groupId: groupA.id, key: "当前进度", value: "第 1 步：登录成功", sourceProfileId: W1 });
const progress2 = await bus.share({ groupId: groupA.id, key: "当前进度", value: "第 2 步：已进入订单页", sourceProfileId: W1 });
const progressItems = (await bus.listItems({ groupId: groupA.id })).filter(item => item.key === "当前进度");
check(
  "W1 用同一个 key 写两次 → 只有一条，值是最后一次的",
  progressItems.length === 1 && progressItems[0].value.includes("第 2 步") && progressItems[0].id === progress1.id && progressItems[0].revision === 2,
  `条数=${progressItems.length}  id 不变=${progressItems[0].id === progress1.id}  revision=${progressItems[0].revision}  value="${progressItems[0].value}"`,
);
await bus.share({ groupId: groupA.id, key: "当前进度", value: "第 2 步（W2 视角）", sourceProfileId: W2 });
const progressAll = (await bus.listItems({ groupId: groupA.id })).filter(item => item.key === "当前进度");
check(
  "不同来源用同一个 key → 各存一条（覆盖坐标是 group+来源+key）",
  progressAll.length === 2,
  `条数=${progressAll.length}：${progressAll.map(item => item.sourceProfileId).join(", ")}`,
);

/* ================================================================== *
 * ⑤ 标签 + 子串检索
 * ================================================================== */
console.log("\n=== ⑤ 标签检索 / 子串检索 / key 模糊匹配 ===");
await bus.share({
  groupId: groupA.id,
  key: "登录接口",
  value: "POST /api/login，JSON 提交，记得带 X-Requested-With 头",
  tags: ["接口", "站点:example.com"],
  sourceProfileId: W2,
});
const byTag = await bus.recall({ groupId: groupA.id, tags: ["接口"] });
check("按标签命中", byTag.length === 1 && byTag[0].key === "登录接口", `命中 ${byTag.length} 条：${byTag.map(item => item.key).join(", ")}`);
const bySubstring = await bus.recall({ groupId: groupA.id, query: "x-requested-with" });
check(
  "子串检索命中且大小写不敏感（原文是 X-Requested-With）",
  bySubstring.length === 1 && bySubstring[0].matchedIn.includes("value"),
  `命中 ${bySubstring.length} 条，命中位置=${bySubstring[0]?.matchedIn?.join("/")}`,
);
const byKey = await bus.recall({ groupId: groupA.id, query: "登录" });
check(
  "key 模糊匹配命中",
  byKey.some(item => item.key === "登录接口"),
  `命中 ${byKey.length} 条：${byKey.map(item => `${item.key}[${item.matchedIn.join("/")}]`).join(", ")}`,
);
const tagAndQuery = await bus.recall({ groupId: groupA.id, query: "login", tags: ["接口"] });
check("query + tags 叠加（都要满足）", tagAndQuery.length === 1, `命中 ${tagAndQuery.length} 条`);
const missByTag = await bus.recall({ groupId: groupA.id, query: "login", tags: ["不存在的标签"] });
check("tags 对不上时即使 query 命中也不返回", missByTag.length === 0, `命中 ${missByTag.length} 条`);

/* ================================================================== *
 * ⑥ 消息
 * ================================================================== */
console.log("\n=== ⑥ 消息：私信 / 广播 / 已读 ===");
const dm = await bus.send({ groupId: groupA.id, from: W1, to: W2, text: "验证码那条记忆写好了，key=验证码位置" });
const broadcast = await bus.send({ groupId: groupA.id, from: W2, text: "广播：订单页有二次确认弹窗，别当成失败重试" });
const inboxW2 = await bus.inbox({ profileId: W2 });
check(
  "W2 的 inbox 同时看到「发给我的私信」和「我所在组的广播」",
  inboxW2.length === 2 && inboxW2.some(m => m.id === dm.id && m.to === W2) && inboxW2.some(m => m.id === broadcast.id && m.to === null),
  `共 ${inboxW2.length} 条：${inboxW2.map(m => `${m.to === null ? "广播" : "→W2"}(来自 ${m.from})`).join("，")}`,
);
const inboxW1 = await bus.inbox({ profileId: W1 });
check(
  "W1 看得到广播，但看不到发给 W2 的私信",
  inboxW1.length === 1 && inboxW1[0].id === broadcast.id,
  `W1 收到 ${inboxW1.length} 条：${inboxW1.map(m => m.id).join(", ")}`,
);
const inboxW3 = await bus.inbox({ profileId: W3 });
check("不在组里的 W3 一条都收不到", inboxW3.length === 0, `W3 收到 ${inboxW3.length} 条`);
let toOutsider = null;
try {
  await bus.send({ groupId: groupA.id, from: W1, to: W3, text: "发不出去" });
} catch (error) { toOutsider = error; }
check(
  "发给组外窗口 → 明确拒绝（否则消息会石沉大海）",
  toOutsider?.code === "not_a_member",
  `code=${toOutsider?.code}  message=${toOutsider?.message?.split("\n")[0]}`,
);
const unreadBefore = await bus.inbox({ profileId: W2, unreadOnly: true });
const marked = await bus.markRead({ profileId: W2, messageIds: [dm.id] });
const unreadAfter = await bus.inbox({ profileId: W2, unreadOnly: true });
check(
  "markRead 之后 unreadOnly 把已读过滤掉",
  unreadBefore.length === 2 && marked.marked === 1 && unreadAfter.length === 1 && unreadAfter[0].id === broadcast.id,
  `标记前未读 ${unreadBefore.length} 条 → markRead(${dm.id}) marked=${marked.marked} → 未读 ${unreadAfter.length} 条（剩广播 ${unreadAfter[0]?.id}）`,
);
const markedAgain = await bus.markRead({ profileId: W2, messageIds: [dm.id] });
check(
  "重复 markRead 幂等（报 alreadyRead，不重复计数）",
  markedAgain.marked === 0 && markedAgain.alreadyRead === 1,
  `marked=${markedAgain.marked} alreadyRead=${markedAgain.alreadyRead}`,
);

/* ================================================================== *
 * ⑦ 跨进程持久化
 * ================================================================== */
console.log("\n=== ⑦ 跨进程持久化：另起一个进程读 ===");
const statsBeforeChild = await bus.stats();
const childRead = await runChild(["--child-read", busFile, groupA.id]);
const fileMode = (statSync(busFile).mode & 0o777).toString(8);
console.log(`        [info] 磁盘文件权限位（八进制）= ${fileMode}（Windows 上 mode 基本是 no-op，POSIX 上应为 600）`);
check(
  "新进程（不是本进程）读到 A 组的记忆，说明真的落盘了",
  childRead.code === 0 && childRead.result?.items?.length >= 4 && childRead.result.items.some(item => item.key === "验证码位置"),
  `子进程 pid=${childRead.result?.pid} 读到 ${childRead.result?.items?.length} 条（本进程 stats.items=${statsBeforeChild.items}）；key 清单=${childRead.result?.items?.map(i => i.key).join(", ")}`,
);
check(
  "子进程读到的内容与写入内容逐字一致",
  childRead.result?.items?.some(item => item.key === "验证码位置" && item.value.includes("#captcha-frame") && item.source === W1),
  `子进程看到的验证码条目：${JSON.stringify(childRead.result?.items?.find(i => i.key === "验证码位置"))?.slice(0, 160)}`,
);
if (childRead.stderr) console.log(`        [info] 子进程 stderr：${childRead.stderr.trim().slice(0, 300)}`);

/* ================================================================== *
 * ⑧ 并发写
 * ================================================================== */
console.log("\n=== ⑧ 并发写：同进程 30 并发 + 4 个子进程并发 ===");
const CONCURRENT = 30;
await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => bus.share({
  groupId: groupA.id,
  key: `并发-${i}`,
  value: `同进程第 ${i} 条`,
  sourceProfileId: W1,
})));
const afterLocal = await bus.listItems({ groupId: groupA.id, limit: 200 });
const localItems = afterLocal.filter(item => item.key.startsWith("并发-"));
check(
  `同进程 ${CONCURRENT} 个并发写：条数正好 ${CONCURRENT}（不丢更新、不重复）`,
  localItems.length === CONCURRENT && new Set(localItems.map(item => item.key)).size === CONCURRENT,
  `写后条数=${localItems.length}，去重后 key 数=${new Set(localItems.map(item => item.key)).size}`,
);

const childWrites = await Promise.all([1, 2, 3, 4].map(n => runChild([
  "--child-write", busFile, groupA.id, W2, "5", `子进程${n}`,
])));
const childTotal = childWrites.reduce((sum, child) => sum + (child.result?.written ?? 0), 0);
const afterChildren = await bus.listItems({ groupId: groupA.id, limit: 200 });
const childItems = afterChildren.filter(item => item.key.startsWith("child-"));
check(
  "4 个子进程并发各写 5 条：20 条一条不少",
  childWrites.every(child => child.code === 0) && childTotal === 20 && childItems.length === 20,
  `子进程 pid=[${childWrites.map(child => child.result?.pid).join(", ")}] 各自 written=[${childWrites.map(child => child.result?.written).join(", ")}] → 磁盘上 child-* 共 ${childItems.length} 条`,
);
// 子进程失败时必须把它的 stderr 打出来 —— 否则只看到 written 是空的，
// 根本不知道它是为什么挂的（之前就是这样，白查了很久）。
for (const [i, child] of childWrites.entries()) {
  if (child.code === 0 && child.result) continue;
  console.log(`        [诊断] 子进程 #${i + 1} 退出码=${child.code}`);
  console.log(`        [诊断] stdout=${JSON.stringify(child.stdout.slice(0, 300))}`);
  console.log(`        [诊断] stderr=${JSON.stringify(child.stderr.slice(0, 600))}`);
}
const rawAfter = readFileSync(busFile, "utf8");
let parsedAfter = null;
let parseError = null;
try { parsedAfter = JSON.parse(rawAfter); } catch (error) { parseError = error; }
const statsAfter = await bus.stats();
check(
  "并发之后 JSON 依然合法，且磁盘条数 = 内存条数",
  parsedAfter !== null && parsedAfter.items.length === statsAfter.items,
  `磁盘 ${parsedAfter?.items?.length} 条 = stats ${statsAfter.items} 条；文件 ${statsAfter.fileSize}${parseError ? `（解析错误：${parseError.message}）` : ""}`,
);
const leftovers = readdirSync(tmpRoot).filter(name => name.includes(".tmp") || name.endsWith(".lock"));
check(
  "并发之后没有残留临时文件 / 锁文件（原子写收尾干净）",
  leftovers.length === 0,
  `临时目录内容：${readdirSync(tmpRoot).join(", ")}`,
);

/* ================================================================== *
 * ⑨ 上限
 * ================================================================== */
console.log("\n=== ⑨ 上限：超了要明确报错，不能静默丢弃 ===");
const beforeBig = (await bus.stats()).items;
let tooBig = null;
try {
  await bus.share({ groupId: groupA.id, key: "超大内容", value: "x".repeat(70 * 1024), sourceProfileId: W1 });
} catch (error) { tooBig = error; }
const afterBig = (await bus.stats()).items;
check(
  "70KB 的 value 被拒绝，且没有写进去",
  tooBig?.code === "value_too_large" && afterBig === beforeBig && /71680/.test(tooBig.message) && /65536/.test(tooBig.message),
  `code=${tooBig?.code}；报错：${tooBig?.message}`,
);
const boundaryOk = await bus.share({ groupId: groupA.id, key: "刚好 64KB", value: "y".repeat(64 * 1024), sourceProfileId: W1 });
check(
  "边界值（正好 64KB）允许写入",
  boundaryOk.bytes === 64 * 1024,
  `写入 ${boundaryOk.bytes} 字节，revision=${boundaryOk.revision}`,
);

// 每组条数 / 消息数上限：用带自定义 limits 的独立实例实测（不必真写 2000 条）
const smallFile = path.join(tmpRoot, "small-limit.json");
const small = new ContextBus({ file: smallFile, limits: { maxItemsPerGroup: 3, maxMessagesPerGroup: 2 } });
await small.initialize();
const smallGroup = await small.createGroup({ name: "小上限组", members: [W1] });
for (let i = 0; i < 3; i++) {
  await small.share({ groupId: smallGroup.id, key: `k${i}`, value: `v${i}`, sourceProfileId: W1 });
}
let groupFull = null;
try {
  await small.share({ groupId: smallGroup.id, key: "k4", value: "v4", sourceProfileId: W1 });
} catch (error) { groupFull = error; }
check(
  "每组条数上限：第 4 条被拒绝，报错里说清上限和处理办法",
  groupFull?.code === "group_full" && /上限 3/.test(groupFull.message) && /forget|prune/.test(groupFull.message),
  `code=${groupFull?.code}；报错：${groupFull?.message}`,
);
const updateAtCap = await small.share({ groupId: smallGroup.id, key: "k0", value: "v0-更新", sourceProfileId: W1 });
check(
  "到达上限后，同 key 的更新依然允许（更新不占新名额）",
  updateAtCap.revision === 2 && (await small.listItems({ groupId: smallGroup.id })).length === 3,
  `revision=${updateAtCap.revision}，条数仍为 3`,
);
await small.send({ groupId: smallGroup.id, from: W1, text: "1" });
await small.send({ groupId: smallGroup.id, from: W1, text: "2" });
let messageFull = null;
try {
  await small.send({ groupId: smallGroup.id, from: W1, text: "3" });
} catch (error) { messageFull = error; }
check(
  "每组消息数上限同样生效并明确报错",
  messageFull?.code === "group_full" && /上限 2/.test(messageFull.message),
  `code=${messageFull?.code}；报错：${messageFull?.message}`,
);
let noSelector = null;
try { await small.forget({ groupId: smallGroup.id }); } catch (error) { noSelector = error; }
check(
  "forget 不给 key/来源时拒绝（防止一次删光整组）",
  noSelector?.code === "need_selector",
  `code=${noSelector?.code}；报错：${noSelector?.message}`,
);
let tooManyTags = null;
try {
  await small.share({ groupId: smallGroup.id, key: "标签超限", value: "v", tags: Array.from({ length: 21 }, (_, i) => `t${i}`), sourceProfileId: W1 });
} catch (error) { tooManyTags = error; }
check("标签数量超限也被拒绝", tooManyTags?.code === "too_many_tags", `code=${tooManyTags?.code}；报错：${tooManyTags?.message}`);

// 整个文档体积上限：原子重写有性能天花板，超了必须拒绝而不是硬写
const docCapFile = path.join(tmpRoot, "doc-cap.json");
const docCap = new ContextBus({ file: docCapFile, limits: { maxDocBytes: 2048 } });
await docCap.initialize();
const docCapGroup = await docCap.createGroup({ name: "体积上限组", members: [W1] });
let docFull = null;
try {
  await docCap.share({ groupId: docCapGroup.id, key: "大块", value: "z".repeat(4 * 1024), sourceProfileId: W1 });
} catch (error) { docFull = error; }
const docCapAfter = await docCap.stats();
check(
  "整个文档体积上限：超了拒绝写入，且文档没被改动",
  docFull?.code === "bus_full" && docCapAfter.items === 0 && /prune|forget/.test(docFull.message),
  `code=${docFull?.code}；报错：${docFull?.message}`,
);
await docCap.dispose();
await small.dispose();

/* ================================================================== *
 * ⑩ 过期清理
 * ================================================================== */
console.log("\n=== ⑩ ttl 过期 + prune ===");
const ttlItem = await bus.share({
  groupId: groupA.id,
  key: "临时结论",
  value: "这条 60 毫秒后过期，应该自动消失",
  tags: ["临时"],
  sourceProfileId: W1,
  ttl: 60,
});
const ttlVisibleNow = await bus.recall({ groupId: groupA.id, query: "临时结论" });
check("带 ttl 的条目刚写完可见", ttlVisibleNow.length === 1, `命中 ${ttlVisibleNow.length} 条，expiresAt=${ttlVisibleNow[0]?.expiresAt}`);
await sleep(150);
const ttlVisibleLater = await bus.recall({ groupId: groupA.id, query: "临时结论" });
const ttlListed = (await bus.listItems({ groupId: groupA.id, limit: 200 })).some(item => item.id === ttlItem.id);
const expiredCount = (await bus.stats()).expiredItems;
check(
  "ttl 到点后读不到（惰性过期：不用等 prune 就不该命中）",
  ttlVisibleLater.length === 0 && !ttlListed && expiredCount >= 1,
  `recall 命中 ${ttlVisibleLater.length} 条、listItems 含它=${ttlListed}、stats.expiredItems=${expiredCount}`,
);
const pruned = await bus.prune();
const diskAfterPrune = JSON.parse(readFileSync(busFile, "utf8"));
check(
  "prune 之后磁盘上真的没有了",
  pruned.removedItems >= 1 && !diskAfterPrune.items.some(item => item.id === ttlItem.id),
  `prune 清掉 ${pruned.removedItems} 条；剩余 组=${pruned.remaining.groups} 条=${pruned.remaining.items} 消息=${pruned.remaining.messages}`,
);
const prunedAgain = await bus.prune();
check("再次 prune 没有可清的（幂等）", prunedAgain.removedItems === 0, `第二次清掉 ${prunedAgain.removedItems} 条`);

/* ================================================================== *
 * ⑭ 分组维护：updateGroup / getGroup / deleteGroup 级联删除
 * ================================================================== */
console.log("\n=== ⑭ 分组维护（界面层要用的那几条）===");
const groupC = await bus.createGroup({ name: "临时组", members: [W1], note: "原始备注" });
const updated = await bus.updateGroup(groupC.id, { name: "改过名的组", note: "新备注" });
check(
  "updateGroup 改得动 name / note",
  updated.name === "改过名的组" && updated.note === "新备注" && updated.id === groupC.id,
  `name=${updated.name} note=${updated.note}`,
);
const relinked = await bus.updateGroup(groupC.id, { members: [W1, W2] });
check("updateGroup 也能整表替换 members", relinked.members.length === 2, `members=[${relinked.members.join(", ")}]`);
const missingGroup = await bus.getGroup("g_notexist0000");
check("getGroup 对不存在的组返回 null（不抛错，界面好处理）", missingGroup === null, `返回 ${JSON.stringify(missingGroup)}`);
await bus.share({ groupId: groupC.id, key: "组内记忆", value: "删组时应该被连带删掉", sourceProfileId: W1 });
await bus.send({ groupId: groupC.id, from: W1, text: "组内消息，删组时也应该被连带删掉" });
const groupsBeforeDelete = (await bus.stats()).groups;
const deleted = await bus.deleteGroup(groupC.id);
const afterDelete = await bus.getGroup(groupC.id);
const statsAfterDelete = await bus.stats();
check(
  "deleteGroup 连同组内条目与消息一起删（单文件原子写，不留孤儿）",
  deleted.deleted === true && deleted.removedItems === 1 && deleted.removedMessages === 1
    && afterDelete === null && statsAfterDelete.groups === groupsBeforeDelete - 1,
  `删除结果=${JSON.stringify(deleted)}；组数 ${groupsBeforeDelete} → ${statsAfterDelete.groups}；组内记忆/消息都已清掉`,
);
const deleteAgain = await bus.deleteGroup(groupC.id);
check("重复 deleteGroup 幂等（deleted=false，不抛错）", deleteAgain.deleted === false, `返回 ${JSON.stringify(deleteAgain)}`);

/* ================================================================== *
 * ⑮ 附加：CJS 动态 import（Electron 主进程的调用方式）
 * ================================================================== */
console.log("\n=== ⑮ 附加：CJS 里 await import() 调 ESM（主进程是 CJS，必须能用）===");
const cjsProbe = [
  'const { pathToFileURL } = require("node:url");',
  "(async () => {",
  "  const moduleFile = process.argv[1];",
  "  const dataFile = process.argv[2];",
  "  const { ContextBus } = await import(pathToFileURL(moduleFile).href);",
  "  const bus = new ContextBus({ file: dataFile });",
  "  await bus.initialize();",
  "  const groups = await bus.listGroups();",
  "  const stats = await bus.stats();",
  "  await bus.dispose();",
  '  console.log("<<<RESULT " + JSON.stringify({ pid: process.pid, groups: groups.length, groupNames: groups.map(g => g.name), items: stats.items, file: stats.file }) + " RESULT>>>");',
  "})().catch((error) => { console.error(error); process.exit(1); });",
].join("\n");
const cjsResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["-e", cjsProbe, path.join(here, "core", "context-bus.js"), busFile], { cwd: here, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  child.on("close", code => {
    const match = /<<<RESULT (.*) RESULT>>>/.exec(stdout);
    let result = null;
    if (match) { try { result = JSON.parse(match[1]); } catch { /* 留给检查判 FAIL */ } }
    resolve({ code, stdout, stderr, result });
  });
});
check(
  "CJS（require + await import）能加载 core/context-bus.js 并正常调用 listGroups/stats",
  cjsResult.code === 0 && cjsResult.result?.groups === 2 && cjsResult.result?.items > 0,
  `子进程 pid=${cjsResult.result?.pid}，读到 ${cjsResult.result?.groups} 个组「${cjsResult.result?.groupNames?.join("、")}」/ ${cjsResult.result?.items} 条记忆；文件=${cjsResult.result?.file}${cjsResult.stderr ? `；stderr=${cjsResult.stderr.trim().slice(0, 200)}` : ""}`,
);

/* ================================================================== *
 * ⑫ 附加：容错（损坏文件 / 更高版本）
 * ================================================================== */
console.log("\n=== ⑫ 附加：容错 ===");
const brokenFile = path.join(tmpRoot, "broken.json");
writeFileSync(brokenFile, "{ 这不是 JSON", "utf8");
const brokenBus = new ContextBus({ file: brokenFile, log: (line) => console.log(`        [bus] ${line}`) });
await brokenBus.initialize();
const quarantined = readdirSync(tmpRoot).filter(name => name.startsWith("broken.json.corrupt-"));
const brokenGroup = await brokenBus.createGroup({ name: "损坏恢复组", members: [W1] });
await brokenBus.share({ groupId: brokenGroup.id, key: "恢复后写入", value: "总线依然可用", sourceProfileId: W1 });
check(
  "损坏的 json 被改名隔离（原始字节保留），总线从空文档继续可用",
  quarantined.length === 1 && existsSync(path.join(tmpRoot, quarantined[0])) && (await brokenBus.listItems({ groupId: brokenGroup.id })).length === 1,
  `隔离文件：${quarantined[0]}；隔离后写入读回 ${(await brokenBus.listItems({ groupId: brokenGroup.id })).length} 条`,
);
await brokenBus.dispose();

const futureFile = path.join(tmpRoot, "future.json");
writeFileSync(futureFile, JSON.stringify({ version: 99, groups: [], items: [], messages: [] }), "utf8");
const futureBus = new ContextBus({ file: futureFile });
let futureError = null;
try { await futureBus.initialize(); } catch (error) { futureError = error; }
check(
  "更高版本的数据文件被拒绝（不覆盖别人的数据）",
  futureError?.code === "version_mismatch" && JSON.parse(readFileSync(futureFile, "utf8")).version === 99,
  `code=${futureError?.code}；文件内容未被改动：version=${JSON.parse(readFileSync(futureFile, "utf8")).version}`,
);

/* ================================================================== *
 * ⑬ 附加：陈旧锁接管（持锁进程崩掉之后的恢复路径）
 * ================================================================== */
console.log("\n=== ⑬ 附加：陈旧锁自动接管 ===");
const staleLock = `${busFile}.lock`;
const staleAge = new Date(Date.now() - 90_000);
writeFileSync(staleLock, JSON.stringify({ pid: 999999, at: Date.now() - 90_000 }), "utf8");
utimesSync(staleLock, staleAge, staleAge);
const staleLogs = [];
const staleBus = new ContextBus({ file: busFile, log: (line) => staleLogs.push(line) });
await staleBus.initialize();
const staleWrite = await staleBus.share({ groupId: groupA.id, key: "陈旧锁之后写入", value: "锁被接管后依然能写", sourceProfileId: W1 });
check(
  "90 秒没动过的锁文件被判定为陈旧并接管，写入照常成功",
  staleWrite.revision === 1 && staleLogs.some(line => line.includes("陈旧")),
  `写入成功（id=${staleWrite.id}）；日志：${staleLogs.find(line => line.includes("陈旧")) ?? "（没有接管日志！）"}`,
);
check(
  "接管之后锁文件被释放（没有残留）",
  !existsSync(staleLock),
  `锁文件还存在=${existsSync(staleLock)}`,
);
await staleBus.dispose();

/* ================================================================== *
 * ⑪ 真实 MCP 协议
 * ================================================================== */
console.log("\n=== ⑪ 真实 MCP 协议：起 Bridge，用 tools/call 调共享上下文工具 ===");
const dataHome = path.join(tmpRoot, "mcp-data");
mkdirSync(dataHome, { recursive: true });
const { boot } = await import("./standalone.js");
const bridgeLogs = [];
const app = await boot({
  roots: [tmpRoot],
  dataHome,
  workspace: { id: "selftest", name: "context-bus-selftest", kind: "folder", uri: tmpRoot, folders: [tmpRoot] },
  // 自检的 MCP 客户端按 JSON 读响应体，测的不是传输方式；默认已改成 SSE，这里显式要 JSON
  options: { jsonResponse: true },
  onLog: (event) => { if (event.kind !== "request") bridgeLogs.push(`[${event.kind}] ${event.text ?? JSON.stringify(event)}`); },
});
const url = app.server.localUrl;

/** 最小 MCP 客户端：走 Bridge 的真实 HTTP 端点，和外部 Agent 同一条路。 */
function mcpClient(endpoint) {
  let sessionId = null;
  let id = 0;
  const post = async (method, params) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!sessionId) sessionId = response.headers.get("mcp-session-id");
    const body = await response.json();
    if (body.error) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    initialize: () => post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "context-bus-selftest", version: "1" } }),
    listTools: async () => (await post("tools/list", {}))?.tools ?? [],
    call: (name, args) => post("tools/call", { name, arguments: args ?? {} }),
    text: (result) => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "",
  };
}

const client = mcpClient(url);
await client.initialize();
const tools = await client.listTools();
const contextNames = tools.filter(tool => tool.name.startsWith("context_") || tool.name.startsWith("agent_")).map(tool => tool.name);
check(
  "tools/list 里出现 13 个共享上下文工具",
  contextNames.length === 13,
  `工具清单：${contextNames.join(", ")}`,
);
check(
  "boot() 的 status 里报告了总线状态（界面层可直接用）",
  app.status.contextReady === true && app.status.contextTools === 13 && app.status.contextFile === path.join(dataHome, "context-bus.json"),
  `contextReady=${app.status.contextReady} contextTools=${app.status.contextTools} contextFile=${app.status.contextFile}`,
);

const created = await client.call("context_group_create", { name: "MCP 实测组", members: [W1] });
const mcpGroupId = created.structuredContent?.group?.id;
const linkedMcp = await client.call("context_group_link", { groupId: mcpGroupId, profileIds: [W2] });
check(
  "context_group_create / context_group_link 通过 MCP 生效",
  !created.isError && Boolean(mcpGroupId) && !linkedMcp.isError && linkedMcp.structuredContent?.group?.members?.length === 2,
  `groupId=${mcpGroupId}；link 后成员=[${linkedMcp.structuredContent?.group?.members?.join(", ")}]`,
);

const noIdentity = await client.call("context_share", { groupId: mcpGroupId, key: "无身份", value: "x" });
check(
  "不传 profileId 且没有任何身份来源 → 明确报错并给出解决办法",
  noIdentity.isError && /profileId/.test(client.text(noIdentity)) && /BRIDGE_PROFILE_ID/.test(client.text(noIdentity)),
  `isError=${noIdentity.isError}；返回：${client.text(noIdentity).split("\n").slice(0, 2).join(" / ")}`,
);

const shared = await client.call("context_share", {
  groupId: mcpGroupId,
  key: "验证码位置",
  value: "验证码在 iframe #captcha-frame 里，等 1.5 秒才出现",
  tags: ["坑", "站点:example.com"],
  profileId: W1,
});
check(
  "context_share 写入成功（显式 profileId）",
  !shared.isError && shared.structuredContent?.item?.key === "验证码位置" && shared.structuredContent?.profileId === W1,
  `返回：${client.text(shared).split("\n")[0]}`,
);

const recalled = await client.call("context_recall", { groupId: mcpGroupId, query: "captcha-frame", profileId: W2 });
check(
  "context_recall 读回刚写的内容（W2 身份）",
  !recalled.isError && recalled.structuredContent?.count === 1 && /iframe/.test(client.text(recalled)),
  `count=${recalled.structuredContent?.count}；文本首行：${client.text(recalled).split("\n")[0]}`,
);

const implicit = await client.call("context_share", { groupId: mcpGroupId, key: "隐式身份", value: "这条靠会话绑定写入（同会话里之前显式传过 profileId）" });
check(
  "同一会话内省略 profileId → 复用上次显式指定的窗口（会话绑定兜底）",
  !implicit.isError && implicit.structuredContent?.profileId === W1 && implicit.structuredContent?.resolvedFrom.includes("会话"),
  `身份判定=${implicit.structuredContent?.resolvedFrom} profileId=${implicit.structuredContent?.profileId}`,
);

await app.contextBus.setActiveProfile(W2);
const client2 = mcpClient(url);
await client2.initialize();
const viaActive = await client2.call("context_share", { groupId: mcpGroupId, key: "活跃窗口兜底", value: "界面切窗口后，新会话靠「最近活跃窗口」确定身份" });
check(
  "新会话 + 总线记录的最近活跃窗口 → 也能确定身份（界面切窗口那条路）",
  !viaActive.isError && viaActive.structuredContent?.profileId === W2 && viaActive.structuredContent?.resolvedFrom.includes("活跃"),
  `身份判定=${viaActive.structuredContent?.resolvedFrom} profileId=${viaActive.structuredContent?.profileId}`,
);

const inboxCall = await client.call("agent_send", { groupId: mcpGroupId, text: "广播：共享记忆已经能用了", profileId: W1 });
const inboxRead = await client2.call("agent_inbox", { profileId: W2, unreadOnly: true });
check(
  "agent_send / agent_inbox 走通（广播 + 未读过滤）",
  !inboxCall.isError && !inboxRead.isError && inboxRead.structuredContent?.messages?.some(m => m.from === W1),
  `agent_inbox 返回 ${inboxRead.structuredContent?.messages?.length} 条：${inboxRead.structuredContent?.messages?.map(m => m.text).join(" | ")}`,
);

check(
  "agent_inbox 每条消息都带 untrusted=true 与 from，并返回 unreadCount（读不自动标已读）",
  !inboxRead.isError &&
    inboxRead.structuredContent?.messages?.length > 0 &&
    inboxRead.structuredContent.messages.every(m => m.untrusted === true && typeof m.from === "string") &&
    typeof inboxRead.structuredContent.unreadCount === "number" &&
    inboxRead.structuredContent.unreadCount >= 1,
  `untrusted=${inboxRead.structuredContent?.messages?.map(m => m.untrusted).join(",")}；` +
  `unreadCount=${inboxRead.structuredContent?.unreadCount}；from=${inboxRead.structuredContent?.messages?.map(m => m.from).join(",")}`,
);

const taskSent = await client.call("agent_send", {
  groupId: mcpGroupId,
  to: W2,
  kind: "task",
  text: "核对订单页二次确认弹窗，结果写进 logs/order-confirm.txt",
  profileId: W1,
  dedupeKey: "selftest-task-order-confirm",
});
const taskId = taskSent.structuredContent?.messageId;
const taskWaiting = await client2.call("agent_task_update", {
  profileId: W2, taskId, status: "input_required", result: "卡在验证码，见 logs/step1.txt",
});
const taskDone = await client2.call("agent_task_update", {
  profileId: W2, taskId, status: "completed", result: "logs/order-confirm.txt",
});
const taskList = await client.call("agent_task_list", { profileId: W1, taskId });
check(
  "子代理任务：派活 → 接收方 input_required → completed → 发送方查到结果引用",
  !taskSent.isError && !taskWaiting.isError && !taskDone.isError && !taskList.isError &&
    taskSent.structuredContent?.message?.status === "working" &&
    taskWaiting.structuredContent?.status === "input_required" &&
    taskList.structuredContent?.tasks?.[0]?.status === "completed" &&
    taskList.structuredContent.tasks[0].result === "logs/order-confirm.txt",
  `taskId=${taskId}；最终状态=${taskList.structuredContent?.tasks?.[0]?.status}；` +
  `结果=${taskList.structuredContent?.tasks?.[0]?.result}`,
);

const taskRewind = await client2.call("agent_task_update", { profileId: W2, taskId, status: "working" });
check(
  "任务终态回退被拒（BAD_TRANSITION）",
  taskRewind.isError && /BAD_TRANSITION/.test(client.text(taskRewind)),
  `isError=${taskRewind.isError}；返回：${client.text(taskRewind).split("\n")[0]}`,
);

const taskResend = await client.call("agent_send", {
  groupId: mcpGroupId,
  to: W2,
  kind: "task",
  text: "核对订单页二次确认弹窗，结果写进 logs/order-confirm.txt",
  profileId: W1,
  dedupeKey: "selftest-task-order-confirm",
});
check(
  "10 分钟内同一 dedupeKey 重复发送 → 返回原 messageId，不重复入队",
  !taskResend.isError && taskResend.structuredContent?.messageId === taskId && taskResend.structuredContent?.deduplicated === true,
  `messageId=${taskResend.structuredContent?.messageId}（原 ${taskId}）deduplicated=${taskResend.structuredContent?.deduplicated}`,
);

const statsCall = await client.call("context_stats", {});
check(
  "context_stats 报告组数 / 条数 / 文件大小",
  !statsCall.isError && statsCall.structuredContent?.stats?.groups === 1 && statsCall.structuredContent?.stats?.items === 3 && statsCall.structuredContent?.stats?.fileBytes > 0,
  `组=${statsCall.structuredContent?.stats?.groups} 条=${statsCall.structuredContent?.stats?.items} 消息=${statsCall.structuredContent?.stats?.messages} 文件=${statsCall.structuredContent?.stats?.fileSize}`,
);

const mcpBusFile = path.join(dataHome, "context-bus.json");
await app.stop();
const reopened = new ContextBus({ file: mcpBusFile });
const persisted = await reopened.listItems({ groupId: mcpGroupId, limit: 50 });
check(
  "app.stop() 之后数据仍在磁盘上（工具写的确实落盘了）",
  existsSync(mcpBusFile) && persisted.length === 3,
  `文件 ${mcpBusFile} 存在=${existsSync(mcpBusFile)}，读回 ${persisted.length} 条：${persisted.map(item => item.key).join(", ")}`,
);
let afterDispose = null;
try { await app.contextBus.stats(); } catch (error) { afterDispose = error; }
check(
  "dispose 之后再用会明确报错（不是静默成功）",
  afterDispose?.code === "disposed",
  `code=${afterDispose?.code}；报错：${afterDispose?.message}`,
);
await reopened.dispose();

console.log("\n  Bridge 侧日志（节选）：");
for (const line of bridgeLogs.filter(line => line.includes("context")).slice(0, 8)) console.log(`        ${line}`);

/* ================================================================== *
 * 汇总
 * ================================================================== */
await bus.dispose();

const passed = results.filter(row => row.ok).length;
const failed = results.filter(row => !row.ok);
console.log(`\n================ 汇总 ================`);
// 「通过 N/M」这一行的格式是硬约定：tools/run-all-checks.mjs 用它判定这一项过没过
console.log(`通过 ${passed}/${results.length}`);
console.log(`检查项：${results.length} 个，通过 ${passed} 个，失败 ${failed.length} 个`);
if (failed.length) {
  console.log(`\n失败明细：`);
  for (const row of failed) console.log(`  ✗ ${row.name}\n      ${row.detail}`);
}
console.log(`\n数据文件（可直接打开看）：${busFile}`);
console.log(`临时目录：${tmpRoot}`);
process.exit(failed.length ? 1 : 0);
