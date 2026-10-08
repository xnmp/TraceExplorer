/**
 * In-memory Trace backend for the view harness. It answers the folder-scoped
 * protocol from a mutable node list (components are derived with the same
 * domain rules the view uses) and records save/discard calls so specs can
 * assert on outcomes.
 */
import { configureBackend } from "$lib/api/common";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { TileSizePreset } from "../../integration/plugin-sdk";
import { TILE_IMAGE_PX } from "./tile-presets";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import StubFileTiles from "./StubFileTiles.svelte";

export const DIRECTORY = "/pictures";
const TEMP = "/managed";
export const MIRROR = "/pictures-mirror";

type Seed = { key: string; parents?: string[]; scope?: TraceNode["scope"]; temporary?: boolean; prompt?: string };
let counter = 0;
function make({ key, parents = [], scope = "current", temporary = false, prompt }: Seed): TraceNode {
  counter += 1;
  const path = temporary ? `${TEMP}/${key}.png` : scope === "current" ? `${DIRECTORY}/${key}.png` : scope === "subfolder" ? `${DIRECTORY}/refs/${key}.png` : `/elsewhere/${key}.png`;
  return {
    key: parents.length ? `o:${counter}:0` : `a:${counter}`, artifactId: counter, runId: parents.length ? counter : null, parents, path, scope,
    location: temporary ? "Unsaved" : scope === "current" ? `./${key}.png` : scope === "subfolder" ? `refs/${key}.png` : `/elsewhere/${key}.png`,
    state: "present", temporary, discarded: false, earlierRevision: false, order: counter, prompt: prompt ?? `${key} prompt`,
  };
}

/** Named scenario nodes; keys are resolved after creation so parents refer to real keys. */
function scenario(): { nodes: TraceNode[]; names: Map<string, string> } {
  counter = 0;
  const names = new Map<string, string>();
  const nodes: TraceNode[] = [];
  const add = (seed: Seed) => {
    const node = make({ ...seed, parents: (seed.parents ?? []).map((name) => names.get(name)!) });
    names.set(seed.key, node.key);
    nodes.push(node);
  };
  const query = new URLSearchParams(globalThis.location?.search ?? "");
  // `?gym=1` puts a small component first, shaped like a typical edit session:
  // a root with two edits, and two further edits under the second one.
  if (query.has("gym")) for (const seed of [
    { key: "gym" }, { key: "cerulean", parents: ["gym"] }, { key: "saffron", parents: ["gym"] },
    { key: "saffron-a", parents: ["saffron"] }, { key: "saffron-b", parents: ["saffron"] },
  ] satisfies Seed[]) add(seed);
  for (const seed of [
    { key: "village" }, { key: "palette" }, { key: "mist", scope: "subfolder" }, { key: "lantern", scope: "external" },
    { key: "daylight", parents: ["village"] }, { key: "warm", parents: ["village", "palette", "mist", "lantern"] }, { key: "cool", parents: ["palette"] },
    { key: "morning", parents: ["daylight"] }, { key: "sunny", parents: ["daylight"] }, { key: "evening", parents: ["warm"] }, { key: "rain", parents: ["warm"] },
    { key: "merge", parents: ["daylight", "warm"], temporary: true }, { key: "quiet", parents: ["rain"] },
    // Daylight's six children make its focus widen the graph (see the motion specs).
    { key: "dawn", parents: ["daylight"] }, { key: "noon", parents: ["daylight"] }, { key: "dusk", parents: ["daylight"] },
    { key: "forest" }, { key: "forest-mist", parents: ["forest"] }, { key: "autumn", parents: ["forest"] },
    { key: "fan" }, ...Array.from({ length: 18 }, (_, index) => ({ key: `fan-${index + 1}`, parents: ["fan"] })),
  ] satisfies Seed[]) add(seed);
  // `?deeper=1` continues the forest's mist edit two more generations, so selecting along it reveals new columns.
  if (query.has("deeper")) for (const seed of [{ key: "mist-dawn", parents: ["forest-mist"] }, { key: "mist-dusk", parents: ["mist-dawn"] }]) add(seed);
  // `?many=N` appends N small components (a root and six children each) for tall, scrollable views.
  const many = Number(query.get("many") ?? 0);
  for (let component = 0; component < many; component++) {
    add({ key: `m${component}` });
    for (let index = 0; index < 6; index++) add({ key: `m${component}-${index}`, parents: [`m${component}`] });
  }
  return { nodes, names };
}

let state = scenario();
let version = 1;
let entryExtras = [
  { name: "notes.txt", path: `${DIRECTORY}/notes.txt`, kind: "file" as const },
  { name: "plain.png", path: `${DIRECTORY}/plain.png`, kind: "file" as const },
  { name: "refs", path: `${DIRECTORY}/refs`, kind: "directory" as const },
];
const calls: Array<{ method: string; params: unknown }> = [];
let changeListener: (() => void) | null = null;
let holdSaves = false;
let heldSaves: Array<() => void> = [];
let titleConnection = false;
let pickerResult: string | null | undefined;
let nextSaveFailure: string | null = null;
// Delay of the Preview-info queries, in ms: a native backend answers them over IPC, not within the same frame.
let previewLatency = 0;
const titleCalls: number[] = [];
const titleWaiters = new Map<number, (title: string) => void>();

function componentsOf() {
  const dag = projectDag(state.nodes);
  return connectedComponents(dag).map((members) => {
    const first = members.map((key) => dag.nodes.get(key)!).sort((a, b) => a.order - b.order)[0];
    const name = [...state.names].find(([, key]) => key === first.key)?.[0] ?? first.key;
    const nodes = members.map((key) => dag.nodes.get(key)!);
    return {
      id: `c:${first.key}`, members, nodes,
      summary: {
        id: `c:${first.key}`, title: name, cover: first.path ? { path: first.path, present: true } : null,
        imageCount: nodes.filter((node) => node.artifactId !== null).length, nodeCount: nodes.length,
        active: nodes.some((node) => node.state === "running"), unsaved: nodes.some((node) => node.temporary && !node.discarded),
      },
    };
  });
}

export const files = () => [
  ...state.nodes.filter((node) => node.scope === "current" && !node.temporary && node.path).map((node) => ({ name: node.path!.split("/").at(-1)!, path: node.path!, kind: "file" as const })),
  ...entryExtras,
].map((entry) => ({ ...entry, size: 32, modified: "2026-10-05T00:00:00Z" }));

function changed() { version += 1; changeListener?.(); }
function update(key: string, patch: Partial<TraceNode>) {
  state = { ...state, nodes: state.nodes.map((node) => node.key === key ? { ...node, ...patch } : node) };
}
const byArtifact = (id: number) => state.nodes.find((node) => node.artifactId === id);

configureBackend({
  invoke<T>(method: string, params: Record<string, any> = {}): Promise<T> {
    calls.push({ method, params: structuredClone(params) });
    const reply = (value: unknown) => Promise.resolve(value as T);
    const later = (value: unknown) => previewLatency ? new Promise<T>((resolve) => setTimeout(() => resolve(value as T), previewLatency)) : reply(value);
    const token = String(version);
    switch (method) {
      // MIRROR answers with the same Trace: another folder whose components reuse the same ids.
      case "folder_has_trace": return reply(params.directory === DIRECTORY || params.directory === MIRROR);
      case "trace_folder_components": {
        const all = componentsOf().map((component) => component.summary);
        return reply({ token, total: all.length, offset: params.offset, components: all.slice(params.offset) });
      }
      case "trace_folder_members": {
        if (params.token !== token) return reply({ stale: true, total: 0, offset: 0, members: [] });
        const members = componentsOf().flatMap((component) => component.nodes
          .filter((node) => node.scope === "current" && !node.temporary && node.path)
          .map((node) => ({ path: node.path!, componentId: component.id, key: node.key })));
        return reply({ stale: false, total: members.length, offset: params.offset, members: members.slice(params.offset) });
      }
      case "trace_component_nodes": {
        if (params.token !== token) return reply({ stale: true, total: 0, offset: 0, nodes: [] });
        const nodes = componentsOf().find((component) => component.id === params.componentId)?.nodes ?? [];
        return reply({ stale: false, total: nodes.length, offset: params.offset, nodes: nodes.slice(params.offset) });
      }
      case "trace_run_details": return later((params.runIds as number[]).map((id) => {
        const node = state.nodes.find((item) => item.runId === id);
        return {
          id, operation: "openai.image.edit", parameters: { prompt: node?.prompt ?? "", resolution: "2k", aspect_ratio: "keep", quality: "high", seed: 7 },
          createdAt: "2026-10-05T00:00:00Z", status: node?.state === "running" ? "running" : "succeeded", finishedAt: null, error: null, recovered: false,
          details: { actual_size: { width: 1024, height: 768 } }, inputIds: [],
        };
      }));
      case "trace_revision_status": return later("matched");
      case "trace_for_image": return later(null);
      case "image_save_suggestion": return reply({ directory: DIRECTORY, filename: `${byArtifact(params.artifactId)?.key ?? "image"}.png` });
      case "save_generated_image": {
        const node = byArtifact(params.artifactId);
        if (!node) return Promise.reject(new Error("Unknown artifact"));
        if (nextSaveFailure) { const message = nextSaveFailure; nextSaveFailure = null; return Promise.reject(new Error(message)); }
        const name = [...state.names].find(([, key]) => key === node.key)?.[0] ?? "saved";
        const path: string = params.target ?? `${DIRECTORY}/${name}.png`;
        const finish = () => {
          const inside = path.startsWith(`${DIRECTORY}/`) && !path.slice(DIRECTORY.length + 1).includes("/");
          update(node.key, { temporary: false, path, scope: inside ? "current" : "external", location: inside ? `./${path.split("/").at(-1)}` : path });
          changed();
        };
        if (holdSaves) return new Promise((resolve) => heldSaves.push(() => { finish(); resolve({ path } as T); }));
        finish();
        return reply({ path });
      }
      case "discard_generated_image": {
        const node = byArtifact(params.artifactId);
        if (node) { update(node.key, { discarded: true }); changed(); }
        return reply({ viewPath: null });
      }
      case "trace_title_connection": return reply(titleConnection);
      case "trace_prompt_title": return new Promise<T>((resolve) => { titleCalls.push(params.runId); titleWaiters.set(params.runId, (title) => resolve(title as T)); });
      default: return Promise.reject(new Error(`Unexpected method ${method}`));
    }
  },
});

// `?fileTiles=1` simulates a host with the `ui/file-tiles` module; without it, an older SDK 2 host.
const fileTiles = new URLSearchParams(globalThis.location?.search ?? "").has("fileTiles");
// `?tileSize=<preset>` simulates a host with the `tileSize` capability whose pane reports that preset; without it, an older host.
const tileQuery = new URLSearchParams(globalThis.location?.search ?? "").get("tileSize");
export const initialTileSize: TileSizePreset | null = tileQuery && tileQuery in TILE_IMAGE_PX ? tileQuery as TileSizePreset : null;
const color = (path: string) => `hsl(${[...path].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)} 45% 55%)`;
(globalThis as any).__TAURI_EXPLORER_PLUGIN_SDK__ = {
  sdkVersion: 1, apiVersion: 2, svelteVersion: "5.56.3",
  capabilities: ["fileViews", "previewInfo", "previewTargets", "blobWorkers", ...(fileTiles ? ["fileTiles"] : []), ...(initialTileSize ? ["tileSize"] : [])],
  modules: fileTiles ? { "ui/file-tiles": { default: StubFileTiles } } : {},
  pickSaveFile: async () => pickerResult === undefined ? `${DIRECTORY}/picked.png` : pickerResult,
  thumbnailData: async (path: string) => ({ ok: true, data: URL.createObjectURL(new Blob([
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="${color(path)}"/></svg>`,
  ], { type: "image/svg+xml" })) }),
};

export const backend = {
  key: (name: string) => state.names.get(name)!,
  path: (name: string) => state.nodes.find((node) => node.key === state.names.get(name))?.path ?? null,
  node: (name: string) => structuredClone(state.nodes.find((node) => node.key === state.names.get(name)) ?? null),
  calls: (method?: string) => structuredClone(calls.filter((call) => !method || call.method === method)),
  onChange(listener: () => void) { changeListener = listener; },
  /** Starts a generation from `parent`; returns the placeholder's key. */
  startGeneration(parent: string, name: string) {
    counter += 1;
    const key = `o:${counter}:0`;
    state.names.set(name, key);
    state = { ...state, nodes: [...state.nodes, {
      key, artifactId: null, runId: counter, parents: [state.names.get(parent)!], path: null, scope: "current", location: "Generating",
      state: "running", temporary: true, discarded: false, earlierRevision: false, order: counter, prompt: `${name} prompt`,
    }] };
    changed();
    return key;
  },
  /** Saves an unsaved output into the folder, as its Save action would. */
  saveGeneration(name: string) {
    update(state.names.get(name)!, { temporary: false, path: `${DIRECTORY}/${name}.png`, location: `./${name}.png`, scope: "current" });
    changed();
  },
  /** Discards an unsaved output, as its Delete action would. */
  discardGeneration(name: string) {
    update(state.names.get(name)!, { discarded: true });
    changed();
  },
  completeGeneration(name: string) {
    const key = state.names.get(name)!;
    counter += 1;
    update(key, { artifactId: counter, path: `${TEMP}/${name}.png`, location: "Unsaved", state: "present" });
    changed();
  },
  /** Title generation: connection availability, requested run ids, and manual completion. */
  titles: {
    connect(available: boolean) { titleConnection = available; },
    calls: () => [...titleCalls],
    finish(runId: number, title: string) { titleWaiters.get(runId)?.(title); titleWaiters.delete(runId); },
  },
  /** Replaces a node's prompt, as a rerecorded run would. */
  setPrompt(name: string, prompt: string) {
    update(state.names.get(name)!, { prompt });
    changed();
  },
  runId: (name: string) => state.nodes.find((node) => node.key === state.names.get(name))?.runId ?? null,
  /** `null` simulates cancelling the Save as… picker. */
  setPicker(result: string | null | undefined) { pickerResult = result; },
  /** The next save fails with this message (for example a filename collision). */
  failNextSave(message: string) { nextSaveFailure = message; },
  holdSaves() { holdSaves = true; },
  /** Answers run details, revision status and per-image traces after `ms`. */
  setPreviewLatency(ms: number) { previewLatency = ms; },
  releaseSaves() { holdSaves = false; const pending = heldSaves; heldSaves = []; pending.forEach((run) => run()); },
  reset() { previewLatency = 0; pickerResult = undefined; nextSaveFailure = null; state = scenario(); version += 1; calls.length = 0; },
};
