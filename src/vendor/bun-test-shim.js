/**
 * bun:test 的最小垫片：让搬来的上游测试（写给 bun 的）直接在 node:test 上跑。
 * 只实现上游测试实际用到的部分：describe / test / it / expect（toBe、toEqual、toContain、toBeUndefined、
 * toMatchObject、toBeLessThan 及其 .not），以及 beforeEach / afterEach。缺什么再补什么。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

export { afterEach, beforeEach, describe, test, test as it };

function matchesObject(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => matchesObject(actual[i], value));
  }
  return Object.keys(expected).every((key) => matchesObject(actual[key], expected[key]));
}

function contains(actual, item) {
  if (typeof actual === "string") return actual.includes(item);
  if (Array.isArray(actual) || actual instanceof Set) return [...actual].some((value) => Object.is(value, item));
  return false;
}

function matchers(actual, negate) {
  const check = (pass, message) => {
    if (negate ? pass : !pass) assert.fail(negate ? `期望不满足：not ${message}` : message);
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `期望 ${JSON.stringify(actual)} 严格等于 ${JSON.stringify(expected)}`),
    toEqual: (expected) => {
      let pass = true;
      try { assert.deepStrictEqual(actual, expected); } catch { pass = false; }
      check(pass, `期望 ${JSON.stringify(actual)} 深度等于 ${JSON.stringify(expected)}`);
    },
    toContain: (item) => check(contains(actual, item), `期望 ${JSON.stringify(actual)?.slice(0, 400)} 包含 ${JSON.stringify(item)}`),
    toBeUndefined: () => check(actual === undefined, `期望 undefined，实际 ${JSON.stringify(actual)}`),
    toMatchObject: (expected) => check(matchesObject(actual, expected), `期望 ${JSON.stringify(actual)} 匹配 ${JSON.stringify(expected)}`),
    toBeLessThan: (limit) => check(actual < limit, `期望 ${actual} < ${limit}`),
  };
}

/** toThrow 的判定：不给参数只要求抛错；给字符串要求消息包含它；给正则要求消息匹配。 */
function thrownMatches(error, expected) {
  if (expected === undefined) return true;
  const message = String(error?.message ?? error);
  return expected instanceof RegExp ? expected.test(message) : message.includes(String(expected));
}

export function expect(actual) {
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    // await expect(promise).rejects.toThrow(...)
    rejects: {
      toThrow: async (expected) => {
        let error;
        try { await actual; } catch (caught) { error = caught; }
        if (error === undefined) assert.fail("期望 Promise 被拒绝，实际成功了");
        if (!thrownMatches(error, expected)) assert.fail(`拒绝原因 ${JSON.stringify(String(error?.message ?? error))} 不匹配 ${expected}`);
      },
    },
    toThrow: (expected) => {
      let error;
      try { actual(); } catch (caught) { error = caught; }
      if (error === undefined) assert.fail("期望抛错，实际没有");
      if (!thrownMatches(error, expected)) assert.fail(`错误 ${JSON.stringify(String(error?.message ?? error))} 不匹配 ${expected}`);
    },
  });
}
