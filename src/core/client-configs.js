/**
 * 按客户端生成「远程 MCP 配置」——界面里「一键复制配置」真正复制的东西。
 *
 * 为什么不能一份 JSON 打天下：
 *   - 同样的远程服务器，字段名有 url / serverUrl / baseUrl / httpUrl 四种写法；
 *   - type 有的必填（Claude Code、VS Code、Cline），有的不能写（Trae），有的省略就被当 SSE（Cline）；
 *   - 鉴权分档：大多数能给 Authorization: Bearer 静态头，Claude 网页 / ChatGPT 网页只能 OAuth 或匿名。
 * 写错一个键，客户端就静默不加载，所以这里按客户端分别生成，并附上「放哪」和「最常见的坑」。
 *
 * 纯函数，不读文件、不碰网络：buildClientConfig(clientKey, { baseUrl, token, pathToken })
 *   - baseUrl：公网（或本机）MCP 根地址，例如 https://xxx.trycloudflare.com/mcp；
 *     没带 /mcp 时按 <origin>/mcp 补齐；已经带 /mcp/<口令> 时按 pathToken 统一收成 /mcp 或 /mcp/<口令>。
 *   - token：口令。pathToken 为真（默认，和现状一致）时放进路径，配置里不写 Authorization；
 *     pathToken 为假时改用 Authorization: Bearer 请求头。**token 参数优先于 baseUrl 里的旧口令**。
 *
 * 口令只出现在可复制的配置正文（text / variants）里；steps 和 notes 一律用 <口令> 占位，
 * 避免界面把步骤渲染到气泡、把整个结果 console.log 排查时把密钥带出去。
 *
 * 各家字段与坑来自 .task/clients-report.md（第 12 节总表、12.1 报错对照、13 节）。
 */

export const SERVER_NAME = "windrise";

/** 分组顺序：网页 → 桌面 → IDE → 命令行 → 国内 */
export const GROUPS = ["网页", "桌面", "IDE", "命令行", "国内"];

/**
 * 客户端清单（界面据此生成列表；不支持的也要列出来并说明原因）。
 * kind：json / toml / yaml / cli / form；form 是「没有 JSON、只能照着点」的客户端。
 */
export const CLIENTS = [
  { key: "claude", name: "Claude 网页 / 桌面 / 手机", group: "网页", secretNote: false },
  { key: "chatgpt", name: "ChatGPT", group: "网页", secretNote: false },
  { key: "claude-code", name: "Claude Code", group: "命令行", secretNote: false },
  { key: "codex", name: "Codex CLI / IDE", group: "命令行", secretNote: false },
  { key: "gemini-cli", name: "Gemini CLI", group: "命令行", secretNote: false },
  { key: "kimi-code", name: "Kimi Code CLI", group: "命令行", secretNote: false },
  { key: "deepseek-harness", name: "DeepSeek Harness", group: "命令行", secretNote: false },
  { key: "cursor", name: "Cursor", group: "IDE", secretNote: true },
  { key: "vscode", name: "VS Code / Copilot", group: "IDE", secretNote: true },
  { key: "devin", name: "Devin Desktop（原 Windsurf）", group: "IDE", secretNote: true },
  { key: "devin-legacy", name: "Devin 旧版 / Windsurf 旧版（Cascade）", group: "IDE", secretNote: true },
  { key: "cline", name: "Cline", group: "IDE", secretNote: true },
  { key: "trae", name: "Trae（CN / 国际）", group: "IDE", secretNote: true },
  { key: "cherry-studio", name: "Cherry Studio", group: "桌面", secretNote: true },
  { key: "chatwise", name: "ChatWise", group: "桌面", secretNote: false },
  { key: "lingma", name: "通义灵码 / Qoder CN", group: "国内", secretNote: true },
  { key: "yuanbao", name: "腾讯元宝", group: "国内", secretNote: false },
  { key: "doubao", name: "豆包", group: "国内", secretNote: false },
  { key: "zhipu", name: "智谱清言", group: "国内", secretNote: false },
];

export function listClients() {
  return CLIENTS.map((c) => ({ ...c }));
}

const UNSUPPORTED_REASON = "目前没有用户可配的 MCP 入口";
const PATH_ONLY_REASON = "这个客户端只能靠路径口令：请把「路径口令」打开，或改用 OAuth";
const INVALID_URL_REASON = "地址格式看不懂：请填完整的 https://<域名>/mcp 地址";
/** 缺口令时正文里的占位符：统一成「你的口令」，用户在客户端里一眼知道要替换什么 */
const TOKEN_PLACEHOLDER = "<你的口令>";
/**
 * 路径里的占位符额外写明「URL 编码后」：真实口令含 # ? / 空格 / 中文时必须先编码，
 * 否则用户直接粘贴会把地址截断（# 之后全变成 fragment）。
 */
const PATH_TOKEN_PLACEHOLDER = "<你的口令-URL编码后>";

/** ---- 地址辅助 ---- */

/** 从任意用户输入里取 origin；没有协议时按 https 猜一次。取不到返回 null。 */
function urlOrigin(input) {
  for (const candidate of [input, `https://${input}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch { /* 继续试下一种写法 */ }
  }
  return null;
}

/**
 * 把「/mcp 之前」的前缀收成「origin + 前缀路径 + /mcp」。
 * 反代子路径（https://h/proxy/mcp/TOK）必须保留 /proxy；没写协议时按 https 补。
 * 认不出来返回 ""。
 */
function mcpBaseFromPrefix(prefix) {
  const text = String(prefix || "").trim();
  if (!text) return "";
  for (const candidate of [text, `https://${text}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.origin}${pathname}/mcp`;
    } catch { /* 继续试下一种写法 */ }
  }
  return "";
}

/**
 * 把用户给的地址收成根 + 是否带口令，统一行为 http(s)://host[/前缀]/mcp[/<口令>]。
 * 地址里没有 /mcp 段时按 origin 补成 <origin>/mcp（隧道根地址也能用）；
 * 命中 /mcp 段时前缀也要能被 urlOrigin 认出来（`demo.example.com/mcp` 不能被原样当成 base），
 * 认不出时返回 base: ""，由 buildClientConfig 报「地址格式看不懂」，不猜。
 */
export function normalizeBaseUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return { base: "", pathToken: null, tail: "" };
  const hashIdx = raw.search(/[?#]/);
  const head = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const tail = hashIdx >= 0 ? raw.slice(hashIdx) : "";
  const m = head.match(/^(.*?)\/mcp(?:\/([^/]+))?\/?$/i);
  if (m) {
    // 前缀里的路径要保留：隧道挂在反代子路径时，丢掉 /proxy 就会生成一个「格式合法但连不上」的地址
    return { base: mcpBaseFromPrefix(m[1]), pathToken: m[2] || null, tail };
  }
  const origin = urlOrigin(head.replace(/\/+$/, ""));
  if (origin) return { base: `${origin}/mcp`, pathToken: null, tail };
  return { base: "", pathToken: null, tail };
}

/** pathToken 只接受布尔；0 / "false" / "0" 这类表单值按「请求头模式」处理。 */
function normalizePathToken(value) {
  if (value === undefined || value === null) return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return true;
}

/** 比较 baseUrl 里已经带的口令和传入的口令（地址里的可能是 URL 编码后的）。 */
function sameToken(inPath, token) {
  if (!inPath || !token) return false;
  try { return decodeURIComponent(inPath) === token; } catch { return inPath === token; }
}

function resolveUrl(baseUrl, token, pathToken) {
  const { base, pathToken: inPath, tail } = normalizeBaseUrl(baseUrl);
  const root = base || "https://<你的公网域名>/mcp";
  const tok = String(token || "").trim();
  if (!pathToken) return `${root}${tail}`;
  const path = tok || inPath;
  if (!path) return `${root}/${PATH_TOKEN_PLACEHOLDER}${tail}`;
  // 显式口令做 URL 编码；从地址里解出来的令牌已经是 URL 形态，原样保留不重复编码
  return `${root}/${tok ? encodeURIComponent(tok) : path}${tail}`;
}

function headerConfig(url, token, pathToken) {
  const tok = String(token || "").trim();
  return pathToken ? {} : { headers: { Authorization: `Bearer ${tok || "<你的口令>"}` } };
}

/** SSE 端点：https://host/mcp/<令牌> → https://host/sse/<令牌> */
function sseUrl(baseUrl, token, pathToken) {
  const url = resolveUrl(baseUrl, token, pathToken);
  return url.replace(/\/mcp(?=\/|$)/, "/sse");
}

/** 步骤 / 注意事项里用的地址：路径里的口令换成占位符，避免密钥进 UI 气泡和日志。 */
function redactUrl(url) {
  return String(url).replace(/\/(mcp|sse)\/[^/?#]+/, "/$1/<口令>");
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const SET = SERVER_NAME;

/** ---- 各家生成器 ---- */

function claudeConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const tok = String(token || "").trim() || "<你的口令>";
  const steps = [
    "打开 Claude → Customize → Connectors → Add custom connector。",
    "URL 填上面「地址」那一行（整段复制就行）。",
    "Authentication 选 No sign-in；如果组织开了 beta 的 Request headers，在 Request headers 里加一项 authorization（值见下面的注意事项）。",
    "保存后回到对话，在连接器列表里启用它。",
  ];
  const notes = [
    "Request headers 目前是 beta，只对少数组织开放；看不到这一栏就用 OAuth，或换个客户端。",
    "Claude 是从 Anthropic 云端来连你的服务器：域名必须能解析出公网 IPv4，跳转（301/302）会丢掉 Authorization。",
    "免费版最多 1 个自定义连接器；隧道换域名后要重新添加。",
  ];
  if (!pathToken) {
    notes.unshift("Request headers 里填 authorization = Bearer <口令>（值要带 Bearer 前缀，最多 4 个头）。");
  } else {
    notes.unshift("口令在 URL 路径里，一般不需要填请求头；要填请求头时写 authorization = Bearer <口令>。");
  }
  const text = !pathToken
    ? [
      "地址：" + url,
      "鉴权：No sign-in + Request headers（beta）",
      `请求头：authorization: Bearer ${tok}`,
    ].join("\n")
    : [
      "地址：" + url,
      "鉴权：No sign-in（口令在路径里）",
      `请求头（可选，beta）：authorization: Bearer ${tok}`,
    ].join("\n");
  return {
    kind: "form",
    text,
    steps,
    notes,
    supported: true,
    reason: null,
  };
}

function chatgptConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const steps = [
    "ChatGPT → Plugins → + → Add custom MCP server（不需要先开 Developer Mode）。",
    "URL 填上面「地址」那一行（整段复制就行）。",
    "Authentication 选 No authentication（Windrise 口令在路径里，不需要请求头）；如果 Windrise 开了 OAuth 就选 OAuth。",
    "保存后 Create as a plugin、安装，然后在对话里 @ 选中它。",
  ];
  const notes = [
    "ChatGPT 只支持 OAuth 或无鉴权，没有自定义请求头的入口；只能网页端用，手机端不支持。",
    "工具清单是冻结快照：服务器改了工具后，要去 Plugins → 该连接 → Refresh，否则一直报旧 schema 的错。",
    "完整 MCP 目前只给 Business / Enterprise；Pro 只能读，发布类工具会被挡。",
  ];
  if (!pathToken) {
    notes.unshift("ChatGPT 没有请求头入口：口令改走请求头（Authorization: Bearer）时这条路走不通，必须开 OAuth 或把口令放回路径。");
  }
  return {
    kind: "form",
    text: ["地址：" + url, "鉴权：No authentication", pathToken ? "" : "注意：ChatGPT 不能带自定义请求头，口令必须放在路径里"].filter(Boolean).join("\n"),
    steps,
    notes,
    // 请求头模式下没有可用的鉴权入口：界面要置灰，别让用户复制一份必然 401 的地址
    supported: pathToken,
    reason: pathToken ? null : PATH_ONLY_REASON,
  };
}

function claudeCodeConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const entry = { type: "http", url, ...headerConfig(url, token, pathToken), timeout: 120000 };
  const cfg = { mcpServers: { [SET]: entry } };
  const cli = pathToken
    ? `claude mcp add --transport http ${SET} ${redactUrl(url)}`
    : `claude mcp add --transport http ${SET} ${url} --header "Authorization: Bearer <口令>"`;
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "项目级写进工作区的 .mcp.json；全局写进 ~/.claude.json 的顶层 mcpServers。",
      "也可以直接用命令行（在项目目录里执行，把 <你的口令> 换成你在设置里创建的口令）：",
      cli,
      "加完在 Claude Code 里输入 /mcp 看连接状态。",
    ],
    notes: [
      '必须有 "type": "http"；只有 url 没有 type 会被当成 stdio，报 has a "url" but no "type"。',
      "timeout 单位是毫秒；工具执行要看清是服务器慢还是被 16 MiB 单条响应上限挡住。",
    ],
    supported: true,
    reason: null,
  };
}

function codexConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const tok = String(token || "").trim() || "<你的口令>";
  const lines = [
    `[mcp_servers.${SET}]`,
    `url = "${url}"`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    'default_tools_approval_mode = "writes"',
  ];
  if (!pathToken) {
    lines.push('bearer_token_env_var = "WINDRISE_TOKEN"');
  }
  const text = lines.join("\n") + "\n";
  const variants = !pathToken
    ? [{
      label: "明文请求头版（口令会留在 config.toml 里）",
      kind: "toml",
      text: [
        `[mcp_servers.${SET}]`,
        `url = "${url}"`,
        `http_headers = { Authorization = "Bearer ${tok}" }`,
        "startup_timeout_sec = 20",
        "tool_timeout_sec = 120",
        'default_tools_approval_mode = "writes"',
      ].join("\n") + "\n",
    }]
    : [];
  return {
    kind: "toml",
    text,
    steps: [
      "写进 ~/.codex/config.toml（Windows：%USERPROFILE%\\.codex\\config.toml；CLI、IDE 扩展、桌面 App 共用这份）。",
      "保存后重开 codex；用 codex mcp list 看有没有 windrise。",
      ...(!pathToken ? ["不想设 WINDRISE_TOKEN 环境变量，就用下面「明文请求头版」（口令会进配置文件）。"] : []),
    ],
    notes: [
      "startup_timeout_sec 默认 10、tool_timeout_sec 默认 60，默认值经常不够，所以这里显式写 20 / 120。",
      "default_tools_approval_mode = \"writes\" 会让发布 / 提交这类写操作在 Codex 里先弹确认。",
      ...(!pathToken ? ["WINDRISE_TOKEN 要设成你在「设置 → 口令」里创建的一把口令；不想设环境变量就用下面「明文请求头版」（口令会进配置文件）。"] : []),
    ],
    variants,
    supported: true,
    reason: null,
  };
}

function geminiConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const entry = { httpUrl: url, ...headerConfig(url, token, pathToken), timeout: 120000 };
  const cfg = { mcpServers: { [SET]: entry } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "写进 ~/.gemini/settings.json（没有 mcpServers 就整段放进去）。",
      "重开 gemini 命令行，用 /mcp 看服务器状态。",
    ],
    notes: [
      "字段必须叫 httpUrl；写成 url 会被当成 SSE，连不上且看起来地址是对的。",
      "timeout 单位是毫秒，默认 600000；这里压到 120000 让失败早点暴露。",
    ],
    supported: true,
    reason: null,
  };
}

function cursorConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const cfg = { mcpServers: { [SET]: { url, ...headerConfig(url, token, pathToken) } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "写进 ~/.cursor/mcp.json（或项目里 .cursor/mcp.json）。",
      "在 Cursor 设置 → MCP 里打开 windrise 的开关。",
    ],
    notes: [
      "单个服务器崩了会被隔离，其他服务器照常；查错看 Output 面板里的 MCP Logs。",
      "这段配置含密钥（口令在路径里也算），不要提交到 git。",
    ],
    supported: true,
    reason: null,
  };
}

function vscodeConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const entry = { type: "http", url, ...headerConfig(url, token, pathToken) };
  // .vscode/mcp.json 原生格式顶层是 servers；可移植格式才是 mcpServers
  const nativeCfg = { servers: { [SET]: entry } };
  const portableCfg = { mcpServers: { [SET]: entry } };
  return {
    kind: "json",
    text: json(nativeCfg),
    steps: [
      "VS Code 原生格式 .vscode/mcp.json：直接复制上面的配置（顶层键是 servers）。",
      "可移植格式（Copilot / 工作区 .mcp.json / ~/.copilot/mcp-config.json）：复制下面「可移植格式」那份（顶层键是 mcpServers）。",
      "保存后在工作区信任提示里选「信任」，再从 MCP 面板启动 windrise。",
    ],
    notes: [
      "两套格式的顶层键不一样（servers vs mcpServers），互相复制不改键就是不加载。",
      "别用 ${input:...}：可移植格式不支持，也不会转发给 Copilot。",
    ],
    variants: [{ label: "可移植格式（mcpServers）", kind: "json", text: json(portableCfg) }],
    supported: true,
    reason: null,
  };
}

function devinConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const cfg = { mcpServers: { [SET]: { url, transport: "http", ...headerConfig(url, token, pathToken) } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "新版 Devin Desktop（Devin Local）：写进 %APPDATA%\\devin\\mcp_config.json（macOS / Linux：~/.config/devin/mcp_config.json）。",
      '旧版 Cascade 已移除；万一还在用，到列表里选「Devin 旧版 / Windsurf 旧版（Cascade）」复制 serverUrl 版本。',
      "重开 Devin，或在 MCP 面板里重连。",
    ],
    notes: [
      "只有 4xx 才会回退到 SSE，401 / 403 不回退：令牌错了要先去查口令，别以为是传输不支持。",
      "旧 Cascade 最多 100 个工具；大工具集要按空间拆服务器。",
    ],
    supported: true,
    reason: null,
  };
}

function devinLegacyConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const cfg = { mcpServers: { [SET]: { serverUrl: url, ...headerConfig(url, token, pathToken) } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "旧的 Windsurf / Cascade 用这份（新 Devin Desktop 用「Devin Desktop」那份）。",
      "写进 mcp_config.json，然后在 Cascade 的 MCP 面板里刷新。",
    ],
    notes: [
      "Cascade 已在 2026-09-08 移除；只在旧版本上还有效。",
      "旧版最多 100 个工具，超出的工具不会出现。",
    ],
    supported: true,
    reason: null,
  };
}

function clineConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const cfg = {
    mcpServers: {
      [SET]: { type: "streamableHttp", url, ...headerConfig(url, token, pathToken), disabled: false, autoApprove: [] },
    },
  };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "在 Cline 的 MCP Servers → Configure 里编辑 cline_mcp_settings.json，把这段并进去。",
      "保存后回到 MCP 面板，windrise 应显示绿色已连接。",
    ],
    notes: [
      '必须写 "type": "streamableHttp"；省略就默认 legacy SSE，工具不会出现。',
      "工具执行超时（MCP error -2: Request timed out）一般要调大 Cline 的 MCP 超时。",
    ],
    supported: true,
    reason: null,
  };
}

function cherryConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const cfg = { mcpServers: { [SET]: { type: "streamableHttp", baseUrl: url, ...headerConfig(url, token, pathToken) } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "设置 → MCP 服务器 → 添加 → 选「导入 JSON」，粘贴下面这段。",
      "导入后在该 Agent 的 MCP 设置里启用 windrise。",
    ],
    notes: [
      "内部字段是 baseUrl；个别版本的导入器只认 url，导入失败就手工把 baseUrl 改成 url 再试。",
      "显示已连接但 Agent 找不到工具：去 Agent → 编辑 → MCP 里勾上 windrise。",
    ],
    supported: true,
    reason: null,
  };
}

function traeConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const headers = pathToken
    ? { START_MCP_TIMEOUT_MS: "30000", RUN_MCP_TIMEOUT_MS: "120000" }
    : { Authorization: `Bearer ${String(token || "").trim() || "<你的口令>"}`, START_MCP_TIMEOUT_MS: "30000", RUN_MCP_TIMEOUT_MS: "120000" };
  const cfg = { mcpServers: { [SET]: { url, headers } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "全局配置：MCP → 添加 → 手动配置，粘贴这段 JSON。",
      "项目级：放到项目根目录 .trae/mcp.json，并在「设置 > MCP」里打开「启用项目级 MCP」。",
      "Agent 运行时选「本地」，云端任务连不到本机隧道。",
    ],
    notes: [
      "不要加 type 字段：Trae 靠 url 判断远程，多写一个 type 会解析失败。",
      "变量只支持 ${workspaceFolder}，没有 ${env:...}，所以这段配置含密钥，别提交到 git。",
    ],
    supported: true,
    reason: null,
  };
}

function kimiConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const entry = { url, ...headerConfig(url, token, pathToken), toolTimeoutMs: 120000 };
  const cfg = { mcpServers: { [SET]: entry } };
  // 环境变量版只在请求头模式下才有意义：路径模式里 url 本身还带着口令，换不干净
  const variants = !pathToken
    ? [{
      label: "环境变量版（口令不写进 JSON）",
      kind: "json",
      text: json({ mcpServers: { [SET]: { url, bearerTokenEnvVar: "WINDRISE_TOKEN", toolTimeoutMs: 120000 } } }),
    }]
    : [];
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "写进 ~/.kimi-code/mcp.json（或项目里 .kimi-code/mcp.json）。",
      "重开会话：编辑 mcp.json 不会注册到已打开的会话。",
      ...(variants.length ? ["不想把口令写进 JSON，就用下面「环境变量版」；记得先设置 WINDRISE_TOKEN。"] : []),
    ],
    notes: [
      "含 url 且没写 transport 的条目按 HTTP 处理；旧式 SSE 才需要显式 transport: \"sse\"。",
      "工具太多占上下文时可以用 deferred 按需加载，但它要配合环境变量，一键配置里不默认开。",
    ],
    variants,
    supported: true,
    reason: null,
  };
}

function deepseekConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const tok = String(token || "").trim() || "<你的口令>";
  const lines = [
    "- id: mcp-windrise",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: windrise",
    "    transport: streamable-http",
    `    url: ${url}`,
  ];
  if (!pathToken) {
    lines.push("    headers:");
    lines.push("      Authorization: 'Bearer " + tok + "'   # 也可以改成从环境变量 WINDRISE_TOKEN 读");
  }
  lines.push("    toolCallTimeoutMs: 120000");
  return {
    kind: "yaml",
    text: lines.join("\n") + "\n",
    steps: [
      "把这段加进 DeepSeek Harness 的 YAML 配置（agents 列表里）。",
      "重启 Harness；连接失败会按配置里的 failOnStartupError 决定是否继续启动。",
    ],
    notes: [
      "配置是 YAML 不是 JSON；缩进错了会直接解析失败。",
      "服务器 instructions 默认上限 32,768 字节，超了是连接失败而不是截断。",
    ],
    supported: true,
    reason: null,
  };
}

function lingmaConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const sse = sseUrl(baseUrl, token, pathToken);
  // 请求头模式必须把 Authorization 写进正文：这一家没有 notes 以外的口头提示，漏了就是必然 401
  const cfg = { mcpServers: { [SET]: { type: "streamable-http", url, ...headerConfig(url, token, pathToken) } } };
  return {
    kind: "json",
    text: json(cfg),
    steps: [
      "QoderWork CN 桌面端：MCP → 添加，类型选 Streamable HTTP，粘贴下面的 JSON。",
      ...(pathToken ? [] : ["Headers 已写进上面的 JSON；客户端要单独填请求头时，照抄 authorization 那一项。"]),
      `灵码 IDE 插件目前只认 SSE：URL 改填 ${redactUrl(sse)}；没有请求头输入框时只能给无鉴权端点。`,
    ],
    notes: [
      "灵码 IDE 插件只支持 SSE，填 /mcp 会报 context deadline exceeded 或 405。",
      "必须切到「智能体模式」并打开工程目录，否则 MCP 工具不会被调用。",
    ],
    supported: true,
    reason: null,
  };
}

function chatwiseConfig({ baseUrl, token, pathToken }) {
  const url = resolveUrl(baseUrl, token, pathToken);
  const notes = [
    "ChatWise 未实现 OAuth，也没有公开的自定义请求头入口：口令只能靠 URL 路径。",
    "它只发请求收响应，不监听服务器主动推送，别依赖 progress / notification。",
    "实验结果请以你本机版本为准。",
  ];
  if (!pathToken) {
    notes.unshift("ChatWise 没有自定义请求头入口：请求头模式这条配置很可能连不上，要用就在「设置 → 口令」里打开「公网允许路径令牌（/mcp/<令牌> 地址）」，让口令回到路径里。");
  }
  return {
    kind: "form",
    text: [
      `（实验性）地址：${url}`,
      "ChatWise 没有 OAuth，请求头支持不明确，很可能连不上。",
    ].join("\n"),
    steps: [
      "不建议首发使用：ChatWise 未实现 OAuth，也没有公开的自定义请求头入口。",
      "实在要用：Tools → MCP → Add，传输选 Streamable HTTP，地址填上面「地址」那一行。",
    ],
    notes,
    // 同上：没有请求头入口，请求头模式下这份配置连不上，不能和能用的条目长得一样
    supported: pathToken,
    reason: pathToken ? null : PATH_ONLY_REASON,
  };
}

function unsupported() {
  return { kind: "form", text: "", steps: [], notes: [], variants: [], supported: false, reason: UNSUPPORTED_REASON };
}

const BUILDERS = {
  claude: claudeConfig,
  chatgpt: chatgptConfig,
  "claude-code": claudeCodeConfig,
  codex: codexConfig,
  "gemini-cli": geminiConfig,
  cursor: cursorConfig,
  vscode: vscodeConfig,
  devin: devinConfig,
  "devin-legacy": devinLegacyConfig,
  cline: clineConfig,
  "cherry-studio": cherryConfig,
  trae: traeConfig,
  "kimi-code": kimiConfig,
  "deepseek-harness": deepseekConfig,
  lingma: lingmaConfig,
  chatwise: chatwiseConfig,
  yuanbao: unsupported,
  doubao: unsupported,
  zhipu: unsupported,
};

/** 正文里提到的环境变量名：缺口令时提示用户去创建 / 导出成哪一个。 */
function envVarNames(texts) {
  const names = new Set();
  const source = texts.join("\n");
  for (const match of source.matchAll(/bearer_token_env_var\s*=\s*"([^"]+)"/g)) names.add(match[1]);
  for (const match of source.matchAll(/"?bearerTokenEnvVar"?\s*:\s*"([^"]+)"/g)) names.add(match[1]);
  return [...names];
}

/** 统一收口：补齐 variants、补口令缺失 / 冲突提示、补「含密钥」提示，并算出 needsToken。 */
function finalize(result, { meta, pathToken, baseUrl, token }) {
  const variants = Array.isArray(result.variants) ? result.variants : [];
  const tok = String(token || "").trim();
  const inPath = normalizeBaseUrl(baseUrl).pathToken;
  // 不支持的条目不给可复制的正文：正文只有一份没有鉴权的地址，复制出去就是必然 401。
  // steps 只留「为什么不可用 + 怎么打开路径口令」，不再写「地址填上面那一行」。
  if (result.supported === false) {
    const reason = result.reason || UNSUPPORTED_REASON;
    const steps = reason === PATH_ONLY_REASON
      ? [reason, "在「设置 → 口令」里打开「公网允许路径令牌（/mcp/<令牌> 地址）」后重新生成，这一行才可用。"]
      : [];
    return {
      kind: result.kind || "form",
      text: "",
      steps,
      notes: [],
      variants: [],
      supported: false,
      reason,
      needsToken: false,
      pathToken: pathToken === true,
    };
  }
  const notes = Array.isArray(result.notes) ? [...result.notes] : [];
  if (pathToken && !tok && !inPath) {
    notes.push(`缺少口令：路径里的 ${PATH_TOKEN_PLACEHOLDER} 需要换成你在设置里创建的口令，并且先做 URL 编码（#、?、/、空格、中文等都要转义），否则客户端一定 401。`);
  }
  if (!pathToken && !tok) {
    const texts = [result.text, ...variants.map((variant) => variant.text)];
    // 只看主推正文：备选里的占位符由备选自己的复制提示负责，不能拿它去描述主推正文
    const bodyHasPlaceholder = String(result.text || "").includes(TOKEN_PLACEHOLDER);
    const names = envVarNames(texts);
    if (bodyHasPlaceholder) {
      notes.push("缺少口令：请求头里的 <你的口令> 需要换成你在设置里创建的口令，否则客户端一定 401。");
    }
    // 环境变量版正文里没有 <你的口令>，不能给一句「换请求头占位符」让人去找不存在的东西
    for (const name of names) {
      notes.push(`缺少口令：正文用的是 ${name} 环境变量，先在「设置 → 口令」创建一把口令并导出成该环境变量（或改用备选里的明文请求头版），否则客户端一定 401。`);
    }
    if (!bodyHasPlaceholder && !names.length) {
      notes.push("缺少口令：正文里的 <你的口令> 需要换成你在设置里创建的口令，否则客户端一定 401。");
    }
  }
  if (pathToken && inPath && tok && !sameToken(inPath, tok)) {
    notes.push("地址里带的是旧口令，已按传入的新口令重新生成；客户端仍失败时先清掉界面里缓存的旧地址。");
  }
  if (meta?.secretNote) {
    notes.push(pathToken
      ? "口令就在这段地址的路径里，等于把密码写在配置里，别外传、别提交。"
      : "请求头里的口令是明文，注意别把这份配置提交到 git。");
  }
  // 正文里带占位符（地址路径或请求头里）就说明「这份配置还缺口令」：
  // 界面据此在每行标注「需把 <你的口令…> 换成…」，不能只靠 notes（界面不一定渲染 notes）。
  const needsToken = [result.text, ...variants.map((variant) => variant.text)]
    .some((text) => String(text || "").includes("<你的口令"));
  return {
    kind: result.kind,
    text: result.text,
    steps: result.steps,
    notes,
    variants,
    supported: true,
    reason: null,
    needsToken,
    pathToken: pathToken === true,
  };
}

/**
 * 生成某个客户端的远程 MCP 配置。
 * @param {string} clientKey CLIENTS 里的 key
 * @param {{baseUrl?: string, token?: string, pathToken?: boolean}} options
 *   pathToken 只接受布尔（缺省 true）；为了兼容表单传递，0 / "false" / "0" 也按请求头模式处理。
 */
export function buildClientConfig(clientKey, { baseUrl = "", token = "", pathToken } = {}) {
  const usePath = normalizePathToken(pathToken);
  const rawBase = String(baseUrl || "").trim();
  if (rawBase && !normalizeBaseUrl(rawBase).base) {
    return {
      kind: "form",
      text: "",
      steps: [],
      notes: [],
      variants: [],
      supported: false,
      reason: INVALID_URL_REASON,
    };
  }
  const meta = CLIENTS.find((c) => c.key === clientKey);
  if (!meta) {
    // 旧版 Windsurf（Cascade）用 serverUrl，语义不同；新旧两个 key 都认
    if (clientKey === "windsurf") {
      return finalize(devinLegacyConfig({ baseUrl, token, pathToken: usePath }), { meta: { secretNote: true }, pathToken: usePath, baseUrl, token });
    }
    return {
      kind: "form",
      text: "",
      steps: [],
      notes: [],
      variants: [],
      supported: false,
      reason: `不认识的客户端：${clientKey}`,
    };
  }
  const build = BUILDERS[clientKey];
  if (!build) return finalize(unsupported(), { meta, pathToken: usePath, baseUrl, token });
  return finalize(build({ baseUrl, token, pathToken: usePath }), { meta, pathToken: usePath, baseUrl, token });
}

/**
 * 界面用的分组清单：按 GROUPS 顺序把 CLIENTS 分组，每条都带上生成好的配置。
 * 不支持的条目也保留（supported:false + reason），界面可以置灰并显示原因。
 */
export function buildClientConfigGroups(options = {}) {
  return GROUPS.map((group) => ({
    group,
    clients: CLIENTS.filter((c) => c.group === group).map((c) => ({
      key: c.key,
      name: c.name,
      secretNote: Boolean(c.secretNote),
      config: buildClientConfig(c.key, options),
    })),
  })).filter((g) => g.clients.length > 0);
}