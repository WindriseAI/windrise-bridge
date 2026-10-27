/**
 * 文件类工具实现 —— 对应学习软件的 FILE_TOOL_DEFINITIONS 五个工具。
 *
 * 设计取向和学习软件一致：
 *   1. 所有路径先过守卫，越界直接报错，不静默改写；
 *   2. 返回里的路径统一压成工作区相对路径（跨机器传阅时不会泄露本机用户名）；
 *   3. 有大小上限、有行号窗口、有截断标记，避免把上下文塞爆。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_READ_BYTES = 256 * 1024;          // 不指定行范围时一次最多返回这么多
const MAX_RANGE_FILE_BYTES = 50 * 1024 * 1024; // 指定行范围时允许读的最大文件
const MAX_READ_LINES = 2000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_HITS = 200;

const IMAGE_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * 简易 glob → 正则，支持双星 / 单星 / 问号，够本地检索用。
 * 语义对齐常见 glob：双星加斜杠可匹配「零层目录」，
 * 所以 "**\/*.md" 既能命中根目录的 README.md，也能命中深层文件。
 */
export function globToRegExp(pattern) {
  const normalized = pattern.split(path.sep).join("/").replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") { out += "(?:[^/]+/)*"; i += 2; }   // **/ → 任意层数（含零层）
        else { out += ".*"; i++; }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if ("+.^$()|{}[]".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

function text(content, structured, extra = {}) {
  return { content: [{ type: "text", text: content }, ...extra.extraContent ?? []], structuredContent: structured, ...extra };
}

function lines(bytes) {
  return bytes.split(/\r\n|\n|\r/);
}

const sha = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;
const num = (...values) => { for (const v of values) { const n = Number(v); if (v !== undefined && v !== null && v !== "" && Number.isFinite(n)) return n; } return undefined; };
const toArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

/** 常见的生成目录 / 依赖目录：默认不进去（no_ignore=true 才进） */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage", "__pycache__", ".venv", "venv", "target", ".idea", ".vscode"]);

/** 把 "1-50" / "10" / "10-" 解析成起止行号（1 基，含端点）。 */
export function parseRange(spec, total) {
  if (spec === undefined || spec === null || spec === "") return [1, total];
  const match = /^(\d+)?\s*[-–]\s*(\d+)?$/.exec(String(spec).trim());
  if (!match) {
    const single = Number(String(spec).trim());
    if (Number.isFinite(single)) return [Math.max(1, single), Math.max(1, single)];
    return [1, total];
  }
  const start = match[1] ? Number(match[1]) : 1;
  const end = match[2] ? Number(match[2]) : total;
  return [Math.min(start, end), Math.max(start, Math.min(end, total))];
}

/**
 * read_files：一次读一个或一批文本文件，可带行范围。
 * 参数兼容两套写法：
 *   新（与 ShunCode 一致）：files: [{ path, start_line, end_line }]
 *   旧：path / paths + range: "10-60"
 * 每个文件返回 version（sha256），apply_patch 可以带上它防止改到过期内容。
 */
export async function readFiles(input, ctx) {
  const specs = [];
  for (const f of toArray(input.files)) specs.push(typeof f === "string" ? { path: f } : f ?? {});
  for (const p of [...toArray(input.paths), ...toArray(input.path)]) specs.push({ path: p, range: input.range, start_line: input.start_line, end_line: input.end_line });
  if (!specs.length) throw new Error("需要 files（[{ path, start_line, end_line }]）或 path");
  const rows = [];
  for (const spec of specs.slice(0, 32)) {
    const target = spec.path;
    try {
      if (!target) throw new Error("缺少 path");
      const info = await ctx.guard.check(target);
      const fileStat = await stat(info.abs);
      if (!fileStat.isFile()) { rows.push({ path: target, error: "不是文件（目录请用 list_directory）" }); continue; }
      const startArg = num(spec.start_line, spec.startLine);
      const endArg = num(spec.end_line, spec.endLine);
      const ranged = startArg !== undefined || endArg !== undefined || spec.range;
      if (fileStat.size > (ranged ? MAX_RANGE_FILE_BYTES : 20 * MAX_READ_BYTES)) {
        rows.push({ path: target, error: `文件太大（${Math.round(fileStat.size / 1024)}KB），请用 search_files 定位后带 start_line/end_line 分段读`, size: fileStat.size });
        continue;
      }
      const buf = await readFile(info.abs);
      const raw = buf.toString("utf8").replace(/^\uFEFF/, "");
      const all = lines(raw);
      if (all.length > 1 && all[all.length - 1] === "") all.pop();
      let start; let end;
      if (spec.range && startArg === undefined && endArg === undefined) [start, end] = parseRange(spec.range, all.length);
      else { start = Math.max(1, startArg ?? 1); end = Math.min(all.length, endArg ?? all.length); }
      // 没指定范围时按行数 / 字节数自动截断，告诉对方下一段从哪开始
      let limited = false;
      if (!ranged || endArg === undefined) {
        let bytes = 0;
        for (let i = start; i <= end; i++) {
          bytes += all[i - 1].length + 1;
          if (i - start + 1 > MAX_READ_LINES || bytes > MAX_READ_BYTES) { end = i - 1; limited = true; break; }
        }
      }
      const slice = all.slice(start - 1, end);
      rows.push({
        path: ctx.guard.toRelative(info.abs),
        absolute: info.abs,
        version: sha(buf),
        totalLines: all.length,
        start_line: start,
        end_line: end,
        range: `${start}-${end}`,
        has_more: end < all.length,
        next_start_line: end < all.length ? end + 1 : null,
        truncated: limited,
        content: slice.map((line, index) => `${start + index}| ${line}`).join("\n"),
      });
    } catch (error) {
      rows.push({ path: target, error: error.message, code: error.code });
    }
  }
  const out = rows.map(r => r.error
    ? `### ${r.path}\n读取失败：${r.error}`
    : `### ${r.path}（第 ${r.range} 行 / 共 ${r.totalLines} 行${r.has_more ? `，后面还有，下一段从第 ${r.next_start_line} 行开始` : ""}｜version ${r.version}）\n${r.content}`).join("\n\n");
  return text(out || "没有读取任何文件。", { files: rows }, rows.length && rows.every(r => r.error) ? { isError: true } : {});
}

/** read_image：把图片当图片交给模型（支持多模态客户端看图）。 */
export async function readImage(input, ctx) {
  const info = await ctx.guard.check(input.path);
  const ext = path.extname(info.abs).toLowerCase();
  const mime = IMAGE_EXT[ext];
  if (!mime) throw new Error(`不支持的图片类型：${ext || "未知后缀"}`);
  const fileStat = await stat(info.abs);
  if (fileStat.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`);
  const data = await readFile(info.abs);
  const digest = createHash("sha256").update(data).digest("hex");
  return {
    content: [
      { type: "text", text: `图片 ${ctx.guard.toRelative(info.abs)}｜${mime}｜${fileStat.size} 字节｜sha256 ${digest.slice(0, 16)}…` },
      { type: "image", data: data.toString("base64"), mimeType: mime },
    ],
    structuredContent: { path: ctx.guard.toRelative(info.abs), mimeType: mime, bytes: fileStat.size, sha256: digest },
  };
}

/** glob 匹配器：只写文件名（如 *.ts）时在任意层级匹配文件名，写了路径就按相对路径匹配 */
function globMatcher(pattern, caseSensitive = false) {
  const p = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "");
  const rx = new RegExp(globToRegExp(p).source, caseSensitive ? "" : "i");
  const basenameOnly = !p.includes("/");
  return (rel) => rx.test(basenameOnly ? rel.slice(rel.lastIndexOf("/") + 1) : rel);
}

/**
 * 遍历工作区目录（跳过隐藏 / 依赖目录），对每个文件调用 visit(rel, abs, dirent)。
 * visit 返回 false 就停止。
 */
async function walkFiles(rootAbs, { includeHidden = false, noIgnore = false, exclude = [], maxDirs = 20_000 } = {}, visit) {
  const skip = exclude.map(e => globMatcher(e));
  let dirs = 0;
  let stop = false;
  async function walk(dir) {
    if (stop || ++dirs > maxDirs) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (stop) return;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      if (skip.some(m => m(rel) || m(`${rel}/`))) continue;
      if (entry.isDirectory()) {
        if (!noIgnore && IGNORED_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if ((await visit(rel, abs, entry)) === false) { stop = true; return; }
      }
    }
  }
  await walk(rootAbs);
}

/**
 * find_files：按文件名 / glob 找文件。
 * 参数：patterns（数组，与 ShunCode 一致）或 glob / pattern；max_results（旧：limit）；
 * include_hidden、no_ignore、exclude、case_sensitive、sort（modified_desc 默认 / path_asc）。
 */
export async function findFiles(input, ctx) {
  const patterns = [...toArray(input.patterns), ...toArray(input.glob), ...toArray(input.pattern)];
  if (!patterns.length) patterns.push("**/*");
  const matchers = patterns.map(p => globMatcher(p, input.case_sensitive === true));
  const roots = input.path ? [input.path] : ctx.guard.roots;
  const limit = Math.min(num(input.max_results, input.limit) ?? 100, 500);
  const hits = [];
  for (const root of roots) {
    const info = await ctx.guard.check(root);
    await walkFiles(info.abs, { includeHidden: input.include_hidden, noIgnore: input.no_ignore, exclude: toArray(input.exclude) }, async (rel, abs) => {
      if (!matchers.some(m => m(rel))) return true;
      const st = await stat(abs).catch(() => null);
      hits.push({ path: ctx.guard.toRelative(abs), bytes: st?.size ?? null, mtime: st?.mtimeMs ?? 0 });
      return hits.length < 5000;
    });
  }
  if (input.sort === "path_asc") hits.sort((x, y) => x.path.localeCompare(y.path));
  else hits.sort((x, y) => y.mtime - x.mtime);
  const shown = hits.slice(0, limit);
  return text(
    shown.length ? shown.map(h => `${h.path}${h.bytes !== null ? `  (${h.bytes} B)` : ""}`).join("\n") + (hits.length > limit ? `\n…共 ${hits.length} 个，只显示前 ${limit} 个（缩小范围或调大 max_results）` : "") : "没有匹配的文件。",
    { patterns, count: shown.length, total: hits.length, truncated: hits.length > limit, files: shown.map(({ mtime, ...rest }) => rest) },
  );
}

/**
 * search_files：搜文件内容。默认按**原文**搜（is_regex=true 才当正则），大小写默认智能判断
 * （全小写不区分，带大写就区分）。优先用 ripgrep，没有就用内置遍历。
 * 参数与 ShunCode 一致：pattern、path、include、exclude、is_regex、case_sensitive、context_lines、
 * max_results、max_matches_per_file、include_hidden、no_ignore；也兼容旧的 glob / caseInsensitive / limit。
 */
export async function searchFiles(input, ctx) {
  const pattern = String(input.pattern ?? input.query ?? "");
  if (!pattern) throw new Error("pattern 不能为空");
  const scope = await ctx.guard.check(input.path ?? ctx.guard.roots[0]);
  const isRegex = input.is_regex === true || input.regex === true;
  const caseSensitive = input.case_sensitive ?? (input.caseInsensitive === undefined ? /[A-Z]/.test(pattern) : !input.caseInsensitive);
  const limit = Math.min(num(input.max_results, input.limit) ?? 100, 500);
  const perFile = Math.min(num(input.max_matches_per_file) ?? 20, 100);
  const contextLines = Math.min(Math.max(num(input.context_lines) ?? 0, 0), 20);
  const include = [...toArray(input.include), ...toArray(input.glob)];
  const exclude = toArray(input.exclude);
  const scopeIsFile = (await stat(scope.abs).catch(() => null))?.isFile();
  const baseDir = scopeIsFile ? path.dirname(scope.abs) : scope.abs;

  let rx;
  try { rx = new RegExp(isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i"); }
  catch (error) { throw new Error(`正则不合法：${error.message}（要按原文搜就不要设 is_regex）`); }

  const matches = [];
  const args = ["--json", "--max-count", String(perFile), "--max-filesize", "2M", caseSensitive ? "-s" : "-i"];
  if (!isRegex) args.push("-F");
  if (contextLines) args.push("-C", String(contextLines));
  if (input.include_hidden) args.push("--hidden");
  if (input.no_ignore) args.push("--no-ignore");
  else for (const d of IGNORED_DIRS) args.push("-g", `!**/${d}/**`);
  for (const g of include) args.push("-g", g);
  for (const g of exclude) args.push("-g", `!${g}`);
  args.push("--", pattern, scope.abs);
  const rg = await runRipgrep(args);
  let engine = "ripgrep";
  if (rg.available) {
    let pendingBefore = [];
    for (const rec of rg.records) {
      const rel = ctx.guard.toRelative(rec.data.path?.text ?? "");
      const lineText = String(rec.data.lines?.text ?? "").replace(/\r?\n$/, "").slice(0, 400);
      if (rec.type === "context") {
        const last = matches[matches.length - 1];
        if (last && last.path === rel && rec.data.line_number > last.line) (last.after ??= []).push(lineText);
        else pendingBefore.push(lineText);
        continue;
      }
      if (matches.length >= limit) break;
      matches.push({ path: rel, line: rec.data.line_number, text: lineText, ...(contextLines ? { before: pendingBefore.slice(-contextLines) } : {}) });
      pendingBefore = [];
    }
  } else {
    engine = "node";
    const visit = async (rel, abs) => {
      const st = await stat(abs).catch(() => null);
      if (!st || st.size > 2 * 1024 * 1024) return true;
      const raw = await readFile(abs, "utf8").catch(() => null);
      if (!raw || raw.includes("\u0000")) return true;
      const all = lines(raw);
      let inFile = 0;
      for (let i = 0; i < all.length && matches.length < limit && inFile < perFile; i++) {
        if (!rx.test(all[i])) continue;
        inFile += 1;
        matches.push({
          path: ctx.guard.toRelative(abs), line: i + 1, text: all[i].slice(0, 400),
          ...(contextLines ? { before: all.slice(Math.max(0, i - contextLines), i), after: all.slice(i + 1, i + 1 + contextLines) } : {}),
        });
      }
      return matches.length < limit;
    };
    if (scopeIsFile) await visit(path.basename(scope.abs), scope.abs);
    else {
      const inc = include.map(g => globMatcher(g));
      await walkFiles(baseDir, { includeHidden: input.include_hidden, noIgnore: input.no_ignore, exclude }, (rel, abs) => (inc.length && !inc.some(m => m(rel)) ? true : visit(rel, abs)));
    }
  }
  const render = (m) => [
    ...(m.before ?? []).map(t => `${m.path}-  ${t}`),
    `${m.path}:${m.line}  ${m.text}`,
    ...(m.after ?? []).map(t => `${m.path}-  ${t}`),
  ].join("\n");
  return text(
    matches.length ? matches.map(render).join(contextLines ? "\n--\n" : "\n") + (matches.length >= limit ? "\n…结果已达上限，缩小范围再搜" : "") : "没有命中。",
    { engine, pattern, is_regex: isRegex, count: matches.length, truncated: matches.length >= limit, matches },
  );
}

function runRipgrep(args) {
  return new Promise(resolve => {
    const child = spawn(process.env.BRIDGE_RG || "rg", args, { windowsHide: true });
    let buffer = "";
    const records = [];
    let settled = false;
    const finish = (available) => { if (!settled) { settled = true; resolve({ available, records }); } };
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        try { const parsed = JSON.parse(line); if (parsed.type === "match" || parsed.type === "context") records.push(parsed); } catch { /* 忽略非 json 行 */ }
      }
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code !== 2 || records.length > 0));
    setTimeout(() => { child.kill(); finish(true); }, 30_000);
  });
}

/* ================================================================== *
 * apply_patch：Codex 格式补丁
 *   *** Begin Patch
 *   *** Add File: 路径        （后面每行以 + 开头）
 *   *** Delete File: 路径
 *   *** Update File: 路径
 *   *** Move to: 新路径        （可选，改名）
 *   @@ 可选的上下文标题（如函数名），也可以是 @@ -12,3 +12,4 @@
 *    上下文 / -删除 / +新增
 *   *** End of File            （可选：这一段贴着文件末尾）
 *   *** End Patch
 *
 * 规则：
 *   - 先把所有文件的结果算出来，任何一处对不上就**一个都不写**（不会改一半）
 *   - 保留原文件的换行风格（CRLF / LF）、BOM、末尾换行
 *   - 上下文先精确匹配，不行再忽略行尾空格、再忽略首尾空格
 *   - expected_versions（read_files 返回的 version）对不上就拒绝，防止覆盖别人刚改的内容
 * ================================================================== */
export async function applyPatch(input, ctx) {
  const patch = String(input.patch ?? input.input ?? "");
  if (!patch.trim()) throw new Error("patch 不能为空");
  const ops = parsePatch(patch);
  if (!ops.length) throw new Error("补丁里没有找到 *** Add File / *** Update File / *** Delete File");
  const expected = input.expected_versions && typeof input.expected_versions === "object" ? input.expected_versions : {};

  const plan = [];
  const errors = [];
  for (const op of ops) {
    try {
      const info = await ctx.guard.check(op.path);
      const existing = await readFile(info.abs).catch(() => null);
      const want = expected[op.path] ?? expected[ctx.guard.toRelative(info.abs)];
      if (want && existing && sha(existing) !== want) throw Object.assign(new Error("文件在你读过之后被改过（STALE_FILE），请重新 read_files 再生成补丁"), { code: "STALE_FILE" });
      if (op.kind === "add") {
        if (existing) throw new Error("文件已存在，不能 Add File（要改请用 Update File）");
        plan.push({ ...op, abs: info.abs, content: op.lines.join("\n") + (op.lines.length ? "\n" : ""), added: op.lines.length, removed: 0 });
      } else if (op.kind === "delete") {
        if (!existing) throw new Error("文件不存在，无法删除");
        plan.push({ ...op, abs: info.abs, added: 0, removed: lines(existing.toString("utf8").replace(/\r?\n$/, "")).length });
      } else {
        if (!existing) throw new Error("文件不存在（新建文件请用 *** Add File）");
        const result = applyUpdate(existing.toString("utf8"), op.hunks);
        if (result.error) throw new Error(result.error);
        let moveAbs = null;
        if (op.moveTo) moveAbs = (await ctx.guard.check(op.moveTo)).abs;
        plan.push({ ...op, abs: info.abs, moveAbs, content: result.content, added: result.added, removed: result.removed, diff: result.diff });
      }
    } catch (error) {
      errors.push({ path: op.path, ok: false, error: error.message, code: error.code ?? (error.name === "PathDeniedError" ? "PATH_DENIED" : undefined) });
    }
  }
  if (errors.length) {
    const body = `补丁没有应用（一个文件都没改）：\n${errors.map(e => `- ${e.path}：${e.error}`).join("\n")}`;
    return { content: [{ type: "text", text: body }], structuredContent: { ok: false, files: errors }, isError: true };
  }

  const results = [];
  for (const item of plan) {
    const rel = ctx.guard.toRelative(item.abs);
    if (item.kind === "delete") { await rm(item.abs, { force: true }); results.push({ path: rel, ok: true, action: "deleted", removed: item.removed }); continue; }
    const target = item.moveAbs ?? item.abs;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.content, "utf8");
    if (item.moveAbs && item.moveAbs !== item.abs) await rm(item.abs, { force: true });
    results.push({ path: ctx.guard.toRelative(target), ok: true, action: item.kind === "add" ? "added" : item.moveAbs ? "moved" : "updated", added: item.added, removed: item.removed, diff: item.diff, version: sha(Buffer.from(item.content, "utf8")) });
  }
  const label = { added: "新建", deleted: "删除", moved: "改名并修改", updated: "修改" };
  const body = results.map(r => `${label[r.action]} ${r.path}：+${r.added ?? 0} / -${r.removed ?? 0}${r.diff ? `\n${r.diff}` : ""}`).join("\n");
  return { content: [{ type: "text", text: body }], structuredContent: { ok: true, files: results } };
}

function parsePatch(patch) {
  const ops = [];
  let current = null;
  let hunk = null;
  const all = patch.replace(/\r\n/g, "\n").split("\n");
  const flush = () => { if (current) ops.push(current); current = null; hunk = null; };
  for (const raw of all) {
    let m;
    if (/^\*\*\*\s*(Begin|End) Patch\s*$/.test(raw)) { if (/End/.test(raw)) flush(); continue; }
    if ((m = /^\*\*\*\s*Add File:\s*(.+?)\s*$/.exec(raw))) { flush(); current = { kind: "add", path: unquote(m[1]), lines: [] }; continue; }
    if ((m = /^\*\*\*\s*Delete File:\s*(.+?)\s*$/.exec(raw))) { flush(); ops.push({ kind: "delete", path: unquote(m[1]) }); continue; }
    if ((m = /^\*\*\*\s*(?:Update|Modify) File:\s*(.+?)\s*$/.exec(raw))) { flush(); current = { kind: "update", path: unquote(m[1]), hunks: [] }; continue; }
    if (!current) continue;
    if (current.kind === "add") { if (raw.startsWith("+")) current.lines.push(raw.slice(1)); continue; }
    if ((m = /^\*\*\*\s*Move to:\s*(.+?)\s*$/.exec(raw))) { current.moveTo = unquote(m[1]); continue; }
    if (/^\*\*\*\s*End of File\s*$/.test(raw)) { if (hunk) hunk.eof = true; continue; }
    if (raw.startsWith("@@")) {
      const header = raw.replace(/^@@\s?/, "").replace(/\s?@@\s*$/, "");
      const nums = /^-(\d+)/.exec(header.trim());
      hunk = { header: nums ? "" : header.trim(), hint: nums ? Number(nums[1]) - 1 : null, ops: [], eof: false };
      current.hunks.push(hunk);
      continue;
    }
    const marker = raw[0];
    if (marker === "+" || marker === "-" || marker === " " || raw === "") {
      if (!hunk) { hunk = { header: "", hint: null, ops: [], eof: false }; current.hunks.push(hunk); }
      hunk.ops.push({ marker: raw === "" ? " " : marker, text: raw.slice(1) });
    }
  }
  flush();
  // 去掉每段末尾多余的空上下文行（补丁结尾常多一个空行；去掉只是少一行上下文，不影响结果）
  for (const op of ops) for (const h of op.hunks ?? []) {
    while (h.ops.length > 1 && h.ops[h.ops.length - 1].marker === " " && h.ops[h.ops.length - 1].text === "") h.ops.pop();
  }
  return ops;
}

function unquote(s) { return String(s).replace(/^["'`]|["'`]$/g, ""); }

/** 在 lines 里从 from 开始找 needle 这段（三档宽松度），返回起始下标或 -1 */
function seekBlock(all, needle, from, eof) {
  if (!needle.length) return eof ? all.length : -1;
  const norms = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const norm of norms) {
    const target = needle.map(norm);
    const tryAt = (i) => target.every((t, k) => norm(all[i + k] ?? "\u0000") === t);
    if (eof) { const i = all.length - target.length; if (i >= from && tryAt(i)) return i; }
    for (let i = from; i <= all.length - target.length; i++) if (tryAt(i)) return i;
  }
  return -1;
}

function applyUpdate(original, hunks) {
  const bom = original.startsWith("\uFEFF");
  const body = bom ? original.slice(1) : original;
  const eol = /\r\n/.test(body) ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(body);
  const all = body.split(/\r?\n/);
  if (finalNewline) all.pop();

  const replacements = [];
  let cursor = 0;
  let added = 0;
  let removed = 0;
  const diff = [];
  for (const [n, h] of hunks.entries()) {
    const oldLines = h.ops.filter(o => o.marker !== "+").map(o => o.text);
    const newLines = h.ops.filter(o => o.marker !== "-").map(o => o.text);
    let from = cursor;
    if (h.header) {
      const idx = all.findIndex((line, i) => i >= cursor && line.trim() && line.includes(h.header));
      if (idx >= 0) from = idx;
    }
    if (h.hint !== null && h.hint >= cursor) from = Math.max(cursor, Math.min(h.hint, all.length) - 50);
    let at;
    if (!oldLines.length) {
      // 纯新增：有标题就插在标题行后面，否则加到文件末尾
      at = h.header && from > cursor - 1 && all[from]?.includes(h.header) ? from + 1 : all.length;
    } else {
      at = seekBlock(all, oldLines, from, h.eof);
      if (at < 0 && from > cursor) at = seekBlock(all, oldLines, cursor, h.eof);
      if (at < 0) {
        const first = oldLines.find(l => l.trim()) ?? oldLines[0];
        return { error: `第 ${n + 1} 段对不上：找不到这几行原文（第一行是「${first}」）。请先 read_files 看当前内容，按真实文本重新生成补丁。` };
      }
    }
    replacements.push({ at, len: oldLines.length, lines: newLines });
    cursor = at + oldLines.length;
    added += h.ops.filter(o => o.marker === "+").length;
    removed += h.ops.filter(o => o.marker === "-").length;
    diff.push(`@@ -${at + 1},${oldLines.length} +${at + 1},${newLines.length} @@`, ...h.ops.map(o => `${o.marker}${o.text}`));
  }
  const out = all.slice();
  for (const r of replacements.sort((x, y) => y.at - x.at)) out.splice(r.at, r.len, ...r.lines);
  const content = (bom ? "\uFEFF" : "") + out.join(eol) + (finalNewline || !out.length ? eol : "");
  const diffText = diff.join("\n");
  return { content: out.length ? content : (bom ? "\uFEFF" : ""), added, removed, diff: diffText.length > 6000 ? `${diffText.slice(0, 6000)}\n…` : diffText };
}
