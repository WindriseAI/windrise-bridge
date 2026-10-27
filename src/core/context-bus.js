/**
 * 共享上下文总线（Context Bus）—— 让「链接成一组」的多个浏览器窗口共享记忆。
 *
 * 一句话：A 窗口的 Agent 踩过的坑写进总线，同组的 B 窗口直接读到，不用重踩。
 * 任务进度、发现、结论都能互相看见；还能互相发消息。
 *
 * ★ 这不是共享登录态。★
 *   各窗口的 Cookie / localStorage / IndexedDB / 存储分区（persist:profile-<id>）完全不动。
 *   共享的只是「记忆」——一段本地 JSON，跟浏览器身份没有任何关系，不会导致互相踢下线。
 *
 * ── 存储设计：为什么是**一个**文件 ──
 *   默认 ~/.bridge-replica/context-bus.json（可用构造参数 file 覆盖；界面层传的就是这个路径）。
 *   拆成多文件（groups.json / items-<groupId>.json / messages.json）看起来更"可扩展"，
 *   但会带来三个真问题，而收益在我们这个体量下是零：
 *     ① 跨实体不变量会变成非原子：删一个组要同时删组内条目与消息，拆文件后中途失败就留下孤儿数据；
 *     ② 一把锁变成多把锁，多个窗口同时写不同组时反而更容易踩到死锁/顺序问题；
 *     ③ 多文件各自的原子写无法组成一个"整体一致"的视图，读到半更新状态的概率反而升高。
 *   单文件 + 一次原子替换 = 所有不变量天生原子。代价是每次写都要重写整个文档，
 *   所以配了体积上限（见 LIMITS.maxDocBytes），超了**明确报错**而不是悄悄丢数据。
 *   真到了几十 MB 的规模，正确做法是换 SQLite，而不是拆 JSON——那是另一件事。
 *
 * ── 写入纪律（对齐项目里已有的做法）──
 *   · 原子写：临时文件（wx, 0600）+ fsync + rename（同 core/workspace.js 的 atomicWrite、
 *     core/external-mcp.js 的 atomicWriteJson）。读者永远不会看到半个 json。
 *   · 文件权限 0600（POSIX 上生效；Windows 上 mode 基本是 no-op，靠用户目录 ACL 兜底）。
 *   · 跨进程互斥：独占创建锁文件 + 陈旧回收（同 core/workspace.js 的 withLock）。
 *   · 进程内串行化：一个 promise 队列，保证同一进程内的并发调用不会互相抢锁/丢更新。
 *   · 上限：单条 value 64KB、每组 2000 条、消息 16KB……超了一律抛错（error.code 可编程判断）。
 *
 * ── 踩过的坑（写在这里省得下次再踩）──
 *   ① 「读-改-写」必须在锁**里面**完成。先读后拿锁 = 两个窗口同时写时后写者覆盖先写者（丢更新）。
 *   ② 锁文件被判"陈旧"而接管的前提是：临界区只做内存计算 + 一次原子写，毫秒级完成。
 *      所以 staleMs(30s) 远大于临界区耗时；如果以后往临界区里塞慢操作，必须同时改这里。
 *   ③ 文件损坏时**不要**直接删：改名隔离（.corrupt-<时间戳>）并记日志，数据还在，人能去捞。
 *   ④ 过期条目要在「读」的时候就当它不存在（惰性过滤），不能只靠 prune——否则 prune 之前
 *      过期数据依然会被 recall 命中，语义就错了。
 *   ⑤ Windows 上 rename 覆盖已存在文件是原子的（MoveFileEx 语义），不需要先 unlink；
 *      先 unlink 再 rename 反而会出现"文件短暂不存在"的窗口，被并发读者看到空文档。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 数据格式版本。读到更高版本会**拒绝启动**而不是覆盖（别毁掉新版本写的文件）。 */
export const CONTEXT_BUS_VERSION = 1;

/**
 * 默认上限。超限一律抛错，绝不静默截断/丢弃。
 * 构造参数 limits 可以覆盖（自检用它把「每组条数上限」压到很小来实测，不必真写 2000 条）。
 */
export const LIMITS = Object.freeze({
  maxValueBytes: 64 * 1024,          // 单条 value：64KB（按 UTF-8 字节算）
  maxKeyChars: 200,                  // key 长度
  maxTagChars: 64,                   // 单个标签长度
  maxTags: 20,                       // 每条最多几个标签
  maxItemsPerGroup: 2000,            // 每组最多多少条记忆
  maxMessagesPerGroup: 2000,         // 每组最多多少条消息
  maxMessageChars: 16 * 1024,        // 单条消息 16KB
  maxGroups: 200,                    // 最多多少个分组
  maxDocBytes: 32 * 1024 * 1024,     // 整个文档 32MB：原子重写的性能天花板
  maxLimit: 200,                     // 单次查询返回条数上限

  /* ── 子代理互发消息的刹车（数值参考 Claude Code 跨会话与 MCP Tasks 的公开语义）── */
  dedupeWindowMs: 10 * 60 * 1000,    // 同一发送方 + 同一 key，10 分钟内重复发送直接返回原 messageId
  maxDedupeKeyChars: 200,            // 显式 dedupeKey 长度上限
  rateLimitPerMinute: 20,            // 每个发送方每分钟最多 20 条
  maxUnreadPerInbox: 50,             // 每个收件箱未读上限，超了 INBOX_FULL
  maxTaskResultChars: 2000,          // 任务结果只放引用（路径/短摘要），2000 字上限
  taskTtlMs: 12 * 60 * 60 * 1000,    // 12 小时没做完的任务惰性标记为 cancelled（reason=ttl）
});

/** 任务状态机（与 MCP Tasks 同名）。终态不能再转出去，只允许同状态幂等重试。 */
export const TASK_STATUSES = Object.freeze(["working", "input_required", "completed", "failed", "cancelled"]);
export const TASK_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
export const TASK_TRANSITIONS = Object.freeze({
  working: ["input_required", "completed", "failed", "cancelled"],
  input_required: ["working", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
});

/** profileId / groupId 允许的字符：字母数字加 `_ . : @ -`，1~64 字符（窗口 id 是 8 位 hex）。 */
const ID_RE = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** 默认文件位置：与 standalone.js 的 dataHome 约定一致（~/.bridge-replica）。 */
export function defaultContextBusFile(env = process.env, home = os.homedir()) {
  const explicit = env.BRIDGE_DATA_HOME?.trim();
  const base = explicit ? path.resolve(explicit) : path.join(home, ".bridge-replica");
  return path.join(base, "context-bus.json");
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 带错误码的异常：调用方（工具层/界面层）可以按 code 分支，而不是去匹配中文字符串。 */
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 时间戳：数字（毫秒）或 ISO 字符串都收，其余抛错。 */
function toTimestamp(value, what) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("bad_timestamp", `${what} 不是合法时间戳：${value}`);
    return value;
  }
  // 纯数字字符串当毫秒时间戳（有些 MCP 客户端把数字都序列化成字符串）
  const text = String(value).trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw fail("bad_timestamp", `${what} 不是合法时间（要毫秒时间戳或 ISO 字符串）：${value}`);
  return parsed;
}

function checkId(value, what) {
  const id = String(value ?? "").trim();
  if (!ID_RE.test(id)) {
    throw fail("bad_id", `${what} 不合法：${JSON.stringify(String(value ?? ""))}。只允许字母数字和 _ . : @ -，长度 1~64。`);
  }
  return id;
}

/** 惰性过期：ttl 到点之后，读的时候就当它不存在（不能等 prune 才失效）。 */
function isExpired(item, now = Date.now()) {
  return typeof item.expiresAt === "number" && item.expiresAt <= now;
}

/**
 * 内容去重键。显式 dedupeKey 和自动内容哈希用不同前缀（k: / h:），
 * 避免某个 Agent 恰好把 64 位哈希当 dedupeKey 传进来时和自动键撞上。
 * 这不是安全机制（不做密钥用途），只是稳定、无碰撞的 128 位十六进制串。
 */
function contentHash(parts) {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

export class ContextBus {
  /**
   * @param {object} [options]
   * @param {string} [options.file]  数据文件路径，默认 ~/.bridge-replica/context-bus.json
   * @param {(line: string) => void} [options.log] 日志回调（界面层会把它接到日志面板）
   * @param {object} [options.limits] 覆盖 LIMITS（自检用；生产别动）
   */
  constructor({ file, log, limits } = {}) {
    this.file = path.resolve(file ?? defaultContextBusFile());
    this.log = typeof log === "function" ? log : () => {};
    this.limits = { ...LIMITS, ...(limits ?? {}) };

    // 锁参数：临界区是毫秒级的，30 秒的"陈旧"阈值远超临界区，不会被误接管。
    this.lockStaleMs = 30_000;
    this.lockTimeoutMs = 20_000;
    this.lockRetryMs = 12;

    this.#queue = Promise.resolve();
    this.#ready = null;
    this.#disposed = false;
  }

  #queue;
  #ready;
  #disposed;

  /* ================================================================== *
   * 生命周期
   * ================================================================== */

  /**
   * 建目录 + 体检已有文件。幂等；所有对外方法也会惰性调用它（忘了 initialize 也不会崩）。
   * 文件损坏时**改名隔离**（保留原始字节）并记日志，而不是删掉或直接抛错让界面永远不可用。
   */
  async initialize() {
    if (this.#disposed) throw fail("disposed", "共享上下文总线已关闭（dispose 之后不能再用）。");
    if (!this.#ready) this.#ready = this.#initOnce();
    return this.#ready;
  }

  async #initOnce() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const raw = await readFile(this.file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw === null) return { created: false };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 损坏：改名隔离，让总线还能用，同时人还能把原始字节捞回去。
      const quarantine = `${this.file}.corrupt-${Date.now()}`;
      await rename(this.file, quarantine).catch(() => {});
      this.log(`[context-bus] 数据文件不是合法 JSON（${error.message}），已改名隔离到 ${quarantine}，总线从空文档继续。`);
      return { created: false, quarantined: quarantine };
    }
    if (parsed?.version !== undefined && parsed.version !== CONTEXT_BUS_VERSION) {
      // 更高版本：不覆盖、不隔离，直接拒绝——这是别人的数据，别毁。
      throw fail("version_mismatch", `共享上下文文件版本是 ${parsed.version}，本程序只认识 ${CONTEXT_BUS_VERSION}。文件：${this.file}`);
    }
    return { created: false, groups: Array.isArray(parsed?.groups) ? parsed.groups.length : 0 };
  }

  /**
   * 关掉总线：等队列里排着的写全部落盘，之后所有方法直接报错。
   * 幂等；standalone.js / 主进程 stop() 会调它。
   */
  async dispose() {
    if (this.#disposed) return;
    await this.#queue.catch(() => {});
    this.#disposed = true;
  }

  /* ================================================================== *
   * 分组
   * ================================================================== */

  /** 建分组。name 为空时自动起名（界面层点「新建」时可能还没输入）。 */
  async createGroup({ name, members = [], note = "", id } = {}) {
    return this.#mutate((doc) => {
      if (doc.groups.length >= this.limits.maxGroups) {
        throw fail("too_many_groups", `分组数量已达上限 ${this.limits.maxGroups} 个，不能再建。可以先删掉不用的分组（deleteGroup）。`);
      }
      const group = {
        id: id ? checkId(id, "分组 id") : `g_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        name: String(name ?? "").trim().slice(0, 120) || `分组 ${doc.groups.length + 1}`,
        note: String(note ?? "").slice(0, 2000),
        members: this.#cleanMembers(members),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (doc.groups.some(g => g.id === group.id)) throw fail("duplicate_group", `分组 id 已存在：${group.id}`);
      doc.groups.push(group);
      return this.#cloneGroup(group);
    }, "创建分组");
  }

  /** 全部分组（按创建时间倒序：新的在前，界面列表更直观）。 */
  async listGroups() {
    const doc = await this.#read();
    return [...doc.groups].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).map(g => this.#cloneGroup(g));
  }

  /** 取一个分组；不存在返回 null（不是抛错——界面"打开详情"时更省事）。 */
  async getGroup(id) {
    const groupId = checkId(id, "分组 id");
    const doc = await this.#read();
    const group = doc.groups.find(g => g.id === groupId);
    return group ? this.#cloneGroup(group) : null;
  }

  /** 改 name / note / members（members 是整表替换；只传要改的字段）。 */
  async updateGroup(id, patch = {}) {
    const groupId = checkId(id, "分组 id");
    return this.#mutate((doc) => {
      const group = doc.groups.find(g => g.id === groupId);
      if (!group) throw fail("no_such_group", `没有这个分组：${groupId}`);
      if (patch.name !== undefined) group.name = String(patch.name ?? "").trim().slice(0, 120) || group.name;
      if (patch.note !== undefined) group.note = String(patch.note ?? "").slice(0, 2000);
      if (patch.members !== undefined) group.members = this.#cleanMembers(patch.members);
      group.updatedAt = Date.now();
      return this.#cloneGroup(group);
    }, "更新分组");
  }

  /** 删分组：组内条目和消息一并删除（单文件原子写，不存在删一半的中间态）。 */
  async deleteGroup(id) {
    const groupId = checkId(id, "分组 id");
    return this.#mutate((doc) => {
      const index = doc.groups.findIndex(g => g.id === groupId);
      if (index < 0) return { id: groupId, deleted: false, removedItems: 0, removedMessages: 0 };
      doc.groups.splice(index, 1);
      const before = doc.items.length;
      doc.items = doc.items.filter(item => item.groupId !== groupId);
      const removedItems = before - doc.items.length;
      const messagesBefore = doc.messages.length;
      doc.messages = doc.messages.filter(message => message.groupId !== groupId);
      const removedMessages = messagesBefore - doc.messages.length;
      this.log(`[context-bus] 已删除分组 ${groupId}（连带 ${removedItems} 条记忆、${removedMessages} 条消息）`);
      return { id: groupId, deleted: true, removedItems, removedMessages };
    }, "删除分组");
  }

  /** 把窗口加进组（去重；已在组里的会被跳过并如实报告）。 */
  async link(groupId, profileIds = []) {
    const id = checkId(groupId, "分组 id");
    const incoming = this.#cleanMembers(profileIds);
    return this.#mutate((doc) => {
      const group = doc.groups.find(g => g.id === id);
      if (!group) throw fail("no_such_group", `没有这个分组：${id}`);
      const added = incoming.filter(pid => !group.members.includes(pid));
      const already = incoming.filter(pid => group.members.includes(pid));
      group.members.push(...added);
      group.updatedAt = Date.now();
      return { group: this.#cloneGroup(group), added, already };
    }, "链接窗口");
  }

  /** 把窗口移出组（成员不在组里也照常返回，不报错）。 */
  async unlink(groupId, profileIds = []) {
    const id = checkId(groupId, "分组 id");
    const incoming = this.#cleanMembers(profileIds);
    return this.#mutate((doc) => {
      const group = doc.groups.find(g => g.id === id);
      if (!group) throw fail("no_such_group", `没有这个分组：${id}`);
      const removed = group.members.filter(pid => incoming.includes(pid));
      const missing = incoming.filter(pid => !group.members.includes(pid));
      group.members = group.members.filter(pid => !incoming.includes(pid));
      group.updatedAt = Date.now();
      return { group: this.#cloneGroup(group), removed, missing };
    }, "取消链接");
  }

  /** 某窗口属于哪些分组（返回完整分组对象数组，界面/工具都直接用）。 */
  async groupsFor(profileId) {
    const pid = checkId(profileId, "窗口 id");
    const doc = await this.#read();
    return doc.groups.filter(g => g.members.includes(pid))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(g => this.#cloneGroup(g));
  }

  /* ================================================================== *
   * 记忆条目
   * ================================================================== */

  /**
   * 写一条共享记忆。
   * 覆盖规则：同一个 (groupId, sourceProfileId, key) 就是**更新**（保留 id，value/tags/ttl 换新，
   * revision+1），不会堆积——这正是「同 key 同来源就更新」的落点。
   * key 省略 = 每次都新建一条（没有覆盖坐标，只能堆积）。
   */
  async share({ groupId, key, value, tags = [], sourceProfileId, profileId, ttl } = {}) {
    const id = checkId(groupId, "分组 id");
    // sourceProfileId 是契约字段；profileId 只是宽容别名（界面层偶尔会顺手写成 profileId）
    const source = checkId(sourceProfileId ?? profileId, "写入方窗口 id（sourceProfileId）");
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.limits.maxValueBytes) {
      throw fail("value_too_large",
        `单条记忆的 value 超限：${bytes} 字节 > 上限 ${this.limits.maxValueBytes} 字节（${humanBytes(this.limits.maxValueBytes)}）。` +
        ` 请拆分后再写（比如分成多条 key），或把大内容放到文件里、这里只存路径与摘要。`);
    }
    const itemKey = key === undefined || key === null ? "" : String(key).trim();
    if (itemKey.length > this.limits.maxKeyChars) {
      throw fail("key_too_long", `key 太长：${itemKey.length} 字符 > 上限 ${this.limits.maxKeyChars}。`);
    }
    const cleanTags = this.#cleanTags(tags);
    const ttlMs = ttl === undefined || ttl === null ? null : Number(ttl);
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw fail("bad_ttl", `ttl 必须是正数（毫秒），收到：${JSON.stringify(ttl)}。省略 ttl = 永不过期。`);
    }

    return this.#mutate((doc) => {
      const group = doc.groups.find(g => g.id === id);
      if (!group) throw fail("no_such_group", `没有这个分组：${id}。先 createGroup，或者用 listGroups 看看有哪些组。`);
      // 归属校验：不拦着就会往自己没加入的组里写，同组的人莫名其妙看到陌生来源的数据。
      if (!group.members.includes(source)) {
        throw fail("not_a_member",
          `窗口 ${source} 不在分组 ${group.name}（${id}）里，不能往这个组写记忆。` +
          ` 先 link 把窗口加进组（成员：${group.members.join(", ") || "（空）"}）。`);
      }

      const now = Date.now();
      const existing = itemKey
        ? doc.items.find(item => item.groupId === id && item.sourceProfileId === source && item.key === itemKey)
        : null;

      if (existing) {
        existing.value = text;
        existing.tags = cleanTags;
        existing.at = now;
        existing.ttl = ttlMs;
        existing.expiresAt = ttlMs === null ? null : now + ttlMs;
        existing.bytes = bytes;
        existing.revision = (existing.revision ?? 1) + 1;
        return { ...existing, tags: [...existing.tags] };
      }

      const live = doc.items.filter(item => item.groupId === id && !isExpired(item, now));
      if (live.length >= this.limits.maxItemsPerGroup) {
        throw fail("group_full",
          `分组「${group.name}」已有 ${live.length} 条记忆，达到上限 ${this.limits.maxItemsPerGroup} 条，写不进去了。` +
          ` 处理办法：用 context_forget 删掉没用的旧 key，或先 prune() 清掉带 ttl 的过期条目。`);
      }

      const item = {
        id: `i_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        groupId: id,
        key: itemKey,
        value: text,
        tags: cleanTags,
        sourceProfileId: source,
        at: now,
        createdAt: now,
        ttl: ttlMs,
        expiresAt: ttlMs === null ? null : now + ttlMs,
        bytes,
        revision: 1,
      };
      doc.items.push(item);
      return { ...item, tags: [...item.tags] };
    }, "写入记忆");
  }

  /**
   * 检索共享记忆。三种匹配可以叠加（同时给 = 都要满足）：
   *   · query：在 key / value / tags 里做**大小写不敏感**的子串匹配
   *   · tags ：命中任意一个标签即算命中（OR 语义）
   *   · since：只要 at >= since 的
   * groupId 省略时，按 profileId 在「我加入的所有组」里搜（工具层的便利；界面层一般直接给 groupId）。
   * 返回数组，按时间倒序（新的在前）。过期条目在读的时候就当它不存在。
   */
  async recall({ groupId, query, tags, limit = 20, since, profileId } = {}) {
    const doc = await this.#read();
    const now = Date.now();
    let scope;
    if (groupId !== undefined && groupId !== null && groupId !== "") {
      const id = checkId(groupId, "分组 id");
      // 带了 profileId 就校验成员身份：不在组里的窗口读不到别组的记忆
      if (profileId !== undefined && profileId !== null && profileId !== "") {
        const g = doc.groups.find(x => x.id === id);
        if (!g || !g.members.includes(String(profileId))) return [];
      }
      scope = [id];
    } else {
      const pid = checkId(profileId, "窗口 id（省略 groupId 时必须给，用来确定「我加入的组」）");
      scope = doc.groups.filter(g => g.members.includes(pid)).map(g => g.id);
    }
    const needle = query === undefined || query === null ? null : String(query).toLowerCase();
    const wantedTags = tags === undefined || tags === null ? [] : this.#cleanTags(tags);
    const sinceAt = toTimestamp(since, "since");
    const max = Math.max(1, Math.min(Number(limit) || 20, this.limits.maxLimit));

    const hits = [];
    for (const item of doc.items) {
      if (!scope.includes(item.groupId)) continue;
      if (isExpired(item, now)) continue;
      if (sinceAt !== null && (item.at ?? 0) < sinceAt) continue;
      if (wantedTags.length && !wantedTags.some(tag => item.tags.includes(tag))) continue;
      const matchedIn = [];
      if (needle !== null) {
        if (item.key.toLowerCase().includes(needle)) matchedIn.push("key");
        if (item.value.toLowerCase().includes(needle)) matchedIn.push("value");
        if (item.tags.some(tag => tag.toLowerCase().includes(needle))) matchedIn.push("tags");
        if (!matchedIn.length) continue;
      }
      hits.push({ ...item, tags: [...item.tags], matchedIn });
    }
    hits.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return hits.slice(0, max);
  }

  /**
   * 删一条记忆。
   * 至少要给 key 或 sourceProfileId 之一（防手滑：只给 groupId 会一次删光整组）。
   *   · 只给 key            → 删该组里所有来源的这个 key
   *   · 只给 sourceProfileId → 删该来源在该组写的全部条目
   *   · 两个都给            → 精确删一条
   * 返回 { removed, ids }。
   */
  async forget({ groupId, key, sourceProfileId } = {}) {
    const id = checkId(groupId, "分组 id");
    const hasKey = key !== undefined && key !== null && String(key).trim() !== "";
    const itemKey = hasKey ? String(key).trim() : null;
    const hasSource = sourceProfileId !== undefined && sourceProfileId !== null && String(sourceProfileId).trim() !== "";
    const source = hasSource ? checkId(sourceProfileId, "窗口 id（sourceProfileId）") : null;
    if (!hasKey && !hasSource) {
      throw fail("need_selector", "forget 至少要给 key 或 sourceProfileId 之一，否则等于清空整组——那太危险了。");
    }
    return this.#mutate((doc) => {
      const before = doc.items.length;
      const removedIds = [];
      doc.items = doc.items.filter((item) => {
        const hit = item.groupId === id
          && (itemKey === null || item.key === itemKey)
          && (source === null || item.sourceProfileId === source);
        if (hit) removedIds.push(item.id);
        return !hit;
      });
      return { removed: before - doc.items.length, ids: removedIds };
    }, "删除记忆");
  }

  /** 列某组的全部记忆（不含过期），时间倒序。 */
  async listItems({ groupId, limit = 100 } = {}) {
    const id = checkId(groupId, "分组 id");
    const doc = await this.#read();
    const now = Date.now();
    const max = Math.max(1, Math.min(Number(limit) || 100, this.limits.maxLimit));
    return doc.items
      .filter(item => item.groupId === id && !isExpired(item, now))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, max)
      .map(item => ({ ...item, tags: [...item.tags] }));
  }

  /* ================================================================== *
   * 消息
   * ================================================================== */

  /**
   * 发消息。to 省略 = 广播给全组；给了 to 就必须是组内成员（否则消息会石沉大海）。
   *
   * 可靠投递的三条纪律（对齐 MCP Tasks「先持久化再返回」）：
   *   ① 返回值只在 #mutate 的原子写（fsync + rename）成功之后才产生 —— 拿到 messageId 就代表磁盘上已经有了；
   *   ② 同一发送方 + 同一 dedupeKey（不给就用「组 + 收件人 + kind + 正文」的内容哈希）在 10 分钟内
   *      重复发送，直接返回原 messageId，不重复入队（deduplicated=true）；
   *   ③ 限流与收件箱上限都在锁里判断：每个发送方每分钟 20 条；每个收件箱 50 条未读，超了 INBOX_FULL。
   *
   * kind="task" 是「派活」：必须指定 to，初始状态 working，只有接收方能通过 updateTask 推进状态。
   */
  async send({ groupId, from, to, text, kind = "text", dedupeKey } = {}) {
    const id = checkId(groupId, "分组 id");
    const sender = checkId(from, "发送方窗口 id（from）");
    const body = String(text ?? "");
    if (!body.trim()) throw fail("empty_text", "消息内容不能为空。");
    if (body.length > this.limits.maxMessageChars) {
      throw fail("message_too_long", `消息太长：${body.length} 字符 > 上限 ${this.limits.maxMessageChars}。`);
    }
    const messageKind = kind === undefined || kind === null || kind === "" ? "text" : String(kind);
    if (messageKind !== "text" && messageKind !== "task") {
      throw fail("bad_kind", `消息类型只能是 text 或 task，收到的是 ${JSON.stringify(messageKind)}。`);
    }
    const recipient = to === undefined || to === null || to === "" ? null : checkId(to, "接收方窗口 id（to）");
    if (messageKind === "task" && !recipient) {
      throw fail("task_needs_recipient", "派活（kind=task）必须指定 to（接收方窗口 id）；任务不能广播，否则没人对结果负责。");
    }
    const explicitKey = dedupeKey === undefined || dedupeKey === null || String(dedupeKey).trim() === ""
      ? null
      : String(dedupeKey).trim();
    if (explicitKey && explicitKey.length > this.limits.maxDedupeKeyChars) {
      throw fail("dedupe_key_too_long", `dedupeKey 太长：${explicitKey.length} 字符 > 上限 ${this.limits.maxDedupeKeyChars}。`);
    }
    // 显式 key 是「同一次派活」的语义；不给 key 时才退化成内容哈希。前缀避免两种键互相撞上。
    const effectiveKey = explicitKey
      ? `k:${explicitKey}`
      : `h:${contentHash([id, recipient ?? "*", messageKind, body])}`;

    return this.#mutate((doc) => {
      const now = Date.now();
      // 任何写操作顺手把过期未完成的任务落成 cancelled，避免读-写两条路径给出不同语义。
      this.#expireTasks(doc, now);
      const group = doc.groups.find(g => g.id === id);
      if (!group) throw fail("no_such_group", `没有这个分组：${id}`);
      if (!group.members.includes(sender)) {
        throw fail("not_a_member", `窗口 ${sender} 不在分组「${group.name}」里，发不了消息。先 link 加进去。`);
      }
      if (recipient && !group.members.includes(recipient)) {
        throw fail("not_a_member",
          `接收方 ${recipient} 不在分组「${group.name}」里。组内成员：${group.members.join(", ") || "（空）"}。` +
          ` 要广播就省略 to。`);
      }

      // 去重必须在限流之前：重试同一条消息不该消耗配额，也不该被自己的重试卡住。
      const prior = doc.messages.find(m =>
        m.from === sender && m.dedupeKey === effectiveKey &&
        Number.isFinite(m.at) && m.at > now - this.limits.dedupeWindowMs);
      if (prior) {
        return { ...this.#cloneMessage(prior), deduplicated: true };
      }

      // 限流：按落盘的消息数算，跨进程/重启都成立（不依赖内存计数器）。
      const recent = doc.messages.filter(m =>
        m.from === sender && Number.isFinite(m.at) && m.at > now - 60_000);
      if (recent.length >= this.limits.rateLimitPerMinute) {
        const oldest = recent.reduce((min, m) => Math.min(min, m.at), now);
        const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
        throw fail("RATE_LIMITED",
          `RATE_LIMITED：窗口 ${sender} 最近 1 分钟已发 ${recent.length} 条，达到上限 ${this.limits.rateLimitPerMinute} 条。` +
          ` 把消息合并成一条，约 ${retryAfterSec} 秒后再发。`);
      }

      // 收件箱未读上限：按每个收件人的「整个收件箱」算（广播的每个成员都要检查）。
      const targets = recipient ? [recipient] : [...new Set(group.members)];
      const full = [];
      for (const pid of targets) {
        const unread = this.#unreadCount(doc, pid);
        if (unread >= this.limits.maxUnreadPerInbox) full.push(`${pid}（${unread} 条未读）`);
      }
      if (full.length) {
        throw fail("INBOX_FULL",
          `INBOX_FULL：收件箱未读已达上限 ${this.limits.maxUnreadPerInbox} 条，这次发送被拒绝：${full.join("、")}。` +
          ` 让对方先读并 agent_mark_read，或等任务处理完再发。`);
      }

      const live = doc.messages.filter(m => m.groupId === id);
      if (live.length >= this.limits.maxMessagesPerGroup) {
        throw fail("group_full",
          `分组「${group.name}」的消息已有 ${live.length} 条，达到上限 ${this.limits.maxMessagesPerGroup} 条。` +
          ` 消息只能靠删组清理（deleteGroup），或把结论沉淀成记忆条目（share）之后删组重建。`);
      }
      const message = {
        id: `m_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        groupId: id,
        from: sender,
        to: recipient,
        text: body,
        at: now,
        readBy: [],
        kind: messageKind,
        dedupeKey: effectiveKey,
        status: messageKind === "task" ? "working" : null,
        result: null,
        reason: null,
        updatedAt: now,
      };
      doc.messages.push(message);
      return { ...this.#cloneMessage(message), deduplicated: false };
    }, "发送消息");
  }

  /**
   * 收件箱分页（工具层用）。读**不**标已读：已读只能由 markRead 显式确认。
   *
   * @param {object} options
   * @param {string} [options.since] 增量拉取：毫秒时间戳 / ISO 字符串（严格更新），或 messageId（取它之后入队的）。
   * @param {"text"|"task"} [options.kind] 只看某种消息。
   * @returns {Promise<{messages: object[], unreadCount: number, nextSince: string|null, count: number}>}
   */
  async inboxPage({ profileId, groupId, unreadOnly = false, limit = 20, since, kind } = {}) {
    const pid = checkId(profileId, "窗口 id（profileId）");
    const doc = await this.#read();
    return this.#inboxPage(doc, pid, { groupId, unreadOnly, limit, since, kind, now: Date.now() });
  }

  /** 兼容旧调用（界面层 / 自检）：只要消息数组。语义与新 inboxPage 完全一致。 */
  async inbox({ profileId, groupId, unreadOnly = false, limit = 20, since, kind } = {}) {
    const page = await this.inboxPage({ profileId, groupId, unreadOnly, limit, since, kind });
    return page.messages;
  }

  /** 标记已读：把我的 id 加进这些消息的 readBy（去重），并返回剩余未读数。 */
  async markRead({ profileId, messageIds = [] } = {}) {
    const pid = checkId(profileId, "窗口 id（profileId）");
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(id => String(id)).filter(Boolean);
    if (!ids.length) throw fail("need_ids", "markRead 需要 messageIds（消息 id 数组，从 inbox 拿）。");
    return this.#mutate((doc) => {
      this.#expireTasks(doc);
      const marked = [];
      const alreadyRead = [];
      const notFound = [];
      for (const id of ids) {
        const message = doc.messages.find(m => m.id === id);
        if (!message) { notFound.push(id); continue; }
        if (!Array.isArray(message.readBy)) message.readBy = [];
        if (message.readBy.includes(pid)) { alreadyRead.push(id); continue; }
        message.readBy.push(pid);
        marked.push(id);
      }
      return {
        marked: marked.length,
        alreadyRead: alreadyRead.length,
        notFound,
        ids: marked,
        unreadCount: this.#unreadCount(doc, pid),
      };
    }, "标记已读");
  }

  /**
   * 发送方查自己派出去的任务（只返回 kind=task 且 from=我 的消息）。
   * 状态过滤作用在「惰性过期之后」的视图上，所以 12 小时没做完的任务在这里已经是 cancelled（reason=ttl）。
   */
  async tasks({ profileId, taskId, status, groupId, since, limit = 50 } = {}) {
    const pid = checkId(profileId, "窗口 id（profileId）");
    const doc = await this.#read();
    const now = Date.now();
    const sinceFilter = this.#resolveSince(doc, since);
    const max = Math.max(1, Math.min(Number(limit) || 50, this.limits.maxLimit));
    const wantedStatus = status === undefined || status === null || status === "" ? null : String(status);
    if (wantedStatus && !TASK_STATUSES.includes(wantedStatus)) {
      throw fail("bad_status", `任务状态不合法：${JSON.stringify(wantedStatus)}。可选：${TASK_STATUSES.join(" / ")}。`);
    }
    const wantedGroup = groupId === undefined || groupId === null || groupId === "" ? null : checkId(groupId, "分组 id");
    const wantedId = taskId === undefined || taskId === null || taskId === "" ? null : String(taskId);

    const rows = [];
    doc.messages.forEach((message, index) => {
      if (message.kind !== "task" || message.from !== pid) return;
      if (wantedId && message.id !== wantedId) return;
      if (wantedGroup && message.groupId !== wantedGroup) return;
      if (!this.#matchesSince(index, message, sinceFilter)) return;
      rows.push(this.#viewMessage(message, now));
    });
    const filtered = wantedStatus ? rows.filter(message => message.status === wantedStatus) : rows;
    return filtered
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, max);
  }

  /**
   * 接收方更新任务状态 / 结果。只有被派活的接收方（消息 to）能改。
   * 终态（completed / failed / cancelled）不能再转出去；同状态重复调用是幂等的（便于网络重试）。
   * result 只收引用：文件路径或短摘要，上限 2000 字（别把大段正文塞进来）。
   */
  async updateTask({ profileId, taskId, status, result } = {}) {
    const pid = checkId(profileId, "窗口 id（profileId）");
    const tid = String(taskId ?? "").trim();
    if (!tid) throw fail("need_task_id", "updateTask 需要 taskId（agent_send 返回的 messageId）。");
    const nextStatus = String(status ?? "").trim();
    if (!TASK_STATUSES.includes(nextStatus)) {
      throw fail("bad_status",
        `任务状态不合法：${JSON.stringify(String(status ?? ""))}。可选：${TASK_STATUSES.join(" / ")}。`);
    }
    let resultText;
    if (result !== undefined && result !== null) {
      if (typeof result !== "string") throw fail("bad_result", "result 必须是字符串（文件路径或短摘要）。");
      if (result.length > this.limits.maxTaskResultChars) {
        throw fail("result_too_long",
          `result 太长：${result.length} 字符 > 上限 ${this.limits.maxTaskResultChars}。只放文件路径或短摘要，正文写进文件再用路径引用。`);
      }
      resultText = result;
    }

    return this.#mutate((doc) => {
      const now = Date.now();
      this.#expireTasks(doc, now);
      const task = doc.messages.find(m => m.id === tid);
      if (!task || task.kind !== "task") {
        throw fail("no_such_task", `找不到任务 ${tid}（不是 task 消息，或 id 写错了）。`);
      }
      if (task.to !== pid) {
        throw fail("not_assignee",
          `任务 ${tid} 派给的是 ${task.to ?? "（未指定）"}，只有接收方能更新；发送方只能查询（agent_task_list）。`);
      }
      const current = task.status;
      if (nextStatus !== current) {
        const terminal = TASK_TERMINAL_STATUSES.includes(current);
        const allowed = TASK_TRANSITIONS[current] ?? [];
        if (terminal || !allowed.includes(nextStatus)) {
          throw fail("BAD_TRANSITION",
            `BAD_TRANSITION：任务 ${tid} 当前是 ${current}，不能改成 ${nextStatus}。` +
            (terminal ? "终态不能再转出去。" : ` 允许的下一步：${allowed.join(" / ") || "无"}。`));
        }
      } else if (TASK_TERMINAL_STATUSES.includes(current) &&
                 resultText !== undefined && resultText !== task.result) {
        throw fail("BAD_TRANSITION",
          `BAD_TRANSITION：任务 ${tid} 已经结束（${current}），结果不能再改。要更正就新开一条任务。`);
      }

      if (resultText !== undefined) task.result = resultText;
      task.status = nextStatus;
      task.updatedAt = now;
      task.reason = nextStatus === "cancelled" ? (task.reason ?? null) : null;
      return this.#viewMessage(task, now);
    }, "更新任务状态");
  }

  /* ================================================================== *
   * 维护
   * ================================================================== */

  /**
   * 总线状态。界面层的状态面板读它：组数 / 条目数 / 文件大小 都在。
   * fileBytes 是磁盘上的真实大小（stat 拿的），跟内存里的文档可能差一次写。
   */
  async stats() {
    const doc = await this.#read();
    const info = await stat(this.file).catch(() => null);
    const now = Date.now();
    const members = new Set();
    for (const group of doc.groups) for (const pid of group.members) members.add(pid);
    const byGroup = doc.groups.map((group) => {
      const items = doc.items.filter(item => item.groupId === group.id);
      return {
        id: group.id,
        name: group.name,
        members: group.members.length,
        items: items.filter(item => !isExpired(item, now)).length,
        expiredItems: items.filter(item => isExpired(item, now)).length,
        messages: doc.messages.filter(m => m.groupId === group.id).length,
      };
    });
    const fileBytes = info?.size ?? 0;
    return {
      version: CONTEXT_BUS_VERSION,
      file: this.file,
      fileBytes,
      fileSize: humanBytes(fileBytes),
      groups: doc.groups.length,
      items: doc.items.length,
      messages: doc.messages.length,
      members: members.size,
      expiredItems: doc.items.filter(item => isExpired(item, now)).length,
      unreadMessages: doc.messages.filter(m => !(m.readBy ?? []).length).length,
      broadcasts: doc.messages.filter(m => m.to === null).length,
      directMessages: doc.messages.filter(m => m.to !== null).length,
      activeProfileId: doc.activeProfileId ?? null,
      activeAt: doc.activeAt ?? null,
      updatedAt: doc.updatedAt ?? null,
      byGroup,
      limits: { ...this.limits },
    };
  }

  /**
   * 清过期条目（只清 ttl 到点的，**不动**没过期的数据）。
   * 返回清掉几条 + 清完之后的概况。
   */
  async prune() {
    return this.#mutate((doc) => {
      const now = Date.now();
      const before = doc.items.length;
      doc.items = doc.items.filter(item => !isExpired(item, now));
      const removed = before - doc.items.length;
      if (removed) this.log(`[context-bus] prune：清掉 ${removed} 条过期记忆，剩 ${doc.items.length} 条。`);
      return {
        removedItems: removed,
        remaining: {
          groups: doc.groups.length,
          items: doc.items.length,
          messages: doc.messages.length,
        },
      };
    }, "清理过期条目");
  }

  /* ================================================================== *
   * 「最近活跃窗口」—— 工具层默认身份的兜底来源
   * ================================================================== */

  /**
   * 界面层切窗口时调它，把「当前活跃窗口」记下来。
   * 工具层解析不到显式 profileId 时会回落到这个值（解析顺序见 tools/context.js 顶部注释）。
   * 边界：这只是个**便利值**，不是鉴权，也不是"当前窗口"的权威事实。
   */
  async setActiveProfile(profileId) {
    const pid = profileId === null || profileId === "" ? null : checkId(profileId, "窗口 id");
    return this.#mutate((doc) => {
      doc.activeProfileId = pid;
      doc.activeAt = pid ? Date.now() : null;
      return { activeProfileId: pid, activeAt: doc.activeAt };
    }, "更新活跃窗口");
  }

  /** 读「最近活跃窗口」（没有就是 null）。 */
  async activeProfile() {
    const doc = await this.#read();
    return { profileId: doc.activeProfileId ?? null, at: doc.activeAt ?? null };
  }

  /* ================================================================== *
   * 内部：读 / 写 / 锁 / 队列
   * ================================================================== */

  #cloneGroup(group) {
    return { ...group, members: [...group.members] };
  }

  /** members 归一化：字符串、去空白、去重、校验 id 格式。 */
  #cleanMembers(list) {
    const raw = Array.isArray(list) ? list : (list === undefined || list === null || list === "" ? [] : [list]);
    const out = [];
    for (const entry of raw) {
      const id = checkId(entry, "窗口 id");
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  #cleanTags(list) {
    const raw = Array.isArray(list) ? list : (list === undefined || list === null || list === "" ? [] : [list]);
    const out = [];
    for (const entry of raw) {
      const tag = String(entry ?? "").trim();
      if (!tag) continue;
      if (tag.length > this.limits.maxTagChars) {
        throw fail("tag_too_long", `标签太长：${tag.length} 字符 > 上限 ${this.limits.maxTagChars}（标签：${tag.slice(0, 40)}…）。`);
      }
      if (!out.includes(tag)) out.push(tag);
      if (out.length > this.limits.maxTags) {
        throw fail("too_many_tags", `标签太多：上限 ${this.limits.maxTags} 个（去重后）。`);
      }
    }
    return out;
  }

  /* ── 消息 / 任务的内部工具 ── */

  #cloneMessage(message) {
    return { ...message, readBy: [...(message.readBy ?? [])] };
  }

  /**
   * 某个窗口的未读数。广播（to=null）和私信（to=我）都算；只统计「我还在的组」。
   * 收件箱上限用的就是这个数，所以必须和 inboxPage 的可见范围完全一致。
   */
  #unreadCount(doc, pid, groupIds = null) {
    const scope = groupIds ?? doc.groups.filter(group => group.members.includes(pid)).map(group => group.id);
    const scopeSet = new Set(scope);
    return doc.messages.filter(message =>
      scopeSet.has(message.groupId) &&
      (message.to === null || message.to === pid) &&
      !(message.readBy ?? []).includes(pid)).length;
  }

  /** 任务是否已超过 TTL 还没做完（只有 working / input_required 会过期）。 */
  #isTaskExpired(message, now = Date.now()) {
    if (!message || message.kind !== "task") return false;
    if (message.status !== "working" && message.status !== "input_required") return false;
    return Number.isFinite(message.at) && message.at + this.limits.taskTtlMs <= now;
  }

  /**
   * 把过期未完成的任务落成 cancelled（reason=ttl）。只允许在 #mutate 里调 —— 它会改 doc。
   * 读路径用的是 #viewMessage 的惰性视图：两次读之间不会因为「没写入」而看到不同状态。
   */
  #expireTasks(doc, now = Date.now()) {
    let changed = 0;
    for (const message of doc.messages) {
      if (!this.#isTaskExpired(message, now)) continue;
      message.status = "cancelled";
      message.reason = "ttl";
      message.updatedAt = message.at + this.limits.taskTtlMs;
      changed++;
    }
    if (changed) {
      this.log(`[context-bus] ${changed} 个任务超过 TTL 未完成，惰性标记为 cancelled（reason=ttl）`);
    }
    return changed;
  }

  /** 读视图：不改 doc，只按当前时间给出「如果现在读，任务应该是什么状态」。 */
  #viewMessage(message, now = Date.now()) {
    const view = this.#cloneMessage(message);
    if (this.#isTaskExpired(view, now)) {
      view.status = "cancelled";
      view.reason = "ttl";
      view.updatedAt = view.at + this.limits.taskTtlMs;
      view.ttlExpired = true;
    }
    return view;
  }

  /** since 解析：messageId → 文档里的追加位置；时间戳 / ISO → 毫秒时间。 */
  #resolveSince(doc, since) {
    if (since === undefined || since === null || since === "") return { position: null, at: null };
    if (typeof since === "string" && since.trim().startsWith("m_")) {
      const id = since.trim();
      const position = doc.messages.findIndex(message => message.id === id);
      if (position < 0) {
        throw fail("UNKNOWN_SINCE", `UNKNOWN_SINCE：找不到消息 ${id}（可能已被删组连带删除）。省略 since 重新全量拉一次。`);
      }
      return { position, at: null };
    }
    return { position: null, at: toTimestamp(since, "since") };
  }

  /** 增量判断：消息位置在 since 消息之后，或时间严格晚于 since 时间戳。 */
  #matchesSince(index, message, filter) {
    if (filter.position !== null) return index > filter.position;
    if (filter.at !== null) return Number.isFinite(message.at) && message.at > filter.at;
    return true;
  }

  #inboxPage(doc, pid, { groupId, unreadOnly = false, limit = 20, since, kind, now = Date.now() } = {}) {
    const scope = (groupId !== undefined && groupId !== null && groupId !== "")
      ? [checkId(groupId, "分组 id")]
      : doc.groups.filter(group => group.members.includes(pid)).map(group => group.id);
    const scopeSet = new Set(scope);
    const wantedKind = kind === undefined || kind === null || kind === "" ? null : String(kind);
    if (wantedKind && wantedKind !== "text" && wantedKind !== "task") {
      throw fail("bad_kind", `消息类型只能是 text 或 task，收到的是 ${JSON.stringify(wantedKind)}。`);
    }
    const sinceFilter = this.#resolveSince(doc, since);
    const max = Math.max(1, Math.min(Number(limit) || 20, this.limits.maxLimit));

    const matched = [];
    doc.messages.forEach((message, index) => {
      if (!scopeSet.has(message.groupId)) return;
      if (message.to !== null && message.to !== pid) return;
      if (wantedKind && message.kind !== wantedKind) return;
      if (unreadOnly && (message.readBy ?? []).includes(pid)) return;
      if (!this.#matchesSince(index, message, sinceFilter)) return;
      matched.push({ message, index });
    });
    matched.sort((a, b) => (b.message.at ?? 0) - (a.message.at ?? 0) || b.index - a.index);
    const page = matched.slice(0, max).map(entry => this.#viewMessage(entry.message, now));

    return {
      messages: page,
      count: page.length,
      // 未读数不受 since / unreadOnly / kind 影响：它就是「这个收件箱还有多少没确认」。
      unreadCount: this.#unreadCount(doc, pid, scope),
      nextSince: page[0]?.id ?? (typeof since === "string" && since.trim().startsWith("m_") ? since.trim() : null),
    };
  }

  async #ensureReady() {
    if (this.#disposed) throw fail("disposed", "共享上下文总线已关闭（dispose 之后不能再用）。");
    await this.initialize();
  }

  /** 只读路径：不需要锁——原子替换保证读到的永远是完整文档。 */
  async #read() {
    await this.#ensureReady();
    return this.#readDoc();
  }

  /**
   * 变更路径：进程内队列串行化 → 拿跨进程锁 → 读 → 改 → 原子写。
   * 「读-改-写」整个在锁里完成，这是不丢更新的关键。
   */
  async #mutate(fn, what) {
    await this.#ensureReady();
    return this.#serialize(async () => {
      const { handle, lockPath } = await this.#acquireLock();
      try {
        const doc = await this.#readDoc();
        const result = await fn(doc);
        await this.#writeDoc(doc);
        return result;
      } catch (error) {
        if (what) this.log(`[context-bus] ${what}失败：${error.message}`);
        throw error;
      } finally {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      }
    });
  }

  #serialize(fn) {
    const run = this.#queue.then(() => fn());
    // 队列自身永不 reject，否则一次失败会把后面排队的调用全带崩
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 独占创建锁文件；拿不到就等；锁文件过旧（持锁进程崩了）自动接管。 */
  async #acquireLock() {
    const lockPath = `${this.file}.lock`;
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > this.lockTimeoutMs) {
        throw fail("lock_timeout",
          `共享上下文正在被其它进程写入（锁文件：${lockPath}）。等了 ${Math.round((Date.now() - started) / 1000)} 秒仍拿不到锁，请稍后重试。`);
      }
      try {
        const handle = await open(lockPath, "wx", 0o600);
        // 锁文件里留个 PID：出问题时能看出是谁占着
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => {});
        return { handle, lockPath };
      } catch (error) {
        // Windows：锁文件正被删除（删除挂起）时再创建，报的是 EPERM 而不是 EEXIST，同样是「别人刚放锁」，等一下再抢
        const busy = error.code === "EEXIST" || (process.platform === "win32" && error.code === "EPERM");
        if (!busy) throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > this.lockStaleMs) {
          this.log(`[context-bus] 锁文件 ${Math.round((Date.now() - info.mtimeMs) / 1000)} 秒没动过，判定为陈旧（持锁进程可能崩了），接管。`);
          await rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
      }
      await sleep(this.lockRetryMs + Math.random() * this.lockRetryMs);
    }
  }

  /** 读文档。任何字段缺失/类型不对都在这里归一化，后面的代码就不用到处防 undefined。 */
  async #readDoc() {
    const raw = await readFile(this.file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw === null) return this.#emptyDoc();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 运行期损坏：不删不隔离（避免把用户数据搞丢），明确报错让人来处理。
      throw fail("corrupt_file",
        `共享上下文文件不是合法 JSON（${error.message}）。文件：${this.file}。` +
        ` 建议先把它改名备份，总线会在下一次写入时自动重建。`);
    }
    if (parsed?.version !== undefined && parsed.version !== CONTEXT_BUS_VERSION) {
      throw fail("version_mismatch", `共享上下文文件版本是 ${parsed.version}，本程序只认识 ${CONTEXT_BUS_VERSION}。文件：${this.file}`);
    }
    const doc = this.#emptyDoc();
    doc.updatedAt = Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : null;
    doc.activeProfileId = typeof parsed?.activeProfileId === "string" && ID_RE.test(parsed.activeProfileId) ? parsed.activeProfileId : null;
    doc.activeAt = Number.isFinite(parsed?.activeAt) ? parsed.activeAt : null;
    if (Array.isArray(parsed?.groups)) {
      for (const group of parsed.groups) {
        if (!group || typeof group.id !== "string" || !ID_RE.test(group.id)) continue;
        doc.groups.push({
          id: group.id,
          name: String(group.name ?? group.id).slice(0, 120),
          note: String(group.note ?? ""),
          members: Array.isArray(group.members) ? group.members.map(String).filter(pid => ID_RE.test(pid)) : [],
          createdAt: Number.isFinite(group.createdAt) ? group.createdAt : null,
          updatedAt: Number.isFinite(group.updatedAt) ? group.updatedAt : null,
        });
      }
    }
    if (Array.isArray(parsed?.items)) {
      for (const item of parsed.items) {
        if (!item || typeof item.id !== "string" || typeof item.groupId !== "string") continue;
        const value = typeof item.value === "string" ? item.value : JSON.stringify(item.value ?? null);
        doc.items.push({
          id: item.id,
          groupId: item.groupId,
          key: String(item.key ?? ""),
          value,
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          sourceProfileId: String(item.sourceProfileId ?? ""),
          at: Number.isFinite(item.at) ? item.at : null,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : (Number.isFinite(item.at) ? item.at : null),
          ttl: Number.isFinite(item.ttl) ? item.ttl : null,
          expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : null,
          bytes: Number.isFinite(item.bytes) ? item.bytes : Buffer.byteLength(value, "utf8"),
          revision: Number.isFinite(item.revision) ? item.revision : 1,
        });
      }
    }
    if (Array.isArray(parsed?.messages)) {
      for (const message of parsed.messages) {
        if (!message || typeof message.id !== "string" || typeof message.groupId !== "string") continue;
        // 旧版本文件只有 id/group/text/at/readBy：kind 缺失一律当普通文本，任务字段补成安全默认值。
        const kind = message.kind === "task" ? "task" : "text";
        const status = kind === "task"
          ? (TASK_STATUSES.includes(message.status) ? message.status : "working")
          : null;
        doc.messages.push({
          id: message.id,
          groupId: message.groupId,
          from: String(message.from ?? ""),
          to: message.to === null || message.to === undefined || message.to === "" ? null : String(message.to),
          text: String(message.text ?? ""),
          at: Number.isFinite(message.at) ? message.at : null,
          readBy: Array.isArray(message.readBy) ? message.readBy.map(String) : [],
          kind,
          dedupeKey: typeof message.dedupeKey === "string" && message.dedupeKey ? message.dedupeKey : null,
          status,
          result: typeof message.result === "string" ? message.result : null,
          reason: typeof message.reason === "string" ? message.reason : null,
          updatedAt: Number.isFinite(message.updatedAt)
            ? message.updatedAt
            : (Number.isFinite(message.at) ? message.at : null),
        });
      }
    }
    return doc;
  }

  #emptyDoc() {
    return { version: CONTEXT_BUS_VERSION, updatedAt: null, activeProfileId: null, activeAt: null, groups: [], items: [], messages: [] };
  }

  /**
   * 原子写：临时文件（wx, 0600）→ 写 → fsync → rename 覆盖。
   * 序列化只做一次，写盘用的就是被检查过体积的那份字节，避免"检查的和写的不一致"。
   */
  async #writeDoc(doc) {
    doc.version = CONTEXT_BUS_VERSION;
    doc.updatedAt = Date.now();
    const text = JSON.stringify(doc, null, 2);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.limits.maxDocBytes) {
      throw fail("bus_full",
        `共享上下文整体体积超限：${humanBytes(bytes)} > 上限 ${humanBytes(this.limits.maxDocBytes)}，这次写入被拒绝（数据没有被改动）。` +
        ` 处理办法：prune() 清过期条目，或 forget() 删掉没用的 key。`);
    }
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#replaceFile(temp);
    // POSIX 上把权限钉死 0600；Windows 上 chmod 只动只读位，靠用户目录 ACL 兜底
    await chmod(this.file, 0o600).catch(() => {});
    // 目录 fsync 让 rename 本身也持久化（Windows 打不开目录句柄，跳过）
    if (process.platform !== "win32") {
      const dirHandle = await open(dir, "r").catch(() => null);
      if (dirHandle) {
        await dirHandle.sync().catch(() => {});
        await dirHandle.close().catch(() => {});
      }
    }
    return bytes;
  }

  /**
   * 把临时文件原子地换到正式文件上 —— Windows 上必须带重试。
   *
   * 为什么（这是实测踩出来的真 bug）：
   *   Windows 不允许重命名覆盖一个**正被其它进程打开**的文件，
   *   此时 rename 直接抛 EPERM，而不是排队等对方关掉。
   *
   *   而我们的锁只挡写者、挡不住读者：另一个进程用 readFile 读的时候，
   *   文件会被短暂打开，写者的 rename 正好落在这个窗口里就失败了。
   *
   *   实测症状：4 个子进程并发各写 5 条，约 10% 的概率有 1~2 个进程
   *   报 EPERM 退出，**那些写入全部丢失**（放到共享记忆上就是：两个窗口
   *   的 Agent 同时写，有一方的改动静默消失）。
   *
   *   读者的打开窗口极短，所以退避重试就够了 —— 不用改锁模型。
   *   EPERM / EBUSY / EACCES 在 Windows 上语义重叠，一律当瞬时错误处理。
   *   其它平台的 EPERM 是权限问题，重试没意义，直接抛。
   */
  async #replaceFile(temp) {
    const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
    const isWindows = process.platform === "win32";
    /*
     * 重试预算：最多 25 次，退避 10ms 起每次乘 1.5、封顶 250ms，总计约 4 秒。
     *
     * 为什么给这么宽：
     *   一开始只给了 12 次 / 约 0.5 秒，单独跑没问题，但在**机器忙的时候**
     *   （Electron + 桥 + cloudflared 都在跑）还是会耗尽 —— 读者的打开窗口
     *   被拉长了。这是实测出来的：全量验收里偶发失败，单独跑却 20/20 全过。
     *   整个写入是在锁里做的，锁超时 20 秒，所以 4 秒的重试完全放得下。
     */
    const MAX_ATTEMPTS = isWindows ? 25 : 1;
    const BASE_DELAY_MS = 10;
    const MAX_DELAY_MS = 250;

    let lastError = null;
    let waitedMs = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await rename(temp, this.file);
        if (attempt > 1) {
          this.log(`[context-bus] 换文件第 ${attempt} 次才成功（等了约 ${waitedMs}ms，前 ${attempt - 1} 次被别的进程占着）`);
        }
        return;
      } catch (error) {
        lastError = error;
        const retryable = isWindows && TRANSIENT.has(error.code);
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        const delay = Math.min(MAX_DELAY_MS, Math.round(BASE_DELAY_MS * 1.5 ** (attempt - 1)));
        waitedMs += delay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    await rm(temp, { force: true }).catch(() => {});
    if (lastError && process.platform === "win32" && TRANSIENT.has(lastError.code)) {
      throw fail("replace_failed",
        `写共享上下文时文件一直被别的进程占着，重试 ${MAX_ATTEMPTS} 次（约 ${waitedMs}ms）仍失败（${lastError.code}）。` +
        ` 通常是有另一个进程在密集读同一个文件；稍后重试即可。这次写入没有被应用（数据没被改坏）。`);
    }
    throw lastError;
  }
}
