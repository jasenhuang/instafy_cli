import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:8188";
/** 用户配置：{ "url": "...", "out": "...", "timeout": 1800 } */
export const CONFIG_FILE = path.join(os.homedir(), ".instafy.json");

export interface InstafyConfig {
  url?: string;
  /** 默认输出目录，支持 ~ 开头 */
  out?: string;
  /** 默认等待上限（秒） */
  timeout?: number;
}

function invalid(file: string, detail: string): Error {
  return new Error(`配置文件 ${file} ${detail}`);
}

export function loadConfig(file = CONFIG_FILE): InstafyConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`读取配置文件失败 ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid(file, "不是合法的 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid(file, "内容应为 JSON 对象");
  }

  const { url, out, timeout } = parsed as Record<string, unknown>;
  const config: InstafyConfig = {};

  if (url !== undefined) {
    if (typeof url !== "string" || url.trim() === "") throw invalid(file, "的 url 应为非空字符串");
    const trimmed = url.trim().replace(/\/+$/, "");
    try {
      new URL(trimmed);
    } catch {
      throw invalid(file, `的 url 不是合法地址: ${trimmed}`);
    }
    config.url = trimmed;
  }

  if (out !== undefined) {
    if (typeof out !== "string" || out.trim() === "") throw invalid(file, "的 out 应为非空字符串");
    config.out = out.trim();
  }

  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw invalid(file, "的 timeout 应为正数（秒）");
    }
    config.timeout = timeout;
  }

  return config;
}

/** 展开开头的 ~，再按当前目录解析成绝对路径 */
export function resolveOutDir(flag?: string, config: InstafyConfig = loadConfig()): string {
  const dir = flag ?? config.out ?? "outputs";
  const home = os.homedir();
  const expanded = dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;
  return path.resolve(expanded);
}

export const DEFAULT_TIMEOUT = 1800;

export function resolveTimeout(flag?: number, config: InstafyConfig = loadConfig()): number {
  return flag ?? config.timeout ?? DEFAULT_TIMEOUT;
}

/** 优先级：--url > INSTAFY_COMFY_URL > ~/.instafy.json > 默认地址 */
export function resolveBaseUrl(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
  config: InstafyConfig = loadConfig(),
): string {
  return flag ?? env.INSTAFY_COMFY_URL ?? config.url ?? DEFAULT_URL;
}
