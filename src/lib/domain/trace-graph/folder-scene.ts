/**
 * The drawable folder scene and the diff between two of them (docs/scene-transactions.md §2, §3,
 * as amended: geometry comes from one `FolderLayoutEngine` output). Pure: no Svelte, IO or timers.
 *
 * `buildFolderScene` flattens a `FolderLayout` into keyed records in folder coordinates (cells,
 * covers, band tiles, connectors, junctions, band and row backgrounds) and styles them from the
 * focus, selection and badge hover. Styling never moves a rectangle: two scenes from one layout
 * differ only in payload. Connector bounds are computed from path data, never measured.
 *
 * `diffScenes` matches records by identity across complete scenes (offscreen ones included) and
 * says how each one presents: `snap`, `animate` or `carry` (geometry unchanged).
 */
import type { FileEntry } from "../file";
import type { NodeKey, TraceNode } from "./model";
import type { ReferenceBadge } from "./projection";
import type { GridBand, GridRect } from "./grid-flow";
import type { Orientation, PlacedJunction, PlacedNode, PlacedRoute } from "./layout";
import { tileSize, type TileMetrics } from "./metrics";
import { bandFocus, junctionRelated, routeStyle, type RouteStyle, type SceneTile } from "./scene";
import { toneOf } from "./lineage";
import { classifySceneChange, type CommittedGraph, type SceneChange } from "./scene-change";
import { coverNode, folderGridGeometry, type FolderCell, type FolderGridGeometry } from "./folder-grid";
import { mapPathNumbers } from "./path-data";
import { routeBounds } from "./folder-layout/route-bounds";
import { composeFolderLayout, type PlannedBand } from "./folder-layout/default-engine";
import type { FolderGraph, FolderLayout, FolderLayoutInput, GraphId, OpenStack } from "./folder-layout/types";

export type { GraphId };
export type EntityId = string;

/** A record's identity: `JSON.stringify([kind, graphId, localId])`. Component ids never form one. */
export const entityId = (kind: SceneRecord["kind"] | "edge", graphId: GraphId | null, localId: string): EntityId => JSON.stringify([kind, graphId, localId]);

/** A pane lifetime showing one folder; a scene from another scope is never diffed against. */
export interface SceneScope {
  readonly paneId: string;
  readonly directory: string;
  /** Pane lifetime, not backend revision. */
  readonly generation: number;
}

/** Inputs that restyle a scene without moving anything. */
export interface SceneStyling {
  readonly focus: NodeKey | null;
  readonly selectedKeys: ReadonlySet<NodeKey>;
  readonly selectedPaths: ReadonlySet<string>;
  readonly badgeHover: NodeKey | null;
  /** Host cover chrome (`pane.tileSize`): image size with a host tile renderer, else null; the small preset. */
  readonly cover?: { readonly imagePx: number | null; readonly small: boolean };
}

/** Provenance of an open graph's data, for the motion classifier. */
export interface SceneGraphSource {
  readonly componentId: string;
  /** `ComponentData.version`. */
  readonly revision: number;
  /** Identity of the complete component DAG (`ComponentData.dag`). */
  readonly data: object;
}

export interface FolderSceneInput {
  readonly scope: SceneScope;
  /** The engine input the layout was computed from; its items must be `FolderCell`s. */
  readonly layoutInput: FolderLayoutInput;
  readonly layout: FolderLayout;
  readonly sources: ReadonlyMap<GraphId, SceneGraphSource>;
  readonly styling: SceneStyling;
  /** Loaded nodes for closed covers; others show the index's cover (`coverNode`). */
  readonly coverNodes?: ReadonlyMap<GraphId, TraceNode>;
}

export interface CoverDecoration {
  readonly name: string;
  readonly count: number;
  readonly unsaved: boolean;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly imagePx: number | null;
  readonly small: boolean;
}

interface RecordBase {
  readonly id: EntityId;
  readonly graphId: GraphId | null;
  /** Folder coordinates (inside the grid padding). */
  readonly rect: GridRect;
}
export type TileRecord = RecordBase & {
  readonly kind: "tile";
  readonly tile: SceneTile;
  /** As the tile renders it: band-relative for band tiles, cell-relative for covers. */
  readonly placed: PlacedNode;
  readonly badges: readonly ReferenceBadge[];
  readonly selected: boolean;
  readonly cover: CoverDecoration | null;
  /** How its band draws it (a sideways band's chevron); absent for covers, which draw "down". */
  readonly orientation?: Orientation;
};
export type EntryRecord = RecordBase & { readonly kind: "entry"; readonly entry: FileEntry; readonly selected: boolean };
/** `route.path` is in folder coordinates; `rect` is its padded control-point bounds. */
export type RouteRecord = RecordBase & { readonly kind: "route"; readonly route: PlacedRoute; readonly style: RouteStyle };
export type JunctionRecord = RecordBase & { readonly kind: "junction"; readonly junction: PlacedJunction; readonly highlighted: boolean };
export type BandRecord = RecordBase & { readonly kind: "band"; readonly band: GridBand };
export type RowRecord = RecordBase & { readonly kind: "row"; readonly band: GridBand };
export type SceneRecord = TileRecord | EntryRecord | RouteRecord | JunctionRecord | BandRecord | RowRecord;

/** One drawn parent→child relationship (a reference badge's included). */
export interface SceneEdge {
  readonly id: EntityId;
  readonly graphId: GraphId;
  readonly parent: NodeKey;
  readonly child: NodeKey;
  readonly badge: boolean;
}

/** An open graph as the motion classifier sees it (`layout` is the raw layout). */
export interface FolderSceneGraph extends FolderGraph, Omit<CommittedGraph, "plan" | "layout"> {}

export interface FolderScene {
  readonly scope: SceneScope;
  /** What the scene was built from, without the engine's previous layout (scenes never chain). */
  readonly inputs: Omit<FolderSceneInput, "layout">;
  readonly layout: FolderLayout;
  readonly columns: number;
  readonly bounds: GridRect;
  readonly tile: TileMetrics;
  /** Cell size and gap the layout was packed with (a counterfactual repacks with them). */
  readonly geometry: FolderGridGeometry;
  readonly cells: readonly FolderCell[];
  readonly graphs: ReadonlyMap<GraphId, FolderSceneGraph>;
  readonly records: ReadonlyMap<EntityId, SceneRecord>;
  readonly tiles: ReadonlyMap<EntityId, TileRecord>;
  readonly routes: ReadonlyMap<EntityId, RouteRecord>;
  /** Ordinary files and folders, by path. */
  readonly entries: ReadonlyMap<string, EntryRecord>;
  readonly edges: ReadonlyMap<EntityId, SceneEdge>;
  /** Keyboard navigation targets by key (cell id or node key), including unmounted tiles. */
  readonly navigation: ReadonlyMap<string, GridRect>;
}

/** The rendered junction dot's radius. */
export const JUNCTION_RADIUS = 2.8;

const finite = (...values: number[]) => values.every(Number.isFinite);
function checkedRect(rect: GridRect, what: string, positive = false): GridRect {
  if (!finite(rect.x, rect.y, rect.width, rect.height) || rect.width < 0 || rect.height < 0 || (positive && (rect.width <= 0 || rect.height <= 0)))
    throw new RangeError(`invalid dimensions: ${what}`);
  return rect;
}
/** The members the engine plans with: keys of the graph (repeats are harmless here). */
const drawable = (stack: OpenStack): readonly NodeKey[] => stack.members.filter((key) => stack.graph.dag.nodes.has(key));
const rectOf = (r: GridRect): GridRect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/**
 * The scene for a layout. Throws RangeError when the layout does not match its input (cells
 * other than the items, a graph that is not an open stack, an open stack with a drawable cover
 * but no graph, a missing source, a planned tile the layout does not place), for duplicate
 * items or routes, and for non-finite or negative dimensions.
 */
export function buildFolderScene(input: FolderSceneInput): FolderScene {
  const { layout, layoutInput, styling, scope } = input;
  const cells = layoutInput.items as readonly FolderCell[];
  const tile = layoutInput.tile;
  const geometry = folderGridGeometry(layoutInput.width, tile, layoutInput.grid);
  if (layout.columns !== geometry.columns) throw new RangeError("layout columns do not match its input");
  const ids = new Set<string>();
  for (const cell of cells) { if (ids.has(cell.id)) throw new RangeError(`duplicate grid item: ${cell.id}`); ids.add(cell.id); }
  if (layout.cells.size !== cells.length || cells.some((cell) => !layout.cells.has(cell.id))) throw new RangeError("layout cells do not match the items");
  for (const [id, graph] of layout.graphs) {
    if (!ids.has(id) || !layoutInput.open.has(id)) throw new RangeError(`layout graph is not an open stack: ${id}`);
    if (!input.sources.has(id)) throw new RangeError(`missing source for graph: ${id}`);
    if (graph.id !== id) throw new RangeError(`graph id mismatch: ${id}`);
  }
  for (const cell of cells) {
    const stack = cell.kind === "stack" ? layoutInput.open.get(cell.id) : undefined;
    if (stack && stack.members.includes(cell.id) && stack.graph.dag.nodes.has(cell.id) && !layout.graphs.has(cell.id)) throw new RangeError(`missing layout for open stack: ${cell.id}`);
  }

  const records = new Map<EntityId, SceneRecord>(), tiles = new Map<EntityId, TileRecord>(), routes = new Map<EntityId, RouteRecord>();
  const entries = new Map<string, EntryRecord>(), edges = new Map<EntityId, SceneEdge>(), navigation = new Map<string, GridRect>();
  const add = <R extends SceneRecord>(record: R): R => {
    if (records.has(record.id)) throw new RangeError(`duplicate scene record: ${record.id}`);
    records.set(record.id, record);
    return record;
  };
  const coverSize = tileSize({ foreign: false, hint: true }, tile);
  const chrome = styling.cover ?? { imagePx: null, small: false };
  const graphs = new Map<GraphId, FolderSceneGraph>();

  for (const graph of layout.graphs.values()) {
    const source = input.sources.get(graph.id)!;
    graphs.set(graph.id, { ...graph, data: source.data, componentId: source.componentId, revision: source.revision, tile });
  }

  // Cells: ordinary entries and covers, in input order.
  for (const cell of cells) {
    const rect = checkedRect(rectOf(layout.cells.get(cell.id)!), `cell ${cell.id}`, true);
    navigation.set(cell.id, { x: rect.x + (rect.width - tile.width) / 2, y: rect.y, width: tile.width, height: rect.height });
    if (cell.kind !== "stack") {
      if (!cell.entry) throw new RangeError(`entry cell without an entry: ${cell.id}`);
      const record = add<EntryRecord>({ kind: "entry", id: entityId("entry", null, cell.entry.path), graphId: null, rect, entry: cell.entry, selected: styling.selectedPaths.has(cell.entry.path) });
      entries.set(cell.entry.path, record);
      continue;
    }
    const graph = graphs.get(cell.id), stack = graph ? layoutInput.open.get(cell.id)! : undefined;
    const lineage = stack ? bandFocus(stack.graph, drawable(stack), styling.focus, styling.badgeHover).lineage : null;
    const planned = graph?.plan.tiles.get(cell.id);
    const node = stack?.graph.dag.nodes.get(cell.id) ?? input.coverNodes?.get(cell.id) ?? coverNode({ ...cell, coverKey: cell.coverKey ?? cell.id });
    const sceneTile: SceneTile = planned && lineage ? { ...planned, node, tone: toneOf(lineage, cell.id) }
      : { key: cell.id, node, tone: styling.focus === cell.id ? "focus" : styling.focus !== null ? "unrelated" : "neutral", size: coverSize, childCount: 0, hiddenDescendants: 0, expandable: false, expanded: false };
    const summary = cell.summary;
    const placed: PlacedNode = { key: cell.id, x: (rect.width - tile.width) / 2, y: 0, width: tile.width, height: rect.height, row: 0, band: 0 };
    tiles.set(entityId("tile", cell.id, cell.id), add<TileRecord>({ kind: "tile", id: entityId("tile", cell.id, cell.id), graphId: cell.id,
      rect: { x: rect.x + placed.x, y: rect.y, width: tile.width, height: rect.height }, tile: sceneTile, placed,
      badges: graph ? graph.plan.badges.get(cell.id) ?? [] : [], selected: styling.selectedKeys.has(cell.id),
      cover: { name: cell.entry?.name ?? summary?.title ?? cell.id, count: summary?.imageCount ?? 0, unsaved: summary?.unsaved ?? false, active: summary?.active ?? false,
        expanded: !!graph, imagePx: chrome.imagePx, small: chrome.small } }));
  }

  // Open graphs: band tiles, connectors, junctions and semantic edges, in folder coordinates.
  for (const graph of graphs.values()) {
    const stack = layoutInput.open.get(graph.id)!, { attached, plan } = graph, { x: dx, y: dy } = graph.origin;
    if (!finite(dx, dy)) throw new RangeError(`invalid dimensions: origin of ${graph.id}`);
    const lineage = bandFocus(stack.graph, drawable(stack), styling.focus, styling.badgeHover).lineage;
    for (const [key, planned] of plan.tiles) {
      const placed = attached.nodes.get(key);
      if (!placed) throw new RangeError(`planned tile not placed: ${graph.id}/${key}`);
      checkedRect(placed, `tile ${graph.id}/${key}`, true);
      for (const parent of stack.graph.dag.parents.get(key) ?? []) if (plan.tiles.has(parent)) {
        const id = entityId("edge", graph.id, JSON.stringify([parent, key]));
        edges.set(id, { id, graphId: graph.id, parent, child: key, badge: false });
      }
      for (const badge of plan.badges.get(key) ?? []) {
        const id = entityId("edge", graph.id, JSON.stringify([badge.key, key]));
        edges.set(id, { id, graphId: graph.id, parent: badge.key, child: key, badge: true });
      }
      if (key === graph.id) continue; // The cover is its cell.
      const rect = { x: placed.x + dx, y: placed.y + dy, width: placed.width, height: placed.height };
      navigation.set(key, rect);
      const id = entityId("tile", graph.id, key);
      tiles.set(id, add<TileRecord>({ kind: "tile", id, graphId: graph.id, rect, tile: { ...planned, tone: toneOf(lineage, key) }, placed,
        badges: plan.badges.get(key) ?? [], selected: styling.selectedKeys.has(key), cover: null, orientation: graph.layout.orientation }));
    }
    for (const route of attached.routes) {
      const path = dx === 0 && dy === 0 ? route.path : mapPathNumbers(route.path, (value, index) => value + (index % 2 ? dy : dx));
      const rect = routeBounds(path) ?? { x: dx, y: dy, width: 0, height: 0 };
      const id = entityId("route", graph.id, route.id);
      routes.set(id, add<RouteRecord>({ kind: "route", id, graphId: graph.id, rect: checkedRect(rect, `route ${graph.id}/${route.id}`),
        route: { ...route, path }, style: routeStyle(route, stack.graph.dag, lineage) }));
    }
    for (const junction of attached.junctions.values()) {
      const x = junction.x + dx, y = junction.y + dy;
      add<JunctionRecord>({ kind: "junction", id: entityId("junction", graph.id, junction.id), graphId: graph.id,
        rect: checkedRect({ x: x - JUNCTION_RADIUS, y: y - JUNCTION_RADIUS, width: 2 * JUNCTION_RADIUS, height: 2 * JUNCTION_RADIUS }, `junction ${graph.id}/${junction.id}`),
        junction: { ...junction, x, y }, highlighted: junctionRelated(junction.parents, lineage) });
    }
  }
  for (const band of layout.bands) add<BandRecord>({ kind: "band", id: entityId("band", band.id, band.id), graphId: band.id, rect: checkedRect(rectOf(band), `band ${band.id}`), band });
  for (const row of layout.rowBands) add<RowRecord>({ kind: "row", id: entityId("row", null, String(row.row)), graphId: null, rect: checkedRect(rectOf(row), `row ${row.row}`), band: row });
  checkedRect(layout.bounds, "bounds");

  const inputs = { scope, layoutInput: { ...layoutInput, previous: null }, sources: input.sources, styling, coverNodes: input.coverNodes };
  return { scope, inputs, layout, columns: layout.columns, bounds: layout.bounds, tile, geometry, cells, graphs, records, tiles, routes, entries, edges, navigation };
}

// ─── Diff ────────────────────────────────────────────────────────────────────

export type RecordPolicy = "snap" | "animate" | "carry";
export interface SceneDiff {
  readonly enter: ReadonlyMap<EntityId, SceneRecord>;
  /** Retained records whose geometry or payload changed. */
  readonly update: ReadonlyMap<EntityId, { readonly before: SceneRecord; readonly after: SceneRecord }>;
  readonly exit: ReadonlyMap<EntityId, SceneRecord>;
  readonly policy: {
    /** Scope change or first publication: present the next scene as is. */
    readonly reset: boolean;
    /** Raw plan/layout classification per graph; added and removed graphs reflow. */
    readonly graphs: ReadonlyMap<GraphId, SceneChange>;
    /** For every next record and every exiting one. */
    readonly records: ReadonlyMap<EntityId, RecordPolicy>;
  };
}

const sameScope = (a: SceneScope, b: SceneScope) => a.paneId === b.paneId && a.directory === b.directory && a.generation === b.generation;

/** The numbers that place a record; equal keys mean nothing moved or reshaped. */
function geometryOf(record: SceneRecord): string {
  const { x, y, width, height } = record.rect, rect = `${x},${y},${width},${height}`;
  switch (record.kind) {
    case "tile": return `${rect}|${record.placed.x},${record.placed.y},${record.placed.width},${record.placed.height}`;
    case "route": return `${rect}|${record.route.path}`;
    case "junction": return `${rect}|${record.junction.x},${record.junction.y}`;
    default: return rect;
  }
}

/** Structural equality over plain data, maps and sets (NaN equals NaN). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length) return false;
  return left.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Record geometry of the scene the next one would be had every `reveal` graph kept its previous
 * band: next cells, metrics and other graphs, with each reveal graph's previous plan and raw
 * layout, packed and attached as the default engine does. Null when that cannot be composed.
 */
function counterfactual(previous: FolderScene, next: FolderScene, reveal: ReadonlySet<GraphId>): ReadonlyMap<EntityId, SceneRecord> | null {
  const bands = new Map<GraphId, PlannedBand>([...next.graphs].map(([id, graph]) => {
    const kept = reveal.has(id) ? previous.graphs.get(id)! : graph;
    return [id, { plan: kept.plan, layout: kept.layout }];
  }));
  try {
    const layout = composeFolderLayout(next.cells, next.geometry, bands);
    return buildFolderScene({ ...next.inputs, layout }).records;
  } catch {
    return null;
  }
}

export function diffScenes(previous: FolderScene | null, next: FolderScene): SceneDiff {
  const enter = new Map<EntityId, SceneRecord>(), exit = new Map<EntityId, SceneRecord>();
  const update = new Map<EntityId, { readonly before: SceneRecord; readonly after: SceneRecord }>();
  const graphs = new Map<GraphId, SceneChange>(), records = new Map<EntityId, RecordPolicy>();
  if (!previous || !sameScope(previous.scope, next.scope)) {
    for (const [id, record] of next.records) { enter.set(id, record); records.set(id, "snap"); }
    for (const [id, record] of previous?.records ?? []) if (!next.records.has(id)) { exit.set(id, record); records.set(id, "snap"); }
    for (const id of next.graphs.keys()) graphs.set(id, "reflow");
    return { enter, update, exit, policy: { reset: true, graphs, records } };
  }
  for (const [id, graph] of next.graphs) graphs.set(id, classifySceneChange(previous.graphs.get(id) ?? null, graph));
  for (const id of previous.graphs.keys()) if (!next.graphs.has(id)) graphs.set(id, "reflow");
  const reveal = new Set([...graphs].filter(([, change]) => change === "reveal").map(([id]) => id));
  const owned = (record: SceneRecord) => record.graphId !== null && reveal.has(record.graphId);
  let alternative: ReadonlyMap<EntityId, SceneRecord> | null | undefined;
  /** Whether the record would have stayed put had the reveals not changed their bands. */
  const displacedByReveal = (id: EntityId, before: SceneRecord): boolean => {
    if (!reveal.size) return false;
    if (alternative === undefined) alternative = counterfactual(previous, next, reveal);
    const would = alternative?.get(id);
    return !!would && geometryOf(would) === geometryOf(before);
  };
  for (const [id, after] of next.records) {
    const before = previous.records.get(id);
    if (!before) { enter.set(id, after); records.set(id, owned(after) ? "snap" : "animate"); continue; }
    if (!deepEqual(before, after)) update.set(id, { before, after });
    records.set(id, geometryOf(before) === geometryOf(after) ? "carry" : owned(after) || displacedByReveal(id, before) ? "snap" : "animate");
  }
  for (const [id, before] of previous.records) if (!next.records.has(id)) { exit.set(id, before); records.set(id, owned(before) ? "snap" : "animate"); }
  return { enter, update, exit, policy: { reset: false, graphs, records } };
}
