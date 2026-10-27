# Windrise 自带插件（BrowserOS / Chromium MV3）

一句话：Windrise 打开账号窗口时，用 `--load-extension=<这个目录>` 把它挂到 BrowserOS 上；挂上之后它做这些事——
设 WebRTC 策略、读回代理设置、把两页并排、在页面左下角放一个格子按钮（布局 / 收起 / 打开侧边栏），
提供侧边栏面板和新标签页仪表盘（格子、连接、最近操作、推荐位）。
**不开端口、不用 native messaging、不设 externally_connectable、不联网、不上报、不读页面内容。**
content script 只往页面里放自己的按钮，不读页面 DOM；chrome://、PDF 这类注入不了按钮的页面用侧边栏（工具栏图标）。

## 怎么装

启动 BrowserOS 时加一个参数就行（和 `electron/browseros-engine.cjs` 的启动参数一致）：

```
chrome.exe --user-data-dir=<账号自己的资料目录> --load-extension=<...>\electron\browseros-extension ...
```

- 本机实测（BrowserOS 155.0.8309.26，2026-10-24）：`--load-extension` 有效，插件能起来，扩展 id 由**目录的绝对路径**算出来——
  同一台机器、同一路径永远是同一个 id（本机是 `nfdbgpcmhfpeieafmfijjfnfajnlboek`），换路径 id 就变。
  所以控制端别把 id 写死，要按 `chrome-extension://<id>/sw.js` 这个 URL 去找、再用 `ping()` 核对。
- 正规 Google Chrome 从 137 起品牌版开始忽略 `--load-extension`；BrowserOS 还认。要换 Chrome 内核时这里得另想办法。
- 装了不用重启浏览器：插件是启动参数带上去的，进程起来就有。

## 为什么不开端口、不用 native messaging

控制端（`electron/browseros-engine.cjs`、`browseros-profiles.cjs`）本来就是用 `--remote-debugging-pipe`
和浏览器连着的一条 CDP 管道（见 `electron/cdp-connection.cjs`）。插件要能被控制，最省事、也最不容易被外面够到的办法是：

1. 控制端 `Target.setDiscoverTargets({discover:true})`，在 `Target.getTargets` 里找 `type === "service_worker"`
   且 url 是 `chrome-extension://<id>/sw.js` 的那个目标；
2. `Target.attachToTarget({targetId, flatten:true})`，`Runtime.enable`；
3. `Runtime.evaluate({expression:"__windrise.ping()", awaitPromise:true, returnByValue:true})`。

于是：

- 不用监听端口 → 这台机器上任何进程都扫不到一个「插件端口」；
- 不用 `externally_connectable` → 网页脚本（包括被 AI 带着跑的页面）根本连不上这个扩展；
- 不用 native messaging → 不落地本机消息宿主程序，不读 stdin 的 4 字节长度头那一套；
- content script 只在页面左下角放自己的按钮（closed Shadow DOM），按钮里的编号和账号名来自 `chrome.storage.session`，
  不读页面文字、不读页面元素；
- 格子动作从按钮 / 侧边栏 / 新标签页 → `chrome.runtime.sendMessage` → 本 worker → 主程序经 CDP 在这个 worker 会话上
  `Runtime.addBinding({name:"windriseGridAction"})` 加的全局函数。页面世界没有这个 binding，
  主程序还会再按白名单校验一次。白名单：`layout:1x1` / `layout:1x2` / `layout:2x2` / `layout:3x3` /
  `hide-self` / `show-settings`（可带 tab：settings / account / bridge / context / choose-connection）/
  `grid-open:<1~9999>` / `space-focus:<空间id>` / 插件动作 ext-*，以及初次设置引导页的
  `tunnel-connect` / `owner-key-new` / `pay-order:D|M|Y` / `tool-tier:basic` / `tool-tier:full` / `onboarding-done` / `onboarding-open`。

**注意**：BrowserOS 自己预装了扩展（worker 是 `chrome-extension://<别的 id>/background.js`），它们也在目标列表里。
找的时候不能「看到第一个 `chrome-extension://` 就算」，要逐个 attach 看 `typeof globalThis.__windrise === "object"`
（`_probe/browseros-extension-check.mjs` 就是这么做的，本机每次能试到 2~3 个别人的 worker）。

## 权限

```json
"permissions": ["privacy", "proxy", "tabs", "storage", "sidePanel", "tabGroups", "management", "cookies"],
"host_permissions": ["<all_urls>"],
"action": { "default_title": "Windrise 侧边栏" },
"side_panel": { "default_path": "panel.html" },
"chrome_url_overrides": { "newtab": "newtab.html" },
"content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle", "all_frames": false }]
```

`privacy` 用来设 WebRTC 策略，`proxy` 用来读代理设置，`tabs` 用来建/查标签页（自带分屏也在 `chrome.tabs` 里）。
`storage` 用来在 `chrome.storage.session` 里存「格子 N · 账号名」和侧边栏的只读状态。
`sidePanel` 让工具栏图标直接打开 `panel.html`，新标签页被 `newtab.html` 接管。
`tabGroups` 用来建空间（标签组）和把空间里新开的标签页并入组。
`management` 用来列本格子从商店装的插件，以及「装到所有格子 / 从所有格子移除」。
`cookies` 只给侧边栏的「导入 Cookie」用：人确认后把用户自己导出的 Cookie 逐条写进当前格子。
`host_permissions: ["<all_urls>"]` 只为让 content script 能注入那个左下角按钮；不读页面内容。
`all_frames: false` 表示只注入顶层页面，iframe 里不重复放按钮。

## `globalThis.__windrise` 接口

### `ping()`

```js
{ version: "1", id, manifestName, manifestVersion, permissions, hostPermissions, hasCreateSplit, hasUnsplit }
```

`id` 就是扩展 id；`permissions` / `hostPermissions` 是**运行时真正生效的**那份清单，不是读文件猜的。

### `setGridInfo({ slot, name })`

主程序经 CDP 在 worker 会话上调用，把「格子 N · 账号名」写进 `chrome.storage.session`。
content script 和侧边栏读这一项并监听变化；`slot` 必须是正整数，`name` 会截到 120 字。
页面世界拿不到这个调用，也拿不到 worker 上的 `windriseGridAction` binding。

### `setPanelState(state)` / `getPanelState()`

主程序每 5 秒（以及开窗 / 换布局 / 收起 / 摆回后）经 CDP 在 worker 会话上调用 `setPanelState`，
把侧边栏和新标签页要的只读状态写进 `chrome.storage.session` 的 `panelState`：

```js
{
  version, updatedAt,
  self:  { slot, name, hidden },                       // 这一格
  grids: [{ slot, name, hidden }],                     // 所有打开的格子
  spaces: [{ id, name, owner: "human"|"ai", tabCount }], // 这一格的空间（我的 + AI 的）
  connection: { connected, level, label, publicUrl, tokenCount, pathEnabled, provider },
  tunnel: { provider },
  toolTier: "basic" | "full",
  adminBroker: { running },
  sharedContext: { enabled, dir },                     // dir = 本地共享文件夹路径
  memos: { configured, status },                       // 只有配没配和连接状态，API Key 不出主进程
  recentActions: [{ tool, at, ok }],                   // 最近 10 条，不含参数
  recommendation: { title, description, url },
  tools: [{ name, title, description, capability, source }], // 工具注册表现取，引导页第 4 步用
  aiClients: [{ id, name, kind: "remote"|"local", hint }]     // ai-clients.cjs 现取，引导页第 3 步用
}
```

`publicUrl` 永远是不带令牌的 `/mcp` 形式；`tokenCount` 只给数量，不给口令本身。
`panel.html` / `newtab.html` 读这个键并监听 `chrome.storage.onChanged`。
`getPanelState()` 是给插件页面兜底读同一项的。

### 初次设置引导页（`onboarding.html` / `domain-guide.html`）

引导页是插件页面：`chrome-extension://<id>/onboarding.html`（第一次启动时主程序在格子 1 里开这个标签页，
侧边栏底部「重新打开初次设置」也能再开）。`domain-guide.html` 是自有域名教程页，静态内容 + 一段复制给 AI 的提示词；
教程里的「打开 Windrise 设置」按钮走 `show-settings`（tab = settings）打开主程序设置窗口，不直接改设置。

- 引导页读同一份 `panelState`（license / payPlans / connection / toolTier / adminBroker / sharedContext / memos / tools / aiClients）；
- 它的按钮走上面那张白名单（`tunnel-connect` 等），`show-settings` 带 tab 跳到设置窗口对应页；
- **`owner-key-new` 只有引导页能发**：worker 检查 `sender.url === chrome-extension://<id>/onboarding.html`，
  别的插件页面和网页一律拒。主程序生成口令后经 `__windrise.deliverOwnerKey({requestId, key})` 把明文
  **只送回这一次**（`sendResponse`），不进 `chrome.storage`、不进 `panelState`、不进定时推送；
  频率限制一分钟一次（主程序侧）。
- **`pay-order:D|M|Y` 也只许引导页发**：引导页用 `chrome.runtime.connect({name:"pay-order"})` 建一条
  只属于这一单的长连接（requestId 随机生成）。worker 校验来源后转发给主程序；主程序下单、轮询，
  二维码和支付状态经 `__windrise.deliverPayOrder({requestId, ...})` 只推回这条连接，
  不进 `chrome.storage`、不进 `panelState`、不广播给侧边栏 / 新标签页。

### `deliverOwnerKey({ requestId, key? , error? })`

主程序经 CDP 在 worker 会话上调用，把口令生成结果送回给发起 `owner-key-new` 的引导页（按 requestId 找应答）。
返回 `{ ok, delivered }`；requestId 不在（超时 / 不是这个页面发起）时 `delivered: false`。
`ownerKeySenderAllowed(url, ownId)` 是来源判断的纯函数，主程序自测直接调它核对。

### `deliverPayOrder({ requestId, orderId?, qrCode?, status?, amount?, expiresAt?, addedDays?, error? })`

主程序经 CDP 在 worker 会话上调用，把下单 / 支付结果推回发起 `pay-order` 的引导页。
二维码是 `data:image/png;base64,...`；`paid` / `expired` / `failed` 后清掉请求，重复推送返回 `delivered: false`。

### Cookie 导入（侧边栏，不走主程序）

`panel.html` 的「导入 Cookie」直接读用户选中的本地文件，解析和写入都在 `cookie-import.js`：

- 只支持用户自己用原浏览器 Cookie 导出插件导出的 Netscape `cookies.txt` 或 Cookie-Editor / EditThisCookie 的 JSON 数组；
- 选文件 → 预览（条数 + 前 20 个域名 + 跳过计数）→ 人点「确认导入」后才逐条 `chrome.cookies.set` 到当前格子；
- 单文件 5 MB、最多 5000 条；过期跳过，坏行计数；session cookie 不带 `expirationDate`；
- cookie 值不写日志、不进 `chrome.storage`、不显示在界面（只显示条数和域名）；不联网、不上传。

### `applyPolicy({ webRtcPolicy, expectProxy })`

```js
{
  webRtc: { value, levelOfControl },   // 真实值
  proxy:  { mode, levelOfControl, value, note },  // 读不到就是 null
  errors: [],                          // 设不上、读不回来都写这儿
  proxyMatchesExpectation, proxyNote,  // expectProxy 给了才有内容
}
```

顺序是死的：先 `chrome.privacy.network.webRTCIPHandlingPolicy.set({value, scope:"regular"})`，
**然后一定再 `.get({})` 读一次**，把浏览器真正认的 `value` 和 `levelOfControl` 带回去。
设不上就写进 `errors`，不会假装成功；写进去的和读回来的不一致也会写进去。

`levelOfControl` 怎么读：

| 值 | 意思 |
|---|---|
| `controlled_by_this_extension` | 就是我们在管，可以开窗口 |
| `controllable_by_this_extension` | 现在没人占（一般意味着我们没设上） |
| `controlled_by_other_extensions` / `not_controllable` | 被别的插件或企业策略接管了，我们说了不算 |

本机实测：`disable_non_proxied_udp` → `controlled_by_this_extension`。

### `getState()`

```js
{ webRtc: { value, levelOfControl }, proxy: { mode, levelOfControl, value, note }, tabs: 数字, errors: [] }
```

`tabs` 是 `chrome.tabs.query({})` 的条数。用 `--no-startup-window` 启动、还没建窗口的时候读到 `0` 是正常的。

### `openSplit({ url, withUrl })`

```js
{ windowId, tabIds: [甲, 乙], split: "chrome.tabs.create(splitWithTabId)" | "fallback" | "unsupported",
  splitViewIds: [甲, 乙], sameWindow, errors }
```

1. 先建 `withUrl` 那一页当锚（不给就 `about:blank`），再 `chrome.tabs.create({url, splitWithTabId: 锚.id})`；
2. 调不通就退回「同一窗口里相邻两个普通标签页」，`split` 标 `fallback`；
3. 连标签页都建不出来才标 `unsupported`。

**接口没报错不等于真并排了**：建完会 `chrome.tabs.get` 回读两个标签页的 `splitViewId`，对不上就如实降级成 `fallback`，
不拿「没报错」当成功。全程 `active:false`，不抢前台、不弹任何界面（没有新窗口、没有对话框）。
本机实测：`splitWithTabId` 有效，两个标签页 `splitViewId` 相同、`windowId` 相同（另有 CDP 独立核对，见探针）。

### 空间（标签组）这一组

空间 = 同一个账号里的任务工作区，用浏览器标签组实现；主程序（browseros-profiles.cjs）开空间、
page_* 带 space 参数路由到空间的主标签页，这里只提供「分组 / 关组 / 切前台 / 新标签页归组」四件事。

#### `groupTabs({ tabIds?, marker?, title, color, collapsed })`

```js
{ tabId, groupId, title, color, collapsed }
```

1. 有 `tabIds` 直接 `chrome.tabs.group({tabIds})`；
2. 没有就按 `marker` 找：主程序先把新标签页加载成 `about:blank#windrise-space-<空间id>`，
   这里 `chrome.tabs.query({})` 按这个网址找到 tab id —— **CDP 的 targetId 和 chrome tab id 对不上，
   只能靠这个标记网址对上**（空间 id 是短随机串，不会撞用户网址）；
3. `chrome.tabGroups.update(groupId, {title, color, collapsed})`，标题用「AI·名字」，默认折叠。

找到组 id 和 chrome tab id 一起还回去，主程序存起来，之后 `focusTab` / `closeGroupTabs` 都用 chrome tab id。

#### `closeGroupTabs({ groupId?, tabIds? })` → `{ removed, tabIds }`

按标签组找出现在属于这个组的全部标签页（外加显式给的 tabIds）一起 `chrome.tabs.remove`。
主程序存过的 chrome tab id 可能已经过期，所以以「现在查询到的」为准。

#### `focusTab({ tabId })` → `{ tabId, active }`

`chrome.tabs.update(tabId, {active:true})` 把标签页切到前台。**只给人在侧边栏点「切到空间」用**；
AI 的控制路径绝不许调它（AI 走 CDP，不碰 chrome.tabs.update）。

#### `groupToJoinForNewTab(tab, openerTab)`

新标签页该不该自动并入「打开它的那个标签页」所在的标签组（纯函数，主程序自测直接调它核对规则）。
有 `openerTabId`、且打开它的标签页真在某个标签组里（groupId >= 0，`TAB_GROUP_ID_NONE = -1` 不算）才给 groupId，
别的都返回 null。用户 Ctrl+T 开的新标签页没有 opener，不动。真正的分组动作挂在 `chrome.tabs.onCreated` 上。

## 代理这一块的实测结论（和原契约写的不一样，以实测为准）

引擎契约 §3 第 2 条原本写的是「命令行的 `--proxy-server` 不会出现在 `chrome.proxy.settings` 里，
所以 `getState().proxy.mode` 可能是 `system`」。**本机 BrowserOS 155.0.8309.26 实测是会出现的：**

| 启动方式 | `chrome.proxy.settings.get({incognito:false})` |
|---|---|
| `--proxy-server=http://127.0.0.1:14670` | `mode: "fixed_servers"`，`rules.singleProxy = {scheme:"http", host:"127.0.0.1", port:14670}`，`levelOfControl: "controllable_by_this_extension"` |
| 不带代理 | `mode: "system"`，`levelOfControl: "controllable_by_this_extension"` |

所以：

- 上层**不能**假设 `mode` 一定是 `system`；带命令行代理时它是 `fixed_servers`，而且 `singleProxy` 里的 host/port
  就是命令行给的那一个（可以直接拿来和启动参数对账，`applyPolicy({expectProxy})` 就是这么干的）；
- 反过来，读到 `mode: "system"` 也**不能**当成「代理没生效」——命令行代理是启动时定死的配置，
  不同版本展不展示不一定。判断权限归属看 `levelOfControl`；要证明流量真走了代理，得看控制端自己的证据
  （比如第一个请求的 `Network.responseReceived` 里的 `remoteIPAddress`）。

## worker 会被浏览器停掉，也能被叫醒（实测，控制端必须知道）

MV3 的 service worker 不是常驻进程，空转会被浏览器停掉。这件事直接影响控制端什么时候能调到插件，所以实测清楚了：

| 情况 | 实测结果 |
|---|---|
| 什么都没做（没 attach 过） | 浏览器启动后约 **18~35 秒**（不同次）worker 被停，`Target.getTargets` 里就没有 `…/sw.js` 这个目标了 |
| 拿睡前的旧 targetId 去 `Target.attachToTarget` | 被拒：`TARGET_CLOSED … No target with given id found` |
| **调试器会话挂着不放**（attach 后不 detach） | 40 秒一直在，没被停 —— 会话挂着时浏览器不杀它 |
| 摘掉会话之后 | 约 18 秒后又被停 |
| 被停之后 `ServiceWorker.enable` / `startWorker` | 这个构建里**没有**（`'ServiceWorker.enable' wasn't found`），CDP 叫不醒 |
| 被停之后建一个 `about:blank` 标签页 | **371~454ms 就回来了**，`ping()` 报的还是同一个 id，`applyPolicy` 照常能设上 |

所以控制端照这个来：

1. 连上浏览器就尽早 attach 并**保持会话**（`applyPolicy` 核对完也别急着 detach，除非确定后面不会再调）；
2. 真发现 `…/sw.js` 目标不在（进程跑了很久、或者上次会话被摘了），先
   `Target.createTarget({url:"about:blank", background:true})` 建个空标签页当叫醒信号，
   再去找目标、再调 —— 插件顶层注册了 `chrome.tabs.onCreated`，事件一发生浏览器就会把 worker 拉起来；
3. 别指望 `ServiceWorker` 那套 CDP 方法，这个构建里没有。

**没测到**：worker 睡过去之后，之前设好的 WebRTC 策略还生不生效（要测就得在它睡后开页面收 ICE 候选）。
策略本身是浏览器记在资料目录里的，理论上跟 worker 生死无关，但这条我没测，不当结论用。

## 它不做的事

- 不联网、不上报（整份 `sw.js` 和 content script 里没有 `fetch` / `XMLHttpRequest` / `WebSocket`，探针会扫一遍确认）；
- 不读页面内容：content script 只创建并操作自己的 host 节点（closed Shadow DOM），不查页面文字、不查页面元素；
- Cookie 导入只读用户自己用导出插件生成的文件，不解析浏览器加密的 Cookies 数据库，不联网、不上传；
- 不碰登录页——「AI 不许碰登录页」是控制端 `electron/ai-site-guard.cjs` 的事，插件不掺和；
- 不设代理（只读不写）：代理由启动参数定，插件改它反而会让「命令行代理」和「插件代理」打架。

## 真机怎么验

```bash
node --check electron/browseros-extension/sw.js
node _probe/browseros-panel-state-selftest.mjs       # 纯 Node：状态裁秘密、调用日志、管理员代理
node _probe/cookie-import-selftest.mjs               # 纯 Node：Cookie 两种格式解析、上限、写入计数
node _probe/browseros-extension-check.mjs            # 清单、权限、content script、ping、策略、代理、分屏、退出码
WITH_WAKE=1 node _probe/browseros-extension-check.mjs  # 再加 7 项：worker 睡眠与叫醒（多花约 2 分钟）
```

探针会自己起真 BrowserOS（默认两趟：一趟带 `--proxy-server`、一趟不带），临时资料目录落在
`<本地路径><pid>\`，窗口挪到屏幕外，
结束走 `Browser.close`，只按自己 spawn 出来的 pid 收尾。最后一行打印 `共 N 项，通过 N/N 项`。
`WITH_WAKE=1` 那一档会多起一个进程，专门等 worker 睡过去再把它叫醒，所以慢。
