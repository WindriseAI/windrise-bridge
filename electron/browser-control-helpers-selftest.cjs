/**
 * browser-control 注入辅助函数自测：密码框、验证码框的值不进快照，普通输入框保留可分辨的标签，
 * 旧版辅助函数会被新版替换。用假 DOM 在 node:vm 里跑，不依赖 Electron。
 * 用法：node electron/browser-control-helpers-selftest.cjs
 */

const vm = require("node:vm");
const assert = require("node:assert");
const { PAGE_HELPERS } = require("./browser-control.cjs");

function makeElement({
  tagName = "INPUT",
  type = "text",
  value = "",
  attributes = {},
  parentElement = null,
  labels = [],
  textContent = "",
  children = [],
  maxLength,
  previousElementSibling = null,
  nextElementSibling = null,
} = {}) {
  return {
    nodeType: 1,
    tagName,
    type,
    value,
    id: attributes.id || "",
    name: attributes.name || "",
    innerText: textContent,
    textContent,
    disabled: false,
    parentElement,
    labels,
    children,
    previousElementSibling,
    nextElementSibling,
    maxLength: maxLength ?? Number.parseInt(attributes.maxlength ?? "", 10),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    getBoundingClientRect() {
      return { width: 100, height: 20 };
    },
    closest(selector) {
      if (selector !== "label") return null;
      return parentElement?.tagName === "LABEL" ? parentElement : null;
    },
    contains() {
      return false;
    },
  };
}

function createSandbox(elements) {
  const sandbox = {
    document: {
      querySelectorAll: () => elements,
      getElementById: id => elements.find(element => element.id === id) || null,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    CSS: { escape: s => s },
  };
  sandbox.window = sandbox;
  return { sandbox, context: vm.createContext(sandbox) };
}

function createPage(elements) {
  const page = createSandbox(elements);
  vm.runInContext(PAGE_HELPERS, page.context);
  return { ...page, helpers: page.sandbox.window.__bridgeHelpers };
}

const password = makeElement({ type: "password", value: "hunter2", attributes: { type: "password" } });
const passwordUpper = makeElement({ type: "PASSWORD", value: "upper-secret", attributes: { type: "PASSWORD" } });
const passwordWithPlaceholder = makeElement({
  type: "password",
  value: "hunter2",
  attributes: { type: "password", placeholder: "请输入密码" },
});
const passwordSwitchedToText = makeElement({
  type: "text",
  value: "switched-secret",
  attributes: { type: "text", name: "login_password", autocomplete: "current-password" },
});
const oneTimeCode = makeElement({
  type: "text",
  value: "123456",
  attributes: { type: "text", autocomplete: "one-time-code" },
});
const card = makeElement({
  type: "text",
  value: "4111 1111 1111 1111",
  attributes: { type: "text", name: "field1" },
});
const idCard = makeElement({
  type: "text",
  value: "11010519491231002X",
  attributes: { type: "text", name: "field2" },
});
const oldIdCard = makeElement({
  type: "text",
  value: "110105491231002",
  attributes: { type: "text", name: "field-old" },
});
const captchaHintText = makeElement({ tagName: "SPAN", textContent: "短信验证码" });
const captchaParent = { innerText: "短信验证码", children: [captchaHintText], childNodes: [] };
const captchaNearby = makeElement({
  type: "text",
  value: "654321",
  attributes: { type: "text", name: "field3" },
  parentElement: captchaParent,
});
captchaParent.children.push(captchaNearby);
captchaNearby.previousElementSibling = captchaHintText;
const plain = makeElement({ type: "text", value: "hello", attributes: { type: "text" } });
const search = makeElement({ type: "search", value: "TA-666", attributes: { type: "search", name: "q" } });
const email = makeElement({ type: "email", value: "user@example.com", attributes: { type: "email", name: "email" } });
const emailLabelled = makeElement({
  type: "email",
  value: "user@example.com",
  attributes: { type: "email", name: "email2" },
  labels: [{ innerText: "邮箱" }],
});
const note = makeElement({ tagName: "TEXTAREA", value: "普通备注", attributes: { name: "note" } });
const submit = makeElement({ type: "submit", value: "提交", attributes: { type: "submit" } });
const byLabel = makeElement({
  type: "text",
  value: "123",
  attributes: { type: "text", id: "x1", name: "f1" },
  labels: [{ innerText: "CVC" }],
});
const labelledPassword = makeElement({
  type: "text",
  value: "MuiShown-Secret1",
  attributes: { type: "text", id: "x2", name: "f2" },
  labels: [{ innerText: "Password" }],
});
const ariaLabelled = makeElement({
  type: "text",
  value: "456",
  attributes: { type: "text", id: "x3", "aria-labelledby": "l3" },
});
const ariaLabelSource = makeElement({ tagName: "SPAN", attributes: { id: "l3" }, textContent: "Security code" });
const titlePassword = makeElement({
  type: "text",
  value: "789",
  attributes: { type: "text", id: "x4", title: "Password" },
});
const securityPin = makeElement({
  type: "text",
  value: "4321",
  attributes: { type: "text", id: "x5", name: "f5" },
  labels: [{ innerText: "Security PIN" }],
});
const hantPassword = makeElement({
  type: "text",
  value: "Hant-Secret",
  attributes: { type: "text", id: "x6", name: "f6" },
  labels: [{ innerText: "密碼" }],
});
const jaPassword = makeElement({
  type: "text",
  value: "Ja-Secret",
  attributes: { type: "text", id: "x7", name: "f7" },
  labels: [{ innerText: "パスワード" }],
});
const koPassword = makeElement({
  type: "text",
  value: "Ko-Secret",
  attributes: { type: "text", id: "x8", name: "f8" },
  labels: [{ innerText: "비밀번호" }],
});
const splitDigit = makeElement({
  type: "text",
  value: "3",
  attributes: { type: "text", id: "digit-1", "aria-label": "Digit 1", maxlength: "1", inputmode: "numeric" },
});
const businessName = makeElement({
  type: "text",
  value: "Acme Trading",
  attributes: { type: "text", name: "businessName" },
});
const passengerName = makeElement({
  type: "text",
  value: "Zhang Wei",
  attributes: { type: "text", name: "passengerName" },
});
const labelledCity = makeElement({
  type: "text",
  value: "Shanghai",
  attributes: { type: "text", id: "city", name: "city" },
  labels: [{ innerText: "City" }],
});
// 验证码提示只能藏「像验证码的值」：手机号、邮编、促销码、数量都不能因为旁边有「验证码」就被当成敏感框。
const phoneWithCaptcha = makeElement({
  type: "tel",
  value: "13800138000",
  attributes: { type: "tel", name: "phone", inputmode: "numeric" },
  labels: [{ innerText: "请输入手机号" }],
});
const phoneCaptchaHint = makeElement({ tagName: "SPAN", textContent: "请输入验证码" });
phoneWithCaptcha.previousElementSibling = phoneCaptchaHint;
phoneWithCaptcha.parentElement = { innerText: "", childNodes: [], children: [phoneCaptchaHint, phoneWithCaptcha] };
const postalCode = makeElement({
  type: "text",
  value: "200000",
  attributes: { type: "text", id: "postal" },
  labels: [{ innerText: "邮政编码" }],
});
const zipCode = makeElement({
  type: "text",
  value: "94103",
  attributes: { type: "text", id: "zip", placeholder: "Zip code" },
});
const promoCode = makeElement({
  type: "text",
  value: "SAVE20",
  attributes: { type: "text", id: "promo" },
  labels: [{ innerText: "Promo code" }],
});
const quantity = makeElement({
  type: "text",
  value: "2",
  attributes: { type: "text", id: "qty", inputmode: "numeric" },
  labels: [{ innerText: "Quantity" }],
});
const realCode = makeElement({
  type: "text",
  value: "482913",
  attributes: { type: "text", id: "real-code", name: "code" },
});

const page = createPage([
  password, passwordUpper, passwordWithPlaceholder, passwordSwitchedToText, oneTimeCode, card, idCard, oldIdCard,
  captchaNearby, plain, search, email, emailLabelled, note, submit, byLabel, labelledPassword, ariaLabelled,
  ariaLabelSource, titlePassword, securityPin, hantPassword, jaPassword, koPassword, splitDigit, businessName,
  passengerName, labelledCity, phoneWithCaptcha, postalCode, zipCode, promoCode, quantity, realCode,
]);
const h = page.helpers;

assert.strictEqual(h.label(password), "input（已填）");
assert.strictEqual(h.label(passwordUpper), "input（已填）");
assert.strictEqual(h.label(passwordWithPlaceholder), "请输入密码（已填）");
assert.strictEqual(h.label(passwordSwitchedToText), "input（已填）");
assert.strictEqual(h.label(oneTimeCode), "input（已填）");
assert.strictEqual(h.label(card), "input（已填）");
assert.strictEqual(h.label(idCard), "input（已填）");
assert.strictEqual(h.label(oldIdCard), "input（已填）");
assert.strictEqual(h.label(captchaNearby), "input（已填）");
assert.strictEqual(h.label(plain), "input（已填 5 字）");
assert.strictEqual(h.label(search), "input（已填 6 字）");
assert.strictEqual(h.label(email), "input（已填 16 字）");
assert.strictEqual(h.label(emailLabelled), "邮箱（已填 16 字）");
assert.strictEqual(h.label(note), "textarea（已填 4 字）");
assert.strictEqual(h.label(submit), "提交");
assert.strictEqual(h.label(byLabel), "CVC（已填）");
assert.strictEqual(h.label(labelledPassword), "Password（已填）");
assert.strictEqual(h.label(ariaLabelled), "Security code（已填）");
assert.strictEqual(h.label(titlePassword), "Password（已填）");
assert.strictEqual(h.label(securityPin), "Security PIN（已填）");
assert.strictEqual(h.label(hantPassword), "密碼（已填）");
assert.strictEqual(h.label(jaPassword), "パスワード（已填）");
assert.strictEqual(h.label(koPassword), "비밀번호（已填）");
assert.strictEqual(h.label(splitDigit), "Digit 1（已填）");
assert.strictEqual(h.label(businessName), "input（已填 12 字）");
assert.strictEqual(h.label(passengerName), "input（已填 9 字）");
assert.strictEqual(h.label(labelledCity), "City（已填 8 字）");
assert.strictEqual(h.label(phoneWithCaptcha), "请输入手机号（已填 11 字）");
assert.strictEqual(h.label(postalCode), "邮政编码（已填 6 字）");
assert.strictEqual(h.label(zipCode), "Zip code（已填 5 字）");
assert.strictEqual(h.label(promoCode), "Promo code（已填 6 字）");
assert.strictEqual(h.label(quantity), "Quantity（已填 1 字）");
assert.strictEqual(h.label(realCode), "input（已填）");
assert.ok(!h.label(passwordUpper).includes("upper-secret"));

const outlineJson = JSON.stringify(h.outline());
for (const secret of [
  "hunter2", "123456", "upper-secret", "switched-secret", "4111", "11010519491231002X", "110105491231002",
  "654321", "user@example.com", "TA-666", "MuiShown-Secret1", "Hant-Secret", "Ja-Secret", "Ko-Secret",
]) {
  assert.ok(!outlineJson.includes(secret), `outline 里不应出现 ${secret}`);
}
assert.ok(outlineJson.includes("（已填 5 字）"));
assert.ok(outlineJson.includes("邮箱（已填 16 字）"));
assert.ok(outlineJson.includes("Digit 1（已填）"));
assert.ok(outlineJson.includes("Acme Trading") || outlineJson.includes("businessName"), "普通字段应保留可分辨的标签");
assert.ok(!outlineJson.includes("Password（已填 16 字）"), "敏感字段只报已填，不报长度");

const upgradePage = createSandbox([plain]);
upgradePage.sandbox.window.__bridgeHelpers = { version: 3, label: () => "旧版" };
vm.runInContext(PAGE_HELPERS, upgradePage.context);
const upgraded = upgradePage.sandbox.window.__bridgeHelpers;
assert.strictEqual(upgraded.version, 4);
assert.notStrictEqual(upgraded.label(plain), "旧版");
vm.runInContext(PAGE_HELPERS, upgradePage.context);
assert.strictEqual(upgradePage.sandbox.window.__bridgeHelpers, upgraded);

console.log("browser-control 辅助函数自测通过");
