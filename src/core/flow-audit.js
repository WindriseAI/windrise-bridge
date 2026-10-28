/**
 * flow_replay 审计 → 调用日志（logs/flow-replay/）的记录映射。
 *
 * 生产里重放审计只有 logStep 一个出口，以前只放行 event === "step"，结果：
 *   - 开跑前的拒绝（越界域名 / 没分到格子 / confirmStep 错位 / fromStep 越界 / 缺变量）一条都不落盘；
 *   - 整轮结论（end）也从来没写过，事后只能靠逐条 step 猜。
 * 这里把 step / refused / end 三种事件都映射成日志记录；start 仍然是汇总事件，不重复写。
 *
 * 硬规则：不记任何输入值、密码、secret。step 只记步骤号 / 动作 / 按键 / 目标名 / 四态；
 * refused 只记原因（拒绝原因里本来就只有变量名 / 域名 / 步骤号，没有变量值）；end 只记汇总数字。
 */

const FLOW_SESSION = "flow_replay";

/**
 * @param {object} entry replayDraft 送进 audit 回调的条目
 * @returns {object|null} createCallLog.record 认的记录；不认识的事件返回 null（不写）
 */
export function flowAuditRecord(entry = {}) {
  const event = entry?.event;
  const base = {
    sessionId: FLOW_SESSION,
    client: { name: FLOW_SESSION, version: "1" },
    tool: "flow_replay",
  };

  if (event === "refused") {
    const reason = typeof entry.reason === "string" ? entry.reason : "";
    return {
      ...base,
      args: { event: "refused", reason },
      ok: false,
      code: "REFUSED",
      reason,
    };
  }

  if (event === "end") {
    return {
      ...base,
      args: {
        event: "end",
        status: entry.status ?? null,
        completed: Number.isFinite(Number(entry.completed)) ? Number(entry.completed) : 0,
        dispatched: Number.isFinite(Number(entry.dispatched)) ? Number(entry.dispatched) : 0,
      },
      // 只有整轮真的每步都读回确认才算成功；partial / noop / uncertain 一律不算
      ok: entry.status === "success",
      code: entry.status ?? null,
    };
  }

  if (event !== "step") return null;

  // 审计按真实情况填：只有 success / dispatched 才算 ok，提交边界用回放自己的判定结果
  const ok = entry.status === "success" || entry.status === "dispatched";
  return {
    ...base,
    args: {
      event: "step",
      step: entry.step ?? null,
      // 动作名和按键必须进日志：事后要分得清「点击」和「回车提交」
      action: entry.action ?? null,
      key: entry.key ?? null,
    },
    ok,
    code: entry.status ?? null,
    action: {
      actionClass: entry.actionClass ?? "MUTATING",
      outcome: entry.status ?? null,
      target: entry.target ?? null,
      commitBoundary: entry.commitBoundary === true,
    },
  };
}

/**
 * 生产用的 logStep：把审计条目交给 createCallLog 落盘。
 * 返回的函数带 flush()，方便测试等日志真的写完再读文件（生产路径不需要等）。
 *
 * pending 只放「还没写完」的那几条：桌面上是长驻进程，每条都留着不清理，重放次数一多就是无界增长
 * （每个已解决的 Promise 及其闭包都被数组引用着）。写完立刻从数组里摘掉。
 */
export function createFlowStepLogger({ callLog } = {}) {
  if (!callLog || typeof callLog.record !== "function") throw new Error("createFlowStepLogger 需要 callLog.record");
  const pending = new Set();
  const logStep = (entry = {}) => {
    const record = flowAuditRecord(entry);
    if (!record) return;
    const task = Promise.resolve(callLog.record(record)).catch(() => {}).finally(() => {
      pending.delete(task);
    });
    pending.add(task);
  };
  logStep.flush = async () => {
    // 写完的会自己摘掉；这里等的是调用这一刻还在途的那些（等的过程中不可能再新增）
    await Promise.all([...pending]);
    pending.clear();
  };
  /** 在途条数（测试用：确认pending没有只增不减）。 */
  logStep.pendingCount = () => pending.size;
  return logStep;
}
