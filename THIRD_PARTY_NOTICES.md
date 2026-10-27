# 第三方组件与许可证

Windrise Bridge 本身按 **GNU Affero General Public License v3.0 or later**（AGPL-3.0-or-later）发布，全文见仓库根目录 `LICENSE`。

下面列出随软件分发或运行时下载的第三方组件。它们的许可证都与 AGPL-3.0 兼容，各自的版权声明和许可证原文保留在对应目录里。

| 组件 | 用途 | 许可证 | 原文位置 |
|---|---|---|---|
| Electron | 桌面外壳 | MIT | 安装目录 `LICENSE` |
| Chromium（随 Electron） | 浏览器内核 | BSD-3-Clause 及其附带的多种许可证 | 安装目录 `LICENSES.chromium.html` |
| Node.js（随 Electron） | 运行时 | MIT 等 | 随 Electron 分发 |
| @modelcontextprotocol/sdk | MCP 协议 | MIT | `node_modules/@modelcontextprotocol/sdk/LICENSE` |
| zod | 参数校验 | MIT | `node_modules/zod/LICENSE` |
| TypeScript | 语言服务（lsp、诊断） | Apache-2.0 | `node_modules/typescript/LICENSE.txt` |
| MCP SDK 的间接依赖 | — | MIT / ISC / BSD-2-Clause / BSD-3-Clause | 各自 `node_modules/<包>/LICENSE` |
| cloudflared | 隧道（运行时下载或随包附带） | Apache-2.0 | https://github.com/cloudflare/cloudflared/blob/master/LICENSE |
| ngrok（可选，用户自行安装） | 隧道 | 专有，用户自行同意其条款 | https://ngrok.com/tos |
| Windows-MCP（可选外部 MCP） | 桌面控制 | MIT | https://github.com/CursorTouch/Windows-MCP/blob/main/LICENSE |
| Windrise 浏览器（BrowserOS 分支） | 账号窗口的浏览器内核，随 NSIS 安装包安装 | AGPL-3.0 | 由浏览器安装器装到 `%LOCALAPPDATA%\Windrise`（老版本装过的机器上还是 `%LOCALAPPDATA%\BrowserOS`，程序两个位置都认），许可证和 Chromium 声明随浏览器安装 |

NSIS 安装包会把浏览器安装器临时解到 `$PLUGINSDIR` 并静默安装，装完删除；已经装过浏览器的机器跳过（`%LOCALAPPDATA%\Windrise` 优先，其次 `%LOCALAPPDATA%\BrowserOS`）。浏览器本体的许可证、Chromium 的 BSD-3-Clause 声明和第三方组件清单随浏览器一起安装，不在 Windrise Bridge 的安装目录里。

依赖许可证可以用下面的命令重新统计：

```bash
node -e "const fs=require('fs');for(const d of fs.readdirSync('node_modules')){const ns=d.startsWith('@')?fs.readdirSync('node_modules/'+d).map(x=>d+'/'+x):[d];for(const n of ns){try{const j=require('./node_modules/'+n+'/package.json');console.log(j.license,n)}catch{}}}"
```

## 直接复用的源码

### BrowserOS（AGPL-3.0）

- 上游：https://github.com/browseros-ai/BrowserOS ，提交 `512f9cc15962b00b65b2cb35c429ed3134764f84`
- 许可证：GNU Affero General Public License v3.0（上游 README 写 AGPL-3.0、package.json 写 or-later，这里按 AGPL-3.0 标注；与本项目的 AGPL-3.0-or-later 兼容）。全文与本仓库 `LICENSE` 相同。
- 版权：归 BrowserOS 的作者和贡献者所有（上游仓库未写明版权人）。
- 复用了什么：语义快照核心（`browser-core/src/core/snapshot/*`、`core/observer/*`）、页面转 markdown（`browser-core/src/content-markdown.ts`）、`browser-mcp` 的 token 估算和不可信内容包裹，以及对应的上游测试。
- 放在哪：`src/vendor/browseros/`，清单见其中的 `SOURCE.json`；每个文件头写明来源路径和提交号。
- 改动：由 `tools/vendor-browseros.mjs` 从 TypeScript 机械转成 JavaScript（去掉类型、补全导入后缀），逻辑未改。测试里的 `bun:test` 换成本仓库的 `src/vendor/bun-test-shim.js`。

### Ego Lite（MIT）

- 上游：https://github.com/citrolabs/ego-lite ，提交 `d392204d1ea1a8027a591ab2b0129c2e11d85f26`。只取 GitHub 上公开的 MIT 部分，不碰安装包和浏览器本体。
- 许可证：MIT，Copyright (c) 2026 CitroLabs。原文随代码放在 `src/vendor/ego-lite/LICENSE`。
- 复用了什么：按编号动作的输入层（`package/ego-browser/src/driver/page-actions.ts`、`action-target.ts`、`scroll-motion.ts`、`keyboard.ts`、`ref-map.ts`），以及对应的上游测试。
- 放在哪：`src/vendor/ego-lite/`，清单见其中的 `SOURCE.json`；每个文件头写明来源路径、提交号和 MIT 声明。
- 改动：由 `tools/vendor-ego.mjs` 从 TypeScript 机械转成 JavaScript，逻辑未改；它原本依赖的 Ego 浏览器运行时、全局状态和元素解析器没有搬，导入改指向我们手写的 `src/vendor/ego-lite/ego-shims.js`，编号改由我们的语义快照提供（`src/core/surface-act.js`）。没有搬切前台（`Target.activateTarget`）的代码。

## 参照过但没有拷代码的项目

- **Ego Lite 的其余部分**：skill / learnings 只研究思路；浏览器本体是专有软件，不碰（见 `docs/windrise-next-plan.md` 第 3.3.2 节）。
- **老师提供的“学习软件”**：闭源商业软件，没有开源授权，不复用其任何代码。审计记录见 `docs/source-audit.md`。
