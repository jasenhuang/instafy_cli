import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptGraph } from "./client.js";
import { loadConfig, resolveWorkflowsDir } from "./config.js";

export type WorkflowKind = "image" | "video";

/** 参考文件类型 */
export type MediaKind = "image" | "video" | "audio";

export const MEDIA_KINDS: MediaKind[] = ["image", "video", "audio"];

/** [节点 id, 输入名] */
export type Binding = [string, string];

export interface Workflow {
  name: string;
  kind: WorkflowKind;
  description?: string;
  /** 同步来源（远端相对路径） */
  source?: string;
  syncedAt?: string;
  bindings: Partial<Record<ParamKey, Binding>>;
  graph: PromptGraph;
}

type SlotIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** 媒体槽位：图片最多 10 张，视频/音频各最多 3 个 */
export type MediaParam =
  | `image${SlotIndex}`
  | `video${1 | 2 | 3}`
  | `audio${1 | 2 | 3}`;

export type ParamKey =
  | "prompt"
  | "negative"
  /** 旧格式兼容：等价于 image1 */
  | "image"
  | MediaParam
  | "width"
  | "height"
  | "seed"
  | "steps"
  | "seconds"
  | "fps"
  | "output";

export type Params = Partial<Record<ParamKey, string | number | undefined>>;

const SLOT_INDEXES: Record<MediaKind, number[]> = {
  image: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  video: [1, 2, 3],
  audio: [1, 2, 3],
};

/** 各类媒体的槽位，顺序即对应 --ref / --ref-video / --ref-audio 的传参顺序 */
export const MEDIA_PARAMS: Record<MediaKind, ParamKey[]> = {
  image: SLOT_INDEXES.image.map((index) => `image${index}` as ParamKey),
  video: SLOT_INDEXES.video.map((index) => `video${index}` as ParamKey),
  audio: SLOT_INDEXES.audio.map((index) => `audio${index}` as ParamKey),
};

/** 工作流声明的某类参考槽位（旧的 image binding 视为单张参考图） */
export function mediaSlotKeys(workflow: Workflow, kind: MediaKind): ParamKey[] {
  const slots = MEDIA_PARAMS[kind].filter((key) => workflow.bindings[key]);
  if (kind === "image" && slots.length === 0 && workflow.bindings.image) return ["image"];
  return slots;
}

export function mediaSlots(workflow: Workflow): Record<MediaKind, ParamKey[]> {
  return {
    image: mediaSlotKeys(workflow, "image"),
    video: mediaSlotKeys(workflow, "video"),
    audio: mediaSlotKeys(workflow, "audio"),
  };
}

/** 已传入的参考文件数量 */
export type RefCounts = Record<MediaKind, number>;

export function totalRefs(counts: RefCounts): number {
  return counts.image + counts.video + counts.audio;
}

/** 默认选择用：参考文件的种类和数量都匹配（缺某类的不自动选，避免剪掉槽位后跑不通） */
export function acceptsRefs(workflow: Workflow, counts: RefCounts): boolean {
  for (const kind of MEDIA_KINDS) {
    const declared = mediaSlotKeys(workflow, kind).length;
    if (counts[kind] > declared) return false;
    if (declared > 0 && counts[kind] === 0) return false;
  }
  return true;
}

/** 随发布包内置的工作流目录（构建后指向项目根目录下的 workflows/） */
export const PACKAGED_WORKFLOWS_DIR = fileURLToPath(new URL("../workflows", import.meta.url));

/** 工作流目录：配置 workflowsDir，默认 CLI 执行目录下的 workflows/ */
export function workflowsDir(): string {
  return resolveWorkflowsDir(undefined, loadConfig());
}

/** 读取时以内置目录为基底，用户目录（默认 ./workflows）覆盖同名工作流。 */
function searchDirs(): string[] {
  const userDir = workflowsDir();
  return userDir === PACKAGED_WORKFLOWS_DIR ? [userDir] : [PACKAGED_WORKFLOWS_DIR, userDir];
}

function readWorkflow(filePath: string): Workflow {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Workflow;
  if (!raw?.name || !raw?.kind || !raw?.graph) {
    throw new Error(`${filePath} 不是合法的工作流文件（需要 name / kind / graph 字段）`);
  }
  return raw;
}

/** 递归列出目录下的工作流文件（返回相对该目录的路径）。 */
function listWorkflowFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listWorkflowFiles(full).map((rel) => path.join(entry.name, rel)));
    } else if (entry.name.endsWith(".json")) {
      files.push(entry.name);
    }
  }
  return files;
}

interface WorkflowIndex {
  /** 按 name 索引 */
  byName: Map<string, Workflow>;
  /** 按相对路径（去掉 .json）索引，例如 flux/flux1_dev_t2i */
  byPath: Map<string, Workflow>;
}

function loadIndex(): WorkflowIndex {
  const byName = new Map<string, Workflow>();
  const byPath = new Map<string, Workflow>();
  for (const dir of searchDirs()) {
    for (const rel of listWorkflowFiles(dir)) {
      const workflow = readWorkflow(path.join(dir, rel));
      byName.set(workflow.name, workflow);
      byPath.set(rel.replace(/\.json$/i, ""), workflow);
    }
  }
  return { byName, byPath };
}

export function loadBuiltinWorkflows(): Map<string, Workflow> {
  return loadIndex().byName;
}

/** 按名称、相对路径（如 wan/wan2_2_14B_t2v）或磁盘路径找工作流。 */
export function findWorkflow(spec: string): Workflow | undefined {
  const { byName, byPath } = loadIndex();
  return byName.get(spec) ?? byPath.get(spec.replace(/\.json$/i, ""));
}

export function resolveWorkflow(
  spec: string | undefined,
  kind: WorkflowKind | undefined,
  refs: RefCounts,
  overrides?: DefaultWorkflowNames,
  warn?: (message: string) => void,
): Workflow {
  const builtins = loadBuiltinWorkflows();

  if (spec) {
    const found = findWorkflow(spec);
    if (found) return found;
    if (spec.endsWith(".json") || spec.includes("/") || spec.includes("\\")) {
      return readWorkflow(path.resolve(spec));
    }
    throw new Error(`找不到工作流 "${spec}"，可用: ${[...builtins.keys()].join(", ")}`);
  }

  if (!kind) throw new Error("未指定模式，无法选择默认工作流");

  return pickDefault(kind, refs, builtins, overrides, warn);
}

export interface DefaultWorkflowNames {
  image?: string;
  imageRef?: string;
  video?: string;
  videoRef?: string;
}

/** 不带 --workflow 时的内置优先级（~/.instafy.json 的 defaults 会插到最前面）。 */
const DEFAULT_PREFERENCES: Record<string, string[]> = {
  "image:plain": ["qwen_image_2_1_t2i", "zimage_turbo_t2i", "flux2_klein_t2i", "flux1_dev_t2i"],
  "image:ref": ["qwen_image_2_1_image_edit", "flux2_klein_i2i"],
  "video:plain": ["minimax_h3_i2v", "wan2_2_14B_t2v", "ltx-2b-t2v", "minimax_h3_director_turbo"],
  "video:ref": ["minimax_h3_i2v", "minimax_h3_r2v", "wan2_2_14B_i2v", "minimax_h3_i2v_uncensored"],
};

function pickDefault(
  kind: WorkflowKind,
  refs: RefCounts,
  workflows: Map<string, Workflow>,
  overrides?: DefaultWorkflowNames,
  warn?: (message: string) => void,
): Workflow {
  const hasRef = totalRefs(refs) > 0;
  const key = `${kind}:${hasRef ? "ref" : "plain"}`;
  const slot = (hasRef ? `${kind}Ref` : kind) as keyof DefaultWorkflowNames;
  const preferred = overrides?.[slot];
  if (preferred) {
    const workflow = workflows.get(preferred);
    // 配置的默认工作流只要类型对就照常用，参考文件不合适会在提交前报错
    if (workflow && workflow.kind === kind) return workflow;
    warn?.(`配置的默认工作流 ${preferred} ${workflow ? "类型不对" : "不存在"}，改用内置默认`);
  }

  for (const name of DEFAULT_PREFERENCES[key] ?? []) {
    const workflow = workflows.get(name);
    if (!workflow || workflow.kind !== kind) continue;
    // 内置优先级里排前面的可能只接图片，传了视频/音频就跳过它
    if (!hasRef || acceptsRefs(workflow, refs)) return workflow;
  }

  const fallback = [...workflows.values()]
    .filter((workflow) =>
      workflow.kind === kind &&
      (hasRef ? acceptsRefs(workflow, refs) : MEDIA_KINDS.every((k) => mediaSlotKeys(workflow, k).length === 0)),
    )
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (fallback) return fallback;

  throw new Error(
    `没有可用的 ${kind} 工作流${hasRef ? "（参考文件种类/数量要匹配）" : ""}，请先运行 instafy sync，或用 --workflow 指定`,
  );
}

/** 把参数写进工作流图，未配置 binding 的参数会被调用方提前拦掉。 */
export function buildGraph(workflow: Workflow, params: Params): PromptGraph {
  const graph = structuredClone(workflow.graph) as PromptGraph;

  for (const [key, value] of Object.entries(params) as Array<[ParamKey, string | number | undefined]>) {
    if (value === undefined || value === null) continue;
    const binding = workflow.bindings[key];
    if (!binding) continue;
    const [nodeId, input] = binding;
    const node = graph[nodeId];
    if (!node) throw new Error(`工作流 ${workflow.name} 的 binding ${key} 指向不存在的节点 ${nodeId}`);
    node.inputs[input] = value;
  }

  if (workflow.bindings.output) {
    const [nodeId, input] = workflow.bindings.output;
    const node = graph[nodeId];
    if (node) node.inputs[input] = `instafy/${workflow.name}`;
  }

  return graph;
}

/** 没传参考文件的槽位：删掉对应的 LoadImage/LoadVideo/LoadAudio，并把因此缺少必填输入的节点一并清掉 */
export function dropMediaSlots(
  graph: PromptGraph,
  workflow: Workflow,
  keys: ParamKey[],
  requiredFields: (classType: string) => string[],
): void {
  const doomed = new Set<string>();
  for (const key of keys) {
    const binding = workflow.bindings[key];
    if (binding) doomed.add(binding[0]);
  }
  const queue = [...doomed];
  while (queue.length > 0) {
    const nodeId = queue.pop()!;
    const node = graph[nodeId];
    if (!node) continue;
    delete graph[nodeId];

    for (const other of Object.values(graph)) {
      for (const [input, value] of Object.entries(other.inputs)) {
        if (Array.isArray(value) && value.length === 2 && value[0] === nodeId) delete other.inputs[input];
      }
    }

    for (const [id, other] of Object.entries(graph)) {
      if (doomed.has(id)) continue;
      const missing = requiredFields(other.class_type).some((field) => other.inputs[field] === undefined);
      if (missing) {
        doomed.add(id);
        queue.push(id);
      }
    }
  }
}

export function supportedParams(workflow: Workflow): ParamKey[] {
  return (Object.keys(workflow.bindings) as ParamKey[]).filter((k) => k !== "output");
}
