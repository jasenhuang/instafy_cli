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
  | "image"
  | "width"
  | "height"
  | "seed"
  | "steps"
  | "seconds"
  | "fps"
  | "output";

export type Params = Partial<Record<ParamKey, string | number | undefined>>;

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

export function resolveWorkflow(spec: string | undefined, kind: WorkflowKind | undefined, hasRef: boolean): Workflow {
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

  const name =
    kind === "image"
      ? hasRef
        ? "flux2-klein-edit"
        : "z-image-turbo"
      : hasRef
        ? "wan2.2-i2v"
        : "wan2.2-t2v";

  const workflow = builtins.get(name);
  if (!workflow) throw new Error(`内置工作流缺失: ${name}`);
  return workflow;
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

export function supportedParams(workflow: Workflow): ParamKey[] {
  return (Object.keys(workflow.bindings) as ParamKey[]).filter((k) => k !== "output");
}
