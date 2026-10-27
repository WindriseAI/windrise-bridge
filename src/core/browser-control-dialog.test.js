/**
 * page_snapshot / page_act 的对话框迟到检查（纯 Node，假 surface）：
 *   node --test src/core/browser-control-dialog.test.js
 *
 *   ① page_snapshot 是只读动作：失败被改写成 DIALOG_OPEN 时不能冒充「动作已发出」；
 *   ② page_act 的错误被改写时保留原错误码和闸门载荷（NEEDS_CONFIRM / reason / keyword / retryable）。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { BrowserControlServer } = require("../../electron/browser-control.cjs");

function serverWith(surface) {
  const server = new BrowserControlServer({ manager: {} });
  server.resolveTab = () => ({ wc: surface.wc, space: null });
  server.surfaceFor = async () => surface;
  return server;
}

function fakeWc() {
  return {
    id: 5,
    isBrowserOsTab: false,
    isDestroyed: () => false,
    getURL: () => "https://example.test/",
    getTitle: () => "示例",
  };
}

test("page_snapshot 碰上对话框：报 DIALOG_OPEN，但不会写 outcome:dispatched", async () => {
  const surface = {
    wc: fakeWc(),
    cdp: {
      dialog: { type: "alert", message: "hello", defaultPrompt: "", url: "https://example.test/" },
    },
    snap: {},
  };
  const server = serverWith(surface);
  const error = await server.pageSnapshot("t1", {}).catch((caught) => caught);
  assert.equal(error.code, "DIALOG_OPEN");
  assert.equal("outcome" in error, false, "只读动作不能凭空出现 outcome");
  assert.equal("dispatched" in error, false, "只读动作不能说「动作已发出」");
  assert.equal(error.dialog?.message, "hello");
});

test("page_act 的动作错误撞上对话框：保留 causeCode 和确认载荷，并按写动作定三态", async () => {
  const surface = {
    wc: fakeWc(),
    cdp: {
      dialog: null,
      inputBlocked: null,
      send: async () => ({ result: { value: 0 } }),
      onEvent: () => () => {},
    },
    snap: {},
    actor: {
      async act() {
        // 动作执行到一半页面弹了 confirm，同时闸门抛 NEEDS_CONFIRM
        surface.cdp.dialog = { type: "confirm", message: "确定删除？", defaultPrompt: "", url: "https://example.test/" };
        const error = Object.assign(new Error("需要确认"), {
          code: "NEEDS_CONFIRM",
          reason: "commit_boundary",
          target: "发布",
          keyword: "发布",
          retryable: true,
          outcome: "failed",
          dispatched: false,
          next_step: "先向用户确认，确认后带 confirm:true 重试",
        });
        throw error;
      },
    },
  };
  const server = serverWith(surface);
  const error = await server.pageAct("t1", { action: "click", ref: "e1" }).catch((caught) => caught);
  assert.equal(error.code, "DIALOG_OPEN");
  assert.equal(error.causeCode, "NEEDS_CONFIRM", "关掉对话框后还要知道原本被闸门拦了");
  assert.equal(error.reason, "commit_boundary");
  assert.equal(error.keyword, "发布");
  assert.equal(error.target, "发布");
  assert.equal(error.retryable, true);
  assert.equal(error.outcome, "failed");
  assert.equal(error.dispatched, false);
});