/**
 * vendor 补丁：在 tools/vendor-browseros.mjs 转完上游源码之后，把我们自己的改动逐条打上。
 *
 * 为什么不用 git / patch 命令：这两个都不保证在用户的机器上（仓库本身要求不跑 git），
 * 而这里的补丁都是「在一个已知位置插入若干行 / 替换若干行」，用最小的 unified-diff
 * 解析器就够，打不上就报错退出，绝不静默放过。
 *
 * 补丁文件放在 tools/vendor-patches/browseros/*.patch，格式是 diff -u 的标准输出，
 * 路径写成 a/src/vendor/... 和 b/src/vendor/...（相对仓库根）。生成方式：
 *   diff -u <上游转换结果> <改好的文件> > tools/vendor-patches/browseros/<文件名>.patch
 *
 * 规则：
 *   - 每个补丁必须至少有一个 hunk 真的落在目标文件上，否则报错（说明上游变了，补丁过期）；
 *   - 任何 hunk 的上下文对不上也报错，绝不模糊匹配（错一行就可能改坏别人的代码）；
 *   - 同一个文件可以被多个补丁依次改（按文件名排序）。
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 解析 unified diff：
 * 返回 [{ oldPath, newPath, hunks: [{ oldStart, oldLines, newStart, newLines, lines,
 *        oldNoEol, newNoEol }] }]
 * oldNoEol / newNoEol 来自 `\ No newline at end of file`，按它前面那行落在旧侧还是新侧记录。
 */
export function parsePatch(text) {
  const files = [];
  let current = null;
  let hunk = null;
  let consumedOld = 0;
  let consumedNew = 0;
  const hunkDone = () => hunk !== null && consumedOld >= hunk.oldLines && consumedNew >= hunk.newLines;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    // 标记行必须比「hunk 已读完」先处理：它一般紧跟在最后一行内容后面
    if (line.startsWith("\\") && hunk) {
      const previous = hunk.lines[hunk.lines.length - 1];
      if (previous?.startsWith("+")) hunk.newNoEol = true;
      else if (previous?.startsWith("-")) hunk.oldNoEol = true;
      else if (previous) { hunk.oldNoEol = true; hunk.newNoEol = true; }
      continue;
    }
    if (hunkDone()) hunk = null;
    if (line.startsWith("--- ")) {
      current = { oldPath: stripPrefix(line.slice(4)), newPath: null, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ") && current) {
      current.newPath = stripPrefix(line.slice(4));
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && current) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
        oldNoEol: false,
        newNoEol: false,
      };
      current.hunks.push(hunk);
      consumedOld = 0;
      consumedNew = 0;
      continue;
    }
    if (hunk && !hunkDone()) {
      const marker = line === "" ? " " : line[0];
      if (marker === " ") {
        hunk.lines.push(` ${line.slice(1)}`);
        consumedOld += 1;
        consumedNew += 1;
        continue;
      }
      if (marker === "+") {
        hunk.lines.push(line);
        consumedNew += 1;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push(line);
        consumedOld += 1;
        continue;
      }
      if (marker === "\\") continue; // 正常不会走到：标记行在上面已经处理
      throw new Error(`补丁里有看不懂的行：${JSON.stringify(line.slice(0, 80))}`);
    }
    if (line === "") continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    throw new Error(`补丁里有看不懂的行：${JSON.stringify(line.slice(0, 80))}`);
  }
  return files.filter((file) => file.newPath);
}

function stripPrefix(value) {
  const trimmed = value.split("\t")[0].trim();
  return trimmed.replace(/^[ab]\//, "");
}

/** 按行切分并保留每行自己的行尾（\r\n / \n / \r）；最后一行没有行尾时 eol 是 ""。 */
function splitLines(raw) {
  const parts = [];
  const re = /([^\r\n]*)(\r\n|\n|\r)/g;
  let match;
  let lastIndex = 0;
  while ((match = re.exec(raw))) {
    parts.push({ text: match[1], eol: match[2] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < raw.length) parts.push({ text: raw.slice(lastIndex), eol: "" });
  return parts;
}

/** 在 source 上应用一个文件的全部 hunk；上下文对不上就抛错。 */
export function applyFilePatch(source, file, label = file.newPath) {
  const raw = String(source);
  const parts = splitLines(raw);
  const defaultEol = raw.includes("\r\n") ? "\r\n" : "\n";
  let offset = 0;
  for (const hunk of file.hunks) {
    const oldLines = hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    // 零旧行 hunk（@@ -X,0）的 oldStart 语义是「插在第 X 行之后」，0 基插入点就是 X，不是 X-1
    const expected = hunk.oldLines === 0 ? hunk.oldStart + offset : hunk.oldStart - 1 + offset;
    let actual = findUniqueMatch(parts.map((part) => part.text), oldLines, expected);
    if (actual < 0) {
      throw new Error(`${label} 的补丁打不上：第 ${hunk.oldStart} 行附近的上下文对不上（上游可能变了，先更新补丁）`);
    }
    // 零旧行 hunk 落在（或越过）文件末尾、而源文件没有尾换行时：先给最后一行补上行尾，
    // 否则新插入的行会直接拼在上一行后面（"a\nb" + 插入 → "a\nbnew"）。
    if (hunk.oldLines === 0) {
      if (actual > parts.length) actual = parts.length;
      if (actual === parts.length && parts.length && parts[parts.length - 1].eol === "") {
        parts[parts.length - 1].eol = defaultEol;
      }
    }
    const replaced = parts.slice(actual, actual + oldLines.length);
    const insertEol = replaced[replaced.length - 1]?.eol || replaced[0]?.eol || defaultEol;
    // 这一处是不是改到文件末尾：决定要不要按补丁里的 no-newline 标记改尾换行
    const touchesEof = actual + oldLines.length === parts.length;
    const newParts = newLines.map((text, index) => {
      const isLast = index === newLines.length - 1;
      let eol = isLast && replaced.length ? replaced[replaced.length - 1].eol : insertEol;
      // 改到文件末尾：补丁声明了 no-newline 才去掉尾换行；没声明就保持源文件原样（不追加也不去掉）
      if (isLast && touchesEof) {
        if (hunk.newNoEol) eol = "";
        else if (replaced.length) eol = replaced[replaced.length - 1].eol;
        else eol = defaultEol;
      }
      return { text, eol };
    });
    parts.splice(actual, oldLines.length, ...newParts);
    offset += newParts.length - oldLines.length;
  }
  return parts.map((part) => part.text + part.eol).join("");
}

/** 把补丁反过来（+ 变 -、old/new 行号互换）：用于维护时从改过的文件还原上游原样，也用于测试。 */
export function reverseFilePatch(file) {
  return {
    oldPath: file.newPath,
    newPath: file.oldPath ?? file.newPath,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      oldLines: hunk.newLines,
      newStart: hunk.oldStart,
      newLines: hunk.oldLines,
      oldNoEol: hunk.newNoEol === true,
      newNoEol: hunk.oldNoEol === true,
      lines: hunk.lines.map((line) => {
        if (line.startsWith("+")) return `-${line.slice(1)}`;
        if (line.startsWith("-")) return `+${line.slice(1)}`;
        return line;
      }),
    })),
  };
}

/**
 * 找 oldLines 在 lines 里的位置：优先从 expected 开始找，找不到再全文件找（上游加了几行注释也能打上）。
 * 必须唯一，否则报错 —— 位置错了比打不上更危险。
 */
function findUniqueMatch(lines, oldLines, expected) {
  if (!oldLines.length) return expected;
  const matchesAt = (index) => index >= 0 && index + oldLines.length <= lines.length
    && oldLines.every((line, offset) => lines[index + offset] === line);
  if (matchesAt(expected)) return expected;
  const found = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    if (matchesAt(index)) found.push(index);
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(`补丁的上下文在文件里出现 ${found.length} 次，无法确定改哪一处`);
  }
  return -1;
}

/**
 * 把目录下所有 *.patch 按文件名顺序打到 outDir 里。
 * 返回 [{ file, hunks }]，任何一步失败都抛错（调用方负责退出）。
 */
export function applyPatchDirectory(patchDir, outDir, { log = () => {} } = {}) {
  const names = readdirSync(patchDir).filter((name) => name.endsWith(".patch")).sort();
  const applied = [];
  for (const name of names) {
    const text = readFileSync(path.join(patchDir, name), "utf8");
    const files = parsePatch(text);
    if (!files.length) throw new Error(`补丁 ${name} 里没有任何文件改动`);
    for (const file of files) {
      if (!file.hunks.length) throw new Error(`补丁 ${name} 里 ${file.newPath} 没有任何 hunk`);
      const target = path.join(outDir, file.newPath.replace(/^src\/vendor\/browseros\//, ""));
      let source;
      try {
        source = readFileSync(target, "utf8");
      } catch {
        throw new Error(`补丁 ${name} 指向的文件不存在：${file.newPath}`);
      }
      const patched = applyFilePatch(source, file, `${name} → ${file.newPath}`);
      writeFileSync(target, patched);
      log(`  ${name} → ${file.newPath}（${file.hunks.length} 处）`);
      applied.push({ file: file.newPath, hunks: file.hunks.length });
    }
  }
  return applied;
}
