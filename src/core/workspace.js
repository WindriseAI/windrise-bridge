/**
 * 工作区（Workspace）：多个窗口、多个进程怎么认出「同一个项目」并共享它的记录。
 *
 *   1. 工作区身份是对存储键做 sha256，跟窗口会话无关，重开窗口、换数据目录都认得出来。
 *   2. 三种形态：folder（单文件夹）/ workspace（多根）/ empty（空窗口）。
 *   3. 机器级共享目录 <共享目录>/workspace-hub 下，每个窗口一个 json 记录，带心跳时间戳，过期即视为失效。
 *   4. 写记录用「临时文件 + rename」原子替换；跨进程互斥用「独占创建锁文件 + 陈旧检测」，只依赖 node:fs，跨平台可用。
 *   5. 面板只读这些记录做展示，不把 MCP 路由令牌写进去。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HUB_VERSION = 1;
const WINDOW_TTL_MS = 60_000;

/**
 * 共享根目录，按顺序取第一个给了的：
 *   BRIDGE_SHARED_DATA_HOME（直接指定共享目录）→ BRIDGE_PORTABLE（便携版，放在它的 shared-data 下）→ 用户主目录。
 */
export function workspaceHubRoot(env = process.env, home = os.homedir()) {
  const bases = [
    [env.BRIDGE_SHARED_DATA_HOME, (dir) => dir],
    [env.BRIDGE_PORTABLE, (dir) => path.join(dir, "shared-data")],
  ];
  for (const [value, place] of bases) {
    const dir = String(value ?? "").trim();
    if (dir) return path.join(place(path.resolve(dir)), "workspace-hub");
  }
  return path.join(home, ".bridge-replica-shared", "workspace-hub");
}

/** 工作区身份：可跨窗口、跨重启、跨 --user-data-dir 复用。 */
export function workspaceIdentity(storageKey) {
  if (!storageKey) return "empty";
  return createHash("sha256").update(`bridge-hub-workspace-v1::${storageKey}`).digest("hex");
}

/** 从常见入口推断身份：优先 .code-workspace 文件，其次文件夹路径。 */
export function describeWorkspace({ folders = [], workspaceFile } = {}) {
  const kind = workspaceFile ? "workspace" : folders.length ? "folder" : "empty";
  const storageKey = workspaceFile ?? (folders.length === 1 ? folders[0] : folders.join("|"));
  return {
    id: workspaceIdentity(storageKey),
    name: path.basename(workspaceFile ?? folders[0] ?? "") || "空窗口",
    kind,
    uri: workspaceFile ?? folders[0] ?? null,
    folders: [...folders],
  };
}

/** 原子写：先写临时文件并 fsync，再 rename 覆盖，避免读到半个 json。 */
async function atomicWrite(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file).catch(async (error) => {
    await rm(temp, { force: true });
    throw error;
  });
}

/**
 * 跨进程互斥：独占创建锁文件。拿不到就重试；锁文件过旧（进程崩了）自动接管。
 * 学习软件用的是命名管道锁，这里用「排他创建 + 陈旧回收」达到同样效果。
 */
async function withLock(lockPath, fn, { retries = 40, delayMs = 25, staleMs = 30_000 } = {}) {
  let handle;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  if (!handle) throw new Error("共享记录正在被其它窗口写入，请稍后重试。");
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

export class WorkspaceHub {
  constructor({ root = workspaceHubRoot(), windowId = randomUUID(), workspace, pid = process.pid } = {}) {
    this.root = path.resolve(root);
    this.windowId = windowId;
    this.pid = pid;
    this.workspace = workspace ?? describeWorkspace();
    this.startedAt = Date.now();
  }

  dirs() {
    return ["windows", "chats", "requests"].map(name => path.join(this.root, name));
  }

  async initialize() {
    for (const dir of [this.root, ...this.dirs()]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** 对外公布的窗口记录：不含路由令牌等敏感值。 */
  snapshot(bridge = {}) {
    return {
      version: HUB_VERSION,
      windowId: this.windowId,
      pid: this.pid,
      workspace: this.workspace,
      updatedAt: Date.now(),
      startedAt: this.startedAt,
      bridge: {
        state: bridge.state ?? "stopped",
        provider: bridge.provider ?? "none",
        publicUrl: redactUrl(bridge.publicUrl),
        localUrl: redactUrl(bridge.localUrl),
        toolCount: bridge.toolCount ?? 0,
        connectedClients: bridge.connectedClients ?? 0,
      },
    };
  }

  async publish(bridge) {
    await this.initialize();
    const file = path.join(this.root, "windows", `${this.windowId}.json`);
    const payload = this.snapshot(bridge);
    await withLock(path.join(this.root, `lock-${this.windowId}.lock`), () => atomicWrite(file, payload));
    return payload;
  }

  /** 其它窗口的心跳在 TTL 内才算活着；过期的记录当作历史残留忽略。 */
  async listWindows() {
    const dir = path.join(this.root, "windows");
    const files = await readdir(dir).catch(() => []);
    const now = Date.now();
    const out = [];
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const raw = await readFile(path.join(dir, name), "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const value = JSON.parse(raw);
        if (value?.version !== HUB_VERSION) continue;
        out.push({ ...value, alive: now - value.updatedAt <= WINDOW_TTL_MS });
      } catch { /* 忽略坏记录 */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 会话历史共享：一个会话一个文件，写入走同一把锁。 */
  async publishChat({ sessionId, title, messages = [], revision = 1 }) {
    if (!sessionId || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new Error("会话 ID 不合法");
    await this.initialize();
    const key = createHash("sha256").update(`${this.workspace.id}\n${sessionId}`).digest("hex");
    const file = path.join(this.root, "chats", `${key}.json`);
    const record = { version: HUB_VERSION, key, workspaceId: this.workspace.id, sessionId, title: String(title ?? "新对话").slice(0, 180), revision, count: messages.length, updatedAt: Date.now() };
    await withLock(path.join(this.root, `lock-chat-${key}.lock`), async () => {
      await atomicWrite(path.join(this.root, "chats", `${key}.messages.json`), { ...record, messages });
      await atomicWrite(file, record);
    });
    return record;
  }

  async listChats() {
    const dir = path.join(this.root, "chats");
    const files = await readdir(dir).catch(() => []);
    const out = [];
    for (const name of files) {
      if (!name.endsWith(".json") || name.endsWith(".messages.json")) continue;
      const raw = await readFile(path.join(dir, name), "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const value = JSON.parse(raw);
        if (value?.workspaceId === this.workspace.id) out.push(value);
      } catch { /* 忽略坏记录 */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** 面板里永远不回显或记录完整路由令牌。 */
export function redactUrl(url) {
  if (!url) return null;
  return String(url).replace(/\/mcp\/[A-Za-z0-9_-]{8,}/gi, "/mcp/••••••");
}
