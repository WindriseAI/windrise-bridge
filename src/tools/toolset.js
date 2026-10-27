/**
 * 控制面工具 + 工具注册表组装。
 *
 * 这里就是回答「为什么工具数量能有十几、二十几种」的地方，代码本身就是答案：
 *   BUILTIN = 文件 6 + IDE 9（含 2 个提权工具）+ 控制面 5 = 20
 *   再叠加 用户自定义工具（.bridge/mcp-tools/*.mjs）+ 外部 MCP 转发的工具
 * 每次 tools/list 都是这三部分求并集，所以数量天然是浮动的。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Capability, registerTools } from "../core/registry.js";
import { createBrokerClient } from "../core/broker-client.js";
import { ExternalMcpConfigStore, ExternalMcpManager } from "../core/external-mcp.js";
import { applyPatch, findFiles, readFiles, readImage, searchFiles } from "./files.js";
import { shellKind } from "./shell.js";
import { getDiagnostics as staticDiagnostics, listDirectory } from "./shell.js";
import { realDiagnostics, realLsp } from "./diagnostics.js";
import { getTsserver, parsePosition, severityText } from "../core/lsp.js";

/* ------------------------------------------------------------------ *
 * 控制面状态：任务卡 / 进度 / 审批
 * ------------------------------------------------------------------ */

export function createControlPlane({ skillsDir } = {}) {
  const state = {
    task: { taskId: null, revision: 0, todos: [], lifecycle: "idle", updatedAt: null },
    progress: [],
    mcpServers: [],
    skillsDir: skillsDir ?? null,
  };

  const seal = (status) => status === "completed" || status === "cancelled";

  return {
    state,

    /** set_todos：整表替换或补丁合并；每次写入都带 revision，避免旧写覆盖新写。 */
    setTodos(input) {
      const incoming = Array.isArray(input.todos) ? input.todos : [];
      if (input.expected_revision !== undefined && input.expected_revision !== state.task.revision) {
        return {
          isError: true,
          text: `revision 冲突：期望 ${input.expected_revision}，当前 ${state.task.revision}。请重新读取最新任务卡后再写入。`,
        };
      }
      if (input.new_task) state.task = { taskId: input.task_id ?? `task_${Date.now()}`, revision: 0, todos: [], lifecycle: "running", updatedAt: Date.now() };
      const merged = new Map((input.mode === "patch" ? state.task.todos : []).map(t => [t.id, t]));
      for (const todo of incoming) {
        if (!todo?.id) continue;
        const previous = state.task.todos.find(t => t.id === todo.id);
        if (previous && seal(previous.status) && todo.status !== previous.status) continue; // 已封口的卡片不允许改状态
        merged.set(todo.id, { id: String(todo.id), title: String(todo.title ?? "").slice(0, 400), status: todo.status ?? "pending" });
      }
      if (input.mode !== "patch") {
        const list = incoming.map(t => ({ id: String(t.id), title: String(t.title ?? "").slice(0, 400), status: t.status ?? "pending" }));
        state.task.todos = list;
      } else {
        state.task.todos = [...merged.values()];
      }
      state.task.lifecycle = input.lifecycle ?? state.task.lifecycle;
      state.task.revision += 1;
      state.task.updatedAt = Date.now();
      const inProgress = state.task.todos.filter(t => t.status === "in_progress").length;
      return {
        text: `任务卡已更新（revision ${state.task.revision}）：共 ${state.task.todos.length} 步，进行中 ${inProgress} 步，生命周期 ${state.task.lifecycle}。`,
        structuredContent: { task_id: state.task.taskId, task_revision: state.task.revision, todos: state.task.todos, lifecycle: state.task.lifecycle },
      };
    },

    /** report_progress：瞬时进度，不做持久化权威（和学习软件的语义一致）。 */
    reportProgress(input) {
      const entry = { at: new Date().toISOString(), percent: input.percent ?? null, message: String(input.message ?? "").slice(0, 400), phase: input.phase ?? null };
      state.progress.push(entry);
      if (state.progress.length > 200) state.progress.shift();
      return { text: `进度已上报：${entry.percent ?? "?"}% ${entry.message}`.trim(), structuredContent: entry };
    },

    /** list_skills：把技能目录的清单交出去。技能不是工具，是「说明书」，必须让模型读文件。 */
    async listSkills(input) {
      const dirs = [input?.directory, state.skillsDir].filter(Boolean);
      const found = [];
      for (const dir of dirs) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const base = path.join(dir, entry.name);
          const skillFile = await firstExisting([path.join(base, "SKILL.md"), path.join(base, "skill.md")]);
          const description = skillFile
            ? (await readFile(skillFile, "utf8").catch(() => "")).split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"))?.trim() ?? ""
            : "";
          found.push({
            name: entry.name,
            title: entry.name,
            description: description.slice(0, 300),
            scope: "global",
            directory: base,
            skillFile,
            enabled: true,
          });
        }
      }
      const lines = [`已安装 Skills：共 ${found.length} 个。`, ...found.map(s => `- ${s.name}：${s.description || "（无描述）"}\n  目录：${s.directory}\n  说明文件：${s.skillFile ?? "缺少 SKILL.md"}`)];
      lines.push("Skill 不是 MCP 工具：请先读取说明文件，再按需读取其引用的资源。");
      return { text: lines.join("\n"), structuredContent: { directory: state.skillsDir, enabled: true, skills: found } };
    },

    /**
     * configure_mcp：管理「别人家的 MCP」，写进配置文件并即时生效。
     *
     * 写操作（add / remove / enable / disable）都走原子写（临时文件 + fsync + rename），
     * 写完立刻让 ExternalMcpManager 失效并重连，不需要重启 Bridge。
     * 没有管理器时（例如 --list-tools 的轻量路径）退化为「只读写配置」，此时不会真的连服务器。
     *
     * 密钥：配置文件里 env / headers 的值可以是 `${VAR}`，连接时从宿主环境取，避免明文落盘；
     * list 回显时对 authorization/token/key/secret 一类字段打码。
     */
    async configureMcp(input, ctx) {
      const action = String(input.action ?? "list");
      const manager = ctx?.externalMcp ?? null;
      const store = manager?.config ?? new ExternalMcpConfigStore({ configPath: ctx?.mcpConfigPath ?? path.join(process.cwd(), "external-mcp.json") });
      const id = input.name ?? input.id;

      /** 写操作后立刻重连，并把「挂上了几个工具」如实回报。 */
      const applyAndRefresh = async (note) => {
        if (!manager) return { text: `${note} 当前没有连接管理器（轻量模式），下次启动 Bridge 时生效。`, structuredContent: { applied: false } };
        manager.invalidate();
        const refreshed = await manager.refresh({ force: true });
        const lines = [`${note} 已重连，挂载外部工具 ${refreshed.adopted.length} 个。`];
        if (refreshed.blocked.length) lines.push(`与本地工具保留名冲突未挂载：${refreshed.blocked.join(", ")}`);
        if (refreshed.errors.length) lines.push(`连接失败的服务器：${refreshed.errors.join("；")}`);
        return { text: lines.join("\n"), structuredContent: { applied: true, adopted: refreshed.adopted, blocked: refreshed.blocked, errors: refreshed.errors } };
      };

      if (action === "list") {
        if (manager) {
          const { rows, errors } = await manager.statusRows();
          const lines = rows.length
            ? rows.map(row => `${row.id}（${row.label}）· ${row.transport} · ${row.status} · ${row.toolCount} 个工具 → ${row.target}${row.reason ? `｜${row.reason}` : ""}`)
            : ["尚未配置任何外部 MCP 服务器。"];
          if (errors.length) lines.push(`配置里有问题的条目：${errors.map(e => `${e.name}（${e.reason}）`).join("；")}`);
          lines.push(`配置文件：${manager.configPath}`);
          return { text: lines.join("\n"), structuredContent: { servers: rows, errors, configPath: manager.configPath } };
        }
        const { servers, errors } = await store.servers();
        // 轻量模式没有管理器：结构化结果里不能带 headers / env（可能含凭据）
        const safeServers = servers.map(({ headers: _headers, env: _env, ...rest }) => rest);
        return {
          text: servers.length ? servers.map(s => `${s.id}（${s.label}）· ${s.transport} · ${s.enabled ? "已启用" : "已停用"}`).join("\n") : "尚未配置任何外部 MCP 服务器。",
          structuredContent: { servers: safeServers, errors, configPath: store.configPath },
        };
      }

      if (action === "add") {
        if (!id) throw new Error("add 需要 name（服务器 id，会作为工具名前缀）");
        if (!input.url && !input.command) throw new Error("add 需要 url（http 型）或 command（stdio 型）");
        const raw = {
          ...(input.label ? { label: String(input.label) } : {}),
          ...(input.transport ? { transport: input.transport } : {}),
          ...(input.httpTransport ? { httpTransport: input.httpTransport } : {}),
          ...(input.url ? { url: String(input.url) } : { command: String(input.command), args: (input.args ?? []).map(String) }),
          ...(input.env ? { env: input.env } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.cwd ? { cwd: String(input.cwd) } : {}),
          ...(input.timeout !== undefined ? { timeout: Number(input.timeout) } : {}),
          enabled: input.enabled !== false,
          ...(input.tool_allow || input.tool_deny
            ? { tools: { allow: (input.tool_allow ?? []).map(String), deny: (input.tool_deny ?? []).map(String) } }
            : {}),
        };
        const saved = await store.upsert({ name: id, ...raw });
        const result = await applyAndRefresh(`已登记外部 MCP 服务器 ${saved.id}（${saved.transport}）。`);
        return { text: result.text, structuredContent: { name: saved.id, transport: saved.transport, ...result.structuredContent } };
      }

      if (action === "remove") {
        if (!id) throw new Error("remove 需要 name");
        const existed = await store.remove(id);
        const result = await applyAndRefresh(existed ? `已从配置移除 ${id}。` : `配置里本来就没有 ${id}。`);
        return { text: result.text, structuredContent: { name: id, existed, ...result.structuredContent } };
      }

      if (action === "enable" || action === "disable") {
        if (!id) throw new Error(`${action} 需要 name`);
        const enabled = action === "enable";
        await store.setEnabled(id, enabled);
        const result = await applyAndRefresh(`已${enabled ? "启用" : "停用"} ${id}。`);
        return { text: result.text, structuredContent: { name: id, enabled, ...result.structuredContent } };
      }

      if (action === "reload") {
        if (!manager) return { text: "当前没有连接管理器（轻量模式），无需重连。", structuredContent: { applied: false } };
        const result = await applyAndRefresh("已重新读取配置。");
        const rows = (await manager.statusRows()).rows;
        const lines = [result.text, ...rows.map(row => `  ${row.id}：${row.status}（${row.toolCount} 个工具）${row.reason ? `｜${row.reason}` : ""}`)];
        return { text: lines.join("\n"), structuredContent: { ...result.structuredContent, servers: rows } };
      }

      if (action === "test") {
        if (!id) throw new Error("test 需要 name");
        // 真的连一次、拉一次工具清单，用实际结果回答「能不能用」。
        const probe = manager ?? new ExternalMcpManager({ configPath: store.configPath, log: () => {} });
        try {
          const report = await probe.probe(id);
          return {
            text: `${id} 连接成功（${report.transport}，${report.durationMs} ms），工具 ${report.toolCount} 个：${report.tools.join(", ") || "（无）"}`,
            structuredContent: { name: id, reachable: true, ...report },
          };
        } catch (error) {
          const classified = error?.name === "TimeoutError" ? "连接超时" : error.message;
          return { text: `${id} 连接失败：${classified}`, structuredContent: { name: id, reachable: false, reason: classified }, isError: false };
        } finally {
          if (!manager) await probe.dispose().catch(() => {});
        }
      }

      throw new Error(`不支持的 action：${action}（可用 list/add/remove/enable/disable/reload/test）`);
    },
  };
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 工具定义表：20 个内置工具
 * ------------------------------------------------------------------ */

const S = {
  type: "object",
  additionalProperties: true,
};

/** command_id / commandId / id 都认（不同客户端写法不一样） */
function pickCommandId(input) {
  const raw = input?.command_id ?? input?.commandId ?? input?.id;
  const match = /cmd_[A-Za-z0-9_]+/.exec(String(raw ?? ""));
  return match ? match[0] : raw;
}

function runCommandDescription(terminal) {
  const kind = shellKind(terminal?.shell);
  const shellText = {
    "git-bash": "终端是 Git Bash（bash 语法；路径可以写 /c/... 或 C:/...；要用 Windows 专有功能时显式调用 powershell.exe）",
    bash: "终端是 bash",
    pwsh: "终端是 PowerShell 7（不是 bash；支持 &&）",
    powershell: "终端是 Windows PowerShell 5（不是 bash；不支持 &&，用 ; 或 if ($?) { } 连接命令）",
  }[kind];
  return `在本机执行命令或多行脚本。${shellText}。每条命令单独运行：cd 后的目录会带到下一条，环境变量不保留。` +
    "默认等命令结束（最多 timeout_ms，默认 120 秒）；超时不会杀掉命令，而是返回 status=running 和 command_id，之后用 get_command_output 继续看。" +
    "服务器、监视进程这类长期运行的用 background=true。工作区外的文件夹也可以用它查看（cwd 写绝对路径）。" +
    "命令自动执行；如果用户打开了「危险命令需要人工确认」，删除、强推、结束进程这类会先等用户在本机批准（返回里会说明）。修改文件优先用 apply_patch。";
}

/** 提权结果进入 MCP 前只留尾部：命令输出可能有几十万字符，隧道和模型都吃不消。 */
function clipAdminOutput(text, limit = 20_000) {
  const value = String(text ?? "");
  return value.length > limit ? `…（前面省略 ${value.length - limit} 字）\n${value.slice(-limit)}` : value;
}

function adminFailure(error) {
  const reason = String(error?.message ?? error ?? "未知错误");
  return {
    content: [{ type: "text", text: `提权执行失败：${reason}` }],
    structuredContent: { status: "error", code: error?.code ?? null, reason },
    isError: true,
  };
}

/** 把 broker 的几种回应统一成 MCP 工具结果。 */
function formatAdminResult(result) {
  if (!result || typeof result !== "object") {
    return { content: [{ type: "text", text: "管理员代理没有返回有效结果。" }], structuredContent: { status: "error" }, isError: true };
  }
  if (result.status === "executed") {
    const stdout = clipAdminOutput(result.stdout);
    const stderr = clipAdminOutput(result.stderr);
    const head = `status: executed\nexit_code: ${result.code ?? "null"}${result.timedOut ? "（超时，已尝试结束进程）" : ""}\nduration_ms: ${result.durationMs ?? "?"}`;
    return {
      content: [{ type: "text", text: `${head}\n--- stdout ---\n${stdout || "(无输出)"}\n--- stderr ---\n${stderr || "(无输出)"}` }],
      structuredContent: {
        status: "executed",
        exit_code: result.code,
        // 和文本一致只带尾部 20k：bridge 的超限句柄只看 content，不量 structuredContent
        stdout,
        stderr,
        timed_out: Boolean(result.timedOut),
        duration_ms: result.durationMs ?? null,
      },
      isError: false,
    };
  }
  if (result.status === "needs_confirm") {
    return {
      content: [{
        type: "text",
        text: `这条命令**尚未执行**，需要用户确认。\n`
          + `命令：${result.command}\n`
          + `风险：${result.reason}\n`
          + `pending_id: ${result.id}\n`
          + `有效期至：${result.expiresAt ?? "默认 5 分钟"}\n\n`
          + `请把「命令原文 + 风险」原样转告用户。只有用户明确回复「确认」后，才能调用 admin_confirm（pending_id 用上面这个）；`
          + `用户回「取消」或超时就不要执行。pending_id 只能用一次，不能拿去确认别的命令。`,
      }],
      structuredContent: {
        status: "needs_confirm",
        pending_id: result.id,
        command: result.command,
        reason: result.reason,
        expires_at: result.expiresAt ?? null,
      },
      isError: false,
    };
  }
  if (result.status === "denied") {
    return {
      content: [{ type: "text", text: `管理员代理拒绝执行：${result.reason}\n这是明确毁灭性的命令，不提供确认机会，请换安全做法。` }],
      structuredContent: { status: "denied", code: "BROKER_DENIED", reason: result.reason },
      isError: true,
    };
  }
  if (result.status === "expired") {
    return {
      content: [{ type: "text", text: `这条待确认命令已过期，没有执行：${result.reason}` }],
      structuredContent: { status: "expired", reason: result.reason },
      isError: true,
    };
  }
  if (result.status === "cancelled") {
    return {
      content: [{ type: "text", text: "这条待确认命令已取消，没有执行。" }],
      structuredContent: { status: "cancelled" },
      isError: false,
    };
  }
  return {
    content: [{ type: "text", text: `管理员代理报错：${result.reason ?? "未知错误"}` }],
    structuredContent: { status: "error", reason: result.reason ?? null },
    isError: true,
  };
}

export function defineBuiltinTools({ control, terminal, guard, mcpConfigPath, externalMcp, broker }) {
  const baseContext = { guard, terminal, mcpConfigPath, externalMcp, guardRoots: guard?.roots };
  const brokerClient = broker ?? createBrokerClient();
  /**
   * 统一 handler 约定：handler(input) 或 handler(input, ctx)。
   * 外部 MCP 转发来的工具会收到同一个 ctx，并多出一个 forward()，
   * 这样「本地工具」和「转发的工具」在协议层是同一类东西。
   */
  const wrap = (fn) => async (input, incoming) => fn(input ?? {}, { ...baseContext, ...(incoming ?? {}) });

  return [
    // ---------- 文件类（6）----------
    {
      name: "read_files", title: "读取文件", capability: Capability.READ,
      description: "读取一个或多个文本文件（UTF-8），带行号。独立的文件请放在同一次调用里。小文件不用写行号，读全文；大文件会自动截断并给出 next_start_line，或者先用 search_files 定位再带 start_line/end_line 读。每个文件返回 version，可传给 apply_patch 的 expected_versions。路径限于 Bridge 设置里的工作区文件夹；工作区外的文件用 run_command 去看（cat、ls 等），或请用户在 Windrise Bridge「设置 → 工作区」里添加该文件夹。",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", maxItems: 20, items: { type: "object", properties: { path: { type: "string", description: "工作区内路径，相对或绝对都行" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["path"] } },
          path: { type: "string", description: "只读一个文件时也可以直接写 path" },
        },
        additionalProperties: true,
      },
      handler: wrap(readFiles),
    },
    {
      name: "read_image", title: "查看图片", capability: Capability.READ,
      description: "读取本地图片并以图像内容返回（支持 png/jpg/jpeg/gif/webp）。用于界面截图、图纸、图表类理解；只在需要看图时调用。",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
      handler: wrap(readImage),
    },
    {
      name: "find_files", title: "查找文件", capability: Capability.READ,
      description: "按文件名 / 路径的 glob 模式找文件（不搜内容，搜内容用 search_files）。只写文件名的模式（如 '*.ts'）在所有层级匹配。多个模式放进同一次调用的 patterns 数组。默认跳过隐藏文件和 node_modules/.git/dist 等目录，按修改时间新到旧排序。",
      inputSchema: {
        type: "object",
        properties: {
          patterns: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "例如 ['**/*.md', 'package.json']" },
          path: { type: "string", description: "在哪个目录下找，默认工作区根目录" },
          exclude: { type: "array", items: { type: "string" } },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
          include_hidden: { type: "boolean" },
          no_ignore: { type: "boolean" },
          case_sensitive: { type: "boolean" },
          sort: { type: "string", enum: ["modified_desc", "path_asc"] },
        },
        required: ["patterns"],
        additionalProperties: true,
      },
      handler: wrap(findFiles),
    },
    {
      name: "search_files", title: "搜索内容", capability: Capability.READ,
      description: "在工作区文件内容里搜索，返回 文件:行号 和命中行。默认按原文搜（is_regex=true 才当正则）；大小写默认智能判断（全小写不区分）。用 path 缩小目录或指定单个文件，include/exclude 过滤文件，context_lines 带上前后几行。",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1 },
          path: { type: "string" },
          include: { type: "array", items: { type: "string" }, description: "例如 ['**/*.ts']" },
          exclude: { type: "array", items: { type: "string" } },
          is_regex: { type: "boolean" },
          case_sensitive: { type: "boolean" },
          context_lines: { type: "integer", minimum: 0, maximum: 20 },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
          max_matches_per_file: { type: "integer", minimum: 1, maximum: 100 },
          include_hidden: { type: "boolean" },
          no_ignore: { type: "boolean" },
        },
        required: ["pattern"],
        additionalProperties: true,
      },
      handler: wrap(searchFiles),
    },
    {
      name: "apply_patch", title: "应用补丁", capability: Capability.WRITE,
      description: "用一个 Codex 格式补丁修改工作区文件。以 '*** Begin Patch' 开头、'*** End Patch' 结尾；支持 '*** Add File: 路径'（内容每行以 + 开头）、'*** Update File: 路径'（可跟 '*** Move to: 新路径'）、'*** Delete File: 路径'。@@ 段里上下文行以空格开头，删除行以 -，新增行以 +；@@ 后面可以写函数名等标题帮助定位，不需要行号。先 read_files 看过再改。任何一个文件对不上就整体不改（不会改一半）；保留原文件的换行风格和 BOM。可传 expected_versions（read_files 返回的 version）防止改到过期内容。",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string", minLength: 1 },
          expected_versions: { type: "object", additionalProperties: { type: "string" }, description: "路径 → read_files 返回的 sha256:... version" },
        },
        required: ["patch"],
        additionalProperties: true,
      },
      handler: wrap(applyPatch),
    },
    {
      name: "batch_file_tools", title: "批量文件操作", capability: Capability.WRITE,
      description: "把多个只读文件操作打包成一次调用（例如同时读 5 个文件、同时搜 3 个模式），减少往返次数。仅接受只读类子操作。",
      inputSchema: { type: "object", properties: { calls: { type: "array", items: { type: "object" } } }, required: ["calls"], additionalProperties: true },
      handler: wrap(async (input, ctx2) => {
        const results = [];
        for (const call of (input.calls ?? []).slice(0, 20)) {
          const name = call?.tool ?? call?.name;
          try {
            const sub = BUILTIN_BY_NAME.get(name);
            if (!sub) throw new Error(`不支持的子操作：${name}`);
            if (sub.capability !== Capability.READ) throw new Error(`${name} 不是只读操作，不能放进批量调用`);
            results.push({ tool: name, result: await sub.handler(call.arguments ?? call.args ?? {}, ctx2) });
          } catch (error) {
            results.push({ tool: name, error: error.message });
          }
        }
        return {
          content: [{ type: "text", text: `批量执行 ${results.length} 项：${results.map(r => `${r.tool}${r.error ? "失败" : "完成"}`).join("、")}` }],
          structuredContent: { count: results.length, results },
        };
      }),
    },

    // ---------- IDE / 终端类（9）----------
    {
      name: "list_directory", title: "列目录", capability: Capability.READ,
      description: "列出工作区内某个目录的内容（深度 1 或 2）。按文件名找请用 find_files。工作区外的目录用 run_command 执行 ls 查看。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "默认工作区根目录" },
          depth: { type: "integer", enum: [1, 2] },
          include_hidden: { type: "boolean" },
          max_entries: { type: "integer", minimum: 1, maximum: 500 },
          no_ignore: { type: "boolean", description: "展开 node_modules、.git、dist 等目录" },
        },
        additionalProperties: true,
      },
      handler: wrap(listDirectory),
    },
    {
      name: "run_command", title: "执行命令", capability: Capability.EXECUTE,
      description: runCommandDescription(terminal),
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, description: "命令或多行脚本原文，直接写，不要再套一层 bash -c / powershell -Command" },
          cwd: { type: "string", description: "工作目录。相对路径按第一个工作区算；也可以写工作区外的绝对路径。不写就接着上一条命令所在的目录" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 600000, description: "最多等多久（默认 120000）。到时间命令不会被杀，会先返回 status=running" },
          background: { type: "boolean", description: "长期运行的服务 / 监视进程设为 true，立即返回 command_id" },
        },
        required: ["command"],
        additionalProperties: true,
      },
      handler: async (input) => {
        const background = input?.background === true || input?.mode === "detach";
        const result = await terminal.run(input?.command, { mode: background ? "detach" : "auto", timeoutMs: input?.timeout_ms ?? input?.timeoutMs ?? 120_000, cwd: input?.cwd });
        if (result.needsApproval) return { content: [{ type: "text", text: result.message }], structuredContent: result, isError: false };
        if (result.output === undefined) return { content: [{ type: "text", text: `command_id: ${result.id}\nstatus: running（后台运行，用 get_command_output 看输出）\ncwd: ${result.cwd}` }], structuredContent: result };
        const head = `command_id: ${result.id}\nstatus: ${result.status}\nexit_code: ${result.exitCode ?? "null"}\ncwd: ${result.cwd}\nduration_ms: ${result.durationMs}`;
        return { content: [{ type: "text", text: `${head}\n--- 输出 ---\n${result.output || "(无输出)"}` }], structuredContent: result };
      },
    },
    {
      name: "admin_run", title: "提权执行", capability: Capability.EXECUTE,
      description: "以管理员权限执行命令（走本机常驻的提权代理 WindriseElevatedBroker；Windows 下用 PowerShell 语法）。"
        + "自动执行的只有少数只读查询（查进程 / 服务 / 端口 / 事件日志、tasklist、netstat）和按名字启动 / 重启服务；"
        + "其余命令（包括安装软件、修改文件、改系统设置、删除、格式化、关机、停防火墙 / 杀软等）一律**不会自动执行**，"
        + "会返回 pending_id 和风险说明。"
        + "必须先把原命令和风险如实转告用户，用户明确回复「确认」后再调用 admin_confirm；"
        + "确认只依赖 AI 把命令和风险如实转告用户，代理本身无法核实用户是否真的同意。"
        + "明确毁灭性的命令（格式化系统盘、全盘删除、覆盖物理磁盘等）会被直接拒绝，连确认都不给。"
        + "管理员代理没运行时会明确报「管理员代理未运行」，不会降级成普通权限偷偷执行。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, description: "要执行的命令原文（Windows 下按 PowerShell 语法写）" },
          cwd: { type: "string", description: "工作目录。必须在管理员代理允许的范围内（本软件目录）；不写就用默认目录" },
        },
        required: ["command"],
        additionalProperties: true,
      },
      handler: async (input) => {
        try {
          return formatAdminResult(await brokerClient.runElevated(input?.command, { cwd: input?.cwd }));
        } catch (error) {
          return adminFailure(error);
        }
      },
    },
    {
      name: "admin_confirm", title: "确认提权命令", capability: Capability.EXECUTE,
      description: "确认并执行一条 admin_run 返回的待确认命令。"
        + "调用前必须把命令原文和风险如实转告用户，只有用户明确回复「确认」后才能调用；"
        + "确认只依赖 AI 如实转告，代理本身无法核实用户是否真的同意。"
        + "pending_id 只能使用一次（执行、取消或过期后立即失效），默认 5 分钟过期。"
        + "可以带 command 原文用于核对，和 pending 绑定的命令不一致时管理员代理会拒绝执行。",
      inputSchema: {
        type: "object",
        properties: {
          pending_id: { type: "string", minLength: 1, description: "admin_run 返回的 pending_id" },
          command: { type: "string", description: "可选：原命令，用于核对" },
        },
        required: ["pending_id"],
        additionalProperties: true,
      },
      handler: async (input) => {
        const pendingId = input?.pending_id ?? input?.pendingId ?? input?.id;
        try {
          return formatAdminResult(await brokerClient.confirmElevated(pendingId, { command: input?.command }));
        } catch (error) {
          return adminFailure(error);
        }
      },
    },
    {
      name: "get_command_output", title: "读取命令输出", capability: Capability.READ,
      description: "读取之前 run_command 的输出、状态和 exit_code。传 run_command 返回的 command_id。接着上次读时把返回的 next_offset 作为 offset 传入，避免重复。",
      inputSchema: {
        type: "object",
        properties: {
          command_id: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 0 },
          max_bytes: { type: "integer", minimum: 1, maximum: 131072 },
        },
        required: ["command_id"],
        additionalProperties: true,
      },
      handler: async (input) => {
        const commandId = pickCommandId(input);
        if (!commandId) throw new Error("需要 command_id（run_command 返回的那个 cmd_... ）");
        const result = terminal.output(commandId, { tail: input.tail ?? 200, offset: input.offset ?? (input.tail ? undefined : 0), maxChars: input.max_bytes ?? 32_768 });
        return { content: [{ type: "text", text: `command_id: ${result.id}\nstatus: ${result.status}\nexit_code: ${result.exitCode ?? "null"}\nnext_offset: ${result.next_offset}${result.truncated ? "（还有更多，接着用这个 offset 读）" : ""}\n--- 输出 ---\n${result.text || "(暂无输出)"}` }], structuredContent: result };
      },
    },
    {
      name: "send_command_input", title: "向命令喂输入", capability: Capability.EXECUTE,
      description: "给正在运行的命令写入输入（交互式提示、REPL）。默认在末尾加换行。",
      inputSchema: {
        type: "object",
        properties: {
          command_id: { type: "string", minLength: 1 },
          input: { type: "string" },
          append_newline: { type: "boolean" },
        },
        required: ["command_id", "input"],
        additionalProperties: true,
      },
      handler: async (input) => {
        const result = terminal.send(input.input, { commandId: pickCommandId(input), appendNewline: input.append_newline !== false });
        return { content: [{ type: "text", text: result.ok ? `已写入（command_id ${result.commandId}）。` : result.note }], structuredContent: result, isError: !result.ok };
      },
    },
    {
      name: "cancel_command", title: "中断命令", capability: Capability.EXECUTE,
      description: "中断一条正在运行的命令（连同它启动的子进程）。传 run_command 返回的 command_id。",
      inputSchema: {
        type: "object",
        properties: { command_id: { type: "string", minLength: 1 } },
        required: ["command_id"],
        additionalProperties: true,
      },
      handler: async (input) => {
        const result = await terminal.cancel(pickCommandId(input));
        return { content: [{ type: "text", text: result.note }], structuredContent: result };
      },
    },
    {
      name: "get_diagnostics", title: "诊断检查", capability: Capability.READ,
      description: "对指定文件或目录做真实的类型与语法检查（TypeScript 语言服务引擎，与编辑器诊断一致）。语言服务不可用时会自动降级为文件级静态体检，并明确说明降级原因。这是快照，不是全量覆盖；要判断「能不能跑」请另行执行测试命令。",
      inputSchema: { type: "object", properties: { path: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, additionalProperties: true },
      handler: wrap(realDiagnostics),
    },
    {
      name: "lsp", title: "语言服务", capability: Capability.READ,
      description: "语言服务查询，基于 TypeScript 官方引擎（tsserver）。支持的操作：status（看引擎状态）、definition（跳定义）、references（找引用）、symbols（列文件符号）、quickinfo（看类型）、completion（看补全）。需要带 path，定位类操作还要 line 与 offset。",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["status", "definition", "references", "symbols", "quickinfo", "completion"] },
          path: { type: "string" },
          line: { type: "integer" },
          offset: { type: "integer" },
          position: { type: "string", description: "也可以写成 '12:5' 这种 行:列" },
        },
        required: ["operation"],
        additionalProperties: true,
      },
      handler: wrap(realLsp),
    },

    // ---------- 控制面（5）----------
    {
      name: "set_todos", title: "设置任务卡", capability: Capability.CONTROL,
      description: "维护当前任务的任务卡。开始时用 new_task=true 开一张新卡；后续用 mode=patch 增量更新（需带 expected_revision）。已完成/已取消的卡片会封口，只允许改未封口的步骤。最多一个 in_progress。",
      inputSchema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled", "blocked"] } }, required: ["id", "title", "status"] } }, mode: { type: "string", enum: ["replace", "patch"] }, expected_revision: { type: "integer" }, new_task: { type: "boolean" }, task_id: { type: "string" }, lifecycle: { type: "string" } }, required: ["todos"], additionalProperties: true },
      handler: async (input) => {
        const result = control.setTodos(input ?? {});
        return result.isError
          ? { content: [{ type: "text", text: result.text }], isError: true, structuredContent: { conflict: true } }
          : { content: [{ type: "text", text: result.text }], structuredContent: result.structuredContent };
      },
    },
    {
      name: "update_plan", title: "更新计划", capability: Capability.CONTROL,
      description: "set_todos 的别名，语义完全相同：用于同步任务卡的完整快照。二者任选其一即可，不要同时写。",
      inputSchema: { type: "object", properties: { todos: { type: "array", items: { type: "object" } }, mode: { type: "string" }, expected_revision: { type: "integer" } }, required: ["todos"], additionalProperties: true },
      handler: async (input) => {
        const result = control.setTodos(input ?? {});
        return { content: [{ type: "text", text: result.text }], structuredContent: result.structuredContent ?? {}, isError: Boolean(result.isError) };
      },
    },
    {
      name: "report_progress", title: "上报进度", capability: Capability.CONTROL,
      description: "上报一次瞬时进度（百分比 + 一句话 + 阶段名），用于长任务过程中的可见反馈。它不是任务卡，不承担持久调度职责。",
      inputSchema: { type: "object", properties: { percent: { type: "number" }, message: { type: "string" }, phase: { type: "string" } }, additionalProperties: true },
      handler: async (input) => {
        const result = control.reportProgress(input ?? {});
        return { content: [{ type: "text", text: result.text }], structuredContent: result.structuredContent };
      },
    },
    {
      name: "list_skills", title: "列出技能", capability: Capability.READ,
      description: "列出本机已安装的技能目录及其根说明文件路径。技能是「说明书文件夹」而不是工具：得到清单后要读 SKILL.md 及其引用文件，不要把技能名当工具调用。",
      inputSchema: { type: "object", properties: { directory: { type: "string" } }, additionalProperties: true },
      handler: async (input) => {
        const result = await control.listSkills(input ?? {});
        return { content: [{ type: "text", text: result.text }], structuredContent: result.structuredContent };
      },
    },
    {
      name: "configure_mcp", title: "配置外部 MCP", capability: Capability.WRITE,
      description: "管理本机连接的外部 MCP 服务器，并把这些服务器的工具代理进本桥的工具清单（对外名 ext__<服务器>__<工具>）。"
        + "action：list 查看配置与连接状态、add 新增（HTTP 地址或本地命令）、remove 删除、enable/disable 启停、reload 重读配置并重连、test 真连一次看能不能用。"
        + "写操作会原子改写配置文件并立即重连，不需要重启。env/headers 的值可以写 ${VAR} 从宿主环境取，避免密钥明文落盘。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove", "enable", "disable", "reload", "test"] },
          name: { type: "string", description: "服务器 id（同时用作工具名前缀，只允许字母数字与 . _ -）" },
          label: { type: "string", description: "显示名（出现在工具 title 里）" },
          transport: { type: "string", enum: ["stdio", "http"], description: "省略时按 url/command 自动判断" },
          httpTransport: { type: "string", enum: ["auto", "streamable-http", "sse"], description: "http 型专用；auto 时先试 streamable-http" },
          url: { type: "string" },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          headers: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
          timeout: { type: "number", description: "连接/调用超时，单位秒（默认 连接 5s / 列工具 3s / 调用 20s）" },
          enabled: { type: "boolean" },
          tool_allow: { type: "array", items: { type: "string" }, description: "只挂载这些上游工具（白名单，按上游原名）" },
          tool_deny: { type: "array", items: { type: "string" }, description: "不挂载这些上游工具（黑名单，按上游原名）" },
        },
        required: ["action"],
        additionalProperties: true,
      },
      handler: async (input, incoming) => {
        const ctx = { ...baseContext, ...(incoming ?? {}) };
        const result = await control.configureMcp(input ?? {}, ctx);
        return { content: [{ type: "text", text: result.text }], structuredContent: result.structuredContent, isError: Boolean(result.isError) };
      },
    },
  ];
}

/** 供 batch_file_tools 反查子操作。 */
export const BUILTIN_BY_NAME = new Map();

/** 注册内置工具集，返回注册后的完整清单。 */
export function installBuiltinTools(options) {
  const tools = defineBuiltinTools(options);
  BUILTIN_BY_NAME.clear();
  for (const tool of tools) BUILTIN_BY_NAME.set(tool.name, tool);
  registerTools(tools);
  return tools;
}
