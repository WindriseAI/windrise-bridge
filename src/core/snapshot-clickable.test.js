/**
 * 可点元素救回逻辑的单元测试（纯 Node，不需要浏览器）：
 *   node --test src/core/snapshot-clickable.test.js
 *
 * 覆盖：
 *   ① render：被无障碍树忽略（ignored）的节点只要光标命中就出现，角色是 clickable / image / icon，带编号；
 *   ② render：真实无障碍名照旧在引号里，合成名单独写在 (提示: …)，不覆盖真名；
 *   ③ render：隐藏的 file input 标 [hidden]，且可被 page_act 定位（有 ref）；
 *   ④ 合成提示名：6 级优先级各一条；
 *   ⑤ 敏感值不泄漏：aria-label / placeholder 命中敏感词整条丢掉，input 的 value 从不进提示名；
 *   ⑥ 扫描：open shadow root 里的元素能扫到；命中上限 300；一次 evaluate 收全部候选。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RefMap } from "../vendor/browseros/core/snapshot/refs.js";
import { renderSnapshot } from "../vendor/browseros/core/snapshot/render.js";
import { resolveRefEntry } from "../vendor/browseros/core/observer/resolve.js";
import { MAX_CURSOR_HITS, collectCandidates, findCursorHits, hintForElement, scanCursorInFrame } from "./snapshot-cursor.js";
import { sanitizeHint } from "./snapshot-redact.js";

/* ---------------- 假 DOM：只实现扫描器真正用到的部分 ---------------- */

function node(tag, props = {}, children = []) {
  const attributes = { ...(props.attributes ?? {}) };
  const el = {
    tagName: tag.toUpperCase(),
    attributes,
    children,
    parentElement: null,
    previousElementSibling: null,
    nextSibling: props.nextSibling ?? null,
    previousSibling: props.previousSibling ?? null,
    labels: props.labels ?? [],
    shadowRoot: props.shadowRoot ?? null,
    type: props.type,
    hidden: props.hidden ?? false,
    onclick: props.onclick ?? null,
    isContentEditable: props.contentEditable ?? false,
    innerText: props.innerText ?? "",
    textContent: props.textContent ?? props.innerText ?? "",
    rect: props.rect ?? { left: 0, top: 0, width: 100, height: 100 },
    style: props.style ?? {},
    ...(props.expando ?? {}),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    getBoundingClientRect() {
      return el.rect;
    },
    querySelectorAll(selector) {
      if (selector !== "*") throw new Error(`假 DOM 只支持 *：${selector}`);
      const out = [];
      const walk = (current) => {
        for (const child of current.children) {
          out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    querySelector(selector) {
      if (selector === "img[alt]") {
        return el.querySelectorAll("*").find((child) => child.tagName === "IMG" && child.hasAttribute("alt")) ?? null;
      }
      if (selector === "svg title") {
        const svg = el.querySelectorAll("*").find((child) => child.tagName === "SVG");
        return svg ? svg.querySelectorAll("*").find((child) => child.tagName === "TITLE") ?? null : null;
      }
      throw new Error(`假 DOM 不支持选择器：${selector}`);
    },
  };
  for (const child of children) {
    child.parentElement = el;
  }
  for (let index = 1; index < children.length; index += 1) {
    children[index].previousElementSibling = children[index - 1];
  }
  el.ownerDocument = {
    getElementById(id) {
      return el.querySelectorAll("*").find((child) => child.getAttribute("id") === id) ?? null;
    },
  };
  return el;
}

/** 扫描入口用的根：扫描器从 root.querySelectorAll('*') 开始，根自己不算候选 */
function scan(root, viewport = { width: 1000, height: 800 }) {
  return collectCandidates(root, viewport, (el) => el.style);
}

/* ---------------- ① 被忽略的节点 ---------------- */

function ax(nodeId, role, opts = {}) {
  const { children, ...rest } = opts;
  return { nodeId, role: { type: "role", value: role }, childIds: children, ...rest };
}

describe("renderSnapshot：被无障碍树忽略的可点元素", () => {
  test("ignored 的 div 只要光标命中就出现，角色 clickable 且带编号", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "generic", { ignored: true, backendDOMNodeId: 42 }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([[42, { reasons: ["cursor:pointer"], kind: "clickable", hint: "添加封面" }]]),
    });
    assert.equal(out.text, '- clickable [ref=e1] [cursor=pointer] (提示: 添加封面)');
  });

  test("ignored 的 img 写 image、svg 写 icon", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2", "3"] }),
      ax("2", "image", { ignored: true, backendDOMNodeId: 7 }),
      ax("3", "generic", { ignored: true, backendDOMNodeId: 8 }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([
        [7, { reasons: ["cursor:pointer"], kind: "image", hint: "封面图" }],
        [8, { reasons: ["cursor:pointer"], kind: "icon", hint: "icon-search" }],
      ]),
    });
    assert.equal(out.text, [
      "- image [ref=e1] [cursor=pointer] (提示: 封面图)",
      "- icon [ref=e2] [cursor=pointer] (提示: icon-search)",
    ].join("\n"));
  });

  test("没有光标命中的 ignored 节点照旧丢掉（子节点照常上提）", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "generic", { ignored: true, backendDOMNodeId: 5, children: ["3"] }),
      ax("3", "button", { name: { type: "computedString", value: "保存" }, backendDOMNodeId: 6 }),
    ];
    assert.equal(renderSnapshot(nodes, { refs: new RefMap() }).text, '- button "保存" [ref=e1]');
  });
});

describe("renderSnapshot：合成提示名与真实名的区分", () => {
  test("真实无障碍名保留在引号里，不再补提示名", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "generic", {
        name: { type: "computedString", value: "添加封面" },
        backendDOMNodeId: 9,
      }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([[9, { reasons: ["cursor:pointer"], kind: "clickable", hint: "别的提示" }]]),
    });
    assert.equal(out.text, '- generic "添加封面" [ref=e1] [cursor=pointer]');
  });

  test("旧的 reasons 数组形状（上游调用方）照常工作", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "generic", { backendDOMNodeId: 11 }),
    ];
    const out = renderSnapshot(nodes, { refs: new RefMap(), cursorHits: new Map([[11, ["onclick"] ]]) });
    assert.equal(out.text, "- generic [ref=e1] [cursor=pointer]");
  });

  test("隐藏的 file input 带 [hidden]，并照样发编号", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "none", { ignored: true, backendDOMNodeId: 21 }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([[21, {
        reasons: ["file-input"], kind: "file-input", hint: "添加封面", hidden: true, fileInput: true,
      }]]),
    });
    assert.equal(out.text, '- file-input [ref=e1] [hidden] (提示: 添加封面)');
  });

  test("无障碍树里没有的命中（display:none 的 file input）追加在最后，编号可用", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "button", { name: { type: "computedString", value: "发布" }, backendDOMNodeId: 3 }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([[99, {
        reasons: ["file-input"], kind: "file-input", hint: "添加封面", hidden: true, fileInput: true,
      }]]),
    });
    assert.equal(out.text, [
      '- button "发布" [ref=e1]',
      "- file-input [ref=e2] [hidden] (提示: 添加封面)",
    ].join("\n"));
  });

  test("树里有节点但被装饰规则丢掉的命中不再补回来", () => {
    const nodes = [
      ax("1", "RootWebArea", { children: ["2"] }),
      ax("2", "generic", { backendDOMNodeId: 4, ignored: false }),
    ];
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([[4, { reasons: ["cursor:pointer"], kind: "clickable" }]]),
    });
    // 有命中就会被提升成 clickable，这里验的是「没有重复出现两行」
    assert.equal(out.text.split("\n").length, 1);
  });
});

/* ---------------- ④ 提示名 6 级优先级 ---------------- */

const VIEWPORT = { width: 1000, height: 800 };

describe("hintForElement：6 级优先级", () => {
  test("1 级：aria-label / title / alt / placeholder / data-tooltip / aria-describedby", () => {
    assert.equal(hintForElement(node("div", { attributes: { "aria-label": "添加封面" } }), VIEWPORT).hint, "添加封面");
    assert.equal(hintForElement(node("div", { attributes: { title: "关闭" } }), VIEWPORT).hint, "关闭");
    assert.equal(hintForElement(node("div", { attributes: { alt: "头像" } }), VIEWPORT).hint, "头像");
    assert.equal(hintForElement(node("div", { attributes: { placeholder: "搜索" } }), VIEWPORT).hint, "搜索");
    assert.equal(hintForElement(node("div", { attributes: { "data-tooltip": "换一换" } }), VIEWPORT).hint, "换一换");
    const described = node("div", { attributes: { "aria-describedby": "tip" } }, [
      node("span", { attributes: { id: "tip" }, textContent: "点击上传封面" }),
    ]);
    assert.equal(hintForElement(described, VIEWPORT).hint, "点击上传封面");
  });

  test("2 级：自己的可见文字，压空白并截到 30 字", () => {
    const el = node("div", { innerText: "  上传   封面\n " });
    assert.equal(hintForElement(el, VIEWPORT).hint, "上传 封面");
    const long = node("div", { innerText: "字".repeat(50) });
    assert.equal(hintForElement(long, VIEWPORT).hint.length, 30);
  });

  test("3 级：子元素 img 的 alt，或 svg 里 <title> 的文字", () => {
    const withImg = node("div", {}, [node("img", { attributes: { alt: "封面预览" } })]);
    assert.equal(hintForElement(withImg, VIEWPORT).hint, "封面预览");
    const withSvg = node("div", {}, [
      node("svg", {}, [node("title", { textContent: "放大" })]),
    ]);
    assert.equal(hintForElement(withSvg, VIEWPORT).hint, "放大");
  });

  test("4 级：class / id 里有意义的词，最多 3 个，hash 乱码去掉", () => {
    const el = node("div", { attributes: { class: "upload-cover css-1a2b3c4d icon-search btn-close extra" } });
    assert.equal(hintForElement(el, VIEWPORT).hint, "upload cover icon");
    const hashed = node("div", { attributes: { class: "sc-bdVaJa k9F2xQ1z" } });
    assert.equal(hintForElement(hashed, VIEWPORT).level, 6, "全乱码时退到位置和尺寸");
  });

  test("5 级：前一个兄弟的文字，或父级的可见文字", () => {
    const previous = node("div", { textContent: "封面" });
    const target = node("div", {});
    const parent = node("div", {}, [previous, target]);
    assert.equal(hintForElement(target, VIEWPORT).hint, "封面");
    const lone = node("div", {});
    node("div", { textContent: "上传封面图片" }, [lone]);
    assert.equal(hintForElement(lone, VIEWPORT).hint, "上传封面图片");
  });

  test("6 级：位置和尺寸", () => {
    const el = node("div", { rect: { left: 800, top: 10, width: 32, height: 32 } });
    assert.equal(hintForElement(el, VIEWPORT).hint, "右上 32×32");
    const offscreen = node("div", { rect: { left: -200, top: 10, width: 40, height: 20 } });
    assert.equal(hintForElement(offscreen, VIEWPORT).hint, "视口外 40×20");
  });

  test("表单控件：label / 紧邻文本优先，同一组复选框不再共用父容器整段文字", () => {
    const label = node("label", { textContent: "接收通知" });
    const labeled = node("input", { type: "checkbox", labels: [label] });
    assert.equal(hintForElement(labeled, VIEWPORT).hint, "接收通知");

    // the-internet 的 checkboxes：文字是 input 后面的文本节点，不是 <label>
    const first = node("input", { type: "checkbox", nextSibling: { nodeType: 3, textContent: " checkbox 1" } });
    const second = node("input", { type: "checkbox", nextSibling: { nodeType: 3, textContent: " checkbox 2" } });
    node("form", {}, [first, second]);
    assert.equal(hintForElement(first, VIEWPORT).hint, "checkbox 1");
    assert.equal(hintForElement(second, VIEWPORT).hint, "checkbox 2");
    assert.notEqual(hintForElement(first, VIEWPORT).hint, hintForElement(second, VIEWPORT).hint);
  });
});

/* ---------------- ⑤ 敏感值不泄漏 ---------------- */

describe("提示名不泄漏敏感值", () => {
  test("命中敏感词整条丢掉", () => {
    assert.equal(sanitizeHint("输入支付密码"), "");
    assert.equal(sanitizeHint("验证码"), "");
    assert.equal(sanitizeHint("card number"), "");
  });

  test("长数字换成 [已隐藏]，只有数字的整条丢掉", () => {
    assert.equal(sanitizeHint("尾号 6222021234567890"), "尾号 [已隐藏]");
    assert.equal(sanitizeHint("6222021234567890"), "");
  });

  test("input 的 value 从不进提示名（扫描只读属性和可见文字）", () => {
    const input = node("input", { type: "text", attributes: { value: "hunter2" }, rect: { left: 10, top: 10, width: 200, height: 30 } });
    const hint = hintForElement(input, VIEWPORT).hint;
    assert.ok(!hint.includes("hunter2"), `提示名里出现了输入值：${hint}`);
  });

  test("扫描结果回到 Node 侧时已经过 sanitizeHint", async () => {
    const root = node("div", {}, [
      node("div", { attributes: { "aria-label": "支付密码" }, style: { cursor: "pointer" }, rect: { left: 10, top: 10, width: 100, height: 40 } }),
    ]);
    const { meta } = scan(root);
    assert.equal(meta.length, 1);
    // 页面脚本只负责取原文（它拿不到 Node 侧的敏感词表），过滤在 findCursorHits 里做
    assert.equal(meta[0].hint, "支付密码");
    const session = {
      Runtime: {
        evaluate: async () => ({ result: { objectId: "scan-root" } }),
        getProperties: async ({ objectId }) => (objectId === "scan-root"
          ? { result: [{ name: "nodes", value: { objectId: "nodes" } }, { name: "meta", value: { objectId: "meta" } }] }
          : { result: [{ name: "0", value: { objectId: "el-0" } }] }),
        callFunctionOn: async () => ({ result: { value: meta } }),
        releaseObject: async () => ({}),
      },
      DOM: { describeNode: async () => ({ node: { backendNodeId: 77 } }) },
    };
    const hits = await findCursorHits(session);
    assert.equal(hits.get(77)?.hint, "", "敏感词命中的提示名必须整条丢掉");
  });
});

/* ---------------- ⑥ 扫描：shadow DOM、上限、批量 ---------------- */

describe("collectCandidates", () => {
  test("进 open shadow root（递归）", () => {
    const inner = node("div", { attributes: { "aria-label": "确认" }, style: { cursor: "pointer" }, rect: { left: 10, top: 10, width: 80, height: 30 } });
    const shadow = node("div", {}, [inner]);
    const host = node("div", { shadowRoot: shadow });
    const root = node("div", {}, [host]);
    const { meta } = scan(root);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].hint, "确认");
  });

  test("命中上限 300，视口内的优先保留", () => {
    const children = [];
    for (let index = 0; index < 400; index += 1) {
      const inView = index < 40;
      children.push(node("div", {
        attributes: { "aria-label": `项 ${index}` },
        style: { cursor: "pointer" },
        rect: inView
          ? { left: 10, top: 10, width: 100, height: 20 }
          : { left: 10, top: 5000, width: 100, height: 20 },
      }));
    }
    const { meta } = scan(node("div", {}, children));
    assert.equal(meta.length, MAX_CURSOR_HITS);
    const inViewCount = meta.filter((item) => /项 \d+/.test(item.hint)).length;
    assert.equal(inViewCount, MAX_CURSOR_HITS);
  });

  test("带 data-e2e 的卡片能被认出来（抖音封面卡片没有 cursor:pointer）", () => {
    const card = node("div", {
      attributes: { "data-e2e": "cover-upload" },
      rect: { left: 10, top: 10, width: 320, height: 180 },
    }, [node("img", { attributes: { alt: "封面" }, rect: { left: 10, top: 10, width: 320, height: 180 } })]);
    const root = node("div", {}, [card]);
    const { meta } = scan(root);
    assert.equal(meta.length, 1);
    assert.ok(meta[0].reasons.includes("testid-card"));
    assert.equal(meta[0].kind, "clickable");
  });

  test("隐藏的 file input 会进结果，标记 hidden", () => {
    const file = node("input", {
      type: "file",
      hidden: true,
      attributes: { "aria-label": "添加封面" },
      rect: { left: 0, top: 0, width: 0, height: 0 },
    });
    const { meta } = scan(node("div", {}, [file]));
    assert.equal(meta.length, 1);
    assert.equal(meta[0].kind, "file-input");
    assert.equal(meta[0].hidden, true);
    assert.equal(meta[0].hint, "添加封面");
  });

  test("没有 cursor:pointer 的原生复选框也会进结果，提示名按邻近文字区分", () => {
    const first = node("input", {
      type: "checkbox",
      nextSibling: { nodeType: 3, textContent: " checkbox 1" },
      rect: { left: 10, top: 10, width: 13, height: 13 },
    });
    const second = node("input", {
      type: "checkbox",
      nextSibling: { nodeType: 3, textContent: " checkbox 2" },
      rect: { left: 10, top: 40, width: 13, height: 13 },
    });
    const { meta } = scan(node("form", {}, [first, second]));
    assert.equal(meta.length, 2);
    assert.deepEqual(meta.map((item) => item.hint), ["checkbox 1", "checkbox 2"]);
    assert.ok(meta.every((item) => item.reasons.includes("form-control")));
  });
});

/* ---------------- React 页面：只有真的带 onClick 才算命中 ---------------- */

/** React 在**每个**元素上都留 __reactFiber$ 和 __reactProps$，props 里通常没有事件 */
function reactExpando(handlers = {}) {
  return {
    __reactFiber$abc123: { tag: 5, memoizedProps: {} },
    __reactProps$abc123: { className: "x", children: null, ...handlers },
  };
}

describe("React / Vue 的框架事件属性", () => {
  test("每个元素都有 fiber 和 props，只有 props 里带 onClick 的才进快照", () => {
    const wrapper = node("div", {
      expando: reactExpando(),
      rect: { left: 10, top: 10, width: 300, height: 200 },
    });
    const clicked = node("div", {
      expando: reactExpando({ onClick: () => {} }),
      attributes: { "aria-label": "发布" },
      rect: { left: 10, top: 10, width: 300, height: 60 },
    });
    const plain = node("div", {
      expando: reactExpando(),
      attributes: { "aria-label": "纯展示" },
      rect: { left: 10, top: 80, width: 300, height: 60 },
    });
    wrapper.children = [clicked, plain];
    for (const child of wrapper.children) child.parentElement = wrapper;

    const { meta } = scan(node("div", {}, [wrapper]));
    assert.equal(meta.length, 1, `只该有带 onClick 的那个，实际：${JSON.stringify(meta.map((m) => m.hint))}`);
    assert.equal(meta[0].hint, "发布");
    assert.deepEqual(meta[0].reasons, ["handler"]);
  });

  test("__reactFiber$ 单独存在不算命中", () => {
    const el = node("div", {
      expando: { __reactFiber$zzz: { tag: 5 } },
      attributes: { "aria-label": "只有 fiber" },
      rect: { left: 10, top: 10, width: 100, height: 40 },
    });
    assert.equal(scan(node("div", {}, [el])).meta.length, 0);
  });

  test("Vue 的 _vei 只有真的带 onXxx 才算命中", () => {
    const empty = node("div", {
      expando: { _vei: {} },
      attributes: { "aria-label": "空处理器表" },
      rect: { left: 10, top: 10, width: 100, height: 40 },
    });
    const clicked = node("div", {
      expando: { _vei: { "onClick|": () => {} } },
      attributes: { "aria-label": "Vue 点击" },
      rect: { left: 10, top: 60, width: 100, height: 40 },
    });
    const { meta } = scan(node("div", {}, [empty, clicked]));
    assert.equal(meta.length, 1);
    assert.equal(meta[0].hint, "Vue 点击");
  });
});

/* ---------------- 包装层折叠 ---------------- */

describe("包装层折叠与排序", () => {
  test("父子大小几乎相同、里面只有一个命中 → 只留里面那个", () => {
    const inner = node("div", {
      attributes: { "aria-label": "内容管理" },
      style: { cursor: "pointer" },
      rect: { left: 10, top: 10, width: 200, height: 40 },
    });
    const outer = node("div", {
      attributes: { "aria-label": "内容管理" },
      style: { cursor: "pointer" },
      rect: { left: 10, top: 10, width: 202, height: 42 },
    });
    outer.children = [inner];
    inner.parentElement = outer;
    const { meta } = scan(node("div", {}, [outer]));
    assert.equal(meta.length, 1, `包装层应该被折叠，实际 ${meta.length} 行`);
  });

  test("外层明显更大（是容器，不是包装）时两层都保留", () => {
    const inner = node("div", {
      attributes: { "aria-label": "编辑作品" },
      onclick: () => {},
      rect: { left: 10, top: 10, width: 60, height: 20 },
    });
    const outer = node("div", {
      attributes: { "aria-label": "作品卡片" },
      style: { cursor: "pointer" },
      rect: { left: 10, top: 10, width: 600, height: 300 },
    });
    outer.children = [inner];
    inner.parentElement = outer;
    const { meta } = scan(node("div", {}, [outer]));
    assert.equal(meta.length, 2);
  });

  test("十几层同样的提示名一路塌成一层", () => {
    let current = node("div", {
      attributes: { "aria-label": "内容管理" },
      style: { cursor: "pointer" },
      rect: { left: 0, top: 0, width: 200, height: 40 },
    });
    let parent = current;
    for (let depth = 0; depth < 12; depth += 1) {
      const wrapper = node("div", {
        attributes: { "aria-label": "内容管理" },
        style: { cursor: "pointer" },
        rect: { left: 0, top: 0, width: 200 + (depth % 2), height: 40 },
      });
      wrapper.children = [parent];
      parent.parentElement = wrapper;
      parent = wrapper;
    }
    const { meta } = scan(node("div", {}, [parent]));
    assert.equal(meta.length, 1, `13 层同名包装应该只剩 1 行，实际 ${meta.length}`);
  });

  test("只有 handler 的命中，祖先 3 层内同名同提示 → 丢掉", () => {
    const ancestor = node("div", {
      attributes: { "aria-label": "作品发布 首页 内容管理" },
      style: { cursor: "pointer" },
      rect: { left: 0, top: 0, width: 300, height: 300 },
    });
    const middle = node("div", { rect: { left: 0, top: 0, width: 100, height: 40 } });
    const inner = node("div", {
      expando: reactExpando({ onClick: () => {} }),
      attributes: { "aria-label": "作品发布 首页 内容管理" },
      rect: { left: 0, top: 0, width: 50, height: 20 },
    });
    ancestor.children = [middle];
    middle.parentElement = ancestor;
    middle.children = [inner];
    inner.parentElement = middle;
    const { meta } = scan(node("div", {}, [ancestor]));
    assert.equal(meta.length, 1, "只有 handler 的重复包装要丢掉");
    assert.ok(meta[0].reasons.includes("cursor:pointer"));
  });

  test("强理由排在只有 handler 的前面（命中超上限时先保强理由）", () => {
    const strong = [];
    for (let index = 0; index < 5; index += 1) {
      strong.push(node("div", {
        attributes: { "aria-label": `强 ${index}` },
        style: { cursor: "pointer" },
        rect: { left: 0, top: 0, width: 100, height: 20 },
      }));
    }
    const weak = node("div", {
      expando: reactExpando({ onClick: () => {} }),
      attributes: { "aria-label": "弱" },
      rect: { left: 0, top: 0, width: 900, height: 700 },
    });
    const { meta } = scan(node("div", {}, [...strong, weak]));
    assert.equal(meta.length, 6);
    assert.equal(meta[meta.length - 1].hint, "弱", "只有 handler 的必须垫底");
  });
});

describe("resolveRefEntry：光标扫描救回的元素", () => {
  function stubSession({ live, axTree = [] }) {
    return {
      DOM: {
        resolveNode: async ({ backendNodeId }) => {
          if (!live.has(backendNodeId)) throw new Error("No node with given id");
          return { object: { objectId: `obj-${backendNodeId}` } };
        },
      },
      Accessibility: { getFullAXTree: async () => ({ nodes: axTree }) },
      Runtime: { releaseObject: async () => ({}) },
    };
  }

  test("第一层照旧按 backendNodeId 解析（被忽略的节点也走得通）", async () => {
    const refs = new RefMap();
    const ref = refs.mint({ backendNodeId: 30, role: "clickable", name: "" });
    const resolved = await resolveRefEntry(stubSession({ live: new Set([30]) }), refs.get(ref));
    assert.equal(resolved.backendNodeId, 30);
  });

  test("元素没了就报过期，不按 role+name 撞到别的节点", async () => {
    const refs = new RefMap();
    const ref = refs.mint({ backendNodeId: 30, role: "clickable", name: "" });
    // 树里放一个同角色同名字的节点：第二层重查会把它当成目标，那是另一个元素
    const axTree = [
      { nodeId: "root", role: { type: "role", value: "RootWebArea" }, childIds: ["a"] },
      { nodeId: "a", role: { type: "role", value: "clickable" }, name: { type: "computedString", value: "" }, backendDOMNodeId: 40 },
    ];
    await assert.rejects(
      () => resolveRefEntry(stubSession({ live: new Set([40]), axTree }), refs.get(ref)),
      /Stale ref/,
    );
    assert.equal(refs.get(ref)?.backendNodeId, 30, "缓存不能被错节点顶掉");
  });
});

describe("findCursorHits：往返次数与命中数无关", () => {
  /** 假 CDP 会话：只实现扫描器用到的四个方法，并数往返次数 */
  function fakeSession(candidates) {
    const calls = { evaluate: 0, getProperties: 0, callFunctionOn: 0, describeNode: 0 };
    const session = {
      Runtime: {
        evaluate: async () => {
          calls.evaluate += 1;
          return { result: { objectId: "scan-root" } };
        },
        getProperties: async ({ objectId }) => {
          calls.getProperties += 1;
          if (objectId === "scan-root") {
            return { result: [{ name: "nodes", value: { objectId: "nodes" } }, { name: "meta", value: { objectId: "meta" } }] };
          }
          return {
            result: candidates.map((_, index) => ({ name: String(index), value: { objectId: `el-${index}` } })),
          };
        },
        callFunctionOn: async () => ({ result: { value: candidates } }),
        releaseObject: async () => ({}),
      },
      DOM: {
        describeNode: async ({ objectId }) => {
          calls.describeNode += 1;
          return { node: { backendNodeId: Number(objectId.slice(3)) + 100 } };
        },
      },
    };
    return { session, calls };
  }

  test("一次 evaluate、一次 getProperties 拿全部元素、describeNode 并发", async () => {
    const candidates = [
      { kind: "clickable", reasons: ["cursor:pointer"], hint: "添加封面", hidden: false, fileInput: false },
      { kind: "icon", reasons: ["onclick"], hint: "icon-search", hidden: false, fileInput: false },
    ];
    const { session, calls } = fakeSession(candidates);
    const hits = await findCursorHits(session);
    assert.equal(calls.evaluate, 1);
    assert.equal(calls.getProperties, 2, "扫描结果和元素数组各一次");
    assert.equal(calls.describeNode, 2);
    assert.equal(hits.size, 2);
    assert.deepEqual(hits.get(100), {
      reasons: ["cursor:pointer"], hint: "添加封面", context: "", kind: "clickable", hidden: false, fileInput: false,
    });
  });

  test("扫描脚本自身抛错时返回空表（不拖垮整次快照）", async () => {
    const { session } = fakeSession([]);
    session.Runtime.evaluate = async () => {
      throw new Error("Cannot find context");
    };
    assert.equal((await findCursorHits(session)).size, 0);
  });

  test("同源 iframe 用 createIsolatedWorld 拿到的上下文扫", async () => {
    const candidates = [{ kind: "clickable", reasons: ["cursor:pointer"], hint: "播放", hidden: false, fileInput: false }];
    const { session } = fakeSession(candidates);
    const used = [];
    session.Page = {
      createIsolatedWorld: async ({ frameId }) => {
        used.push(frameId);
        return { executionContextId: 7 };
      },
    };
    const original = session.Runtime.evaluate;
    session.Runtime.evaluate = async (params) => {
      assert.equal(params.contextId, 7);
      return original(params);
    };
    const hits = await findCursorHits(session, { frameId: "child-frame" });
    assert.deepEqual(used, ["child-frame"]);
    assert.equal(hits.size, 1);
  });
});

/* ---------------- ⑦ 重名提示名：补区分文字 ---------------- */

/**
 * 抖音创作中心封面卡片的固定夹具（假 DOM，不跑浏览器）：
 *   两张卡片都只有「选择封面」一行字，第一张旁边多一行「竖封面3:4」，第二张旁边什么都没有。
 * 第一张的父容器 textContent 里带着提示名本身，所以第二张往上找祖先兄弟时只拿到
 * 「选择封面 竖封面3:4」—— 和提示名重叠，按规则不算区分文字，正好覆盖「取不到就用序号」。
 */
function coverCardsFixture() {
  const card1 = node("div", {
    innerText: "选择封面",
    style: { cursor: "pointer" },
    rect: { left: 10, top: 10, width: 320, height: 180 },
  });
  const label = node("span", { textContent: "竖封面3:4", rect: { left: 10, top: 200, width: 80, height: 20 } });
  const group1 = node("div", { textContent: "选择封面 竖封面3:4" }, [card1, label]);
  const card2 = node("div", {
    innerText: "选择封面",
    style: { cursor: "pointer" },
    rect: { left: 400, top: 10, width: 320, height: 180 },
  });
  const group2 = node("div", { textContent: "选择封面" }, [card2]);
  return node("div", {}, [group1, group2]);
}

/** 把扫描结果包成 render 要的 Map<backendNodeId, hit>，编号从 start 起 */
function hitsFrom(meta, start = 501) {
  const hits = new Map();
  meta.forEach((item, index) => {
    hits.set(start + index, { ...item, hint: sanitizeHint(item.hint), context: sanitizeHint(item.context) });
  });
  return hits;
}

function ignoredCards(count) {
  const children = [];
  for (let index = 0; index < count; index += 1) children.push(String(index + 2));
  const nodes = [ax("1", "RootWebArea", { children })];
  for (let index = 0; index < count; index += 1) {
    nodes.push(ax(String(index + 2), "generic", { ignored: true, backendDOMNodeId: 501 + index }));
  }
  return nodes;
}

describe("重名提示名：补区分文字", () => {
  test("固定夹具：同名封面卡片，有兄弟文字的用文字、没有的用序号", () => {
    const { meta } = scan(coverCardsFixture());
    assert.equal(meta.length, 2, `两张卡片各一行，实际：${JSON.stringify(meta.map((m) => m.hint))}`);
    assert.deepEqual(meta.map((m) => m.hint), ["选择封面", "选择封面"]);
    assert.equal(meta[0].context, "竖封面3:4");
    assert.equal(meta[1].context, "");

    const out = renderSnapshot(ignoredCards(2), { refs: new RefMap(), cursorHits: hitsFrom(meta) });
    assert.equal(out.text, [
      "- clickable [ref=e1] [cursor=pointer] (提示: 选择封面 · 竖封面3:4)",
      "- clickable [ref=e2] [cursor=pointer] (提示: 选择封面 · 第 2 个)",
    ].join("\n"));
  });

  test("都取不到区分文字时，按出现顺序编号", () => {
    const out = renderSnapshot(ignoredCards(2), {
      refs: new RefMap(),
      cursorHits: new Map([
        [501, { reasons: ["cursor:pointer"], kind: "clickable", hint: "选择封面", context: "" }],
        [502, { reasons: ["cursor:pointer"], kind: "clickable", hint: "选择封面", context: "" }],
      ]),
    });
    assert.equal(out.text, [
      "- clickable [ref=e1] [cursor=pointer] (提示: 选择封面 · 第 1 个)",
      "- clickable [ref=e2] [cursor=pointer] (提示: 选择封面 · 第 2 个)",
    ].join("\n"));
  });

  test("区分文字本身重复（两张卡片都是「竖封面3:4」）也退回序号", () => {
    const out = renderSnapshot(ignoredCards(2), {
      refs: new RefMap(),
      cursorHits: new Map([
        [501, { reasons: ["cursor:pointer"], kind: "clickable", hint: "选择封面", context: "竖封面3:4" }],
        [502, { reasons: ["cursor:pointer"], kind: "clickable", hint: "选择封面", context: "竖封面3:4" }],
      ]),
    });
    assert.equal(out.text, [
      "- clickable [ref=e1] [cursor=pointer] (提示: 选择封面 · 第 1 个)",
      "- clickable [ref=e2] [cursor=pointer] (提示: 选择封面 · 第 2 个)",
    ].join("\n"));
  });

  test("唯一的提示名不受影响：扫描给了区分文字也不追加", () => {
    const out = renderSnapshot(ignoredCards(2), {
      refs: new RefMap(),
      cursorHits: new Map([
        [501, { reasons: ["cursor:pointer"], kind: "clickable", hint: "添加封面", context: "竖封面3:4" }],
        [502, { reasons: ["cursor:pointer"], kind: "clickable", hint: "更换封面", context: "横封面4:3" }],
      ]),
    });
    assert.equal(out.text, [
      "- clickable [ref=e1] [cursor=pointer] (提示: 添加封面)",
      "- clickable [ref=e2] [cursor=pointer] (提示: 更换封面)",
    ].join("\n"));
  });

  test("区分文字压空白、截到 20 字，和提示名重叠的不算", () => {
    const card1 = node("div", {
      innerText: "选择封面",
      style: { cursor: "pointer" },
      rect: { left: 10, top: 10, width: 320, height: 180 },
    });
    const label1 = node("span", {
      textContent: `  竖封面3:4\n${"很长的说明".repeat(4)}  `,
      rect: { left: 10, top: 200, width: 80, height: 20 },
    });
    const group1 = node("div", { textContent: "选择封面" }, [card1, label1]);
    // 第二张卡片只有一段和提示名一样的兄弟文字 → 不算区分文字
    const card2 = node("div", {
      innerText: "选择封面",
      style: { cursor: "pointer" },
      rect: { left: 400, top: 10, width: 320, height: 180 },
    });
    const sameLabel = node("span", { textContent: "选择封面", rect: { left: 400, top: 200, width: 80, height: 20 } });
    const group2 = node("div", { textContent: "选择封面" }, [card2, sameLabel]);

    const { meta } = scan(node("div", {}, [group1, group2]));
    assert.equal(meta.length, 2);
    assert.equal(meta[0].context, "竖封面3:4 很长的说明很长的说明很长的");
    assert.equal(meta[0].context.length, 20, "区分文字最多 20 字");
    assert.equal(meta[1].context, "");
  });

  test("扫描句柄 collect 两次：第二次不再对已分配元素发 describeNode", async () => {
    let describes = 0;
    const session = {
      Runtime: {
        evaluate: async () => ({ result: { objectId: "scan-root" } }),
        getProperties: async ({ objectId }) => (objectId === "scan-root"
          ? { result: [{ name: "nodes", value: { objectId: "nodes" } }, { name: "meta", value: { objectId: "meta" } }] }
          : { result: [
            { name: "0", value: { objectId: "el-0" } },
            { name: "1", value: { objectId: "el-1" } },
          ] }),
        callFunctionOn: async () => ({ result: { value: [{ hint: "A" }, { hint: "B" }] } }),
        releaseObject: async () => ({}),
      },
      DOM: {
        describeNode: async ({ objectId }) => {
          describes += 1;
          return { node: { backendNodeId: objectId === "el-0" ? 10 : 20 } };
        },
      },
    };
    const scan = await scanCursorInFrame(session, { keepSemantic: true });
    const first = await scan.collect(session);
    assert.equal(first.size, 2);
    assert.equal(describes, 2, "第一次每个元素各 describeNode 一次");
    const second = await scan.collect(session);
    assert.equal(second.size, 2);
    assert.equal(describes, 2, "同一个扫描句柄第二次收集不能再发 describeNode");
  });

  test("隐藏的 file input 重名时也按序号区分", () => {
    const nodes = ignoredCards(1);
    const out = renderSnapshot(nodes, {
      refs: new RefMap(),
      cursorHits: new Map([
        [501, { reasons: ["file-input"], kind: "file-input", hint: "添加封面", hidden: true, fileInput: true, context: "" }],
        [601, { reasons: ["file-input"], kind: "file-input", hint: "添加封面", hidden: true, fileInput: true, context: "" }],
      ]),
    });
    assert.equal(out.text, [
      "- file-input [ref=e1] [hidden] (提示: 添加封面 · 第 1 个)",
      "- file-input [ref=e2] [hidden] (提示: 添加封面 · 第 2 个)",
    ].join("\n"));
  });
});
