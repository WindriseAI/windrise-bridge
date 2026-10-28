/**
 * 流程回放的执行开关。
 *
 * 设置项 `flowReplayExecute` 默认 **false**：关着时 flow_replay 只能干跑（预演），
 * 列出将要做的动作和不支持的步骤，一步都不执行；带 execute:true 调用直接返回 FEATURE_DISABLED。
 * 打开后才允许 execute:true 真正操作页面。
 *
 * 这里直接读 <数据目录>/settings.json（和 Electron 的 SettingsStore 同一个文件），
 * 读不到 / 读坏 / 字段不是 true 一律按关闭处理 —— 失败方向必须是「不执行」。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** 默认值：执行关闭。和 electron/settings.cjs 的 DEFAULTS.flowReplayExecute 保持一致。 */
export const DEFAULT_FLOW_REPLAY_EXECUTE = false;

/**
 * 读取这个数据目录里的流程回放执行开关。
 * @param {string} [dataHome]
 * @returns {Promise<boolean>}
 */
export async function flowReplayExecuteEnabled(dataHome) {
  if (!dataHome) return DEFAULT_FLOW_REPLAY_EXECUTE;
  try {
    const raw = await readFile(path.join(dataHome, "settings.json"), "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return parsed?.flowReplayExecute === true;
  } catch {
    return DEFAULT_FLOW_REPLAY_EXECUTE;
  }
}