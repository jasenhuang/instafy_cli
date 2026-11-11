import type { PromptGraph } from "./client.js";

/**
 * ComfyUI UI 格式 → /prompt API 格式。
 *
 * 规则与 ComfyUI 前端一致：widgets_values 按 object_info 中 widget 类型输入的顺序位置映射
 * （required 在 optional 之前），`control_after_generate` 会多吃一个值；连线覆盖字面值。
 * 另外处理两件 Python 版 ui2api.py 也在做的事：子图展开、mute（丢）/bypass（穿透）。
 *
 * 比 ui2api.py 多修了两处：
 * - 子图实例只部分 promotion 时按 socket 名字对齐，而不是按下标（否则会丢连线）；
 * - 动态下拉（COMFY_DYNAMICCOMBO_V3，如 SaveImageAdvanced 的 format）的子控件用
 *   "format.bit_depth" 这种带前缀的键名，并按选中的 key 消费 widgets_values。
 */

type NodeSpec = [string | string[], ...unknown[]];
interface DynamicOption {
  key?: string;
  inputs?: { required?: Record<string, NodeSpec>; optional?: Record<string, NodeSpec> };
}
export interface NodeSchema {
  input?: { required?: Record<string, NodeSpec>; optional?: Record<string, NodeSpec> };
}
export type SchemaLookup = (classType: string) => NodeSchema | undefined;

interface UiSocket {
  name?: string;
  type?: string;
  link?: number | null;
  widget?: { name?: string };
}

interface UiNode {
  id: number | string;
  type?: string;
  title?: string;
  mode?: number;
  inputs?: UiSocket[];
  widgets_values?: unknown;
  _literals?: Record<string, unknown>;
}

interface SubgraphDef {
  id: string;
  nodes?: UiNode[];
  links?: unknown[];
  inputs?: Array<{ name?: string }>;
  outputs?: Array<{ type?: string }>;
}

interface UiWorkflow {
  nodes: UiNode[];
  links?: unknown[];
  definitions?: { subgraphs?: SubgraphDef[] };
}

/** 只能由连线提供、不会出现在 widgets_values 里的类型 */
const LINK_ONLY = new Set([
  "MODEL",
  "CLIP",
  "VAE",
  "IMAGE",
  "MASK",
  "AUDIO",
  "LATENT",
  "CONDITIONING",
  "SAMPLER",
  "SIGMAS",
  "GUIDER",
  "NOISE",
  "VIDEO",
  "CLIP_VISION",
  "CONTROL_NET",
  "STYLE_MODEL",
  "COMFY_AUTOGROW_V3",
]);

/** 纯前端节点：没有服务端 schema，不会进入 /prompt */
const SKIP_TYPES = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
  "Label (rgthree)",
  "Fast Groups Muter (rgthree)",
  "Fast Groups Bypasser (rgthree)",
]);

interface Resolution {
  kind: "node" | "value";
  id?: string;
  slot?: number;
  value?: unknown;
}

type LinkMap = Map<number, [string, number]>;

function linkMap(entries: unknown): LinkMap {
  const map: LinkMap = new Map();
  for (const entry of (entries as unknown[]) ?? []) {
    if (Array.isArray(entry)) {
      map.set(Number(entry[0]), [String(entry[1]), Number(entry[2])]);
    } else if (entry && typeof entry === "object") {
      const dict = entry as Record<string, unknown>;
      map.set(Number(dict.id), [String(dict.origin_id), Number(dict.origin_slot)]);
    }
  }
  return map;
}

function widgetSockets(node: UiNode): UiSocket[] {
  return (node.inputs ?? []).filter((socket) => socket.widget);
}

/** 展开所有子图实例，边界连线按名字重接；返回扁平化的 UI 图。 */
function flattenWorkflow(wf: UiWorkflow): UiWorkflow {
  const defs = new Map<string, SubgraphDef>();
  for (const sub of wf.definitions?.subgraphs ?? []) defs.set(sub.id, sub);
  if (defs.size === 0) return wf;

  const nodes: UiNode[] = [];
  const links: unknown[][] = [];
  let linkCounter = 0;
  const pending: Array<() => void> = [];

  const newLink = (originId: string, originSlot: number): number => {
    linkCounter += 1;
    links.push([linkCounter, originId, originSlot, 0, 0, ""]);
    return linkCounter;
  };

  type Outbound = (slot: number) => Resolution | null;

  function scope(
    scopeNodes: UiNode[],
    scopeLinks: unknown,
    namespace: string,
    inbound: (slot: number) => Resolution | null,
  ): Outbound {
    const byId = new Map<string, UiNode>();
    for (const node of scopeNodes) byId.set(String(node.id), node);
    const lm = linkMap(scopeLinks);
    const expanded = new Map<string, Outbound>();
    const emitted = new Set<string>();

    function resolve(originId: string, originSlot: number, guard = 0): Resolution | null {
      if (guard > 32) return null;
      if (String(originId) === "-10") return inbound(originSlot);
      const node = byId.get(String(originId));
      if (!node) return null;
      if (node.type === "Reroute") {
        const up = node.inputs?.[0]?.link;
        if (up == null || !lm.has(up)) return null;
        const [upId, upSlot] = lm.get(up)!;
        return resolve(upId, upSlot, guard + 1);
      }
      if (node.type && defs.has(node.type)) return expandInstance(node)(originSlot);
      emit(node);
      return { kind: "node", id: `${namespace}${node.id}`, slot: originSlot };
    }

    function socketSource(node: UiNode, socket: UiSocket): Resolution | null {
      const lid = socket.link;
      if (lid == null || !lm.has(lid)) return null;
      const [originId, originSlot] = lm.get(lid)!;
      return resolve(originId, originSlot);
    }

    function childInbound(node: UiNode, slot: number): Resolution | null {
      const sub = defs.get(node.type!)!;
      const virtualName = sub.inputs?.[slot]?.name;
      const sockets = node.inputs ?? [];
      // 关键修正：实例 socket 与子图输入按名字对齐，实例只 promotion 了一部分时不会错位
      const socket =
        (virtualName ? sockets.find((item) => item.name === virtualName) : undefined) ?? sockets[slot];
      if (!socket) return null;
      if (socket.link != null) return socketSource(node, socket);

      const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      const promoted = widgetSockets(node);
      const index = promoted.findIndex((item) => item.name === socket.name);
      if (index !== -1 && index < values.length) return { kind: "value", value: values[index] };
      return null;
    }

    function expandInstance(node: UiNode): Outbound {
      const cached = expanded.get(String(node.id));
      if (cached) return cached;

      const sub = defs.get(node.type!)!;
      let out: Outbound;

      if (node.mode === 2) {
        out = () => null;
      } else if (node.mode === 4) {
        const bypassed: Outbound = (slot) => {
          const want = sub.outputs?.[slot]?.type;
          const sockets = node.inputs ?? [];
          const order = [slot];
          for (let i = 0; i < sockets.length; i += 1) if (i !== slot) order.push(i);
          for (const index of order) {
            const socket = sockets[index];
            if (socket && socket.type === want) return childInbound(node, index);
          }
          return null;
        };
        out = bypassed;
      } else {
        out = scope(
          sub.nodes ?? [],
          sub.links ?? [],
          `${namespace}${node.id}:`,
          (slot) => childInbound(node, slot),
        );
      }

      expanded.set(String(node.id), out);
      return out;
    }

    function emit(node: UiNode): void {
      const key = String(node.id);
      if (emitted.has(key)) return;
      emitted.add(key);

      const copy: UiNode = { ...node, id: `${namespace}${node.id}` };
      const literals: Record<string, unknown> = {};
      const sockets: UiSocket[] = [];

      for (const socket of node.inputs ?? []) {
        const next: UiSocket = { ...socket };
        const src = socketSource(node, socket);
        if (src?.kind === "node") {
          next.link = newLink(src.id!, src.slot!);
        } else if (src?.kind === "value") {
          if (socket.name) literals[socket.name] = src.value;
          next.link = null;
        } else if (socket.link != null) {
          next.link = null;
        }
        sockets.push(next);
      }

      copy.inputs = sockets;
      if (Object.keys(literals).length > 0) copy._literals = literals;
      nodes.push(copy);
    }

    const emitAll = () => {
      for (const node of scopeNodes) {
        if (node.type && defs.has(node.type)) expandInstance(node);
        else emit(node);
      }
    };
    pending.push(emitAll);

    return (slot: number): Resolution | null => {
      for (const entry of (scopeLinks as unknown[]) ?? []) {
        let originId: string;
        let originSlot: number;
        let targetId: number;
        let targetSlot: number;
        if (Array.isArray(entry)) {
          [originId, originSlot, targetId, targetSlot] = [
            String(entry[1]),
            Number(entry[2]),
            Number(entry[3]),
            Number(entry[4]),
          ];
        } else {
          const dict = entry as Record<string, unknown>;
          originId = String(dict.origin_id);
          originSlot = Number(dict.origin_slot);
          targetId = Number(dict.target_id);
          targetSlot = Number(dict.target_slot);
        }
        if (targetId === -20 && targetSlot === slot) {
          return resolve(originId, originSlot);
        }
      }
      return null;
    };
  }

  scope(wf.nodes, wf.links ?? [], "", () => null);
  while (pending.length > 0) pending.shift()!();

  const out: UiWorkflow = { ...wf, nodes, links };
  delete out.definitions;
  return out;
}

function isWidgetType(type: string | string[]): boolean {
  if (Array.isArray(type)) return true; // COMBO 的取值列表
  return !LINK_ONLY.has(type);
}

interface Slot {
  name: string;
  type: string | string[];
  eatsExtra: boolean;
  meta: Record<string, unknown>;
}

function slotsOf(schema: NodeSchema | undefined): Slot[] {
  const slots: Slot[] = [];
  for (const group of ["required", "optional"] as const) {
    const defs = schema?.input?.[group];
    if (!defs) continue;
    for (const [name, spec] of Object.entries(defs)) {
      const type = spec[0];
      if (!isWidgetType(type)) continue;
      const meta = spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {};
      slots.push({ name, type, eatsExtra: Boolean(meta.control_after_generate), meta });
    }
  }
  return slots;
}

/** widgets_values 位置映射；动态下拉的子控件按 "format.xxx" 名字继续消费。 */
function assignWidgets(schema: NodeSchema | undefined, values: unknown[], inputs: Record<string, unknown>): void {
  let index = 0;
  let exhausted = false;

  const consume = (slots: Slot[], prefix: string): void => {
    for (const slot of slots) {
      if (exhausted) return;
      if (index >= values.length) {
        exhausted = true;
        return;
      }
      const full = prefix + slot.name;
      const value = values[index];
      index += 1;
      inputs[full] = value;
      if (slot.eatsExtra) index += 1;

      if (slot.type === "COMFY_DYNAMICCOMBO_V3") {
        const option = ((slot.meta.options as DynamicOption[] | undefined) ?? []).find((item) => item?.key === value);
        if (option) {
          const dynamic = option.inputs;
          const subSlots = [
            ...slotsOf({ input: { required: dynamic?.required, optional: dynamic?.optional } }),
          ];
          consume(subSlots, `${full}.`);
        }
      }
    }
  };

  consume(slotsOf(schema), "");
}

function requiredNames(schema: NodeSchema | undefined): Set<string> {
  return new Set(Object.keys(schema?.input?.required ?? {}));
}

function isLinkValue(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

/** 用 object_info 的默认值补齐 UI 格式里缺失的必填控件（含动态下拉的子控件）。 */
function fillDefaults(
  prompt: PromptGraph,
  lookup: SchemaLookup,
  fullSchema: Record<string, NodeSchema> | undefined,
  onWarning?: (message: string) => void,
): void {
  const warned = new Set<string>();

  const fillGroup = (
    inputs: Record<string, unknown>,
    group: Record<string, NodeSpec> | undefined,
    prefix: string,
  ): void => {
    for (const [name, spec] of Object.entries(group ?? {})) {
      const full = prefix + name;
      const type = spec[0];
      const meta = spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {};
      if (type === "COMFY_DYNAMICCOMBO_V3") {
        const selected = full in inputs ? inputs[full] : meta.default;
        const option = ((meta.options as DynamicOption[] | undefined) ?? []).find((item) => item?.key === selected);
        if (option?.inputs) {
          if (!(full in inputs) && selected !== undefined) inputs[full] = selected;
          fillGroup(inputs, option.inputs.required, `${full}.`);
          fillGroup(inputs, option.inputs.optional, `${full}.`);
        }
        continue;
      }
      if (typeof type === "string" && LINK_ONLY.has(type)) continue;
      if (full in inputs) continue;
      if ("default" in meta) inputs[full] = meta.default;
    }
  };

  for (const node of Object.values(prompt)) {
    const schema = lookup(node.class_type);
    if (!schema && fullSchema) {
      if (!warned.has(node.class_type) && onWarning) {
        warned.add(node.class_type);
        onWarning(`服务器上没有节点 ${node.class_type}，跳过 schema 补齐`);
      }
    }
    fillGroup(node.inputs, schema?.input?.required, "");
  }
}

/**
 * UI 图 → API 图。wf 已经脱掉 definitions，节点 id 变成字符串。
 * 跳过纯前端节点、mute 分支，bypass 节点按同类型输入穿透。
 */
function convertFlat(wf: UiWorkflow, lookup: SchemaLookup): PromptGraph {
  const byId = new Map<string, UiNode>();
  for (const node of wf.nodes) byId.set(String(node.id), node);
  const links = linkMap(wf.links ?? []);

  function source(
    originId: string,
    originSlot: number,
    want: string | undefined,
    guard = 0,
  ): [string, number] | null {
    let currentId = originId;
    let currentSlot = originSlot;

    while (guard < 32) {
      const node = byId.get(String(currentId));
      if (!node) return null;
      if (node.mode === 2) return null;

      const type = node.type;
      if (type !== "Reroute" && node.mode !== 4) return [String(currentId), currentSlot];

      const sockets = node.inputs ?? [];
      const order: number[] = [];
      if (type === "Reroute") order.push(0);
      else {
        order.push(currentSlot);
        for (let i = 0; i < sockets.length; i += 1) if (i !== currentSlot) order.push(i);
      }

      let advanced = false;
      for (const index of order) {
        const socket = sockets[index];
        if (!socket) continue;
        if (type !== "Reroute" && want && want !== "*" && socket.type !== want && socket.type !== "*") continue;
        const lid = socket.link;
        if (lid == null || !links.has(lid)) continue;
        [currentId, currentSlot] = links.get(lid)!;
        advanced = true;
        break;
      }
      if (!advanced) return null;
      guard += 1;
    }
    return null;
  }

  const prompt: PromptGraph = {};
  const dead = new Map<string, Set<string>>();

  for (const node of wf.nodes) {
    const type = node.type;
    if (!type || SKIP_TYPES.has(type)) continue;
    if (node.mode === 2 || node.mode === 4) continue;

    const inputs: Record<string, unknown> = {};
    const values = node.widgets_values;
    if (Array.isArray(values)) {
      assignWidgets(lookup(type), values, inputs);
    } else if (values && typeof values === "object") {
      Object.assign(inputs, values);
    }
    Object.assign(inputs, node._literals ?? {});

    for (const socket of node.inputs ?? []) {
      const lid = socket.link;
      if (lid == null || !links.has(lid)) continue;
      const [originId, originSlot] = links.get(lid)!;
      if (!byId.has(originId)) continue;
      const src = source(originId, originSlot, socket.type);
      if (!src) {
        if (socket.name) {
          const set = dead.get(String(node.id)) ?? new Set<string>();
          set.add(socket.name);
          dead.set(String(node.id), set);
          delete inputs[socket.name];
        }
        continue;
      }
      inputs[socket.name!] = [src[0], src[1]];
    }

    prompt[String(node.id)] = { class_type: type, inputs, _meta: { title: node.title || type } };
  }

  // 必填输入断了的节点执行不了，删掉并让下游继续失联
  let pruned = new Set<string>();
  while (dead.size > 0) {
    const drop = new Set<string>();
    for (const [nodeId, node] of Object.entries(prompt)) {
      const required = requiredNames(lookup(node.class_type));
      const missing = new Set(dead.get(nodeId) ?? []);
      for (const [name, value] of Object.entries(node.inputs)) {
        if (isLinkValue(value) && pruned.has(value[0])) missing.add(name);
      }
      for (const name of missing) {
        if (required.has(name)) {
          drop.add(nodeId);
          break;
        }
      }
    }
    if (drop.size === 0) break;
    for (const nodeId of drop) {
      pruned.add(nodeId);
      delete prompt[nodeId];
      dead.delete(nodeId);
    }
  }
  for (const node of Object.values(prompt)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isLinkValue(value) && pruned.has(value[0])) delete node.inputs[name];
    }
  }

  return prompt;
}

export function isApiFormat(value: unknown): value is PromptGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every((item) => Boolean(item) && typeof item === "object" && "class_type" in (item as Record<string, unknown>))
  );
}

export interface ConvertOptions {
  /** 完整的 object_info，用来给出“节点不存在”的提示 */
  objectInfo?: Record<string, NodeSchema>;
  onWarning?: (message: string) => void;
}

/** 把 UI 格式工作流转成 API 格式；已经是 API 格式则原样返回。 */
export function convertWorkflow(
  raw: unknown,
  lookup: SchemaLookup,
  options: ConvertOptions = {},
): PromptGraph {
  if (isApiFormat(raw)) return raw;

  const wf = raw as UiWorkflow;
  if (!wf || !Array.isArray(wf.nodes)) throw new Error("不是合法的 ComfyUI 工作流（缺少 nodes）");

  const flat = flattenWorkflow(wf);
  const prompt = convertFlat(flat, lookup);

  if (options.objectInfo) {
    fillDefaults(prompt, lookup, options.objectInfo, options.onWarning);
  }
  return prompt;
}
