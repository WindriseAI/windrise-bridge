// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/snapshot/roles.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
export const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'textarea',
    'checkbox',
    'radio',
    'combobox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'option',
    'treeitem',
    'listbox',
    'DisclosureTriangle',
]);
export const SKIP_ROLES = new Set([
    'none',
    'presentation',
    'LineBreak',
    'InlineTextBox',
    'StaticText',
    'text',
]);
export const ROOT_ROLES = new Set([
    'RootWebArea',
    'WebArea',
]);
export const VALUE_ROLES = new Set([
    'textbox',
    'searchbox',
    'textarea',
    'combobox',
    'spinbutton',
]);
