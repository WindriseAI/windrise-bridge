/**
 * preload —— 渲染进程与主进程之间唯一的窄通道。
 * 只暴露明确列出的方法，渲染层拿不到 Node 能力。
 */
const { contextBridge, ipcRenderer } = require("electron");

// 告诉样式表当前系统（macOS 要给左上角红绿灯按钮留位置）
window.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.platform = process.platform; });

contextBridge.exposeInMainWorld("bridge", {
  // 状态
  snapshot: () => ipcRenderer.invoke("bridge:snapshot"),

  // Bridge
  start: () => ipcRenderer.invoke("bridge:start"),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  listTools: () => ipcRenderer.invoke("bridge:list-tools"),
  setRoots: (roots) => ipcRenderer.invoke("bridge:set-roots", roots),
  setOptions: (options) => ipcRenderer.invoke("bridge:set-options", options),

  // 隧道
  tunnelStart: (provider) => ipcRenderer.invoke("tunnel:start", provider),
  tunnelStop: () => ipcRenderer.invoke("tunnel:stop"),
  tunnelProbe: (provider) => ipcRenderer.invoke("tunnel:probe", provider),
  connect: (provider) => ipcRenderer.invoke("bridge:connect", provider),
  disconnect: () => ipcRenderer.invoke("bridge:disconnect"),
  // 让其他 AI 操作本软件：命令行 + 一键写入 AI 客户端配置
  aiClientsStatus: () => ipcRenderer.invoke("aiclients:status"),
  aiClientsInstallCli: () => ipcRenderer.invoke("aiclients:install-cli"),
  aiClientsInstall: (key) => ipcRenderer.invoke("aiclients:install", key),
  // 按客户端复制远程 MCP 配置（生成逻辑在主进程，渲染层只拿结果）
  clientConfigGroups: () => ipcRenderer.invoke("client-configs:groups"),
  onStatus: (handler) => {
    const listener = (_event, snap) => handler(snap);
    ipcRenderer.on("bridge:status", listener);
    return () => ipcRenderer.removeListener("bridge:status", listener);
  },
  onGoto: (handler) => {
    const listener = (_event, tab) => handler(tab);
    ipcRenderer.on("panel:goto", listener);
    return () => ipcRenderer.removeListener("panel:goto", listener);
  },
  onConnected: (handler) => {
    const listener = (_event, info) => handler(info);
    ipcRenderer.on("tunnel:connected", listener);
    return () => ipcRenderer.removeListener("tunnel:connected", listener);
  },

  net: { diagnose: (opts) => ipcRenderer.invoke("net:diagnose", opts) },
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    skip: () => ipcRenderer.invoke("update:skip"),
    onState: (handler) => {
      const listener = (_event, st) => handler(st);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },

  customTools: {
    list: () => ipcRenderer.invoke("tools:custom-list"),
    save: (spec, original) => ipcRenderer.invoke("tools:custom-save", { spec, original }),
    remove: (name) => ipcRenderer.invoke("tools:custom-remove", name),
    toggle: (name, enabled) => ipcRenderer.invoke("tools:custom-toggle", { name, enabled }),
    test: (spec, args) => ipcRenderer.invoke("tools:custom-test", { spec, args }),
  },

  // 连接器：每个 AI 一把钥匙，只能操作分给它的窗口
  connectors: {
    list: () => ipcRenderer.invoke("connectors:list"),
    create: (name) => ipcRenderer.invoke("connectors:create", { name }),
    remove: (id) => ipcRenderer.invoke("connectors:remove", { id }),
    rename: (id, name) => ipcRenderer.invoke("connectors:rename", { id, name }),
    grant: (connectorId, profileId) => ipcRenderer.invoke("connectors:grant", { connectorId, profileId }),
    revoke: (connectorId, profileId) => ipcRenderer.invoke("connectors:revoke", { connectorId, profileId }),
    approve: (requestId) => ipcRenderer.invoke("connectors:approve", { requestId }),
    deny: (requestId) => ipcRenderer.invoke("connectors:deny", { requestId }),
    setBearer: (id) => ipcRenderer.invoke("connectors:set-bearer", { id }),
    setPathMode: (id) => ipcRenderer.invoke("connectors:set-path-mode", { id }),
    onChanged: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("connectors:changed", listener);
      return () => ipcRenderer.removeListener("connectors:changed", listener);
    },
  },

  // 主身份口令：/mcp 入口改用 Authorization: Bearer
  ownerAuth: {
    status: () => ipcRenderer.invoke("owner-auth:status"),
    generate: () => ipcRenderer.invoke("owner-auth:generate"),
    revoke: () => ipcRenderer.invoke("owner-auth:revoke"),
    addKey: (label) => ipcRenderer.invoke("owner-auth:add-key", { label }),
    rotateKey: (id) => ipcRenderer.invoke("owner-auth:rotate-key", { id }),
    revokeKey: (id) => ipcRenderer.invoke("owner-auth:revoke-key", { id }),
    setPath: (enabled) => ipcRenderer.invoke("owner-auth:set-path", { enabled }),
    rotatePath: () => ipcRenderer.invoke("owner-auth:rotate-path"),
  },

  // 设置（端口、开机自启、命名隧道参数）
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (patch) => ipcRenderer.invoke("settings:set", patch),
  // MemOS：Key 只发给主进程写外部 MCP 配置，界面只拿 configured / 连接状态
  memos: {
    status: () => ipcRenderer.invoke("memos:status"),
    save: (payload) => ipcRenderer.invoke("memos:save", payload),
    disconnect: () => ipcRenderer.invoke("memos:disconnect"),
  },
  autostartGet: () => ipcRenderer.invoke("autostart:get"),
  autostartSet: (enabled) => ipcRenderer.invoke("autostart:set", enabled),

  // 一键开通固定公网地址（Cloudflare）
  cloudflare: {
    status: () => ipcRenderer.invoke("cf:status"),
    preview: (input) => ipcRenderer.invoke("cf:preview", input),
    provision: (input) => ipcRenderer.invoke("cf:provision", input),
  },

  // 隧道客户端（cloudflared / ngrok）的检测与安装
  clients: {
    status: () => ipcRenderer.invoke("clients:status"),
    install: (name) => ipcRenderer.invoke("clients:install", name),
    onProgress: (handler) => {
      const listener = (_event, progress) => handler(progress);
      ipcRenderer.on("clients:progress", listener);
      return () => ipcRenderer.removeListener("clients:progress", listener);
    },
  },

  // 多开浏览器
  profilesList: () => ipcRenderer.invoke("browser:list"),
  profileCreate: (input) => ipcRenderer.invoke("browser:create", input),
  profileOpen: (id, url) => ipcRenderer.invoke("browser:open", { id, url }),
  profileQuickOpen: (site) => ipcRenderer.invoke("browser:quick-open", { key: site }),
  sitesList: () => ipcRenderer.invoke("browser:sites"),
  siteAdd: (input) => ipcRenderer.invoke("browser:site-add", input),
  siteRemove: (key) => ipcRenderer.invoke("browser:site-remove", key),
  profileClose: (id) => ipcRenderer.invoke("browser:close", id),
  profileUpdate: (id, patch) => ipcRenderer.invoke("browser:update", { id, patch }),
  profileRemove: (id, purge) => ipcRenderer.invoke("browser:remove", { id, purge }),
  profileCookies: (id) => ipcRenderer.invoke("browser:cookies", id),
  profileNavigate: (id, url) => ipcRenderer.invoke("browser:navigate", { id, url }),

  // 系统
  openPath: (target) => ipcRenderer.invoke("sys:open-path", target),
  pickFolder: (opts) => ipcRenderer.invoke("sys:pick-folder", opts),
  copy: (text) => ipcRenderer.invoke("sys:clipboard", text),

  // 共享上下文总线
  context: {
    snapshot: () => ipcRenderer.invoke("context:snapshot"),
    createGroup: (payload) => ipcRenderer.invoke("context:group-create", payload),
    updateGroup: (id, patch) => ipcRenderer.invoke("context:group-update", { id, patch }),
    deleteGroup: (id) => ipcRenderer.invoke("context:group-delete", { id }),
    link: (groupId, profileIds) => ipcRenderer.invoke("context:link", { groupId, profileIds }),
    unlink: (groupId, profileIds) => ipcRenderer.invoke("context:unlink", { groupId, profileIds }),
    share: (payload) => ipcRenderer.invoke("context:share", payload),
    recall: (payload) => ipcRenderer.invoke("context:recall", payload),
    forget: (payload) => ipcRenderer.invoke("context:forget", payload),
    send: (payload) => ipcRenderer.invoke("context:send", payload),
    inbox: (payload) => ipcRenderer.invoke("context:inbox", payload),
    markRead: (payload) => ipcRenderer.invoke("context:mark-read", payload),
    stats: () => ipcRenderer.invoke("context:stats"),
    prune: () => ipcRenderer.invoke("context:prune"),
    groupsFor: (profileId) => ipcRenderer.invoke("context:groups-for", { profileId }),
    setActive: (profileId) => ipcRenderer.invoke("context:set-active", { profileId }),
  },

  // 界面主题
  setTheme: (mode) => ipcRenderer.invoke("ui:set-theme", mode),

  // 命令审批（危险命令需要人工确认）
  approvals: {
    list: () => ipcRenderer.invoke("approvals:list"),
    approve: (id) => ipcRenderer.invoke("approvals:approve", id),
    reject: (id) => ipcRenderer.invoke("approvals:reject", id),
    onRequest: (handler) => {
      const listener = (_event, entry) => handler(entry);
      ipcRenderer.on("bridge:approval", listener);
      return () => ipcRenderer.removeListener("bridge:approval", listener);
    },
  },

  // 激活（激活码）：隧道是付费功能，打通隧道前要激活；浏览器和本机 MCP 不受影响
  license: {
    status: () => ipcRenderer.invoke("license:status"),
    activate: (code) => ipcRenderer.invoke("license:activate", code),
    refresh: () => ipcRenderer.invoke("license:refresh"),
    plans: () => ipcRenderer.invoke("license:plans"),
    createOrder: (kind) => ipcRenderer.invoke("license:create-order", kind),
    pollOrder: (orderId) => ipcRenderer.invoke("license:poll-order", orderId),
    onChanged: (handler) => {
      const listener = (_event, e) => handler(e);
      ipcRenderer.on("license:changed", listener);
      return () => ipcRenderer.removeListener("license:changed", listener);
    },
    onStatus: (handler) => {
      const listener = (_event, st) => handler(st);
      ipcRenderer.on("license:status", listener);
      return () => ipcRenderer.removeListener("license:status", listener);
    },
  },

  // 外部网页（只允许白名单网站，见 main.cjs）
  account: {
    openExternal: (url) => ipcRenderer.invoke("account:open-external", url),
  },

  // 日志推送
  onLog: (handler) => {
    const listener = (_event, record) => handler(record);
    ipcRenderer.on("bridge:log", listener);
    return () => ipcRenderer.removeListener("bridge:log", listener);
  },
});
