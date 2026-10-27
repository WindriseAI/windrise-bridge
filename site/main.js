// Windrise Bridge 官网脚本。每一块单独包起来，一块出错不影响别的；没有脚本时内容照样都看得见。
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const safe = (fn) => { try { fn(); } catch (error) { console.warn(error); } };

// 进场：进视口时显示一次，不重放；同一组里的几样东西错开出现；观察器没触发时兜底全部显示
safe(() => {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window)) { targets.forEach((el) => el.classList.add('is-in')); return; }
  targets.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal'));
    el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 6) * 80}ms`;
  });
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  targets.forEach((el) => io.observe(el));
  addEventListener('load', () => setTimeout(() => {
    targets.forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in'); });
  }, 2500));
});

// 首屏能动手的地方：在手机上派一件活，电脑屏幕上一步步出现它在做什么（演示，内容是示例）
safe(() => {
  const TASKS = {
    orders: { ask: '导出今天的订单', steps: ['打开后台（已登录）', '筛选「今天」', '点「导出」'], done: '27 单，已存到「下载」' },
    report: { ask: '整理本周周报', steps: ['打开文档（已登录）', '读这周的 8 条记录', '新建「周报」页面'], done: '整理好了，8 条' },
    tests: { ask: '跑测试发我结果', steps: ['在终端里跑测试', '读结果', '记一份给你'], done: '212 项全部通过' },
  };
  const chips = [...document.querySelectorAll('.chip')];
  const bubble = document.querySelector('[data-bubble]');
  const log = document.querySelector('[data-log]');
  const reply = document.querySelector('[data-reply]');
  if (!chips.length || !bubble || !log) return;
  let timers = [];
  const play = (key) => {
    const task = TASKS[key];
    timers.forEach(clearTimeout);
    timers = [];
    bubble.textContent = task.ask;
    if (reply && !reduceMotion) { reply.style.animation = 'none'; void reply.offsetWidth; reply.style.animation = ''; }
    log.replaceChildren();
    const items = [...task.steps, task.done].map((text, i, all) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (i === all.length - 1) li.className = 'is-done';
      return li;
    });
    items.forEach((li, i) => {
      if (!reduceMotion) li.classList.add('is-hidden');
      log.append(li);
      if (!reduceMotion) timers.push(setTimeout(() => li.classList.remove('is-hidden'), 450 + i * 650));
    });
  };
  chips.forEach((chip, i) => {
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      play(chip.dataset.task);
    });
    chip.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = chips[(i + step + chips.length) % chips.length];
      next.focus();
      next.click();
    });
  });
});

// 「你说了算」那几个开关：真能拨；登录页那个关不掉
safe(() => {
  document.querySelectorAll('.switchrow .toggle').forEach((toggle) => {
    const row = toggle.closest('.switchrow');
    toggle.addEventListener('click', () => {
      if (toggle.getAttribute('aria-disabled') === 'true') return;
      const on = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(on));
      row.classList.toggle('is-on', on);
    });
  });
});

// 下载按钮：新版发布前一律不可点。
// 更新服务器的 stable 渠道现在发的是旧版 v0.1.0（要激活码，没有 BrowserOS 窗口和断线恢复），不能让访客以为下到的是页面上讲的这一版。
// 新版发布后把 NEW_BUILD_RELEASED 改成 true，就沿用旧官网的做法：问更新接口拿安装包地址和版本号，拿到才放行。
const NEW_BUILD_RELEASED = false;
safe(() => {
  const button = document.getElementById('dl-win');
  if (!button) return;
  button.addEventListener('click', (event) => { if (button.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
  if (!NEW_BUILD_RELEASED) return;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 6000);
  fetch('https://api.secrethq.shop/api/update/check?version=0.0.0&platform=win32&channel=stable', { signal: controller.signal, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      // 更新接口回的 manifest 是一段 JSON 字符串，安装包在 latest.assets.setup（没有就用 portable）
      const latest = data?.manifest ? JSON.parse(data.manifest).latest : null;
      const url = (latest?.assets?.setup || latest?.assets?.portable)?.url;
      if (!url) return;
      button.href = url;
      button.setAttribute('aria-disabled', 'false');
      button.textContent = latest.version ? `下载 Windows 版 v${latest.version}` : '下载 Windows 版';
    })
    .catch(() => {});
});
