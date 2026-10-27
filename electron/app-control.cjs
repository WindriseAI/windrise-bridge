/**
 * 软件控制 —— 让命令行（windrise）和其他 AI（MCP 工具 windrise_*）能操作本软件。
 *
 * 走的是浏览器控制服务那条本机通道：/control/<令牌>/app/<名字>。
 * 这里只做「把请求翻译成主进程里已有的操作」，不另起一套逻辑，
 * 所以界面上点按钮和这里调用，效果完全一样。
 *
 * 会造成影响的操作（断开隧道、删除账号）必须带 confirm: true；
 * 给 AI 增加可访问的文件夹，还要在本机弹窗让人点「允许」。
 */

const fs = require("node:fs");
const path = require("node:path");

const pad2 = (n) => String(n).padStart(2, "0");

/** 本地时间 HH:MM:SS（24 小时制，两位补零；不用 toLocaleTimeString，免得随系统设置变） */
function hhmmss(ms) {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 把公网实测快照排成一句中文，给 windrise_status / windrise status 用 */
function describePublicCheck(pc, { hasPublicUrl } = {}) {
  if (!hasPublicUrl) return "隧道没打通，不测";
  if (!pc || !pc.at) return "还没测";
  if (pc.ok === true) {
    return Number.isFinite(pc.latencyMs)
      ? `${hhmmss(pc.at)} 通过（延迟 ${pc.latencyMs} 毫秒）`
      : `${hhmmss(pc.at)} 通过`;
  }
  let text = `${hhmmss(pc.at)} 没通过，连续 ${pc.failures ?? 0} 次：${pc.lastError || "原因不明"}`;
  if (pc.lastOkAt) text += `；上次通过 ${hhmmss(pc.lastOkAt)}`;
  return text;
}

/** 把会话数和最后一次外部请求排成一句中文，给 windrise_status / windrise status 用 */
function describeActivity(summary, { now = Date.now() } = {}) {
  if (!summary) return "桥没在运行";
  const sessions = summary.sessions ?? 0;
  const head = `当前会话 ${sessions} 个；`;
  const at = Number(summary.lastTunnelRequestAt);
  if (!Number.isFinite(at) || at <= 0) return `${head}还没有经公网的请求`;
  const quietMs = Math.max(0, now - at);
  const ago = quietMs < 60_000
    ? "刚刚"
    : quietMs < 60 * 60_000
      ? `${Math.floor(quietMs / 60_000)} 分钟前`
      : `${Math.floor(quietMs / (60 * 60_000))} 小时前`;
  return `${head}最后一次经公网的请求 ${hhmmss(at)}（${ago}）`;
}

function createAppControl(d) {
  const { state } = d;

  const brief = (p) => ({
    id: p.id,
    name: p.name,
    site: p.site || null,
    running: Boolean(p.running),
    url: p.currentUrl || p.startUrl || null,
    lastOpenedAt: p.lastOpenedAt || null,
    slot: p.slot ?? null,
    hidden: Boolean(p.hidden),
  });

  /** 按 id 或名字找账号窗口（名字不区分大小写）；BrowserOS 下也认「格子 2」/「slot:2」/「2」 */
  async function resolveProfile(key) {
    const text = String(key ?? "").trim();
    if (!text) throw new Error("缺少账号：请给出账号的 id、名字或格子编号");
    const list = await state.profiles.list();
    const hit = list.find((p) => p.id === text)
      || list.find((p) => p.name === text)
      || list.find((p) => String(p.name).toLowerCase() === text.toLowerCase());
    if (hit) return hit;
    if (typeof state.profiles.resolveGridId === "function") {
      const bySlot = await state.profiles.resolveGridId(text);
      const slotHit = bySlot ? list.find((p) => p.id === bySlot) : null;
      if (slotHit) return slotHit;
    }
    const names = list.map((p) => `${p.name}（${p.id}）`).join("、") || "现在还没有账号";
    throw new Error(`找不到账号「${text}」。可用账号：${names}`);
  }

  function needConfirm(params, what) {
    if (params.confirm === true || params.confirm === "true" || params.yes === true) return;
    const error = new Error(`${what}需要确认：请带上 confirm: true（命令行加 --yes）再执行一次`);
    error.code = "NEED_CONFIRM";
    throw error;
  }

  async function status() {
    const conn = d.connectionStatus();
    const running = Boolean(state.app);
    const profiles = await state.profiles.list();
    const publicCheck = typeof d.publicCheckSnapshot === "function" ? d.publicCheckSnapshot() : null;
    // 授权：只给「是否激活 + 到期」摘要，激活码 / 设备密钥 / 许可证不出主进程
    const license = typeof d.licenseStatus === "function" ? await d.licenseStatus() : null;
    // 活动：会话数和最后一次经公网的 MCP 请求。healthSummary 是同步的，不会打外部探针。
    const health = running ? state.app.server.healthSummary() : null;
    const activity = health
      ? {
        sessions: health.sessions ?? null,
        lastRequestAt: health.lastRequestAt ?? null,
        lastTunnelRequestAt: health.lastTunnelRequestAt ?? null,
        summary: describeActivity(health),
      }
      : { summary: "桥没在运行" };
    // 隧道模块还在加 readyConnections；现在读不到就是 null，不要因此报错。
    const tunnelStatus = typeof state.tunnel?.status === "function" ? state.tunnel.status() : null;
    const edge = { readyConnections: tunnelStatus?.readyConnections ?? null };
    return {
      app: d.APP_NAME,
      version: d.app.getVersion(),
      pid: process.pid,
      bridge: { running, localMcpUrl: running ? state.app.server.localUrl : null },
      connection: { level: conn.level, label: conn.label, detail: conn.detail || null, error: conn.error || null, provider: conn.provider || null, publicMcpUrl: conn.publicMcpUrl || null },
      license,
      profiles: { total: profiles.length, open: state.profiles.openCount },
      folders: state.roots,
      dataHome: d.DATA_HOME,
      publicCheck: publicCheck
        ? { ...publicCheck, summary: describePublicCheck(publicCheck, { hasPublicUrl: Boolean(conn.publicMcpUrl) }) }
        : null,
      activity,
      edge,
    };
  }

  async function tunnel(params) {
    const op = String(params.op || "status");
    if (op === "status") return { connection: d.connectionStatus() };
    if (op === "start") {
      const result = await d.connectAll(params.provider || undefined);
      if (result && result.ok === false) throw new Error(result.error || "隧道没有打通");
      return { connection: d.connectionStatus() };
    }
    if (op === "stop" || op === "restart") {
      needConfirm(params, op === "stop" ? "断开隧道" : "重连隧道");
      /*
       * 先回话再动手：调用方很可能就是通过这条隧道连进来的，
       * 同步断开的话它永远收不到回复。
       */
      setTimeout(async () => {
        try {
          await d.stopTunnel();
          if (op === "restart") await d.connectAll(params.provider || undefined);
        } catch (error) { d.pushLog({ kind: "app-control", text: `隧道${op === "stop" ? "断开" : "重连"}失败：${error.message}`, level: "err" }); }
      }, 400);
      return { scheduled: true, message: op === "stop" ? "隧道将在 0.4 秒后断开（通过隧道连进来的 AI 会随之断开）" : "隧道正在重连，约 5–20 秒后恢复" };
    }
    throw new Error(`不认识的隧道操作：${op}（可用 status / start / restart / stop）`);
  }

  async function profiles(params) {
    const op = String(params.op || "list");
    const list = async () => (await state.profiles.list()).map(brief);
    if (op === "list") return { profiles: await list() };
    if (op === "create") {
      const name = String(params.name || "").trim();
      if (!name) throw new Error("新建账号需要名字");
      const input = { name };
      if (params.url) input.startUrl = String(params.url);
      if (params.site) input.site = String(params.site);
      const profile = await state.profiles.create(input);
      d.pushLog({ kind: "browser", text: `新建窗口「${profile.name}」（来自命令行 / AI）`, level: "ok" });
      return { profile: brief(profile), profiles: await list() };
    }
    if (op === "layout") {
      const layout = String(params.layout || "").trim();
      if (!layout) throw new Error("换布局要给 layout：1x1 / 1x2 / 2x2 / 3x3");
      // 不给 id 时用当前 slot 1（backend 自己找）；给了就用那个格子当基准（被点的格子变 slot 1）
      const baseId = params.id === undefined || params.id === null || String(params.id).trim() === ""
        ? null
        : (await resolveProfile(params.id)).id;
      const result = await state.profiles.applyLayout(baseId, layout);
      d.pushLog({ kind: "browser", text: `账号格子切到 ${result.layout}：${result.assigned?.length ?? 0} 个已开格子就位，新建 ${result.created?.length ?? 0} 个，收起 ${result.hide?.length ?? 0} 个（来自界面 / AI）`, level: "ok" });
      return {
        layout: result.layout,
        workArea: result.workArea,
        assigned: result.assigned,
        created: result.created,
        hidden: result.hide,
      };
    }
    const target = await resolveProfile(params.id ?? params.name);
    if (op === "show") {
      const result = await state.profiles.show(target.id);
      return { shown: { id: target.id, name: target.name, slot: result?.slot ?? null } };
    }
    if (op === "hide") {
      const result = await state.profiles.hide(target.id);
      return { hidden: { id: target.id, name: target.name, slot: result?.slot ?? null } };
    }
    if (op === "rename") {
      const name = String(params.newName ?? params.to ?? "").trim();
      if (!name) throw new Error("请给出新名字");
      await state.profiles.update(target.id, { name });
      return { renamed: { id: target.id, from: target.name, to: name } };
    }
    if (op === "delete") {
      needConfirm(params, `删除账号「${target.name}」`);
      const purge = params.purge === true || params.purge === "true";
      const result = await state.profiles.remove(target.id, { purge });
      d.pushLog({ kind: "browser", text: `移除窗口「${target.name}」${result.purged ? "（已清空该账号数据）" : "（磁盘数据保留）"}（来自命令行 / AI）`, level: "warn" });
      return { deleted: { id: target.id, name: target.name, purged: Boolean(result.purged) } };
    }
    if (op === "open") {
      const url = params.url ? String(params.url) : undefined;
      const result = await state.profiles.openWindow(target.id, { url });
      await d.contextBus().then((bus) => bus.setActiveProfile(target.id)).catch(() => {});
      return { opened: { id: target.id, name: target.name, mode: "window", reused: Boolean(result?.reused) } };
    }
    if (op === "close") {
      state.profiles.closeWindow(target.id);
      return { closed: { id: target.id, name: target.name } };
    }
    throw new Error(`不认识的账号操作：${op}（可用 list / create / rename / delete / open / close / layout / show / hide）`);
  }

  function show(params) {
    d.showPanel(params.tab ? String(params.tab) : undefined);
    return { shown: true };
  }

  function logs(params) {
    const limit = Math.max(1, Math.min(500, Number(params.limit) || 50));
    let rows = state.logs;
    if (params.kind) rows = rows.filter((r) => r.kind === String(params.kind));
    if (params.level) rows = rows.filter((r) => r.level === String(params.level));
    return { logs: rows.slice(-limit).map((r) => ({ at: new Date(r.at).toISOString(), kind: r.kind, level: r.level || "info", text: r.text })) };
  }

  async function folders(params) {
    const op = String(params.op || "list");
    if (op === "list") return { folders: state.roots };
    const target = path.resolve(String(params.path || "").trim() || ".");
    if (!params.path) throw new Error("请给出文件夹路径");
    if (op === "add") {
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`文件夹不存在：${target}`);
      if (state.roots.some((r) => path.resolve(r) === target)) return { folders: state.roots, unchanged: true };
      // 扩大 AI 能碰的范围 —— 必须本机有人点头
      d.showPanel();
      const answer = await d.dialog.showMessageBox(state.panel && !state.panel.isDestroyed() ? state.panel : undefined, {
        type: "question",
        buttons: ["允许", "不允许"],
        defaultId: 1,
        cancelId: 1,
        title: "允许访问文件夹？",
        message: "有程序请求让 AI 访问这个文件夹：",
        detail: `${target}\n\n允许后，连接到本软件的 AI 可以读写这个文件夹里的文件。`,
      });
      if (answer.response !== 0) throw new Error("用户没有允许访问这个文件夹");
      const result = await d.setRoots([...state.roots, target]);
      return { folders: result.state?.roots ?? state.roots, added: target };
    }
    if (op === "remove") {
      const next = state.roots.filter((r) => path.resolve(r) !== target);
      if (next.length === state.roots.length) throw new Error(`当前没有这个文件夹：${target}`);
      if (!next.length) throw new Error("至少要保留一个文件夹");
      const result = await d.setRoots(next);
      return { folders: result.state?.roots ?? next, removed: target };
    }
    throw new Error(`不认识的文件夹操作：${op}（可用 list / add / remove）`);
  }

  /** 给 windrise mcp 用：确保本机 MCP 服务在跑，返回本机地址 */
  async function ensureBridge() {
    if (!state.app) await d.startBridge();
    return { localMcpUrl: state.app.server.localUrl };
  }

  const handlers = {
    status, tunnel, profiles, show, logs, folders,
    ensure_bridge: ensureBridge,
  };

  return async function handle(name, params = {}) {
    const fn = handlers[name];
    if (!fn) throw new Error(`不认识的操作：${name}（可用 ${Object.keys(handlers).join(" / ")}）`);
    return fn(params || {});
  };
}

module.exports = { createAppControl, describePublicCheck, describeActivity };
