/**
 * 让 Jev（TypeSafe systemone）在一堆相似元素里挑一个候选。
 *
 * 为什么单独一个文件：候选抽取、领先倍数（ratio）、错误归并全是纯逻辑，
 * 用假 fetch 就能测；src/tools/browser.js 那一层只管拿快照、拼返回。
 *
 * 密钥只从 TYPESAFE_API_KEY 环境变量读，绝不写进日志、返回值或错误信息；
 * 万一上游把密钥回显在正文里，也先抹掉再往外抛。
 */

/** systemone 的问答接口：body 是 { model, state, questions }，一次问一个问题。 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.14.0";
/** criteria 有上限：超出的候选直接截掉，别让请求被拒。 */
export const JEV_MAX_CRITERIA = 255;
/** 候选标签的长度上限（探针脚本验证过这个长度的描述问得准）。 */
export const JEV_LABEL_LIMIT = 160;
const JEV_INSTRUCTIONS = "页面上哪个元素是完成这件事要点击或填写的那一个？";
/** 问不到可用答案（没密钥 / 网络失败 / 返回不可用）统一用这个错误码。 */
export const JEV_UNAVAILABLE = "JEV_UNAVAILABLE";

/** 语义快照里带编号的行，编号形如 e12。 */
const REF_LINE = /\[ref=(e\d+)\]/;

export function jevError(message, { code = JEV_UNAVAILABLE, cause, ...rest } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  Object.assign(error, rest);
  return error;
}

/**
 * 把密钥从任何要往外抛的文字里抹掉。
 * 上游的 HTTP 错误正文、网络错误消息都可能把请求头回显出来。
 */
export function redactKey(text, key) {
  const value = String(text ?? "");
  const secret = String(key ?? "");
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

/**
 * 从快照文本里抽候选：只认带 [ref=eN] 的行。
 *
 * 标签去掉了列表符号和编号，保留 role、无障碍名和合成提示名
 * （`(提示: 添加封面)`），Jev 就是靠这些描述区分的。
 * 同一编号重复出现（find 模式会把祖先行也带出来）只算一次。
 */
export function extractChoices(text, { limit = JEV_MAX_CRITERIA } = {}) {
  const choices = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split("\n")) {
    const match = raw.match(REF_LINE);
    if (!match) continue;
    const ref = match[1];
    if (seen.has(ref)) continue;
    const label = raw
      .trim()
      .replace(/^-\s*/, "")
      .replace(/\s*\[ref=e\d+\]/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, JEV_LABEL_LIMIT);
    if (!label) continue;
    seen.add(ref);
    choices.push({ ref, label });
    if (choices.length >= limit) break;
  }
  return choices;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 从 Jev 的 answers.target 里算第一名、第二名和领先倍数。
 *
 * ratio = 第一名概率 / 第二名概率：第二名概率为 0 时按 1e-6 兜底（和探针脚本一致），
 * 只有一个候选（没有第二名）时 ratio 为 null、decided 为 true —— 没得挑就不算没把握。
 */
export function decideFromAnswer(answer, { minRatio = 3 } = {}) {
  const choice = typeof answer?.choice === "string" ? answer.choice.trim() : "";
  if (!choice) throw jevError("Jev 的返回里没有选中的编号（answers.target.choice 为空），这次结果不可用");
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
  const entries = Object.entries(probabilities).filter(([, p]) => typeof p === "number" && Number.isFinite(p));
  if (!entries.length) throw jevError("Jev 的返回里没有 probabilities，算不出把握程度");
  const confidence = entries.find(([ref]) => ref === choice)?.[1] ?? null;
  const secondEntry = entries.filter(([ref]) => ref !== choice).sort((a, b) => b[1] - a[1])[0] ?? null;
  const ratio = secondEntry && confidence !== null ? round2(confidence / Math.max(secondEntry[1], 1e-6)) : null;
  const decided = ratio === null ? true : ratio >= minRatio;
  return {
    ref: choice,
    confidence,
    ratio,
    second: secondEntry ? { ref: secondEntry[0], p: secondEntry[1] } : null,
    decided,
  };
}

/**
 * 把 intent + 候选发给 Jev，返回原始答案和这次往返耗时。
 *
 * fetchImpl 可注入：单测用假 fetch，绝不访问真实网络。
 * 任何失败都归一成带 code 的错误（默认 JEV_UNAVAILABLE），让上层只处理一种形状。
 */
export async function askJev({
  intent,
  choices,
  state,
  apiKey = process.env.TYPESAFE_API_KEY,
  model = JEV_MODEL,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw jevError("没有配置 TYPESAFE_API_KEY 环境变量，问不了小决策模型 Jev：先用 page_snapshot 自己看快照挑元素");
  }
  const candidates = Array.isArray(choices) ? choices.slice(0, JEV_MAX_CRITERIA) : [];
  if (!candidates.length) {
    throw jevError("没有候选元素可以问：快照里没有带编号的行，先 page_snapshot 看看页面", { code: "NOT_FOUND" });
  }

  const criteria = {};
  for (const choice of candidates) {
    const ref = String(choice?.ref ?? "").trim();
    if (!ref) continue;
    criteria[ref] = String(choice?.label ?? "").replace(/\s+/g, " ").trim().slice(0, JEV_LABEL_LIMIT) || ref;
  }

  const question = {
    model,
    state: String(state ?? `用户想在这个网页上做这件事：${String(intent ?? "").trim()}`).trim(),
    questions: {
      target: { type: "choice", instructions: JEV_INSTRUCTIONS, criteria },
    },
  };

  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(question),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw jevError(`连不上小决策模型 Jev（${redactKey(error?.message ?? error, key)}）：网络不通或超时，先用 page_snapshot 自己看快照挑元素`, { cause: error });
  }
  const latencyMs = Date.now() - startedAt;

  let raw = "";
  try {
    raw = await response.text();
  } catch (error) {
    throw jevError(`读不到 Jev 的返回（${redactKey(error?.message ?? error, key)}）`, { cause: error });
  }
  if (!response.ok) {
    const snippet = redactKey(raw, key).trim().slice(0, 200);
    throw jevError(`Jev 返回 HTTP ${response.status}${snippet ? `：${snippet}` : ""}：先用 page_snapshot 自己看快照挑元素`, { status: response.status });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw jevError(`Jev 的返回不是 JSON（${redactKey(raw, key).trim().slice(0, 200)}）：先用 page_snapshot 自己看快照挑元素`);
  }
  const answer = payload?.answers?.target;
  if (!answer || typeof answer !== "object") {
    throw jevError("Jev 的返回里没有 answers.target：这次没拿到选择结果，先用 page_snapshot 自己看快照挑元素");
  }
  return { answer, model, latencyMs, usage: payload.usage ?? null };
}
