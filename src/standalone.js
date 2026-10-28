#!/usr/bin/env node
/**
 * 独立运行模式 —— 不开 UI 就能把 Bridge 跑起来，方便先验证协议层。
 *
 *   node src/standalone.js              启动并常驻
 *   node src/standalone.js --list-tools 只打印工具清单
 *   node src/standalone.js --self-test  自检：启动 → 握手 → tools/list → 调用一次 → 退出
 *   node src/standalone.js --tunnel     启动后拉一条 Cloudflare 临时隧道
 */

import os from "node:os";
import path from "node:path";
import { createPathGuard } from "./core/guard.js";
import { installBuiltinTools, createControlPlane } from "./tools/toolset.js";
import { TerminalManager } from "./tools/shell.js";
import { BridgeServer } from "./core/bridge.js";
import { ConnectorStore, connectorsFile } from "./core/connectors.js";
import { OwnerAuthStore, ownerAuthFile } from "./core/bearer-auth.js";
import { loadOrCreateRouteToken } from "./core/route-token.js";
import { listExternalTools, listTools, registerTools, reservedToolNames } from "./core/registry.js";
import { ExternalMcpConfigStore, ExternalMcpManager } from "./core/external-mcp.js";
import { WorkspaceHub, describeWorkspace, workspaceHubRoot } from "./core/workspace.js";
import { TunnelManager } from "./core/tunnel.js";
import { ContextBus, defaultContextBusFile } from "./core/context-bus.js";
import { defineBrowserTools, browserControlAvailable } from "./tools/browser.js";
import { defineAppTools } from "./tools/app.js";
import { defineFlowTools } from "./tools/flow.js";
import { flowDraftsDir } from "./core/flow-draft.js";
import { createCallLog } from "./core/call-log.js";
import { createFlowStepLogger } from "./core/flow-audit.js";
import { defineContextTools } from "./tools/context.js";
import { installCustomTools, defineCustomToolAdmin } from "./tools/custom.js";

export async function boot({ roots, workspace, dataHome, onLog = () => {}, instructions, browser = true, context = true, port, options, healthProbes, startupGraceMs, resultLimitBytes, connectors: providedConnectors, profileExists, toolTier = "basic", remoteGate = null, remoteGateTtlMs = 90_000, oauth = null } = {}) {
  const cwd = roots?.[0] ?? process.cwd();
  const home = dataHome ?? (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"));
  // 连接器：显式传进来的（桌面端要拿去做设置页）优先，没有就自己按数据目录建一个。
  // 纯命令行模式没有界面，但令牌路由照样生效。
  const connectorStore = providedConnectors ?? new ConnectorStore({ file: connectorsFile(home) });
  // 主身份的口令和「公网允许路径令牌」开关（2026-10-25，见 core/bearer-auth.js）
  const ownerAuthStore = new OwnerAuthStore({ file: ownerAuthFile(home) });
  const guard = createPathGuard(roots ?? [cwd]);
  const control = createControlPlane({ skillsDir: path.join(dataHome ?? (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica")), "skills") });
  /*
   * 这个参数之前**根本没传**，所以界面上那个「危险命令需要人工确认」开关是死的
   * —— 不管勾没勾，非白名单命令都会被拦，而且没有地方能批准。
   * 实测踩过：agent 想跑 ffmpeg 处理视频，直接被卡住。
   */
  const terminal = new TerminalManager({
    guard,
    cwd,
    autoApproveReadOnly: options?.approveDangerous === true, // 默认全部自动执行，和桌面版一致
    onApprovalRequest: (entry) => onLog({ kind: "approval-request", ...entry }),
  });
  const mcpConfigPath = path.join(dataHome ?? (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica")), "external-mcp.json");

  /**
   * 外部 MCP 转发：启动时读配置并连接所有启用的服务器。
   * 顺序很关键 —— 先建管理器（不连），再装内置工具（configure_mcp 要拿到它），最后才连。
   * 单个服务器连不上只记日志，绝不让整个 Bridge 起不来。
   */
  let notifyToolListChanged = () => {};
  const externalMcp = new ExternalMcpManager({
    configPath: mcpConfigPath,
    log: (text) => onLog({ kind: "external-mcp", text }),
    onChanged: () => notifyToolListChanged(),
  });

  installBuiltinTools({ control, terminal, guard, mcpConfigPath, externalMcp });

  /*
   * 流程草稿：纯本地文件（<数据目录>/flows/drafts），不需要界面，所以总是挂载。
   * 放在这里而不是内置工具表里：草稿要读写 dataHome，只有 boot 知道它在哪。
   * 重放的每一步写进单独的重放审计（<数据目录>/logs/flow-replay/），不写 mcp-calls ——
   * 那份日志是 flow_save_draft 抽取草稿的唯一来源，写进去会污染用户真正想存的那次会话。
   */
  const flowCallLog = createCallLog({
    dir: path.join(home, "logs", "flow-replay"),
    onError: (line) => onLog({ kind: "call-log", text: line }),
  });
  /**
   * 重放的审计（复用 call-log 的脱敏 / 追加逻辑）：step / refused / end 都落盘。
   * 只记步骤号 / 动作 / 按键 / 目标 / 原因 / 汇总，不记任何输入值（values / vars 一个都不传）。
   */
  const logFlowStep = createFlowStepLogger({ callLog: flowCallLog });
  registerTools(defineFlowTools({ dataHome: home, logStep: logFlowStep }));

  // 浏览器工具只在控制面板开着的时候挂上去（窗口只能由 Electron 主进程创建）
  let browserTools = 0;
  if (browser && await browserControlAvailable()) {
    registerTools(defineBrowserTools());
    browserTools = defineBrowserTools().length;
    // 软件本身的控制（windrise_*）：同一条通道，同样只在界面开着时挂
    const appTools = defineAppTools();
    registerTools(appTools);
    onLog({ kind: "browser-tools", text: `已挂载 ${browserTools} 个浏览器工具、${appTools.length} 个软件控制工具` });
  }

  /**
   * 共享上下文总线：纯本地存储，不依赖界面，所以**总是挂载**（跟 browser 那套不同）。
   * 数据文件跟其它配置放一起（dataHome 下），主进程那边传的也是同一个路径。
   * 初始化失败不拦启动：工具照样注册，调用时会把真实错误抛给 Agent（宁可可用可报错，也不要静默少工具）。
   */
  const contextFile = dataHome ? path.join(dataHome, "context-bus.json") : defaultContextBusFile();
  let contextBus = null;
  let contextTools = [];
  let contextReady = false;
  if (context) {
    contextBus = new ContextBus({
      file: contextFile,
      log: (line) => onLog({ kind: "context", text: String(line) }),
    });
    try {
      await contextBus.initialize();
      contextReady = true;
    } catch (error) {
      // 初始化失败也把工具挂上：调用时会抛出这个真实错误，比"工具凭空消失"好排查
      onLog({ kind: "context", text: `共享上下文总线初始化失败（工具仍会挂载，调用时会报这个错）：${error.message}` });
    }
    contextTools = defineContextTools({ bus: contextBus, log: (line) => onLog({ kind: "context", text: line }) });
    registerTools(contextTools);
    onLog({ kind: "context-tools", text: `已挂载 ${contextTools.length} 个共享上下文工具（数据文件：${contextFile}）` });
  }

  /*
   * 用户自定义工具（界面「工具 → 新建工具」，存在 <数据目录>/custom-tools.json）。
   * 放在外部 MCP 之前：保留名集合包含它们；撞内置名的会被跳过并记日志。
   */
  let customTools = { loaded: [], errors: [] };
  const customHome = dataHome ?? (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"));
  // 让 Agent 能一句话替用户加工具（custom_tool_list / save / remove）
  registerTools(defineCustomToolAdmin({ dataHome: customHome, cwd, onChanged: () => notifyToolListChanged(), log: (text) => onLog({ kind: "custom-tools", text }) }));
  try {
    customTools = await installCustomTools(customHome, { cwd });
    if (customTools.loaded.length) onLog({ kind: "custom-tools", text: `已挂载 ${customTools.loaded.length} 个自定义工具：${customTools.loaded.join(", ")}` });
    for (const line of customTools.errors) onLog({ kind: "custom-tools", text: `自定义工具跳过：${line}` });
  } catch (error) {
    onLog({ kind: "custom-tools", text: `自定义工具加载失败（已忽略）：${error.message}` });
  }

  // 连接外部 MCP 服务器（在浏览器工具之后：保留名集合要包含它们，外部工具才抢不走）
  let external = { adopted: [], blocked: [], errors: [] };
  try {
    external = await externalMcp.refresh({ force: true });
    onLog({
      kind: "external-mcp",
      text: external.adopted.length
        ? `已挂载 ${external.adopted.length} 个外部 MCP 工具：${external.adopted.join(", ")}`
        : "没有可用的外部 MCP 工具（未配置或全部连接失败）",
    });
  } catch (error) {
    // 兜底：refresh 内部已经把单服务器失败吃掉了，这里只防意外
    onLog({ kind: "external-mcp", text: `外部 MCP 初始化异常（已忽略，Bridge 继续启动）：${error.message}` });
  }

  const hub = new WorkspaceHub({ root: workspaceHubRoot(), workspace: workspace ?? describeWorkspace({ folders: [cwd] }) });
  await hub.initialize();

  const { token, file } = await loadOrCreateRouteToken(dataHome);

  /*
   * 端口：默认 0 = 让系统随机分配（最安全，不撞端口）。
   *
   * 但**要接命名隧道就必须固定端口** —— cloudflared 的 ingress 规则里
   * 写的是死端口，桥每次随机换端口的话隧道就永远指不到。
   * 优先级：函数参数 > 环境变量 BRIDGE_PORT > 随机。
   */
  const wantedPort = Number.isInteger(port) ? port : (Number(process.env.BRIDGE_PORT) || 0);

  const server = new BridgeServer({
    dataHome: home,
    routeToken: token,
    connectors: connectorStore,
    ownerAuth: ownerAuthStore,
    // 本机 MCP 防绕过 + 远程请求放行（激活 + 我们的隧道）。纯命令行 / 自测不传，行为与从前一样。
    remoteGate,
    remoteGateTtlMs,
    // 工具档位（设置页）：basic 只放自带 / 自定义 / 鼠标兜底，full 全放
    toolTier,
    // 隧道 OAuth（默认关闭）：不传或 enabled=false 时端点完全不存在
    oauth,
    // 授权工作区：run_command 的 cwd 谓词按这个边界判；guard.roots 是活数组，改工作区立即生效
    workspaceRoots: guard.roots,
    // 终端当前目录（命令不写 cwd 时落在这里），scoped 口令也要按它判边界
    currentCwd: () => terminal.cwd,
    // 连接器越权申请排队前确认窗口真的存在；没接浏览器（纯命令行）时不传，桥按「不存在」处理、不排队
    profileExists,
    port: wantedPort,
    onActivity: (event) => onLog(event),
    instructions,
    // 响应方式：默认 SSE（边跑边回），设置页勾了 JSON 才一次性回；心跳间隔可调
    jsonResponse: options?.jsonResponse === true,
    sseKeepAliveMs: options?.sseKeepAliveMs,
    healthProbes,
    startupGraceMs,
    resultLimitBytes,
    // 外部工具的转发通道：按 (serverId, 上游原名) 查绑定，不从暴露名反推
    forward: (serverId, upstreamName, args, options) => externalMcp.forward(serverId, upstreamName, args, options),
    // 列工具前懒刷新：外部清单有 30s 缓存，平时零成本；断线/改配置后下次列清单自动校正
    beforeListTools: () => externalMcp.refresh(),
    // 固定端口没抢到时退回随机端口 —— 必须让用户知道，否则会以为隧道指不到是别的原因
    onPortFallback: (taken, actual) => onLog({
      kind: "bridge",
      text: `端口 ${taken} 被占用，已改用 ${actual}。功能都正常，但命名隧道指向 ${taken} 会连不上 —— 要么关掉占用端口的程序，要么把隧道规则改到 ${actual}。`,
    }),
  });
  notifyToolListChanged = () => server.notifyToolListChanged();
  await server.start();

  const snapshot = await hub.publish({
    state: "running",
    provider: "none",
    localUrl: server.localUrl,
    toolCount: listTools().length,
    connectedClients: server.sessionCount,
  });

  return {
    guard, control, terminal, hub, server, token, tokenFile: file, snapshot, browserTools, externalMcp,
    connectors: connectorStore,
    /**
     * 主口令操作：每次改动后让桥断开失效的主会话。generate() 的返回值里有口令明文，只给界面显示一次，别写日志。
     */
    ownerAuth: {
      status: () => ownerAuthStore.status(),
      pathEnabled: () => ownerAuthStore.pathEnabled(),
      generate: () => { const result = ownerAuthStore.generate(); server.ownerAuthChanged(); return result; },
      revoke: () => { const result = ownerAuthStore.revoke(); server.ownerAuthChanged(); return result; },
      setPathEnabled: (enabled) => { const result = ownerAuthStore.setPathEnabled(enabled); server.ownerAuthChanged(); return result; },
      // 多把口令（2026-10-25 下午）：addKey 不影响别的会话；rotateKey / revokeKey 只断那一把的会话
      addKey: (label, scope) => { const result = ownerAuthStore.addKey(label, scope === undefined ? {} : { scope }); server.ownerAuthChanged(); return result; },
      rotateKey: (id, scope) => { const result = ownerAuthStore.rotateKey(id, scope === undefined ? {} : { scope }); server.ownerAuthChanged(); return result; },
      revokeKey: (id) => { const result = ownerAuthStore.revokeKey(id); server.ownerAuthChanged(); return result; },
      // 口令作用域：不换口令、不断会话，下一次调用立即按新作用域判
      setScope: (id, scope) => ownerAuthStore.setScope(id, scope),
    },
    contextBus, contextFile, contextTools: contextTools.length, contextReady, customTools,
    get status() {
      return {
        // health() 现在是异步的（要跑探针），同步的 status 只带基础字段，避免调用方拿到 Promise
        ...server.healthSummary(),
        localUrl: server.localUrl,
        publicUrl: null,
        hubRoot: hub.root,
        workspace: hub.workspace,
        windowId: hub.windowId,
        tokenFile: file,
        browserTools,
        contextFile,
        contextTools: contextTools.length,
        contextReady,
        externalTools: listExternalTools(),
        externalServers: externalMcp.snapshot(),
      };
    },
    async stop() {
      await server.stop();
      terminal.dispose();
      // 外部 MCP 子进程必须在这里被杀掉，不能留残留
      await externalMcp.dispose().catch((error) => onLog({ kind: "external-mcp", text: `外部 MCP 关闭异常：${error.message}` }));
      // 总线：等排队的写落盘再关（dispose 幂等，没挂载时是 no-op）
      await contextBus?.dispose().catch((error) => onLog({ kind: "context", text: `共享上下文关闭异常：${error.message}` }));
      await hub.publish({ state: "stopped", toolCount: listTools().length });
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

/**
 * 启动信息（--tunnel 也要看得到本机地址和健康检查地址，排查「隧道到底通不通」时要用）。
 * 抽成函数导出：测试可以真的调一次、断言输出，比查源码字符串结实。
 */
export function printBanner(app) {
  console.log("Bridge 已启动");
  console.log("  MCP 地址 :", app.server.localUrl);
  console.log("  健康检查 :", app.server.healthUrl());
  console.log("  工作区   :", app.snapshot.workspace.name, `(${app.snapshot.workspace.kind})`);
  console.log("  共享目录 :", app.hub.root);
  console.log("  工具数量 :", listTools().length);
}

if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--list-tools")) {
    const control = createControlPlane({});
    const guard = createPathGuard([process.cwd()]);
    const terminal = new TerminalManager({ guard, cwd: process.cwd() });
    installBuiltinTools({ control, terminal, guard, mcpConfigPath: "/dev/null" });
    const tools = listTools();
    console.log(`内置工具 ${tools.length} 个：`);
    for (const tool of tools) console.log(`  ${tool.name.padEnd(22)} [${tool.capability.padEnd(8)}] ${tool.title}`);
    // 流程草稿工具只依赖数据目录，列清单时也带上（不读写任何草稿文件）
    const flowTools = defineFlowTools({ dataHome: process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica") });
    registerTools(flowTools);
    console.log(`\n流程草稿工具 ${flowTools.length} 个（总是挂载，草稿目录：${flowDraftsDir(process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"))}）：`);
    for (const tool of flowTools) console.log(`  ${tool.name.padEnd(22)} [${tool.capability.padEnd(8)}] ${tool.title}`);
    const browser = defineBrowserTools();
    const online = await browserControlAvailable();
    console.log(`\n浏览器工具 ${browser.length} 个（${online ? "控制服务在线，已挂载" : "控制服务未启动，暂未挂载"}）：`);
    for (const tool of browser) console.log(`  ${tool.name.padEnd(22)} [${tool.capability.padEnd(8)}] ${tool.title}`);

    // 共享上下文：纯本地，总是挂载。这里只造一个不落盘的实例来列清单（没 initialize 就不会写文件）
    const contextTools = defineContextTools({ bus: new ContextBus({ file: defaultContextBusFile() }) });
    console.log(`\n共享上下文工具 ${contextTools.length} 个（总是挂载，数据文件：${defaultContextBusFile()}）：`);
    for (const tool of contextTools) console.log(`  ${tool.name.padEnd(22)} [${tool.capability.padEnd(8)}] ${tool.title}`);
    console.log(`\n合计：${tools.length + flowTools.length + contextTools.length + (online ? browser.length : 0)} 个工具`);

    // 外部 MCP：这里只读配置、不连接（连接要花时间，且会拉起子进程），所以只报「配了几个」
    const externalConfig = new ExternalMcpConfigStore({ configPath: path.join(os.homedir(), ".bridge-replica", "external-mcp.json") });
    const { servers, errors } = await externalConfig.servers();
    console.log(`\n已配置外部 MCP 服务器 ${servers.length} 个（--list-tools 不连接，故不列出其工具）：`);
    for (const server of servers) {
      const target = server.transport === "http" ? server.url : `${server.command} ${(server.args ?? []).join(" ")}`.trim();
      console.log(`  ${server.id.padEnd(22)} [${server.transport.padEnd(5)}] ${server.enabled ? "启用" : "停用"} → ${target}`);
    }
    for (const error of errors) console.log(`  ${error.name}：配置有问题（${error.reason}）`);
    console.log(`配置文件：${externalConfig.configPath}`);
    terminal.dispose();
    process.exit(0);
  }

  const roots = [process.cwd()];
  /*
   * 命令行 / 调试模式的 OAuth 开关：设置里没接 UI 之前，用环境变量打开。
   *   WINDRISE_OAUTH=1                       启用（默认关闭）
   *   WINDRISE_OAUTH_PUBLIC_URL=https://...  固定公网 base；不填就按请求 Host 推
   */
  const oauth = process.env.WINDRISE_OAUTH === "1"
    ? { enabled: true, publicBaseUrl: process.env.WINDRISE_OAUTH_PUBLIC_URL?.trim() || null }
    : null;
  const app = await boot({ roots, oauth, onLog: (event) => { if (event.kind !== "request") console.log("[活动]", JSON.stringify(event)); } });

  if (args.has("--self-test")) {
    /**
     * 自检要跑的就是用户的真实默认路径（SSE），所以不传 jsonResponse，也不能假设 body 是纯 JSON。
     * SSE 事件的正文由若干条 "data:" 行组成，这里一个响应只有一个事件、正文是一行 JSON，
     * 取最后一条 "data:" 行就够；万一桥被配成 JSON 响应，就按普通 JSON 读。
     */
    const readMcp = async (response) => {
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json();
      const text = await response.text();
      const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      if (lines.length === 0) return JSON.parse(text);
      return JSON.parse(lines[lines.length - 1].slice(5));
    };
    const url = app.server.localUrl;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = (body, sid) => fetch(url, { method: "POST", headers: sid ? { ...headers, "mcp-session-id": sid } : headers, body: JSON.stringify(body) });
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test", version: "0" } } });
    const initBody = await readMcp(init);
    const sid = init.headers.get("mcp-session-id");
    const list = await readMcp(await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid));
    const call = await readMcp(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_directory", arguments: { path: ".", depth: 1 } } }, sid));
    const bad = await fetch(url.replace(app.token, "0".repeat(32)), { method: "POST", headers, body: "{}" });
    const health = await (await fetch(app.server.healthUrl())).json();
    console.log("自检结果：");
    console.log(`  协议版本        : ${initBody?.result?.protocolVersion}`);
    // 正文已经读掉了，所以看响应头判断；默认路径就该是 SSE，用一眼能看出来的方式标出来
    console.log(`  响应方式        : ${(init.headers.get("content-type") ?? "").includes("text/event-stream") ? "SSE 边跑边回" : "JSON 一次性"}`);
    console.log(`  会话 ID         : ${sid ? "已下发" : "未下发"}`);
    console.log(`  tools/list 数量 : ${list?.result?.tools?.length}`);
    console.log(`  工具名           : ${list?.result?.tools?.map(t => t.name).join(", ")}`);
    console.log(`  list_directory  : ${call?.result?.content?.[0]?.text?.split("\n")[0] ?? "无返回"}`);
    console.log(`  错误令牌被拒     : HTTP ${bad.status}`);
    console.log(`  健康检查         : ${JSON.stringify(health)}`);
    /*
     * 用 exitCode 自然退出，不调 process.exit(0)：工具调用日志是排队异步写的，
     * 强退偶尔会在 Windows 上触发 libuv 的 UV_HANDLE_CLOSING 断言（结果其实是全过的）。
     * app.stop() 之后事件循环空了就自然退出，不会多打启动日志。
     */
    process.exitCode = 0;
    await app.stop();
  } else if (args.has("--tunnel")) {
    const tunnel = new TunnelManager({ localUrl: app.server.localUrl, onLog: (line) => console.log("[隧道]", line) });
    const started = await tunnel.start("cloudflare");
    console.log("公网地址:", started.publicUrl);
    console.log("把下面这个地址填进 MCP 客户端：", started.publicUrl.replace(/\/mcp\/.*$/, `/mcp/${app.token}`));
    process.on("SIGINT", async () => { await tunnel.stop(); await app.stop(); process.exit(0); });
  }

  /*
   * 启动信息统一在这里打印：--tunnel 也要看得到本机地址和健康检查地址（排查「隧道到底通不通」时要用）。
   * 自检分支不打印（它自己输出一份结果）。
   */
  if (!args.has("--self-test")) {
    printBanner(app);
    process.on("SIGINT", async () => { await app.stop(); process.exit(0); });
  }
}
