/**
 * 托盘化启动流程的纯逻辑（不碰 Electron，不碰浏览器）：
 *   - 启动时要不要自动打开格子 1（用户手动开 vs 开机自启，两个开关分开）；
 *   - 「格子 1」账号怎么解析：有就开，没有就按现有命名规则建一个（启动地址 Google）；
 *   - 「格子 N」账号命名（和 browseros-profiles 的 #nextGridName 同一套规则）；
 *   - second-instance 的处理计划；
 *   - 托盘「连接状态」一行的文字（已连接 / 未连接 + 公网域名，不带口令不带路径）。
 *
 * main.cjs 只拿这些结果执行；自测直接调这里，不用起 Electron。
 */

/** 新格子默认打开的网址（2026-10-26 用户定：Google） */
const GRID1_START_URL = "https://www.google.com/";
/** 格子 1 的账号名（产品计划 2026-10-26「格子 N」命名规则） */
const GRID1_NAME = "格子 1";

/**
 * 格子 1 打开后要不要在里面开「初次设置」引导页标签：
 * 引导没走过（settings.onboardingDone 不是 true）且这次真打开了格子 1。
 * 引导页右上角「跳过」/ 走完 8 步 / 页面被关掉都会记 onboardingDone，之后不再自动弹；
 * 侧边栏底部有「重新打开初次设置」，随时可以再看。
 */
function shouldOpenOnboarding(saved = {}, { opened = false } = {}) {
  return opened === true && saved?.onboardingDone !== true;
}

/**
 * 启动时要不要自动打开格子 1：
 *   - 开机自启：看 openGridOnAutostart（默认关，一开机不弹浏览器）；
 *   - 用户自己打开：看 openGridOnStart（默认开，打开软件 = 出浏览器）。
 */
function shouldOpenGridOnStart(saved = {}, { autostart = false } = {}) {
  if (autostart) return saved.openGridOnAutostart === true;
  return saved.openGridOnStart !== false;
}

/** 最小的没被用掉的「格子 N」名字（和 browseros-profiles 的 #nextGridName 同一套规则） */
function gridNameFor(preferred = null, profiles = []) {
  const used = new Set();
  for (const profile of profiles || []) {
    if (profile?.name) used.add(String(profile.name));
  }
  // 优先用它将要占的位置编号（第 2 格就叫「格子 2」），被别的账号占了名字才往后找
  if (Number.isInteger(preferred) && preferred > 0 && !used.has(`格子 ${preferred}`)) return `格子 ${preferred}`;
  for (let n = 1; n < 100_000; n += 1) {
    const name = `格子 ${n}`;
    if (!used.has(name)) return name;
  }
  throw new Error("账号名「格子 N」已经用掉太多了，建不出新名字");
}

/**
 * 找「格子 1」的账号：
 *   - 有「格子 1」→ { kind: "open", id }（直接开 / 聚焦）；
 *   - 没有 → { kind: "create", name, startUrl }（按命名规则建一个，启动地址 Google）。
 */
function resolveGrid1(profiles = []) {
  const list = Array.isArray(profiles) ? profiles : [];
  // 「格子 1」指用户的主格子，不是名字叫「格子 1」的那个：老用户的主账号可能叫别的名字（例如「google.com 账号 1」）。
  // 优先最近打开过的；都没打开过就用叫「格子 1」的；再不行就第一个。只有一个账号都没有时才新建。
  const byRecent = list.filter((p) => p?.id).slice().sort((a, b) => (Number(b?.lastOpenedAt) || 0) - (Number(a?.lastOpenedAt) || 0));
  const existing = (byRecent[0] && Number(byRecent[0].lastOpenedAt) > 0 ? byRecent[0] : null)
    || list.find((p) => String(p?.name || "") === GRID1_NAME)
    || byRecent[0]
    || null;
  if (existing?.id) {
    return { kind: "open", id: existing.id, name: existing.name, startUrl: existing.startUrl || GRID1_START_URL };
  }
  return { kind: "create", name: gridNameFor(1, list), startUrl: GRID1_START_URL };
}

/**
 * 打开（或聚焦）格子 1 的完整流程（main.cjs 的 openWindrise 就用它，自测换假依赖）：
 * 解析 → 没账号就先建（名字按命名规则、启动地址 Google）→ 开窗口 → 聚焦。
 */
async function openGrid1Flow({ profiles, createProfile, openWindow, focusWindow }) {
  const plan = resolveGrid1(profiles);
  const id = plan.kind === "open"
    ? plan.id
    : (await createProfile({ name: plan.name, startUrl: plan.startUrl })).id;
  await openWindow(id);
  if (focusWindow) await focusWindow(id);
  return { kind: plan.kind, id, name: plan.name };
}

/**
 * second-instance 的处理计划：
 *   - 账号管理器还没就绪：先记账（wantGrid1），等就绪了再开；
 *   - 就绪了：直接打开 / 聚焦格子 1。
 */
function secondInstancePlan({ profilesReady }) {
  return profilesReady ? { action: "open" } : { action: "queue" };
}

/** 托盘「连接状态」一行：已连接 / 未连接 + 公网地址的域名部分（不显示口令、不带路径） */
function trayStatusLine({ level, host = "" }) {
  const label = level === "connected" ? "已连接" : "未连接";
  const domain = String(host || "").trim();
  return domain ? `${label} · ${domain}` : label;
}

module.exports = {
  GRID1_START_URL,
  GRID1_NAME,
  shouldOpenGridOnStart,
  shouldOpenOnboarding,
  gridNameFor,
  resolveGrid1,
  openGrid1Flow,
  secondInstancePlan,
  trayStatusLine,
};
