import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ComfyClient, type PromptGraph } from "./client.js";
import { convertWorkflow, type NodeSchema } from "./convert.js";
import { loadConfig, resolveBaseUrl, resolveWorkflowsDir } from "./config.js";
import {
  MEDIA_KINDS,
  MEDIA_PARAMS,
  type Binding,
  type MediaKind,
  type ParamKey,
  type Workflow,
  type WorkflowKind,
} from "./workflows.js";

const MANIFEST_FILE = ".instafy-sync.json";
/** ComfyUI user/default 下的相对目录，对应 ~/ComfyUI/user/default/workflows */
const DEFAULT_DIR = "workflows";

interface ManifestEntry {
  /** 相对工作流目录的路径，保留远端目录结构 */
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
  /** 本地写入目录，不传则按配置 workflowsDir / 默认 ./workflows 解析 */
  workflowsDir?: string;
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
  /** 本地工作流目录（绝对路径） */
  localDir: string;
}

const VIDEO_SAVE_NODES = ["SaveVideo", "VHS_VideoCombine", "SaveAnimatedWEBP", "SaveAnimatedWEBM"];

function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

/** Save 系节点（含视频保存）。 */
function allSaveNodes(graph: PromptGraph): string[] {
  return Object.keys(graph).filter(
    (id) => graph[id].class_type.startsWith("Save") || VIDEO_SAVE_NODES.includes(graph[id].class_type),
  );
}

/** 从 Save 节点反向收集上游节点。 */
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

function detectKind(graph: PromptGraph, ids: Set<string>): WorkflowKind {
  for (const id of ids) {
    if (VIDEO_SAVE_NODES.includes(graph[id].class_type)) return "video";
  }
  return "image";
}

interface Guess {
  kind: WorkflowKind;
  bindings: Partial<Record<ParamKey, Binding>>;
  warnings: string[];
}

/**
 * 参数通过节点标题声明：在 ComfyUI 里把节点 Title 设成 instafy:<参数>。
 * 一个节点可以同时承载多个参数（如采样器的 seed/steps），标题只需标主角色。
 * 媒体槽位（image1..image10 / video1..video3 / audio1..audio3）的标题按参数名生成。
 */
const TITLE_BY_PARAM: Partial<Record<ParamKey, string>> = {
  prompt: "instafy:prompt",
  negative: "instafy:negative",
  image: "instafy:image",
  width: "instafy:size",
  height: "instafy:size",
  seed: "instafy:seed",
  steps: "instafy:steps",
  fps: "instafy:fps",
  seconds: "instafy:seconds",
  output: "instafy:output",
};

/** 标量参数在标题节点上按顺序尝试的字段名（只读字面值，不跟连线）。 */
const PARAM_FIELDS: Partial<Record<ParamKey, string[]>> = {
  prompt: ["prompt", "text", "positive_prompt", "manual_prompt", "global_prompt", "value"],
  negative: ["negative_prompt", "negative", "text"],
  width: ["width"],
  height: ["height"],
  seed: ["seed", "noise_seed"],
  steps: ["steps"],
  fps: ["fps", "frame_rate", "value"],
  seconds: ["value", "seconds"],
  output: ["filename_prefix"],
};

/**
 * 参考文件节点读取的字段名：LoadImage 用 image，LoadVideo 用 file，
 * LoadAudio 用 audio；后两个兜底兼容 VideoHelperSuite 之类的自定义节点。
 */
const MEDIA_FIELDS: Record<MediaKind, string[]> = {
  image: ["image", "file"],
  video: ["file", "video", "filename"],
  audio: ["audio", "file", "filename"],
};

const MEDIA_KEY = /^(image|video|audio)(\d+)$/;

/** 载入媒体文件的节点类，用来提示"有节点但没打标题" */
const MEDIA_LOAD_NODES: Record<MediaKind, string[]> = {
  image: ["LoadImage", "LoadImageMask", "LoadImageOutput"],
  video: ["LoadVideo", "VHS_LoadVideo", "VHS_LoadVideoPath"],
  audio: ["LoadAudio", "VHS_LoadAudio", "VHS_LoadAudioUpload"],
};

function titleOfParam(param: ParamKey): string {
  return TITLE_BY_PARAM[param] ?? `instafy:${param}`;
}

function mediaKindOf(param: ParamKey): MediaKind | undefined {
  const match = MEDIA_KEY.exec(param);
  return match ? (match[1] as MediaKind) : undefined;
}

function fieldsOf(param: ParamKey, fallback?: string[]): string[] {
  const media = mediaKindOf(param);
  if (media) return MEDIA_FIELDS[media];
  return fallback ?? PARAM_FIELDS[param] ?? [];
}

/**
 * 一个节点只打一个标题（如采样器同时有 seed/steps），其余参数的字段从"别的标题节点"上找时，
 * 只允许该参数专有的字段名，避免把 prompt 的 text 当成 negative、把 seconds 的 value 当成 prompt。
 */
const PARAM_FALLBACK_FIELDS: Partial<Record<ParamKey, string[]>> = {
  prompt: ["prompt", "positive_prompt", "manual_prompt", "global_prompt"],
  negative: ["negative_prompt", "negative"],
  seed: ["seed", "noise_seed"],
  steps: ["steps"],
  fps: ["fps", "frame_rate"],
  seconds: ["seconds"],
};

const BIND_PARAMS: ParamKey[] = [
  "prompt",
  "negative",
  "width",
  "height",
  "seed",
  "steps",
  "fps",
  "seconds",
  ...MEDIA_PARAMS.image,
  ...MEDIA_PARAMS.video,
  ...MEDIA_PARAMS.audio,
];

function titleOf(graph: PromptGraph, id: string): string {
  const meta = (graph[id] as { _meta?: { title?: string } })._meta;
  return meta?.title ?? "";
}

/** 按节点标题解析绑定；不认标题的工作流不会有任何参数。 */
function bindByTitles(graph: PromptGraph): Guess {
  const warnings: string[] = [];
  const roots = allSaveNodes(graph);
  if (roots.length === 0) warnings.push("没有找到 Save 节点，无法确定产出");
  const ids = roots.length > 0 ? upstreamOf(graph, roots) : new Set(Object.keys(graph));
  const kind = detectKind(graph, ids);

  const bindings: Partial<Record<ParamKey, Binding>> = {};
  const guess: Guess = { kind, bindings, warnings };

  if (roots.length > 0) {
    const videoSave = roots.find((id) => VIDEO_SAVE_NODES.includes(graph[id].class_type));
    const saveId = videoSave ?? roots[0];
    if (graph[saveId].class_type.startsWith("Save")) bindings.output = [saveId, "filename_prefix"];
  }

  const titled = [...ids]
    .filter((id) => titleOf(graph, id).startsWith("instafy:"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const byTitle = new Map<string, string[]>();
  for (const id of titled) {
    const title = titleOf(graph, id);
    const list = byTitle.get(title) ?? [];
    list.push(id);
    byTitle.set(title, list);
  }
  for (const [title, list] of byTitle) {
    if (list.length > 1) warnings.push(`标题 ${title} 出现在多个节点（${list.join(", ")}），只使用第一个`);
  }

  const bind = (param: ParamKey): void => {
    // image1 兼容旧标题 instafy:image
    const titles = param === "image1" ? [titleOfParam("image1"), TITLE_BY_PARAM.image!] : [titleOfParam(param)];
    const exact = titled.filter((id) => titles.includes(titleOf(graph, id)));
    const fallbackFields = PARAM_FALLBACK_FIELDS[param];
    const groups = fallbackFields ? [exact, titled.filter((id) => !titles.includes(titleOf(graph, id)))] : [exact];
    for (const group of groups) {
      for (const id of group) {
        const fields = group === exact ? fieldsOf(param) : fallbackFields!;
        for (const field of fields) {
          const value = graph[id].inputs[field];
          if (value === undefined || isLink(value)) continue;
          bindings[param] = [id, field];
          return;
        }
      }
    }
  };

  for (const param of BIND_PARAMS) bind(param);

  // 多槽位工作流通常只接其中几路，2 号以后的缺失不算问题；video1/audio1 只在确实有该媒体标题时才要求
  const hasKindTitle = (kind: MediaKind) => titled.some((id) => titleOf(graph, id).startsWith(`instafy:${kind}`));
  const required = BIND_PARAMS.filter((param) => {
    if (/^(image|video|audio)([2-9]|10)$/.test(param)) return false;
    const slotOne = /^(video|audio)1$/.exec(param);
    if (slotOne) return hasKindTitle(slotOne[1] as MediaKind);
    return true;
  });
  const missing = required.filter((param) => !bindings[param]);
  if (missing.length > 0) {
    warnings.push(
      titled.length > 0
        ? `未绑定 ${missing.join("/")}（需要时给对应节点加 instafy:* 标题）`
        : "没有声明任何 instafy:* 标题，所有参数不可用（在 ComfyUI 里给节点设置标题后重新 sync）",
    );
  }

  // 有视频/音频载入节点却没打标题时，命令行的 --ref-video / --ref-audio 没法用
  for (const media of MEDIA_KINDS) {
    if (MEDIA_PARAMS[media].some((param) => bindings[param])) continue;
    const unlabeled = [...ids].filter(
      (id) =>
        MEDIA_LOAD_NODES[media].includes(graph[id].class_type) &&
        !titleOf(graph, id).startsWith(`instafy:${media}`),
    );
    if (unlabeled.length > 0) {
      warnings.push(
        `有 ${unlabeled.length} 个${media === "image" ? "图片" : media === "video" ? "视频" : "音频"}载入节点没打 instafy:${media}1 标题，` +
          `${media === "image" ? "--ref" : media === "video" ? "--ref-video" : "--ref-audio"} 用不了`,
      );
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

async function readManifest(localDir: string): Promise<Manifest> {
  try {
    const raw = await fs.readFile(path.join(localDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed?.entries) return parsed;
  } catch {
    // 首次同步
  }
  return { version: 1, entries: {} };
}

async function writeManifest(localDir: string, manifest: Manifest): Promise<void> {
  await fs.writeFile(path.join(localDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/** 删除同步留下的空目录（不会越过工作流目录）。 */
async function pruneEmptyDirs(dir: string, root: string): Promise<void> {
  let current = path.resolve(dir);
  const rootDir = path.resolve(root);
  while (current !== rootDir && current.startsWith(rootDir + path.sep)) {
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
  return {
    name,
    kind: guess.kind,
    description: `同步自 ${rel}`,
    source: rel,
    syncedAt: new Date().toISOString(),
    bindings: guess.bindings,
    graph,
  };
}

export async function syncWorkflows(opts: SyncOptions = {}): Promise<SyncResult> {
  const config = loadConfig();
  const dir = normalizeUserDataDir(opts.dir);
  const localDir = resolveWorkflowsDir(opts.workflowsDir, config);
  const result: SyncResult = {
    added: [],
    updated: [],
    unchanged: [],
    skipped: [],
    failed: [],
    pruned: [],
    remoteDir: dir,
    localDir,
  };

  const client = new ComfyClient(resolveBaseUrl(opts.url, process.env, config));

  const remotePaths = await client.listUserData(dir, true);
  const manifest = await readManifest(localDir);

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
    const localFile = tracked ? path.join(localDir, tracked.file) : undefined;
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
      const target = path.join(localDir, entry.file);
      if (await fileExists(target)) await fs.unlink(target);
      await pruneEmptyDirs(path.dirname(target), localDir);
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
      const target = path.join(localDir, file);

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
        const guess = bindByTitles(graph);
        const workflow = buildWorkflow(record.rel, graph, name, guess);

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(workflow, null, 2) + "\n");

        // 旧版本按文件名平铺，路径变了就清掉旧文件
        if (tracked && tracked.file !== file) {
          const stale = path.join(localDir, tracked.file);
          if (await fileExists(stale)) await fs.unlink(stale);
        }

        manifest.entries[record.rel] = { file, name, sha1: record.sha1, syncedAt: new Date().toISOString() };

        for (const warning of [...warnings, ...guess.warnings]) {
          process.stderr.write(`  ${record.rel}: ${warning}\n`);
        }
      } catch (err) {
        result.failed.push({ rel: record.rel, error: (err as Error).message });
      }
    }
  }

  const failedRels = new Set(result.failed.map((item) => item.rel));
  result.added = result.added.filter((rel) => !failedRels.has(rel));
  result.updated = result.updated.filter((rel) => !failedRels.has(rel));

  await writeManifest(localDir, manifest);
  return result;
}
