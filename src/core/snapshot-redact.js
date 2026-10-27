/**
 * 快照脱敏的共用规则：语义快照（surface-snapshot.js）和光标扫描合成的提示名（snapshot-cursor.js）
 * 都按这一套判，别各写一份。
 *
 * 这里只做「判断」和「清洗」，不改 AX 树、不发 CDP：脱敏改写仍在 surface-snapshot.js 里。
 */

/** 敏感值统一换成这个固定标记：不带长度，密码框的圆点也一起换掉，免得从字符数猜出密码长度。 */
export const REDACTED = "[已隐藏]";

/** 拉丁词按整词命中：password、pwd、cvc、otp 之类；不再用 pass / ssn / card 这种裸子串。 */
export const SENSITIVE_TOKEN_RE = /^(password|passwd|pwd|pw|pin|cvc|cvv|cvv2|csc|otp|ssn|idcard)$/;
export const SENSITIVE_CARD_TOKEN_RE = /^card(number|no|num|cvc)$/;
export const CARD_FOLLOW_TOKENS = new Set(["number", "no", "num", "cvc"]);
export const CC_FOLLOW_TOKENS = new Set(["number", "no", "num", "csc", "cvv", "cvc", "exp"]);

/** 中文和其他语言没有大小写边界，仍按子串命中。 */
export const SENSITIVE_SUBSTRING_RE = /密码|密碼|口令|安全码|安全碼|交易码|交易碼|支付密码|支付密碼|验证码|驗證碼|校验码|校驗碼|卡号|卡號|身份证|身份證|パスワード|暗証番号|비밀번호|пароль|contraseñ|senha|kennwort|passwort|mot de passe/i;

/** 拉丁词按驼峰 / 下划线 / 横线 / 空格 / 点切成单词，再整词匹配。 */
export function tokenize(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/** 一段文字里有没有敏感词（中文等按子串，拉丁按整词）。 */
export function isSensitiveText(text) {
  const raw = String(text ?? "");
  if (!raw) return false;
  if (SENSITIVE_SUBSTRING_RE.test(raw)) return true;
  const tokens = tokenize(raw);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SENSITIVE_TOKEN_RE.test(token)) return true;
    if (SENSITIVE_CARD_TOKEN_RE.test(token)) return true;
    if (token === "card" && CARD_FOLLOW_TOKENS.has(tokens[index + 1] ?? "")) return true;
    if (token === "cc" && CC_FOLLOW_TOKENS.has(tokens[index + 1] ?? "")) return true;
  }
  return false;
}

/**
 * 光标扫描合成的提示名（`(提示: xxx)`）统一过这一道：
 *   - 命中敏感词（密码、验证码、卡号……）整条丢掉，宁可没有提示，也不给 AI 一个可疑线索；
 *   - 8 位以上连续数字（手机号、卡号、证件号）换成固定标记；
 *   - 只有标记本身、或者只有标点，也丢掉。
 */
export function sanitizeHint(text, maxLength = 40) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (isSensitiveText(raw)) return "";
  const masked = raw.replace(/\d{8,}/g, REDACTED);
  if (!masked || masked === REDACTED) return "";
  if (!/[\p{L}\p{N}]/u.test(masked)) return "";
  return masked.slice(0, maxLength);
}
