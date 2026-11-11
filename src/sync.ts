import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ComfyClient, type PromptGraph } from "./client.js";
import { convertWorkflow, type NodeSchema } from "./convert.js";
import { resolveBaseUrl } from "./config.js";
import { WORKFLOWS_DIR, type Binding, type ParamKey, type Workflow, type WorkflowKind } from "./workflows.js";

const MANIFEST_FILE = ".instafy-sync.json";
/** ComfyUI user/default 下的相对目录，对应 ~/ComfyUI/user/default/workflows */
const DEFAULT_DIR = "workflows";

interface ManifestEntry {
  /** 相对 workflows/ 的路径，保留远端目录结构 */
  file: string;
  name: string;
  sha1: string;
  syncedAt: string;
}

interface Manifest {
  version: number;
  entries: Record<string, ManifestEntry>;
}

export interface SyncOptions {
  /** 不传则按 --url / INSTAFY_COMFY_URL / ~/.instafy.json / 默认地址解析 */
  url?: string;
  /** user/default 下的相对目录，或 ~/ComfyUI/user/default/workflows 这类绝对路径 */
  dir?: string;
  dryRun?: boolean;
  force?: boolean;
  prune?: boolean;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
  failed: Array<{ rel: string; error: string }>;
  pruned: string[];
  /** user/default 下的相对目录 */
  remoteDir: string;
}

const SAMPLERS = ["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced", "CFGGuider"];
const LATENT_NODES = new Set([
  "EmptySD3LatentImage",
  "EmptyLatentImage",
  "EmptyFlux2LatentImage",
  "EmptyHunyuanLatentVideo",
  "EmptyHunyuanVideo15Latent",
  "EmptyLTXVLatentVideo",
  "EmptyQwenImageLayeredLatentImage",
  "EmptyLatentVideo",
  "WanImageToVideo",
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
]);
const VIDEO_SAVE_NODES = ["SaveVideo", "VHS_VideoCombine", "SaveAnimatedWEBP", "SaveAnimatedWEBM"];

function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

function linkTarget(graph: PromptGraph, value: unknown): string | undefined {
  if (!isLink(value)) return undefined;
  return graph[value[0]] ? value[0] : undefined;
}

/** 从输出节点向上游遍历，得到真正参与执行的节点集合。 */
function upstreamOf(graph: PromptGraph, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || !graph[id]) continue;
    seen.add(id);
    for (const value of Object.values(graph[id].inputs)) {
      if (isLink(value) && graph[value[0]]) stack.push(value[0]);
    }
  }
  return seen;
}

function allSaveNodes(graph: PromptGraph): string[] {
  return Object.keys(graph).filter(
    (id) => graph[id].class_type.startsWith("Save") || VIDEO_SAVE_NODES.includes(graph[id].class_type),
  );
}

function detectKind(graph: PromptGraph, ids: Set<string>): WorkflowKind {
  for (const id of ids) {
    if (VIDEO_SAVE_NODES.includes(graph[id].class_type)) return "video";
  }
  return "image";
}

function pickTextField(node: PromptGraph[string], want: "positive" | "negative", slot: number): string | undefined {
  const inputs = node.inputs;
  const str = (key: string) => (typeof inputs[key] === "string" ? key : undefined);

  if (typeof inputs.negative_prompt === "string" && (want === "negative" || slot >= 1)) {
    return "negative_prompt";
  }
  if (want === "positive") {
    return str("positive_prompt") ?? str("prompt") ?? str("manual_prompt") ?? str("text");
  }
  if (str("negative")) return "negative";
  if (/TextEncode/.test(node.class_type)) return str("text");
  return undefined;
}

/** 顺着 conditioning 链往上找提示词输入；ConditioningZeroOut 说明这一路没有反向提示词。 */
function resolveText(
  graph: PromptGraph,
  link: [string, number],
  want: "positive" | "negative",
  depth = 0,
): Binding | undefined {
  if (depth > 12) return undefined;
  const [id, slot] = link;
  const node = graph[id];
  if (!node) return undefined;
  if (node.class_type === "ConditioningZeroOut") return undefined;

  // 文本节点直接给字面值
  if (/PrimitiveString/.test(node.class_type) && typeof node.inputs.value === "string") return [id, "value"];

  const field = pickTextField(node, want, slot);
  if (field) return [id, field];

  const inputs = node.inputs;
  // 文本字段本身是连线时（MiniMax H3 之类把 prompt 作为输入接到 PrimitiveString）
  const textLink = (want === "negative"
    ? ["negative_prompt", "negative", "text"]
    : ["prompt", "manual_prompt", "positive_prompt", "text", "global_prompt"]
  )
    .map((name) => inputs[name])
    .find((value) => isLink(value));
  if (textLink) return resolveText(graph, textLink as [string, number], want, depth + 1);
  const follow = (names: string[]): [string, number] | undefined => {
    for (const name of names) {
      const target = linkTarget(graph, inputs[name]);
      if (target) return [target, (inputs[name] as [string, number])[1]];
    }
    return undefined;
  };

  const next =
    want === "positive"
      ? follow(["positive", "conditioning", "guider", "negative"])
      : follow(["negative", "conditioning", "guider"]);
  return next ? resolveText(graph, next, want, depth + 1) : undefined;
}


function findDirectPrompt(graph: PromptGraph, ids: Set<string>): Binding | undefined {
  const fields = ["global_prompt", "prompt", "manual_prompt", "positive_prompt", "text"];
  let best: { binding: Binding; text: string } | undefined;
  for (const id of ids) {
    for (const field of fields) {
      const value = graph[id].inputs[field];
      if (typeof value !== "string") continue;
      const candidate = { binding: [id, field] as Binding, text: value };
      if (!best || candidate.text.length > best.text.length) best = candidate;
    }
  }
  return best?.binding;
}

/** 采样器的 steps 可能挂在一层 sigmas 上游（如 SplitSigmas → BasicScheduler）。 */
function resolveSteps(graph: PromptGraph, id: string, depth = 0): Binding | undefined {
  if (depth > 3) return undefined;
  const node = graph[id];
  if (!node) return undefined;
  if (typeof node.inputs.steps === "number") return [id, "steps"];
  if (isLink(node.inputs.sigmas)) return resolveSteps(graph, (node.inputs.sigmas as [string, number])[0], depth + 1);
  return undefined;
}

interface Guess {
  kind: WorkflowKind;
  positive?: Binding;
  negative?: Binding;
  image?: Binding;
  width?: Binding;
  height?: Binding;
  seed?: Binding;
  steps?: Binding;
  fps?: Binding;
  seconds?: Binding;
  output?: Binding;
  warnings: string[];
}

function guessBindings(graph: PromptGraph): Guess {
  const warnings: string[] = [];
  const roots = allSaveNodes(graph);
  if (roots.length === 0) warnings.push("没有找到 Save 节点，无法确定产出");
  const ids = roots.length > 0 ? upstreamOf(graph, roots) : new Set(Object.keys(graph));
  const kind = detectKind(graph, ids);

  const guess: Guess = { kind, warnings };

  if (roots.length > 0) {
    const videoSave = roots.find((id) =>
      VIDEO_SAVE_NODES.includes(graph[id].class_type) || graph[id].class_type.startsWith("SaveVideo"),
    );
    const saveId = videoSave ?? roots[0];
    if (graph[saveId].class_type.startsWith("Save")) guess.output = [saveId, "filename_prefix"];
  }

  const samplerIds = [...ids].filter((id) => SAMPLERS.includes(graph[id].class_type));
  const samplerId = samplerIds.find((id) => graph[id].inputs.add_noise === "enable") ?? samplerIds[0];

  if (!samplerId) {
    // 有的工作流把采样封装在自定义节点里（如 MiniMax H3 Director），直接找提示词与种子字段
    const direct = findDirectPrompt(graph, ids);
    if (direct) {
      guess.positive = direct;
    } else {
      warnings.push("没有识别到采样器，也无法定位提示词输入");
    }
    const seedNode = [...ids].find(
      (id) => typeof graph[id].inputs.seed === "number" || typeof graph[id].inputs.noise_seed === "number",
    );
    if (seedNode) {
      guess.seed = [seedNode, typeof graph[seedNode].inputs.seed === "number" ? "seed" : "noise_seed"];
    }
  }

  const sampler = samplerId ? graph[samplerId] : undefined;
  let positiveLink = isLink(sampler?.inputs.positive) ? (sampler.inputs.positive as [string, number]) : undefined;
  let negativeLink = isLink(sampler?.inputs.negative) ? (sampler.inputs.negative as [string, number]) : undefined;

  if (!positiveLink && isLink(sampler?.inputs.guider)) {
    const guider = graph[(sampler.inputs.guider as [string, number])[0]];
    if (guider) {
      if (isLink(guider.inputs.positive)) positiveLink = guider.inputs.positive as [string, number];
      if (isLink(guider.inputs.negative)) negativeLink = guider.inputs.negative as [string, number];
      if (!positiveLink && isLink(guider.inputs.conditioning)) {
        positiveLink = guider.inputs.conditioning as [string, number];
      }
    }
  }

  if (positiveLink) {
    guess.positive = resolveText(graph, positiveLink, "positive");
    if (!guess.positive) warnings.push("没有识别到正向提示词输入");
  }
  if (negativeLink) {
    const negative = resolveText(graph, negativeLink, "negative");
    if (negative && !(guess.positive && negative[0] === guess.positive[0] && negative[1] === guess.positive[1])) {
      guess.negative = negative;
    }
  }

  if (sampler && samplerId) {
    if (typeof sampler.inputs.seed === "number") guess.seed = [samplerId, "seed"];
    else if (typeof sampler.inputs.noise_seed === "number") guess.seed = [samplerId, "noise_seed"];
    else if (isLink(sampler.inputs.noise)) {
      const noiseId = (sampler.inputs.noise as [string, number])[0];
      if (typeof graph[noiseId]?.inputs.noise_seed === "number") guess.seed = [noiseId, "noise_seed"];
    }
    guess.steps = resolveSteps(graph, samplerId);
  }
  if (!guess.seed) warnings.push("没有识别到随机种子输入");

  for (const id of ids) {
    const node = graph[id];
    if (LATENT_NODES.has(node.class_type) && typeof node.inputs.width === "number" && typeof node.inputs.height === "number") {
      guess.width = [id, "width"];
      guess.height = [id, "height"];
      break;
    }
  }

  const loaders = [...ids].filter((id) => graph[id].class_type === "LoadImage");
  if (loaders.length > 0) {
    const feeder = [...ids].find((id) =>
      ["start_image", "first_frame"].some((key) => {
        const target = linkTarget(graph, graph[id].inputs[key]);
        return target !== undefined && loaders.includes(target);
      }),
    );
    const chosen = feeder
      ? linkTarget(graph, graph[feeder].inputs.start_image ?? graph[feeder].inputs.first_frame)
      : undefined;
    guess.image = [chosen ?? loaders[0], "image"];
    if (loaders.length > 1) warnings.push(`有 ${loaders.length} 个 LoadImage，只绑定了第一个`);
  }

  for (const id of ids) {
    const node = graph[id];
    if (node.class_type !== "CreateVideo") continue;
    if (typeof node.inputs.fps === "number") {
      guess.fps = [id, "fps"];
      break;
    }
    if (isLink(node.inputs.fps)) {
      const fpsId = (node.inputs.fps as [string, number])[0];
      const source = graph[fpsId];
      if (typeof source?.inputs.value === "number") guess.fps = [fpsId, "value"];
      else if (typeof source?.inputs.frame_rate === "number") guess.fps = [fpsId, "frame_rate"];
      break;
    }
  }
  if (!guess.fps) {
    const frameRate = [...ids].find((id) => typeof graph[id].inputs.frame_rate === "number");
    if (frameRate) guess.fps = [frameRate, "frame_rate"];
  }

  // 时长：Wan / MiniMax 用数学表达式把秒数换算成帧数，秒数挂在表达式的一个输入上
  if (guess.fps) {
    for (const id of ids) {
      const node = graph[id];
      if (typeof node.inputs.length === "number" || !isLink(node.inputs.length)) continue;
      const math = graph[(node.inputs.length as [string, number])[0]];
      if (!math || math.class_type !== "ComfyMathExpression") continue;
      for (const value of Object.values(math.inputs)) {
        const target = linkTarget(graph, value);
        if (!target || target === guess.fps[0]) continue;
        if (typeof graph[target].inputs.value === "number") {
          guess.seconds = [target, "value"];
          break;
        }
      }
      if (guess.seconds) break;
    }
  }

  return guess;
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment
    .replace(/\.json$/i, "")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "workflow";
}

/** 远端相对路径 → 本地 workflows/ 下的相对路径，目录结构原样保留。 */
function targetFile(rel: string): string {
  const dirs = rel.split("/").filter(Boolean).map(sanitizeSegment);
  const base = dirs.pop() ?? "workflow";
  return [...dirs, base + ".json"].join("/");
}

/** 工作流名默认取文件名；跨目录重名时加上父目录前缀。 */
function pickName(rel: string, manifest: Manifest): string {
  const file = targetFile(rel);
  const base = path.basename(file, ".json");
  const parent = path.dirname(file);
  const others = Object.entries(manifest.entries)
    .filter(([other]) => other !== rel)
    .map(([, entry]) => entry.name);
  if (!others.includes(base)) return base;
  const prefixed = parent === "." ? `${base}-2` : `${sanitizeSegment(parent.split("/").pop()!)}-${base}`;
  let name = prefixed;
  let index = 2;
  while (others.includes(name)) {
    name = `${prefixed}-${index}`;
    index += 1;
  }
  return name;
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(path.join(WORKFLOWS_DIR, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed?.entries) return parsed;
  } catch {
    // 首次同步
  }
  return { version: 1, entries: {} };
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await fs.writeFile(path.join(WORKFLOWS_DIR, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/** 删除同步留下的空目录（不会越过 workflows/）。 */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let current = path.resolve(dir);
  const root = path.resolve(WORKFLOWS_DIR);
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      if ((await fs.readdir(current)).length > 0) return;
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** 允许直接传远端绝对路径，内部统一成 user/default 下的相对目录。 */
function normalizeUserDataDir(dir?: string): string {
  const raw = (dir ?? "").trim() || DEFAULT_DIR;
  const marker = "/user/default/";
  let rel = raw;
  const cut = raw.indexOf(marker);
  if (cut >= 0) rel = raw.slice(cut + marker.length);
  rel = rel.replace(/^~?\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return rel || DEFAULT_DIR;
}

function sha1Of(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function buildWorkflow(rel: string, graph: PromptGraph, name: string, guess: Guess): Workflow {
  const bindings: Partial<Record<ParamKey, Binding>> = {};
  if (guess.positive) bindings.prompt = guess.positive;
  if (guess.negative) bindings.negative = guess.negative;
  if (guess.image) bindings.image = guess.image;
  if (guess.width) bindings.width = guess.width;
  if (guess.height) bindings.height = guess.height;
  if (guess.seed) bindings.seed = guess.seed;
  if (guess.steps) bindings.steps = guess.steps;
  if (guess.fps) bindings.fps = guess.fps;
  if (guess.seconds) bindings.seconds = guess.seconds;
  if (guess.output) bindings.output = guess.output;

  return {
    name,
    kind: guess.kind,
    description: `同步自 ${rel}`,
    source: rel,
    syncedAt: new Date().toISOString(),
    bindings,
    graph,
  };
}

export async function syncWorkflows(opts: SyncOptions = {}): Promise<SyncResult> {
  const dir = normalizeUserDataDir(opts.dir);
  const result: SyncResult = {
    added: [],
    updated: [],
    unchanged: [],
    skipped: [],
    failed: [],
    pruned: [],
    remoteDir: dir,
  };

  const client = new ComfyClient(resolveBaseUrl(opts.url));

  const remotePaths = await client.listUserData(dir, true);
  const manifest = await readManifest();

  const records: Array<{ rel: string; content: Buffer; sha1: string }> = [];
  for (const listed of remotePaths) {
    const rel = listed.startsWith(`${dir}/`) ? listed.slice(dir.length + 1) : listed;
    if (!rel.endsWith(".json") || rel.split("/").some((part) => part.startsWith("."))) continue;
    try {
      const content = await client.readUserData(`${dir}/${rel}`);
      records.push({ rel, content, sha1: sha1Of(content) });
    } catch (err) {
      result.failed.push({ rel, error: (err as Error).message });
    }
  }

  const pending: Array<{ rel: string; content: Buffer; sha1: string }> = [];
  for (const record of records) {
    const tracked = manifest.entries[record.rel];
    const localFile = tracked ? path.join(WORKFLOWS_DIR, tracked.file) : undefined;
    const exists = localFile ? await fileExists(localFile) : false;

    if (tracked && exists && tracked.sha1 === record.sha1 && tracked.file === targetFile(record.rel) && !opts.force) {
      result.unchanged.push(record.rel);
    } else {
      pending.push(record);
    }
  }

  if (opts.prune) {
    const remoteRels = new Set(records.map((record) => record.rel));
    for (const [rel, entry] of Object.entries(manifest.entries)) {
      if (remoteRels.has(rel)) continue;
      result.pruned.push(rel);
      if (opts.dryRun) continue;
      const target = path.join(WORKFLOWS_DIR, entry.file);
      if (await fileExists(target)) await fs.unlink(target);
      await pruneEmptyDirs(path.dirname(target));
      delete manifest.entries[rel];
    }
  }

  for (const record of pending) {
    (manifest.entries[record.rel] ? result.updated : result.added).push(record.rel);
  }
  if (opts.dryRun) return result;

  if (pending.length > 0) {
    const objectInfo = await client.objectInfo();
    const lookup = (classType: string): NodeSchema | undefined => objectInfo[classType];

    for (const record of pending) {
      const tracked = manifest.entries[record.rel];
      const file = targetFile(record.rel);
      const target = path.join(WORKFLOWS_DIR, file);

      if (!tracked && (await fileExists(target)) && !opts.force) {
        result.skipped.push(record.rel);
        process.stderr.write(`  ${record.rel}: 本地已有 ${file} 且不受同步管理，跳过（--force 可覆盖）\n`);
        continue;
      }

      try {
        const warnings: string[] = [];
        const parsed = JSON.parse(record.content.toString("utf8")) as unknown;
        const graph = convertWorkflow(parsed, lookup, {
          objectInfo,
          onWarning: (message) => warnings.push(message),
        });
        const name = tracked?.name ?? pickName(record.rel, manifest);
        const guess = guessBindings(graph);
        const workflow = buildWorkflow(record.rel, graph, name, guess);

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(workflow, null, 2) + "\n");

        // 旧版本按文件名平铺，路径变了就清掉旧文件
        if (tracked && tracked.file !== file) {
          const stale = path.join(WORKFLOWS_DIR, tracked.file);
          if (await fileExists(stale)) await fs.unlink(stale);
        }

        manifest.entries[record.rel] = { file, name, sha1: record.sha1, syncedAt: new Date().toISOString() };

        for (const warning of [...warnings, ...guess.warnings]) {
          process.stderr.write(`  ${record.rel}: ${warning}\n`);
        }
        if (!guess.positive) {
          process.stderr.write(`  ${record.rel}: 未识别到提示词输入，需手动编辑 bindings\n`);
        }
      } catch (err) {
        result.failed.push({ rel: record.rel, error: (err as Error).message });
      }
    }
  }

  const failedRels = new Set(result.failed.map((item) => item.rel));
  result.added = result.added.filter((rel) => !failedRels.has(rel));
  result.updated = result.updated.filter((rel) => !failedRels.has(rel));

  await writeManifest(manifest);
  return result;
}
