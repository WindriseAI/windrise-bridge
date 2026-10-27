/**
 * asar 头部解析 + 指定文件提取（零依赖）。
 *
 * 头部实际布局（实测 DSH 的 app.asar，每段 UInt32LE）：
 *   偏移  0 : 4              pickle 长度前缀
 *   偏移  4 : jsonLen + 8    headerBuf 总长
 *   偏移  8 : jsonLen + 4    headerBuf 载荷长
 *   偏移 12 : jsonLen        JSON 长度
 *   偏移 16 : JSON 本体       ← 起点在这里
 *   数据区  : 16 + jsonLen，各文件 offset 相对这里算
 *
 * 踩过的坑（两次）：
 *   ① 一开始以为 JSON 从 8 开始 → "Unexpected non-whitespace character after JSON"
 *   ② 改成 12 还是不对 → 实际是 16（少算了嵌套 pickle 的两层长度前缀）
 * 所以现在不硬编码了：按 4 个长度字段推，再扫描第一个 '{' 交叉验证，
 * 两者不一致就以扫描结果为准并打日志 —— 换打包器也不至于瞎。
 *
 * 运行：node asar-peek.mjs <asar路径> [list|grep:关键词|cat:路径]
 */

import { open } from "node:fs/promises";

/** 读取足够的头部前缀用来定位 JSON。 */
const PROBE_BYTES = 64;

async function readHeader(asarPath) {
  const handle = await open(asarPath, "r");
  try {
    const probe = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, PROBE_BYTES, 0);
    if (bytesRead < 16) throw new Error(`文件太小，不像是 asar：只读到 ${bytesRead} 字节`);

    const pickleLength = probe.readUInt32LE(0);
    if (pickleLength !== 4) {
      throw new Error(
        `asar 头部不像是标准布局：偏移 0 的 pickle 长度应为 4，实际是 ${pickleLength}。` +
        ` 这个文件可能不是 asar，或者用了别的封装格式。`
      );
    }

    // 按布局推：JSON 长度在偏移 12，JSON 本体从 16 开始
    const jsonLength = probe.readUInt32LE(12);
    let jsonStart = 16;

    // 交叉验证：在探测区里找第一个 '{'。理论上应当等于 16。
    const braceIndex = probe.indexOf(0x7b);
    if (braceIndex >= 0 && braceIndex !== jsonStart) {
      // 以实际扫描结果为准（换打包器、或者有额外字段时能自愈）
      jsonStart = braceIndex;
    }

    if (!Number.isFinite(jsonLength) || jsonLength <= 0 || jsonLength > 512 * 1024 * 1024) {
      throw new Error(`asar 头部长度不合理：偏移 12 读到 ${jsonLength}`);
    }

    const headerBuf = Buffer.alloc(jsonLength);
    await handle.read(headerBuf, 0, jsonLength, jsonStart);

    let header;
    try {
      header = JSON.parse(headerBuf.toString("utf8"));
    } catch (error) {
      throw new Error(
        `asar 头部 JSON 解析失败（${error.message}）。` +
        ` 起点 ${jsonStart}、长度 ${jsonLength}。前 80 字节：${headerBuf.subarray(0, 80).toString("utf8")}`
      );
    }

    const dataStart = jsonStart + jsonLength;
    return { handle, header, dataStart, jsonStart, jsonLength };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function walk(node, prefix = "", out = []) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (value.files) walk(value, full, out);
    else out.push({ path: full, size: value.size ?? 0, offset: value.offset ? Number(value.offset) : 0, unpacked: Boolean(value.unpacked) });
  }
  return out;
}

const [asarPath, command = "list"] = process.argv.slice(2);
if (!asarPath) { console.log("用法: node asar-peek.mjs <asar路径> [list|grep:关键词|cat:内部路径]"); process.exit(1); }

const { handle, header, dataStart } = await readHeader(asarPath);
const files = walk(header);
console.log(`# asar: ${asarPath}`);
console.log(`# 文件总数: ${files.length}\n`);

if (command === "list") {
  const interesting = files.filter(f => /\.(css|html)$/.test(f.path) && !/node_modules|libreoffice|LICENSES/i.test(f.path));
  console.log(`界面相关文件 ${interesting.length} 个：`);
  for (const f of interesting.slice(0, 80)) console.log(`  ${String(f.size).padStart(9)}  ${f.path}`);
  console.log("\n最大的 20 个文件：");
  for (const f of [...files].sort((a, b) => b.size - a.size).slice(0, 20)) console.log(`  ${String(f.size).padStart(10)}  ${f.path}`);
} else if (command.startsWith("grep:")) {
  const keyword = command.slice(5);
  const hits = files.filter(f => f.path.toLowerCase().includes(keyword.toLowerCase()));
  console.log(`匹配 "${keyword}" 的 ${hits.length} 个文件：`);
  for (const f of hits.slice(0, 60)) console.log(`  ${String(f.size).padStart(9)}  ${f.path}`);
} else if (command.startsWith("cat:")) {
  const target = command.slice(4);
  const file = files.find(f => f.path === target || f.path.endsWith(target));
  if (!file) { console.log("找不到:", target); process.exit(1); }
  if (file.size > 400_000) { console.log(`文件过大（${file.size} 字节），只读前 400KB`); }
  const length = Math.min(file.size, 400_000);
  const buf = Buffer.alloc(length);
  await handle.read(buf, 0, length, dataStart + file.offset);
  console.log(`# ${file.path}（${file.size} 字节）\n`);
  console.log(buf.toString("utf8"));
}
await handle.close();
