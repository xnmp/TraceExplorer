/**
 * The default folder layout: exactly the geometry the Trace view composed before the seam
 * existed (StackGrid + TraceGraph), as one pure function.
 *
 * 1. Columns and cell size from the width, tile and grid metrics (`folderGridGeometry`).
 * 2. Each open stack is planned (`planBandScene`, pinned at its cover's column by `gridPins`,
 *    with the previous committed layout's history and reading order) and laid out
 *    (`layoutGraph`). Every open band is laid out before packing: no estimate or placeholder.
 * 3. The rows are packed once with the exact band extents (`packedGridFlow`, `bandExtent`),
 *    and every band is attached below its cover (`bandPlacements`, `attachPackedBand`).
 *
 * Inputs are checked, not trusted:
 * - a non-finite width or metric, a non-positive tile, negative grid metrics, duplicate item ids
 *   or overflowing geometry throw RangeError; a negative width counts as zero (one column);
 * - a stack's `expanded` that is not a Set counts as only its cover; non-string keys are ignored;
 * - open ids that are not stack items, and stacks whose cover is not a drawable member of their
 *   graph, are laid out closed; member keys missing from the graph and repeated keys are dropped;
 * - `previous` is a hint: a malformed graph in it contributes nothing, and one from another width
 *   or tile size contributes only its reading order (its history no longer matches the request).
 *
 * Output is plain data, never mutated afterwards; treat it as readonly (it may share objects
 * with earlier outputs, the band cache and `previous`).
 */
import type { NodeKey } from "../model";
import { gridFlow, type GridItem, type GridMetrics, type GridRect } from "../grid-flow";
import { attachPackedBand, bandExtent, bandPlacements, packedGridFlow } from "../band-geometry";
import { bandHistorySignature } from "../band-layout";
import { folderGridGeometry, gridPins, type FolderGridGeometry } from "../folder-grid";
import { layoutGraph, type BandHistory, type GraphLayout, type LayoutRequest } from "../layout";
import { layoutSignature } from "../layout-signature";
import { planBandScene, type BandScenePlan } from "../scene";
import { createBoundedCache, estimateLayoutBytes, type BoundedCache } from "./bounded-cache";
import { routeBounds, unionRect } from "./route-bounds";
import type { FolderGraph, FolderLayout, FolderLayoutEngine, FolderLayoutInput, GraphId, OpenStack } from "./types";

/** One open band before packing: its plan and its raw (cover-relative) layout. */
export interface PlannedBand {
  readonly plan: BandScenePlan;
  readonly layout: GraphLayout;
}

export const gridMetricsOf = (geometry: FolderGridGeometry): GridMetrics =>
  ({ cellWidth: geometry.cellWidth, cellHeight: geometry.cellHeight, columnGap: geometry.gap, rowGap: geometry.gap });

/** What a band reads from the previous committed layout: Phase 2 history and the reading order hint. */
interface Prior {
  readonly history?: BandHistory;
  readonly hint?: ReadonlyMap<NodeKey, number>;
  /** The committed raw layout and the basis of the request it was laid out from. */
  readonly committed?: { readonly layout: GraphLayout; readonly basis: string };
}

/**
 * A band request's geometry basis: everything but the history and reading-order hint taken from
 * the committed layout. An unchanged basis keeps the committed layout: a newly committed history
 * must not itself cause another layout (docs/scene-transactions.md §4, layout economy).
 */
const requestBasis = (request: LayoutRequest): string => layoutSignature({ ...request, history: undefined, hint: undefined });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (...values: unknown[]) => values.every((value) => typeof value === "number" && Number.isFinite(value));
const isLayout = (value: unknown): value is GraphLayout => isObject(value) && value.nodes instanceof Map && value.junctions instanceof Map
  && Array.isArray(value.routes) && Array.isArray(value.rows) && value.readingOrder instanceof Map && finite(value.width, value.height);
const isOrder = (value: unknown): value is ReadonlyMap<NodeKey, number> => value instanceof Map && [...value].every(([key, order]) => typeof key === "string" && finite(order));

/** History built from a committed graph exactly as TraceGraph's `committedHistory` built it. */
function priorOf(previous: Record<string, unknown>, id: GraphId, graph: unknown): Prior {
  if (!isObject(graph) || !isLayout(graph.layout)) return {};
  const hint = isOrder(graph.layout.readingOrder) ? graph.layout.readingOrder : undefined;
  const plan = graph.plan, placement = graph.placement;
  const band = (previous.bands as unknown[]).find((candidate) => isObject(candidate) && candidate.id === id);
  const cell = (previous.cells as Map<unknown, unknown>).get(id);
  if (!isObject(plan) || !isObject(plan.request) || !isLayout(graph.attached) || !isObject(placement) || !isObject(band) || !isObject(cell)
    || !finite(band.y, cell.y, placement.x, placement.coverX, placement.coverHeight, placement.width, placement.left, placement.right)) return { hint };
  let signature: string, basis: string;
  try {
    signature = bandHistorySignature(plan.request as unknown as LayoutRequest);
    basis = requestBasis(plan.request as unknown as LayoutRequest);
  } catch { return { hint }; }
  const bandTop = (band.y as number) - (cell.y as number);
  return { hint, committed: { layout: graph.layout, basis },
    history: { signature, layout: graph.layout, placed: graph.attached, attachment: { bandTop, placement: placement as unknown as FolderGraph["placement"] } } };
}

function priorsOf(previous: unknown): ReadonlyMap<GraphId, Prior> {
  if (!isObject(previous) || !(previous.graphs instanceof Map) || !(previous.cells instanceof Map) || !Array.isArray(previous.bands)) return new Map();
  const priors = new Map<GraphId, Prior>();
  for (const [id, graph] of previous.graphs) {
    if (typeof id !== "string") continue;
    try { priors.set(id, priorOf(previous, id, graph)); } catch { /* a malformed graph contributes nothing */ }
  }
  return priors;
}

/** The stack's drawable members: keys of its graph, each once, in the given order. */
function membersOf(stack: OpenStack): readonly NodeKey[] {
  const nodes = stack.graph.dag.nodes, seen = new Set<NodeKey>();
  return stack.members.filter((key) => typeof key === "string" && nodes.has(key) && !seen.has(key) && !!seen.add(key));
}

/** The stack's expanded keys, string keys only, with its cover (expanded while the stack is open). */
function expandedOf(stack: OpenStack, cover: GraphId): ReadonlySet<NodeKey> {
  const given: unknown = stack.expanded;
  const keys = given instanceof Set ? [...given].filter((key): key is NodeKey => typeof key === "string") : [];
  return new Set([...keys, cover]);
}

/** Open stack items in grid order whose cover is a drawable member. */
function openStacks(input: FolderLayoutInput): readonly (readonly [GraphId, OpenStack, readonly NodeKey[]])[] {
  if (!(input.open instanceof Map)) return [];
  return input.items.flatMap((item) => {
    const stack = item.kind === "stack" ? input.open.get(item.id) : undefined;
    if (!stack || !isObject(stack.graph) || !isObject(stack.graph.dag) || !(stack.graph.dag.nodes instanceof Map) || !Array.isArray(stack.members)) return [];
    const members = membersOf(stack);
    return members.includes(item.id) ? [[item.id, stack, members] as const] : [];
  });
}

/** A planned band: its request, and the committed layout it keeps when its geometry basis is unchanged. */
interface BandPlan { readonly plan: BandScenePlan; readonly kept: GraphLayout | null }

/** Plans every open band (the first half of step 2): what each band's layout request will be. */
export function planBands(input: FolderLayoutInput, geometry: FolderGridGeometry): ReadonlyMap<GraphId, BandPlan> {
  const base = gridFlow(input.items, new Map(), geometry.columns, gridMetricsOf(geometry));
  const open = openStacks(input);
  const pins = gridPins(base, open.map(([id]) => id));
  const priors = priorsOf(input.previous);
  const width = Math.max(0, input.width);
  const plans = new Map<GraphId, BandPlan>();
  for (const [id, stack, members] of open) {
    const prior = priors.get(id);
    const plan = planBandScene(stack.graph, members, typeof stack.anchor === "string" ? stack.anchor : null, width,
      { pinned: pins.get(id)!, expanded: expandedOf(stack, id), history: prior?.history, hint: prior?.hint, tile: input.tile });
    plans.set(id, { plan, kept: prior?.committed && prior.committed.basis === requestBasis(plan.request) ? prior.committed.layout : null });
  }
  return plans;
}

/** Plans and lays out every open band (step 2). */
export function layoutBands(input: FolderLayoutInput, geometry: FolderGridGeometry, cache: BoundedCache<GraphLayout> | null = null): ReadonlyMap<GraphId, PlannedBand> {
  const bands = new Map<GraphId, PlannedBand>();
  for (const [id, { plan, kept }] of planBands(input, geometry)) {
    const layout = kept ?? bandLayout(plan.request, cache);
    // A cover the band does not place cannot be attached; the stack is shown closed.
    if (layout.nodes.has(id)) bands.set(id, { plan, layout });
  }
  return bands;
}

/**
 * The band layout requests an engine run with `cache` would compute, the ones it does not hold:
 * what a caller weighs to decide where to run the engine (Phase 2's per-request workload rule).
 * Throws as the engine does for invalid geometry.
 */
export function uncachedBandRequests(input: FolderLayoutInput, cache: BoundedCache<GraphLayout>): readonly LayoutRequest[] {
  const geometry = folderGridGeometry(input.width, input.tile, input.grid);
  return [...planBands(input, geometry).values()].filter(({ kept, plan }) => !kept && !cache.get(layoutSignature(plan.request))).map(({ plan }) => plan.request);
}

/** Seeds `cache` with the bands of a layout computed elsewhere (a worker), keyed by their exact requests. */
export function rememberBands(layout: FolderLayout, cache: BoundedCache<GraphLayout>): void {
  for (const graph of layout.graphs.values()) cache.set(layoutSignature(graph.plan.request), graph.layout);
}

function bandLayout(request: LayoutRequest, cache: BoundedCache<GraphLayout> | null): GraphLayout {
  if (!cache) return layoutGraph(request);
  const key = layoutSignature(request);
  const known = cache.get(key);
  if (known) return known;
  const layout = layoutGraph(request);
  cache.set(key, layout);
  return layout;
}

/**
 * Packs the rows with the bands' exact extents and attaches every band below its cover
 * (step 3). Bands whose id is not a stack item are ignored.
 */
export function composeFolderLayout(items: readonly GridItem[], geometry: FolderGridGeometry, bands: ReadonlyMap<GraphId, PlannedBand>): FolderLayout {
  const extents = new Map(items.flatMap((item) => {
    const band = item.kind === "stack" ? bands.get(item.id) : undefined;
    return band ? [[item.id, bandExtent(band.layout, item.id)] as const] : [];
  }));
  const flow = packedGridFlow(items, extents, geometry.columns, gridMetricsOf(geometry));
  const placements = bandPlacements(flow, geometry.cellHeight);
  const graphs = new Map<GraphId, FolderGraph>();
  for (const band of flow.bands) {
    const cell = flow.cells.get(band.id)!, placement = placements.get(band.id)!, { plan, layout } = bands.get(band.id)!;
    graphs.set(band.id, { id: band.id, plan, layout, attached: attachPackedBand(layout, band.id, band.y - cell.y, placement), origin: { x: 0, y: cell.y }, placement });
  }
  return { columns: geometry.columns, size: { width: flow.width, height: flow.height }, bounds: folderBounds({ x: 0, y: 0, width: flow.width, height: flow.height }, flow.cells.values(), [...flow.bands, ...flow.rowBands], graphs.values()),
    cells: flow.cells, bands: flow.bands, rowBands: flow.rowBands, graphs };
}

/** Everything drawn: the grid box, cells, band backgrounds, band tiles, junctions and padded connectors. */
function folderBounds(grid: GridRect, cells: Iterable<GridRect>, bands: readonly GridRect[], graphs: Iterable<FolderGraph>): GridRect {
  let bounds: GridRect | null = grid;
  for (const cell of cells) bounds = unionRect(bounds, cell);
  for (const band of bands) bounds = unionRect(bounds, band);
  for (const graph of graphs) {
    const { x: dx, y: dy } = graph.origin, layout = graph.attached;
    for (const node of layout.nodes.values()) bounds = unionRect(bounds, { x: node.x + dx, y: node.y + dy, width: node.width, height: node.height });
    for (const junction of layout.junctions.values()) bounds = unionRect(bounds, { x: junction.x + dx, y: junction.y + dy, width: 0, height: 0 });
    for (const route of layout.routes) bounds = unionRect(bounds, routeBounds(route.path, dx, dy));
  }
  if (!finite(bounds!.x, bounds!.y, bounds!.width, bounds!.height)) throw new RangeError("folder geometry overflow");
  return bounds!;
}

export interface DefaultEngineOptions {
  /** Per-band layout reuse keyed by the exact request; null disables it. Output is identical either way. */
  readonly bandCache?: BoundedCache<GraphLayout> | null;
}

export function createDefaultEngine(options: DefaultEngineOptions = {}): FolderLayoutEngine {
  const cache = options.bandCache === undefined ? createBoundedCache(estimateLayoutBytes) : options.bandCache;
  return (input) => {
    const geometry = folderGridGeometry(input.width, input.tile, input.grid);
    return composeFolderLayout(input.items, geometry, layoutBands(input, geometry, cache));
  };
}

export const defaultFolderLayout: FolderLayoutEngine = createDefaultEngine();
