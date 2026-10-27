/**
 * 多账号浏览器管理器（CommonJS 版）。
 *
 * 账号窗口固定交给浏览器内核（Windrise 浏览器，BrowserOS 分支；老机器上装的是 BrowserOS）：
 * 每个账号是一个独立的资料目录，
 * 由 BrowserOsProfiles（browseros-profiles.cjs）启动、摆位、收起/显示和关闭。
 * 这个文件只保留账号数据、站点清单、格子编号/布局和给控制服务的统一入口，
 * 不再包含 Electron 内嵌浏览器内核（session 分区、BrowserWindow、分屏工作台）。
 *
 * 只做「多开账号」：独立资料目录 + 可选代理 + 持久化。
 * 不做任何设备指纹伪装（已移除）。
 */

const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { checkProxyForSave } = require("./proxy-guard.cjs");
const { checkSiteUrl } = require("./url-guard.cjs");

const PROFILES_FILE = "browser-profiles.json";
/*
 * 默认 UA：
 * ① Electron 自带的 UA 里有 "Electron/x.y" 和应用名，Google 登录等会因此拒绝
 *   （「此浏览器或应用可能不安全」）——去掉这两段。
 * ② 内核版本：Electron 32 = Chromium 128。有的站点按 UA 里的 Chrome 版本拦截旧浏览器，
 *   128 会被 302 到不支持页。所以把版本号报成「当前 Chrome 稳定版」：按 Chrome 每 4 周一版从 128 的发布日推算，
 *   用 Chrome 官方的精简格式 Chrome/<主版本>.0.0.0（真 Chrome 也是这么发的）。
 * 这不是伪装设备，只是不暴露壳的名字、不让站点误判成过期浏览器。
 */
const CHROME_128_RELEASE = Date.UTC(2024, 7, 20);
const FOUR_WEEKS = 28 * 24 * 3600 * 1000;
function currentChromeMajor(now = Date.now()) {
  const estimated = 128 + Math.floor((now - CHROME_128_RELEASE) / FOUR_WEEKS);
  // 少报 1 版（新版刚推送时大量用户还在上一版），下限 131，上限防止系统时间错乱报出离谱版本
  return Math.min(Math.max(estimated - 1, 131), 128 + 60);
}

function cleanUserAgent(ua) {
  const major = currentChromeMajor();
  return String(ua || "")
    .replace(/\s*Electron\/[\d.]+/i, "")
    .replace(/\s*bridge-replica\/[\d.]+/i, "")
    .replace(/\s*Bridge Replica\/[\d.]+/i, "")
    .replace(/\s*Windrise[ -]?Bridge\/[\d.]+/i, "")
    .replace(/Chrome\/(\d+)[\d.]*/, (all, v) => (Number(v) < major ? `Chrome/${major}.0.0.0` : all))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 内置站点快捷入口：一键新建一个独立账号窗口并打开。没有内置站点时用「添加网站」自己加。 */
const QUICK_SITES = {};

/** 用户输入的网址规范化：补 https://，只接受 http(s) */
function normalizeSiteUrl(input) {
  let text = String(input || "").trim();
  if (!text) throw new Error("请填写网址");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 http / https 网址");
  return url.href;
}

const PALETTE = ["#2f6feb", "#16a34a", "#e8720c", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#c2410c"];

/** 带错误码的错：调用方按 code 分支（错误码见 docs/research/browseros-engine-contract-2026-10-24.md §7） */
function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 浏览器内核能不能用（新版本是 Windrise 浏览器，老机器上回退 BrowserOS 装的那份）。
 * 全过才算能用：找得到程序 → 程序能用（不是待装新版、不在 BrowserClaw 下面）→ 算出来的默认资料目录不是浏览器自己的。
 * 任何一条不过都把原因带回去；开账号窗口时按 BROWSEROS_UNAVAILABLE 明确报错，不回落 Electron。
 */
function checkBrowserOsReady(dataHome) {
  let engine;
  try {
    engine = require("./browseros-engine.cjs");
  } catch (error) {
    return { ok: false, reason: `引擎模块加载不了：${error.message}` };
  }
  let exe;
  try {
    exe = engine.findExecutable();
  } catch (error) {
    return { ok: false, reason: `找不到 Windrise 浏览器主程序（${error.code || "错误"}：${error.message}）` };
  }
  try {
    engine.assertUsableExecutable(exe);
  } catch (error) {
    return { ok: false, reason: `Windrise 浏览器主程序不能用（${error.code || "错误"}：${error.message}）` };
  }
  try {
    const dir = engine.defaultUserDataDir(dataHome, "engine-auto-check");
    const norm = (value) => path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
    const localAppData = process.env.LOCALAPPDATA || "";
    if (localAppData) {
      // 保留目录直接用引擎那份清单（Chrome / Edge / Windrise / BrowserOS / Chromium / BrowserClaw），别再抄一份
      const reserved = engine.defaultBrowserProfileDirs({ localAppData });
      const claw = norm(path.join(localAppData, "BrowserClaw"));
      if (reserved.some((item) => norm(item) === norm(dir))) return { ok: false, reason: `默认资料目录 ${dir} 正好是浏览器自己的默认目录，不能拿来开账号窗口` };
      if (norm(dir) === claw || norm(dir).startsWith(`${claw}${path.sep}`)) return { ok: false, reason: `默认资料目录 ${dir} 落在 BrowserClaw 下面（那是 neo 的地盘）` };
    }
  } catch (error) {
    return { ok: false, reason: `算不出默认资料目录：${error.message}` };
  }
  return { ok: true, exe };
}

/** Windrise 浏览器不可用时的统一错误：说清原因，并告诉用户怎么装。 */
function browserOsUnavailableError(reason) {
  return codedError(
    "BROWSEROS_UNAVAILABLE",
    `账号窗口需要 Windrise 浏览器，但这次用不了：${reason}。请先安装 Windrise 浏览器（安装包里带着），装好后重启 Windrise Bridge；软件其他功能照常可用。`,
  );
}

class BrowserProfileManager {
  constructor({
    dataHome, onEvent = () => {}, getWorkArea = null, getPanelState = null, showSettings = null,
    getExtAutoSync = null, setExtAutoSync = null,
    tunnelConnect = null, generateOwnerKey = null, setToolTier = null, setOnboardingDone = null,
  } = {}) {
    this.dataHome = dataHome ?? path.join(app.getPath("userData"), "browser");
    this.file = path.join(this.dataHome, PROFILES_FILE);
    this.onEvent = onEvent;
    this.open = new Map();       // id -> { profile, window, partition, engine }
    this.profiles = [];
    this.loaded = false;
    this.sites = [];             // 用户自定义的一键打开网站 [{ key, name, url, color }]
    /** 工作区来源（Electron 的 screen 由 main.cjs 注入；这一层和 backend 都不 require electron） */
    this.getWorkArea = typeof getWorkArea === "function" ? getWorkArea : null;
    /** 账号窗口后端固定是浏览器内核；安装/环境不满足时这里照样能建，开窗口时才明确报 BROWSEROS_UNAVAILABLE */
    this.engine = "browseros";
    const { BrowserOsProfiles } = require("./browseros-profiles.cjs");
    this.backend = new BrowserOsProfiles({
      dataHome: this.dataHome,
      onEvent: (event) => this.#onBackendEvent(event),
      getWorkArea: this.getWorkArea,
      // 换布局补新账号时，用这个管理器自己的建账号逻辑（落盘、事件、颜色、默认值都跟界面新建一样）
      createProfile: (input) => this.create(input),
      listProfiles: () => this.profiles,
      // 侧边栏 / 新标签页的只读状态（main.cjs 实现），以及插件里「管理口令」要打开设置页
      getPanelState: typeof getPanelState === "function" ? getPanelState : null,
      showSettings: typeof showSettings === "function" ? showSettings : null,
      // 点格子列表时由这里打开 / 摆回：走 openWindow，才能同步上层 open 登记表
      openGrid: (slot) => this.openGrid(slot),
      // 「新装的插件自动装到所有格子」开关的读 / 写（main.cjs 接 settings）
      getExtAutoSync: typeof getExtAutoSync === "function" ? getExtAutoSync : null,
      setExtAutoSync: typeof setExtAutoSync === "function" ? setExtAutoSync : null,
      // 初次设置引导页的动作（main.cjs 接设置 / 隧道 / 口令）
      tunnelConnect: typeof tunnelConnect === "function" ? tunnelConnect : null,
      generateOwnerKey: typeof generateOwnerKey === "function" ? generateOwnerKey : null,
      setToolTier: typeof setToolTier === "function" ? setToolTier : null,
      setOnboardingDone: typeof setOnboardingDone === "function" ? setOnboardingDone : null,
    });
  }

  /** 开窗口前先确认 BrowserOS 能用；不能用就明确报错，不回落 Electron。 */
  #assertBrowserOsReady() {
    const ready = checkBrowserOsReady(this.dataHome);
    if (!ready.ok) throw browserOsUnavailableError(ready.reason);
    return ready;
  }

  /**
   * 转发内核事件；顺手维护「已打开」登记 —— 浏览器进程自己死了、标签页被人关了，
   * backend 会报 window-closed，这里跟着把它从 open 里摘掉，windowFor 立刻就会说「没打开」。
   */
  #onBackendEvent(event) {
    try {
      if (event?.kind === "window-closed") {
        const entry = this.open.get(event.id);
        if (entry && entry.engine === "browseros") this.open.delete(event.id);
      }
      this.onEvent(event);
    } catch (error) {
      console.log(`[browser-profiles] 处理事件 ${event?.kind} 出错（忽略）：${error.message}`);
    }
  }

  async load() {
    if (this.loaded) return this.profiles;
    await fs.mkdir(this.dataHome, { recursive: true });
    const raw = await fs.readFile(this.file, "utf8").catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // 老数据里可能还有 fingerprint 字段；旧版分屏偏好（split）读到也直接忽略，不往新文件里带
        this.profiles = (Array.isArray(parsed?.profiles) ? parsed.profiles : []).map(({ fingerprint, ...rest }) => rest);
        if (Array.isArray(parsed?.sites)) this.sites = parsed.sites.filter(x => x && x.key && x.url);
      } catch { this.profiles = []; }
    }
    this.loaded = true;
    return this.profiles;
  }

  async save() {
    await fs.mkdir(this.dataHome, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ version: 1, profiles: this.profiles, sites: this.sites }, null, 2), "utf8");
    return this.profiles;
  }

  /** 分区短标签（BrowserOS 的标识，只给界面/日志当 key 用，不是 Electron 的 persist: 分区）。 */
  partitionOf(profile) {
    return this.backend.partitionOf(profile.id);
  }

  async create({ name, startUrl = "about:blank", proxy = "", userAgent = "", note = "", color = "", site = "" } = {}) {
    await this.load();
    const id = randomUUID().slice(0, 8);
    const profile = {
      id,
      name: (name || "").trim() || `窗口 ${this.profiles.length + 1}`,
      // 起始地址只放行 http / https / about:blank（AI 能经 windrise_profiles 传进来，挡 file://）
      startUrl: checkSiteUrl(startUrl) || "about:blank",
      // 代理写法不对就直接报错给用户看，不存一个「看着像代理、其实直连」的配置
      proxy: checkProxyForSave(proxy),
      userAgent: userAgent || "",
      note: note || "",
      color: color || PALETTE[this.profiles.length % PALETTE.length],
      site: site || "",
      createdAt: Date.now(),
      lastOpenedAt: null,
      openCount: 0,
    };
    this.profiles.push(profile);
    await this.save();
    this.onEvent({ kind: "profile-created", id: profile.id, name: profile.name });
    return profile;
  }

  async update(id, patch) {
    await this.load();
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new Error(`没有这个窗口：${id}`);
    const checked = { ...patch };
    if (checked.startUrl !== undefined) checked.startUrl = checkSiteUrl(checked.startUrl) || "about:blank";
    if (checked.proxy !== undefined) checked.proxy = checkProxyForSave(checked.proxy);
    for (const key of ["name", "startUrl", "proxy", "userAgent", "note", "color", "zoom"]) {
      if (checked[key] !== undefined) profile[key] = checked[key];
    }
    await this.save();
    return profile;
  }

  /**
   * 移除窗口。
   * 删除本地数据是高危操作，所以：默认只从列表移除、磁盘数据保留；
   * 只有调用方显式传 purge=true 才清空该账号的分区目录。
   */
  async remove(id, { purge = false } = {}) {
    await this.load();
    const index = this.profiles.findIndex(p => p.id === id);
    if (index < 0) throw new Error(`没有这个窗口：${id}`);
    const [profile] = this.profiles.splice(index, 1);
    // 关窗 + 删目录都交给 backend：删的是 BrowserOS 的资料目录
    if (!purge) await this.backend.close(id).catch((error) => console.log(`[browser-profiles] 关账号窗口 ${id} 出错（忽略）：${error.message}`));
    this.open.delete(id);
    await this.save();
    let purged = false;
    if (purge) {
      // 删不掉就让错误抛出去（删不干净不能算成功）
      await this.backend.purge(id);
      purged = true;
    }
    this.onEvent({ kind: "profile-removed", id, purged });
    return { profile, purged, partitionKept: !purge };
  }

  /**
   * 一键开站点：每点一次新建一个独立账号窗口（「站点名 账号 1、2、3…」）并直接打开。
   * 想回到已有账号，用列表里的「打开」。
   */
  /* ---------------- 一键打开网站（内置 + 用户自定义） ---------------- */
  async listSites() {
    await this.load();
    const builtin = Object.entries(QUICK_SITES).map(([key, s]) => ({ key, ...s }));
    return [...builtin, ...this.sites.map(s => ({ ...s, builtin: false }))].map(s => ({
      ...s,
      accounts: this.profiles.filter(p => p.site === s.key).length,
    }));
  }

  async addSite({ name, url, color } = {}) {
    await this.load();
    const href = normalizeSiteUrl(url);
    const host = new URL(href).hostname.replace(/^www\./, "");
    if (this.sites.length >= 24) throw new Error("最多添加 24 个网站");
    const site = {
      key: `site-${randomUUID().slice(0, 6)}`,
      name: String(name || "").trim().slice(0, 24) || host,
      url: href,
      color: /^#[0-9a-f]{6}$/i.test(color || "") ? color : PALETTE[(this.sites.length + 1) % PALETTE.length],
    };
    this.sites.push(site);
    await this.save();
    return site;
  }

  async removeSite(key) {
    await this.load();
    const before = this.sites.length;
    this.sites = this.sites.filter(s => s.key !== key);
    if (this.sites.length === before) throw new Error("没有这个网站（内置网站不能删除）");
    await this.save();
    return { removed: key };
  }

  siteOf(key) {
    return QUICK_SITES[key] ?? this.sites.find(s => s.key === key) ?? null;
  }

  async openQuickSite(key = "") {
    await this.#assertBrowserOsReady();
    await this.load();
    const site = this.siteOf(key);
    if (!site) throw new Error(`不认识的站点：${key}`);
    const index = this.profiles.filter(p => p.site === key).length + 1;
    const profile = await this.create({ name: `${site.name} 账号 ${index}`, startUrl: site.url, site: key, color: site.color });
    const opened = await this.openWindow(profile.id);
    return { ...opened, profile };
  }

  /**
   * 打开（或聚焦）账号窗口。
   * 同一 profile 重复调用只聚焦，不新开——两个窗口抢同一份 Cookie 会互相踢下线。
   */
  async openWindow(id, { url, mode } = {}) {
    await this.load();
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) {
      // 走不到这里时说明 id 既不是账号 id 也不是格子编号：把「该传什么」写清楚，别只说「没有这个窗口」
      throw codedError("TARGET_CLOSED", `没有这个窗口：${id}。id 要填账号 id，或者格子编号（例如 1、「格子 1」、「slot:1」）；不确定有哪些格子就先调 browser_profiles`);
    }
    if (mode && mode !== "window") throw codedError("INVALID_ARGUMENT", "账号窗口只能独立打开，不支持分屏模式");
    this.#assertBrowserOsReady();

    const target = url ? checkSiteUrl(url) : "";
    const opened = await this.backend.open(id, { profile, url: target });
    // 登记进 open：browser-control 的 windowFor 认的就是这里（window 是 BrowserOS 标签页的外观）
    this.open.set(id, { profile, window: opened.window, partition: opened.partition, engine: "browseros" });
    if (!opened.reused) {
      profile.lastOpenedAt = Date.now();
      profile.openCount = (profile.openCount || 0) + 1;
      await this.save();
    }
    // url 用后端交回的真实地址（复用时就是标签页现在停的地方），slot 用当前格子编号
    return { profile, reused: opened.reused, partition: opened.partition, mode: "window", url: opened.url ?? target ?? null, slot: opened.slot ?? null };
  }

  closeWindow(id) {
    // 契约要求：返回 Promise，但内部 catch 完 —— main.cjs 是即发即忘，不能变成未处理的拒绝
    this.open.delete(id);   // 先注销：紧接着的 list() 立刻就不会再说它在跑
    return this.backend.close(id)
      .catch((error) => {
        console.log(`[browser-profiles] 关账号窗口 ${id} 出错（已忽略）：${error.message}`);
        return { closed: false, error: error.message };
      });
  }

  /** 列出所有窗口 + 运行状态，供界面渲染。 */
  async list() {
    await this.load();
    // BrowserOS 那边只问「哪些开着、现在在哪个网址」，而且只给短标签，绝不给 pid / 端口 / ws / 盘符路径
    const live = new Map(this.backend.list().map((item) => [item.id, item]));
    return this.profiles.map(profile => {
      const item = live.get(profile.id);
      const running = Boolean(item?.running);
      return {
        ...profile,
        running,
        partition: this.backend.partitionOf(profile.id),
        partitionDir: null,
        currentUrl: running ? (item.currentUrl || null) : null,
        mode: running ? "window" : null,
        engine: "browseros",
        slot: running ? (item.slot ?? null) : null,
        hidden: running ? Boolean(item.hidden) : false,
      };
    });
  }

  get openCount() { return this.open.size; }

  /* ---------------- 格子编号 / 布局 ---------------- */

  #assertBrowserOsGrids(what) {
    if (!this.backend) throw codedError("BROWSEROS_UNAVAILABLE", `${what}需要 Windrise 浏览器账号窗口后端；请先安装 Windrise 浏览器并重启 Windrise Bridge`);
  }

  /**
   * 「格子 2」/「slot:2」/「2」→ 账号 id；不是这三种写法就返回 null（交给调用方按 id / 名字继续找）。
   *
   * 两种来源都要认，否则 browser_open id=1 在格子没开的时候会报「没有这个窗口：1」：
   *   1. 现在开着的格子（按当前编号，收起的按收起前的编号）；
   *   2. 还没开、但账号名就是「格子 N」的那个账号 —— 这正是 browser_open 要打开的格子。
   */
  async resolveGridId(key) {
    const text = String(key ?? "").trim();
    if (!text) return null;
    const match = /^格子\s*(\d+)$/.exec(text) || /^slot\s*[:：]\s*(\d+)$/i.exec(text) || /^(\d+)$/.exec(text);
    if (!match) return null;
    this.#assertBrowserOsGrids("按格子编号找窗口");
    const slot = Number(match[1]);
    if (!Number.isInteger(slot) || slot <= 0) return null;
    const rows = this.backend.list();
    const live = rows.find((item) => item.slot === slot && !item.hidden) || rows.find((item) => item.lastSlot === slot);
    if (live?.id) return live.id;
    // 没开着：按账号名「格子 N」找（换布局 / 首次打开时都是这个名字）
    await this.load();
    const profile = this.profiles.find((item) => item.name === `格子 ${slot}`);
    return profile?.id ?? null;
  }

  /** 当前 slot 1 的账号 id（windrise_profiles layout 不传 id 时的基准格子） */
  async defaultGridId() {
    this.#assertBrowserOsGrids("找 slot 1");
    const rows = this.backend.list();
    return (rows.find((item) => item.slot === 1 && !item.hidden) || rows.find((item) => !item.hidden))?.id ?? null;
  }

  async #gridTargetId(key) {
    const text = String(key ?? "").trim();
    if (!text) throw codedError("INVALID_ARGUMENT", "缺少格子：请给出 slot（格子 2 / slot:2 / 2）或账号 id");
    const byGrid = await this.resolveGridId(text);
    if (byGrid) return byGrid;
    // 也认账号 id / 名字（MCP 层通常已经换过一次，这里兜底，免得名字直接掉进 backend）
    const rows = await this.list();
    const byId = rows.find((item) => item.id === text);
    if (byId) return byId.id;
    const byName = rows.find((item) => item.name === text)
      || rows.find((item) => String(item.name).toLowerCase() === text.toLowerCase());
    return byName ? byName.id : text;
  }

  /** 把 backend 里新开/换过位置的窗口同步进 open（browser-control 的 windowFor 认这里） */
  #syncOpenFromBackend() {
    if (!this.backend) return;
    for (const entry of this.backend.entries()) {
      this.open.set(entry.id, {
        profile: entry.profile,
        window: entry.window,
        partition: entry.partition,
        engine: "browseros",
      });
    }
  }

  async setBounds(id, bounds) {
    this.#assertBrowserOsGrids("setBounds");
    const target = await this.#gridTargetId(id);
    return this.backend.setBounds(target, bounds);
  }

  async hide(id) {
    this.#assertBrowserOsGrids("收起格子");
    const target = await this.#gridTargetId(id);
    return this.backend.hide(target);
  }

  async show(id) {
    this.#assertBrowserOsGrids("显示格子");
    const target = await this.#gridTargetId(id);
    return this.backend.show(target);
  }

  /**
   * 人主动点「聚焦」（托盘单击 / second-instance / 侧边栏格子列表）：
   * 收起先摆回屏幕内，再让浏览器把窗口拿到前台。AI 的控制路径（openWindow / show）不碰它。
   */
  async focusWindow(id) {
    this.#assertBrowserOsGrids("聚焦格子");
    await this.load();
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`没有这个窗口：${id}`);
    const result = await this.backend.focus(id);
    this.#syncOpenFromBackend();
    return { id, name: profile.name, hidden: result?.hidden === true };
  }

  /**
   * 换布局。clickedId 不传时用当前 slot 1（需求：默认以当前 slot 1 为准）。
   * 新补出来的账号由 backend 调 createProfile（就是本类的 create），再登记进 open。
   */
  async applyLayout(clickedId, layout) {
    this.#assertBrowserOsGrids("换格子布局");
    await this.load();
    const base = clickedId === undefined || clickedId === null || String(clickedId).trim() === ""
      ? await this.defaultGridId()
      : await this.#gridTargetId(clickedId);
    if (!base) throw codedError("INVALID_ARGUMENT", "现在没有打开的格子；先用 browser_open 打开一个再切布局");
    const result = await this.backend.applyLayout(base, layout);
    // 换布局补出来的新账号也算「打开过一次」，和界面点「打开」记的口径一致
    if (Array.isArray(result?.created) && result.created.length) {
      for (const item of result.created) {
        const profile = this.profiles.find((p) => p.id === item.id);
        if (!profile) continue;
        profile.lastOpenedAt = Date.now();
        profile.openCount = (profile.openCount || 0) + 1;
      }
      await this.save();
    }
    this.#syncOpenFromBackend();
    return result;
  }

  async navigate(id, url) {
    return this.backend.navigate(id, url);   // 里面已经过 checkSiteUrl
  }

  /**
   * 侧边栏 / 新标签页点某个格子：按编号找已开的窗口（含收起的，用收起前的编号），
   * 找到就摆回屏幕内并拿到前台；没开着就按名字「格子 N」打开那个账号再聚焦。
   * 走 openWindow / backend.focus，保证上层的 open 登记表也跟着更新；这是人点的路径，AI 到不了。
   */
  async openGrid(slot) {
    this.#assertBrowserOsGrids("打开格子");
    await this.load();
    const wanted = Number(slot);
    if (!Number.isInteger(wanted) || wanted <= 0) {
      throw codedError("INVALID_ARGUMENT", `格子编号必须是正整数（收到 ${String(slot)}）`);
    }
    const live = this.backend.entries().find((item) => item.slot === wanted)
      || this.backend.entries().find((item) => item.lastSlot === wanted);
    if (live) {
      const shown = await this.backend.focus(live.id);
      this.#syncOpenFromBackend();
      return {
        opened: {
          id: live.id,
          name: live.profile?.name || live.id,
          slot: shown?.slot ?? live.slot ?? null,
          hidden: false,
          reused: true,
        },
      };
    }
    const profile = this.profiles.find((item) => item.name === `格子 ${wanted}`);
    if (!profile) throw codedError("INVALID_ARGUMENT", `没有编号为 ${wanted} 的格子（账号「格子 ${wanted}」不存在）`);
    const opened = await this.openWindow(profile.id);
    await this.backend.focus(profile.id).catch((error) => console.log(`[browser-profiles] 格子 ${profile.id} 拿前台失败（忽略）：${error.message}`));
    return {
      opened: {
        id: profile.id,
        name: profile.name,
        slot: this.backend.get(profile.id)?.slot ?? null,
        hidden: false,
        reused: Boolean(opened?.reused),
      },
    };
  }

  /** 侧边栏 / 新标签页的格子列表（只给编号、名字、是否收起） */
  panelGrids() {
    return this.backend.panelGrids();
  }

  /** 侧边栏 / 新标签页的空间列表（只给 id、名字、owner、标签页数） */
  panelSpaces(id) {
    return this.backend.panelSpaces(id);
  }

  /** 读该账号的 Cookie 数量，用来直观证明「隔离生效」。 */
  async cookieCount(id) {
    await this.load();
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new Error(`没有这个窗口：${id}`);
    return this.backend.cookieCount(id);
  }

  closeAll() {
    // 契约要求：返回 Promise，内部 catch 完（main.cjs 是即发即忘）
    this.open.clear();
    return this.backend.closeAll()
      .catch((error) => { console.log(`[browser-profiles] 关全部账号窗口时出错（已忽略）：${error.message}`); })
      .then(() => ({ closed: true }));
  }
}

module.exports = { BrowserProfileManager, QUICK_SITES, cleanUserAgent, normalizeSiteUrl };
