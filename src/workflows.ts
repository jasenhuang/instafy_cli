import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptGraph } from "./client.js";

export type WorkflowKind = "image" | "video";

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

export type ParamKey =
  | "prompt"
  | "negative"
  /** 旧格式兼容：等价于 image1 */
  | "image"
  | "image1"
  | "image2"
  | "image3"
  | "image4"
  | "image5"
  | "image6"
  | "image7"
  | "image8"
  | "image9"
  | "image10"
  | "width"
  | "height"
  | "seed"
  | "steps"
  | "seconds"
  | "fps"
  | "output";

export type Params = Partial<Record<ParamKey, string | number | undefined>>;

/** 参考图槽位，顺序即 --ref 的传参顺序 */
export const IMAGE_PARAMS: ParamKey[] = [
  "image1",
  "image2",
  "image3",
  "image4",
  "image5",
  "image6",
  "image7",
  "image8",
  "image9",
  "image10",
];

/** 工作流声明的参考图槽位（旧的 image binding 视为单张） */
export function imageSlots(workflow: Workflow): ParamKey[] {
  const slots = IMAGE_PARAMS.filter((key) => workflow.bindings[key]);
  if (slots.length === 0 && workflow.bindings.image) return ["image"];
  return slots;
}

/** 内置 / 同步来的工作流目录（构建后仍指向项目根目录下的 workflows/） */
export const WORKFLOWS_DIR = fileURLToPath(new URL("../workflows", import.meta.url));

function readWorkflow(filePath: string): Workflow {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Workflow;
  if (!raw?.name || !raw?.kind || !raw?.graph) {
    throw new Error(`${filePath} 不是合法的工作流文件（需要 name / kind / graph 字段）`);
  }
  return raw;
}

/** 递归列出 workflows/ 下的工作流文件（返回相对 workflows/ 的路径）。 */
function listWorkflowFiles(dir = WORKFLOWS_DIR): string[] {
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
  for (const rel of listWorkflowFiles()) {
    const workflow = readWorkflow(path.join(WORKFLOWS_DIR, rel));
    byName.set(workflow.name, workflow);
    byPath.set(rel.replace(/\.json$/i, ""), workflow);
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
  hasRef: boolean,
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

  return pickDefault(kind, hasRef, builtins, overrides, warn);
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
  hasRef: boolean,
  workflows: Map<string, Workflow>,
  overrides?: DefaultWorkflowNames,
  warn?: (message: string) => void,
): Workflow {
  const key = `${kind}:${hasRef ? "ref" : "plain"}`;
  const slot = (hasRef ? `${kind}Ref` : kind) as keyof DefaultWorkflowNames;
  const preferred = overrides?.[slot];
  if (preferred) {
    const workflow = workflows.get(preferred);
    if (workflow && workflow.kind === kind) return workflow;
    warn?.(`配置的默认工作流 ${preferred} ${workflow ? "类型不对" : "不存在"}，改用内置默认`);
  }

  for (const name of DEFAULT_PREFERENCES[key] ?? []) {
    const workflow = workflows.get(name);
    if (workflow && workflow.kind === kind) return workflow;
  }
  const fallback = [...workflows.values()]
    .filter((workflow) => workflow.kind === kind && imageSlots(workflow).length > 0 === hasRef)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (fallback) return fallback;

  throw new Error(
    `没有可用的 ${kind} 工作流${hasRef ? "（需要参考图）" : ""}，请先运行 instafy sync，或用 --workflow 指定`,
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

/** 没传参考图的槽位：删掉对应 LoadImage，并把因此缺少必填输入的节点一并清掉 */
export function dropImageSlots(
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
