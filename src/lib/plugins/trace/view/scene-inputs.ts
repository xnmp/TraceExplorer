/**
 * Pure adapters from what a Trace pane holds (host listing, intent, the session's complete
 * component data) to the folder layout engine's input and the scene builder's provenance
 * (docs/scene-transactions.md §4). No Svelte, IO or timers: the scene controller calls these
 * on captured, immutable values.
 */
import type { FileEntry } from "$lib/domain/file";
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
import type { ComponentFocus } from "$lib/domain/trace-graph/scene";
import { matchesIndex, type ComponentData, type FolderIndex } from "$lib/domain/trace-graph/folder-data";
import { projectReferenceBadges, type BadgeProjection } from "$lib/domain/trace-graph/projection";
import { folderCells, folderGridGeometry, gridInnerWidth, unlistedCovers, type FolderCell, type HostGridMetrics } from "$lib/domain/trace-graph/folder-grid";
import type { TileMetrics } from "$lib/domain/trace-graph/metrics";
import type { FolderLayout, FolderLayoutInput, GraphId, OpenStack } from "$lib/domain/trace-graph/folder-layout";
import type { FolderScene, SceneGraphSource, SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { arrivingStacks, type GeometryInputs } from "$lib/domain/trace-graph/scene-change";
import { expandedKeys, expansionAnchor, sameExpansion, type Expansion } from "$lib/domain/trace-graph/expansion";
import type { BandExpansion } from "$lib/domain/trace-graph/visibility";

/** What the pane wants shown, captured from host and session state (data excluded). */
export interface SceneIntent {
  readonly directory: string;
  /** Host listing, in host order. */
  readonly listing: readonly FileEntry[];
  /** Listed paths known to belong to a stack before the index maps them (`folderCells`). */
  readonly claimed: ReadonlySet<string>;
  /** Requested open stacks by cover key (the session's open stack keys). */
  readonly open: ReadonlySet<GraphId>;
  readonly focus: ComponentFocus | null;
  /** The pane's explicit expansion (the session's): what open bands show. */
  readonly expansion: Expansion;
  readonly selectedKeys: ReadonlySet<NodeKey>;
  readonly selectedPaths: ReadonlySet<string>;
  readonly badgeHover: NodeKey | null;
  /** The pane's quantised width, grid padding included. */
  readonly width: number;
  readonly tile: TileMetrics;
  /** Host tile-grid metrics, or the fallback derived from the tile (`fallbackGridMetrics`). */
  readonly grid: HostGridMetrics;
  /** Host cover chrome (see `SceneStyling.cover`). */
  readonly cover: { readonly imagePx: number | null; readonly small: boolean };
  /** The host's selected files, Preview target and focused path: changes only through host writes. */
  readonly hostChoice: string;
}

/** The data a scene is built from: one index and complete components read under its token. */
export interface SceneData {
  readonly index: FolderIndex;
  /** Complete component data by component id; open stacks need theirs here. */
  readonly components: ReadonlyMap<string, ComponentData>;
}

const projections = new WeakMap<ComponentData, BadgeProjection>();
/** The component's reference-badge projection, one per data object (stable identity). */
export function projectionOf(data: ComponentData): BadgeProjection {
  let known = projections.get(data);
  if (!known) projections.set(data, known = projectReferenceBadges(data.dag));
  return known;
}

/** Whether `focus` belongs to a stack's graph: a member, or a reference badge's key. */
export const focusBelongs = (graph: BadgeProjection, focus: NodeKey | null): boolean =>
  focus !== null && (graph.dag.nodes.has(focus) || graph.badges.has(focus));

/** The open stack for a cover: its expanded keys and anchor, from the pane's expansion (never the selection). */
export function openStackOf(id: GraphId, data: ComponentData, expansion: Expansion): OpenStack {
  const graph = projectionOf(data), members = graph.dag.order, scope = { graph, members, cover: id };
  return { id, graph, members, anchor: expansionAnchor(expansion, scope), expanded: expandedKeys(expansion, scope) };
}

/** Same members in any order. */
export const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => a === b || (a.size === b.size && [...a].every((value) => b.has(value)));

const sameEntry = (a: FileEntry, b: FileEntry) => a === b || (a.path === b.path && a.name === b.name && a.kind === b.kind && a.size === b.size && a.modified === b.modified);
/** Same entries in the same order (contents, not object identity). */
export const sameListing = (a: readonly FileEntry[], b: readonly FileEntry[]): boolean =>
  a === b || (a.length === b.length && a.every((entry, index) => sameEntry(entry, b[index])));

const sameFocus = (a: ComponentFocus | null, b: ComponentFocus | null) => a === b || (!!a && !!b && a.key === b.key && a.componentId === b.componentId);
/** Same width, tile, grid and cover metrics: a scene laid out for one fits the other. */
export const sameGeometry = (a: SceneIntent, b: SceneIntent): boolean => a.width === b.width && a.tile.width === b.tile.width && a.tile.image === b.tile.image
  && a.grid.cellWidth === b.grid.cellWidth && a.grid.cellHeight === b.grid.cellHeight && a.grid.gap === b.grid.gap && a.grid.gridPadding === b.grid.gridPadding
  && a.cover.imagePx === b.cover.imagePx && a.cover.small === b.cover.small;

/** What changed between two intents, by kind (contents compared, never object identity). */
export interface IntentChange {
  readonly directory: boolean;
  readonly hostChoice: boolean;
  readonly listing: boolean;
  /** Width only. */
  readonly resize: boolean;
  /** Tile, grid or cover metrics. */
  readonly metrics: boolean;
  /** Open set, expansion, focus, selection, claimed paths or badge hover. */
  readonly other: boolean;
}
export function intentChange(before: SceneIntent | null, after: SceneIntent): IntentChange {
  if (!before) return { directory: true, hostChoice: true, listing: true, resize: true, metrics: true, other: true };
  const metrics = !sameGeometry({ ...before, width: 0 }, { ...after, width: 0 });
  return {
    directory: before.directory !== after.directory,
    hostChoice: before.hostChoice !== after.hostChoice,
    listing: !sameListing(before.listing, after.listing),
    resize: before.width !== after.width,
    metrics,
    other: !sameSet(before.open, after.open) || !sameExpansion(before.expansion, after.expansion) || !sameFocus(before.focus, after.focus) || !sameSet(before.selectedKeys, after.selectedKeys)
      || !sameSet(before.selectedPaths, after.selectedPaths) || !sameSet(before.claimed, after.claimed) || before.badgeHover !== after.badgeHover,
  };
}
export const changed = (change: IntentChange): boolean => Object.values(change).some(Boolean);

/** A stack's cover key, resolved against an index by its stable key: a cover's own, or the stack now holding that revision. */
export function resolveCover(index: FolderIndex, key: string): GraphId | null {
  if (index.components.some((summary) => summary.coverKey === key)) return key;
  for (const member of index.members.values()) if (member.key === key) {
    const summary = index.components.find((candidate) => candidate.id === member.componentId);
    if (summary) return summary.coverKey;
  }
  return null;
}

/** Component ids of the requested open stacks that are grid items, by cover key, excluding `blocked`. */
export function requiredComponents(cells: readonly FolderCell[], open: ReadonlySet<GraphId>, blocked: ReadonlySet<GraphId>): ReadonlyMap<GraphId, string> {
  return new Map(cells.flatMap((cell) => cell.kind === "stack" && cell.summary && open.has(cell.id) && !blocked.has(cell.id) ? [[cell.id, cell.summary.id] as const] : []));
}

/** Whether `data` is complete, current data for `index`. */
export const fresh = (data: ComponentData | undefined, index: FolderIndex, stale: (id: string) => boolean, id: string): data is ComponentData =>
  !!data && !stale(id) && matchesIndex(data, index);

/**
 * Grid items for a listing, with the held history (`folderCells`): stacks unsaved since the grid was
 * last laid out afresh keep their place. `kept` is the committed history when the folder and column
 * count are unchanged, otherwise empty.
 */
export function folderItems(listing: readonly FileEntry[], index: FolderIndex, claimed: ReadonlySet<string>, kept: ReadonlySet<string>): { readonly cells: readonly FolderCell[]; readonly held: ReadonlySet<string> } {
  const first = folderCells(listing, index, kept, claimed);
  const held = new Set([...kept, ...unlistedCovers(first, kept)]);
  return { cells: sameSet(held, kept) ? first : folderCells(listing, index, held, claimed), held };
}

/** Held history carried into the next layout: kept only for the same folder and column count. */
export interface HeldHistory { readonly directory: string; readonly columns: number; readonly held: ReadonlySet<string> }

export interface PreparedLayoutInput {
  readonly input: FolderLayoutInput;
  readonly cells: readonly FolderCell[];
  readonly history: HeldHistory;
  /** Provenance of every open stack, for the scene and the motion classifier. */
  readonly sources: ReadonlyMap<GraphId, SceneGraphSource>;
  /** Loaded cover nodes for stacks shown closed. */
  readonly coverNodes: ReadonlyMap<GraphId, TraceNode>;
  /** Compact identity of everything the engine reads except `previous` (see `layoutBasis`). */
  readonly basis: string;
}

/**
 * The complete engine input for an intent and coherent data. Open stacks whose data is not in
 * `data.components` are laid out closed; callers include only stacks they have complete data for.
 * `loaded` supplies cover nodes for closed stacks (any loaded copy of the cover's node).
 */
export function prepareLayoutInput(intent: SceneIntent, data: SceneData, open: ReadonlyMap<GraphId, string>, history: HeldHistory | null,
  previous: FolderLayout | null, loaded: ReadonlyMap<string, ComponentData> = data.components): PreparedLayoutInput {
  const width = gridInnerWidth(intent.width, intent.grid.gridPadding);
  const grid = { cellWidth: intent.grid.cellWidth, cellHeight: intent.grid.cellHeight, gap: intent.grid.gap };
  const { columns } = folderGridGeometry(width, intent.tile, grid);
  const kept = history && history.directory === data.index.directory && history.columns === columns ? history.held : new Set<string>();
  const { cells, held } = folderItems(intent.listing, data.index, intent.claimed, kept);
  const stacks = new Map<GraphId, OpenStack>(), sources = new Map<GraphId, SceneGraphSource>(), versions: StackBasis[] = [];
  for (const [id, componentId] of open) {
    const component = data.components.get(componentId);
    if (!component) continue;
    const stack = openStackOf(id, component, intent.expansion);
    stacks.set(id, stack);
    sources.set(id, { componentId, revision: component.version, data: component.dag });
    versions.push([id, component.version, stack.anchor, expandedSignature(stack.expanded)]);
  }
  const coverNodes = new Map<GraphId, TraceNode>();
  for (const cell of cells) if (cell.kind === "stack" && cell.summary && !stacks.has(cell.id)) {
    const node = loaded.get(cell.summary.id)?.dag.nodes.get(cell.id);
    if (node) coverNodes.set(cell.id, node);
  }
  const input: FolderLayoutInput = { items: cells, open: stacks, width, tile: intent.tile, grid, previous, dataRevision: data.index.token,
    folderKey: data.index.directory,
    contents: JSON.stringify([intent.listing.map(e => [e.path, e.kind, e.size, e.modified]),
      data.index.components.map(c => [c.id, c.coverKey, c.imageCount, c.nodeCount]), [...data.index.members]]) };
  return { input, cells, history: { directory: data.index.directory, columns, held }, sources, coverNodes, basis: layoutBasis(input, versions) };
}

/** An open stack's part of the layout basis: its id, data version, anchor and expanded keys (`expandedSignature`). */
export type StackBasis = readonly [GraphId, number, NodeKey | null, string];

/** A stack's expansion as one string. Its order is part of it: the latest entry decides, and the carets read it. */
export const expandedSignature = (expanded: BandExpansion): string => JSON.stringify([...expanded]);

/**
 * Everything the engine reads apart from `previous`: item identities, each open stack's data
 * version, anchor and expanded keys (never the selection), width, tile and grid. Equal bases lay out alike, so the
 * committed layout is reused instead of asking the engine again with a new history
 * (docs/scene-transactions.md §4).
 */
export function layoutBasis(input: FolderLayoutInput, versions: readonly StackBasis[]): string {
  return JSON.stringify([input.items.map((item) => [item.id, item.kind]), [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    input.width, input.tile.width, input.tile.image, input.grid.cellWidth, input.grid.cellHeight, input.grid.gap, input.dataRevision, input.folderKey, input.contents]);
}

/** Same styling by contents: renderers read some of it directly (reference badges' selection), not only through records. */
export const sameStyling = (a: SceneStyling, b: SceneStyling): boolean => a === b || (a.focus === b.focus && a.badgeHover === b.badgeHover
  && sameSet(a.selectedKeys, b.selectedKeys) && sameSet(a.selectedPaths, b.selectedPaths)
  && (a.cover === b.cover || (!!a.cover && !!b.cover && a.cover.imagePx === b.cover.imagePx && a.cover.small === b.cover.small)));

/** Styling for a scene: what restyles without moving anything. */
export const stylingOf = (intent: SceneIntent): SceneStyling => ({
  focus: intent.focus?.key ?? null, selectedKeys: intent.selectedKeys, selectedPaths: intent.selectedPaths, badgeHover: intent.badgeHover, cover: intent.cover,
});

/**
 * What a committed scene was laid out from, for the motion policy (`geometryMotion`): its layout
 * input, the intent and index token it was committed with. `previous` is what the scene on screen
 * was laid out from (null on arriving) and `failed` the requested stacks that failed, to carry the
 * arrival's pending stacks (`arrivingStacks`). `current` is false for a saved scene shown as it was
 * laid out until the pane's own layout commits.
 */
export function geometryInputsOf(scene: FolderScene, intent: SceneIntent, token: string, failed: ReadonlySet<GraphId>, current: boolean, previous: GeometryInputs | null): GeometryInputs {
  const input = scene.inputs.layoutInput, open = scene.inputs.sources;
  return {
    current, width: input.width, padding: intent.grid.gridPadding, tile: input.tile, grid: input.grid,
    items: input.items.map((item) => `${item.kind}\0${item.id}`), token, open, requested: intent.open,
    arriving: arrivingStacks(previous, intent.open, open, failed), focus: intent.focus?.key ?? null,
    expanded: new Map([...input.open].map(([id, stack]) => [id, expandedSignature(stack.expanded)])),
  };
}
