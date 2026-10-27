/**
 * Windrise Cookie 导入的共享模块：侧边栏用 <script> 引入；也能被 sw.js 用 importScripts 引，
 * Node 自测（_probe/cookie-import-selftest.mjs）用 vm 加载后直接测里面的纯函数。
 *
 * 只处理「用户自己从浏览器 Cookie 导出插件导出的文件」，不碰浏览器加密数据库、不联网、不上传：
 *   - Netscape cookies.txt：7 列制表符，# 开头是注释，#HttpOnly_ 前缀表示 HttpOnly；
 *   - JSON 数组：Cookie-Editor / EditThisCookie 的导出字段（name、value、domain、path、secure、
 *     httpOnly、sameSite、expirationDate、hostOnly）。
 *
 * 规范化成 chrome.cookies.set 的参数：
 *   - url = (secure ? https : http) + "://" + domain + path；
 *   - sameSite 映射成 no_restriction / lax / strict / unspecified；
 *   - expirationDate 按秒（Chrome / Cookie-Editor 的写法）；过期（<= 现在）跳过；
 *   - session cookie（Netscape 0、JSON session=true 或没有 expirationDate）不带 expirationDate；
 *   - hostOnly 的不传 domain（让浏览器按 URL 主机写 host-only cookie）。
 *
 * 安全规矩：
 *   - 只解析和返回参数，不写日志、不进 chrome.storage、不读页面；
 *   - cookie 值只在返回的 cookies / chrome.cookies.set 参数里，错误信息里会被抹掉；
 *   - 真正写入只在人点了「确认导入」之后由侧边栏调用 importCookies。
 */

(function (global) {
  "use strict";

  /** 单个文件最大 5 MB */
  const FILE_MAX_BYTES = 5 * 1024 * 1024;
  /** 一次最多导入 5000 条 */
  const COOKIE_LIMIT = 5000;
  /** 预览最多列 20 个域名 */
  const DOMAIN_PREVIEW_LIMIT = 20;

  function cookieError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  /** UTF-8 字节数：File.size 是字节，这里对读进来的文本也算同一套（不依赖 TextEncoder） */
  function utf8ByteLength(text) {
    if (typeof text !== "string" || !text) return 0;
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  /** sameSite 只认 Chrome 的四个值；导出插件写成 None / Lax / Strict 也能对回来 */
  function normalizeSameSite(input) {
    const text = String(input ?? "").trim().toLowerCase();
    if (text === "no_restriction" || text === "no-restriction" || text === "none") return "no_restriction";
    if (text === "lax") return "lax";
    if (text === "strict") return "strict";
    return "unspecified";
  }

  /** Cookie 路径：空串按根路径；没写开头的斜杠就补上 */
  function normalizePath(input) {
    let path = typeof input === "string" ? input.trim() : "";
    if (!path) return "/";
    if (!path.startsWith("/")) path = `/${path}`;
    return path;
  }

  /** 域名：小写、去掉开头的点（URL 里不能带）；空串 / 带空白 / 明显不是域名的返回 null */
  function normalizeDomain(input) {
    if (typeof input !== "string") return null;
    let domain = input.trim().toLowerCase();
    while (domain.startsWith(".")) domain = domain.slice(1);
    if (domain.endsWith(".")) domain = domain.slice(0, -1);
    if (!domain) return null;
    if (/\s/.test(domain)) return null;
    if (/[/\\?#@]/.test(domain)) return null;
    return domain;
  }

  /** 由 secure + domain + path 拼 chrome.cookies.set 的 url；拼不出来（坏域名 / 坏路径）返回 null */
  function buildCookieUrl(domainInput, pathInput, secure) {
    const domain = normalizeDomain(domainInput);
    if (!domain) return null;
    const path = normalizePath(pathInput);
    // IPv6 字面量在 URL 里要加方括号；普通域名不受影响
    const host = domain.includes(":") && !domain.startsWith("[") ? `[${domain}]` : domain;
    const url = `${secure === true ? "https" : "http"}://${host}${path}`;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!parsed.hostname) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  /** Cookie 名不能为空，也不能带空白或分隔符 */
  function isValidCookieName(name) {
    return typeof name === "string" && name.length > 0
      && !/[\s;=,]/.test(name)
      && !/[\u0000-\u001f\u007f]/.test(name);
  }

  /**
   * 把一条规范化后的记录变成 chrome.cookies.set 参数。
   * @param {object} record {name, value, domain, path, secure, httpOnly, sameSite, expirationDate, hostOnly}
   * @param {number} nowSeconds 现在（秒）
   * @returns {{params: object, domain: string} | {expired: true, domain: string} | null}
   */
  function toChromeCookie(record, nowSeconds) {
    const now = Number.isFinite(nowSeconds) ? nowSeconds : Date.now() / 1000;
    if (!record || typeof record !== "object") return null;
    if (!isValidCookieName(record.name)) return null;
    if (typeof record.value !== "string") return null;
    const domain = normalizeDomain(record.domain);
    if (!domain) return null;
    const path = normalizePath(record.path);
    const secure = record.secure === true;
    const url = buildCookieUrl(domain, path, secure);
    if (!url) return null;

    const params = {
      url,
      name: record.name,
      value: record.value,
      path,
      secure,
      httpOnly: record.httpOnly === true,
      sameSite: normalizeSameSite(record.sameSite),
    };
    // host-only cookie 不传 domain；只有明确 hostOnly=false 才写 domain（域 cookie，包含子域）
    if (record.hostOnly === false) params.domain = domain;

    const expiration = record.expirationDate;
    if (expiration !== null && expiration !== undefined) {
      const seconds = Number(expiration);
      if (!Number.isFinite(seconds)) return null;
      if (seconds < 0) return { expired: true, domain };
      if (seconds > 0) {
        if (seconds <= now) return { expired: true, domain };
        params.expirationDate = seconds;
      }
    }
    return { params, domain };
  }

  /** JSON 条目 -> 规范化记录；缺字段 / 类型不对返回 null（按坏行计） */
  function jsonRecord(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (!isValidCookieName(item.name)) return null;
    if (typeof item.value !== "string") return null;
    const rawDomain = typeof item.domain === "string" ? item.domain : "";
    const domain = normalizeDomain(rawDomain);
    if (!domain) return null;
    const hostOnly = typeof item.hostOnly === "boolean" ? item.hostOnly : !rawDomain.trim().startsWith(".");
    return {
      name: item.name,
      value: item.value,
      domain,
      path: item.path,
      secure: item.secure === true || item.secure === "TRUE" || item.secure === "true",
      httpOnly: item.httpOnly === true || item.httpOnly === "TRUE" || item.httpOnly === "true",
      sameSite: item.sameSite,
      hostOnly,
      expirationDate: item.session === true ? null : item.expirationDate,
    };
  }

  /** 解析 Netscape cookies.txt（7 列制表符） */
  function parseNetscape(text, stats, nowSeconds) {
    const cookies = [];
    const domains = [];
    const seen = new Set();
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
      if (!rawLine.trim()) continue;
      const leadTrimmed = rawLine.replace(/^[ \t]+/, "");
      let line = rawLine;
      let httpOnly = false;
      if (leadTrimmed.startsWith("#HttpOnly_")) {
        httpOnly = true;
        line = leadTrimmed.slice("#HttpOnly_".length);
      } else if (leadTrimmed.startsWith("#")) {
        continue;
      }

      stats.total += 1;
      const parts = line.split("\t");
      if (parts.length < 7) { stats.badLines += 1; continue; }

      const rawDomain = parts[0];
      const flag = parts[1].trim().toUpperCase();
      const rawPath = parts[2];
      const secureText = parts[3].trim().toUpperCase();
      const expiryText = parts[4].trim();
      const rawName = parts[5];
      const value = parts.slice(6).join("\t");

      if ((flag !== "TRUE" && flag !== "FALSE") || (secureText !== "TRUE" && secureText !== "FALSE")) {
        stats.badLines += 1;
        continue;
      }
      const expires = expiryText === "" ? NaN : Number(expiryText);
      if (!Number.isFinite(expires)) { stats.badLines += 1; continue; }

      const built = toChromeCookie({
        name: rawName,
        value,
        domain: rawDomain,
        path: rawPath,
        secure: secureText === "TRUE",
        httpOnly,
        sameSite: "unspecified",
        hostOnly: flag !== "TRUE" && !rawDomain.trim().startsWith("."),
        expirationDate: expires,
      }, nowSeconds);
      if (!built) { stats.badLines += 1; continue; }
      if (built.expired) { stats.expired += 1; continue; }
      if (cookies.length >= COOKIE_LIMIT) { stats.overLimit += 1; continue; }

      cookies.push(built.params);
      if (!seen.has(built.domain)) {
        seen.add(built.domain);
        domains.push(built.domain);
      }
    }
    return { cookies, domains };
  }

  /** 解析 JSON 数组（Cookie-Editor / EditThisCookie） */
  function parseJson(text, stats, nowSeconds) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: cookieError("COOKIE_FORMAT_INVALID", "JSON 读不出来：不是有效的 JSON 数组") };
    }
    if (!Array.isArray(data)) {
      return { error: cookieError("COOKIE_FORMAT_INVALID", "JSON 导出必须是一个数组（Cookie-Editor / EditThisCookie 的格式）") };
    }
    stats.total = data.length;

    const cookies = [];
    const domains = [];
    const seen = new Set();
    for (const item of data) {
      const record = jsonRecord(item);
      if (!record) { stats.badLines += 1; continue; }
      const built = toChromeCookie(record, nowSeconds);
      if (!built) { stats.badLines += 1; continue; }
      if (built.expired) { stats.expired += 1; continue; }
      if (cookies.length >= COOKIE_LIMIT) { stats.overLimit += 1; continue; }

      cookies.push(built.params);
      if (!seen.has(built.domain)) {
        seen.add(built.domain);
        domains.push(built.domain);
      }
    }
    return { cookies, domains };
  }

  /**
   * 解析一份 Cookie 导出文本（自动辨认 Netscape / JSON）。
   * @param {string} text
   * @returns {{ok: true, format: string, cookies: object[], domains: string[], domainCount: number,
   *   total: number, expired: number, badLines: number, overLimit: number} |
   *   {ok: false, code: string, error: string}}
   */
  function parseCookieText(text) {
    if (typeof text !== "string") {
      return { ok: false, code: "COOKIE_INVALID_ARGUMENT", error: "要导入的内容必须是文本" };
    }
    let source = text;
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
    const bytes = utf8ByteLength(source);
    if (bytes > FILE_MAX_BYTES) {
      return { ok: false, code: "COOKIE_FILE_TOO_LARGE", error: `文件 ${bytes} 字节，超过 5 MB 上限` };
    }

    const stats = { total: 0, badLines: 0, expired: 0, overLimit: 0 };
    const nowSeconds = Date.now() / 1000;
    const trimmed = source.trim();
    if (!trimmed) {
      return { ok: true, format: "netscape", cookies: [], domains: [], domainCount: 0, ...stats };
    }

    let format = "netscape";
    let parsed;
    if (trimmed.startsWith("[")) {
      format = "json";
      parsed = parseJson(source, stats, nowSeconds);
    } else if (trimmed.startsWith("{")) {
      return { ok: false, code: "COOKIE_FORMAT_INVALID", error: "JSON 导出必须是一个数组（Cookie-Editor / EditThisCookie 的格式）" };
    } else {
      parsed = parseNetscape(source, stats, nowSeconds);
    }
    if (parsed.error) {
      return { ok: false, code: parsed.error.code || "COOKIE_FORMAT_INVALID", error: parsed.error.message };
    }

    return {
      ok: true,
      format,
      cookies: parsed.cookies,
      domains: parsed.domains.slice(0, DOMAIN_PREVIEW_LIMIT),
      domainCount: parsed.domains.length,
      total: stats.total,
      expired: stats.expired,
      badLines: stats.badLines,
      overLimit: stats.overLimit,
    };
  }

  function hostOfUrl(url) {
    try {
      return new URL(String(url)).hostname;
    } catch {
      return "";
    }
  }

  /** 错误信息里如果带了 cookie 值，替换掉再返回；结果最多 200 字 */
  function sanitizeError(error, secret) {
    let text = String(error?.message || error || "浏览器拒绝");
    if (secret) text = text.split(secret).join("[值已隐藏]");
    return text.slice(0, 200);
  }

  /**
   * 逐条写入 chrome.cookies.set（只在人确认后调用）。
   * @param {object[]} cookies parseCookieText 返回的 cookies
   * @param {(details: object) => Promise<object|null>} [setCookie] 自测时可注入假实现
   * @returns {Promise<{ok: true, success: number, failed: number, total: number, failures: object[]} |
   *   {ok: false, code: string, error: string}>}
   */
  async function importCookies(cookies, setCookie) {
    if (!Array.isArray(cookies)) {
      return { ok: false, code: "COOKIE_INVALID_ARGUMENT", error: "要导入的 Cookie 必须是数组" };
    }
    if (cookies.length > COOKIE_LIMIT) {
      return { ok: false, code: "COOKIE_LIMIT", error: `一次最多导入 ${COOKIE_LIMIT} 条` };
    }

    let setter = setCookie;
    if (typeof setter !== "function") {
      const api = global.chrome && global.chrome.cookies;
      setter = api && typeof api.set === "function" ? api.set.bind(api) : null;
    }
    if (typeof setter !== "function") {
      return { ok: false, code: "COOKIE_UNSUPPORTED", error: "这个浏览器没有 chrome.cookies.set（缺 cookies 权限或不是插件页面）" };
    }

    let success = 0;
    let failed = 0;
    const failures = [];
    for (const cookie of cookies) {
      const secret = typeof cookie?.value === "string" ? cookie.value : "";
      try {
        const result = await setter(cookie);
        if (result) {
          success += 1;
        } else {
          failed += 1;
          if (failures.length < 20) failures.push({ domain: hostOfUrl(cookie?.url), reason: "浏览器没有写入" });
        }
      } catch (error) {
        failed += 1;
        if (failures.length < 20) failures.push({ domain: hostOfUrl(cookie?.url), reason: sanitizeError(error, secret) });
      }
    }
    return { ok: true, success, failed, total: cookies.length, failures };
  }

  global.__windriseCookieImport = {
    FILE_MAX_BYTES,
    COOKIE_LIMIT,
    DOMAIN_PREVIEW_LIMIT,
    // 纯函数（自测直接测这些）
    utf8ByteLength,
    normalizeSameSite,
    normalizeDomain,
    normalizePath,
    buildCookieUrl,
    toChromeCookie,
    parseCookieText,
    parseCookieFile: parseCookieText,
    // chrome.cookies.set 包装（侧边栏确认后调）
    importCookies,
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
