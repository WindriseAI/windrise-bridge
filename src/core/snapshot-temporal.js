/**
 * 快照里的时间 / 日期值：`input[type=time]`（以及 date / datetime-local / month / week）的当前值只在
 * 宿主的 DOM property 里，无障碍树只给出 shadow 里的小时 / 分钟两个 spinbutton，值一个都看不到。
 *
 * 这里在页面里一次性扫一遍时间类输入框，返回「元素对象 ID → { type, value }」。
 * 对象 ID 在快照层用 DOM.describeNode 换成 backendNodeId；render 再把它写到对应元素行上：
 *   - 宿主 input 自己那一行（如果有）：`[value="12:30"]`；
 *   - 宿主不在无障碍树里（时间框只有两个分段）：追加一行 `- time-value "Preferred delivery time:" [value="12:30"]`。
 *
 * 结果参与 diff：值变了，页面就算「有变化」，不再报「页面没有变化」。
 */

/** 收集页面里所有时间类输入框。返回 Map<objectId, { type, value }>；拿不到就是空表（尽力而为）。 */
export async function findTemporalValues(session, { frameId, max = 100 } = {}) {
  const values = new Map();
  let contextId;
  if (frameId !== undefined) {
    try {
      const world = await session.Page.createIsolatedWorld({ frameId, worldName: "windrise-temporal-scan" });
      contextId = world?.executionContextId;
    } catch {
      contextId = undefined;
    }
    if (contextId === undefined) return values;
  }
  const expression = `(() => {
    const TEMPORAL = ["date", "time", "datetime-local", "month", "week"];
    const found = [];
    const nameOf = (element) => {
      const labels = [];
      try {
        for (const label of (element.labels ? Array.from(element.labels) : [])) {
          const text = String(label && label.textContent || "").trim();
          if (text) labels.push(text);
        }
      } catch (error) { /* <label> 关联取不到就退到属性 */ }
      const chosen = labels.join(" ") || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("name") || element.id || "";
      return String(chosen || "").trim();
    };
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const element of all) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (String(element.tagName || "") !== "INPUT") continue;
        const type = String(element.type || "").toLowerCase();
        if (!TEMPORAL.includes(type)) continue;
        found.push(element);
        if (found.length >= ${Number(max)}) break;
      }
    }
    return { nodes: found, meta: found.map((element) => ({ type: String(element.type || "").toLowerCase(), value: String(element.value ?? ""), name: nameOf(element) })) };
  })()`;
  let resultObjectId;
  try {
    const evaluated = await session.Runtime.evaluate({
      expression,
      returnByValue: false,
      awaitPromise: false,
      ...(contextId === undefined ? {} : { contextId }),
    });
    resultObjectId = evaluated.result?.objectId;
  } catch {
    return values;
  }
  if (!resultObjectId) return values;
  const release = [];
  try {
    const roots = await session.Runtime.getProperties({ objectId: resultObjectId, ownProperties: true, generatePreview: false });
    const nodesObjectId = roots.result?.find((property) => property.name === "nodes")?.value?.objectId;
    const metaObjectId = roots.result?.find((property) => property.name === "meta")?.value?.objectId;
    if (!nodesObjectId || !metaObjectId) return values;
    release.push(nodesObjectId, metaObjectId);
    // 同光标扫描：两条读命令串行，避免并发时浏览器只完成一条、表和元数据错位
    const nodeProps = await session.Runtime.getProperties({ objectId: nodesObjectId, ownProperties: true, generatePreview: false });
    const metaRead = await session.Runtime.callFunctionOn({
      objectId: metaObjectId,
      functionDeclaration: "function () { return this; }",
      returnByValue: true,
    });
    const elementIds = (nodeProps.result ?? [])
      .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((property) => property.value.objectId);
    const metas = Array.isArray(metaRead?.result?.value) ? metaRead.result.value : [];
    // 空值也要带上：快照要如实显示「现在是空的」（diff 才看得见从 12:30 清空），
    // 以前只收非空值，结果是「填进去了但快照里没有这一行」。
    for (let index = 0; index < Math.min(elementIds.length, metas.length); index += 1) {
      const meta = metas[index] ?? {};
      values.set(elementIds[index], {
        type: String(meta.type || "time"),
        value: String(meta.value ?? ""),
        name: String(meta.name ?? ""),
      });
    }
  } catch {
    return values;
  } finally {
    for (const objectId of release) await session.Runtime.releaseObject({ objectId }).catch(() => {});
    await session.Runtime.releaseObject({ objectId: resultObjectId }).catch(() => {});
  }
  return values;
}

/** 一次性扫描：在某个框架里扫一遍，返回「按会话收集」的句柄（同 snapshot-cursor 的 scanCursorInFrame）。 */
export async function scanTemporalInFrame(session, { frameId, max = 100 } = {}) {
  const values = await findTemporalValues(session, { frameId, max });
  const byBackend = new Map();
  const result = new Map();
  const collect = async (targetSession) => {
    const entries = [...values.entries()].filter(([objectId]) => !byBackend.has(objectId));
    const described = await Promise.all(entries.map(([objectId]) => targetSession.DOM.describeNode({ objectId })
      .then((node) => ({ objectId, backendNodeId: node?.node?.backendNodeId }))
      .catch(() => ({ objectId, backendNodeId: undefined }))));
    for (const { objectId, backendNodeId } of described) {
      if (backendNodeId === undefined) continue;
      byBackend.set(objectId, backendNodeId);
      const meta = values.get(objectId);
      if (meta && !result.has(backendNodeId)) result.set(backendNodeId, meta);
    }
    return result;
  };
  return { collect, values: result };
}


/**
 * 把时间 / 日期值标进渲染好的快照文字。
 *
 *   - 宿主 input 自己有一行（无障碍树里有它的编号）：行尾补 [value="12:30"]；
 *   - 宿主没有一行（真浏览器里 input[type=time] 只报两个 spinbutton）：紧跟在「InputTime 那一行」后面
 *     补一行 `- time-value "Preferred delivery time:" [value="12:30"]` —— 和 [checked] 一样是状态位，
 *     diff 直接比较它；没有 InputTime 行就挂到第一个 spinbutton 前面。
 *
 * refs 是渲染时用的 RefMap：里面的编号表存着 backendNodeId，用来把值和元素对上。
 */
export function annotateTemporalValues(text, refs, values, { documentId } = {}) {
  if (!values?.size || typeof text !== "string") return text;
  const backendToRef = new Map(backendRefsOf(refs));
  const lines = text.split("\n");
  const isInputTime = (line) => /^\s*-\s+InputTime\b/.test(line);
  const isSpinbutton = (line) => /^\s*-\s+spinbutton\b/.test(line);
  const nameOfLine = (line) => /\bInputTime\b\s+"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? "";
  // 一个宿主只认领一行：页面上有多个时间框时，不能都挂到第一个 InputTime 上
  const claimed = new Set();
  const findInputTime = (name) => {
    const candidates = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!isInputTime(lines[index]) || claimed.has(index)) continue;
      candidates.push(index);
      if (name && nameOfLine(lines[index]) === name) return index;
    }
    return candidates[0] ?? -1;
  };
  for (const [backendNodeId, meta] of values) {
    // 空值也要写出来：AI 需要知道「这个时间框现在是空的」，diff 也要能看见从 12:30 清空。
    const value = String(meta?.value ?? "");
    const suffix = `[value=${JSON.stringify(value)}]`;
    const ref = backendToRef.get(backendNodeId);
    if (ref) {
      const index = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
      if (index >= 0 && !lines[index].includes("[value=")) lines[index] += ` ${suffix}`;
      continue;
    }
    const inputTime = findInputTime(String(meta?.name ?? ""));
    if (inputTime >= 0) {
      claimed.add(inputTime);
      const name = nameOfLine(lines[inputTime]);
      // 宿主 input 自己不在无障碍树里，没有编号就没法用 page_act 填它；这里补一个稳定编号
      // （和普通元素一样挂 backendNodeId + documentId，下一次快照编号不变）。
      const minted = typeof refs?.mint === "function"
        ? refs.mint({ backendNodeId, documentId, role: "InputTime", name: name || "时间" })
        : null;
      const refText = minted ? ` [ref=${minted}]` : "";
      lines[inputTime] += `${refText} ${suffix}`;
      continue;
    }
    const spin = lines.findIndex(isSpinbutton);
    if (spin < 0) continue;
    const indent = (/^\s*/.exec(lines[spin])[0]).slice(0, -2);
    const name = /\bspinbutton\b\s+"([^"]*)"/.exec(lines[spin])?.[1] ?? "";
    const first = name.split(/\s+/).filter(Boolean)[0] ?? "";
    const label = first ? `time-value "${first}"` : "time-value";
    const line = `${indent}- ${label} ${suffix}`;
    if (!lines.some((candidate) => candidate.trim() === line.trim())) lines.splice(spin, 0, line);
  }
  return lines.join("\n");
}

/** RefMap 的编号表里所有「backendNodeId -> 编号」：RefMap 没暴露迭代器，只能读它的 byRef 表。 */
function backendRefsOf(refs) {
  const out = [];
  const byRef = refs?.byRef;
  if (byRef instanceof Map) {
    for (const [ref, meta] of byRef) {
      if (meta?.backendNodeId !== undefined) out.push([meta.backendNodeId, ref]);
    }
  }
  return out;
}
