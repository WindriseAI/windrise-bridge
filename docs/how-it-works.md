# Windrise Bridge 设计与实现说明

讲 Windrise Bridge 是怎么设计的、代码在哪、实测结果如何。

本项目最初参照一款同类软件的公开行为做了独立实现。下文的代码和文件名都指本仓库。

---

## 一、设计说明

### 1. 整体形态

Windrise Bridge 是一个 Electron 桌面应用。核心是一个纯 Node 写的本地 MCP 服务器，不依赖 Electron 也能单独跑（`npm start`）。界面只管启动、配置和展示。

| 文件 | 干什么 |
|---|---|
| `src/core/bridge.js` | MCP 服务端：令牌路由、Streamable HTTP、会话管理、健康检查、放行检查 |
| `src/core/route-token.js` | 路由令牌的生成与持久化 |
| `src/core/registry.js` | 工具注册表，负责算 `tools/list` 的并集 |
| `src/tools/toolset.js` | 内置工具的定义与装配 |
| `src/tools/files.js` / `src/tools/shell.js` | 文件工具、命令执行 |
| `src/tools/custom.js` | 用户自定义工具 |
| `src/core/external-mcp.js` | 外部 MCP 转发 |
| `src/core/guard.js` | 路径守卫、危险命令判定 |
| `src/core/workspace.js` | 工作区记录：身份算法、原子写、跨进程锁 |
| `src/core/tunnel.js` / `src/core/edge-relay.js` | 三种隧道、代理中继、租约 |
| `src/core/activation.js` / `src/core/account.js` / `src/core/license.js` | 激活、通道授权、许可证签发与校验 |
| `electron/main.cjs` | 主进程，把上面这些串起来 |

### 2. MCP 地址的形状

```
http://127.0.0.1:<端口>/mcp/<32位令牌>
https://<隧道域名>/mcp/<32位令牌>
```

- 传输层用官方 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`。POST 收 JSON-RPC，GET 开 SSE 流，DELETE 结束会话。
- **令牌放在 URL 路径里**。ChatGPT Connector、Arena、Manus 这类客户端只让填一个 URL，没地方放自定义请求头。令牌是 16 字节随机数，转成 32 位十六进制。猜不到令牌就进不来，相当于把口令藏在地址里。
- 令牌存在 `~/.bridge-replica/route-token.json`，权限 0600。重启后地址不变，用户贴进客户端的 URL 不会失效。
- 端口默认随机。接命名隧道时要固定端口（`BRIDGE_PORT` 环境变量或设置页）。固定端口被占用时退回随机端口并提示用户，见第三章第 15 节。

### 3. 错误令牌一律 404

`BridgeServer.matchRoute()` 拿完整路径和正则比对。令牌错、没带令牌、访问根路径，统统返回 404 `not_found`。扫描器分辨不出这台机器上有没有服务。

根路径早期会返回服务名和工具数，和这条规则矛盾，后来也改成了 404。

另外两道门：

- **CORS 只放行本机来源**：控制面板、本地页面、`file://` 页面发出的 null origin。不写通配符，别的网页读不到桥的状态。
- **没有会话的 GET / DELETE 返回 400**，提示先用 POST 完成 initialize，免得客户端误以为已经接通。

### 4. 健康检查

```
GET /healthz/<同一个令牌>
```

本机探针和公网探针都打这个地址。返回运行状态、运行时长、工具数、会话数、调用次数、失败次数、平均耗时、成功率（`BridgeServer.health()`）。

健康检查也要令牌。不带令牌拿到的还是 404，所以它不会暴露服务。

### 5. 会话隔离

- 每个客户端 initialize 时，新建一个 transport 和一个 MCP Server 实例，用 `mcp-session-id` 区分。多个客户端可以同时连，互不干扰。
- 会话上限 32 个。满了就关掉最久没活动的那个。
- 空闲 30 分钟自动回收。
- transport 关闭时从会话表里删掉，同时给界面发一条 `session-close` 事件。

### 6. tools/list 是现算的并集

同一个地址的工具数会变。原因是 `tools/list` 每次请求都重新算一遍：

```
tools/list = 内置工具 ∪ 用户自定义工具 ∪ 外部 MCP 转发的工具
```

挂的东西越多，数字越大。

**① 内置工具（18 个）**，定义在 `src/tools/toolset.js`：

| 类别 | 工具 |
|---|---|
| 文件（6） | `read_files` `read_image` `find_files` `search_files` `apply_patch` `batch_file_tools` |
| IDE / 终端（7） | `list_directory` `run_command` `get_command_output` `send_command_input` `cancel_command` `get_diagnostics` `lsp` |
| 控制面（5） | `set_todos` `update_plan` `report_progress` `list_skills` `configure_mcp` |

界面开着时还会多出浏览器工具（`src/tools/browser.js`）、共享上下文工具（`src/tools/context.js`）和操作软件本身的 `windrise_*` 工具（`src/tools/app.js`）。实测过一次是 18 + 10 + 11 = 39 个。

**② 用户自定义工具**（`src/tools/custom.js`）：一条 JSON 规格就是一个工具，存在 `<数据目录>/custom-tools.json`。有三种类型：`http` 发请求，`command` 跑命令模板，`text` 返回固定文字。界面保存后热更新。注册表另外支持从目录加载 `.mjs` 插件（`reloadCustomTools()`）。

**③ 外部 MCP 转发的工具**：用户自己挂的 MCP 服务器，工具被代理进来，见第 8 节。

**工具注解**：每个工具按类别（read / write / execute / control）自动带上 annotations（`registry.js` 的 `defaultAnnotations()`）。只读工具标 `readOnlyHint`，客户端可以自动批准。写入和执行类标 `destructiveHint`，客户端应该让人确认。`command` 类自定义工具跑的是本地命令，归到执行类。

**技能另算**：`list_skills` 返回技能目录清单，每个技能是一个文件夹加一份 `SKILL.md`。技能是说明书，模型拿到清单后要去读文件，别把技能名当工具调用。

### 7. 工具调用怎么落地

```
外部客户端 → POST /mcp/<令牌> → tools/call
  → registry 按名字找到 handler，先校验参数
  → 文件类：过路径守卫（只能碰用户允许的工作区）
  → 命令类：交给 shell.js，每条命令一个独立进程
  → 外部工具：查绑定表，转发给上游 MCP
```

- 文件工具只能碰用户在设置里允许的工作区文件夹。越界抛 `PathDeniedError`，说清原因。运行中改工作区立即生效，不用重启 Bridge，也不断隧道。
- 高危命令（比如递归删除）先要求人工确认。
- `run_command` 每条命令起一个独立进程。脚本先写进临时文件再整体解析，多行命令和 here-string 都正常，语法错误直接报回来。默认等 120 秒，还没跑完就返回 `status=running` 和 `command_id`。之后用 `get_command_output` 增量读输出，`send_command_input` 喂输入，`cancel_command` 中断。一条卡住不影响别的。`cd` 会被记住。
- 早期的做法是一个常驻 PowerShell，往 stdin 写命令。只要有一条多行命令没闭合，PowerShell 就一直等下一行，后面所有命令跟着卡死。所以改成了现在的样子。

### 8. 外部 MCP 转发

代码在 `src/core/external-mcp.js`，自检 `node src/external-mcp-selftest.mjs`。用户挂上自己的 MCP 服务器（stdio 或 HTTP），它的工具被代理进 Bridge 的清单。规则如下。

1. **命名**：`ext__<服务器id>__<净化后的工具名>`。净化就是转小写、把 `[a-z0-9_]` 以外的字符换成下划线。用双下划线分隔，因为工具名本身常带单下划线。注册表限制工具名总长 64，超长时截断并追加 6 位短指纹，防止两个工具截断后同名（`externalToolName()`）。
2. **本地工具名是保留字**：外部工具不能占用内置、浏览器、自定义工具的名字（`reservedToolNames()`）。被拦下的名字单独列出来。
3. **撞名双双丢弃**：同一个服务器里两个工具净化后重名，两个都不要，并记日志。没法判断调用者想要哪一个，宁可都不给。
4. **转发靠绑定表**：维护一张 `暴露名 → { serverId, upstreamName }` 的表，调用时拿上游原名转发。从不靠暴露名反推原名。
5. **超时分三级**：连接 5 秒、列工具 3 秒、调用 20 秒。配置里 `timeout` 的单位是秒，可以用 `toolTimeouts` 按上游工具名单独设。参数里自带 `duration` / `timeout` 的工具，至少给到它自己的时长加 5 秒。外层再套一层 deadline 兜底。
6. **HTTP 传输只在协议不匹配时回退**：`auto` 模式先试 streamable-http，只在「传输方式不匹配」的状态码上回退到 SSE。鉴权失败、限流、服务端错误、网络错误都不回退。否则鉴权失败会被当成换协议能解决，白白多打一次请求。
7. **origin 守卫**：请求不许离开配置的 origin，URL 里不许带用户名、密码、锚点，fetch 用 `redirect: 'error'`。防止配置的服务器把请求带到第三方去。守卫拦下时有单独的中文提示，用户能看懂是地址被拒。
8. **stdio 的 stderr 只排空不记录**：里面可能带凭据。
9. **工具清单缓存 30 秒**，带配置指纹。上游通过 `listChanged` 通知变更，或者断线，都会让缓存失效，下次 `tools/list` 自动重连。

管理入口是内置的 `configure_mcp` 工具和界面。配置文件损坏、命令起不来、缺 url，Bridge 照常启动，只记日志。

### 9. 工作区记录

代码在 `src/core/workspace.js`。

1. **身份**：工作区 ID = `sha256("bridge-hub-workspace-v1::" + 工作区存储键)`。故意不掺窗口会话。掺了的话，每次重载都会把同一批记录当成新的再导入一遍。
2. **三种形态**：`folder`（单文件夹）、`workspace`（多根工作区文件）、`empty`（空窗口）。
3. **共享目录**：按 `BRIDGE_SHARED_DATA_HOME` > `BRIDGE_PORTABLE/shared-data` > `~/.bridge-replica-shared` 的顺序找，落在 `workspace-hub/` 下。多个实例共用一份。
4. **落盘**：一条记录一个文件，写入走「临时文件 + rename」原子替换，权限 0600。
5. **跨进程互斥**：独占创建锁文件，超过 30 秒算陈旧锁，直接回收。只靠 `node:fs`，跨平台可用。
6. **心跳**：窗口记录带时间戳，60 秒没更新就当残留忽略。
7. **令牌不入盘**：写进共享记录的地址会把令牌抹成 `/mcp/••••••`（`redactUrl()`）。

Windows 上 rename 会撞上别的进程正在读的文件，需要退避重试，见第三章第 12 节和第 16 节。

### 10. 授权模型

1. **激活**：用户输入激活码，服务器核销并绑定本机设备 ID，签发一份短期许可证（`src/core/activation.js`）。
2. **许可证格式**：Ed25519 签名的 JWT。公钥内置在客户端，私钥只在服务器上。客户端只信签名，设备 ID 对不上、过期、被改过一个字节都算无效。claims 结构：

   ```json
   {
     "iss": "<许可服务器>",
     "aud": "bridge-replica-desktop",
     "sub": "<账号标识>",
     "kind": "license",
     "features": ["tunnel:cloudflare-quick"],
     "installation_id": "<本机设备 ID>",
     "exp": 1234567890,
     "entitlement_exp": 1234567890
   }
   ```

3. **有效期与续期**：许可证最长 7 天，不超过激活到期时间。在线时至少每 12 小时核对一次，剩不到 3 天就续。断网可以一直用到许可证过期。
4. **防改时间**：记下见过的最晚时间。判断过期时取它和当前时间中较晚的那个，把系统时间往回调没用。
5. **通道授权**：三种隧道各对应一个 feature，`tunnel:cloudflare-quick`、`tunnel:cloudflare-named`、`tunnel:ngrok`（`src/core/account.js`）。开隧道前由主进程的 `assertChannel()` 检查。
6. **多道独立检查**：激活页、隧道启动前、隧道连上后和定时巡检、`bridge.js` 处理 MCP 请求前，各自读文件、各自验签，互不调用。改掉其中一处，其它几处照样拦。`bridge.js` 这一道还会核对程序文件清单的签名和关键文件的哈希。检查结果缓存 90 秒，检查本身出异常按不放行处理。没通过时返回 403 和 JSON-RPC 错误 `-32001`，带中文原因。
7. **自建服务端**：`src/core/license.js` 里有签发函数 `issueLicenseToken()` 和校验类 `LicenseVerifier`。想自己部署许可服务器，可以直接用。`npm run license` 自检「签发 → 验签 → 篡改必拒」。

### 11. 隧道：三种模式

代码在 `src/core/tunnel.js`。

| 模式 | 原理 | 成本 |
|---|---|---|
| **Cloudflare 快速隧道**（默认） | 跑 `cloudflared tunnel --url http://127.0.0.1:<端口>`，从输出里抓 `https://xxx.trycloudflare.com` | 免费、零配置、地址每次启动都变 |
| **Cloudflare 命名隧道** | 用自己的隧道凭据和固定域名，`cloudflared tunnel --config <文件> run` | 要有域名和 Cloudflare 账号 |
| **ngrok** | `ngrok http <端口> --domain=...` | 要有 ngrok 账号和 authtoken |

### 12. 隧道的坑和对策

- **快速隧道必须用自己写的配置文件**。启动参数带 `--config`，指向 Bridge 自己写的一份最小配置。不这么做的话，cloudflared 会读 `~/.cloudflared/config.yml`，用户给别的服务配的 ingress 会把 Bridge 地址劫持成 404。
- **只认真注册成功**：连上与否只看 cloudflared 日志里的 `Registered tunnel connection`，不信端口探测。每种连接方式最多等 45 秒。
- **只有系统代理、没有 TUN 的机器**：cloudflared 连边缘是直拨 7844 端口，既不读系统代理，也不认 `HTTPS_PROXY`，于是一直卡在 connecting。`src/core/edge-relay.js` 在本机起一个 TCP 中继，每条连接经代理 CONNECT 到边缘，cloudflared 用 `--edge 127.0.0.1:<端口> --protocol http2` 连中继。中继只搬字节，不碰证书。整个过程只读代理配置，不改系统设置，不需要管理员权限。
- **ngrok 免费版不接受 HTTP 代理**：启动 ngrok 时把继承的 `*_proxy` 环境变量摘掉，直连。authtoken 走环境变量传，不放命令行，因为命令行在进程列表里谁都看得见。没填 authtoken 时直接报错，并给出去哪里拿。
- **断线重连**：子进程意外退出，按 1、2、4、8、15 秒退避重启。所有方式都失败后，每 30 秒复查一次网络，用户关了代理或加了规则就自动恢复。电脑时间不准、凭据错误这类问题重试没用，直接停下报错。
- **多实例别抢配置文件**：命名隧道的配置文件名带端口，`cloudflared-named-<端口>.yml`，见第三章第 14 节。

### 13. 隧道租约互斥

固定地址的隧道同一时间只能被一个实例占用，否则两个 cloudflared 抢同一个域名，流量随机落到其中一个上。

`TunnelLease`（`src/core/tunnel.js`）按域名或令牌算出一个租约文件 `~/.bridge-replica/tunnel/lease-<摘要>.json`，里面记 pid 和时间。

- 租约在 30 秒内更新过，且那个 pid 还活着：拒绝，提示用户换一个域名，或先停掉那个实例。
- 否则接管租约。
- 释放时删掉租约文件。

> 现状：`TunnelLease` 已经写好，还没接进隧道启动流程。抢不到租约时自动改用快速隧道的逻辑也还没做。

### 14. 成本

本地 MCP 服务器只占本机端口，快速隧道免费。模型推理不走 Bridge，外部 Agent 调工具花的是用户自己客户端的额度。Bridge 只负责递命令、回结果，流量很小。

---

## 二、作业实现

### 目录结构

```
bridge-replica/
├── src/                        核心（纯 Node，不需要 VS Code / Electron）
│   ├── core/
│   │   ├── bridge.js           MCP 服务端：令牌路由 + Streamable HTTP + 健康检查
│   │   ├── registry.js         工具注册表：三层并集的实现
│   │   ├── guard.js            路径守卫 + 危险命令判定
│   │   ├── workspace.js        工作区：身份算法 + 原子写 + 跨进程锁
│   │   ├── tunnel.js           三种隧道 + 租约互斥
│   │   ├── license.js          Ed25519 许可校验 + GitHub 设备码登录 + 支付轮询
│   │   └── route-token.js      路由令牌生成与持久化
│   ├── tools/
│   │   ├── files.js            文件类工具实现
│   │   ├── shell.js            终端管理器 + IDE 类工具
│   │   └── toolset.js          18 个内置工具的定义与装配
│   ├── standalone.js           命令行入口
│   ├── capability-demo.mjs     工具能力实测
│   └── license-selftest.mjs    许可链路自检
├── electron/
│   ├── main.cjs                主进程：串起 Bridge + 多开浏览器 + 面板
│   ├── preload.cjs             IPC 窄通道
│   ├── browser-profiles.cjs    多账号浏览器管理器（分区 + 代理 + 指纹装配）
│   ├── browser-control.cjs     浏览器控制服务（给 Agent 用的 HTTP 接口）
│   ├── fingerprint.cjs         指纹生成与补丁源码
│   ├── fingerprint-preload.cjs 指纹注入（页面脚本之前执行）
│   ├── index.html              控制面板
│   └── ui/{app.css,app.js}     界面样式与逻辑（浅色主题）
└── docs/                       本文档 + 界面截图
```

核心模块里还有两个值得单独提的：

| 文件 | 干什么 |
|---|---|
| `src/core/lsp.js` | tsserver 客户端：换行分隔的裸 JSON 协议、诊断事件收集、按项目缓存进程池 |
| `src/tools/diagnostics.js` | `get_diagnostics` 与 `lsp` 的真实实现；引擎不可用时如实降级并说明原因 |
| `src/tools/browser.js` | 10 个浏览器工具的 MCP 侧；读发现文件找到控制服务，带超时与错误翻译 |

### 跑起来

```bash
npm install

# 命令行跑 Bridge（不开界面）
npm start

# 只打印工具清单（含浏览器工具，会标注是否在线）
npm run tools

# 端到端自检（启动 → 握手 → 列工具 → 真调用 → 令牌校验）
npm run selftest

# 工具能力实测（读写文件、执行命令、越界拦截、审批门）
npm run capability

# 语言服务实测（造一个真有小毛病的项目，验证诊断与跳转）
npm run lsp

# 许可链路自检（签发 → 验签 → 篡改必拒）
npm run license

# 开界面（需要 GUI 会话；注意清掉 ELECTRON_RUN_AS_NODE）
npm run ui

# 开界面并允许 browser_eval（等于把页面控制权交出去，谨慎）
npm run ui:eval

# 真实公网隧道端到端验证
npm run tunnel:test
```

> 坑：环境里如果设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node，根本不进 GUI 模式。开界面前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

### 浏览器工具怎么让 Agent 用上

```
外部 Agent → Bridge（MCP）→ 浏览器控制服务（本机 HTTP + 令牌）→ Electron 窗口
```

- 控制服务随界面启动，**只绑 127.0.0.1**、端口随机、令牌放在 URL 路径里
- 端口和令牌写到 `~/.bridge-replica/browser-control.json`（权限 0600），MCP 工具读它来发现服务
- 界面一关，工具就自动从 `tools/list` 里消失（启动时探测一次）
- `browser_eval` 默认关闭 —— 它等于把页面完全交出去

### 指纹伪装怎么做的

```
窗口 id → sha256 派生种子 → 确定性随机数 → 一套自洽的设备参数 → 注入页面
```

- **稳定性优先**：同一个窗口每次打开必须得到同一套参数。指纹天天变，比不变更可疑。
- **注入时机**：preload 比页面任何脚本都先执行，这是唯一可靠的时机。
  参数通过 `additionalArguments` 传（base64），同一个 preload 文件服务所有窗口。
- 处理的项目：`navigator`（平台/核数/内存/语言）、`screen`、`devicePixelRatio`、
  `Intl` 时区、Canvas 像素噪声、WebGL 显卡型号、AudioContext、WebRTC 候选地址。

### 多账号浏览器怎么做的

核心就一句：**Electron 的 session 分区就是物理隔离的浏览器身份。**

```js
const ses = session.fromPartition(`persist:profile-${profile.id}`);
```

- `persist:` 前缀 → Cookie / localStorage / IndexedDB / 缓存全部**落盘保存**
- 不同分区之间**互不可见**，所以同一个网站能同时登 N 个账号
- 落盘位置：`%APPDATA%\<app>\Partitions\profile-<id>\`
  - Cookie 在 `Network\Cookies`
  - localStorage 在 `Local Storage\leveldb\`
- 同一窗口重复点「打开」只会聚焦，不会新开——两个窗口抢同一份 Cookie 会互相踢下线
- 每个窗口可以配独立代理、独立 UA、独立指纹

想加指纹伪装（Canvas/WebGL/字体/时区打散）的话，是在窗口里注入 patch 脚本，接口位置已经留好了。

---

## 三、实测记录

### 1. 工具能力（`npm run capability`，12 项全过）

| 项 | 结果 |
|---|---|
| 列目录 / 读文件（带行号） | 读到真实磁盘 |
| 内容搜索（ripgrep，带行号） | 命中 |
| 按名查找（通配符） | 命中 |
| **打补丁改代码** | 改完磁盘真的变了（绕过工具直接读文件复核过） |
| 执行命令并拿输出 | `node src/app.js` → `hello world!` |
| 越界读系统文件 | 被拦住，报清楚原因 |
| 高危命令（递归删除） | 先要求人工确认 |
| 确认后放行 | 走通 |

### 2. 多账号隔离与持久化

| 项 | 结果 |
|---|---|
| 两个窗口打开同一站点，各写不同标识 | Cookie / localStorage **各是各的** |
| 主进程侧第三方核对 | 两个分区各 1 条 cookie，互不可见 |
| 关掉两个窗口 → 重新打开 | **登录态都还在** |
| 磁盘取证 | 每个分区各有独立的 `Network\Cookies`、`Local Storage\leveldb`、`Session Storage` |

### 3. MCP 端点（外部客户端视角）

| 项 | 结果 |
|---|---|
| `initialize` | 200，协议 `2025-06-18` |
| `tools/list` | 18 个工具（开界面后 28 个，多出 10 个浏览器工具） |
| `tools/call` 真调用 | 200，返回真实目录内容 |
| 未知工具 | 标记 `isError` |
| 错误令牌 | 404 |
| 健康检查 | 200，带工具数 / 会话数 / 成功率 |

### 4. tsserver 语言服务

| 项 | 结果 |
|---|---|
| 引擎 | TypeScript 5.9.3 自带的 `tsserver.js` |
| 类型诊断 | 4 个真错误全部报出，行号列号准确，带 TS 错误码 |
| 跳定义 | `src/main.ts:1:10` → `src/math.ts:1:17` |
| 找引用 | 4 处，含定义处与三处使用 |
| 列符号 | 带 `export` 修饰符与精确行列 |
| 看类型 | `const total: number` |
| 补全 | 1004 项候选 |

### 5. 浏览器 MCP 工具（10 个）

| 项 | 结果 |
|---|---|
| 工具挂载 | `tools/list` 从 18 变 28 |
| `browser_profiles` | 列出全部窗口，含分区名与运行状态 |
| `browser_open` | 打开并返回分区 |
| `browser_snapshot` | 读到标题、地址、正文、可操作元素清单 |
| `browser_type` | 真的填进输入框（原生 setter + input/change 事件，React 也认） |
| `browser_click` | 真的点到按钮，页面响应 |
| `browser_screenshot` | 640x422 PNG，56 KB |

### 6. 指纹伪装

| 项 | 窗口A | 窗口B | 结论 |
|---|---|---|---|
| 补丁生效 | 是 | 是 | ✅ |
| 时区 | `America/New_York` | `Asia/Shanghai` | 不同 ✅ |
| 平台 | `Win32` | `Linux x86_64` | 不同 ✅ |
| CPU 核数 | 16 | 4 | 不同 ✅ |
| 内存 | 4 GB | 8 GB | 不同 ✅ |
| 屏幕 | `3840x2160 @1.5x` | `1440x900 @2x` | 不同 ✅ |
| 语言 | `en-US` | `zh-CN` | 不同 ✅ |
| Canvas 哈希 | `461072912` | `53264332` | 不同 ✅ |

同一窗口重复打开，参数完全一致（指纹稳定）；不同窗口互不相同。

### 7. 真实公网隧道

实测拉了一条真的 Cloudflare 快速隧道：

| 项 | 结果 |
|---|---|
| 客户端 | cloudflared 2026.10.0 |
| 建连耗时 | 约 6 秒 |
| 公网地址 | `https://cement-cho-chassis-influenced.trycloudflare.com` |
| 连通性 | 健康检查第 1 次尝试即通过 |
| 公网 `initialize` | HTTP 200，协议 `2025-06-18` |
| 公网 `tools/list` | 28 个工具 |
| 公网真实调用 | 读到了本机 `package.json` 前 8 行 |
| 公网上错误令牌 | HTTP 404 |

也就是说，这个地址可以直接填进 ChatGPT / Claude / Arena 的 MCP 连接器使用。

### 8. 外部 MCP 转发

把外部 MCP 服务器的工具代理进自己的清单。命名格式见第一章第 8 节：`ext__<服务器id>__<净化后的工具名>`。

| 项 | 结果 |
|---|---|
| stdio 传输 | 连通并转发成功，`ext__test__echo` → `"echo:hello-from-selftest"` |
| HTTP(Streamable) 传输 | 连通并转发成功 |
| 结构化返回值 | `structuredContent` 原样透传（`{"sum":42}`） |
| 前缀防撞 | 上游叫 `read_files` 时挂成 `ext__github__read_files`，内置不受影响 |
| 撞名抑制 | 同服务器内净化后重名 → **两个都丢弃**并记日志 |
| 保留名守卫 | 对抗性测试 11/11：外部工具无法冒充本地工具名，被拦后原实现完好 |
| 断线重连 | SIGKILL 上游 → 优雅报错 → 下次 `tools/list` 自动重连 → 调用恢复 |
| 进程清理 | `stop()` 后子进程零残留（PID + tasklist + 全进程扫描三重确认） |
| 容错 | 配置损坏 / 命令起不来 / 缺 url → Bridge 照常启动，只记日志 |
| 自检 | `node src/external-mcp-selftest.mjs` → **56/56** |

### 9. 共享上下文总线（多窗口共享记忆）

把几个窗口「链接」成一组，它们共用一块本地记忆 —— 一个窗口里的 Agent 学到的东西，同组其它窗口能直接读到。

**注意：共享的是记忆，不是身份。** 各窗口的 Cookie / 登录态 / 指纹依然完全隔离。

| 项 | 结果 |
|---|---|
| 自检 | `node src/context-bus-selftest.mjs` → **63/63** |
| 跨实例一致性 | 界面侧与 MCP 侧各建一个实例 → **14/14**，两边看到同一份数据 |
| 界面链路 | 建组 → 链接窗口 → 写记忆 → 同组可读 → 隔离完好 → 重载后还在 → **12/12** |
| 跨进程持久化 | 另起进程能读到（真落盘） |
| 并发 | 同进程 30 并发 → 30 条；4 子进程各写 5 条 → 20 条一条不少 |
| 隔离 | B 组三种查法都搜不到 A 组的数据；对照 A 组能命中 |
| 成员守卫 | 不是组员的窗口写不进组（防跨组污染） |
| 上限 | 超长 value 明确报错（`value_too_large`），不静默丢弃 |
| 过期 | ttl 到点后检索不到，`prune()` 真删 |

覆盖语义值得记一下：**同一个 `(组, 来源窗口, 键)` 三元组才是更新**。
两个不同 Agent 用同一个键 → 各留一份（每个 Agent 该有自己的备注，不该互相覆盖）。

### 10. 打包成桌面应用

| 项 | 结果 |
|---|---|
| 打包命令 | `node scripts/build.mjs`（走 npx，不污染 package.json） |
| 安装包 | `dist\bridge-replica-0.1.0-setup.exe` 78.1 MB |
| 免安装版 | `dist\bridge-replica-0.1.0-portable.exe` 77.8 MB |
| 包内容校验 | 包内 `src/` 18 个文件与磁盘**逐文件 SHA256 完全一致** |
| 启动验证 | 窗口出现、界面渲染正常、点「启动 Bridge」后 MCP 地址可用 |
| 核心功能 | `/healthz` 返回 `tools: 39`；MCP 握手 + `tools/list` 成功 |

**打包踩的两个坑**：

1. **asar 必须关**。`src/` 是 ESM，主进程用 `import(pathToFileURL(...))` 动态加载；
   Node 的 ESM loader 读不到 asar 里的内容 → 抛 `Unexpected end of input`。
   代价是安装目录有 2537 个文件。
2. **Chromium 开关要放在路径前面**。`electron --remote-debugging-port=9223 .` 才会绑端口；
   写成 `electron . --remote-debugging-port=9223` 端口根本不会起来（这个坑排查了一阵）。

### 11. 命名隧道（固定公网地址）

固定地址 = 重启也不变的公网入口。实测在一个自有域名上跑通了（下文用 `mcp.example.com` 代替）。

**Cloudflare 的命名隧道有三种形态，配置在哪决定了改哪里有用：**

| 形态 | 凭据 | 配置在哪 | 改法 |
|---|---|---|---|
| ① 仪表板管理 | 令牌 | Cloudflare 后台 | 后台或 API |
| ② 本地管理 | 凭据 JSON | 本地 `config.yml` | 改文件 + 重启 |
| ③ **混合** | 凭据 JSON | **云端**（覆盖本地） | 只能走 API/后台 |

形态③最容易踩：本地明明有一份 `config.yml`，但隧道在 Cloudflare 那边的
`config_src` 是 `cloudflare` —— **云端配置覆盖本地，改本地文件完全没用**。

怎么认出来：看 cloudflared 日志里有没有 `Updated to new configuration ... version=N`。
**有 version 号 = 用的是云端配置**（本地配置不会有版本号）。

**这次真实排查的完整链路（四步才定位）：**

```
1. 本地 config.yml 加了规则        → 不生效
2. 发现是形态③（云端配置）          → 改云端配置
3. 还是不生效                      → 发现 DNS 的 CNAME 指向的是【另一条隧道】
4. 改 DNS 指向正在跑的那条          → 通了
```

**所以排查顺序应该是（顺序反了就会像这次一样白忙）：**

```
① DNS 指向哪条隧道      ← 最常见，也最容易被跳过
② 那条隧道有没有连接器  ← 没连接器必然 530
③ 配置在本地还是云端    ← 云端会覆盖本地
④ 域名有没有匹配的规则
```

`node tools/tunnel-doctor.mjs mcp.example.com` 一条命令把这四步全查一遍。

**实测结果：**

| 项 | 结果 |
|---|---|
| 固定地址 | `https://mcp.example.com/mcp/<令牌>` |
| 健康检查 | HTTP 200 · 39 个工具 |
| MCP 握手 | HTTP 200 · 协议 `2025-06-18` · 会话已下发 |
| 工具清单 | 39 个 = 内置 18 + 浏览器 10 + 上下文 11 |
| 真实调用 | 列目录、读共享上下文状态都成功 |
| 错误令牌 | HTTP 404（正确） |
| 连测 8 次 | 8/8 全部 200（多副本负载均衡下稳定） |

**固定端口是前提。** cloudflared 的规则里写的是死端口，桥每次随机换端口的话隧道永远指不到。
所以支持了 `BRIDGE_PORT` 环境变量和 `boot({ port })` 参数：

```bash
BRIDGE_PORT=48272 node src/standalone.js
```

---

### 12. 跨进程并发写：Windows 上的 rename 竞态（实测修掉的真 bug）

共享上下文支持多个窗口同时写，写盘用的是「临时文件 + rename 覆盖」这个标准原子写法。
但在 Windows 上它会**间歇性失败**：

```
EPERM: operation not permitted, rename 'context-bus.json.<uuid>.tmp' -> 'context-bus.json'
```

**根因**：Windows 不允许重命名覆盖一个**正被其它进程打开**的文件，此时 rename 直接抛
EPERM 而不是排队等对方关掉。而我们的锁只挡写者、挡不住读者 —— 另一个进程用
`readFile` 读的时候文件会被短暂打开，写者的 rename 正好落在这个窗口里就失败了。

**症状有多严重**：4 个子进程并发各写 5 条，**约 10% 的概率有 1~2 个进程报 EPERM 退出，
那些写入全部丢失**。放到真实使用上就是：两个窗口的 Agent 同时写共享记忆，有一方的改动静默消失。

**修复**：rename 失败时对 EPERM / EBUSY / EACCES 退避重试（12 次，5ms 起每次乘 1.6，
总预算约 0.5 秒）。读者的打开窗口极短，重试就够了，不用改锁模型。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 4 子进程并发 × 10 轮 | **失败 1 次** | 0 次 |
| 自检连跑 | 1/10 失败 | **50/50 通过** |
| 8 子进程并发 × 40 轮（压力翻倍） | — | **40/40 通过** |
| 合计验证轮数 | — | **175 轮 0 失败** |

排查过程中的两个弯路（记下来免得重走）：
1. 一开始按进程名判断 tsserver 有没有被当应用拉起 —— **错的**，
   加了 `ELECTRON_RUN_AS_NODE=1` 之后进程名不变，得看它有没有 GPU/renderer 子进程。
2. 一开始用自己写的子进程脚本复现，25 轮全过 —— **条件不对**。
   自检的子进程写完之后还会读一次，那个读才是撞上 rename 的关键动作。

---
### 13. 开机自启与固定端口（让应用自己管全套）

原来要手工做三件事：设环境变量、手动起桥、手动起隧道。现在界面上填一次就行。

**设置页新增「启动与公网地址」卡**，存到 `~/.bridge-replica/settings.json`：

| 字段 | 说明 |
|---|---|
| Bridge 端口 | 0 = 随机（最省心）；接命名隧道必须固定 |
| 公网域名 | 例如 `mcp.example.com` |
| 隧道 ID 或名字 | 与「令牌」二选一 |
| 凭据文件 | 留空则自动在 `~/.cloudflared` 里按隧道 ID 匹配 |
| 隧道令牌 | 仪表板管理模式才填 |
| 自动连隧道 | 启动 Bridge 后自动连 |
| 自动启动 Bridge | 打开程序就起桥 |
| 开机自启 | 写注册表 `HKCU\...\Run`，不需要管理员权限 |

**实测**（关掉一切手动进程，只启动应用，不点任何按钮）：

```
桥            → 48272 上自动起来
cloudflared   → 由应用自己拉起（父进程 electron.exe）
隧道模式      → named（命名隧道，不是快速隧道）
公网地址      → https://mcp.example.com
固定地址实测  → 6/6 全部 HTTP 200
```

**这一版修掉的三个真 bug**（都是「配置了但不生效」这类最难发现的）：

| bug | 表现 | 根因 |
|---|---|---|
| `TunnelManager` 直接读 `process.env` | 界面上填的隧道参数被**静默忽略** | 构造函数没有 `env` 参数，传进去的选项被丢掉 |
| 分支只认 `provider === "cloudflare-named"` | 填了域名却走**快速隧道**，公网地址每次启动都变 | 应用传的是 `"cloudflare"`，判断条件对不上 |
| 命名隧道不设 `publicUrl` | 隧道明明是通的，界面显示「未启动」 | 快速隧道从日志抓 URL，命名隧道不打印那一行 |

第三个的教训：**「静默降级」比报错更难查** —— 快速隧道也是正常的 running 状态，
日志里一切正常，只有公网地址在变。所以现在快速隧道启动时会额外打一行提示，
明确告诉用户「地址每次会变，要固定地址请去设置里配」。

**开机自启的坑**：`reg delete` 在值不存在时返回非零，而它的错误信息是
**系统编码**的（中文 Windows 上是 GBK），在 Node 里读出来是乱码，没法用文本判断。
所以改成**查状态**而不是猜错误信息 —— 删完再查一次，值没了就算成功，这样重复操作也幂等。

### 14. 多实例共存：一个文件记录一个实例是不够的

测试时同时开着开发版和打包版，暴露出一串「两个实例抢同一个文件」的问题。
这类 bug 单实例用户碰不到，但一旦碰到就非常难查（现象都指向别的地方）。

| 抢的东西 | 现象 | 改法 |
|---|---|---|
| `browser-control.json` | 先退出的把文件删了，活着的那个反而被判成「界面未运行」 | 每个实例另写一份 `browser-control-<pid>.json`；读取端扫目录逐个探活；删除前先确认是自己写的 |
| `cloudflared-named.yml` | 隧道指向的端口莫名变成另一个数 | 文件名带上端口：`cloudflared-named-<端口>.yml` |

**测试脚本自己也踩了同一类坑**（记下来免得重犯）：

1. **挑错了 CDP 窗口** —— `targets.find(t => t.url.includes("index.html"))`。
   测试站点的地址是 `http://127.0.0.1:19555/index.html`，URL 里也有 `index.html`，
   而多开浏览器测试会打开好几个这种窗口。结果挑中测试站点，那上面当然没有侧栏按钮，
   表现为「等 25 秒还没就绪」的假 flake。改成只认 `file:` 协议的面板。
2. **连上 CDP ≠ 页面渲染完** —— 直接 `querySelector(...).click()` 会拿到 null。
   加了共享的 `waitForPageReady`。
3. **断言写死数字** —— `expect: /通过 13\/13/`。测试里加一个检查项，这里就失效了，
   而且失效方式很误导：**测试明明 14/14 全过，验收却报失败**。改成通用判定
   `allPassed`（比较两边的数字是否相等）。

### 15. 端口被占用时应该退让，不是罢工

固定端口只是「方便接命名隧道」的手段，不是目的。用户开两个实例、或者别的程序占了 48272，
都不该导致整个应用不可用。

所以 `listen` 遇到 `EADDRINUSE` 时**退回随机端口**，并且明确告知：

```
端口 48272 被占用，已改用 1869。功能都正常，但命名隧道指向 48272 会连不上 ——
要么关掉占用端口的程序，要么把隧道规则改到 1869。
```

### 16. 重试预算要给够：0.5 秒在机器忙的时候不够

第 12 节那个 rename 重试，一开始给的是 12 次 / 约 0.5 秒。单独跑没问题，
但**在全量验收里偶发失败** —— 那时候 Electron + 桥 + cloudflared 都在跑，
读者的打开窗口被拉长，0.5 秒就不够了。

改成 25 次 / 约 4 秒（锁超时是 20 秒，放得下）。改完负载下 30/30 全过。

**教训**：这类「重试几次」的预算不能只按空载测出来的值定，要按**目标环境最忙的时候**定。



---
### 17. 一键开通固定地址（把手工四步合成一次）

原来开一条固定地址要手工四步，**每一步都能卡住**：

| 手工步骤 | 卡在哪 |
|---|---|
| ① 建隧道 | 得先 `cloudflared tunnel login`，浏览器授权 |
| ② 拿凭据 | 凭据文件名是**隧道 UUID**，但 config 里写的是**隧道名字**，对不上 |
| ③ 配 ingress | 这隧道是仪表板管理的（`config_src: cloudflare`）→ **改本地 config.yml 完全没用** |
| ④ 配 DNS | CNAME 必须指向 `<隧道UUID>.cfargotunnel.com`；指错了现象是 **530**，看不出原因 |

现在合成一次调用，而且**先给预览再执行**。

#### 凭据从哪来

`~/.cloudflared/cert.pem` 这个文件**名字骗人** —— 它不是证书，
是一段 base64 的 JSON，解出来是：

```json
{ "zoneID": "…", "accountID": "…", "apiToken": "cfut_…" }
```

这是 **cloudflared 登录时留下的账号级凭据**。有它就能建隧道、改 DNS。
用户没跑过 `cloudflared tunnel login` 的话，也可以在设置里直接填 API 令牌。

#### 预览会算清楚什么

调 `preview()` 只读，**什么都不改**，返回：

- 域名属于哪个 zone（用**最长匹配**：`a.b.example.com` 匹配 `example.com`；
  而 `example.com.evil.com` **不能**被骗着匹配到 `example.com`）
- 同名隧道已存在 → 判定「复用」，不存在 → 判定「新建」
- 该域名已有 DNS 记录 → 判定「改」，并给出**警告**：
  「这条记录现在指向另一条隧道，改掉它会影响正在用那条隧道的服务」

有警告时预览框会变成黄色，确认框里也会重复一遍。

#### 执行顺序有讲究

**先建隧道 → 再配 ingress → 最后改 DNS。**

DNS 放最后是因为：DNS 先指过去但隧道还没配好 → 出现 **530**（用户看到的是「打不开」）；
反过来则是「隧道配好了但没人访问」→ 无害。

#### 安全约定

- 令牌只在请求头里用，**任何日志、错误信息、返回值都不带令牌**
  （`redact()` 会把 `cfut_*` / `cf_*` 抹成 `cfut_<已隐藏>`）
- `provision()` **必须显式传 `confirm: true`**，界面还会再弹一次系统确认框
- 界面上的「确认创建」按钮**在检查之前是禁用的** —— 防止跳过预览直接建

#### 测试到什么程度

| 层 | 怎么测的 |
|---|---|
| API 客户端 | 29/29 —— 凭据发现、令牌有效、只读接口、zone 最长匹配、预览逻辑、令牌不泄漏。**全程只读** |
| 界面流程 | 16/16 —— 凭据状态、预览列步骤、覆盖警告、按钮禁用、确认框内容、**取消后什么都不做** |
| 真实写入 | **没测** —— 会在真实 Cloudflare 账号里建隧道改 DNS，需要人确认 |

---

## 四、踩过的坑（都写在代码注释里了）

1. **tsserver 不用 `Content-Length` 帧**。按 LSP 格式发，它会回
   `Unexpected token 'C', "Content-Length: 81" is not valid JSON` —— 它认的是**换行分隔的裸 JSON**。
2. **tsserver 的严重度是字符串**（`"error"`），不是数字枚举。按数字映射会全显示成「未知」。
3. **navtree 的行号在 `spans[0].start`**，不在 `start`。直接读 `node.start` 拿到的是 null。
4. **Canvas 补丁要打在 `HTMLCanvasElement.prototype` 上**，不是 context 上。
   打错对象的结果是：两个窗口的 Canvas 哈希一模一样，等于没伪装。
5. **`webContents.capturePage()` 被遮挡时会一直挂着不返回**（不是报错）。必须套超时 + 三级退让。
6. **`ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node**，根本不进 GUI 模式。
   这个环境变量在某些工具链里会被自动设上。
7. **CDP 的 `Page.captureScreenshot` 与外部 `--remote-debugging-port` 会打架**。
   开着 DevTools 时内部 attach 会失败，所以要留「提到前台再抓」那条兜底路。
8. **类型检查的沙箱目录会被 tsserver 占住句柄**，删除要容错（`maxRetries`）。

---

## 五、已知缺口

1. **外部 MCP 转发只做了骨架**：`adoptExternalTools` 会把外部工具挂进注册表，但真正连外部服务器的客户端还没实现。
2. **支付是骨架**：套餐、下单、轮询逻辑齐了，但没有真实支付网关。
3. **许可服务器需要自建**：本仓库只有客户端校验和签发函数，服务端（Cloudflare Worker）要自己写。
4. **指纹是常用项打散，不是内核级伪装**：字体列表、TLS 指纹（JA3/JA4）、TCP 指纹这些更深的东西没做。
   专业指纹浏览器（比特、AdsPower 那类）在这些点上更彻底。
5. **`browser_eval` 默认关闭**：它等于把页面控制权完全交出去。要用得在启动时加 `--allow-eval`。


