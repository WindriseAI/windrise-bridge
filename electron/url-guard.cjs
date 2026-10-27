/**
 * 账号窗口能打开哪些网址（规划隐私方案 WP-16）。
 *
 * 职责：所有「由主进程替网页打开网址」的入口（AI 工具、账号起始地址、复用窗口）只放行 http / https，
 *       外加 about:blank。
 * 不负责：哪些网站不让 AI 碰（ai-site-guard.cjs）。
 *
 * 为什么入口必须先拦（2026-10-24 实测）：
 *   - 主进程 wc.loadURL("file:///C:/…") 能把本机文件读进账号窗口，再被快照读走，连接器隔离等于没有；
 *   - wc.loadURL("javascript:…") 会直接在当前页面里执行脚本，loadURL 报 ERR_FAILED 但脚本已经跑完，
 *     而且不触发任何导航事件——绕过了 eval 开关，导航兜底也拦不住，只能在入口拦。
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 校验并规范化一个要在账号窗口里打开的网址。
 * 没写协议的（例如 example.com）按 https 补全；空串原样返回（调用方用默认地址）。
 * @param {string} input
 * @param {{ allowBlank?: boolean }} [options]  about:blank 默认放行（新建账号的默认起始页就是它）
 * @returns {string}
 */
function checkSiteUrl(input, { allowBlank = true } = {}) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (allowBlank && /^about:blank$/i.test(text)) return "about:blank";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw codedError("URL_NOT_ALLOWED", `网址写得不对：${text.slice(0, 80)}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw codedError("URL_NOT_ALLOWED", `账号窗口只能打开 http / https 网址，不能打开 ${parsed.protocol} 开头的地址`);
  }
  return parsed.href;
}

module.exports = { checkSiteUrl };
