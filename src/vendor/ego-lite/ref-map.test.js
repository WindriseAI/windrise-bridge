// SPDX-License-Identifier: MIT
// Portions derived from citrolabs/ego-lite (MIT),
//   file: package/ego-browser/src/ref-map.test.mjs
//   commit: d392204d1ea1a8027a591ab2b0129c2e11d85f26
// Copyright (c) 2026 CitroLabs
// Modified for Windrise Bridge: imports routed to ego-shims.js (CDP via webContents.debugger). 2026-10-24.
import test from "node:test";
import assert from "node:assert/strict";

import { parseRef } from "./ref-map.js";

test("parseRef accepts action forms but not the full snapshot annotation", () => {
  assert.equal(parseRef("@21"), "21");
  assert.equal(parseRef("ref=21"), "21");
  assert.equal(parseRef("21"), "21");
  assert.equal(parseRef("[ref=21]"), null);
});
