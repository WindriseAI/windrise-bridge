/**
 * 真正的诊断与语言服务 —— 基于 tsserver（TypeScript 官方引擎）。
 *
 * 这两个工具是「补上缺口」用的：
 *   - get_diagnostics：不再是找 TODO 的静态体检，而是真的类型检查
 *   - lsp：真的能跳定义、找引用、列符号、看类型
 *
 * 引擎不可用时会**如实说明降级原因**，而不是编造结果。
 */

import path from "node:path";
import { getTsserver, parsePosition, severityRank, severityText } from "../core/lsp.js";
import { getDiagnostics as staticDiagnostics } from "./shell.js";

const SUPPORTED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i;

/**
 * tsserver 的 start / length 在不同命令下形状不一样：
 * 有的是 { line, offset }，有的是 { line, col }，还有的只有裸数字。
 * 这里统一成 行:列。
 */
function positionOf(value) {
  if (value === null || value === undefined) return { line: null, column: null };
  if (typeof value === "object") {
    return {
      line: value.line ?? null,
      column: value.offset ?? value.col ?? value.character ?? null,
    };
  }
  return { line: null, column: null };
}

function formatDiagnostic(item, file) {
  const start = positionOf(item.start);
  const end = positionOf(item.end ?? item.length);
  return {
    file: path.basename(file),
    line: start.line,
    column: start.column,
    endLine: end.line,
    severity: severityText(item.category),
    rank: severityRank(item.category),
    code: item.code ?? null,
    source: item.source ?? null,
    message: String(item.text ?? item.message ?? "").replace(/\s+/g, " ").slice(0, 500),
  };
}

/** 真实的诊断：优先走 tsserver，引擎不可用就退回静态体检并说明原因。 */
export async function realDiagnostics(input, ctx) {
  const targets = Array.isArray(input.paths) ? input.paths : [input.path ?? input.file ?? "."];
  const root = ctx.guard.roots[0];
  const notes = [];
  const files = [];

  // 先把目标展开成文件列表
  const fileList = [];
  for (const target of targets) {
    const info = await ctx.guard.check(target);
    const fileStat = await import("node:fs/promises").then(fs => fs.stat(info.abs)).catch(() => null);
    if (fileStat?.isFile()) fileList.push(info.abs);
    else if (fileStat?.isDirectory()) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(info.abs, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && SUPPORTED.test(entry.name)) fileList.push(path.join(info.abs, entry.name));
      }
    }
  }

  if (!fileList.length) {
    return { content: [{ type: "text", text: "没有找到可检查的文件（支持 .ts/.tsx/.js/.jsx/.json）。" }], structuredContent: { engine: "none", files: [] } };
  }

  let engine = "tsserver";
  let client = null;
  try {
    client = await getTsserver(root, (line) => ctx.log?.(line));
  } catch (error) {
    engine = "static";
    notes.push(`语言服务不可用，已降级为文件级静态体检。原因：${error.message}`);
  }

  if (engine === "tsserver" && client) {
    notes.push("由 TypeScript 语言服务（tsserver）给出，与编辑器里看到的诊断一致。");
    for (const file of fileList.slice(0, 50)) {
      try {
        const result = await client.diagnosticsFor(file);
        const items = result.items.map(item => formatDiagnostic(item, file));
        files.push({ path: ctx.guard.toRelative(file), engine: "tsserver", count: items.length, problems: items });
      } catch (error) {
        files.push({ path: ctx.guard.toRelative(file), engine: "tsserver", error: error.message, problems: [] });
      }
    }
    const errors = files.reduce((sum, f) => sum + (f.problems ?? []).filter(p => p.severity === "错误").length, 0);
    const warnings = files.reduce((sum, f) => sum + (f.problems ?? []).filter(p => p.severity === "警告").length, 0);
    const body = [
      notes[0],
      `检查了 ${files.length} 个文件：错误 ${errors} 个，警告 ${warnings} 个。`,
      ...files.flatMap(f => {
        if (f.error) return [`${f.path}：检查失败（${f.error}）`];
        if (!f.problems.length) return [];
        return [`${f.path}：`, ...f.problems.slice(0, 30).map(p => `  ${p.severity} 第 ${p.line}:${p.column}  ${p.message}${p.code ? `  [TS${p.code}]` : ""}`)];
      }),
    ];
    return {
      content: [{ type: "text", text: body.join("\n") }],
      structuredContent: { engine: "tsserver", notes, errors, warnings, files },
    };
  }

  // 降级：静态体检
  const fallback = await staticDiagnostics(input, ctx);
  notes.push("静态体检只能发现格式类问题，不能判断类型错误。要真诊断请装 TypeScript。");
  return {
    content: [{ type: "text", text: [notes.join("\n"), fallback.content[0].text].join("\n\n") }],
    structuredContent: { engine: "static", notes, ...fallback.structuredContent },
  };
}

/** 真正的语言服务查询。 */
export async function realLsp(input, ctx) {
  const operation = String(input.operation ?? "status").toLowerCase();
  const root = ctx.guard.roots[0];
  const target = input.path ?? input.file;

  if (operation === "status") {
    try {
      const client = await getTsserver(root, (line) => ctx.log?.(line));
      const status = client.status();
      return {
        content: [{ type: "text", text: `语言服务运行中。\n引擎：${status.serverPath}\n已打开文件：${status.openFiles.length} 个\n运行时长：${Math.round(status.uptimeMs / 1000)} 秒` }],
        structuredContent: { available: true, ...status },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `语言服务不可用：${error.message}` }],
        structuredContent: { available: false, reason: error.message },
      };
    }
  }

  if (!target) {
    return { content: [{ type: "text", text: "该操作需要 path 参数。" }], structuredContent: { available: false, reason: "缺少 path" }, isError: true };
  }

  const info = await ctx.guard.check(target);
  let client;
  try {
    client = await getTsserver(root, (line) => ctx.log?.(line));
  } catch (error) {
    return {
      content: [{ type: "text", text: `语言服务不可用，无法执行 ${operation}：${error.message}` }],
      structuredContent: { available: false, reason: error.message },
    };
  }

  const relative = ctx.guard.toRelative(info.abs);

  try {
    if (operation === "definition") {
      const { line, offset } = parsePosition(input);
      const result = await client.definition(relative, line, offset);
      const spans = (result.definitions ?? result.definition ?? []).map(d => ({
        file: ctx.guard.toRelative(d.file ?? d.fileName ?? ""),
        line: d.start?.line ?? null,
        column: d.start?.offset ?? null,
      }));
      const text = spans.length
        ? spans.map(s => `${s.file}:${s.line}:${s.column}`).join("\n")
        : "没找到定义（可能是外部依赖或类型声明）。";
      return { content: [{ type: "text", text }], structuredContent: { available: true, operation, target: relative, definitions: spans } };
    }

    if (operation === "references") {
      const { line, offset } = parsePosition(input);
      const result = await client.references(relative, line, offset);
      const refs = (result.refs ?? []).map(r => ({
        file: ctx.guard.toRelative(r.file ?? ""),
        line: r.start?.line ?? null,
        column: r.start?.offset ?? null,
        lineText: String(r.lineText ?? "").trim().slice(0, 200),
      }));
      const text = refs.length
        ? `共 ${refs.length} 处引用：\n` + refs.slice(0, 80).map(r => `${r.file}:${r.line}  ${r.lineText}`).join("\n")
        : "没找到引用。";
      return { content: [{ type: "text", text }], structuredContent: { available: true, operation, target: relative, count: refs.length, references: refs } };
    }

    if (operation === "symbols") {
      const result = await client.documentSymbols(relative);
      // navtree 的形状：{ text, kind, kindModifiers, spans: [{start,end}], nameSpan: {start,end}, childItems: [] }
      // 行号在 spans[0].start，精确位置在 nameSpan.start
      const walk = (nodes, depth = 0, out = []) => {
        for (const node of nodes ?? []) {
          const span = positionOf(node.spans?.[0]?.start ?? node.start);
          const nameSpan = positionOf(node.nameSpan?.start);
          out.push({
            name: node.text,
            kind: node.kind,
            modifiers: node.kindModifiers || "",
            line: span.line ?? nameSpan.line,
            column: nameSpan.column ?? span.column,
            endLine: positionOf(node.spans?.[0]?.end).line,
            depth,
          });
          if (node.childItems) walk(node.childItems, depth + 1, out);
        }
        return out;
      };
      const symbols = walk(result.childItems ?? []);
      const text = symbols.length
        ? symbols.map(s => {
            const mod = s.modifiers ? `${s.modifiers} ` : "";
            return `${"  ".repeat(s.depth)}${mod}${s.kind} ${s.name}  第 ${s.line}:${s.column} 行`;
          }).join("\n")
        : "这个文件里没有可列出的符号。";
      return { content: [{ type: "text", text }], structuredContent: { available: true, operation, target: relative, count: symbols.length, symbols } };
    }

    if (operation === "quickinfo" || operation === "type") {
      const { line, offset } = parsePosition(input);
      const result = await client.quickInfo(relative, line, offset);
      const display = result.displayString ?? "(无类型信息)";
      const docs = result.documentation ? `\n说明：${String(result.documentation).slice(0, 500)}` : "";
      return {
        content: [{ type: "text", text: `第 ${line}:${offset} 处类型：\n${display}${docs}` }],
        structuredContent: { available: true, operation, target: relative, type: display, documentation: result.documentation ?? null },
      };
    }

    if (operation === "completion") {
      const { line, offset } = parsePosition(input);
      const result = await client.completion(relative, line, offset);
      const entries = (result.entries ?? []).slice(0, 60).map(e => ({ name: e.name, kind: e.kind, sortText: e.sortText }));
      const text = entries.length
        ? `第 ${line}:${offset} 处可补全 ${result.entries.length} 项（显示前 ${entries.length}）：\n` + entries.map(e => `${e.kind.padEnd(12)} ${e.name}`).join("\n")
        : "没有补全建议。";
      return { content: [{ type: "text", text }], structuredContent: { available: true, operation, target: relative, count: entries.length, entries } };
    }

    return {
      content: [{ type: "text", text: `不支持的操作：${operation}。可用：status / definition / references / symbols / quickinfo / completion` }],
      structuredContent: { available: false, reason: "未知操作" },
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `语言服务执行 ${operation} 失败：${error.message}` }],
      structuredContent: { available: false, reason: error.message, operation },
      isError: true,
    };
  }
}
