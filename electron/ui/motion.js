/* =====================================================================
 * motion.js — 动效层（与业务逻辑解耦，只观察 DOM 变化）
 * 规则：jakubkrehel/skills better-ui —— 入场 opacity+blur(4px)+translateY，
 * 退场更短更小；交互状态用 transition（可中途反转）；
 * 所有位移/缩放/模糊只在 prefers-reduced-motion: no-preference 下运行。
 * ===================================================================== */
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const ok = () => !reduce.matches;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const root = document.documentElement;

/* ---------- 1. 首屏分段入场（只跑一次） ---------- */
function boot() {
  root.classList.add("booting");
  const groups = [
    [".brand", ".rail-indicator"],
    [".rail-section, .rail-btn"],
    [".topbar-titles", ".topbar-actions"],
  ];
  let t = 0;
  groups.forEach((sels) => sels.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el, i) => {
      el.style.setProperty("--d", `${t + i * 35}ms`);
      el.classList.add("enter");
    });
    t += 90;
  }));
  enterPage(document.querySelector(".page.active"), 180);
  document.querySelector(".side-status")?.style.setProperty("--d", "420ms");
  document.querySelector(".side-status")?.classList.add("enter");
  setTimeout(() => root.classList.remove("booting"), 1400);
}

/* ---------- 2. 切页：卡片分段浮现 ---------- */
function enterPage(page, base = 0, dur = base ? 520 : 360) {
  if (!page) return;
  [...page.children].forEach((el, i) => {
    el.classList.remove("enter");
    void el.offsetWidth; // 重新触发动画
    el.style.setProperty("--d", `${base + Math.min(i, 6) * (base ? 60 : 35)}ms`);
    el.style.setProperty("--dur", `${dur}ms`);
    el.classList.add("enter");
  });
  // 页内的列表项（隧道、站点、浏览器配置、工具、开关行…）再错开一点浮现
  if (!ok()) return;
  const items = page.querySelectorAll(STAGGER);
  let n = 0;
  items.forEach((el) => {
    if (el.offsetParent === null || n > 14) return;
    el.classList.remove("stagger-item");
    void el.offsetWidth;
    el.style.setProperty("--sd", `${base + 120 + n * 28}ms`);
    el.classList.add("stagger-item");
    n += 1;
  });
  clearTimeout(page._staggerTimer);
  page._staggerTimer = setTimeout(() => page.querySelectorAll(".stagger-item").forEach((el) => el.classList.remove("stagger-item")), base + 1200);
}
const STAGGER = ".tunnel, .site-tile, .profile, .plan, .tool-row, .rd-item, .msg, .empty, .switch-row, .stat";
new MutationObserver((records) => {
  for (const r of records) {
    const el = r.target;
    if (el.classList.contains("page") && el.classList.contains("active") && !r.oldValue?.includes("active")) enterPage(el);
  }
}).observe(document.querySelector(".scroll"), { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

/* ---------- 3. 侧栏滑动指示器 ---------- */
const rail = document.querySelector(".rail");
const indicator = document.createElement("div");
indicator.className = "rail-indicator";
indicator.setAttribute("aria-hidden", "true");
rail.prepend(indicator);
function moveIndicator(instant = false) {
  const active = rail.querySelector(".rail-btn.active");
  if (!active) return;
  if (instant) indicator.classList.add("instant");
  indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.height = `${active.offsetHeight}px`;
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => indicator.classList.remove("instant")));
}
new MutationObserver(() => moveIndicator()).observe(rail, { subtree: true, attributes: true, attributeFilter: ["class"] });
new ResizeObserver(() => moveIndicator(true)).observe(rail);
document.querySelector(".app").addEventListener("transitionend", (e) => { if (e.propertyName === "width") moveIndicator(true); });

/* ---------- 4. 数字滚动（统计、调用数） ---------- */
const NUM = /^(-?\d+(?:\.\d+)?)(.*)$/;
const last = new WeakMap();
function tween(el, from, to, suffix, decimals) {
  const start = performance.now(), dur = 650;
  el.dataset.tweening = "1";
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    const text = (from + (to - from) * e).toFixed(decimals) + suffix;
    last.set(el, text);
    el.textContent = text;
    if (p < 1) requestAnimationFrame(step); else delete el.dataset.tweening;
  };
  requestAnimationFrame(step);
}
function watchNumber(el) {
  if (!el) return;
  last.set(el, el.textContent);
  new MutationObserver(() => {
    const now = el.textContent;
    if (now === last.get(el)) return;               // 自己写的
    const prev = last.get(el) ?? "";
    last.set(el, now);
    const a = NUM.exec(prev.trim()), b = NUM.exec(now.trim());
    if (!ok() || !a || !b || a[1] === b[1]) return;
    const decimals = (b[1].split(".")[1] || "").length;
    tween(el, Number(a[1]), Number(b[1]), b[2], decimals);
    const card = el.closest(".stat");
    if (card) { card.classList.add("bump"); clearTimeout(card._bump); card._bump = setTimeout(() => card.classList.remove("bump"), 700); }
  }).observe(el, { childList: true, characterData: true, subtree: true });
}
["stat-tools", "stat-avg", "stat-fail", "stat-rate", "ss-calls"].forEach((id) => watchNumber(document.getElementById(id)));

/* ---------- 5. 复制按钮：图标 copy → check 交叉淡变 ---------- */
const CHECK = '<svg class="i i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>';
document.querySelectorAll('.btn[id^="btn-copy"]').forEach((btn) => {
  const icon = btn.querySelector("svg.i");
  if (!icon) return;
  // 页面里已经写好 icon-swap 的按钮（比如公网地址那个）不要再包一层，否则图标会错位
  if (!btn.querySelector(".icon-swap")) {
    const wrap = document.createElement("span");
    wrap.className = "icon-swap";
    icon.replaceWith(wrap);
    wrap.append(icon);
    wrap.insertAdjacentHTML("beforeend", CHECK);
  }
  let timer;
  btn.addEventListener("click", () => {
    btn.classList.add("copied");
    clearTimeout(timer);
    timer = setTimeout(() => btn.classList.remove("copied"), 1600);
  });
});

/* ---------- 6. 卡片聚光（跟随指针的极淡高光） ---------- */
let raf = 0;
document.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const card = e.target.closest?.(".card, .tunnel, .plan, .profile");
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
}, { passive: true });

/* ---------- 7. 主题切换：从按钮处圆形展开（View Transitions） ---------- */
export function withThemeTransition(apply, origin) {
  if (!document.startViewTransition || !ok()) return apply();
  const r = origin?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : 0;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.classList.add("vt-theme");
  const vt = document.startViewTransition(apply);
  vt.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 520, easing: EASE, pseudoElement: "::view-transition-new(root)" });
  });
  vt.finished.finally(() => root.classList.remove("vt-theme"));
}
/* 让某个元素重放一次动画（去掉 class → 强制重排 → 加回） */
function replay(el, cls, ms = 900) {
  if (!el) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  clearTimeout(el["_t_" + cls]);
  el["_t_" + cls] = setTimeout(() => el.classList.remove(cls), ms);
}
window.__motion = { withThemeTransition, enterPage, moveIndicator, replay };

/* ---------- 启动 ---------- */
moveIndicator(true);
if (ok()) boot();

/* ---------- 8. 顶栏随滚动出现分隔线；英雄标题状态切换时重放 ---------- */
const scroller = document.querySelector(".scroll"), topbar = document.querySelector(".topbar");
scroller?.addEventListener("scroll", () => topbar.classList.toggle("scrolled", scroller.scrollTop > 4), { passive: true });
const heroTitle = document.getElementById("hero-title");
if (heroTitle) {
  let prev = heroTitle.textContent;
  new MutationObserver(() => {
    if (heroTitle.textContent === prev) return;
    prev = heroTitle.textContent;
    heroTitle.classList.remove("swap"); void heroTitle.offsetWidth; heroTitle.classList.add("swap");
  }).observe(heroTitle, { childList: true, characterData: true, subtree: true });
}

/* ---------- 9. 按钮涟漪：从按下的位置荡开 ---------- */
document.addEventListener("pointerdown", (e) => {
  if (!ok() || e.button !== 0) return;
  const host = e.target.closest?.(".btn, .rg-row, .gn-item");
  if (!host || host.disabled || host.classList.contains("loading")) return;
  const r = host.getBoundingClientRect();
  const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.setAttribute("aria-hidden", "true");
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  host.append(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
  setTimeout(() => dot.remove(), 1200);
}, { passive: true });

/* ---------- 10. 顶栏标题：换页时换字浮现 ---------- */
const pageTitle = document.getElementById("page-title");
if (pageTitle) {
  let prevTitle = pageTitle.textContent;
  new MutationObserver(() => {
    if (pageTitle.textContent === prevTitle) return;
    prevTitle = pageTitle.textContent;
    if (ok()) replay(pageTitle, "swap", 500);
  }).observe(pageTitle, { childList: true, characterData: true, subtree: true });
}

