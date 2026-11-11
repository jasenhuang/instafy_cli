import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

export interface TunnelOptions {
  /** SSH 主机（~/.ssh/config 里的别名或 user@host） */
  sshHost?: string;
  /** false 时不自动建隧道，直接连给定地址 */
  enabled?: boolean;
}

export interface Reachable {
  baseUrl: string;
  /** 需要退出时调用，关闭自动建立的隧道 */
  stop: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.startsWith("127.");
}

async function ping(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(baseUrl + "/system_stats", { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function findFreePort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });

  return (async () => {
    if (await tryListen(preferred)) return preferred;
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        server.close(() => resolve(port));
      });
    });
  })();
}

/**
 * 保证 ComfyUI 可达：先直连；若地址是本机且连不上，则通过 SSH 建本地端口转发。
 * ComfyUI 默认只监听 novel 上的 127.0.0.1:8188，所以本地直接访问需要隧道。
 */
export async function ensureComfyReachable(baseUrl: string, opts: TunnelOptions = {}): Promise<Reachable> {
  const url = new URL(baseUrl);
  if (!isLoopback(url.hostname) || opts.enabled === false) {
    return { baseUrl, stop: () => {} };
  }

  if (await ping(baseUrl, 2000)) {
    return { baseUrl, stop: () => {} };
  }

  const sshHost = opts.sshHost;
  if (!sshHost) {
    throw new Error(
      `连不上 ${baseUrl}，且没有配置 SSH 主机。\n` +
        `请先用 ssh -N -L ${url.port || 8188}:127.0.0.1:${url.port || 8188} <主机> 建隧道，或用 --ssh <主机> 指定。`,
    );
  }

  const sshPort = Number(url.port || 8188);
  const localPort = await findFreePort(sshPort);
  const child: ChildProcess = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-N",
      "-L",
      `${localPort}:127.0.0.1:${sshPort}`,
      sshHost,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const localBase = `http://127.0.0.1:${localPort}`;
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  const cleanup = () => stop();
  process.once("exit", cleanup);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`SSH 隧道启动失败 (${sshHost}): ${stderr.trim() || "ssh 已退出"}`);
    }
    if (await ping(localBase, 1500)) {
      return { baseUrl: localBase, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  stop();
  throw new Error(`SSH 隧道 20 秒内未就绪 (${sshHost}, 本地端口 ${localPort}): ${stderr.trim()}`);
}
