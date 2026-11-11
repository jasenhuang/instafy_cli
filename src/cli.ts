#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ComfyClient, ComfyError, collectOutputs } from "./client.js";
import { syncWorkflows } from "./sync.js";
import { DEFAULT_URL, loadConfig, resolveBaseUrl, resolveOutDir, resolveTimeout } from "./config.js";
import {
  buildGraph,
  loadBuiltinWorkflows,
  resolveWorkflow,
  supportedParams,
  type ParamKey,
  type Params,
  type Workflow,
  type WorkflowKind,
} from "./workflows.js";

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(["help", "json", "dry-run", "force", "prune"]);
const ALIASES: Record<string, string> = {
  p: "prompt",
  r: "ref",
  n: "negative",
  w: "workflow",
  o: "out",
  h: "help",
};
const NUMBER_KEYS = new Set(["width", "height", "seed", "steps", "seconds", "fps", "timeout"]);

interface Options {
  command?: string;
  positional: string[];
  json?: boolean;
  help?: boolean;
  prompt?: string;
  ref?: string;
  negative?: string;
  workflow?: string;
  out?: string;
  url?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  seconds?: number;
  fps?: number;
  timeout?: number;
  dir?: string;
  dryRun?: boolean;
  force?: boolean;
  prune?: boolean;
}

const HELP = `instafy — 调用 ComfyUI 生成图片 / 视频

用法:
  instafy image [选项] [提示词]     生成图片
  instafy video [选项] [提示词]     生成视频
  instafy run <工作流> [选项]       指定工作流生成（名称或相对路径）
  instafy workflows                列出可用工作流
  instafy sync [选项]              同步 ComfyUI 工作流并转成 API 格式

选项:
  -p, --prompt <文本>       提示词（也可直接放在命令后面）
  -r, --ref <文件>          参考图 / 首帧图，本地文件会自动上传
  -n, --negative <文本>     反向提示词
  -w, --workflow <名称|路径> 工作流名称、相对路径（wan/wan2_2_14B_t2v）或 JSON 路径
      --width <像素>        宽度        --height <像素>  高度
      --seed <整数>         随机种子（默认随机）
      --steps <整数>        采样步数
      --seconds <秒>        视频时长    --fps <帧率>     视频帧率
  -o, --out <目录>          输出目录（默认 ./outputs，可由配置指定）
      --timeout <秒>        等待上限（默认 1800，可由配置指定）
      --url <地址>          ComfyUI 地址（默认 ~/.instafy.json，否则 ${DEFAULT_URL}）
      --json                以 JSON 打印结果
  -h, --help                显示帮助

sync 选项:
      --dir <相对目录>      user/default 下的目录，默认 workflows
                            （也可写 ~/ComfyUI/user/default/workflows）
      --dry-run             只列出会新增/更新的工作流
      --force               忽略变更检测，强制重新转换覆盖
      --prune               删除远端已不存在的工作流文件

配置文件 ~/.instafy.json:
  { "url": "http://127.0.0.1:8188", "out": "~/instafy-outputs", "timeout": 1800,
    "defaults": { "image": "qwen_image_2_1_t2i", "imageRef": "flux2_klein_i2i",
                  "video": "wan2_2_14B_t2v", "videoRef": "minimax_h3_i2v" } }
  只写需要的字段；命令行参数优先于配置。

环境变量:
  INSTAFY_COMFY_URL   ComfyUI 地址（优先级高于配置文件）

示例:
  instafy image "一只戴墨镜的橘猫，棚拍质感"
  instafy image --ref ./me.jpg "换成东京夜景背景"
  instafy video --prompt "海边日落，镜头缓慢推进" --seconds 5
  instafy video --ref ./start.png "人物慢慢转头看向镜头"
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = { positional: [] };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith("-")) {
      if (!opts.command) opts.command = token;
      else opts.positional.push(token);
      continue;
    }
    if (token === "--") continue;

    let name = token.replace(/^--?/, "");
    let inlineValue: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = ALIASES[name] ?? name;

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`--${name} 不接受取值`);
      if (name === "help") opts.help = true;
      else if (name === "json") opts.json = true;
      else if (name === "dry-run") opts.dryRun = true;
      else if (name === "force") opts.force = true;
      else if (name === "prune") opts.prune = true;
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} 缺少取值`);

    if (NUMBER_KEYS.has(name)) {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new UsageError(`--${name} 需要数字，收到 "${value}"`);
      (opts as unknown as Record<string, unknown>)[name] = num;
    } else {
      (opts as unknown as Record<string, unknown>)[name] = value;
    }
  }

  return opts;
}

function log(message: string): void {
  process.stderr.write(message + "\n");
}

function humanDuration(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${(seconds / 60).toFixed(1)} 分钟`;
}

async function uniqueTarget(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, `${stem}${ext}`);
  let index = 2;
  while (await fs.stat(candidate).then(() => true, () => false)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

const PARAM_LABELS: Partial<Record<ParamKey, string>> = {
  prompt: "--prompt",
  negative: "--negative",
  image: "--ref",
  width: "--width",
  height: "--height",
  seed: "--seed",
  steps: "--steps",
  seconds: "--seconds",
  fps: "--fps",
};

function warnUnsupported(workflow: Workflow, params: Params): void {
  const supported = new Set(supportedParams(workflow));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!supported.has(key as ParamKey)) {
      log(`提示：工作流 ${workflow.name} 不支持 ${PARAM_LABELS[key as ParamKey] ?? key}，已忽略`);
    }
  }
}

async function generate(kind: WorkflowKind | undefined, opts: Options, workflowSpec?: string): Promise<void> {
  const prompt = opts.prompt ?? opts.positional[0];
  const config = loadConfig();
  const workflow = resolveWorkflow(workflowSpec ?? opts.workflow, kind, Boolean(opts.ref), config.defaults, log);
  const mode = kind ?? workflow.kind;

  if (kind && workflow.kind !== kind) {
    throw new UsageError(`工作流 ${workflow.name} 是 ${workflow.kind} 类型，不能用 ${kind} 模式跑`);
  }
  if (workflow.bindings.image && !opts.ref) {
    throw new UsageError(
      `工作流 ${workflow.name} 需要参考图，请加 --ref <图片>；想跑纯文生视频可加 --workflow wan2_2_14B_t2v`,
    );
  }
  if (!prompt && !opts.ref) {
    throw new UsageError("请提供提示词（--prompt 或直接跟在命令后面），或用 --ref 提供参考图");
  }

  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  const params: Params = {
    prompt,
    negative: opts.negative,
    width: opts.width,
    height: opts.height,
    steps: opts.steps,
    seed,
    seconds: opts.seconds,
    fps: opts.fps,
    image: undefined,
  };
  warnUnsupported(workflow, params);

  const client = new ComfyClient(resolveBaseUrl(opts.url, process.env, config));

  if (opts.ref) {
    log(`上传参考图 ${opts.ref} …`);
    params.image = await client.uploadImage(opts.ref);
  }

  const graph = buildGraph(workflow, params);
  const promptId = await client.queue(graph);
  log(`已提交 ${workflow.name}，任务 ${promptId}，种子 ${seed}`);

  const { entry, elapsedMs } = await client.wait(promptId, {
    timeoutMs: resolveTimeout(opts.timeout, config) * 1000,
    intervalMs: 15_000,
    onTick: (elapsed) => log(`等待中… 已用 ${humanDuration(elapsed)}`),
  });

  const refs = collectOutputs(entry);
  const outDir = resolveOutDir(opts.out, config);
  await fs.mkdir(outDir, { recursive: true });

  const files: string[] = [];
  for (const ref of refs) {
    const target = await uniqueTarget(outDir, ref.filename);
    await client.download(ref, target);
    files.push(target);
  }
  if (files.length === 0) throw new ComfyError("任务完成但没有产出文件，请检查工作流的 Save 节点");

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { workflow: workflow.name, kind: mode, promptId, seed, elapsedSeconds: elapsedMs / 1000, files },
        null,
        2,
      ) + "\n",
    );
  } else {
    log(`完成，用时 ${humanDuration(elapsedMs)}`);
    for (const file of files) process.stdout.write(file + "\n");
  }
}

async function runSync(opts: Options): Promise<void> {
  const result = await syncWorkflows({
    url: opts.url,
    dir: opts.dir,
    dryRun: opts.dryRun,
    force: opts.force,
    prune: opts.prune,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  log(`远端目录 ${result.remoteDir}${opts.dryRun ? "（--dry-run，未写入文件）" : ""}`);
  log(
    `新增 ${result.added.length} / 更新 ${result.updated.length} / 未变 ${result.unchanged.length} / ` +
      `跳过 ${result.skipped.length} / 失败 ${result.failed.length}` +
      (result.pruned.length > 0 ? ` / 删除 ${result.pruned.length}` : ""),
  );
  for (const rel of result.added) process.stdout.write(`  + ${rel}\n`);
  for (const rel of result.updated) process.stdout.write(`  ~ ${rel}\n`);
  for (const rel of result.pruned) process.stdout.write(`  - ${rel}\n`);
  for (const rel of result.skipped) process.stdout.write(`  ? ${rel}\n`);
  for (const item of result.failed) log(`  ! ${item.rel}: ${item.error}`);
}

async function listWorkflows(): Promise<void> {
  const workflows = loadBuiltinWorkflows();
  if (workflows.size === 0) {
    log("workflows/ 目录下没有工作流，先运行 instafy sync");
    return;
  }

  const groups = new Map<string, Workflow[]>();
  for (const workflow of [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = workflow.source ?? `${workflow.name}.json`;
    const parts = rel.split("/");
    const group = parts.length > 1 ? parts.slice(0, -1).join("/") : "（根目录）";
    const list = groups.get(group) ?? [];
    list.push(workflow);
    groups.set(group, list);
  }

  const names = [...workflows.values()].map((workflow) => workflow.name);
  const nameWidth = Math.max(16, ...names.map((name) => name.length));
  const paramOrder: ParamKey[] = ["negative", "width", "height", "seconds", "fps", "steps", "seed"];

  process.stdout.write(`共 ${workflows.size} 个工作流（ref = 需要 --ref）\n`);
  for (const [group, list] of [...groups.entries()].sort((a, b) =>
    a[0] === "（根目录）" ? -1 : b[0] === "（根目录）" ? 1 : a[0].localeCompare(b[0]),
  )) {
    process.stdout.write(`\n${group}\n`);
    for (const workflow of list) {
      const params = paramOrder.filter((key) => workflow.bindings[key]);
      const flags = params.map((key) => `--${key}`).join(" ");
      const ref = workflow.bindings.image ? "ref" : "-";
      const line = `  ${workflow.name.padEnd(nameWidth)}  ${workflow.kind.padEnd(6)}${ref.padEnd(4)}${flags}`;
      process.stdout.write(`${line.trimEnd()}\n`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command) {
    process.stdout.write(HELP);
    return;
  }

  switch (opts.command) {
    case "image":
      return generate("image", opts);
    case "video":
      return generate("video", opts);
    case "run": {
      const spec = opts.positional.shift();
      if (!spec) throw new UsageError("用法: instafy run <工作流> [选项]");
      return generate(undefined, opts, spec);
    }
    case "workflows":
      return listWorkflows();
    case "sync":
      return runSync(opts);
    default:
      throw new UsageError(`未知命令 "${opts.command}"，可用: image / video / run / workflows / sync`);
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`错误: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
  } else if (err instanceof ComfyError) {
    process.stderr.write(`错误: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`错误: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
});
