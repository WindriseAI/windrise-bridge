/**
 * LSP 客户端 —— 用 TypeScript 自带的 tsserver 把 lsp / get_diagnostics 做成真货。
 *
 * 为什么选 tsserver：它随 TypeScript 一起装在 node_modules 里，零额外依赖，
 * 而且它就是 VS Code 用的那个引擎，结果和编辑器里看到的完全一致。
 *
 * 协议要点（关键：tsserver 用的**不是** LSP 的 Content-Length 帧）：
 *   - 每条消息就是一行裸 JSON，以换行结尾；tsserver 也是这么回你的
 *   - 请求：{ seq, type: "request", command, arguments }
 *   - 响应：{ seq, type: "response", request_seq, success, body }
 *   - 事件：{ seq, type: "event", event, body }
 *   踩过的坑：按 LSP 的 "Content-Length: N" 帧头发过去，
 *   tsserver 会把它当 JSON 解析，回 "Unexpected token 'C'"。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 安装包自带的 TypeScript（resources/app/node_modules/typescript），项目里没装也能用 */
const BUNDLED_TSSERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "typescript", "lib", "tsserver.js");

const REQUEST_TIMEOUT_MS = 20_000;

/** 找一个可用的 tsserver：项目本地优先，其次全局。 */
export async function findTsserver(root) {
  const candidates = [
    path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
    path.join(root, "node_modules", "typescript", "lib", "tsserverlibrary.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, source: "project" };
  }
  // 退一步：用 node 解析 typescript 包的位置
  try {
    const resolved = pathToFileURL(path.join(root, "index.js")).href;
    const mod = await import("node:module").then(m => m.createRequire(resolved));
    const tsMain = mod.resolve("typescript/lib/tsserver.js");
    if (existsSync(tsMain)) return { path: tsMain, source: "resolved" };
  } catch { /* 继续找 */ }
  // 再退一步：安装包自带的那份
  if (existsSync(BUNDLED_TSSERVER)) return { path: BUNDLED_TSSERVER, source: "bundled" };
  // 最后：本作业自己的依赖
  const selfPath = path.join(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js");
  if (existsSync(selfPath)) return { path: selfPath, source: "bridge" };
  return null;
}

export class TsserverClient {
  constructor({ root, log = () => {} } = {}) {
    this.root = path.resolve(root);
    this.log = log;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.openFiles = new Set();
    this.diagnostics = new Map();
    this.eventWaiters = [];
    this.serverPath = null;
    this.startedAt = null;
  }

  async ensureStarted() {
    if (this.child && this.child.exitCode === null) return this;
    const found = await findTsserver(this.root);
    if (!found) {
      throw new Error(
        `没找到 tsserver（安装包自带的 TypeScript 也不在）。可以在项目里装 TypeScript（npm i -D typescript），或重新安装 Windrise Bridge。查找过的位置：${path.join(this.root, "node_modules", "typescript", "lib", "tsserver.js")}`
      );
    }
    this.serverPath = found.path;

    /*
     * 起 tsserver 时要注意宿主是谁：
     *
     * 开发模式下 process.execPath 是 node，直接就能跑。
     * 但打包成桌面应用后，process.execPath 是 **Electron 主程序**，
     * 直接拿它起 tsserver 会被当成「用 Electron 打开一个 js 应用」——
     * 结果是它真的拉起一个窗口、带出一整套 GPU/renderer 子进程，
     * 然后永远不说话（表现为 lsp 报 "configure 超时"）。
     *
     * 解法就是给子进程带上 ELECTRON_RUN_AS_NODE=1：让 Electron 退化成纯 Node。
     * 对已经是 node 的情况这个变量无害，所以统一带上。
     */
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    this.child = spawn(process.execPath, [found.path, "--disableAutomaticTypingAcquisition", "--logVerbosity", "off"], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv,
    });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => this.log(`[tsserver stderr] ${chunk.toString().slice(0, 400)}`));
    this.child.on("exit", (code) => {
      this.log(`[tsserver] 退出 code=${code}`);
      this.child = null;
      for (const [, entry] of this.pending) entry.reject(new Error("tsserver 已退出"));
      this.pending.clear();
    });
    this.startedAt = Date.now();
    this.log(`[tsserver] 已启动：${found.path}（来源 ${found.source}）`);

    await this.send("configure", {
      hostInfo: "bridge-replica",
      preferences: { providePrefixAndSuffixTextForRename: true, allowRenameOfImportPath: true },
    });
    return this;
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 换行分隔的裸 JSON：一次可能收到多条，也可能只收到半条
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message.type === "response" && this.pending.has(message.request_seq)) {
      const entry = this.pending.get(message.request_seq);
      this.pending.delete(message.request_seq);
      clearTimeout(entry.timer);
      if (message.success === false) entry.reject(new Error(message.message ?? "tsserver 请求失败"));
      else entry.resolve(message.body ?? {});
      return;
    }
    if (message.type === "event") {
      if (message.event === "syntaxDiag" || message.event === "semanticDiag" || message.event === "suggestionDiag") {
        const file = message.body?.file;
        if (file) this.diagnostics.set(file, { kind: message.event, items: message.body.diagnostics ?? [], at: Date.now() });
      }
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.event === message.event) {
          waiter.resolve(message.body);
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
        }
      }
    }
  }

  waitForEvent(event, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const waiter = { event, resolve };
      this.eventWaiters.push(waiter);
      setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) { this.eventWaiters.splice(index, 1); resolve(null); }
      }, timeoutMs).unref?.();
    });
  }

  send(command, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) { reject(new Error("tsserver 未运行")); return; }
      const seq = ++this.seq;
      const payload = JSON.stringify({ seq, type: "request", command, arguments: args });
      // 一行一条 JSON，末尾换行 —— 这就是 tsserver 认的格式
      const message = payload + "\n";
      const timer = setTimeout(() => {
        if (this.pending.has(seq)) { this.pending.delete(seq); reject(new Error(`${command} 超时`)); }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
      this.child.stdin.write(message, "utf8");
    });
  }

  /** 打开文件（tsserver 只对「已打开」的文件给完整信息）。 */
  async open(file) {
    const absolute = path.resolve(this.root, file);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new Error(`文件不存在：${file}`);
    const text = await readFile(absolute, "utf8");
    const key = absolute.replace(/\\/g, "/");
    if (!this.openFiles.has(key)) {
      await this.send("open", { file: key });
      this.openFiles.add(key);
    }
    await this.send("updateOpen", {
      changedFiles: [{ fileName: key, text }],
      closedFiles: [],
    }).catch(() => {});
    return key;
  }

  /** 收集一个文件的诊断（语法 + 语义 + 建议），等事件回来。 */
  async diagnosticsFor(file, { waitMs = 6000 } = {}) {
    const key = await this.open(file);
    this.diagnostics.delete(key);
    const syntax = this.waitForEvent("syntaxDiag", waitMs);
    const semantic = this.waitForEvent("semanticDiag", waitMs);
    const suggestion = this.waitForEvent("suggestionDiag", 1500);
    await this.send("syntacticDiagnosticsSync", { file: key }).catch(() => {});
    await this.send("semanticDiagnosticsSync", { file: key }).catch(() => {});
    await Promise.race([Promise.all([syntax, semantic, suggestion]), new Promise(r => setTimeout(r, waitMs))]);

    const collected = [];
    for (const kind of ["syntaxDiag", "semanticDiag", "suggestionDiag"]) {
      const entry = this.diagnostics.get(key);
      if (entry && entry.kind === kind) {
        for (const item of entry.items) collected.push({ ...item, source: kind.replace("Diag", "") });
      }
    }
    // 事件可能被后到的同类型覆盖，所以再直接问一次
    for (const [command, label] of [["syntacticDiagnosticsSync", "syntax"], ["semanticDiagnosticsSync", "semantic"]]) {
      const body = await this.send(command, { file: key }).catch(() => null);
      if (Array.isArray(body)) {
        for (const item of body) {
          if (!collected.some(c => c.start === item.start && c.message === item.message && c.source === label)) {
            collected.push({ ...item, source: label });
          }
        }
      }
    }
    return { file: key, items: collected };
  }

  async definition(file, line, offset) {
    const key = await this.open(file);
    return this.send("definitionAndBoundSpan", { file: key, line, offset });
  }

  async references(file, line, offset) {
    const key = await this.open(file);
    return this.send("references", { file: key, line, offset });
  }

  async documentSymbols(file) {
    const key = await this.open(file);
    return this.send("navtree", { file: key });
  }

  async quickInfo(file, line, offset) {
    const key = await this.open(file);
    return this.send("quickinfo", { file: key, line, offset });
  }

  async completion(file, line, offset) {
    const key = await this.open(file);
    return this.send("completionInfo", { file: key, line, offset, includeExternalModuleExports: false });
  }

  status() {
    return {
      running: Boolean(this.child && this.child.exitCode === null),
      serverPath: this.serverPath,
      openFiles: [...this.openFiles],
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  dispose() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = null;
    this.openFiles.clear();
  }
}

/**
 * 共享的 tsserver 池：按项目根目录缓存，避免每个请求都重启进程。
 */
const pool = new Map();

export async function getTsserver(root, log) {
  const key = path.resolve(root);
  if (!pool.has(key)) {
    const client = new TsserverClient({ root: key, log });
    pool.set(key, client);
  }
  const client = pool.get(key);
  await client.ensureStarted();
  return client;
}

export function disposeAll() {
  for (const [, client] of pool) client.dispose();
  pool.clear();
}

/** 把 1 基的「行:列」解析成 tsserver 需要的形式。 */
export function parsePosition(input) {
  if (input?.line) return { line: Number(input.line), offset: Number(input.offset ?? input.column ?? 1) };
  const text = String(input?.position ?? "1:1");
  const match = /^(\d+)\s*[:,\s]\s*(\d+)$/.exec(text.trim());
  if (match) return { line: Number(match[1]), offset: Number(match[2]) };
  const single = Number(text);
  if (Number.isFinite(single)) return { line: single, offset: 1 };
  return { line: 1, offset: 1 };
}

/**
 * 诊断的严重度映射成可读文本。
 * 注意：tsserver 在响应里给的是**字符串**（"error" / "warning" / "suggestion" / "message"），
 * 但在部分事件里给的是数字枚举（0=Warning, 1=Error, 2=Suggestion, 3=Message）。
 * 两种都得认，否则会显示成「未知」。
 */
export function severityText(category) {
  const byName = {
    error: "错误", warning: "警告", suggestion: "建议", message: "提示",
  };
  const byNumber = { 0: "警告", 1: "错误", 2: "建议", 3: "提示" };
  if (typeof category === "string") return byName[category.toLowerCase()] ?? category;
  return byNumber[category] ?? `未知(${category})`;
}

/** 诊断排序权重：错误排前面，方便一眼看到重点。 */
export function severityRank(category) {
  const byName = { error: 0, warning: 1, suggestion: 2, message: 3 };
  const byNumber = { 1: 0, 0: 1, 2: 2, 3: 3 };
  if (typeof category === "string") return byName[category.toLowerCase()] ?? 4;
  return byNumber[category] ?? 4;
}
