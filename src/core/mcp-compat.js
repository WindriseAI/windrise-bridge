/**
 * 工具清单兼容层：不同客户端对 MCP 工具清单的硬限制不一样，这里集中处理。
 *
 * 目前只做两件事：
 *   1. DeepSeek strict 模式 / Kimi / 智谱（GLM）不认 JSON Schema 里的
 *      minLength / maxLength / minItems / maxItems / pattern / format；
 *      tools/list 给这些客户端时换成「兼容视图」（递归去掉这几个关键字），
 *      服务端注册表和调用校验仍用原 schema，绝不因为客户端而放宽。
 *   2. 写操作类工具的描述统一追加「不要和其他写操作并行调用」，
 *      给会并行调工具的模型（Kimi 等）一个明确提示；只加一次，原文不动。
 *
 * 【重要：这 6 个关键字服务端本来就不执行】
 *   服务端的 validateArgs（registry.js）只校验 required / 顶层 type / enum，
 *   从来不看 minLength / maxLength / minItems / maxItems / pattern / format。
 *   所以在兼容视图里删掉它们不会损失任何服务端防线；反过来，客户端就算拿到
 *   精简 schema，也绕不过 required / type / enum 这三道真正的校验。
 *   这些长度 / 个数约束只是「写给客户端看的提示」，不要当成服务端防线。
 *
 * 【安全边界：clientInfo.name 只用于展示层】
 *   isStrictCompatClient 判断用的 clientInfo.name 是客户端在 initialize 里
 *   自己填的字符串，完全由客户端控制。它只决定 tools/list 给哪一套 schema 视图，
 *   禁止参与任何校验 / 放行 / 闸门 / 作用域判断 —— 否则任何客户端自称 kimi 就能绕过。
 *   兼容视图只会在 tools/list 的返回里出现，tools/call 永远用注册表里的原 schema。
 *
 * 纯函数，方便单测。
 */

import { groupForTool } from "./tool-policy.js";

/** DeepSeek strict function calling 不支持的 6 个关键字，就是本文件 stripUnsupportedKeywords 去掉的那批。 */
export const STRICT_UNSUPPORTED_KEYWORDS = Object.freeze([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
]);

const STRICT_KEYWORD_SET = new Set(STRICT_UNSUPPORTED_KEYWORDS);

/** 写操作工具统一追加的提示。 */
export const WRITE_SERIAL_NOTE = "不要和其他写操作并行调用";

/**
 * initialize 的 clientInfo.name 是否命中需要「兼容视图」的客户端。
 * 匹配 deepseek / kimi / glm / zhipu，不区分大小写，允许出现在名字中间
 * （例如 "DeepSeek Harness"、"Kimi Code CLI"、"glm-4.6"、"ZhipuAI"）。
 */
export function isStrictCompatClient(name) {
  const text = String(name ?? "").toLowerCase();
  if (!text) return false;
  return ["deepseek", "kimi", "glm", "zhipu"].some((key) => text.includes(key));
}

/**
 * 哪些子键的值是「一组 schema」：用于遍历 / 复制时区分「属性名」和「关键字」。
 * properties 的键是参数名（可能是 pattern / format 这种），不能当成关键字删掉。
 */
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_SINGLE_KEYS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "not",
  "if",
  "then",
  "else",
]);
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 深度遍历 schema，把用到的 strict 不支持关键字收集到 found（Set）。 */
export function collectStrictKeywords(schema, found = new Set()) {
  if (!isPlainObject(schema)) return found;
  for (const key of STRICT_KEYWORD_SET) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) found.add(key);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      // properties / patternProperties 的值是 schema，键名只是参数名，不递归键名本身
      for (const child of Object.values(value)) collectStrictKeywords(child, found);
    } else if (SCHEMA_SINGLE_KEYS.has(key)) {
      if (Array.isArray(value)) {
        for (const child of value) collectStrictKeywords(child, found);
      } else {
        collectStrictKeywords(value, found);
      }
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (const child of value) collectStrictKeywords(child, found);
    } else if (key === "dependencies" && isPlainObject(value)) {
      for (const child of Object.values(value)) {
        if (isPlainObject(child)) collectStrictKeywords(child, found);
      }
    }
  }
  return found;
}

/**
 * 生成 strict 兼容视图：复制一份 schema，递归去掉 6 个不支持的关键字。
 * 只深拷贝 schema 结构；属性名（例如 search_files 的 pattern 参数）原样保留。
 */
export function stripUnsupportedKeywords(schema) {
  if (Array.isArray(schema)) return schema.map((item) => stripUnsupportedKeywords(item));
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRICT_KEYWORD_SET.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const map = {};
      for (const [name, child] of Object.entries(value)) map[name] = stripUnsupportedKeywords(child);
      out[key] = map;
    } else if (SCHEMA_SINGLE_KEYS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((child) => stripUnsupportedKeywords(child))
        : stripUnsupportedKeywords(value);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((child) => stripUnsupportedKeywords(child));
    } else if (key === "dependencies" && isPlainObject(value)) {
      const map = {};
      for (const [name, child] of Object.entries(value)) {
        // dependencies 的值可能是 schema 或字符串数组，只有 schema 才需要处理
        map[name] = isPlainObject(child) ? stripUnsupportedKeywords(child) : child;
      }
      out[key] = map;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 给写操作工具的说明追加并行提示；已经包含这句就不再追加（保证只加一次）。
 * 空说明就只返回提示本身。
 */
export function withWriteSerialNote(description) {
  const text = String(description ?? "").trim();
  if (!text) return `${WRITE_SERIAL_NOTE}。`;
  if (text.includes(WRITE_SERIAL_NOTE)) return text;
  return `${text} ${WRITE_SERIAL_NOTE}。`;
}

/**
 * 描述层「要不要提醒别并行」的判定（只影响描述文本，不改分组、不改权限）。
 *
 * 任务原文只要求 WRITE 分组；但真正会写盘 / 跑命令的工具（run_command、admin_run、
 * 外部转发 ext__*）都在 admin 分组，capability 是 execute / admin，一样有并行风险
 * （两个命令落到同一个文件上会互相覆盖，git 操作会交错）。所以这里放宽到：
 *   · 分组是 WRITE 或 ADMIN（外部转发工具由 groupForTool 按 source 判成 admin，
 *     不依赖工具自己填的 group）；
 *   · capability 是 execute 或 admin；
 *   · annotations.destructiveHint 为 true（会破坏东西）。
 * 只用于 bridge.js 拼 description，绝不拿去改 group / scope / 闸门。
 *
 * 显式读过只读标记的工具（group=read / readOnlyHint）一律不提醒：read_result 这类
 * 不进注册表的只读工具，没有 group 时会兜底判成 admin，不能靠兜底结果给它加写提示。
 */
export function isWriteLike(tool) {
  const definition = tool ?? {};
  if (String(definition.group ?? "").toLowerCase() === "read") return false;
  if (definition.annotations?.readOnlyHint === true) return false;
  // 显式 group 优先（注册表 entry 自带），再按 source / capability 推导（外部转发 → admin）。
  // 注意：这里只读分组，不改分组，也不影响 scope / 闸门。
  const group = String(definition.group ?? "").toLowerCase()
    || String(groupForTool(definition)).toLowerCase();
  if (group === "write" || group === "admin") return true;
  const capability = String(definition.capability ?? "").toLowerCase();
  if (capability === "execute" || capability === "admin") return true;
  return definition.annotations?.destructiveHint === true;
}
