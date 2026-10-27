/**
 * AI 禁区：哪些页面只许人操作（规划隐私方案 WP-03，2026-10-24 起）。
 *
 * 职责：给一个网址判「AI 能不能碰」。命中的页面上，AI 的快照、读正文、点击、输入、截图、执行脚本一律拒绝，
 *       也不新挂调试器；已经挂着的，页面一跳进来就摘掉。离开（后退、跳到别的网址、关窗口）照常放行。
 * 不负责：网址能不能打开（url-guard.cjs）。
 *
 * 为什么有这一层：
 *   - 账号登录页上有密码、验证码、短信码，AI 看不到也就填不了，从根上挡住「AI 替人登录」；
 *     用户的硬性要求是 Claude 只能本人登录，这里不靠自觉，软件直接不让 AI 动；
 *   - Google 明文规定不允许带自动化的浏览器碰它的登录流程。
 * 拒绝时的错误码 SIGNIN_PAGE_HUMAN_ONLY 同时就是「需要人来登录」的交接信号。
 *
 * 对外说法要照实：这一层只管经浏览器工具（page_*、browser_*）的访问。主令牌还能跑命令，挡不住；
 * 受限连接器只能用浏览器工具，对它才成立。
 */

/** 只许人操作的登录页：整个主机，或主机 + 路径前缀 */
const HUMAN_ONLY = [
  { host: "accounts.google.com", label: "Google 账号登录页" },
  { host: "claude.ai", paths: ["/login", "/magic-link", "/oauth"], label: "Claude 登录页" },
  { host: "auth.openai.com", label: "ChatGPT 登录页" },
  { host: "chatgpt.com", paths: ["/auth/", "/log-in"], label: "ChatGPT 登录页" },
  { host: "chat.deepseek.com", paths: ["/sign_in", "/sign_up"], label: "DeepSeek 登录页" },
];

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * @param {string} url
 * @returns {null | { code: "SIGNIN_PAGE_HUMAN_ONLY", label: string, host: string, message: string }}
 */
function checkAiAccess(url) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  for (const rule of HUMAN_ONLY) {
    if (host !== rule.host) continue;
    if (rule.paths && !rule.paths.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix))) continue;
    return {
      code: "SIGNIN_PAGE_HUMAN_ONLY",
      label: rule.label,
      host,
      message: `这是${rule.label}，只能由人自己登录，AI 不能看也不能操作。请告诉用户在这个窗口里自己登录（优先用邮箱或手机号，不要用 Google 账号），登好后再继续；或者后退离开这个页面`,
    };
  }
  return null;
}

/** 命中就抛错（带 code），没命中什么都不做 */
function assertAiAllowed(url) {
  const hit = checkAiAccess(url);
  if (hit) throw codedError(hit.code, hit.message, { label: hit.label });
}

module.exports = { checkAiAccess, assertAiAllowed, HUMAN_ONLY };
