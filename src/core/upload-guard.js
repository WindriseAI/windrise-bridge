/**
 * 上传文件的路径守卫：AI 让浏览器往页面里塞文件时，只许塞「用户授权过的工作区目录」里的文件。
 *
 * 为什么单独一层：`DOM.setFileInputFiles` 传的是浏览器进程本机的绝对路径，等于把 AI 的读能力
 * 借给了网页 —— 一个被投毒的页面只要放个 `<input type=file>`，就能让 AI 把 `~/.ssh/id_rsa`
 * 或别的账号目录里的文件塞进上传框。所以路径必须在主进程里判，判完才交给 CDP。
 *
 * 判定分三层，任何一层不过都拒绝：
 *   1. 参数层：必须是绝对路径，不能是 URL / 盘符相对 / UNC 共享路径，数量有上限；
 *   2. 存在层：必须存在、必须是普通文件（目录、设备、管道一律不行）；
 *   3. 边界层：解析软链后的真实路径必须落在某个授权根目录里（根目录自己也算）。
 *
 * 这里只做判断，不发 CDP、不读文件内容；错误统一带 code，方便上层原样交给 MCP。
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 一次最多塞多少个文件：再多基本是拿上传框当传输通道，不是正常表单。 */
export const MAX_UPLOAD_FILES = 10;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 绝对路径？Windows 上同时认 C:\x 和 \\server\share\x 的写法。 */
function isAbsolutePath(value) {
  return path.isAbsolute(String(value ?? ""));
}

/** 规范化授权根：去空、解析成绝对路径。 */
export function normalizeRoots(roots) {
  const list = (Array.isArray(roots) ? roots : [roots])
    .map((root) => String(root ?? "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  return [...new Set(list)];
}

/** 真实路径是否在根目录里（根目录自己也算在内）。 */
function insideRoot(realPath, realRoot) {
  if (realPath === realRoot) return true;
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realPath.startsWith(prefix);
}

/**
 * 校验一批上传路径，返回可以交给 CDP 的真实路径。
 *
 * @param {string[]|string} files  调用方给的文件路径（字符串或数组）
 * @param {string[]|string} roots  用户授权过的目录（工作区根 + 额外授权目录）
 * @returns {Promise<string[]>} 解析软链后的真实路径，顺序和输入一致
 */
export async function checkUploadPaths(files, roots) {
  const raw = (Array.isArray(files) ? files : [files])
    .map((file) => (typeof file === "string" ? file.trim() : ""))
    .filter((file) => file.length > 0);
  if (!raw.length) throw codedError("INVALID_ARGUMENT", "upload 要给 files（一个或多个要上传的文件路径）");
  if (raw.length > MAX_UPLOAD_FILES) {
    throw codedError("INVALID_ARGUMENT", `一次最多上传 ${MAX_UPLOAD_FILES} 个文件（这次给了 ${raw.length} 个）`);
  }
  const allowedRoots = normalizeRoots(roots);
  if (!allowedRoots.length) {
    throw codedError("PATH_DENIED", "还没有授权任何工作区目录，不能上传文件：先让用户在「设置 → 工作区」里添加文件夹");
  }
  // 根目录本身也可能是个软链（macOS 的 /tmp → /private/tmp）：先各自解析一次
  const realRoots = [];
  for (const root of allowedRoots) {
    const real = await realpath(root).catch(() => null);
    if (real) realRoots.push(real);
  }
  if (!realRoots.length) {
    throw codedError("PATH_DENIED", `授权的工作区目录都不存在（${allowedRoots.join(" / ")}），不能上传文件`);
  }

  const resolved = [];
  for (const candidate of raw) {
    if (!isAbsolutePath(candidate)) {
      throw codedError("PATH_DENIED", `上传路径必须是绝对路径：${candidate}（相对路径不知道相对于谁，不猜）`);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      throw codedError("PATH_DENIED", `上传只收本机文件路径，不收网址：${candidate}`);
    }
    // 先做一次字符串层判定：明显越界的路径连 stat 都不用做（不泄露「这个文件存不存在」）
    const lexical = path.resolve(candidate);
    if (!allowedRoots.some((root) => insideRoot(lexical, root))) {
      throw codedError(
        "PATH_DENIED",
        `上传路径越界：${candidate} 不在授权的工作区目录里（${allowedRoots.join(" / ")}）。只能上传工作区里的文件；要传别的目录，请让用户在「设置 → 工作区」里添加它`,
      );
    }
    const info = await stat(lexical).catch(() => null);
    if (!info) throw codedError("NOT_FOUND", `上传的文件不存在：${candidate}`);
    if (!info.isFile()) throw codedError("INVALID_ARGUMENT", `上传只收普通文件：${candidate} 不是文件（目录 / 设备 / 管道都不行）`);
    // 软链可能指向工作区之外：真实路径再判一次
    const real = await realpath(lexical).catch(() => null);
    if (!real) throw codedError("NOT_FOUND", `上传的文件读不到真实路径（可能是个断掉的软链）：${candidate}`);
    if (!realRoots.some((root) => insideRoot(real, root))) {
      throw codedError(
        "PATH_DENIED",
        `上传路径越界：${candidate} 是指向工作区之外的软链（真实路径 ${real}），拒绝上传`,
      );
    }
    resolved.push(real);
  }
  return resolved;
}
