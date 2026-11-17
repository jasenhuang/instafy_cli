#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ComfyClient, ComfyError, assertSuccess, collectOutputs, type HistoryEntry, type QueueState } from "./client.js";
import { syncWorkflows } from "./sync.js";
import { DEFAULT_URL, loadConfig, resolveBaseUrl, resolveOutDir, resolveTimeout } from "./config.js";
import {
  buildGraph,
  dropMediaSlots,
  MEDIA_KINDS,
  mediaSlotKeys,
  mediaSlots,
  loadBuiltinWorkflows,
  resolveWorkflow,
  supportedParams,
  totalRefs,
  workflowsDir,
  type MediaKind,
  type ParamKey,
  type Params,
  type RefCounts,
  type Workflow,
  type WorkflowKind,
} from "./workflows.js";

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(["help", "json", "dry-run", "force", "prune", "async", "wait"]);
const ALIASES: Record<string, string> = {
  p: "prompt",
  r: "ref",
  n: "negative",
  w: "workflow",
  o: "out",
  h: "help",
  a: "async",
  rv: "ref-video",
  ra: "ref-audio",
};
const NUMBER_KEYS = new Set(["width", "height", "seed", "steps", "seconds", "fps", "timeout"]);

const MEDIA_LABELS: Record<MediaKind, string> = { image: "图", video: "视频", audio: "音频" };
const MEDIA_SHORT: Record<MediaKind, string> = { image: "img", video: "vid", audio: "aud" };
const MEDIA_FLAGS: Record<MediaKind, string> = { image: "--ref", video: "--ref-video", audio: "--ref-audio" };

/** --ref 按扩展名自动分流；不认识的扩展名当图片 */
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpg", "mpeg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "wma"]);

function inferMediaKind(file: string): MediaKind {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "image";
}

interface Options {
  command?: string;
  positional: string[];
  json?: boolean;
  help?: boolean;
  prompt?: string;
  /** 参考文件，可重复传（--ref a --ref b）；图片/视频/音频按扩展名自动分流 */
  refs?: string[];
  /** 强制当视频/音频传 */
  refVideos?: string[];
  refAudios?: string[];
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
  async?: boolean;
  wait?: boolean;
}

const HELP = `instafy — 调用 ComfyUI 生成图片 / 视频

用法:
  instafy image [选项] [提示词]     生成图片
  instafy video [选项] [提示词]     生成视频
  instafy run <工作流> [选项]       指定工作流生成（名称或相对路径）
  instafy workflows                列出可用工作流
  instafy status <任务id> [--wait]  按 prompt_id 查询进度（--wait 等完成并下载结果）
  instafy sync [选项]              同步 ComfyUI 工作流并转成 API 格式

选项:
  -p, --prompt <文本>       提示词（也可直接放在命令后面）
  -r, --ref <文件>          参考文件，可重复；图片/视频/音频按扩展名自动识别
      --ref-video <文件>    参考视频（-rv），可重复
      --ref-audio <文件>    参考音频（-ra），可重复
  -n, --negative <文本>     反向提示词
  -w, --workflow <名称|路径> 工作流名称、相对路径（wan/wan2_2_14B_t2v）或 JSON 路径
      --width <像素>        宽度        --height <像素>  高度
      --seed <整数>         随机种子（默认随机）
      --steps <整数>        采样步数
      --seconds <秒>        视频时长    --fps <帧率>     视频帧率
  -o, --out <目录>          输出目录（默认 ./outputs，可由配置指定）
      --timeout <秒>        等待上限（默认 1800，可由配置指定）
      --url <地址>          ComfyUI 地址（默认 ~/.instafy.json，否则 ${DEFAULT_URL}）
  -a, --async               提交后立即返回任务 id，不等结果
      --json                以 JSON 打印结果
  -h, --help                显示帮助

status 选项:
      --wait                轮询直到完成（超时按 --timeout），完成后自动下载
      --timeout <秒>        仅 --wait：等待上限
  -o, --out <目录>          仅 --wait：结果下载目录

sync 选项:
      --dir <相对目录>      user/default 下的目录，默认 workflows
                            （也可写 ~/ComfyUI/user/default/workflows）
      --dry-run             只列出会新增/更新的工作流
      --force               忽略变更检测，强制重新转换覆盖
      --prune               删除远端已不存在的工作流文件
                            （参数由节点标题 instafy:* 绑定，见 README）

工作流目录:
  同步结果默认写入 CLI 执行目录下的 workflows/，加载工作流也从这里（叠加内置目录）。
  想换位置就在 ~/.instafy.json 里设 "workflowsDir"（支持 ~ 开头）。

配置文件 ~/.instafy.json:
  { "url": "http://127.0.0.1:8188", "out": "~/instafy-outputs", "timeout": 1800,
    "workflowsDir": "~/instafy-workflows",
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
  instafy video -rv ./pose.mp4 -ra ./bgm.mp3 --ref ./first.png "镜头跟随人物"
  instafy video -p "海边日落" -a            # 提交即返回任务 id
  instafy status 3f1c0d2e                 # 查一次进度
  instafy status 3f1c0d2e --wait          # 轮询到底并下载结果
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
      else if (name === "async") opts.async = true;
      else if (name === "wait") opts.wait = true;
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} 缺少取值`);

    if (name === "ref" || name === "ref-video" || name === "ref-audio") {
      if (name === "ref") (opts.refs ??= []).push(value);
      else if (name === "ref-video") (opts.refVideos ??= []).push(value);
      else (opts.refAudios ??= []).push(value);
      continue;
    }

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
  width: "--width",
  height: "--height",
  seed: "--seed",
  steps: "--steps",
  seconds: "--seconds",
  fps: "--fps",
};

function paramLabel(key: ParamKey): string {
  const media = /^(image|video|audio)\d+$/.exec(key) ?? (key === "image" ? [key, "image"] : null);
  if (media) return MEDIA_FLAGS[media[1] as MediaKind];
  return PARAM_LABELS[key] ?? `--${key}`;
}

function warnUnsupported(workflow: Workflow, params: Params): void {
  const supported = new Set(supportedParams(workflow));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!supported.has(key as ParamKey)) {
      log(`提示：工作流 ${workflow.name} 不支持 ${paramLabel(key as ParamKey)}，已忽略`);
    }
  }
}

async function downloadOutputs(
  client: ComfyClient,
  entry: HistoryEntry,
  outDir: string,
  skipExisting = false,
): Promise<string[]> {
  const refs = collectOutputs(entry);
  await fs.mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const ref of refs) {
    // status 对同一个 prompt_id 可能被反复调用，已下载过的不再重复拉取
    const existing = path.join(outDir, ref.filename);
    if (skipExisting && (await fs.stat(existing).then(() => true, () => false))) {
      files.push(existing);
      continue;
    }
    const target = await uniqueTarget(outDir, ref.filename);
    await client.download(ref, target);
    files.push(target);
  }
  return files;
}

function emitDone(promptId: string, files: string[], opts: Options, elapsedMs?: number): void {
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { promptId, status: "done", ...(elapsedMs === undefined ? {} : { elapsedSeconds: elapsedMs / 1000 }), files },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (elapsedMs !== undefined) log(`完成，用时 ${humanDuration(elapsedMs)}`);
  if (files.length === 0) {
    log(`任务 ${promptId} 已完成，但没有产出文件`);
    return;
  }
  for (const file of files) process.stdout.write(file + "\n");
}

function describeQueue(state: QueueState): string {
  if (state.state === "running") return "执行中";
  if (state.state === "pending") return `排队中（第 ${state.position} 位）`;
  return "不在队列中";
}

async function generate(kind: WorkflowKind | undefined, opts: Options, workflowSpec?: string): Promise<void> {
  const prompt = opts.prompt ?? opts.positional[0];
  const provided: Record<MediaKind, string[]> = { image: [], video: [], audio: [] };
  for (const file of opts.refs ?? []) provided[inferMediaKind(file)].push(file);
  for (const file of opts.refVideos ?? []) provided.video.push(file);
  for (const file of opts.refAudios ?? []) provided.audio.push(file);
  const counts: RefCounts = {
    image: provided.image.length,
    video: provided.video.length,
    audio: provided.audio.length,
  };

  const config = loadConfig();
  const workflow = resolveWorkflow(workflowSpec ?? opts.workflow, kind, counts, config.defaults, log);
  const mode = kind ?? workflow.kind;

  if (kind && workflow.kind !== kind) {
    throw new UsageError(`工作流 ${workflow.name} 是 ${workflow.kind} 类型，不能用 ${kind} 模式跑`);
  }

  const slots = mediaSlots(workflow);
  for (const media of MEDIA_KINDS) {
    const given = provided[media].length;
    const declared = slots[media].length;
    if (given > 0 && declared === 0) {
      throw new UsageError(`工作流 ${workflow.name} 不支持参考${MEDIA_LABELS[media]}（${MEDIA_FLAGS[media]}），换个工作流或去掉它`);
    }
    if (given > declared) {
      throw new UsageError(
        `工作流 ${workflow.name} 最多支持 ${declared} 个参考${MEDIA_LABELS[media]}，收到 ${given} 个`,
      );
    }
  }
  // 某类没传就不填，槽位在提交前剪掉；一个参考文件都没传时才提示需要参考
  const declared = MEDIA_KINDS.filter((media) => slots[media].length > 0);
  if (totalRefs(counts) === 0 && declared.length > 0) {
    const detail = declared.map((media) => `${MEDIA_FLAGS[media]}（${slots[media].length} 个槽位）`).join("、");
    throw new UsageError(
      `工作流 ${workflow.name} 需要参考文件，请加 ${detail}` +
        (mode === "video" ? "；想跑纯文生视频可加 --workflow wan2_2_14B_t2v" : ""),
    );
  }
  for (const media of declared) {
    if (provided[media].length === 0) {
      log(`提示：没传参考${MEDIA_LABELS[media]}，工作流 ${workflow.name} 的 ${slots[media].length} 个槽位已剪掉`);
    }
  }
  if (!prompt && totalRefs(counts) === 0) {
    throw new UsageError(
      "请提供提示词（--prompt 或直接跟在命令后面），或用 --ref / --ref-video / --ref-audio 提供参考文件",
    );
  }

  // seed 不传时只在工作流支持 seed 的情况下随机生成；不支持就不塞，避免误报
  const seed = opts.seed ?? (workflow.bindings.seed ? Math.floor(Math.random() * 2 ** 32) : undefined);
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

  for (const media of MEDIA_KINDS) {
    for (const [index, file] of provided[media].entries()) {
      log(`上传参考${MEDIA_LABELS[media]} ${file} …`);
      params[slots[media][index]] = await client.uploadMedia(file);
    }
  }

  const graph = buildGraph(workflow, params);
  // 没传的槽位直接剪掉；被牵连缺必填输入的节点也一起清掉
  const unusedSlots = MEDIA_KINDS.flatMap((media) => slots[media].slice(provided[media].length));
  if (unusedSlots.length > 0) {
    const info = await client.objectInfo();
    dropMediaSlots(graph, workflow, unusedSlots, (type) => Object.keys(info[type]?.input?.required ?? {}));
  }
  const promptId = await client.queue(graph);
  log(`已提交 ${workflow.name}，任务 ${promptId}${seed === undefined ? "" : `，种子 ${seed}`}`);

  if (opts.async) {
    log(`--async：不等结果，用 instafy status ${promptId} 查询并下载`);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ workflow: workflow.name, kind: mode, promptId, seed, status: "queued" }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(promptId + "\n");
    }
    return;
  }

  const { entry, elapsedMs } = await client.wait(promptId, {
    timeoutMs: resolveTimeout(opts.timeout, config) * 1000,
    intervalMs: 15_000,
    onTick: (elapsed) => log(`等待中… 已用 ${humanDuration(elapsed)}`),
  });

  const files = await downloadOutputs(client, entry, resolveOutDir(opts.out, config));
  if (files.length === 0) throw new ComfyError("任务完成但没有产出文件，请检查工作流的 Save 节点");
  emitDone(promptId, files, opts, elapsedMs);
}

async function reportStatus(opts: Options): Promise<void> {
  const promptId = opts.positional[0];
  if (!promptId) throw new UsageError("用法: instafy status <任务id> [--wait] [-o 目录] [--json]");

  const config = loadConfig();
  const client = new ComfyClient(resolveBaseUrl(opts.url, process.env, config));
  const outDir = resolveOutDir(opts.out, config);

  // 历史里有记录 = 已结束（成功或失败）
  const entry = await client.history(promptId);
  if (entry) {
    await assertSuccess(entry);
    emitDone(promptId, await downloadOutputs(client, entry, outDir, true), opts);
    return;
  }

  const queueState = await client.queueState(promptId);
  if (queueState.state === "unknown") {
    throw new ComfyError(`任务 ${promptId} 既不在队列也不在历史中（id 写错，或历史已被清理）`);
  }

  if (!opts.wait) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { promptId, status: queueState.state, ...(queueState.state === "pending" ? { position: queueState.position } : {}) },
          null,
          2,
        ) + "\n",
      );
    } else {
      log(`任务 ${promptId} ${describeQueue(queueState)}（加 --wait 等完成并下载）`);
    }
    return;
  }

  log(`任务 ${promptId} ${describeQueue(queueState)}，继续等待…`);
  const { entry: done, elapsedMs } = await client.wait(promptId, {
    timeoutMs: resolveTimeout(opts.timeout, config) * 1000,
    intervalMs: 15_000,
    onTick: (elapsed) => log(`等待中… 已用 ${humanDuration(elapsed)}`),
  });
  emitDone(promptId, await downloadOutputs(client, done, outDir, true), opts, elapsedMs);
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
  log(`本地目录 ${result.localDir}`);
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
    log(`${workflowsDir()} 下没有工作流，先运行 instafy sync`);
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

  process.stdout.write(
    `共 ${workflows.size} 个工作流（img / vid / aud = 参考图 / 视频 / 音频槽位数，` +
      `用 --ref / --ref-video / --ref-audio 依次传入）\n`,
  );
  for (const [group, list] of [...groups.entries()].sort((a, b) =>
    a[0] === "（根目录）" ? -1 : b[0] === "（根目录）" ? 1 : a[0].localeCompare(b[0]),
  )) {
    process.stdout.write(`\n${group}\n`);
    for (const workflow of list) {
      const params = paramOrder.filter((key) => workflow.bindings[key]);
      const flags = params.map((key) => `--${key}`).join(" ");
      const ref = MEDIA_KINDS.map((media) => {
        const count = mediaSlotKeys(workflow, media).length;
        return count === 0 ? "" : count === 1 ? MEDIA_SHORT[media] : `${MEDIA_SHORT[media]}×${count}`;
      })
        .filter(Boolean)
        .join(" ");
      const line = `  ${workflow.name.padEnd(nameWidth)}  ${workflow.kind.padEnd(6)}${(ref || "-").padEnd(16)}${flags}`;
      process.stdout.write(`${line.trimEnd()}\n`);
    }
  }
}

/**
 * stdout/stderr 被下游提前关闭（`instafy workflows | head`、`| grep -q`）时别崩：
 * EPIPE 直接安静退出，其他错误照旧抛出去。
 */
function guardPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(0);
      throw err;
    });
  }
}

async function main(): Promise<void> {
  guardPipes();
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
    case "status":
      return reportStatus(opts);
    case "sync":
      return runSync(opts);
    default:
      throw new UsageError(`未知命令 "${opts.command}"，可用: image / video / run / workflows / status / sync`);
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
