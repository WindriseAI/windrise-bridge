/**
 * 命令执行与 IDE 交互工具 —— 对应学习软件的 IDE_TOOL_DEFINITIONS。
 *
 * run_command 返回 commandId，之后可用 get_command_output 读输出、send_command_input 喂输入、
 * cancel_command 中断。
 *
 * **每条命令一个独立进程**（以前是一个常驻 PowerShell，靠往 stdin 写命令 + 结束标记切输出）。
 * 改的原因（实测）：常驻终端里只要有一条多行命令（if {...}、here-string）或括号没闭合，
 * PowerShell 就一直等下一行，结束标记被吞掉 —— 这条卡死，之后**所有**命令都排在它后面一起卡死。
 * 现在：
 *   - 整段脚本先写进临时文件再整体解析，多行、here-string 都正常；语法错误直接报错返回
 *   - 一条卡住不影响别的；超时只是先返回「还在跑」，可以继续读输出或中断
 *   - cd 会被记住（下一条命令从这里开始）；环境变量不保留
 */

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyCommand } from "../core/guard.js";

const MAX_OUTPUT_BYTES = 2_000_000;      // 单条命令最多留 2MB 输出（超出丢最前面的）
const RETURN_CHARS = 20_000;             // 一次返回给模型的最多字符数（取末尾）
const DEFAULT_WAIT_MS = 60_000;          // 默认最多等 60 秒；没跑完先返回「还在跑」
const KEEP_FINISHED = 100;               // 最多记住最近 100 条命令
const IS_WINDOWS = process.platform === "win32";

/** 在 PATH 里找可执行文件（同步，只在启动时用一次） */
function which(name) {
  for (const dir of String(process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir.replace(/^"|"$/g, ""), name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * 选终端：
 *   - Mac / Linux：bash
 *   - Windows：装了 Git 就用 Git 自带的 bash（和 Mac 一样的语法，AI 写命令最不容易错）；
 *     没装就用 PowerShell 7，再没有用系统自带的 Windows PowerShell（写全路径，不怕 PATH 被改坏）
 *   - 环境变量 BRIDGE_SHELL 可以强制指定
 */
export function defaultShell() {
  if (process.env.BRIDGE_SHELL) return process.env.BRIDGE_SHELL;
  if (!IS_WINDOWS) return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const gitBash = [
    ...[process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"]].filter(Boolean).map(d => path.join(d, "Git", "bin", "bash.exe")),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    (() => { const git = which("git.exe"); return git && path.join(path.dirname(path.dirname(git)), "bin", "bash.exe"); })(),
  ].filter(Boolean).find(p => existsSync(p));
  if (gitBash) return gitBash;
  for (const dir of [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)) {
    const pwsh = path.join(dir, "PowerShell", "7", "pwsh.exe");
    if (existsSync(pwsh)) return pwsh;
  }
  const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(sys) ? sys : "powershell.exe";
}

/** 给工具说明用：现在用的是哪种终端 */
export function shellKind(shell = defaultShell()) {
  const base = path.basename(shell).toLowerCase();
  if (base.startsWith("pwsh")) return "pwsh";
  if (base.startsWith("powershell")) return "powershell";
  return IS_WINDOWS ? "git-bash" : "bash";
}

/*
 * PowerShell 引导脚本（用 -EncodedCommand 传，不受「禁止运行脚本」的执行策略影响）：
 * 读临时文件里的整段命令 → 整体解析 → 在 cwd 里执行 → 记下最后所在目录 → 用正确的退出码退出。
 */
const PS_BOOTSTRAP = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Continue'",
  "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch {}",
  "try { Set-Location -LiteralPath $env:BRIDGE_CWD } catch {}",
  "$global:LASTEXITCODE = 0",
  "try { $__sb = [ScriptBlock]::Create([IO.File]::ReadAllText($env:BRIDGE_CMD_FILE, [Text.Encoding]::UTF8)) }",
  "catch { $__e = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }; [Console]::Error.WriteLine('命令语法错误：' + $__e.Message); exit 1 }",
  "$__ok = $true",
  "try { . $__sb; $__ok = $? } catch { [Console]::Error.WriteLine(($_ | Out-String).Trim()); $__ok = $false }",
  "finally { try { [IO.File]::WriteAllText($env:BRIDGE_CWD_FILE, (Get-Location).ProviderPath) } catch {} }",
  "if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__ok) { exit 1 } else { exit 0 }",
].join("\n");
const PS_ENCODED = Buffer.from(PS_BOOTSTRAP, "utf16le").toString("base64");

/** PowerShell 输出被重定向时偶尔夹带 CLIXML（进度条 / 错误记录的序列化），转回普通文字 */
function stripClixml(text) {
  if (!text.includes("#< CLIXML")) return text;
  return text.replace(/#< CLIXML\r?\n?/g, "").replace(/<Objs Version="[^"]*"[^>]*>[\s\S]*?<\/Objs>/g, (block) => {
    const errors = [...block.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1]);
    return errors.join("")
      .replace(/_x000D_/g, "").replace(/_x000A_/g, "\n")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  });
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** 按行解码：每行先按 UTF-8，不合法再按系统中文编码（GBK）——Windows 上老程序常输出 GBK */
let gbk = null;
function decodeOutput(buf) {
  if (!buf.length) return "";
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try { return stripClixml(utf8.decode(buf).replace(ANSI_RE, "")); } catch { /* 有非 UTF-8 的行 */ }
  if (!gbk) { try { gbk = new TextDecoder("gbk"); } catch { gbk = new TextDecoder("utf-8"); } }
  const parts = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0x0a) {
      const line = buf.subarray(start, Math.min(i + 1, buf.length));
      try { parts.push(utf8.decode(line)); } catch { parts.push(gbk.decode(line)); }
      start = i + 1;
    }
  }
  return stripClixml(parts.join("").replace(ANSI_RE, ""));
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
      // 兜底：taskkill 之后进程还在就直接结束它
      try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { /* 已经没了 */ }
    });
  }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } } }
}

export class TerminalManager {
  constructor({ guard, shell = defaultShell(), cwd, autoApproveReadOnly = true, onApprovalRequest = null } = {}) {
    this.onApprovalRequest = onApprovalRequest;
    this.guard = guard;
    this.shell = shell;
    this.posix = !/powershell|pwsh/i.test(path.basename(shell));
    this.cwd = cwd ?? guard?.roots?.[0] ?? process.cwd();
    this.autoApproveReadOnly = autoApproveReadOnly;
    this.commands = new Map();
    /** 待人工审批的命令：id → { command, risk, at } */
    this.pendingApprovals = new Map();
    this.counter = 0;
    this.approvals = new Map();
    this.tmpDir = path.join(os.tmpdir(), "windrise-bridge-cmd");
  }

  /** 当前目录被删了 / 不存在时退回工作区根目录 */
  #startDir() {
    if (this.cwd && existsSync(this.cwd)) return this.cwd;
    this.cwd = this.guard?.roots?.find(r => existsSync(r)) ?? os.homedir();
    return this.cwd;
  }

  /** cwd 参数：相对路径按第一个工作区算；绝对路径只要存在就行（命令本来就能 cd 过去） */
  #resolveCwd(cwd) {
    if (!cwd) return this.#startDir();
    const base = this.guard?.roots?.[0] ?? this.#startDir();
    let dir = String(cwd).trim();
    if (IS_WINDOWS) { const m = /^\/([a-zA-Z])(\/|$)/.exec(dir); if (m) dir = `${m[1]}:\\${dir.slice(3)}`; }   // /d/work → D:\work
    const abs = path.resolve(base, dir);
    if (!existsSync(abs)) throw new Error(`cwd 不存在：${cwd}`);
    return abs;
  }

  async run(command, { mode = "auto", runInBackground = false, timeoutMs, cwd } = {}) {
    const text = String(command ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("command 不能为空");
    const risk = classifyCommand(text);
    // 默认所有命令自动执行（和 ShunCode 一样）；只有用户打开「危险命令需要人工确认」时，删除 / 强推 / 结束进程这类才等批准
    if (risk.level === "destructive" && this.autoApproveReadOnly) {
      const approved = this.approvals.get(text);
      if (!approved) {
        const approvalId = this.#requestApproval(text, risk);
        return {
          needsApproval: true,
          approvalId,
          risk,
          command: text,
          message:
            `该命令被判定为「${risk.note}」，没有自动执行，已提交到本机界面等待用户批准。\n` +
            `  用户在「Bridge → 待批准命令」里点「批准」后，原样重试同一条命令即可执行（批准一次只放行一次）。\n` +
            `  或者换用白名单里的工具（读文件、搜代码、ffmpeg/ffprobe 等）。`,
        };
      }
      this.approvals.delete(text);
    }

    const id = `cmd_${++this.counter}_${randomUUID().slice(0, 8)}`;
    const record = {
      id, command: text, status: "running", startedAt: Date.now(), endedAt: null,
      exitCode: null, risk, cwd: this.#resolveCwd(cwd), chunks: [], bytes: 0, child: null, done: null,
    };
    this.commands.set(id, record);
    this.#trim();

    try {
      await this.#spawn(record, text);
    } catch (error) {
      record.status = "failed";
      record.endedAt = Date.now();
      record.chunks.push(Buffer.from(`[启动终端失败] ${error.message}\n`));
      record.done = Promise.resolve();
    }

    if (mode === "detach" && !runInBackground) {
      return { id, command_id: id, command: text, status: record.status, cwd: record.cwd, risk, hint: "用 get_command_output 取输出，cancel_command 可中断" };
    }
    const waitMs = Math.min(Math.max(Number(timeoutMs) || DEFAULT_WAIT_MS, 1000), 600_000);
    let timer;
    const timedOut = await Promise.race([
      record.done.then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), waitMs); }),
    ]);
    clearTimeout(timer);
    const output = this.#text(record);
    return {
      id,
      command_id: id,
      exit_code: record.exitCode,
      command: text,
      status: record.status,
      output: timedOut ? `${output}\n[还在运行（已等 ${Math.round(waitMs / 1000)} 秒）：用 get_command_output 继续看输出，cancel_command 中断]` : output,
      exitCode: record.exitCode,
      durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
      cwd: record.cwd,
      timedOut,
    };
  }

  async #spawn(record, text) {
    await mkdir(this.tmpDir, { recursive: true });
    const base = path.join(this.tmpDir, record.id);
    const cmdFile = `${base}${this.posix ? ".sh" : ".ps1"}`;
    const cwdFile = `${base}.cwd`;
    const script = this.posix
      ? `cd "$BRIDGE_CWD" 2>/dev/null\ntrap '{ pwd -W 2>/dev/null || pwd; } > "$BRIDGE_CWD_FILE"' EXIT\n${text}\n`
      : text;
    await writeFile(cmdFile, script, "utf8");
    const env = {
      ...process.env,
      BRIDGE_CWD: record.cwd, BRIDGE_CMD_FILE: cmdFile, BRIDGE_CWD_FILE: cwdFile,
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_PAGER: "cat", PAGER: "cat",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = this.posix ? ["--noprofile", "--norc", cmdFile] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", PS_ENCODED];
    if (this.posix && /\/sh$/.test(this.shell)) args.splice(0, 2);
    const child = spawn(this.shell, args, { cwd: record.cwd, env, windowsHide: true, detached: !IS_WINDOWS });
    record.child = child;
    const push = (chunk) => {
      record.chunks.push(chunk);
      record.bytes += chunk.length;
      while (record.bytes > MAX_OUTPUT_BYTES && record.chunks.length > 1) record.bytes -= record.chunks.shift().length;
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.stdin.on("error", () => {});
    record.done = new Promise((resolve) => {
      const finish = async (code, error) => {
        if (record.endedAt) return resolve();
        record.endedAt = Date.now();
        if (error) push(Buffer.from(`\n[启动终端失败] ${error.message}\n`));
        record.exitCode = typeof code === "number" ? code : null;
        if (record.status === "running") record.status = record.exitCode === 0 ? "completed" : "failed";
        record.child = null;
        // 记住 cd 之后的目录，下一条命令从这里开始
        const next = (await readFile(cwdFile, "utf8").catch(() => "")).replace(/^\uFEFF/, "").trim();
        if (next && existsSync(next)) this.cwd = next;
        rm(cmdFile, { force: true }).catch(() => {});
        rm(cwdFile, { force: true }).catch(() => {});
        resolve();
      };
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => finish(code));
      // Git Bash 被强杀后，残留的子进程可能还占着输出管道，close 迟迟不来；进程退出后最多再等 1 秒
      child.on("exit", (code) => setTimeout(() => {
        if (record.endedAt) return;
        try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* 忽略 */ }
        finish(code);
      }, 1000));
    });
  }

  #text(record, tailChars = RETURN_CHARS) {
    const all = decodeOutput(Buffer.concat(record.chunks));
    return all.length > tailChars ? `…（前面省略 ${all.length - tailChars} 字）\n${all.slice(-tailChars)}` : all;
  }

  /** 只留最近的记录；还在跑的不删 */
  #trim() {
    if (this.commands.size <= KEEP_FINISHED) return;
    for (const [key, rec] of this.commands) {
      if (this.commands.size <= KEEP_FINISHED) break;
      if (rec.status !== "running") this.commands.delete(key);
    }
  }

  /**
   * 读输出。两种用法：
   *   - offset（与 ShunCode 一致）：从第 offset 个字符开始读，返回 next_offset，下次接着读不重复
   *   - tail：只看最后多少行（默认）
   */
  output(id, { tail = 200, offset, maxChars = 32_768 } = {}) {
    const record = this.commands.get(id);
    if (!record) {
      const valid = [...this.commands.keys()].slice(-10);
      throw new Error(`未知 command_id: ${id}。最近的可用的 id：${valid.join(", ") || "无"}`);
    }
    const body = decodeOutput(Buffer.concat(record.chunks));
    let text; let truncated;
    if (offset !== undefined && offset !== null) {
      const from = Math.min(Math.max(Number(offset) || 0, 0), body.length);
      text = body.slice(from, from + maxChars);
      truncated = from + maxChars < body.length;
    } else {
      const all = body.split(/\r?\n/);
      const slice = all.slice(Math.max(0, all.length - tail));
      truncated = slice.length < all.length;
      text = slice.join("\n").slice(-RETURN_CHARS);
    }
    const nextOffset = offset !== undefined && offset !== null ? Math.min(Math.max(Number(offset) || 0, 0), body.length) + text.length : body.length;
    return {
      id,
      command_id: id,
      status: record.status,
      command: record.command,
      exitCode: record.exitCode,
      exit_code: record.exitCode,
      durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
      truncated,
      text,
      offset: nextOffset,
      next_offset: nextOffset,
    };
  }

  #running(commandId) {
    if (commandId) {
      const rec = this.commands.get(commandId);
      return rec?.status === "running" ? rec : null;
    }
    return [...this.commands.values()].reverse().find(rec => rec.status === "running") ?? null;
  }

  /** 给正在运行的命令喂一行输入（交互式程序用）；不传 commandId 就给最近一条还在跑的 */
  send(input, { commandId, appendNewline = true } = {}) {
    const text = String(input ?? "");
    const record = this.#running(commandId);
    if (!record?.child) {
      return { ok: false, commandId: commandId ?? null, note: "没有正在运行的命令。send_command_input 只能给运行中的程序喂输入；要执行新命令请用 run_command" };
    }
    const risk = classifyCommand(text);
    if (risk.level === "destructive" && this.autoApproveReadOnly) {
      return { ok: false, commandId: record.id, note: `输入内容被判定为「${risk.note}」，已拦截` };
    }
    record.child.stdin.write(appendNewline ? text + (this.posix ? "\n" : "\r\n") : text);
    return { ok: true, commandId: record.id, note: "已写入" };
  }

  /** 中断：传 commandId 只停那一条（连同它启动的子进程）；不传就停掉全部在跑的 */
  async cancel(id) {
    const targets = id ? [this.commands.get(id)].filter(Boolean) : [...this.commands.values()];
    let count = 0;
    for (const record of targets) {
      if (record.status !== "running") continue;
      record.status = "cancelled";
      killTree(record.child);
      count += 1;
    }
    // 最多等 5 秒让进程收尾，不让调用方一直挂着
    await Promise.race([Promise.all(targets.map(r => r.done?.catch(() => {}))), new Promise(r => setTimeout(r, 5000))]);
    return { ok: true, id: id ?? null, cancelled: count, note: count ? `已中断 ${count} 条命令` : "没有正在运行的命令" };
  }

  /* ---------------- 人工审批 ---------------- */

  /** 登记一条待批准命令；同一条命令重复请求只保留一条。 */
  #requestApproval(command, risk) {
    for (const [approvalId, entry] of this.pendingApprovals) {
      if (entry.command === command) return approvalId;
    }
    const approvalId = `apv_${randomUUID().slice(0, 8)}`;
    const entry = { id: approvalId, command, risk, at: Date.now() };
    this.pendingApprovals.set(approvalId, entry);
    // 最多保留 50 条，防止被刷爆
    while (this.pendingApprovals.size > 50) this.pendingApprovals.delete(this.pendingApprovals.keys().next().value);
    try { this.onApprovalRequest?.(entry); } catch { /* 通知失败不影响主流程 */ }
    return approvalId;
  }

  listApprovals() {
    return [...this.pendingApprovals.values()];
  }

  /** 批准：可以传审批 id，也可以直接传命令原文。批准一次放行一次。 */
  approve(idOrCommand) {
    const key = String(idOrCommand ?? "").trim();
    const entry = this.pendingApprovals.get(key);
    const command = entry ? entry.command : key;
    if (!command) return { ok: false, error: "空命令" };
    this.approvals.set(command, true);
    if (entry) this.pendingApprovals.delete(key);
    return { ok: true, command };
  }

  reject(approvalId) {
    return { ok: this.pendingApprovals.delete(String(approvalId)) };
  }

  dispose() {
    for (const record of this.commands.values()) if (record.status === "running") killTree(record.child);
  }
}

/** list_directory：目录清单，深度 1~2，返回相对路径。默认不显示隐藏项、不展开 node_modules 等目录 */
const LIST_IGNORED = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__pycache__", ".venv", "venv", "target"]);
export async function listDirectory(input, ctx) {
  const base = input.path ?? ".";
  const info = await ctx.guard.check(base);
  const depth = Math.min(Math.max(Number(input.depth ?? 1) || 1, 1), 2);
  const maxEntries = Math.min(Math.max(Number(input.max_entries ?? input.limit ?? 200) || 200, 1), 500);
  const rows = [];
  let more = false;
  async function walk(dir, level) {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
    for (const entry of entries) {
      if (!input.include_hidden && entry.name.startsWith(".")) continue;
      if (rows.length >= maxEntries) { more = true; return; }
      const abs = path.join(dir, entry.name);
      const info2 = await stat(abs).catch(() => null);
      rows.push({
        path: ctx.guard.toRelative(abs),
        type: entry.isDirectory() ? "dir" : "file",
        bytes: entry.isDirectory() ? null : info2?.size ?? null,
        modified: info2?.mtime ? new Date(info2.mtime).toISOString() : null,
      });
      if (entry.isDirectory() && level < depth && (input.no_ignore || !LIST_IGNORED.has(entry.name))) await walk(abs, level + 1);
    }
  }
  await walk(info.abs, 1);
  const body = rows.length ? rows.map(r => `${r.type === "dir" ? "[D]" : "   "} ${r.path}${r.bytes !== null ? `  ${r.bytes} B` : ""}`).join("\n") : "目录为空。";
  return { content: [{ type: "text", text: more ? `${body}\n…只显示前 ${maxEntries} 项（调大 max_entries 或换个子目录）` : body }], structuredContent: { base: ctx.guard.toRelative(info.abs), count: rows.length, truncated: more, entries: rows } };
}

/** get_diagnostics：静态体检。没有真 LSP 时给出「可解释的降级结果」，不假装有语言服务器。 */
export async function getDiagnostics(input, ctx) {
  const target = input.path;
  const notes = [
    "未连接语言服务器：本作业未内置 LSP 客户端，以下为文件级静态检查。",
  ];
  const files = [];
  const list = target ? [target] : [];
  for (const item of list) {
    const info = await ctx.guard.check(item);
    const raw = await (await import("node:fs/promises")).readFile(info.abs, "utf8").catch(() => null);
    if (raw === null) { files.push({ path: item, error: "无法读取" }); continue; }
    const problems = [];
    const all = raw.split(/\r?\n/);
    all.forEach((line, index) => {
      if (/\t/.test(line) && /\.(js|mjs|ts|tsx|jsx|json|yml|yaml)$/i.test(info.abs)) problems.push({ line: index + 1, severity: "info", message: "包含制表符缩进" });
      if (/\bTODO\b|\bFIXME\b/.test(line)) problems.push({ line: index + 1, severity: "info", message: "遗留 TODO/FIXME" });
      if (/\bconsole\.(log|debug)\(/.test(line)) problems.push({ line: index + 1, severity: "info", message: "遗留调试输出" });
    });
    files.push({ path: ctx.guard.toRelative(info.abs), lines: all.length, problems: problems.slice(0, 50) });
  }
  const body = [notes[0], ...files.map(f => f.error ? `${f.path}：${f.error}` : `${f.path}：${f.lines} 行，${f.problems.length} 条提示`)].join("\n");
  return { content: [{ type: "text", text: body }], structuredContent: { engine: "static", notes, files } };
}

/** lsp：对外说明能力边界，避免模型乱试。 */
export async function lspTool(input, ctx) {
  const info = await ctx.guard.check(input.path ?? ".");
  return {
    content: [{ type: "text", text: `LSP 未接入。目标：${ctx.guard.toRelative(info.abs)}。本作业暂不内置语言服务器；如需符号级跳转，请接入真实 LSP 客户端。` }],
    structuredContent: { available: false, target: ctx.guard.toRelative(info.abs) },
  };
}
