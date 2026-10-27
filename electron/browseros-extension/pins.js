/**
 * Windrise 钉住（Pin）的共享模块：sw.js 用 importScripts 引入，侧边栏用 <script> 引入，
 * Node 自测（_probe/browseros-pins-selftest.mjs）用 vm 加载后直接测里面的纯函数。
 *
 * 钉住 = 像 Windows 资源管理器「快速访问」的一组常用网页，按空间分开存：
 * chrome.storage.local 里的键 windrise.pins，值 {version, spaces: {<空间id>: [钉住条目]}}。
 * storage.local 跟着这个账号的资料目录走，所以人和 AI 在同一格子里共用一份，
 * 但各自的钉住写在自己空间的清单里，互不挤占。「我的」空间 id 就是 home。
 *
 * 安全规矩（全在这里拦住，两边共用同一套）：
 *   - url 只收 http / https（javascript:、data:、file:、chrome: 一律拒）；
 *   - 标题裁到 80 字，空标题用网址的域名兜底；
 *   - 同一空间同一个网址只存一条（重复钉只是更新标题）；
 *   - 每个空间最多 50 条，超了报 PIN_LIMIT；
 *   - by 只认 human / ai，别的按 ai。
 * 这份文件不发任何网络请求、不读页面内容。
 */

(function (global) {
  "use strict";

  /** chrome.storage.local 里的键（跟着账号资料目录走） */
  const PINS_KEY = "windrise.pins";
  /** 存储形状版本：以后不兼容地改了 +1 */
  const PINS_VERSION = 1;
  /** 每个空间最多钉多少条 */
  const PIN_LIMIT = 50;
  /** 标题最长多少字 */
  const TITLE_LIMIT = 80;
  /** 钉住 id 的短随机串（和空间 id 同一套字母表，去掉容易看混的字符） */
  const PIN_ID_LENGTH = 8;
  const PIN_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

  /* ---------------- 纯校验（不碰 chrome，自测直接测这些） ---------------- */

  function pinError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  /** 是不是能钉的网址：只认 http / https，别的协议（javascript:、data:、file:、chrome:…）一律不是 */
  function isHttpUrl(input) {
    return normalizeUrl(input) !== null;
  }

  /** 规范化网址：http/https 才收，别的一律 null；认不出来的坏地址也是 null */
  function normalizeUrl(input) {
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (!text) return null;
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  }

  /** 空间 id：非空字符串，裁 64 字（真实的空间 id 只有 8 位或 "home"，这里只做形状兜底） */
  function normalizeSpace(input) {
    const text = String(input ?? "").trim();
    if (!text) return null;
    return text.slice(0, 64);
  }

  /** 标题：裁 80 字；空标题用网址的域名兜底（网址也坏就空串） */
  function normalizeTitle(input, url) {
    const text = typeof input === "string" ? input.trim().slice(0, TITLE_LIMIT) : "";
    if (text) return text;
    if (typeof url === "string" && url.trim()) {
      try {
        return (new URL(url.trim()).host || "").slice(0, TITLE_LIMIT);
      } catch {
        /* 网址是坏的：给空串 */
      }
    }
    return "";
  }

  /** by 只认 human / ai，别的按 ai（主程序那边永远传 ai，这里再兜一层） */
  function normalizeBy(input) {
    return input === "human" ? "human" : "ai";
  }

  /** 钉住 id：短随机串。id 只为区分条目，不承担加密责任 */
  function newPinId(randomSource) {
    const random = randomSource || (typeof global.crypto === "object" && global.crypto) || null;
    if (random && typeof random.getRandomValues === "function") {
      const bytes = new Uint8Array(PIN_ID_LENGTH);
      random.getRandomValues(bytes);
      let id = "";
      for (let index = 0; index < PIN_ID_LENGTH; index += 1) {
        id += PIN_ID_ALPHABET[bytes[index] % PIN_ID_ALPHABET.length];
      }
      return id;
    }
    // 没有 crypto 的环境（很老的构建）：退到 Math.random
    let id = "";
    for (let index = 0; index < PIN_ID_LENGTH; index += 1) {
      id += PIN_ID_ALPHABET[Math.floor(Math.random() * PIN_ID_ALPHABET.length)];
    }
    return id;
  }

  /** 从 store 里拿（或补出）spaces 对象：store 本身不动，只保证返回的形状能用 */
  function spacesOf(store) {
    if (!store || typeof store !== "object" || Array.isArray(store)) return {};
    if (!store.spaces || typeof store.spaces !== "object" || Array.isArray(store.spaces)) store.spaces = {};
    return store.spaces;
  }

  /**
   * 把一个钉住条目加进 store（纯函数：直接改传入的 store，返回加进去 / 更新后的条目）。
   * 规则：url 只收 http/https；同一空间同一 url 去重（重复钉只更新标题，id / by / createdAt 不动）；
   * 每个空间最多 PIN_LIMIT 条，满了抛 PIN_LIMIT。
   * @param {object} store 钉住存储 {version, spaces}
   * @param {string} spaceId 空间 id
   * @param {{id?: string, url: string, title?: string, by?: "human"|"ai", createdAt?: number}} pin
   * @returns {object} 存进去的条目（含 id / title / url / by / createdAt）
   */
  function addPinToStore(store, spaceId, pin) {
    const spaces = spacesOf(store);
    const url = normalizeUrl(pin?.url);
    if (!url) throw pinError("INVALID_ARGUMENT", "钉住只收 http / https 网址（javascript:、data:、file: 这类一律不收）");
    const title = normalizeTitle(pin?.title, url);
    const by = normalizeBy(pin?.by);
    const list = spaces[spaceId] || (spaces[spaceId] = []);
    const existing = list.find((item) => item?.url === url);
    if (existing) {
      // 同一网址重复钉：只更新标题
      existing.title = title;
      return existing;
    }
    if (list.length >= PIN_LIMIT) {
      throw pinError("PIN_LIMIT", `这个空间的钉住满了（最多 ${PIN_LIMIT} 个），先删掉不用的再钉`);
    }
    const item = {
      id: typeof pin?.id === "string" && pin.id.trim() ? pin.id.trim().slice(0, 32) : newPinId(),
      title,
      url,
      by,
      createdAt: Number(pin?.createdAt) > 0 ? Number(pin.createdAt) : Date.now(),
    };
    list.push(item);
    return item;
  }

  /** 删掉一个钉住条目（纯函数）。找不到抛 PIN_NOT_FOUND */
  function removePinFromStore(store, spaceId, pinId) {
    const spaces = spacesOf(store);
    const list = spaces[spaceId] || [];
    const index = list.findIndex((item) => item?.id === String(pinId ?? "").trim());
    if (index < 0) throw pinError("PIN_NOT_FOUND", `这个空间里没有这个钉住：${String(pinId ?? "").slice(0, 40)}`);
    return list.splice(index, 1)[0];
  }

  /** 把某个钉住条目挪到指定位置（纯函数）。index 超出范围就收进 0 ~ 末尾；找不到抛 PIN_NOT_FOUND */
  function movePinInStore(store, spaceId, pinId, index) {
    const spaces = spacesOf(store);
    const list = spaces[spaceId] || [];
    const from = list.findIndex((item) => item?.id === String(pinId ?? "").trim());
    if (from < 0) throw pinError("PIN_NOT_FOUND", `这个空间里没有这个钉住：${String(pinId ?? "").slice(0, 40)}`);
    if (list.length < 2) return list.slice();
    const target = Math.max(0, Math.min(Number(index) || 0, list.length - 1));
    const [item] = list.splice(from, 1);
    list.splice(target, 0, item);
    return list.slice();
  }

  /** 某个空间的钉住清单（纯函数）：返回新数组，外面怎么改都碰不到 store */
  function listPinsOfStore(store, spaceId) {
    const spaces = spacesOf(store);
    return Array.isArray(spaces[spaceId]) ? spaces[spaceId].slice() : [];
  }

  /** 清掉某个空间的全部钉住（纯函数）：返回有没有真清掉东西 */
  function clearSpacePins(store, spaceId) {
    const spaces = spacesOf(store);
    const had = Array.isArray(spaces[spaceId]) && spaces[spaceId].length > 0;
    delete spaces[spaceId];
    return had;
  }

  /* ---------------- chrome.storage.local 包装（唯一数据源） ---------------- */

  async function readStore() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      throw pinError("PIN_UNSUPPORTED", "这里没有 chrome.storage.local，钉住存不了");
    }
    const got = await global.chrome.storage.local.get(PINS_KEY);
    const raw = got && got[PINS_KEY];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    return { version: PINS_VERSION, spaces: {} };
  }

  async function writeStore(store) {
    const out = { version: PINS_VERSION, spaces: spacesOf(store) };
    await global.chrome.storage.local.set({ [PINS_KEY]: out });
    return out;
  }

  /** 读写串行：读 → 改 → 写是一条链，两个钉住同时来也不会互相踩掉 */
  let queue = Promise.resolve();
  function withLock(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  /** 把错包成 {ok:false, code, error}：CDP 那边只带得回异常文本，错误码会丢，所以这里不抛 */
  function fail(error) {
    return { ok: false, code: error?.code || "PIN_ERROR", error: error?.message || String(error) };
  }

  /** 某个空间的钉住清单。space 给空间 id；空着按「我的」（home） */
  async function pinList(input = {}) {
    try {
      const space = normalizeSpace(input?.space) || "home";
      const store = await readStore();
      return { ok: true, space, pins: listPinsOfStore(store, space) };
    } catch (error) {
      return fail(error);
    }
  }

  /** 钉一条：{space, url, title?, by}。by 只认 human / ai，主程序那边固定传 ai */
  async function pinAdd(input = {}) {
    try {
      const space = normalizeSpace(input?.space);
      if (!space) throw pinError("INVALID_ARGUMENT", "钉住要给空间 id");
      const result = await withLock(async () => {
        const store = await readStore();
        const pin = addPinToStore(store, space, {
          url: input?.url,
          title: input?.title,
          by: input?.by,
        });
        await writeStore(store);
        return { pin, pins: listPinsOfStore(store, space) };
      });
      return { ok: true, space, pin: result.pin, pins: result.pins };
    } catch (error) {
      return fail(error);
    }
  }

  /** 取消一条：{space, pinId} */
  async function pinRemove(input = {}) {
    try {
      const space = normalizeSpace(input?.space);
      if (!space) throw pinError("INVALID_ARGUMENT", "取消钉住要给空间 id");
      const pinId = String(input?.pinId ?? "").trim();
      if (!pinId) throw pinError("INVALID_ARGUMENT", "取消钉住要给钉住 id");
      const result = await withLock(async () => {
        const store = await readStore();
        const removed = removePinFromStore(store, space, pinId);
        await writeStore(store);
        return { removed, pins: listPinsOfStore(store, space) };
      });
      return { ok: true, space, pinId: result.removed.id, removed: true, pins: result.pins };
    } catch (error) {
      return fail(error);
    }
  }

  /** 挪位置：{space, pinId, index}。index 超出范围收进 0 ~ 末尾 */
  async function pinMove(input = {}) {
    try {
      const space = normalizeSpace(input?.space);
      if (!space) throw pinError("INVALID_ARGUMENT", "挪钉住要给空间 id");
      const pinId = String(input?.pinId ?? "").trim();
      if (!pinId) throw pinError("INVALID_ARGUMENT", "挪钉住要给钉住 id");
      const result = await withLock(async () => {
        const store = await readStore();
        const pins = movePinInStore(store, space, pinId, input?.index);
        await writeStore(store);
        return pins;
      });
      return { ok: true, space, pins: result };
    } catch (error) {
      return fail(error);
    }
  }

  /** 清掉某个空间的全部钉住（space_close 时主程序顺手调） */
  async function pinClear(input = {}) {
    try {
      const space = normalizeSpace(input?.space);
      if (!space) throw pinError("INVALID_ARGUMENT", "清钉住要给空间 id");
      const cleared = await withLock(async () => {
        const store = await readStore();
        const had = clearSpacePins(store, space);
        await writeStore(store);
        return had;
      });
      return { ok: true, space, cleared };
    } catch (error) {
      return fail(error);
    }
  }

  /* ---------------- 挂上去：sw.js 和侧边栏用同一个名字拿 ---------------- */

  global.__windrisePins = {
    PINS_KEY,
    PINS_VERSION,
    PIN_LIMIT,
    TITLE_LIMIT,
    // 纯函数（自测直接测这些）
    isHttpUrl,
    normalizeUrl,
    normalizeSpace,
    normalizeTitle,
    normalizeBy,
    newPinId,
    addPinToStore,
    removePinFromStore,
    movePinInStore,
    listPinsOfStore,
    clearSpacePins,
    // chrome.storage 包装（sw.js 的 __windrise 和侧边栏都调这些）
    pinList,
    pinAdd,
    pinRemove,
    pinMove,
    pinClear,
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
