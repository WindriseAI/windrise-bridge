/**
 * 语义快照的「切块 / 查找 / 变化摘要」：全是纯函数，不碰 CDP，纯 Node 就能测。
 *
 * 为什么单独一个文件：page_snapshot 在长页面上（维基词条十万字）以前只能从头截断，
 * 尾部的语言切换面板永远读不到；page_act 的差异在长页面上又退化成「多少行变了」。
 * 这两件事都是纯文本处理，放这里既好测，也不会让 browser-control 继续膨胀。
 *
 * 快照的每一行形如：
 *   `- button "发送" [ref=e12]`
 *   `  - link "English" [ref=e42] [cursor=pointer]`
 * 缩进每级 2 个空格，所以祖先行可以直接按缩进推出来。
 */

const DEFAULT_MAX_CHARS = 20_000;
/** 可操作元素的行：带编号的那些。 */
const REF_LINE = /\[ref=(e\d+)\]/;

/**
 * 按字符偏移切一段快照。
 * 返回的 text 在截断时自带「还有多少字，用 offset=N 继续」，AI 不用自己数。
 */
export function paginateSnapshot(text, { offset = 0, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const value = String(text ?? "");
  const total = value.length;
  const requested = Number(offset);
  const start = Math.max(0, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 0, total));
  const requestedLimit = Number(maxChars);
  const limit = Math.max(0, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_MAX_CHARS);
  const end = Math.min(total, start + limit);
  const truncated = end < total;
  const remaining = total - end;
  const chunk = value.slice(start, end);
  const body = truncated
    ? `${chunk}\n（已截断：本次返回第 ${start}–${end} 字，全文 ${total} 字，还有 ${remaining} 字没返回；用 offset=${end} 继续）`
    : chunk;
  return {
    text: body,
    offset: start,
    nextOffset: truncated ? end : null,
    totalChars: total,
    remaining,
    truncated,
  };
}

/** 一行在树里的深度：缩进每 2 个空格一级。 */
function depthOf(line) {
  const match = /^( *)/.exec(String(line ?? ""));
  return Math.floor((match?.[1]?.length ?? 0) / 2);
}

/**
 * 某一行的祖先行（按从远到近的层级，也就是原文顺序）。
 * 只看缩进：同一层最近的一条就是父级，往上逐级找。
 */
export function ancestorsOf(lines, index) {
  const ancestors = [];
  let wanted = depthOf(lines[index]) - 1;
  for (let cursor = index - 1; cursor >= 0 && wanted >= 0; cursor -= 1) {
    if (depthOf(lines[cursor]) === wanted) {
      ancestors.unshift(lines[cursor]);
      wanted -= 1;
    }
  }
  return ancestors;
}

/**
 * 在快照里找含某段文字的行（不区分大小写），每处命中都带上它的祖先行。
 * 典型用法：在十万字的维基快照里找「English」这个链接，而不是从头翻。
 */
export function findInSnapshot(text, needle, { maxMatches = 20 } = {}) {
  // 只有空白的关键字等于没给：不 trim 的话 " " 会命中几乎每一行的缩进
  const wanted = String(needle ?? "").trim().toLowerCase();
  const lines = String(text ?? "").split("\n");
  const matches = [];
  let total = 0;
  if (!wanted) return { matches, count: 0, truncated: false, text: "" };
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(wanted)) continue;
    total += 1;
    if (matches.length >= Math.max(1, Number(maxMatches) || 20)) continue;
    matches.push({ line: lines[index], index, ancestors: ancestorsOf(lines, index) });
  }
  const groups = matches.map((match) => [...match.ancestors, match.line].join("\n"));
  return {
    matches,
    count: total,
    truncated: total > matches.length,
    text: groups.join("\n…\n"),
  };
}

/** 把快照里的可操作行按「去掉编号后的文字」分组：同一段文字可能出现多次（多个「编辑」按钮）。 */
function groupActionable(text) {
  const groups = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!REF_LINE.test(line)) continue;
    const key = line.replace(REF_LINE, "").trimEnd();
    const list = groups.get(key);
    if (list) list.push(line);
    else groups.set(key, [line]);
  }
  return groups;
}

/**
 * 长页面上的差异摘要：不再只说「多少行变了」，而是给出新出现 / 消失的可操作元素。
 * 以「去掉编号的行文字」当身份，同一文字出现多次时按次数差算增减。
 */
export function diffActionable(beforeText, afterText, { limit = 40 } = {}) {
  const cap = Math.max(1, Number(limit) || 40);
  const before = groupActionable(beforeText);
  const after = groupActionable(afterText);
  const added = [];
  const removed = [];
  for (const [key, lines] of after) {
    const had = before.get(key) ?? [];
    if (lines.length > had.length) added.push(...lines.slice(had.length));
  }
  for (const [key, lines] of before) {
    const now = after.get(key) ?? [];
    if (lines.length > now.length) removed.push(...lines.slice(now.length));
  }
  return {
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    addedCount: added.length,
    removedCount: removed.length,
    truncated: added.length > cap || removed.length > cap,
  };
}

/** 把 diffActionable 的结果写成模型好读的几行（每条带序号，行里带 ref 编号）。 */
export function formatActionableDiff(diff) {
  const lines = [];
  const head = (label, count, shown) => `${label}（${count} 个${count > shown ? `，只列前 ${shown} 个` : ""}）：`;
  lines.push(head("新出现的可操作元素", diff.addedCount, diff.added.length));
  if (!diff.added.length) lines.push("（没有）");
  else diff.added.forEach((line, index) => lines.push(`${index + 1}. + ${line.trim()}`));
  lines.push(head("消失的可操作元素", diff.removedCount, diff.removed.length));
  if (!diff.removed.length) lines.push("（没有）");
  else diff.removed.forEach((line, index) => lines.push(`${index + 1}. - ${line.trim()}`));
  return lines.join("\n");
}

/**
 * 只留某个元素（按 backendNodeId 认）的子树，根排在最前。
 * renderSnapshot 在没有 RootWebArea 时从 nodes[0] 开始走，所以根必须在前。
 */
export function subtreeAxNodes(nodes, backendNodeId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const root = list.find((node) => node?.backendDOMNodeId === backendNodeId);
  if (!root) return [];
  const byId = new Map(list.map((node) => [node.nodeId, node]));
  const keep = new Set([root.nodeId]);
  const stack = [...(root.childIds ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    keep.add(id);
    stack.push(...(node.childIds ?? []));
  }
  return [root, ...list.filter((node) => node !== root && keep.has(node.nodeId))];
}

/**
 * 只留「在视口里的节点 + 它们的祖先」：结构还在，视口外的兄弟节点被摘掉。
 * keep 是 backendNodeId 的集合（页面里量出来的）。
 */
export function pruneAxNodes(nodes, keep) {
  const list = Array.isArray(nodes) ? nodes : [];
  const kept = keep instanceof Set ? keep : new Set(keep ?? []);
  const byId = new Map(list.map((node) => [node.nodeId, node]));
  const parentOf = new Map();
  for (const node of list) {
    for (const childId of node.childIds ?? []) parentOf.set(childId, node.nodeId);
  }
  const alive = new Set();
  const mark = (nodeId) => {
    let current = nodeId;
    while (current !== undefined && !alive.has(current)) {
      alive.add(current);
      current = parentOf.get(current);
    }
  };
  for (const node of list) {
    if (node.backendDOMNodeId !== undefined && kept.has(node.backendDOMNodeId)) mark(node.nodeId);
  }
  // 根节点永远留着，不然整棵树没有入口
  for (const node of list) {
    const role = node.role?.value;
    if (role === "RootWebArea" || role === "WebArea") mark(node.nodeId);
  }
  if (!alive.size) return [];
  // 被摘掉的子节点不能继续挂在父节点的 childIds 上，否则 render 会找不到又跳过去（虽然安全，但白跑）
  return list
    .filter((node) => alive.has(node.nodeId))
    .map((node) => (node.childIds?.some((id) => !alive.has(id)) && byId.size
      ? { ...node, childIds: node.childIds.filter((id) => alive.has(id)) }
      : node));
}

/**
 * 逐行 diff 被跳过（长页面）时，把「多少行变了」换成可操作元素清单。
 * 没被跳过就原样返回，短页面上的差异一个字都不变。
 */
export function augmentLargeDiff(diff, beforeText, afterText, { limit = 40 } = {}) {
  if (!diff?.lineDiffSkipped) return diff;
  const actionable = diffActionable(beforeText, afterText, { limit });
  return { ...diff, text: formatActionableDiff(actionable), actionable };
}

export const __testing = { depthOf, groupActionable, REF_LINE, DEFAULT_MAX_CHARS };
