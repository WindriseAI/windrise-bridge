/**
 * 账号代理串：保存前校验、规范化（规划隐私方案 WP-09，按对抗审查第 5、8 条更正）。
 *
 * BrowserOS 启动时用这里规范化后的串拼 `--proxy-server`，再由自带插件核对实际生效的规则。
 * 只接受单个代理，配错就不开，不静默直连：
 *   - socks5://主机:端口、socks://（规范成 socks5://）、http://、https://、裸 主机:端口（按 HTTP）
 *   - 拒绝：列表 / 按协议分配、direct://、socks4://、socks5h://、带账号密码、PAC 写法
 */

const SCHEME_LABEL = {
  socks5: "SOCKS5",
  socks: "SOCKS5",
  http: "PROXY",
  https: "HTTPS",
};

function invalid(error) {
  return { ok: false, normalized: "", expect: "", error };
}

function proxyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 纯函数：解析用户填的代理串。
 * @param {string} str
 * @returns {{ ok: boolean, normalized: string, expect: string, error: string }}
 *   ok 为真时：normalized 是要存下来、交给 setProxy 的串；expect 是 resolveProxy 应该返回的整串。
 */
function parseProxyRule(str) {
  const raw = String(str ?? "").trim();
  if (!raw) return invalid("请填写代理地址；留空表示不用代理");

  // 列表 / 按协议分配：Chromium 会把它们拆成多个代理，甚至加 DIRECT 兜底
  if (/[;,=]/.test(raw)) return invalid("只支持填一个代理：请不要用 ; 、 , 或 = 分隔多个代理地址");

  if (/^direct:\/\//i.test(raw)) return invalid("不允许直连回退：请只填一个代理地址，不要带 direct://");
  if (/^socks4a?:\/\//i.test(raw)) return invalid("socks4 会在本机解析域名，会泄露你访问的网站；请改用 socks5://主机:端口");
  if (/^socks5h:\/\//i.test(raw)) return invalid("请直接写成 socks5://主机:端口，Windrise 本来就让代理解析域名");

  // PAC 写法：PROXY 1.2.3.4:80、SOCKS 1.2.3.4:1080、HTTPS ...（后面带空格的那种）
  if (/^(proxy|socks|socks4|socks5|https?|direct)\s+/i.test(raw)) {
    return invalid("不支持 PAC 写法：请只填一个代理地址，例如 socks5://127.0.0.1:1080");
  }

  // 账号密码：Chromium 的 SOCKS5 不支持认证，HTTP 认证也还没接（WP-12）
  if (raw.includes("@")) return invalid("暂不支持带账号密码的代理：请先在代理软件里去掉认证，或等后续版本支持");

  let scheme = "http";
  let rest = raw;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SCHEME_LABEL, scheme)) {
      return invalid("只支持 socks5://、socks://、http://、https://，或直接填 主机:端口");
    }
    rest = raw.slice(schemeMatch[0].length);
  } else if (raw.startsWith("//")) {
    return invalid("代理地址要写成 主机:端口（例如 127.0.0.1:1080）或 协议://主机:端口");
  }

  // 路径、参数、空白一律拒绝：代理只认主机和端口
  if (/[/?#\s]/.test(rest)) return invalid("代理地址后面不要带路径、参数或空格，只填 协议://主机:端口");

  const hostPort = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+)):(\d{1,5})$/i.exec(rest);
  if (!hostPort) return invalid("代理地址要写成 主机:端口（例如 127.0.0.1:1080）或 协议://主机:端口");

  const port = Number(hostPort[3]);
  if (!(port >= 1 && port <= 65535)) return invalid("端口要在 1 到 65535 之间");
  if (hostPort[2]) {
    const rawHost = hostPort[2];
    if (!rawHost || rawHost.startsWith(".") || rawHost.endsWith(".") || rawHost.includes("..")) {
      return invalid("代理主机名不对：请填 IP 或域名，例如 127.0.0.1:1080");
    }
  }

  // 用 WHATWG URL 按 Chromium 的方式规范化主机：127.1 → 127.0.0.1、0x7f.0.0.1 → 127.0.0.1、
  // [0:0::1] → [::1]、[::FFFF:127.0.0.1] → [::ffff:7f00:1]。不规范化的话，浏览器实际用的代理串
  // 会和这里存下来的写法对不上。
  let canonical;
  try {
    canonical = new URL(`http://${rest}`);
  } catch {
    return invalid("代理地址要写成 主机:端口（例如 127.0.0.1:1080）或 协议://主机:端口");
  }
  // 端口用上面已经校验过的 port：WHATWG URL 会把 :80 这种默认端口从 canonical.port 里去掉，
  // 直接看 canonical.port 会把所有企业常用的 :80 代理判成「没写端口」。
  if (!canonical.hostname) {
    return invalid("代理地址要写成 主机:端口（例如 127.0.0.1:1080）或 协议://主机:端口");
  }
  if (canonical.username || canonical.password) {
    return invalid("暂不支持带账号密码的代理：请先在代理软件里去掉认证，或等后续版本支持");
  }
  if (canonical.pathname !== "/" || canonical.search || canonical.hash) {
    return invalid("代理地址后面不要带路径、参数或空格，只填 协议://主机:端口");
  }

  // canonical.hostname 保留 IPv6 的 [ ]，port 是数字（前导零已被吃掉），正好和 Chromium 的返回串一致
  const normalizedScheme = scheme === "socks" ? "socks5" : scheme;
  const normalized = `${normalizedScheme}://${canonical.hostname}:${port}`;
  const expect = `${SCHEME_LABEL[scheme]} ${canonical.hostname}:${port}`;
  return { ok: true, normalized, expect, error: "" };
}

/**
 * 保存账号（新建 / 修改）前检查代理串。不合规时抛错，错误信息直接给用户看。
 * @param {string} proxy  用户填的代理串，可能为空
 * @returns {string} 规范化以后要存下来的代理串（空串表示不用代理）
 */
function checkProxyForSave(proxy) {
  const raw = String(proxy ?? "").trim();
  if (!raw) return "";
  const rule = parseProxyRule(raw);
  if (!rule.ok) throw proxyError(rule.error, "PROXY_INVALID");
  return rule.normalized;
}

module.exports = { parseProxyRule, checkProxyForSave };
