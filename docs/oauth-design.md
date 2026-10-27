# 隧道 OAuth 设计（默认关闭）

> 状态：2026-10-27 第一版，默认关闭。代码在 `src/core/oauth.js`，网关接入在 `src/core/bridge.js`。
> 目标客户端：ChatGPT、Claude 这类「只能填网址、走 OAuth、不能加自定义请求头」的云端 MCP 客户端。
> 老入口（`/mcp/<路径令牌>` 和 `Authorization: Bearer wrb_...`）完全不动。

## 1. 目标与非目标

### 做

1. 让远程 MCP 客户端通过 **OAuth 2.1 授权码 + PKCE S256** 拿到短期 access token；
2. 用 **RFC 9728 PRM** 告诉客户端「这个 MCP 资源的授权服务器是谁」；
3. 用 **RFC 8414 AS metadata** 告诉客户端 authorize / token / register 端点；
4. 支持 **DCR（RFC 7591）**，并对注册做限速和数量上限；
5. access token **绑定 audience = 本 Bridge 的公网 MCP 地址**，隧道换域名后旧令牌自动失效；
6. 远程浏览器里**看不到口令**；同意动作只发生在**这台电脑上**；
7. 授权时选择工具分组，直接映射到现有 `src/core/tool-policy.js` 的作用域；
8. 令牌只存 SHA-256 哈希、可吊销；审计记录 `client_id` 和客户端名字；
9. 默认关闭，配置打开才挂端点；关闭时这些路径与不存在一样。

### 不做

- 不做用户体系 / OIDC 登录：这是单用户桌面应用，没有「登录哪个用户」的问题；
- 不做 CIMD（client_id 为 HTTPS URL 的元数据文档）：第一版走 DCR，metadata 里显式写 `client_id_metadata_document_supported: false`；
- 不做 implicit / password / client_credentials；
- 不做多资源、多租户、上游 OAuth 代理；
- 不做 token passthrough（不会把客户端令牌转给任何上游）；
- 不替代现有连接器 / 口令 / 路径令牌，也不改变它们的行为；
- 不做设置页 UI（本机确认先做内部函数 + 调试入口）；
- 不改 MCP 传输本身：Bridge 仍然走 2025-06-18 的 `initialize` + `Mcp-Session-Id`，不是 2026-07-28 的 stateless 协议。

## 2. 为什么内置一个极简 AS

调研报告（`_dispatch/refs/tunnel/report.md` 第 4.1 / 第 10 节）建议「先用现成的 AS：Keycloak、Auth0、Ory Hydra、Better Auth；不要自己写完整 OAuth AS，除非有安全经验」。评估后，这一版仍然内置一个**只服务本 Bridge 单资源**的极简 AS，理由：

1. **同意必须落在这台电脑上。** 外置 AS 的「登录 / 同意」在浏览器里完成，远程用户（或拿到链接的人）可以自己点同意；本机配对确认需要 AS 和桌面端共享一个待确认队列。外置 AS 要么做不到，要么得再写一套私有回调。
2. **没有第二个资源。** AS 只签发「访问本机 Bridge `/mcp`」的令牌，没有多租户、没有上游 IdP、没有用户目录。Keycloak/Hydra 的绝大部分能力在这里是负担。
3. **隧道地址会变。** 快速隧道每次重启换 `*.trycloudflare.com` 域名；内置 AS 的 issuer / audience 跟随当前公网地址，外置 AS 要为每个用户改 issuer / 回调配置。
4. **普通用户配不动。** 装 Java、建 realm、配 client、配 TLS、配回调，对桌面软件用户不是可接受的路径。
5. **离线可用。** 没有外网依赖，授权过程只经过用户自己的隧道。

代价与约束：

- 这是一个**安全敏感的自研 AS**，不是通用 OAuth 服务器；
- 只实现 MCP 客户端实际需要的最小集合，任何新 grant / 新端点都要先过威胁建模；
- 只支持 public client（无 `client_secret`），靠 PKCE + 精确 redirect_uri + 本机确认；
- 出问题时的退路是「关掉 `oauthEnabled`」，老入口不受影响。

如果以后要做多资源、企业 SSO、CIMD、审计合规，正确方向是换成成熟 AS（Hydra / Keycloak / Better Auth 等），Bridge 只保留 PRM + resource server 角色。

## 3. 端点

| 方法 | 路径 | 作用 | OAuth 关闭时 |
|---|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | PRM（RFC 9728），也支持 `/.well-known/oauth-protected-resource/mcp` | 404 |
| GET | `/.well-known/oauth-authorization-server` | AS metadata（RFC 8414），也支持 `/mcp` 后缀 | 404 |
| POST | `/register` | DCR（RFC 7591），只发 `client_id`，不发 secret | 404 |
| GET | `/authorize` | 授权页：只显示「请到电脑上的 Windrise Bridge 确认」+ 配对码 | 404 |
| POST | `/token` | `authorization_code` / `refresh_token` | 404 |
| POST | `/revoke` | RFC 7009，吊销 access / refresh token | 404 |
| GET | `/oauth/local/pending` | **仅本机**：待确认列表（调试入口） | 404 |
| POST | `/oauth/local/approve` | **仅本机**：批准并选择工具分组 | 404 |
| POST | `/oauth/local/deny` | **仅本机**：拒绝 | 404 |
| POST | `/oauth/local/revoke` | **仅本机**：按 client_id / token 吊销 | 404 |
| POST/GET/DELETE | `/mcp` | 受保护的 MCP 资源；未授权回 401 | 保持原样（无凭据 404） |

本机入口的额外限制：

- 带任何转发痕迹头（`cf-*` / `x-forwarded-*` / `forwarded`）或 Host 不是本机名 → 一律 404；
- `approve` / `deny` / `revoke` 只收 `application/json`，避免跨站简单表单；
- 有 `Origin` 时只接受本机来源。

## 4. 三种凭据怎么共存

| 入口 | 凭据 | 身份 | 权限 | 现状 |
|---|---|---|---|---|
| `/mcp/<32 位路径令牌>` | URL 里的主令牌 | 主人 | 全量（受全局工具档位限制） | 不变 |
| `/mcp` + `Authorization: Bearer wrb_...` | 主口令 / 连接器口令 | 某把主口令或某个连接器 | 老口令无 scope = 老行为；带 scope 按分组 / 格子 / 域名 | 不变 |
| `/mcp` + `Authorization: Bearer wro_...` | OAuth access token | OAuth 客户端 | 只有授权时选的分组，**没有**连接器的窗口归属 | 新增 |

OAuth 客户端不是连接器：

- 它没有「分给它的浏览器窗口」这一层；有 `read` / `navigate` 分组就能操作所有窗口（这是当前最小实现的已知风险，见第 10 节）；
- 它不写 `connectors.json`，只写 `oauth.json`；
- 审计里 `client.tokenKind = "oauth"`，并额外带 `oauthClientId` / `oauthClientName`。

## 5. 完整流程

```
ChatGPT / Claude
   │ 1. POST https://<隧道域名>/mcp           （无凭据）
   ▼
Bridge ── 401 + WWW-Authenticate: Bearer resource_metadata="https://<域名>/.well-known/oauth-protected-resource"
   │
   │ 2. GET PRM       → resource / authorization_servers / scopes_supported
   │ 3. GET AS metadata → authorize / token / register / S256 / none
   │ 4. POST /register  → DCR 拿到 client_id（public client）
   │ 5. GET /authorize?response_type=code&client_id=...&redirect_uri=...&code_challenge=...&resource=https://<域名>/mcp
   ▼
远程浏览器：只显示「请到电脑上的 Windrise Bridge 确认」+ 配对码（每 2 秒刷新）
   │
   │ 6. 本机：GET /oauth/local/pending → 看到配对码 / 客户端名 / 请求分组
   │         POST /oauth/local/approve {requestId, groups:["read","navigate"]}
   ▼
远程浏览器刷新 → 302 回 redirect_uri?code=...&state=...&iss=https://<域名>
   │
   │ 7. POST /token  grant_type=authorization_code + code_verifier
   ▼
Bridge 发 access_token（15 分钟）+ refresh_token（30 天，轮换）
   │
   │ 8. POST /mcp + Bearer wro_...
   ▼
校验哈希 / 过期 / 吊销 / audience → 按 scope 过滤 tools/list 和 tools/call
```

关键点：

- **401 只在 `/mcp` 无凭据或 OAuth 令牌无效时出现**；错的 `wrb_` 口令仍然 404（不暴露服务存在）。
- `WWW-Authenticate` 的 `resource_metadata` 永远指向当前公网地址的 PRM。
- `/authorize` 的第一跳只创建待确认请求；**没有本机 approve 绝不发码**。
- 授权码有效期 5 分钟、单次使用；错 verifier 不会立即销毁授权码，但累计 5 次失败会作废。
- 授权响应带 `iss`（RFC 9207）；token 响应带 `scope`。
- access token 默认 15 分钟，refresh token 默认 30 天；每次刷新都轮换 refresh token，旧的立刻作废。

## 6. audience 与地址变化

- PRM 的 `resource` 是 `<公网 base>/mcp`；
- authorize 的 `resource`（如果客户端带）必须等于这个值，否则 `invalid_target`；
- token 请求里的 `resource` 也必须等于授权时记录的值；
- access token 记录 `audience`，每次 `/mcp` 请求都拿「当前公网 base + `/mcp`」对比；
- 公网 base 的来源：
  1. 显式配置 `publicBaseUrl`（桌面端用当前隧道的 origin；命令行用 `WINDRISE_OAUTH_PUBLIC_URL`）；
  2. 没配置时按请求的 `x-forwarded-host` / `Host` + `x-forwarded-proto` 推。
- **隧道换域名 = 旧令牌全部失效**，客户端重新走一次 OAuth。这是有意的：令牌不能跟着域名漂移。

## 7. 作用域 → tool-policy

OAuth 的 scope 直接使用 `tool-policy.js` 的分组名，不另起一套：

| scope | tool-policy 分组 | 典型工具 | 默认给 |
|---|---|---|---|
| `read` | `read` | `page_snapshot`、`page_read`、`browser_profiles`、`read_result` | 是 |
| `navigate` | `navigate` | `browser_navigate`、`browser_open`、`space_open` | 是 |
| `write` | `write` | `page_act`、`browser_click`、`browser_type`、`apply_patch` | 否 |
| `admin` | `admin` | `run_command`、`admin_run`、`admin_confirm`、`configure_mcp` | 否 |

- 授权页请求的分组由客户端 `scope` 参数决定；客户端不写 scope 时，本机默认批准 `read+navigate`。
- 本机 approve 只能**缩小**客户端请求的范围：客户端只要 `write`，默认的 `read+navigate` 交集为空，会返回 `invalid_scope`，必须明确选 `write`。
- 显式传 `groups: []` 可以给一个「什么都不能调」的令牌（用于先注册、后授权）。
- 映射结果就是 `normalizeScope({ groups })`；`profiles` / `domains` 为 `null`，表示不额外限制。
- 全局工具档位（basic / full）仍然先生效；OAuth scope 只能再缩小。

## 8. 本机确认（第一版没有 UI）

信任锚点是「这台电脑上的人点了同意」，不是远程页面上的任何东西。

内部接口（`OAuthStore`）：

- `beginAuthorization(params, { base })`：校验并生成待确认请求；
- `pendingList()`：待确认列表；
- `approve(requestId | 配对码, { groups })`：批准，生成授权码哈希；
- `deny(...)`；
- `pendingState(id)` / `takeCode(id)`：授权页状态与一次性发码。

本机调试入口：

```bash
node tools/oauth-debug.mjs list --port 48272
node tools/oauth-debug.mjs approve <requestId|配对码> --groups read,navigate
node tools/oauth-debug.mjs deny <requestId|配对码>
node tools/oauth-debug.mjs revoke --client <client_id>
```

- 默认连 `127.0.0.1:48272`；
- 端口退回随机端口时用 `--port` 指定实际端口；
- 这些端点只接受本机直连，经隧道访问一律 404。

以后做设置页 UI 时，只需要把 `pendingList` / `approve` 接到界面上，协议层不用改。

配对码是 8 位（去掉易混淆字符，`XXXX-XXXX`），只在内存里，不落盘。它不是授权凭据：远程页面能看到它，但没有本机 approve 就不会发码。

## 9. 存储、生命周期、吊销

`<数据目录>/oauth.json`（`0600`，临时文件 + rename）：

```json
{
  "version": 1,
  "clients": [{ "clientId": "wrc_...", "clientName": "ChatGPT", "redirectUris": ["https://..."], "createdAt": 0 }],
  "accessTokens": [{ "id": "at-...", "hash": "<sha256>", "clientId": "wrc_...", "clientName": "ChatGPT", "groups": ["read", "navigate"], "audience": "https://.../mcp", "expiresAt": 0 }],
  "refreshTokens": [{ "id": "rt-...", "hash": "<sha256>", "clientId": "wrc_...", "groups": ["read"], "audience": "https://.../mcp", "expiresAt": 0 }],
  "revoked": [{ "hash": "<sha256>", "kind": "access", "revokedAt": 0 }]
}
```

- **只存哈希**：access / refresh token 的明文只在发放响应里出现一次；`oauth.json` 里没有明文。
- 授权码只存在内存里（哈希 + 明文都不落盘）；配对码只存在内存里；Bridge 重启后未完成的授权全部作废。
- 客户端数量上限默认 50；DCR 每个 IP 每小时默认 10 次；待确认请求默认最多 16 条。
- 文件读坏了另存为 `.broken-<时间>`，按空表运行；读不了时这次运行不写，避免盖掉原文件。
- 吊销：
  - `POST /revoke`（RFC 7009）按令牌吊销；
  - `POST /oauth/local/revoke {clientId}` 吊销一个客户端的全部令牌并断开它的 OAuth 会话；
  - 下一次 `/mcp` 请求就会重新校验并返回 401，不需要等会话空闲回收。

## 10. 安全边界与已知风险

### 已经做到的

- PKCE S256 强制；`plain` 直接拒绝；授权码单次使用、5 分钟过期、错 5 次作废；
- redirect_uri 精确匹配；只接受 HTTPS 或本机回环 HTTP；
- public client，无 client_secret，无 implicit / password；
- access token 短期、refresh 轮换；令牌只存哈希；
- audience 绑定公网 MCP 地址；`resource` 在 authorize / token 两处都校验；
- DCR 按 IP 限速 + 全局客户端上限；
- 401 带 `WWW-Authenticate: Bearer resource_metadata=...`；
- 本机确认入口禁止经隧道访问，POST 只收 JSON；
- 审计记录 `client_id` / 客户端名字 / 分组 / 放行结论 / 原因，且不写令牌明文；
- OAuth 关闭时端点完全不存在。

### 还没做到 / 风险

1. **自研 AS 的长期风险**：没有经过外部安全审计；任何协议扩展都要谨慎。
2. **没有 CIMD**：ChatGPT 首选 CIMD，DCR 仍支持；如果某个版本只认 CIMD，会连不上。
3. **没有用户登录**：本机确认是唯一信任锚点；本机上的恶意进程可以调用 `/oauth/local/approve`。这是「本机已可信」的假设。
4. **没有设置页 UI**：第一版只能编辑 `settings.json` / 用调试 CLI；普通用户还不能自助完成。
5. **OAuth 客户端没有窗口归属**：只能按分组限权，不能像连接器那样只给某几个格子。后续应把 `scope.profiles` 接到授权 UI。
6. **没有 DPoP / mTLS / IP 绑定**：令牌泄露后直到过期或吊销前都可用；靠短 TTL + 轮换 + 吊销降低窗口。
7. **DCR 对公网开放**：限速是内存计数，重启会清零；客户端上限是全局的。后续可加注册开关 / IP allowlist / 管理端预注册。
8. **公网地址变化**：快速隧道换域名会让全部令牌失效，用户需要重新授权。命名隧道 / 固定域名体验更好。
9. **传输层信任**：TLS 在 Cloudflare / ngrok 边缘终止，Bridge 只看到转发头；本机监听仍然是 `127.0.0.1`。
10. **没有 token introspection / 管理 API**：排查只能看 `oauth.json`（哈希）和审计日志。

## 11. 配置与启用

默认关闭。桌面端：

```json
// <数据目录>/settings.json
{
  "oauthEnabled": true
}
```

保存后重启 Bridge（或「断开 → 一键连接」）生效。当前没有设置页开关，这是第一版的已知缺口。

命令行 / 调试：

```powershell
$env:WINDRISE_OAUTH = "1"
$env:WINDRISE_OAUTH_PUBLIC_URL = "https://your-tunnel.example"   # 可选；不填按请求 Host 推
npm start
```

`boot({ oauth })` 还接受这些可选项（测试和以后设置页用）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `accessTokenTtlSeconds` | 900 | access token 有效期 |
| `refreshTokenTtlSeconds` | 2592000 | refresh token 有效期 |
| `codeTtlSeconds` | 300 | 授权码有效期 |
| `pendingTtlSeconds` | 300 | 待确认请求有效期 |
| `maxClients` | 50 | DCR 客户端总数上限 |
| `registrationLimit` | 10 | 每个 IP 每个窗口的注册次数 |
| `registrationWindowSeconds` | 3600 | 注册限速窗口 |
| `maxPending` | 16 | 同时待确认的授权请求上限 |
| `defaultGroups` | `["read","navigate"]` | 本机不选分组时的默认批准范围 |
| `publicBaseUrl` | 无 | 固定公网 base；不填按请求推 |

## 12. 与 MCP 2026-07-28 的差距

调研报告第 2.2 / 4.1 节列出的完整清单里，这一版做了：

- OAuth 2.1 resource server + AS；
- PRM（RFC 9728）与 401 `WWW-Authenticate`；
- AS metadata（RFC 8414）；
- DCR（RFC 7591）fallback；
- PKCE S256；
- RFC 8707 `resource` + audience 校验；
- RFC 9207 `iss`（授权响应里带）；
- scope challenge 的基础版（按分组过滤 `tools/list` / `tools/call`）。

还没做：

- **CIMD**（2026-07-28 首选；DCR 已 deprecated）；
- **stateless 协议**（2026-07-28 移除了 `initialize` / `Mcp-Session-Id` / GET stream / Last-Event-ID）；
- **双时代**：Bridge 仍然是 2025-06-18 的 `initialize` 路径，2026 客户端需要 `mcp-remote --protocol auto` 之类的桥；
- 完整的 scope step-up（当前是授权时一次选定，不做过期后的增量提权）；
- token introspection / 标准管理端点。

结论：这一版是**能连 2025 版客户端的最小 OAuth**，不是 2026-07-28 的完整实现。DCR 还能用，但已经不是规范首选。

## 13. 接 ChatGPT 实测还缺什么

1. **本机确认 UI**：没有 UI，普通用户看到配对码也无法在 Windrise Bridge 里点同意；实测只能用 `tools/oauth-debug.mjs`。
2. **设置页开关 + 客户端管理**：现在要手改 `settings.json`；还需要看到已授权客户端、最后使用时间、一键吊销。
3. **固定公网地址**：Cloudflare Quick Tunnel 每次换域名，而且不支持 SSE；实测应使用命名隧道或 ngrok。域名变化会让令牌失效。
4. **CIMD**：ChatGPT 文档首选 CIMD；我们显式 `client_id_metadata_document_supported: false`，只能走 DCR fallback，需要实测它是否接受。
5. **DCR 细节实测**：ChatGPT 实际提交的 `redirect_uris`、`grant_types`、`token_endpoint_auth_method`、`scope` 需要抓一次真实请求，确认校验没有过严。
6. **MCP 协议版本**：2026-07-28 客户端走 stateless / `server/discover`，当前 Bridge 不认；需要双时代或 `mcp-remote` 桥。
7. **授权页体验**：配对码需要和本机 UI 上的码一致；没有 UI 时只能靠调试 CLI 列表。授权页每 2 秒刷新，Cloudflare/代理的超时行为要实测。
8. **refresh / 重新授权**：长时间会话里 access token 15 分钟过期后，ChatGPT 是否能正确用 refresh token 或重新走 OAuth，需要实测。
9. **DCR 暴露面**：公网任何人都能注册客户端（有限速和上限）。实测前建议临时加 IP allowlist，或只在本机测试。
10. **OAuth 客户端的窗口边界**：现在 `read+navigate` 能操作所有浏览器窗口；如果实测要限制到某个格子，需要把 `scope.profiles` 接到授权 UI。

## 14. 测试覆盖

`src/core/oauth.test.js`（`node --test src/core/oauth.test.js`，也接进了 `tools/run-clickable-tests.mjs`）：

- PKCE：错 verifier 拒绝、plain 拒绝、正确 verifier 发令牌；
- audience：authorize / token 的 `resource` 不符拒绝；公网 base 变化后旧令牌 401；
- 过期：access token 过期 401；refresh 换新可用；旧 refresh 轮换后失效；refresh 过期拒绝；
- 吊销：`/revoke` 后立即 401；本机按 `client_id` 吊销后立即 401；
- DCR：按 IP 限速、客户端总数上限、redirect_uri / auth method / grant type 校验；
- 401：`WWW-Authenticate` 格式、PRM、AS metadata、路径后缀变体；
- 关闭时所有 OAuth 端点 404，老路径令牌照常；
- 打开时老路径令牌、主口令、连接器令牌照常；
- 作用域映射：默认 `read+navigate`，`tools/list` 过滤、越权 `NOT_ALLOWED`、审计有 `client_id` / 名字；
- 令牌只存哈希：`oauth.json` 里没有 access / refresh 明文。
