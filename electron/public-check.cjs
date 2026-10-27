/**
 * 公网实测的判定逻辑 —— 纯函数，不碰 Electron、不发请求。
 *
 * 为什么要单独一个模块：隧道「显示连着」只是本机看到 cloudflared 注册成功，
 * 网卡闪断后上游悄悄死掉时两边都收不到信号（见 docs/research/bridge-disconnect-2026-10-24.md）。
 * 这里只判断「刚才这一次从公网打健康检查」算不算成功，以及连续失败后要不要报警 / 重连；
 * 定时器和 fetch 由 main.cjs 负责，electron/public-check-selftest.cjs 直接跑这里。
 */

/** 刚打通的头 30 秒失败不算数：快速隧道的域名要几秒才生效 */
const GRACE_MS = 30_000;
/** 公网与本机的 uptimeMs 允许差多少（不含这次请求耗时）：差太多说明连到的不是这台电脑 */
const UPTIME_SLACK_MS = 15_000;
/** 连续失败几次才报警 + 自动重连 */
const FAIL_THRESHOLD = 2;
/** 报过警、重连了还是不通：之后每再失败这么多次（30 秒一次，约 3 分钟）再重连一次，不能只试一次就卡在「公网不通」 */
const RETRY_EVERY = 6;
/** 连续多少次「本机网络问题」才记一条 warn（30 秒一次，约 5 分钟） */
const LOCAL_WARN_AFTER = 10;

/**
 * 本机网络问题：电脑现在根本上不了公网（断网、DNS 坏了、代理连不上、网卡刚换）。
 * 这些不是隧道故障 —— 不计数、不报警、不重连，等网络自己恢复。
 * Chromium 的 net::ERR_* 去掉前缀后和 Node 的错误码放在一起比对。
 */
const LOCAL_NETWORK_CODES = [
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_NETWORK_CHANGED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_ADDRESS_INVALID",
  "ERR_NETWORK_ACCESS_DENIED",
  "ERR_CONNECTION_REFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
];

/** main.cjs 与界面共享的状态形状（不要把令牌或完整 URL 放进来） */
function newPublicCheck() {
  return { ok: null, at: 0, lastOkAt: 0, failures: 0, lastError: null, latencyMs: null };
}

/** 把公网 MCP 地址换成健康检查地址：/mcp/<令牌> → /healthz/<令牌>（写法同 probeExternal） */
function healthTarget(publicMcpUrl) {
  let target;
  try { target = new URL(publicMcpUrl); } catch { return null; }
  if (!target.pathname.startsWith("/mcp/")) return null;
  target.pathname = target.pathname.replace(/^\/mcp\//, "/healthz/");
  target.search = "";
  return target;
}

/** 日志和错误里只写域名，绝不写带令牌的完整地址 */
function publicHost(publicMcpUrl) {
  try { return new URL(publicMcpUrl).host; } catch { return ""; }
}

/** 连续失败时的 warn 文字（放这里方便自测：调用方只传域名，不传完整地址） */
function alarmMessage({ failures = FAIL_THRESHOLD, error = "公网访问不到桥", host = "" } = {}) {
  return `隧道显示连着，但公网连续 ${failures} 次访问不到桥（原因：${error}${host ? `，地址 ${host}` : ""}），自动重连隧道`;
}

/**
 * 界面状态的覆盖（纯函数）：连续失败达到阈值时该显示什么。
 * 重连成功、等下一次实测的这段显示「连接中」；验证过还失败才说「公网不通」，
 * 不再写「正在自动重连」（那之后要等约 3 分钟才会再重连）。
 * 没到阈值返回 null，由调用方照常显示 connected。
 */
function publicStatusOverride({ failures = 0, verifying = false, threshold = FAIL_THRESHOLD } = {}) {
  if (failures < threshold) return null;
  if (verifying) return { level: "connecting", label: "连接中", detail: "已重连，正在验证公网…" };
  return {
    level: "error",
    label: "公网不通",
    error: `隧道显示连着，但从公网访问不到桥（已连续 ${failures} 次），会自动重连`,
  };
}

/**
 * 这次实测能不能当「重连后的验证做过了」（纯函数）：成功、或计了数的失败才算。
 * 宽限期里的失败、本机网络问题、以及「桥正在启动」的 503 都不涨失败次数，
 * 算了的话会在新隧道刚打通的几秒里误显示「公网不通」。
 */
function settlesVerification(outcome, result) {
  if (outcome?.state?.ok) return true;
  if (result?.kind === "local-network" || result?.kind === "warming") return false;
  return !outcome?.withinGrace;
}

/** 从 net.fetch / fetch 抛出的错误里抠出错误码（Chromium 是 net::ERR_…，Node 是 ENOTFOUND 这类） */
function probeErrorCode(error) {
  if (!error) return null;
  const parts = [];
  for (const value of [error.code, error.name, error.message, error.cause?.code, error.cause?.name, error.cause?.message]) {
    if (value) parts.push(String(value));
  }
  // 有些实现抛的是字符串，或者把 net::ERR_… 放在 cause 字符串里
  if (typeof error === "string") parts.push(error);
  if (typeof error?.cause === "string") parts.push(error.cause);
  const text = parts.join(" ");
  const netCode = /net::(ERR_[A-Z0-9_]+)/.exec(text);
  if (netCode) return `net::${netCode[1]}`;
  for (const code of LOCAL_NETWORK_CODES) {
    if (/^ERR_/.test(code)) continue;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${code}([^A-Za-z0-9_]|$)`);
    if (pattern.test(text)) return code;
  }
  return error.code ? String(error.code) : (error.name ? String(error.name) : null);
}

/** 这个错误码是不是「本机现在上不了公网」（不是隧道 / 服务端故障） */
function isLocalNetworkCode(code) {
  if (!code) return false;
  return LOCAL_NETWORK_CODES.includes(String(code).replace(/^net::/, ""));
}

/** 本机网络问题的 lastError：说清楚不算隧道故障，界面不会因此显示「公网不通」 */
function localNetworkMessage(code) {
  return `这台电脑现在访问不到公网（${code || "网络错误"}），不算隧道故障`;
}

/**
 * 把一次请求异常分成三类（纯函数，方便自测）：
 *   local-network 本机网络问题 → 不计数、不重连，只单独累计
 *   timeout       请求超时     → 隧道层故障，照常计数
 *   tunnel        其它请求失败 → 隧道层故障，照常计数
 * timedOut 由调用方自己控制超时（AbortController）时传入：net.fetch 被中止后的
 * 错误形状不稳定（AbortError / net::ERR_ABORTED / TypeError），不能只靠错误对象判断。
 *
 * 注意：这只是「对照都不用打」的快速判断。名单外的错误（连接被重置、TLS 出错……）
 * 不能仅凭这里就当成隧道故障，调用方要拿到对照结果后用 judgeWithControl 再判。
 */
function classifyProbeError(error, { timedOut = false, timeoutMs = 8000 } = {}) {
  const code = probeErrorCode(error);
  if (timedOut) {
    return { ok: false, kind: "timeout", code, error: `请求超时（${Math.round(timeoutMs / 1000)} 秒）` };
  }
  if (isLocalNetworkCode(code)) {
    return { ok: false, kind: "local-network", code, error: localNetworkMessage(code) };
  }
  return { ok: false, kind: "tunnel", code, error: `请求失败（${code || "网络错误"}）` };
}

/**
 * 对照地址：同一个公网域名的 /cdn-cgi/trace。这个地址由 Cloudflare 边缘直接回，不进隧道。
 * 只保留域名和固定路径，绝不带令牌 / MCP 路径 / 查询串（日志和错误里也只写域名）。
 */
function controlTarget(publicMcpUrl) {
  let source;
  try { source = new URL(publicMcpUrl); } catch { return null; }
  if (!source.hostname) return null;
  try { return new URL("/cdn-cgi/trace", source.origin); } catch { return null; }
}

/**
 * 拿不到 HTTP 响应时的判定（纯函数）：
 *   probeError / timedOut 这次探测为什么没拿到响应；
 *   control               对照请求的结果 { ok, error }，由调用方用同一个 net.fetch 发。
 * 对照成功 = Cloudflare 边缘能访问，说明是本机到隧道的这段出了问题 → 按隧道故障计数；
 * 对照也失败 = 这台电脑现在上不了 Cloudflare → 本机网络问题，不计数、不重连。
 * 白名单里的错误（断网 / DNS 解析不了）不用对照就是本机问题，省一次请求。
 */
function judgeWithControl({ probeError = null, timedOut = false, control = null, timeoutMs = 8000 } = {}) {
  const code = probeErrorCode(probeError);
  const reason = timedOut ? `请求超时 ${Math.round(timeoutMs / 1000)} 秒` : (code || "网络错误");
  if (!timedOut && isLocalNetworkCode(code)) {
    return { ok: false, kind: "local-network", code, control: "not-needed", error: localNetworkMessage(code) };
  }
  if (control?.ok) {
    return {
      ok: false,
      kind: "tunnel",
      code,
      control: "ok",
      error: `Cloudflare 能访问，但隧道没把请求送到桥（原因：${reason}）`,
    };
  }
  return {
    ok: false,
    kind: "local-network",
    code,
    control: "failed",
    controlCode: probeErrorCode(control?.error),
    error: `这台电脑现在访问不到 Cloudflare（${reason}），不算隧道故障`,
  };
}

/**
 * 这次该不该探测：重连中的隧道（tunnel.status().reconnecting，另一个任务加的字段；
 * 没有这个字段时按 false）和公网实测自己的自动重连期间都不探、不计数，
 * 免得把「正在重连」误判成又失败一次、触发新的重连。
 */
function probeDue({ publicMcpUrl = null, busy = false, reconnecting = false, tunnelReconnecting = false } = {}) {
  return Boolean(publicMcpUrl) && !busy && !reconnecting && !tunnelReconnecting;
}

/**
 * 判定一次探测结果。
 * 成功 = HTTP 200 + JSON 的 ok 为 true + 返回的 uptimeMs 与本机相差不超过「请求耗时 + 15 秒」。
 * 最后一条是为了防「公网地址连到了别的实例」：那种情况下 HTTP 也可能是 200、ok 也可能为 true。
 *
 * 503 是「桥正在启动」的信号（remoteGate 在隧道状态还没定下来时回 503 + Retry-After）：
 * 这不是「公网访问不到桥」，不能计数、更不能触发重连隧道，否则重启后会自己把自己重连一遍。
 */
function judgeProbe({ status, body, localUptimeMs, latencyMs, retryAfter = null } = {}) {
  const elapsed = Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null;
  if (status === 503) {
    return {
      ok: false,
      kind: "warming",
      retryAfter,
      error: retryAfter ? `桥正在启动（HTTP 503，建议 ${retryAfter} 秒后重试）` : "桥正在启动（HTTP 503）",
      latencyMs: elapsed,
    };
  }
  if (status !== 200) {
    return { ok: false, error: status == null ? "没有拿到 HTTP 状态" : `公网返回 HTTP ${status}`, latencyMs: elapsed };
  }
  if (!body || typeof body !== "object" || body.ok !== true) {
    return { ok: false, error: "公网返回的不是正常的健康检查（ok 不是 true）", latencyMs: elapsed };
  }
  const remoteUptime = Number(body.uptimeMs);
  const localUptime = Number(localUptimeMs);
  if (!Number.isFinite(remoteUptime) || !Number.isFinite(localUptime)) {
    return { ok: false, error: "健康检查没带 uptimeMs，没法确认是不是这台电脑上的桥", latencyMs: elapsed };
  }
  const allowedGapMs = Math.max(0, elapsed ?? 0) + UPTIME_SLACK_MS;
  const uptimeGapMs = Math.abs(remoteUptime - localUptime);
  if (uptimeGapMs > allowedGapMs) {
    return {
      ok: false,
      error: `公网返回的运行时长与本机相差 ${Math.round(uptimeGapMs / 1000)} 秒，可能连到了别的实例`,
      latencyMs: elapsed,
      uptimeGapMs,
      allowedGapMs,
    };
  }
  return { ok: true, error: null, latencyMs: elapsed, uptimeGapMs, allowedGapMs };
}

/**
 * 状态机的一步（纯函数）：输入上一次状态和这一次探测结果，输出新状态与动作。
 *   alarm        这次失败刚好达到阈值、且之前没报过 → 调用方记 warn 并重连一次
 *   recovered    之前报过警 / 连续失败过，这次成功 → 调用方记一条「恢复正常」
 *   localAlarm   连续 LOCAL_WARN_AFTER 次本机网络问题 → 调用方记一条 warn（只记一次）
 * 宽限期内失败只更新 ok / lastError，不加 failures，也不报警。
 * 本机网络问题（result.kind === "local-network"）单独累计 localFailures：
 * 不动 failures、不报警、不重连；成功或重新摸到公网（隧道层失败）后清零。
 */
function applyProbe(previous, result, {
  at = Date.now(),
  connectedAt = 0,
  graceMs = GRACE_MS,
  threshold = FAIL_THRESHOLD,
  retryEvery = RETRY_EVERY,
  alerted = false,
  localFailures = 0,
  localAlerted = false,
  localWarnAfter = LOCAL_WARN_AFTER,
} = {}) {
  const base = { ...newPublicCheck(), ...(previous ?? {}) };
  const state = { ...base, at, latencyMs: Number.isFinite(Number(result?.latencyMs)) ? Number(result.latencyMs) : base.latencyMs };
  const localCount = Math.max(0, Number(localFailures) || 0);

  if (result?.kind === "warming") {
    /*
     * 桥正在启动（HTTP 503 + Retry-After）：既不算成功也不算隧道故障。
     * 不动 failures、不报警、不重连，只把原因写到 lastError，界面能看出「在等桥起来」。
     * ok 保持原值：刚打通还没测通过时仍是 null，不会因为一次 503 变成「公网不通」。
     */
    return {
      state: { ...state, lastError: result.error || "桥正在启动" },
      alarm: false,
      reconnect: false,
      recovered: false,
      withinGrace: false,
      alerted: Boolean(alerted),
      localFailures: localCount,
      localAlarm: false,
      localAlerted: Boolean(localAlerted),
    };
  }

  if (result?.kind === "local-network") {
    const error = result?.error || localNetworkMessage(result?.code);
    const failures = localCount + 1;
    const localAlarm = failures >= localWarnAfter && !localAlerted;
    return {
      state: { ...state, ok: false, lastError: error },
      alarm: false,
      reconnect: false,
      recovered: false,
      withinGrace: false,
      alerted: Boolean(alerted),
      localFailures: failures,
      localAlarm,
      localAlerted: Boolean(localAlerted) || localAlarm,
    };
  }

  if (result?.ok) {
    return {
      state: { ...state, ok: true, lastOkAt: at, failures: 0, lastError: null },
      alarm: false,
      reconnect: false,
      recovered: Boolean(alerted) || base.failures >= threshold || Boolean(localAlerted),
      withinGrace: false,
      alerted: false,
      localFailures: 0,
      localAlarm: false,
      localAlerted: false,
    };
  }

  const error = result?.error || "公网访问不到桥";
  const withinGrace = Number.isFinite(connectedAt) && connectedAt > 0 && at - connectedAt < graceMs;
  const failures = withinGrace ? base.failures : base.failures + 1;
  // 第一次到阈值报警；报过以后仍不通，每再失败 retryEvery 次重试一次（宽限期里失败次数不涨，也就不会重试）
  const retry = alerted && !withinGrace && failures > threshold && (failures - threshold) % retryEvery === 0;
  const alarm = failures >= threshold && (!alerted || retry);
  return {
    state: { ...state, ok: false, failures, lastError: error },
    alarm,
    reconnect: alarm,
    recovered: false,
    withinGrace,
    alerted: Boolean(alerted) || alarm,
    // 能拿到隧道层响应 / 超时，说明本机网络是通的：本机网络问题的连续计数就此打断
    localFailures: 0,
    localAlarm: false,
    localAlerted: false,
  };
}

/**
 * 有内部 alerted 记忆的状态机（alerted 不算进对外状态，避免界面看到多余字段）。
 * main.cjs 每次探测把结果 push() 进来即可。
 */
function createPublicCheck() {
  let state = newPublicCheck();
  let alerted = false;
  let localFailures = 0;
  let localAlerted = false;
  return {
    get state() { return { ...state }; },
    get alerted() { return alerted; },
    get localFailures() { return localFailures; },
    get localAlerted() { return localAlerted; },
    push(result, options = {}) {
      const outcome = applyProbe(state, result, { ...options, alerted, localFailures, localAlerted });
      state = outcome.state;
      alerted = outcome.alerted;
      localFailures = outcome.localFailures;
      localAlerted = outcome.localAlerted;
      return {
        state: { ...state },
        alarm: outcome.alarm,
        reconnect: outcome.reconnect,
        recovered: outcome.recovered,
        withinGrace: outcome.withinGrace,
        localAlarm: outcome.localAlarm,
        localFailures: outcome.localFailures,
      };
    },
    reset() { state = newPublicCheck(); alerted = false; localFailures = 0; localAlerted = false; },
  };
}

module.exports = {
  GRACE_MS,
  UPTIME_SLACK_MS,
  FAIL_THRESHOLD,
  RETRY_EVERY,
  LOCAL_WARN_AFTER,
  LOCAL_NETWORK_CODES,
  newPublicCheck,
  healthTarget,
  publicHost,
  alarmMessage,
  publicStatusOverride,
  settlesVerification,
  probeErrorCode,
  isLocalNetworkCode,
  localNetworkMessage,
  classifyProbeError,
  controlTarget,
  judgeWithControl,
  probeDue,
  judgeProbe,
  applyProbe,
  createPublicCheck,
};
