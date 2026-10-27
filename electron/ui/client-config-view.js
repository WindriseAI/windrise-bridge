/**
 * 「按客户端复制配置」弹窗的渲染（纯函数，不碰 DOM）。
 *
 * 单独成一个文件是为了能在 node --test 里断言真正的输出（含步骤 / 提示 / 缺口令标注），
 * 而不是 grep app.js 里有没有某个字符串——上一版就是这么漏掉「界面从不渲染 steps」的。
 *
 * 输入是主进程 → preload → 界面的 groups 数据结构（src/core/client-configs.js 的 buildClientConfigGroups），
 * 输出 HTML 字符串；所有文案都经过 escapeHtml，配置正文不进 HTML（用户点「复制」时从内存里取，不落页面）。
 */

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/** 弹窗顶部的一行模式说明：让用户知道这份配置里的口令是「已经在地址里」还是「要自己换」。 */
export function renderClientConfigMode(options = {}) {
  const pathToken = options.pathToken !== false;
  const hasToken = Boolean(options.hasToken);
  if (pathToken && hasToken) return "当前模式：口令在路径里。下面的地址已经带好口令，整段复制即可。";
  if (pathToken && !hasToken) return "当前模式：口令在路径里，但还没有口令。配置里的 <你的口令-URL编码后> 要先换成你在「设置 → 口令」里创建的口令（先做 URL 编码），否则客户端会 401。";
  if (!pathToken && hasToken) return "当前模式：口令走请求头（Authorization: Bearer）。下面的配置已经带好口令，注意别外传。";
  return "当前模式：口令走请求头，但还没有口令。配置里的 <你的口令> 要先换成你在「设置 → 口令」里创建的口令。";
}

const KIND_LABEL = { form: "按步骤填写", json: "JSON", toml: "TOML", yaml: "YAML", cli: "命令行" };

function renderList(items, tag, className) {
  const list = (items || []).map((text) => String(text || "").trim()).filter(Boolean);
  if (!list.length) return "";
  return `<${tag} class="client-cfg-${className}">${list.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</${tag}>`;
}

/** 一行的详情：怎么放、怎么验证、注意事项；缺口令时在最前面标注要替换的占位符。key 用来把开关和详情对上。 */
export function renderClientDetails(config = {}, key = "") {
  const parts = [];
  if (config.supported !== false && config.needsToken) {
    const hint = config.pathToken === false
      ? "这份配置还缺口令：把正文或备选里的 &lt;你的口令&gt; 换成你的口令，或按提示把口令导出成环境变量，否则客户端会 401。"
      : "需把正文里的 &lt;你的口令-URL编码后&gt; 换成你在「设置 → 口令」里创建的口令（先做 URL 编码：#、?、/、空格、中文都要转义），否则客户端会 401。";
    parts.push(`<p class="client-cfg-needs-token">${hint}</p>`);
  }
  parts.push(renderList(config.steps, "ol", "steps"));
  parts.push(renderList(config.notes, "ul", "notes"));
  const body = parts.filter(Boolean).join("");
  return body ? `<div class="client-cfg-details" data-client-details="${escapeHtml(key)}" hidden>${body}</div>` : "";
}

/** 单个客户端一行（含可展开的详情与备选配置）。 */
export function renderClientRow(client) {
  const { key, name, config = {} } = client || {};
  const supported = config.supported !== false;
  const stateLabel = supported ? (KIND_LABEL[config.kind] || String(config.kind || "").toUpperCase()) : `不支持：${config.reason || ""}`;
  const button = supported
    ? `<button class="btn btn-sm" data-client-config="${escapeHtml(key)}">复制</button>`
    : `<button class="btn btn-sm btn-ghost" data-client-config="${escapeHtml(key)}" disabled>不可用</button>`;
  const variants = (config.variants || []).map((variant, index) => `
        <div class="lg-row ai-row client-cfg-row client-cfg-variant" data-client-variant-of="${escapeHtml(key)}" hidden>
          <span class="ai-name">${escapeHtml(name)} · ${escapeHtml(variant.label || "备选")}</span>
          <span class="ai-state">${escapeHtml(KIND_LABEL[variant.kind] || String(variant.kind || "").toUpperCase())}</span>
          <button class="btn btn-sm" data-client-variant="${escapeHtml(key)}:${index}">复制备选</button>
        </div>`).join("");
  // 主行点「步骤」展开：步骤 / 提示和备选配置一起显示（默认收起，免得一屏堆满 19 个客户端）
  return `
        <div class="lg-row ai-row client-cfg-row client-cfg-main">
          <span class="ai-name">${escapeHtml(name)}${supported && config.needsToken ? ' <span class="client-cfg-tag">缺口令</span>' : ""}</span>
          <span class="ai-state" title="${escapeHtml(stateLabel)}">${escapeHtml(stateLabel)}</span>
          <button class="btn btn-sm" type="button" data-client-details-toggle="${escapeHtml(key)}" aria-expanded="false">步骤</button>
          ${button}
        </div>${renderClientDetails(config, key)}${variants}`;
}

/** 整个弹窗的列表：按分组渲染。 */
export function renderClientGroupList(groups) {
  return (groups || []).map(({ group, clients }) => `
    <section class="client-cfg-group">
      <div class="client-cfg-title">${escapeHtml(group)}</div>
      ${(clients || []).map(renderClientRow).join("")}
    </section>`).join("");
}

/** 复制成功的提示：和界面上真正给了「步骤 / 提示」对齐，不再让用户去找不存在的东西。 */
export function clientCopyToast(name, config = {}) {
  if (!config.needsToken) return `${name} 的配置已复制；展开这一行看「放哪 / 怎么验证」。`;
  const details = config.pathToken === false
    ? "已复制，先把 <你的口令> 换成你的口令或按提示设置环境变量"
    : "已复制，先把地址里的 <你的口令-URL编码后> 换成你的口令（先做 URL 编码）";
  return `${name} 的配置${details}；展开这一行看「放哪 / 怎么验证」。`;
}

/**
 * 点「复制」时要拿的文本：从 groups + 点击标识（key / 备选下标）算出真正要复制的内容和 toast 文案。
 * 抽成纯函数是为了能在 node 里断言「按钮点下去复制的是什么」，而不是只 grep app.js 里有没有调用。
 */
export function pickClientCopy(groups, { key, variantIndex } = {}) {
  const item = (groups || [])
    .flatMap((group) => group.clients || [])
    .find((client) => client.key === key);
  if (!item || !item.config) return null;
  const config = item.config;
  const hasVariant = variantIndex !== undefined && variantIndex !== null && String(variantIndex) !== "";
  if (hasVariant) {
    const variant = Array.isArray(config.variants) ? config.variants[Number(variantIndex)] : null;
    if (!variant) return null;
    const text = String(variant.text ?? "");
    return {
      text,
      message: clientCopyToast(item.name, { needsToken: text.includes("<你的口令"), pathToken: config.pathToken }),
    };
  }
  if (config.supported === false) {
    return { text: "", message: config.reason || "这个客户端暂不支持", unsupported: true };
  }
  return { text: String(config.text ?? ""), message: clientCopyToast(item.name, config) };
}
