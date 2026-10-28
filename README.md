# Bridge Replica

把**这台 Windows 机器**上的能力，通过 MCP 协议开放给任意 MCP 客户端（ChatGPT / Claude / Arena / Cursor / Cline …），
外加一个「多开浏览器」面板（每个窗口一套独立登录态 + 一套稳定指纹）。

一句话：**本机 MCP 桥 + 多开浏览器 + 指纹伪装 + 语言服务。**

---

## 能干什么

| 能力 | 说明 |
| --- | --- |
| 本地 MCP 桥 | 在 `127.0.0.1` 上起一个 MCP 服务（Streamable HTTP，协议 2025-06-18），把内置工具暴露给外部客户端。地址里带随机令牌，猜不到就进不来。 |
| 文件 / 命令工具 | 读文件、找文件、按内容搜索、`apply_patch` 改代码、跑命令并轮询输出，作用范围限制在你设置的「工作区根目录」里。 |
| 多开浏览器 | 每个窗口一个独立 `persist:` 分区 → 同一台机器上同时登 N 个账号，登录态各自落盘，重启还在。 |
| 指纹伪装 | 每个窗口由 id 派生一套**稳定**的设备参数（UA、屏幕、时区、WebGL 等），窗口之间互不串味。 |
| 语言服务 | 基于 TypeScript 官方 `tsserver` 做真实的类型/语法诊断、跳定义、找引用、看类型、补全。 |
| 隧道 | 一条命令把本机地址映射成公网 HTTPS，给只认公网地址的客户端（比如 ChatGPT 连接器）用。 |
| 工作区共享 | 跑起来的 Bridge 会把工作区状态发布到 `~/.bridge-replica-shared/workspace-hub`，方便别的进程/工具看到。 |

---

## 环境要求

- Windows 10/11 x64
- Node.js ≥ 20（开发用；打包产物自带 Electron 运行时，装好即用）
- 想用隧道：`cloudflared`（或 `ngrok`）在 PATH 里，见「常见问题」

## 装依赖 / 开发运行

```powershell
npm install
npm run ui          # 开界面（Electron，等价于 electron .）
npm run ui:eval     # 同上，但额外开启浏览器工具的 eval 能力（把页面完全交出去，慎用）
```

不带界面、只跑协议层（调工具、看工具清单）：

```powershell
npm start           # 起 Bridge 常驻
npm run tools       # 只打印工具清单
npm run selftest    # 启动 → 握手 → tools/list → 真调一次 → 退出
npm run tunnel      # 起 Bridge + 拉一条 Cloudflare 临时隧道
```

---

## 打包（Windows 安装包）

配置全部在 **`electron-builder.yml`**（刻意不放进 `package.json` 的 `build` 字段）。
打包命令：

```powershell
# 第一次打包：把浏览器安装包放进 build/browser/（NSIS 安装包会顺带装它）
node scripts/prepare-browser-installer.mjs "C:\path\to\Windrise浏览器测试版-安装.exe"

node scripts/build.mjs                    # 推荐：先生成图标，再打包 nsis + portable
node scripts/build.mjs --dir              # 只出 dist/win-unpacked（最快，调界面用）
node scripts/build.mjs --icon-only        # 只重新生成 build/icon.ico
npx electron-builder --config electron-builder.yml --publish never   # 直接调，等价
```

产物（`dist/` 下）：

| 文件 | 说明 |
| --- | --- |
| `windrise-bridge-<版本>-setup.exe` | NSIS 安装包：可选安装目录、建桌面/开始菜单快捷方式、带卸载器，并静默安装浏览器内核 |
| `windrise-bridge-<版本>-portable.exe` | 免安装单文件：双击就跑，解压到临时目录（不带浏览器内核） |
| `win-unpacked/` | 解包后的应用目录，安装包就是拿它压的；也能直接双击里面的 exe |

浏览器安装包只进 NSIS：安装时临时解到 `$PLUGINSDIR`，用安装器自己的 `--silent` 静默安装（不弹界面、装完不自动开浏览器），装完删除；已经装过浏览器的机器会跳过，不覆盖现有版本：先看 `%LOCALAPPDATA%\Windrise`（新版本装的位置），老用户机器上再回退 `%LOCALAPPDATA%\BrowserOS`。浏览器安装包本身约 160 MB，`build/browser/` 已加进 `.gitignore`，不随仓库分发。
`--dir`、`--icon-only` 和只打 `--win portable` 时不会编译 NSIS，也就不需要浏览器安装包。

图标：`build/icon.ico`（多尺寸 16→256，脚本生成，不依赖任何素材）。

辅助脚本：

- `scripts/render-icon.ps1` + `scripts/make-icon.mjs` —— 画图标、拼 `.ico`
- `scripts/prepare-browser-installer.mjs` —— 把浏览器安装包放到 `build/browser/windrise-browser-setup.exe`（`--force` 可强制重抄）
- `scripts/build.mjs` —— 图标 + 附带文件 + 打包 + 打印产物清单
- `scripts/inspect-asar.mjs` —— 检查打进包里的文件对不对（关键文件在不在、测试脚本有没有漏进去）
- `scripts/verify-packaged.ps1` + `scripts/smoke-packaged.mjs` —— 打包产物端到端验证（见文末）

> 打包注意：**没有用 asar**（`asar: false`）。原因见「常见问题 / 为什么没开 asar」。

---

## 装好之后怎么用

### 1. 开界面

装完双击桌面快捷方式（或 `portable.exe`），会看到一个浅色窗口，左边一列图标：**Bridge / 多开浏览器 / 工具 / 设置**。

> 双击没反应、任务管理器里也找不到窗口？看「常见问题 / ELECTRON_RUN_AS_NODE」。

### 2. 启动 Bridge

右上角点 **「启动 Bridge」**。几秒后：

- 状态变成 **运行中**
- **MCP 地址**框里出现 `http://127.0.0.1:<随机端口>/mcp/<令牌>`
- 下面还会给一条**健康检查**地址（`/healthz/<令牌>`，浏览器直接打开能看到 `{"ok":true,...}`）

点「复制」把 MCP 地址拿走。**注意：Bridge 每次重启端口都会变**（故意用随机端口，避免撞车），
客户端里的地址要重新粘一次；令牌是固定的，存在 `%USERPROFILE%\.bridge-replica\route-token.json`。

### 3. 把地址填进客户端

- **本机客户端**（Claude Desktop / Cursor / Cline / 各类 MCP 插件）：直接填 `http://127.0.0.1:<端口>/mcp/<令牌>`。
- **只支持「命令 + 参数」的 stdio 客户端**（老版 Claude Desktop 的 `claude_desktop_config.json` 等）：
  用社区常用的 stdio↔HTTP 桥转一层，例如：

  ```json
  {
    "mcpServers": {
      "bridge-replica": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "http://127.0.0.1:6266/mcp/<把令牌粘这里>"]
      }
    }
  }
  ```

- **只认公网 HTTPS 地址的客户端**（ChatGPT 连接器 / Claude 自定义连接器 / Arena 等网页侧）：
  `127.0.0.1` 填不进去，先按下面「隧道」那节开一条公网地址，再填 `https://xxxx/mcp/<令牌>`。

- 界面里的 **「复制提示词」** 会把一段给模型看的系统提示词复制到剪贴板（告诉它优先用 `apply_patch` 改代码、
  长命令用 `run_command` + `get_command_output` 轮询、多步任务用 `set_todos`）。连上客户端后粘进对话第一句，效果更稳。

### 4. 多开浏览器

进 **「多开浏览器」** 页：

1. 填 **窗口名称**（比如「店铺A」「小号1」）、**启动网址**，需要的话填 **代理**（`http://user:pass@host:port` 或 `socks5://host:port`）和 **User-Agent**。
2. 点 **「新建窗口」**（或「批量建 5 个」）。
3. 在下面「窗口列表」里点 **「打开」** → 弹出独立窗口，正常登录。
4. 每个窗口的登录态存在自己的分区里（`persist:profile-<id>`），**关掉再开、重启程序都还在**。
   同一个网站可以在这个窗口登 A 号、在那个窗口登 B 号，互不影响。
5. 列表里还有：**Cookie**（看这个窗口有多少条 cookie）、**改名**（顺带改启动网址/代理）、**移除**。
   「移除」默认**只从列表拿掉，磁盘数据保留**；要连登录数据一起清，才会让你再确认一次。

每个窗口的指纹由它的 id 派生，稳定不变；想换一套指纹就新建一个窗口。

### 5. 开隧道（让外部客户端连上）

本机地址外面连不上，需要一条公网入口。Bridge 页下半部分选模式，点「启动隧道」：

| 模式 | 需要什么 | 地址 | 适合 |
| --- | --- | --- | --- |
| **Cloudflare 快速隧道**（默认） | 什么都不用，装 `cloudflared` 就行 | 每次启动随机 `https://xxx.trycloudflare.com` | 临时试一下 |
| **Cloudflare 命名隧道** | 自己的域名 + Cloudflare 账号；要设环境变量（见下） | 固定域名 | 长期挂在一个客户端里 |
| **ngrok** | ngrok 账号；可选设固定域名 | 固定域名 | 已经在用 ngrok 的人 |

命名隧道 / ngrok 的凭据走环境变量（在启动程序前设好，或者写进系统环境变量）：

```powershell
# Cloudflare 命名隧道
$env:BRIDGE_NAMED_TUNNEL_TOKEN = "<Cloudflare Zero Trust 控制台里复制的隧道令牌>"
$env:BRIDGE_NAMED_HOSTNAME     = "bridge.example.com"

# ngrok
$env:BRIDGE_NGROK_DOMAIN       = "your-name.ngrok-free.app"   # 可留空，留空就用 ngrok 给的随机域名
```

隧道起来后，**公网地址**框里会出现 `https://xxx/mcp/<令牌>`，点「检测客户端」可以看 `cloudflared`/`ngrok` 装没装。

---

## 安全提醒（重要）

- **MCP 地址里的令牌 = 本机文件读写 + 执行命令的权限。** 拿到这条地址的人，等于拿到了这台机器上的
  文件读写和一个终端（危险命令默认要人工确认，但那只是最后一道闸）。
- **不要**把地址贴到群里、issue 里、截图里，也不要用快速隧道长期挂着。
- 快速隧道是**公网可达**的：地址一旦泄露，任何人都能连。不用了就点「停止隧道」。
- 工作区根目录决定了文件工具能碰哪些目录（设置页可改）。别把 `C:\` 整个加进去。
- `npm run ui:eval`（或启动参数 `--allow-eval`）会把浏览器工具的「在页面里执行任意 JS」打开，
  这是「把页面完全交出去」的操作，只在需要时开。

---

## 常见问题

### 双击没反应 / 任务管理器里有进程但没有窗口 —— `ELECTRON_RUN_AS_NODE`

如果环境变量 `ELECTRON_RUN_AS_NODE=1` 被设上了（某些工具链、IDE 终端、脚本会全局设它），
Electron 会退化成**纯 Node**：主进程代码根本不会跑，窗口自然也不会出现，看起来就是「闪一下没了」。

实测症状（打包产物上复现过）：**进程起来几秒内自己退出、退出码 9，任务管理器里没有窗口，
`--remote-debugging-port` 指定的调试端口也连不上**。而只要把这个变量清掉，同一个 exe 立刻正常开窗。

处理办法（任选一个）：

1. **用安装目录里的 `launch-bridge-replica.cmd` 启动**（安装包会把它放在 exe 旁边），它会先清掉这个变量再拉起程序。
   实测：在 `ELECTRON_RUN_AS_NODE=1` 的终端里跑这个 `.cmd`，窗口照常出现、CDP 也能连上。
2. 命令行里清掉再启动：

   ```powershell
   cmd /c "set ELECTRON_RUN_AS_NODE= && "C:\Users\<你>\AppData\Local\Programs\bridge-replica\Bridge Replica.exe""
   ```

3. 找到是谁设的，从系统环境变量里删掉（删完要重开资源管理器/重新登录才生效）。

顺带一句：**这个变量对开发也有影响** —— `npm run ui` 起不来窗口时，先看它。

### 客户端里地址失效了 / 连不上

- Bridge **重启后端口会变**，重新复制一次地址即可。
- 先确认 Bridge 是「运行中」，再用浏览器打开那条 `/healthz/<令牌>` 地址：能看到 `{"ok":true,...}` 说明服务是活的。
- 隧道模式下，客户端要填**公网地址**（`https://.../mcp/<令牌>`），不是 `127.0.0.1`。

### 「端口被占」

Bridge 和浏览器控制服务都用**随机端口**（`127.0.0.1:0`），正常不会撞端口。会撞的只有这几种：

- 你自己给程序加了固定调试端口（比如 `--remote-debugging-port=9223`），而这个端口被别的进程占了 → 窗口照开，但 DevTools 连不上；换个端口即可。
- 开了两条隧道指向同一个客户端，客户端连的还是旧端口 → 停掉隧道重开。
- 想看谁占了端口：`Get-NetTCPConnection -LocalPort <端口> -State Listen | Select-Object OwningProcess`。

### 隧道起不来 / 「检测客户端」说没装

隧道是**直接调用系统里的 `cloudflared`（或 `ngrok`）**，程序里没有自带：

```powershell
winget install --id Cloudflare.cloudflared     # cloudflared
winget install --id ngrok.ngrok                # ngrok
```

或者手动把 `cloudflared.exe` / `ngrok.exe` 丢进 PATH 里的目录。装完**重启程序**（PATH 是启动时读的）。
另外 ngrok 免费版不走 HTTP 代理，程序已经自动把代理变量摘掉了，不用手动设。

### 语言服务 / 诊断说「找不到 tsserver」

`get_diagnostics` 和 `lsp` 用的是 TypeScript 官方引擎 `tsserver`，它得在**目标项目**里能找到：

```powershell
npm i -D typescript      # 在你要诊断的那个项目里装
```

查找顺序是：目标项目的 `node_modules/typescript` → 从项目解析 → 程序自己所在目录的 `node_modules/typescript`。
找不到时不会报死，会自动降级成「文件级静态体检」，并在结果里说明降级原因。

> 已知问题（**打包版实测复现**）：`src/core/lsp.js` 起 tsserver 用的是 `process.execPath`（打包后就是本程序的 exe），
> 而且没给它带 `ELECTRON_RUN_AS_NODE=1`。结果这个子进程被当成「又一个 Electron 应用」拉起来了
> （进程命令行里能看到 `...\typescript\lib\tsserver.js --disableAutomaticTypingAcquisition`，还自带一套 gpu/renderer 子进程），
> 它根本不会说 tsserver 协议，于是 `configure` 超时：
> `lsp {operation:"status"}` 返回 `{"available": false, "reason": "configure 超时"}`，界面上也会白留一个隐藏的第二实例。
> 修复点就在 `src/core/lsp.js` 的 `spawn(...)`：补 `env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }`，
> 或者改成用系统里的 `node` 跑 tsserver。

### 为什么没开 asar？

`src/` 是 ESM，主进程用动态 `import()` 加载它。Node 的 ESM loader 读不到 asar 归档里的内容
（读到空内容 → 抛 `Unexpected end of input`），实测 **asar:true 时点「启动 Bridge」必然失败**。
所以 `electron-builder.yml` 里写的是 `asar: false`：文件直接铺在 `resources/app/` 下，ESM 加载和开发模式一致。
代价是安装目录文件数变多（约 2500 个）、安装稍慢。electron-builder 会提示「asar usage is disabled」——**这是预期内的**。

---

## 数据放在哪

| 位置 | 内容 |
| --- | --- |
| `%USERPROFILE%\.bridge-replica\` | 路由令牌 `route-token.json`、浏览器控制服务信息 `browser-control.json`、外部 MCP 配置、skills |
| `%USERPROFILE%\.bridge-replica-shared\workspace-hub\` | 工作区共享状态 |
| `%APPDATA%\bridge-replica\Partitions\` | 多开浏览器的分区数据（**登录态就在这里**；删掉等于把账号登出） |
| 安装目录 | 程序本体；`launch-bridge-replica.cmd` 是清环境变量的启动器 |

设置页有「打开数据目录」按钮，直接跳过去。

> **第一次用记得改工作区**：文件工具的默认作用范围是「程序启动时的工作目录」——
> 免安装版解压到临时目录、安装版是安装目录，都不是你要操作的目录。
> 去「设置 → 工作区」把根目录改成真正要操作的路径，点「保存并重启 Bridge」。


---

## 给维护者：验证打包产物

```powershell
node scripts/build.mjs                                    # 打包
node scripts/inspect-asar.mjs                             # 检查包内文件（默认看 dist/win-unpacked/resources/app，也接受 app.asar 路径）
pwsh -NoProfile -File scripts/verify-packaged.ps1         # 启动 + 找窗口 + 截图 + 点「启动 Bridge」+ MCP 握手 + 收尾
pwsh -NoProfile -File scripts/verify-packaged.ps1 -Exe "dist\windrise-bridge-0.1.0-portable.exe"   # 同一个流程验证免安装版
```

`verify-packaged.ps1` 干的事：清掉 `ELECTRON_RUN_AS_NODE` 启动 exe → 用 `EnumWindows` 确认窗口真的出现（标题/尺寸/位置）
→ 截屏窗口 → CDP 连上去点「启动 Bridge」、读 `#mcp-url`、打 `/healthz` 和 `tools/list` → `taskkill` 收尾并确认无残留。

技术细节写在 `docs/how-it-works.md`（**这份文档不进安装包**，看的话在仓库里）。

## 许可证

Windrise Bridge 按 **AGPL-3.0-or-later** 开源，全文见 [`LICENSE`](LICENSE)。第三方组件的许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

简单说：可以自由使用、修改、再分发；如果把修改后的版本做成网络服务给别人用，需要向这些用户公开对应的源码。「Windrise」名称和图标不随许可证授权。
