import { imageAvailability } from "../../tests/fixtures/image-connections";
import groupingFixtures from "../../tests/fixtures/folder-grouping.json";
/**
 * In-memory Trace backend for the view harness. It answers the folder-scoped
 * protocol from a mutable node list (components are derived with the same
 * domain rules the view uses) and records save/discard calls so specs can
 * assert on outcomes.
 */
import { configureBackend, invoke } from "$lib/api/common";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { JobCost, JobReveal, TileSizePreset } from "../../integration/plugin-sdk";
import { TILE_IMAGE_PX, TILE_GRID_PX } from "./tile-presets";
import { basename, joinPath, parentDir } from "$lib/domain/path";
import StubFileTile from "./StubFileTile.svelte";
import StubFileTiles from "./StubFileTiles.svelte";
import { folderComponents, folderPage, isDirectFolderSeed, nativeStringOrder, type FolderNode } from "./folder-snapshot";
import { isLocalAbsolutePath } from "$lib/domain/target-location";
import { canonicalFixtureImagePath } from "./image-input-files";
import { withNativeRequestCapacity } from "./request-capacity";

export const DIRECTORY = "/pictures";
const TEMP = "/managed";
export const MIRROR = "/pictures-mirror";

type Seed = { key: string; parents?: string[]; scope?: TraceNode["scope"]; temporary?: boolean; prompt?: string };
let counter = 0;
function make({ key, parents = [], scope = "current", temporary = false, prompt }: Seed): FolderNode {
  counter += 1;
  const path = temporary ? `${TEMP}/${key}.png` : scope === "current" ? `${DIRECTORY}/${key}.png` : scope === "subfolder" ? `${DIRECTORY}/refs/${key}.png` : `/elsewhere/${key}.png`;
  return {
    key: parents.length ? `o:${counter}:0` : `a:${counter}`, artifactId: counter, runId: parents.length ? counter : null, parents, path, scope,
    location: temporary ? "Unsaved" : scope === "current" ? `./${key}.png` : scope === "subfolder" ? `refs/${key}.png` : `/elsewhere/${key}.png`,
    state: "present", temporary, ...(temporary ? { contextDirectory: DIRECTORY } : {}), discarded: false, earlierRevision: false, order: counter, prompt: prompt ?? `${key} prompt`,
  };
}

/** Named scenario nodes; keys are resolved after creation so parents refer to real keys. */
function scenario(): { nodes: FolderNode[]; names: Map<string, string> } {
  counter = 0;
  const names = new Map<string, string>();
  const nodes: FolderNode[] = [];
  const add = (seed: Seed) => {
    const node = make({ ...seed, parents: (seed.parents ?? []).map((name) => names.get(name)!) });
    names.set(seed.key, node.key);
    nodes.push(node);
  };
  const query = new URLSearchParams(globalThis.location?.search ?? "");
  // Shared with native and mock golden tests. These focused scenarios expose
  // references repeated across sections without disturbing the motion gym.
  const grouping = groupingFixtures.find((fixture) => fixture.name === query.get("grouping"));
  if (grouping) {
    const fixtures = grouping.nodes as FolderNode[];
    for (const node of fixtures) {
      names.set(basename(node.path ?? node.key).replace(/\.png$/, ""), node.key);
      counter = Math.max(counter, node.artifactId ?? 0, node.runId ?? 0);
    }
    return { nodes: fixtures, names };
  }
  // Record source identities in their original order, then outputs oldest
  // section first. Native summaries rank newest-first, while identities keep
  // village before forest before fan when a later edit joins those lineages.
  if (query.has("gym")) add({ key: "gym" });
  for (const seed of [
    { key: "village" }, { key: "palette" }, { key: "mist", scope: "subfolder" }, { key: "lantern", scope: "external" },
    { key: "forest" }, { key: "fan" },
  ] satisfies Seed[]) add(seed);
  // `?many=N` adds N older small components (a root and six children each) for tall, scrollable views.
  const many = Number(query.get("many") ?? 0);
  for (let component = many - 1; component >= 0; component--) {
    add({ key: `m${component}` });
    for (let index = 0; index < 6; index++) add({ key: `m${component}-${index}`, parents: [`m${component}`] });
  }
  for (const seed of [
    ...Array.from({ length: 18 }, (_, index) => ({ key: `fan-${index + 1}`, parents: ["fan"] })),
  ] satisfies Seed[]) add(seed);
  // Large uncached scenes exercise the view's worker layout path during reveal.
  if (query.has("revealLarge")) for (let index = 0; index < 85; index++) add({ key: `wide-${index}`, parents: ["fan"] });
  // `?fanChildren=N` gives the fan N more direct children: enough tiles that the graph windows them.
  for (let index = 0; index < Number(query.get("fanChildren") ?? 0); index++) add({ key: `fan-child-${index}`, parents: ["fan"] });
  for (const seed of [
    { key: "forest-mist", parents: ["forest"] }, { key: "autumn", parents: ["forest"] },
  ] satisfies Seed[]) add(seed);
  // `?deeper=1` continues the forest's mist edit two more generations, so selecting along it reveals new columns.
  if (query.has("deeper")) for (const seed of [{ key: "mist-dawn", parents: ["forest-mist"] }, { key: "mist-dusk", parents: ["mist-dawn"] }]) add(seed);
  if (query.has("moreBadges")) {
    add({ key: "reference-3", scope: "subfolder" });
    add({ key: "reference-4", scope: "external" });
  }
  for (const seed of [
    { key: "daylight", parents: ["village"] }, { key: "warm", parents: ["village", "palette", "mist", "lantern", ...(query.has("moreBadges") ? ["reference-3", "reference-4"] : [])] }, { key: "cool", parents: ["palette"] },
    { key: "morning", parents: ["daylight"] }, { key: "sunny", parents: ["daylight"] }, { key: "evening", parents: ["warm"] }, { key: "rain", parents: ["warm"] },
    { key: "merge", parents: ["daylight", "warm"], temporary: true }, { key: "quiet", parents: ["rain"] },
    // Daylight's six children make its focus widen the graph (see the motion specs).
    { key: "dawn", parents: ["daylight"] }, { key: "noon", parents: ["daylight"] }, { key: "dusk", parents: ["daylight"] },
  ] satisfies Seed[]) add(seed);
  // `?gym=1` puts a small component first, shaped like a typical edit session:
  // a root with two edits, and two further edits under the second one.
  if (query.has("gym")) for (const seed of [
    { key: "cerulean", parents: ["gym"] }, { key: "saffron", parents: ["gym"] },
    { key: "saffron-a", parents: ["saffron"] }, { key: "saffron-b", parents: ["saffron"] },
  ] satisfies Seed[]) add(seed);
  // `?lone=1` adds an image whose only history is failed edits: recorded, but with no visible relationship.
  if (query.has("lone")) add({ key: "lonely" });
  // Append new identities after the existing scenarios. Native newest-first
  // summaries put A above B, then the unchanged village/forest/fan/many order.
  // A's focused grandchild disappears when selecting B, exercising a hold
  // while a section above the clicked tile shrinks.
  if (query.has("anchorChains") || query.has("anchorWorker")) {
    for (const seed of [
      { key: "anchor-b" }, { key: "anchor-b-child", parents: ["anchor-b"] },
    ] satisfies Seed[]) add(seed);
    // Clicking B's child reveals an uncached neighborhood above SYNC_LIMIT.
    if (query.has("anchorWorker")) for (let index = 0; index < 75; index++) add({ key: `anchor-b-leaf-${index}`, parents: ["anchor-b-child"] });
    for (const seed of [
      { key: "anchor-a" }, { key: "anchor-a-middle", parents: ["anchor-a"] },
      { key: "anchor-a-last", parents: ["anchor-a-middle"] },
    ] satisfies Seed[]) add(seed);
  }
  // `?draftStack=1` adds an unsaved cover with one saved edit: a stack that another pane can save (`backend.saveGeneration("draft")`).
  if (query.has("draftStack")) { add({ key: "draft", temporary: true }); add({ key: "draft-edit", parents: ["draft"] }); }
  // `?wideRoots=N`: N separate roots joined by multi-input edits into one component, whose first row is far wider than a narrow pane.
  const wideRoots = Number(query.get("wideRoots") ?? 0);
  for (let index = 0; index < wideRoots; index++) add({ key: `wr-${index}` });
  for (let index = 0; index + 1 < wideRoots; index++) add({ key: `wr-edit-${index}`, parents: [`wr-${index}`, `wr-${index + 1}`] });
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
/** Accepted jobs keep the run recipe and save hint, like Trace's durable runs. */
const imageRuns = new Map<number, { operation: string; parameters: Record<string, unknown>; directory: string; filename: string }>();
const imageJobs = new Map<number, string>();
const imageOperations = new Map<number, string>();
const operationIdFor = (jobId: number) => jobId.toString(16).padStart(32, "0");
const billing = new Map<number, { cost: JobCost }>();
let changeListener: (() => void) | null = null;
/** Runs whose Interrupted placeholder the user dismissed (`runs.dismissed_at`). */
const dismissedRuns = new Set<number>();
let holdSaves = false;
let heldSaves: Array<() => void> = [];
let titleConnection = false;
let pickerResult: string | null | undefined;
let nextSaveFailure: string | null = null;
/** How many of the next `openai_image_inputs` calls fail. */
let inputFailures = 0;
const inputSymlinks = new Map<string, string>();
// Delay of the Preview-info queries, in ms: a native backend answers them over IPC, not within the same frame.
let previewLatency = 0;
// Delay of the folder index and component reads, in ms, like a native backend's IPC round trip.
let folderLatency = 0;
let folderReadsHeld = false;
/** How many of the next `trace_component_nodes` reads fail. */
let nodeReadFailures = 0;
let heldFolderReads: Array<() => void> = [];
const titleCalls: number[] = [];
const titleWaiters = new Map<number, (title: string) => void>();

const componentsOf = () => folderComponents(state.nodes, dismissedRuns);

export const files = () => [
  ...state.nodes.filter((node) => isDirectFolderSeed(node) && !entryExtras.some((entry) => entry.path === node.path)).map((node) => ({ name: node.path!.split("/").at(-1)!, path: node.path!, kind: "file" as const })),
  ...entryExtras,
].map((entry) => ({ ...entry, size: 32, modified: "2026-10-05T00:00:00Z" }));

function changed() { version += 1; changeListener?.(); }
function update(key: string, patch: Partial<TraceNode>) {
  state = { ...state, nodes: state.nodes.map((node) => node.key === key ? { ...node, ...patch } : node) };
}
const byArtifact = (id: number) => state.nodes.find((node) => node.artifactId === id);
function saveSuggestion(node: TraceNode | undefined) {
  const run = node?.runId === null || node?.runId === undefined ? undefined : imageRuns.get(node.runId);
  if (!run) return { directory: DIRECTORY, filename: `${node?.key ?? "image"}.png` };
  const occupied = new Set(files().map((entry) => entry.path));
  const stem = run.filename.replace(/\.png$/, "");
  let filename = run.filename;
  for (let index = 2; occupied.has(joinPath(run.directory, filename)); index++) filename = `${stem}_${index}.png`;
  return { directory: run.directory, filename };
}

/** Same storage rule as Trace: a private output path is never a saved-file signal. */
function jobSnapshot(jobId: number) {
  const node = state.nodes.find((node) => node.key === imageJobs.get(jobId));
  if (!node || node.runId === null) return null;
  const run = imageRuns.get(node.runId);
  const reveal: JobReveal | undefined = node.artifactId === null || node.discarded ? undefined
    : run?.parameters.output_storage === "saved" ? { kind: "file", path: node.path! }
    : run?.directory ? { kind: "view", viewId: "trace.view", directory: run.directory, targetId: `artifact:${node.artifactId}` } : undefined;
  const cost = billing.get(node.runId)?.cost;
  return { jobId, runId: node.runId, operationId: imageOperations.get(jobId), status: node.state === "present" ? "succeeded" : node.state,
    outputPath: node.path, error: null, ...(reveal ? { reveal } : {}), ...(cost ? { cost } : {}) };
}

configureBackend(withNativeRequestCapacity({
  invoke<T>(method: string, params: Record<string, any> = {}): Promise<T> {
    calls.push({ method, params: structuredClone(params) });
    const reply = (value: unknown) => Promise.resolve(value as T);
    const later = (value: unknown) => previewLatency ? new Promise<T>((resolve) => setTimeout(() => resolve(value as T), previewLatency)) : reply(value);
    const folderReply = (value: unknown) => folderReadsHeld
      ? new Promise<T>((resolve) => heldFolderReads.push(() => resolve(value as T)))
      : folderLatency ? new Promise<T>((resolve) => setTimeout(() => resolve(value as T), folderLatency)) : reply(value);
    const token = String(version);
    switch (method) {
      // MIRROR answers with the same Trace: another folder whose components reuse the same ids.
      case "jobs.status": {
        const operationId = params.operationId;
        if (typeof operationId !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(operationId)) return Promise.reject(new Error("Invalid image operation ID"));
        const jobId = [...imageOperations].find(([, id]) => id === operationId)?.[0];
        return reply(jobId === undefined ? null : jobSnapshot(jobId));
      }
      case "folder_has_trace": return reply(params.directory === DIRECTORY || params.directory === MIRROR);
      case "trace_folder_components": {
        const all = componentsOf().map((component) => component.summary);
        return folderReply({ token, total: all.length, offset: params.offset, components: folderPage(all, params.offset, 200) });
      }
      case "trace_folder_members": {
        if (params.token !== token) return folderReply({ stale: true, total: 0, offset: 0, members: [] });
        const members = componentsOf().flatMap((component) => component.nodes
          .filter(isDirectFolderSeed)
          .map((node) => ({ path: node.path!, componentId: component.id, key: node.key }))).sort((a, b) => nativeStringOrder(a.path, b.path));
        return folderReply({ stale: false, total: members.length, offset: params.offset, members: folderPage(members, params.offset, 1000) });
      }
      case "trace_component_nodes": {
        if (nodeReadFailures > 0) { nodeReadFailures -= 1; return Promise.reject(new Error("Trace could not read this stack")); }
        if (params.token !== token) return folderReply({ stale: true, total: 0, offset: 0, nodes: [] });
        const nodes = componentsOf().find((component) => component.id === params.componentId)?.nodes;
        if (!nodes) return Promise.reject(new Error("Unknown Trace component"));
        return folderReply({ stale: false, total: nodes.length, offset: params.offset, nodes: folderPage(nodes, params.offset, 1000) });
      }
      case "trace_run_details": return later((params.runIds as number[]).map((id) => {
        const node = state.nodes.find((item) => item.runId === id);
        const run = imageRuns.get(id);
        return {
          id, operation: run?.operation ?? "openai.image.edit", parameters: run?.parameters ?? { prompt: node?.prompt ?? "", resolution: "2k", aspect_ratio: "keep", quality: "high", seed: 7 },
          createdAt: "2026-10-05T00:00:00Z", status: node?.state === "running" ? "running" : "succeeded", finishedAt: null, error: null, recovered: false,
          details: { actual_size: { width: 1024, height: 768 }, ...(billing.has(id) ? { provider_billing: billing.get(id) } : {}) }, inputIds: node?.parents.flatMap((key) => {
            const id = state.nodes.find((parent) => parent.key === key)?.artifactId;
            return id === null || id === undefined ? [] : [id];
          }) ?? [],
        };
      }));
      case "trace_revision_status": return later("matched");
      case "trace_for_image": return later(null);
      case "image_save_suggestion": return reply(saveSuggestion(byArtifact(params.artifactId)));
      case "save_generated_image": {
        const node = byArtifact(params.artifactId);
        if (!node) return Promise.reject(new Error("Unknown artifact"));
        if (nextSaveFailure) { const message = nextSaveFailure; nextSaveFailure = null; return Promise.reject(new Error(message)); }
        const name = [...state.names].find(([, key]) => key === node.key)?.[0] ?? "saved";
        const suggestion = saveSuggestion(node);
        const path: string = params.target ?? (node.runId !== null && imageRuns.has(node.runId)
          ? joinPath(suggestion.directory, suggestion.filename) : `${DIRECTORY}/${name}.png`);
        const finish = () => {
          const inside = path.startsWith(`${DIRECTORY}/`) && !path.slice(DIRECTORY.length + 1).includes("/");
          update(node.key, { temporary: false, path, scope: inside ? "current" : "external", location: inside ? `./${path.split("/").at(-1)}` : path });
          const run = node.runId === null ? undefined : imageRuns.get(node.runId);
          if (run && node.runId !== null) imageRuns.set(node.runId, { ...run, directory: parentDir(path),
            parameters: { ...run.parameters, output_storage: "saved", save_directory_hint: parentDir(path) } });
          changed();
        };
        if (holdSaves) return new Promise((resolve) => heldSaves.push(() => { finish(); resolve({ path } as T); }));
        finish();
        return reply({ path });
      }
      case "dismiss_interrupted_run": {
        // As the backend: repeating a dismissal succeeds; only a dismissable Interrupted placeholder qualifies.
        if (dismissedRuns.has(params.runId)) return reply({});
        const node = state.nodes.find((candidate) => candidate.runId === params.runId);
        if (!node || node.state !== "uncertain" || node.artifactId !== null || !node.dismissable) return Promise.reject(new Error("Only an interrupted placeholder without output can be dismissed"));
        dismissedRuns.add(params.runId);
        changed();
        return reply({});
      }
      case "discard_generated_image": {
        const node = byArtifact(params.artifactId);
        if (node) { update(node.key, { discarded: true }); changed(); }
        return reply({ viewPath: null });
      }
      case "trace_title_context": return reply({version:1,enabled:true,available:titleConnection,configurationRevision:1,context:{configurationRevision:1,fingerprint:"f".repeat(64)}});
      case "trace_cancel_prompt_title": return reply({cancelled:true});
      // AI edit inputs: every known image is present, 160×96, with a revision derived from its path.
      case "openai_image_inputs": if (inputFailures > 0) { inputFailures -= 1; return Promise.reject(new Error("The image service is busy")); }
        if (!Array.isArray(params.paths) || params.paths.length > 8) return Promise.reject(new Error("At most eight input images are supported"));
        return reply((params.paths as string[]).map((path) => {
          const canonicalPath = canonicalFixtureImagePath(path, inputSymlinks);
          if (canonicalPath === null) return { path, error: "Cannot resolve input path" };
          return state.nodes.some((node) => node.path === canonicalPath && node.state === "present" && !node.discarded) || entryExtras.some((entry) => entry.path === canonicalPath && entry.kind === "file")
            ? { path, canonicalPath, digest: [...canonicalPath].reduce((hash, char) => (hash * 33 + char.charCodeAt(0)) % 1e9, 5381).toString(16).padStart(64, "0"), width: 160, height: 96 }
            : { path, error: "Path not found" };
        }));
      case "image_service_describe": {
        const snapshot = structuredClone(imageService);
        return imageDescriptionsHeld ? new Promise<T>((resolve) => { imageDescriptionWaiters.push(() => resolve(snapshot as T)); }) : reply(snapshot);
      }
      case "jobs.start": {
        const request = params.request as Record<string, unknown>;
        const profile = imageService.description?.profiles.find((p) => p.id === request.connectionId);
        if ("apiKey" in params || "backend" in request || "codexPath" in request) return Promise.reject(new Error("Credentials are not accepted by shared image jobs"));
        if (!imageService.available || !profile) return Promise.reject(new Error("Image connection unavailable"));
        if (request.expectedConnectionRevision !== profile.recipeRevision) return Promise.reject(new Error("Image connection changed; prepare again"));
        const references = (request.referencePaths ?? []) as string[];
        const inputCount = (request.sourcePath ? 1 : 0) + references.length;
        if (!(inputCount ? profile.capabilities.edit : profile.capabilities.generation)) return Promise.reject(new Error("Image connection does not support this operation"));
        if (inputCount > profile.capabilities.maxInputs) return Promise.reject(new Error("Too many image inputs"));
        if (profile.transport === "codex-cli" ? request.model !== null : typeof request.model !== "string" || !request.model.trim()) return Promise.reject(new Error("Invalid image model"));
        const jobId = 900 + calls.filter((call) => call.method === "jobs.start").length;
        const paths = [request.sourcePath, ...references].filter((path): path is string => typeof path === "string");
        if (paths.some((path) => !state.nodes.some((node) => node.path === path)
          && !entryExtras.some((entry) => entry.path === path && entry.kind === "file"))) return Promise.reject(new Error("Input image unavailable"));
        // Recording a run indexes plain input files before connecting its output.
        const parents = [...new Set(paths)].map((path) => {
          const known = state.nodes.find((node) => node.path === path);
          if (known) return known.key;
          const source = make({ key: basename(path).replace(/\.[^.]+$/, "") });
          state = { ...state, nodes: [...state.nodes, { ...source, path }] };
          return source.key;
        });
        const runId = ++counter;
        const key = `o:${runId}:0`;
        const filename = request.sourcePath ? `${basename(String(request.sourcePath)).replace(/\.[^.]+$/, "")}_edit.png` : "generated.png";
        const inherited = imageRuns.get(state.nodes.find((node) => node.path === request.sourcePath)?.runId ?? -1)?.directory;
        const outputDir = typeof request.outputDir === "string" ? request.outputDir : "";
        const directory = isLocalAbsolutePath(outputDir) ? outputDir
          : inherited && isLocalAbsolutePath(inherited) ? inherited : "";
        imageRuns.set(runId, {
          operation: inputCount ? "openai.image.edit" : "openai.image.generate",
          parameters: { prompt: request.prompt, resolution: request.resolution, aspect_ratio: request.aspectRatio, quality: request.quality,
            output_storage: "temporary", save_directory_hint: directory, suggested_filename: filename },
          directory, filename,
        });
        imageJobs.set(jobId, key);
        imageOperations.set(jobId, params.operationId ?? operationIdFor(jobId));
        state.names.set(`job-${jobId}`, key);
        state = { ...state, nodes: [...state.nodes, {
          key, artifactId: null, runId, parents, path: null, scope: directory === DIRECTORY ? "current" : "external", location: "Generating",
          state: "running", temporary: true, contextDirectory: directory, discarded: false, earlierRevision: false, order: 1_000_000_000_000 + runId, prompt: String(request.prompt),
        }] };
        changed();
        return reply(jobId);
      }
      case "trace_prompt_title": return new Promise<T>((resolve) => { titleCalls.push(params.runId); titleWaiters.set(params.runId, (title) => resolve({title,configurationRevision:1,fingerprint:"f".repeat(64)} as T)); });
      default: return Promise.reject(new Error(`Unexpected method ${method}`));
    }
  },
}));

// `?fileTiles=1` simulates a host with the `ui/file-tiles` module; without it, an older SDK 2 host.
const fileTile = new URLSearchParams(globalThis.location?.search ?? "").has("fileTile");
const fileTiles = new URLSearchParams(globalThis.location?.search ?? "").has("fileTiles");
// `?tileSize=<preset>` simulates a host with the `tileSize` capability whose pane reports that preset; without it, an older host.
const tileQuery = new URLSearchParams(globalThis.location?.search ?? "").get("tileSize");
export const initialTileSize: TileSizePreset | null = tileQuery && tileQuery in TILE_IMAGE_PX ? tileQuery as TileSizePreset : null;
// Independently toggled so every compatibility combination can be exercised.
export const paneDialogs = new URLSearchParams(globalThis.location?.search ?? "").get("paneDialogs") !== "0";
export const fileDropTargets = new URLSearchParams(globalThis.location?.search ?? "").get("fileDropTargets") !== "0";
const color = (path: string) => `hsl(${[...path].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)} 45% 55%)`;
(globalThis as any).__TAURI_EXPLORER_PLUGIN_SDK__ = {
  sdkVersion: 1, apiVersion: 2, svelteVersion: "5.56.3",
  capabilities: ["fileViews", "previewInfo", "previewTargets", "blobWorkers", "jobReveal", "jobCost", "fileViewReveal", ...(fileTile ? ["fileTile"] : []), ...(fileTiles ? ["fileTiles"] : []), ...(initialTileSize ? ["tileSize"] : []), ...(paneDialogs ? ["paneDialogs"] : []), ...(fileDropTargets ? ["fileDropTargets"] : [])],
  modules: {
    ...(fileTiles ? { "ui/file-tiles": { default: StubFileTiles } } : {}),
    ...(fileTile ? { "ui/file-tile": { default: StubFileTile, tileGridMetrics: (size: TileSizePreset = "medium") => {
      const preset = Object.hasOwn(TILE_IMAGE_PX, size) ? size : "medium";
      return { cellWidth: TILE_GRID_PX[preset], cellHeight: (preset === "small" ? 12 : 22) + TILE_IMAGE_PX[preset] + 4 + 37 + 2, gap: preset === "small" ? 2 : 6, gridPadding: 8 };
    } } } : {}),
  },
  pickSaveFile: async () => pickerResult === undefined ? `${DIRECTORY}/picked.png` : pickerResult,
  thumbnailData: async (path: string) => ({ ok: true, data: URL.createObjectURL(new Blob([
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="${color(path)}"/></svg>`,
  ], { type: "image/svg+xml" })) }),
};

let imageService = imageAvailability();
let imageDescriptionsHeld = false;
let imageDescriptionWaiters: Array<() => void> = [];

export const backend = {
  jobStatus: (jobId: number) => invoke<ReturnType<typeof jobSnapshot>>("jobs.status", { operationId: imageOperations.get(jobId) ?? operationIdFor(jobId) }),
  /** Connect a scenario generation to a durable job, including its publication context. */
  registerJob(name: string, jobId: number, cost?: JobCost) {
    const node = state.nodes.find((node) => node.key === state.names.get(name));
    if (!node || node.runId === null) throw new Error("Generation missing");
    imageJobs.set(jobId, node.key);
    imageOperations.set(jobId, operationIdFor(jobId));
    imageRuns.set(node.runId, { operation: "openai.image.generate", parameters: { prompt: node.prompt, output_storage: node.temporary ? "temporary" : "saved", save_directory_hint: DIRECTORY }, directory: DIRECTORY, filename: `${name}.png` });
    if (cost) billing.set(node.runId, { cost });
    changed();
  },
  /** Publish an accepted job to private storage; Save later moves it to the hint folder. */
  completeJob(jobId: number) {
    const key = imageJobs.get(jobId);
    const node = state.nodes.find((node) => node.key === key);
    const run = node?.runId === null || node?.runId === undefined ? undefined : imageRuns.get(node.runId);
    if (!node || !run || node.state !== "running") throw new Error("Job is not running");
    update(node.key, { artifactId: ++counter, order: counter, path: `${TEMP}/generation-${node.runId}/${run.filename}`, location: "Unsaved", state: "present" });
    changed();
    return node.key;
  },
  /** Changes availability/revision evidence, as the real folder index reports it. */
  setNodeStatus(name: string, patch: Pick<Partial<TraceNode>, "state" | "earlierRevision">) { update(state.names.get(name)!, patch); changed(); },
  holdImageDescriptions() { imageDescriptionsHeld = true; },
  releaseImageDescriptions() { imageDescriptionsHeld = false; for (const resolve of imageDescriptionWaiters) resolve(); imageDescriptionWaiters = []; },
  imageService: () => structuredClone(imageService),
  setImageService(value: typeof imageService) { imageService = structuredClone(value); },
  configureImages() { const next = imageAvailability(); next.description!.configurationRevision = 2; next.description!.defaultConnectionId = "custom-http"; next.description!.profiles = next.description!.profiles.map((p) => p.id === "custom-http" ? { ...p, recipeRevision: "configured-revision" } : p); imageService = next; },
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
      state: "running", temporary: true, contextDirectory: DIRECTORY, discarded: false, earlierRevision: false, order: 1_000_000_000_000 + counter, prompt: `${name} prompt`,
    }] };
    changed();
    return key;
  },
  /** Starts a generation from several parents: an AI edit with several inputs, which merges their components. */
  joinGeneration(parents: string[], name: string) {
    counter += 1;
    const key = `o:${counter}:0`;
    state.names.set(name, key);
    state = { ...state, nodes: [...state.nodes, {
      key, artifactId: null, runId: counter, parents: parents.map((parent) => state.names.get(parent)!), path: null, scope: "current", location: "Generating",
      state: "running", temporary: true, contextDirectory: DIRECTORY, discarded: false, earlierRevision: false, order: 1_000_000_000_000 + counter, prompt: `${name} prompt`,
    }] };
    changed();
    return key;
  },
  /** Saves an unsaved output into the folder, as its Save action would. */
  saveGeneration(name: string) {
    update(state.names.get(name)!, { temporary: false, path: `${DIRECTORY}/${name}.png`, location: `./${name}.png`, scope: "current" });
    changed();
  },
  /** Discards an unsaved output, as its Delete action would; it is then displayed only as a parent. */
  discardGeneration(name: string) {
    update(state.names.get(name)!, { discarded: true });
    changed();
  },
  /** The provider outcome becomes unknown: the placeholder shows as Interrupted. */
  interruptGeneration(name: string, dismissable = true) {
    update(state.names.get(name)!, { state: "uncertain", dismissable });
    changed();
  },
  /** Recovery resets an uncertain run to running while it publishes. */
  resumeGeneration(name: string) {
    update(state.names.get(name)!, { state: "running", dismissable: false });
    changed();
  },
  /** Fails a generation before any output: the backend shows no placeholder for a failed run. */
  failGeneration(name: string) {
    const key = state.names.get(name)!;
    state = { ...state, nodes: state.nodes.filter((node) => node.key !== key) };
    changed();
  },
  completeGeneration(name: string) {
    const key = state.names.get(name)!;
    counter += 1;
    update(key, { artifactId: counter, order: counter, path: `${TEMP}/${name}.png`, location: "Unsaved", state: "present" });
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
  /** The next `count` reads of AI edit inputs fail. */
  failInputs(count: number) { inputFailures = count; },
  /** Mock filesystem links; inspection traverses them before interpreting parent segments. */
  symlinkInput(path: string, target: string) { inputSymlinks.set(path, target); },
  holdSaves() { holdSaves = true; },
  /** Answers run details, revision status and per-image traces after `ms`. */
  setPreviewLatency(ms: number) { previewLatency = ms; },
  setFolderLatency(ms: number) { folderLatency = ms; },
  /** The node stops being an input of `child` (a refresh that drops the reference). */
  dropInput(child: string, parent: string) { const parentKey = state.names.get(parent)!; update(state.names.get(child)!, { parents: state.nodes.find((node) => node.key === state.names.get(child))!.parents.filter((key) => key !== parentKey) }); changed(); },
  addInput(child: string, parent: string) { const node = state.nodes.find((candidate) => candidate.key === state.names.get(child))!; update(node.key, { parents: [...node.parents, state.names.get(parent)!] }); changed(); },
  failNodeReads(count: number) { nodeReadFailures = count; },
  holdFolderReads() { folderReadsHeld = true; },
  releaseFolderReads() { folderReadsHeld = false; const pending = heldFolderReads; heldFolderReads = []; pending.forEach((release) => release()); },
  releaseSaves() { holdSaves = false; const pending = heldSaves; heldSaves = []; pending.forEach((run) => run()); },
  reset() { nodeReadFailures = 0; previewLatency = 0; folderLatency = 0; pickerResult = undefined; nextSaveFailure = null; inputFailures = 0; inputSymlinks.clear(); imageRuns.clear(); imageJobs.clear(); imageOperations.clear(); billing.clear(); state = scenario(); version += 1; calls.length = 0; },
};
