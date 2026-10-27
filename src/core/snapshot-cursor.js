/**
 * 光标扫描：找出「能点但无障碍树看不见」的元素（cursor:pointer 的 div、onclick、tabindex、
 * contenteditable、带 data-e2e / data-testid 的卡片、隐藏的 file input），并给它们合成一个提示名。
 *
 * 上游（BrowserOS 的 core/observer/cursor-augment.ts，搬来时已不再落盘）的做法是：
 *   document.body.querySelectorAll('*') → 每个命中打一个 data-__bcid 属性 → 再逐条 evaluate 查询 →
 *   逐条 DOM.describeNode。三个问题：进不了 shadow DOM；每个命中两次往返；改 DOM 会惊动页面的
 *   MutationObserver。这里换成：
 *   - 递归进 open shadow root（深度上限 8）；
 *   - 一次 Runtime.evaluate 把候选收进两个数组（元素 + 元数据）并返回它们的 objectId；
 *   - 一次 Runtime.getProperties 拿元素数组，再一次 callFunctionOn 把元数据整批读回来；
 *   - DOM.describeNode 按元素并发（往返次数与命中数无关，只有并发度）；
 *   - 完全不碰页面 DOM，不留任何临时属性；
 *   - 命中上限 300，按「是否在视口内 + 面积」排序保留。
 *
 * 提示名（`(提示: xxx)`）在页面里按 6 级优先级取第一个有用的，回到 Node 侧再过一遍
 * ./snapshot-redact.js 的 sanitizeHint（敏感词整条丢掉、长数字换成 [已隐藏]）。
 *
 * 同一批命中里出现同名提示名时（抖音的两张封面卡片都叫「选择封面」），额外取一段区分文字
 * （元素自己或最近祖先的兄弟节点短文本，例如「竖封面3:4」）交给 render；
 * render 只给重名的那几行追加，唯一的提示名原样输出。
 */

import { sanitizeHint } from "./snapshot-redact.js";

/** 命中上限：超过就按「在视口内优先、面积从大到小」保留前 300 个。 */
export const MAX_CURSOR_HITS = 300;

/**
 * 给一个元素合成提示名，按优先级取第一个有用的。返回 { hint, level }。
 * 这个函数会被 toString() 注入页面执行，所以必须自包含：不能引用模块里的任何东西。
 */
export function hintForElement(el, viewport) {
  var clip = function (text, max) {
    var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) : s;
  };
  var attr = function (name) {
    try {
      return el && el.getAttribute ? el.getAttribute(name) || "" : "";
    } catch (e) {
      return "";
    }
  };
  var query = function (selector) {
    try {
      return el && el.querySelector ? el.querySelector(selector) : null;
    } catch (e) {
      return null;
    }
  };
  var rectOf = function (node) {
    try {
      return node.getBoundingClientRect();
    } catch (e) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
  };
  var positionLabel = function () {
    var r = rectOf(el);
    var w = Math.round(r.width);
    var h = Math.round(r.height);
    var vw = viewport && viewport.width ? viewport.width : 0;
    var vh = viewport && viewport.height ? viewport.height : 0;
    if (!vw || !vh) return w + "×" + h;
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) return "视口外 " + w + "×" + h;
    var horizontal = cx < vw / 3 ? "左" : cx > (vw * 2) / 3 ? "右" : "中";
    var vertical = cy < vh / 3 ? "上" : cy > (vh * 2) / 3 ? "下" : "中";
    var where = horizontal === "中" && vertical === "中" ? "中间" : horizontal + vertical;
    return where + " " + w + "×" + h;
  };
  /**
   * class / id 里有意义的词：只认 kebab / snake 这种人手写的名字（upload-cover、icon-search、btn-close）。
   * 整段 class 值先按空白切成 token，token 里带驼峰中段或数字的一律当 hash 乱码整段丢掉
   * （styled-components 的 sc-bdVaJa、CSS Module 的 css-1a2b3c4d、随机后缀 k9F2xQ1z 都落在这里），
   * 免得从乱码里挑出「bd」「VaJa」这种看着像词的碎片。
   */
  var classWords = function () {
    var sources = [attr("class"), attr("id")];
    var words = [];
    var seen = {};
    for (var i = 0; i < sources.length; i += 1) {
      if (!sources[i]) continue;
      var tokens = String(sources[i]).split(/\s+/);
      for (var t = 0; t < tokens.length; t += 1) {
        var token = tokens[t];
        if (!token) continue;
        if (/\d/.test(token)) continue;
        if (/[A-Z]/.test(token.slice(1))) continue;
        var parts = token.split(/[-_]+/);
        for (var j = 0; j < parts.length; j += 1) {
          var word = parts[j];
          if (!word || word.length < 2) continue;
          if (/^(css|sc|jsx|tsx|module|styles|style|root|app|div|span|box|wrap|inner|outer|content|item|container)$/i.test(word)) continue;
          var key = word.toLowerCase();
          if (seen[key]) continue;
          seen[key] = true;
          words.push(word);
          if (words.length >= 3) return words;
        }
      }
    }
    return words;
  };

  // 1. aria-label / title / alt / placeholder / data-tooltip / aria-describedby 指向的文字
  var level1 = clip(
    attr("aria-label") || attr("title") || attr("alt") || attr("placeholder") || attr("data-tooltip"),
    30,
  );
  if (level1) return { hint: level1, level: 1 };
  var describedBy = attr("aria-describedby");
  if (describedBy) {
    var ids = describedBy.split(/\s+/);
    var pieces = [];
    for (var i = 0; i < ids.length && pieces.length < 2; i += 1) {
      var target = null;
      try {
        target = el && el.ownerDocument && el.ownerDocument.getElementById ? el.ownerDocument.getElementById(ids[i]) : null;
      } catch (e) {
        target = null;
      }
      var piece = target ? clip(target.textContent, 30) : "";
      if (piece) pieces.push(piece);
    }
    if (pieces.length) return { hint: clip(pieces.join(" "), 30), level: 1 };
  }

  // 2. 元素自己的可见文字
  var own = clip(el && el.innerText, 30);
  if (own) return { hint: own, level: 2 };

  // 3. 子元素 img 的 alt，或 svg 里 <title> 的文字
  var img = query("img[alt]");
  var alt = img ? clip(img.getAttribute("alt"), 30) : "";
  if (alt) return { hint: alt, level: 3 };
  var svgTitle = query("svg title");
  var svgText = svgTitle ? clip(svgTitle.textContent, 30) : "";
  if (svgText) return { hint: svgText, level: 3 };

  // 3.5 表单控件：label / 紧邻文本。复选框、单选框的说明文字通常写在 input 后面，
  // 以前直接退到「父级 textContent」，同一组控件会拿到一模一样的整段文字（t12：两个都叫「checkbox 1 checkbox」）。
  var tagName = String((el && el.tagName) || "").toLowerCase();
  if (tagName === "input" || tagName === "select" || tagName === "textarea") {
    var labels = [];
    try {
      labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
    } catch (e) {
      labels = [];
    }
    var labelText = clip(labels.map(function (label) {
      return label ? label.textContent : "";
    }).join(" "), 30);
    if (labelText) return { hint: labelText, level: 3 };
    // 紧跟在控件后面的文本节点（the-internet 的 checkboxes 就是这种写法）
    var nextText = "";
    var next = el.nextSibling;
    while (next && next.nodeType === 3 && !String(next.textContent || "").trim()) next = next.nextSibling;
    if (next && next.nodeType === 3) nextText = clip(next.textContent, 30);
    if (nextText) return { hint: nextText, level: 5 };
    var prevText = "";
    var prev = el.previousSibling;
    while (prev && prev.nodeType === 3 && !String(prev.textContent || "").trim()) prev = prev.previousSibling;
    if (prev && prev.nodeType === 3) prevText = clip(prev.textContent, 30);
    if (prevText) return { hint: prevText, level: 5 };
    // 紧邻的元素（<label> / <span>），但不要拿另一个表单控件当名字
    var nextEl = el.nextElementSibling;
    if (nextEl && !/^(input|select|textarea|button)$/i.test(String(nextEl.tagName || ""))) {
      var nextElText = clip(nextEl.textContent, 30);
      if (nextElText) return { hint: nextElText, level: 5 };
    }
    var prevEl = el.previousElementSibling;
    if (prevEl && !/^(input|select|textarea|button)$/i.test(String(prevEl.tagName || ""))) {
      var prevElText = clip(prevEl.textContent, 30);
      if (prevElText) return { hint: prevElText, level: 5 };
    }
  }

  // 4. class / id 里有意义的词
  var words = classWords();
  if (words.length) return { hint: words.join(" "), level: 4 };

  // 5. 旁边最近的标签文字：前一个兄弟，或父级的可见文字（都截到 20 字）
  var previous = el && el.previousElementSibling ? el.previousElementSibling : null;
  var previousText = previous ? clip(previous.textContent, 20) : "";
  if (previousText) return { hint: previousText, level: 5 };
  var parent = el && el.parentElement ? el.parentElement : null;
  var parentText = parent ? clip(parent.textContent, 20) : "";
  if (parentText) return { hint: parentText, level: 5 };

  // 6. 位置和尺寸
  return { hint: positionLabel(), level: 6 };
}

/**
 * 收集候选元素。同样会被 toString() 注入页面，必须自包含。
 * 返回 { nodes: [元素…], meta: [{ kind, reasons, hint, context, hidden, fileInput }…] }，两个数组一一对应。
 * context 只在同一批里有同名提示名时才填：旁边能用于区分的短文本（不保证取到）。
 */
export function collectCandidates(root, viewport, getStyle) {
  var MAX = 300;
  var interactiveTags = {
    a: 1, button: 1, select: 1, textarea: 1, details: 1, summary: 1, option: 1, label: 1,
  };
  var interactiveRoles = {
    button: 1, link: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, option: 1, searchbox: 1, slider: 1, spinbutton: 1,
    switch: 1, tab: 1, treeitem: 1,
  };
  var skipTags = {
    html: 1, head: 1, body: 1, script: 1, style: 1, link: 1, meta: 1, title: 1, br: 1, template: 1, noscript: 1,
  };
  var out = [];

  var rectOf = function (node) {
    try {
      return node.getBoundingClientRect();
    } catch (e) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
  };
  var inViewport = function (rect) {
    if (!viewport || !viewport.width || !viewport.height) return false;
    return rect.left < viewport.width && rect.top < viewport.height
      && rect.left + rect.width > 0 && rect.top + rect.height > 0;
  };
  var cardSized = function (rect) {
    if (!rect || rect.width < 48 || rect.height < 48) return false;
    if (!viewport || !viewport.width || !viewport.height) return true;
    if (rect.width > viewport.width || rect.height > viewport.height) return false;
    return rect.width * rect.height <= viewport.width * viewport.height * 0.5;
  };
  var testIdOf = function (node) {
    try {
      return (node.getAttribute && (node.getAttribute("data-e2e") || node.getAttribute("data-testid"))) || "";
    } catch (e) {
      return "";
    }
  };
  /** 自己或往上 6 层里第一个带 data-e2e / data-testid 的元素 */
  var markedAncestor = function (node) {
    var current = node;
    for (var hops = 0; current && hops <= 6; hops += 1) {
      if (testIdOf(current)) return current;
      current = current.parentElement;
    }
    return null;
  };
  /**
   * 只认「带标记的子树里最外层的那张卡片」：再往上 6 层里还有带标记且尺寸像卡片的元素，就让给外层。
   * 一张封面卡片只出一行，不会 img / 文字 / 包装层各出一行。
   */
  var outermostCard = function (node, rect) {
    if (!cardSized(rect)) return false;
    var current = node.parentElement;
    for (var hops = 0; current && hops < 6; hops += 1) {
      if (markedAncestor(current) && cardSized(rectOf(current))) return false;
      current = current.parentElement;
    }
    return true;
  };
  /**
   * 框架自己挂的点击处理。React 在元素上留 `__reactProps$xxx`，里面**每个元素都有** props 对象，
   * 只有真的写了 onClick 之类才算；`__reactFiber$xxx` 几乎每个元素都有，一律不算。
   * Vue 3 的 `_vei` 是事件处理器表，键名形如 `onClick` / `onMousedown` / `onClick|…`，表里有键才算。
   */
  var FRAMEWORK_EVENT_PROPS = [
    "onClick", "onMouseDown", "onMouseUp", "onPointerDown", "onPointerUp", "onTouchStart",
  ];
  var hasFrameworkHandler = function (node) {
    var keys;
    try {
      keys = Object.keys(node);
    } catch (e) {
      return false;
    }
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (key.indexOf("__reactProps$") === 0) {
        var props = null;
        try {
          props = node[key];
        } catch (e) {
          props = null;
        }
        if (!props || typeof props !== "object") continue;
        for (var j = 0; j < FRAMEWORK_EVENT_PROPS.length; j += 1) {
          if (typeof props[FRAMEWORK_EVENT_PROPS[j]] === "function") return true;
        }
        continue;
      }
      if (key === "_vei") {
        var handlers = null;
        try {
          handlers = node[key];
        } catch (e) {
          handlers = null;
        }
        if (!handlers || typeof handlers !== "object") continue;
        var names;
        try {
          names = Object.keys(handlers);
        } catch (e) {
          names = [];
        }
        for (var k = 0; k < names.length; k += 1) {
          // "onClick" / "onMousedown" / "onClick|…"，只要是真事件名就算
          if (/^on(click|mousedown|mouseup|pointerdown|pointerup|touchstart)(\||$)/i.test(names[k])) return true;
        }
      }
    }
    return false;
  };
  var push = function (el, item) {
    out.push({ el: el, meta: item });
  };
  /** 压空白截断，和 hintForElement 里的 clip 一个口径。 */
  var clip = function (text, max) {
    var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) : s;
  };
  /**
   * 区分文字：同名的几个元素里，谁旁边有短标签就用谁。
   * 顺序是「自己的前一个兄弟 → 自己的后一个兄弟 → 上一层的两个兄弟」，最多往上 3 层；
   * 和提示名重叠的文字不算（那只是把提示名再抄一遍，AI 还是分不清）。
   */
  var contextOf = function (el, hint) {
    var current = el;
    for (var hop = 0; current && hop < 3; hop += 1) {
      var parent = current.parentElement;
      if (!parent) break;
      var siblings = parent.children || [];
      var index = -1;
      for (var i = 0; i < siblings.length; i += 1) {
        if (siblings[i] === current) {
          index = i;
          break;
        }
      }
      var nearby = [];
      if (index > 0) nearby.push(siblings[index - 1]);
      if (index >= 0 && index + 1 < siblings.length) nearby.push(siblings[index + 1]);
      for (var j = 0; j < nearby.length; j += 1) {
        var text = clip(nearby[j] ? nearby[j].textContent : "", 20);
        if (!text || text.indexOf(hint) >= 0) continue;
        return text;
      }
      current = parent;
    }
    return "";
  };

  var inspect = function (el) {
    var tag = String((el && el.tagName) || "").toLowerCase();
    if (!tag || skipTags[tag]) return;
    var type = String(el.type || (el.getAttribute && el.getAttribute("type")) || "").toLowerCase();

    // 隐藏的 file input：上传区域真正接文件的那个框，AI 需要知道它在，但点它没用
    if (tag === "input" && type === "file") {
      var fileRect = rectOf(el);
      var fileStyle = getStyle(el) || {};
      var hidden = Boolean(el.hidden)
        || (el.getAttribute && el.getAttribute("hidden") !== null)
        || fileStyle.display === "none"
        || fileStyle.visibility === "hidden"
        || Number(fileStyle.opacity) === 0
        || fileRect.width < 1
        || fileRect.height < 1;
      var fileHint = hintForElement(el, viewport);
      push(el, {
        kind: "file-input",
        reasons: ["file-input"],
        hint: fileHint.hint,
        hidden: hidden,
        fileInput: true,
        area: Math.max(0, fileRect.width * fileRect.height),
        inView: hidden ? false : inViewport(fileRect),
      });
      return;
    }

    if (interactiveTags[tag]) return;
    var roleAttr = String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase().split(/\s+/)[0];
    if (roleAttr && interactiveRoles[roleAttr]) return;
    var rect = rectOf(el);
    if (!rect || rect.width < 1 || rect.height < 1) return;
    var style = getStyle(el) || {};
    var reasons = [];
    if (style.cursor === "pointer") reasons.push("cursor:pointer");
    if ((el.hasAttribute && el.hasAttribute("onclick")) || el.onclick) reasons.push("onclick");
    var tabIndex = el.getAttribute ? el.getAttribute("tabindex") : null;
    if (tabIndex !== null && tabIndex !== "-1") reasons.push("tabindex");
    if (el.isContentEditable) reasons.push("contenteditable");
    if (hasFrameworkHandler(el)) reasons.push("handler");
    // 原生复选框 / 单选框即使没有 cursor:pointer 也要进来：快照需要给它们各自的 label / 邻近文字，
    // 否则无名控件只能共用父容器那一段文字（t12 问题 4）。
    if (tag === "input" && (type === "checkbox" || type === "radio")) reasons.push("form-control");
    // 只有 cursor 命中时，父级也是 pointer 就当装饰（上游原有规则，避免整片文字都列出来）
    if (reasons.length === 1 && reasons[0] === "cursor:pointer") {
      var parent = el.parentElement;
      var parentStyle = parent ? getStyle(parent) || {} : null;
      if (parentStyle && parentStyle.cursor === "pointer") return;
    }
    if (markedAncestor(el) && outermostCard(el, rect)) reasons.push("testid-card");
    if (!reasons.length) return;
    var hint = hintForElement(el, viewport);
    push(el, {
      kind: tag === "img" ? "image" : tag === "svg" ? "icon" : "clickable",
      reasons: reasons,
      hint: hint.hint,
      hidden: false,
      fileInput: false,
      area: rect.width * rect.height,
      inView: inViewport(rect),
      rect: { width: rect.width, height: rect.height },
    });
  };

  var visitRoot = function (container, depth) {
    if (!container || depth > 8) return;
    var nodes;
    try {
      nodes = container.querySelectorAll("*");
    } catch (e) {
      return;
    }
    for (var i = 0; i < nodes.length; i += 1) inspect(nodes[i]);
    // open shadow root 里的元素不在 querySelectorAll('*') 里，单独递归进去
    for (var j = 0; j < nodes.length; j += 1) {
      var shadow = nodes[j].shadowRoot;
      if (shadow) visitRoot(shadow, depth + 1);
    }
  };

  visitRoot(root, 0);

  /* ---------------- 去噪：包装层折叠 + 同提示名的 handler 链 ---------------- */

  // 候选之间的父子关系（最近命中的祖先），避免用 contains 做 O(n²) 的子树判断
  var byElement = new Map();
  for (var index = 0; index < out.length; index += 1) byElement.set(out[index].el, index);
  var parentOf = [];
  for (var n = 0; n < out.length; n += 1) {
    parentOf[n] = -1;
    var up = out[n].el.parentElement;
    while (up) {
      if (byElement.has(up)) {
        parentOf[n] = byElement.get(up);
        break;
      }
      up = up.parentElement;
    }
  }
  var dropped = [];
  for (var d = 0; d < out.length; d += 1) dropped.push(false);

  var handlerOnly = function (entry) {
    return entry.meta.reasons.length === 1 && entry.meta.reasons[0] === "handler";
  };
  // 只有 handler 的命中：往上 3 层里也有命中且提示名相同 → 是同一块可点区域的重复包装
  for (var h = 0; h < out.length; h += 1) {
    if (!handlerOnly(out[h])) continue;
    var ancestor = out[h].el.parentElement;
    for (var hops = 0; ancestor && hops < 3; hops += 1) {
      if (byElement.has(ancestor)) {
        var ancestorIndex = byElement.get(ancestor);
        if (!dropped[ancestorIndex] && out[ancestorIndex].meta.hint && out[ancestorIndex].meta.hint === out[h].meta.hint) {
          dropped[h] = true;
          break;
        }
      }
      ancestor = ancestor.parentElement;
    }
  }

  var similarSize = function (outer, inner) {
    var a = outer.meta.rect;
    var b = inner.meta.rect;
    if (!a || !b) return false;
    if (Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4) return true;
    var outerArea = a.width * a.height;
    var innerArea = b.width * b.height;
    return outerArea > 0 && innerArea >= outerArea * 0.8;
  };
  // 一个命中里面只有一个命中后代、两者大小差不多 → 外层只是包装，丢掉外层（反复跑到稳定，链条会一路塌掉）
  for (var round = 0; round < 8; round += 1) {
    var childCount = [];
    var onlyChild = [];
    for (var c = 0; c < out.length; c += 1) {
      childCount.push(0);
      onlyChild.push(-1);
    }
    for (var i = 0; i < out.length; i += 1) {
      if (dropped[i]) continue;
      var parent = parentOf[i];
      while (parent !== -1 && dropped[parent]) parent = parentOf[parent];
      if (parent === -1) continue;
      childCount[parent] += 1;
      onlyChild[parent] = i;
    }
    var folded = false;
    for (var k = 0; k < out.length; k += 1) {
      if (dropped[k] || childCount[k] !== 1) continue;
      var child = onlyChild[k];
      if (child === -1 || !similarSize(out[k], out[child])) continue;
      dropped[k] = true;
      folded = true;
    }
    if (!folded) break;
  }

  /* ---------------- 排序：强理由优先，只有 handler 的垫底 ---------------- */
  var STRONG_REASONS = { "cursor:pointer": 1, onclick: 1, tabindex: 1, "testid-card": 1, contenteditable: 1 };
  var tierOf = function (entry) {
    // 上传框永远最先保留：AI 找不到它就不知道上传入口在哪
    if (entry.meta.fileInput) return 2;
    for (var i = 0; i < entry.meta.reasons.length; i += 1) {
      if (STRONG_REASONS[entry.meta.reasons[i]]) return 1;
    }
    return 0;
  };

  var survivors = [];
  for (var s = 0; s < out.length; s += 1) {
    if (dropped[s]) continue;
    out[s].meta.tier = tierOf(out[s]);
    survivors.push(out[s]);
  }
  survivors.sort(function (a, b) {
    if (a.meta.tier !== b.meta.tier) return b.meta.tier - a.meta.tier;
    if (a.meta.inView !== b.meta.inView) return a.meta.inView ? -1 : 1;
    return b.meta.area - a.meta.area;
  });
  var kept = survivors.slice(0, MAX);
  // 重名的才取区分文字：大批量页面上绝大多数提示名是唯一的，不多读 DOM
  var hintCounts = {};
  for (var dupIndex = 0; dupIndex < kept.length; dupIndex += 1) {
    var dupHint = kept[dupIndex].meta.hint;
    if (!dupHint) continue;
    hintCounts[dupHint] = (hintCounts[dupHint] || 0) + 1;
  }
  var nodes = [];
  var meta = [];
  for (var m = 0; m < kept.length; m += 1) {
    var keptHint = kept[m].meta.hint;
    nodes.push(kept[m].el);
    meta.push({
      kind: kept[m].meta.kind,
      reasons: kept[m].meta.reasons,
      hint: keptHint,
      context: keptHint && hintCounts[keptHint] > 1 ? contextOf(kept[m].el, keptHint) : "",
      hidden: kept[m].meta.hidden,
      fileInput: kept[m].meta.fileInput,
    });
  }
  return { nodes: nodes, meta: meta };
}

/** 页面里跑的那段脚本：注入上面两个函数，不往 DOM 上留任何标记。 */
export const CURSOR_SCAN_JS = `(function(){
  var hintForElement = ${hintForElement.toString()};
  var collectCandidates = ${collectCandidates.toString()};
  var viewport = { width: window.innerWidth, height: window.innerHeight };
  return collectCandidates(document.body || document.documentElement, viewport, function (el) { return getComputedStyle(el); });
})()`;

/**
 * 扫一个会话（主框架或某个子框架）里能点但没有语义的元素。
 * 返回 Map<backendNodeId, { reasons, hint, kind, hidden, fileInput }>；任何一步失败都返回空表（尽力而为）。
 * observer.js 只把这张表原样交给 render。
 *
 * frameId：同源 iframe 走的是页面会话，Runtime.evaluate 默认在主框架里跑，必须先用
 * Page.createIsolatedWorld 拿到那个框架的执行上下文，否则扫到的是主框架的元素。
 * 跨域 iframe 有自己的会话（FrameRegistry 的 oopifSessions），不传 frameId。
 */
export async function findCursorHits(session, { frameId, sanitize = sanitizeHint, max = MAX_CURSOR_HITS, keepSemantic = false } = {}) {
  const hits = new Map();
  let contextId;
  if (frameId !== undefined) {
    try {
      const world = await session.Page.createIsolatedWorld({ frameId, worldName: "windrise-cursor-scan" });
      contextId = world?.executionContextId;
    } catch {
      contextId = undefined;
    }
    if (contextId === undefined) return hits;
  }
  let resultObjectId;
  try {
    const evaluated = await session.Runtime.evaluate({
      expression: CURSOR_SCAN_JS,
      returnByValue: false,
      awaitPromise: false,
      ...(contextId === undefined ? {} : { contextId }),
    });
    resultObjectId = evaluated.result?.objectId;
  } catch {
    return hits;
  }
  if (!resultObjectId) return hits;

  /* ---------- 读回扫描结果：元素数组 + 元数据 ---------- */

  const release = [];
  let elementIds = [];
  let metas = [];
  try {
    const roots = await session.Runtime.getProperties({
      objectId: resultObjectId,
      ownProperties: true,
      generatePreview: false,
    });
    const nodesObjectId = roots.result?.find((property) => property.name === "nodes")?.value?.objectId;
    const metaObjectId = roots.result?.find((property) => property.name === "meta")?.value?.objectId;
    if (!nodesObjectId || !metaObjectId) return hits;
    release.push(nodesObjectId, metaObjectId);

    // 两条读命令必须**串行**：并发发到同一个会话时，浏览器偶尔会只完成一条，另一条的表就变空
    // （真机 2026-10-27 实测：并发后 metas 拿到空数组，复选框的提示名/状态全丢）。多一次往返换确定性。
    const nodeProps = await session.Runtime.getProperties({ objectId: nodesObjectId, ownProperties: true, generatePreview: false });
    const metaRead = await session.Runtime.callFunctionOn({
      objectId: metaObjectId,
      functionDeclaration: "function () { return this; }",
      returnByValue: true,
    });
    elementIds = (nodeProps.result ?? [])
      .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((property) => property.value.objectId);
    metas = Array.isArray(metaRead?.result?.value) ? metaRead.result.value : [];
  } catch {
    return hits;
  } finally {
    for (const objectId of release) await session.Runtime.releaseObject({ objectId }).catch(() => {});
    await session.Runtime.releaseObject({ objectId: resultObjectId }).catch(() => {});
  }
  const limit = Math.min(elementIds.length, metas.length, max);
  if (!limit) return hits;

  await collectHits(session, elementIds.slice(0, limit), metas, { sanitize, hits, limit, keepSemantic });
  return hits;
}

/**
 * 把「元素对象 + 元数据」变成 Map<backendNodeId, 命中>。
 *
 * 这一步单独拆出来是因为「一次快照里只有一个框架会跑扫描」（见 findFrameCursorHits）：
 * 扫描的是整棵文档树，跨域 iframe 的内容作为 <iframe> 元素嵌在里面，命中只带 objectId，
 * 要等快照渲染到那行 iframe、拿到它自己的会话之后，才能 describeNode 换成 backendNodeId。
 */
async function collectHits(session, elementIds, metas, { sanitize, hits, limit, assigned = null, keepSemantic = false }) {
  const described = await Promise.all(elementIds.map((objectId) => (assigned?.has(objectId)
    ? undefined
    : session.DOM.describeNode({ objectId })
      .then((describedNode) => describedNode?.node?.backendNodeId)
      .catch(() => undefined))));
  // 元素身份对上了才能认领：同一批扫描结果会给多个框架用，已经分出去的（assigned）不能再算一次
  if (assigned) {
    for (let index = 0; index < limit; index += 1) assigned.add(elementIds[index]);
  }
  // 光标扫描自己消费命中：AX 树里已经有语义的节点（button / checkbox / link…）不需要「救回」，
  // 它只需要隐藏的 file input。以前把有语义的命中也交出去，快照那边会把内置 checkbox 的
  // 角色 / 勾选状态整行换掉，只剩扫描猜出来的提示名（真机 2026-10-27 复现）。
  // 拿不到整树（老会话没开 Accessibility、或假会话里没实现）就当不知道：宁可多给几条命中，
  // 也不能把命中全吞掉 —— 快照那边的 RefMap 只认这里给出的提示名。
  // keepSemantic 时不需要知道 AX 角色（不会跳过任何命中），省掉一次整树读取
  const tree = keepSemantic ? null : await session.Accessibility?.getFullAXTree?.({}).catch(() => null) ?? null;
  const meaningful = tree ? new Map((tree.nodes ?? [])
    .filter((node) => node?.backendDOMNodeId !== undefined)
    .map((node) => [node.backendDOMNodeId, String(node.role?.value ?? "")])) : null;
  const SEMANTIC_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "textarea", "checkbox", "radio", "combobox",
    "listbox", "option", "tab", "switch", "slider", "spinbutton", "menuitem",
    "menuitemcheckbox", "menuitemradio", "treeitem", "DisclosureTriangle",
  ]);
  for (let index = 0; index < limit; index += 1) {
    const backendNodeId = described[index];
    if (backendNodeId === undefined || hits.has(backendNodeId)) continue;
    const meta = metas[index] ?? {};
    const builtInRole = meaningful?.get(backendNodeId);
    // keepSemantic：快照路径要保留这些命中，只为了给「有语义但没名字」的控件补 label / 邻近文字；
    // 角色和勾选状态仍以 AX 树为准（render 只在没有无障碍名时才用提示名）。
    if (!keepSemantic && meta.fileInput !== true && builtInRole && SEMANTIC_ROLES.has(builtInRole)) continue;
    hits.set(backendNodeId, {
      reasons: Array.isArray(meta.reasons) ? meta.reasons : [],
      hint: sanitize(typeof meta.hint === "string" ? meta.hint : ""),
      context: sanitize(typeof meta.context === "string" ? meta.context : ""),
      kind: typeof meta.kind === "string" && meta.kind ? meta.kind : "clickable",
      hidden: meta.hidden === true,
      fileInput: meta.fileInput === true,
    });
  }
  return hits;
}

/**
 * 一次快照只扫一次：在一个框架里跑完扫描拿到原始结果，然后按需把命中分配给各个框架 / 会话。
 *
 * 为什么要这样：快照会为每个同源 / 跨域 iframe 各调一次 findCursorHits；同源 iframe 用的是同一个
 * 页面会话，扫描脚本从主框架执行时本来就能看到同源 iframe 里的元素 —— 每个框架扫一遍既慢，
 * 又会让同一个元素在两个会话里各算一次（编号重复、提示名打架）。
 *
 * 用法：
 *   const scan = await scanCursorInFrame(session, { frameId: 7 });   // 第 7 帧那次扫描
 *   await scan.collect(iframeSession);                               // 跨域 iframe 用自己会话解析
 * 每个元素只会被收集一次（collect 内部的 assigned 表）；分配不到的留在原位，后续框架还能再认领。
 */
export async function scanCursorInFrame(session, { frameId, sanitize = sanitizeHint, max = MAX_CURSOR_HITS, keepSemantic = true } = {}) {
  const empty = { collect: async () => new Map(), hits: new Map() };
  let contextId;
  if (frameId !== undefined) {
    try {
      const world = await session.Page.createIsolatedWorld({ frameId, worldName: "windrise-cursor-scan" });
      contextId = world?.executionContextId;
    } catch {
      contextId = undefined;
    }
    if (contextId === undefined) return empty;
  }
  let resultObjectId;
  try {
    const evaluated = await session.Runtime.evaluate({
      expression: CURSOR_SCAN_JS,
      returnByValue: false,
      awaitPromise: false,
      ...(contextId === undefined ? {} : { contextId }),
    });
    resultObjectId = evaluated.result?.objectId;
  } catch {
    return empty;
  }
  if (!resultObjectId) return empty;
  let elementIds = [];
  let metas = [];
  const release = [];
  try {
    const roots = await session.Runtime.getProperties({ objectId: resultObjectId, ownProperties: true, generatePreview: false });
    const nodesObjectId = roots.result?.find((property) => property.name === "nodes")?.value?.objectId;
    const metaObjectId = roots.result?.find((property) => property.name === "meta")?.value?.objectId;
    if (!nodesObjectId || !metaObjectId) return empty;
    release.push(nodesObjectId, metaObjectId);
    const nodeProps = await session.Runtime.getProperties({ objectId: nodesObjectId, ownProperties: true, generatePreview: false });
    const metaRead = await session.Runtime.callFunctionOn({
      objectId: metaObjectId,
      functionDeclaration: "function () { return this; }",
      returnByValue: true,
    });
    elementIds = (nodeProps.result ?? [])
      .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((property) => property.value.objectId);
    metas = Array.isArray(metaRead?.result?.value) ? metaRead.result.value : [];
  } catch {
    return empty;
  } finally {
    for (const objectId of release) await session.Runtime.releaseObject({ objectId }).catch(() => {});
    await session.Runtime.releaseObject({ objectId: resultObjectId }).catch(() => {});
  }
  const limit = Math.min(elementIds.length, metas.length, max);
  const hits = new Map();
  const assigned = new Set();
  const collect = async (targetSession) => {
    if (!limit) return hits;
    await collectHits(targetSession, elementIds.slice(0, limit), metas, { sanitize, hits, limit, assigned, keepSemantic });
    return hits;
  };
  return { collect, hits };
}
