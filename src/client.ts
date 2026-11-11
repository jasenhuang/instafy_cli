import fs from "node:fs/promises";
import type { NodeSchema } from "./convert.js";
export type PromptGraph = Record<string, PromptNode>;

export interface PromptNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface OutputRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

export class ComfyError extends Error {}

function errMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload);
  const data = payload as { error?: unknown; node_errors?: Record<string, any> };
  const lines: string[] = [];
  if (data.error && typeof data.error === "object" && "message" in data.error) {
    lines.push(String((data.error as { message: unknown }).message));
  } else if (data.error) {
    lines.push(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }
  for (const [nodeId, nodeError] of Object.entries(data.node_errors ?? {})) {
    for (const e of (nodeError?.errors ?? []) as Array<{ message?: string; details?: string }>) {
      lines.push(`节点 ${nodeId} (${nodeError?.class_type}): ${e.message ?? ""} ${e.details ?? ""}`.trim());
    }
  }
  return lines.join("\n") || JSON.stringify(payload);
}

export class ComfyClient {
  constructor(readonly baseUrl: string) {}

  async request(pathname: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
    try {
      return await fetch(this.baseUrl + pathname, {
        ...init,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      throw new ComfyError(`连不上 ComfyUI (${this.baseUrl}): ${(err as Error).message}`);
    }
  }

  /** 健康检查，连不上时返回 false 而不抛错。 */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await this.request("/system_stats", undefined, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string> {
    const buf = await fs.readFile(filePath);
    const name = filePath.split(/[\\/]/).pop()!;
    const ext = name.toLowerCase().split(".").pop() ?? "";
    const mime =
      { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] ??
      "application/octet-stream";

    const form = new FormData();
    form.append("image", new Blob([buf], { type: mime }), name);
    form.append("subfolder", "instafy");
    form.append("type", "input");
    form.append("overwrite", "true");

    const res = await this.request("/upload/image", { method: "POST", body: form }, 60_000);
    const text = await res.text();
    if (!res.ok) throw new ComfyError(`上传参考图失败: ${errMessage(safeJson(text) ?? text)}`);

    const data = JSON.parse(text) as { name: string; subfolder?: string };
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  async queue(graph: PromptGraph): Promise<string> {
    const res = await this.request(
      "/prompt",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: `instafy-${process.pid}` }),
      },
      60_000,
    );
    const text = await res.text();
    if (!res.ok) throw new ComfyError(`提交任务失败:\n${errMessage(safeJson(text) ?? text)}`);
    return (JSON.parse(text) as { prompt_id: string }).prompt_id;
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const res = await this.request(`/history/${promptId}`, undefined, 30_000);
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, HistoryEntry>;
    return data[promptId];
  }

  async wait(
    promptId: string,
    opts: { timeoutMs: number; intervalMs?: number; onTick?: (elapsedMs: number) => void },
  ): Promise<{ entry: HistoryEntry; elapsedMs: number }> {
    const started = Date.now();
    const deadline = started + opts.timeoutMs;
    let lastTick = started;

    while (Date.now() < deadline) {
      const entry = await this.history(promptId);
      if (entry) {
        await assertSuccess(entry);
        return { entry, elapsedMs: Date.now() - started };
      }
      const now = Date.now();
      if (now - lastTick >= (opts.intervalMs ?? 2000)) {
        opts.onTick?.(now - started);
        lastTick = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ComfyError(`等待超时（${Math.round(opts.timeoutMs / 1000)} 秒），任务 ${promptId} 仍在队列中`);
  }

  /** 全量节点 schema（约 3.7 MB），转换工作流时用来做 widgets 位置映射。 */
  async objectInfo(): Promise<Record<string, NodeSchema>> {
    const res = await this.request("/object_info", undefined, 120_000);
    if (!res.ok) throw new ComfyError(`读取 /object_info 失败: HTTP ${res.status}`);
    return (await res.json()) as Record<string, NodeSchema>;
  }

  /**
   * 列出 user/default 下的文件（例如 dir=workflows）。
   * ComfyUI 的 userdata 路由同时挂在 /api/userdata 和 /userdata 上，这里做兜底。
   */
  async listUserData(dir: string, recurse: boolean): Promise<string[]> {
    const qs = new URLSearchParams({ dir });
    if (recurse) qs.set("recurse", "true");
    let lastError = "";
    for (const base of ["/api/userdata", "/userdata"]) {
      const res = await this.request(`${base}?${qs}`, undefined, 60_000);
      if (res.ok) {
        const data = (await res.json()) as unknown;
        if (Array.isArray(data)) return data.map(String);
        lastError = `返回内容不是数组`;
        continue;
      }
      lastError = `HTTP ${res.status}`;
    }
    throw new ComfyError(`列出 userdata 目录 ${dir} 失败: ${lastError}`);
  }

  /** 读取 userdata 文件内容（工作流 JSON），返回原始字节以便算 sha1。 */
  async readUserData(filePath: string): Promise<Buffer> {
    const encoded = encodeURIComponent(filePath);
    let lastError = "";
    for (const base of ["/api/userdata/", "/userdata/"]) {
      const res = await this.request(`${base}${encoded}`, undefined, 120_000);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = `HTTP ${res.status}`;
    }
    throw new ComfyError(`读取 userdata 文件 ${filePath} 失败: ${lastError}`);
  }

  async download(ref: OutputRef, destPath: string): Promise<void> {
    const qs = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? "",
      type: ref.type ?? "output",
    });
    const res = await this.request(`/view?${qs}`, undefined, 300_000);
    if (!res.ok) throw new ComfyError(`下载 ${ref.filename} 失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buf);
  }
}

async function assertSuccess(entry: HistoryEntry): Promise<void> {
  const status = entry.status;
  if (status?.status_str === "error") {
    const messages = JSON.stringify(status.messages ?? []).slice(0, 2000);
    throw new ComfyError(`ComfyUI 执行失败:\n${messages}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 从 history outputs 里挑出真正落盘的文件（忽略预览 / 临时文件）。 */
export function collectOutputs(entry: HistoryEntry): OutputRef[] {
  const refs: OutputRef[] = [];
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const ref = item as OutputRef;
        if (typeof ref.filename !== "string") continue;
        if (ref.type && ref.type !== "output") continue;
        if (!refs.some((r) => r.filename === ref.filename && r.subfolder === ref.subfolder)) {
          refs.push(ref);
        }
      }
    }
  }
  return refs;
}
