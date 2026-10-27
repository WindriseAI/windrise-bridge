/**
 * 路由令牌 —— 参照学习软件的「把口令写进 URL 路径」做法。
 *
 * 为什么不用 Bearer 头：ChatGPT Connector、Arena、Manus 这类第三方 MCP 客户端
 * 只让你填一个 URL，不给自定义头的位置。所以学习软件把随机令牌放进路径：
 *     https://xxx.trycloudflare.com/mcp/<32位随机令牌>
 * 猜不到令牌就进不来，等于「把密码藏在地址里」。
 * 单窗口单令牌、持久化保存（重启后地址不变）。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOKEN_BYTES = 16;              // → 32 位十六进制，和学习软件同长度
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function newRouteToken() {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function isValidRouteToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function routeTokenFile(root = defaultRoot()) {
  return path.join(root, "route-token.json");
}

function defaultRoot(env = process.env, home = os.homedir()) {
  const explicit = env.BRIDGE_DATA_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(home, ".bridge-replica");
}

/**
 * 读取或首次生成令牌。同一台机器上多次启动地址保持一致，
 * 用户粘到 ChatGPT 里的 URL 不会每次失效。
 */
export async function loadOrCreateRouteToken(root = defaultRoot()) {
  const file = routeTokenFile(root);
  const existing = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
  if (existing && isValidRouteToken(existing.token)) return { token: existing.token, file, created: false };
  const token = newRouteToken();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ version: 1, token, createdAt: Date.now() }, null, 2), { mode: 0o600 });
  return { token, file, created: true };
}

/**
 * 换一把新的路径令牌（2026-10-25，口令入口迁移第 3 步）：旧地址立即作废。
 * 只写文件，桥要重启（断开 → 一键连接）才用上新令牌；临时文件 + rename，写一半断电不留坏文件。
 */
export async function rotateRouteToken(root = defaultRoot()) {
  const file = routeTokenFile(root);
  const old = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
  let token;
  do { token = newRouteToken(); } while (old && token === old.token);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const now = Date.now();
  try {
    await writeFile(temp, JSON.stringify({ version: 1, token, createdAt: now, rotatedAt: now }, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return { token, file };
}
