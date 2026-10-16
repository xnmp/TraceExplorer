/**
 * The default folder layout, computed completely before publication as one pure function.
 *
 * 1. Columns and cell size from the width, tile and grid metrics (`folderGridGeometry`).
 * 2. Each open stack is planned (`planBandScene`, pinned at its cover's column by `gridPins`,
 *    with history committed only when folder contents change) and laid out (`layoutGraph`).
 *    Selection and click anchors never enter the request. Every band is complete before packing.
 * 3. The rows are packed once with the exact band extents (`packedGridFlow`, `bandExtent`),
 *    and every band is attached below its cover (`bandPlacements`, `attachPackedBand`).
 * 4. If packing moves retained arrival rectangles, extend the committed folder drawing with
 *    all other cells and routes as obstacles. Certify the complete attached folder; an isolated
 *    fallback is also computed and certified in full before any result is returned.
 *
 * Inputs are checked, not trusted:
 * - a non-finite width or metric, a non-positive tile, negative grid metrics, duplicate item ids
 *   or overflowing geometry throw RangeError; a negative width counts as zero (one column);
 * - a stack's `expanded` that is not a Map counts as only its cover; malformed entries are ignored;
 * - open ids that are not stack items, and stacks whose cover is not a drawable member of their
 *   graph, are laid out closed; member keys missing from the graph and repeated keys are dropped;
 * - history from a malformed drawing is ignored; a width/tile/grid change starts a new placement
 *   basis. Expansion/collapse reuses the same arrival snapshot rather than committing click history.
 *
 * Output is plain data, never mutated afterwards; treat it as readonly (it may share objects
 * with earlier outputs, the band cache and `previous`). Canonical raw band cache entries are kept
 * separately when a folder fallback changes attachment. A world placement has no band transform
 * to replay; its exact local drawing supplies history, and its canonical request supplies caching.
 */
import type { NodeKey } from "../model";
import { gridFlow, type GridItem, type GridMetrics, type GridRect } from "../grid-flow";
import { attachPackedBand, bandExtent, bandPlacements, packedGridFlow } from "../band-geometry";
import { BAND_DEFAULTS, bandHistorySignature, type BandOptions } from "../band-layout";
import { folderGridGeometry, gridPins, type FolderGridGeometry } from "../folder-grid";
import { layoutGraph, type BandHistory, type GraphLayout, type LayoutRequest } from "../layout";
import { layoutSignature } from "../layout-signature";
import { isLayoutShape } from "../history-boundary";
import { withCellFootprints } from "./cell-footprints";
import { folderGeometryGate } from "./geometry-gate";
import { safeLayout } from "../safe-layout";
import { pinnedFolderPlacement, preservesFolderRectangles } from "./pinned-placement";
import { planBandScene, type BandScenePlan } from "../scene";
import type { BandExpansion } from "../visibility";
import { createBoundedCache, estimateLayoutBytes, type BoundedCache } from "./bounded-cache";
import { routeBounds, unionRect } from "./route-bounds";
import type { ArrivalHistory, FolderGraph, FolderLayout, FolderLayoutEngine, FolderLayoutInput, FolderPlacementHistory, GraphId, OpenStack } from "./types";

/** One open band before packing: its plan and its raw (cover-relative) layout. */
export interface PlannedBand {
  readonly plan: BandScenePlan;
  readonly layout: GraphLayout;
}

export const gridMetricsOf = (geometry: FolderGridGeometry): GridMetrics =>
  ({ cellWidth: geometry.cellWidth, cellHeight: geometry.cellHeight, columnGap: geometry.gap, rowGap: geometry.gap });

/** Geometry available to commit when this component's contents change. */
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
    history: { signature, layout: graph.layout, placed: graph.attached,
      ...(graph.worldPlaced === true ? {} : { attachment: { bandTop, placement: placement as unknown as FolderGraph["placement"] } }) } };
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

/** The ledger survives closed stacks; geometry snapshots are taken only on folder changes. */
function arrivalsFor(input: FolderLayoutInput): ReadonlyMap<GraphId, ArrivalHistory> {
  const previous = input.previous;
  const arrivals = new Map(previous?.arrivals instanceof Map ? previous.arrivals : []);
  const priors = priorsOf(previous);
  for (const [id, stack, members] of openStacks(input)) {
    const contents = JSON.stringify(members.map(key => [key, stack.graph.dag.nodes.get(key)!.order, stack.graph.dag.parents.get(key)]));
    const old = arrivals.get(id);
    if (old?.contents === contents) continue;
    // Opening a previously closed stack can reveal facts from an already committed data
    // epoch. That click must not replace its arrival snapshot with the closed drawing.
    const freshEpoch = input.dataRevision === undefined || previous?.dataRevision !== input.dataRevision;
    const history = old ? freshEpoch ? priors.get(id)?.history ?? old.history : old.history : undefined;
    arrivals.set(id, { contents, history });
  }
  return arrivals;
}

/** The stack's drawable members: keys of its graph, each once, in the given order. */
function membersOf(stack: OpenStack): readonly NodeKey[] {
  const nodes = stack.graph.dag.nodes, seen = new Set<NodeKey>();
  return stack.members.filter((key) => typeof key === "string" && nodes.has(key) && !seen.has(key) && !!seen.add(key));
}

/** The stack's expansion, well-formed entries only; the cover is expanded, oldest, unless an entry decides it. */
function expandedOf(stack: OpenStack, cover: GraphId): BandExpansion {
  const given: unknown = stack.expanded;
  const entries = given instanceof Map ? [...given].filter((entry): entry is [NodeKey, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean") : [];
  return new Map(entries.some(([key]) => key === cover) ? entries : [[cover, true], ...entries]);
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
  const arrivals = arrivalsFor(input);
  const width = Math.max(0, input.width);
  const plans = new Map<GraphId, BandPlan>();
  for (const [id, stack, members] of open) {
    const history = arrivals.get(id)?.history;
    const plan = planBandScene(stack.graph, members, null, width,
      { pinned: pins.get(id)!, expanded: expandedOf(stack, id), history, tile: input.tile });
    const graph = input.previous?.graphs instanceof Map ? input.previous.graphs.get(id) : undefined;
    const canonical = graph?.canonical ?? (graph && isObject(graph.plan) && { request: graph.plan.request, layout: graph.layout });
    let kept: GraphLayout | null = null;
    try {
      if (graph && isLayoutShape(graph.layout) && canonical && isLayoutShape(canonical.layout)
        && layoutSignature(canonical.request) === layoutSignature(plan.request)) kept = canonical.layout;
    } catch { /* malformed cache metadata cannot bypass normal history validation */ }
    plans.set(id, { plan, kept });
  }
  return plans;
}

/**
 * An input's geometry and band plans, planned once per input object: the runtime weighs an
 * input's uncached bands (`uncachedBandRequests`) and then runs the engine on that same object.
 * Plans are a pure function of the input; a reused input object whose top-level fields were
 * replaced since is planned again.
 */
interface Planned {
  readonly geometry: FolderGridGeometry;
  readonly plans: ReadonlyMap<GraphId, BandPlan>;
  readonly fields: readonly unknown[];
}
const planned = new WeakMap<FolderLayoutInput, Planned>();
const fieldsOf = (input: FolderLayoutInput): readonly unknown[] => [input.items, input.open, input.width, input.tile, input.grid, input.previous, input.dataRevision];
function plansOf(input: FolderLayoutInput): Planned {
  const known = planned.get(input), fields = fieldsOf(input);
  if (known && known.fields.every((value, index) => Object.is(value, fields[index]))) return known;
  const geometry = folderGridGeometry(input.width, input.tile, input.grid);
  const fresh: Planned = { geometry, plans: planBands(input, geometry), fields };
  planned.set(input, fresh);
  return fresh;
}

/** `layoutSignature` of a planned request, computed once per request object (requests are never mutated). */
const signatures = new WeakMap<LayoutRequest, string>();
function signatureOf(request: LayoutRequest): string {
  let known = signatures.get(request);
  if (known === undefined) signatures.set(request, known = layoutSignature(request));
  return known;
}

/** Plans and lays out every open band (step 2). */
export function layoutBands(input: FolderLayoutInput, geometry: FolderGridGeometry, cache: BoundedCache<GraphLayout> | null = null, options: BandOptions = BAND_DEFAULTS): ReadonlyMap<GraphId, PlannedBand> {
  return layoutPlanned(planBands(input, geometry), cache, options);
}

function layoutPlanned(plans: ReadonlyMap<GraphId, BandPlan>, cache: BoundedCache<GraphLayout> | null, options: BandOptions = BAND_DEFAULTS): ReadonlyMap<GraphId, PlannedBand> {
  const bands = new Map<GraphId, PlannedBand>();
  for (const [id, { plan, kept }] of plans) {
    const layout = kept ?? bandLayout(plan.request, cache, options);
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
  return [...plansOf(input).plans.values()].filter(({ kept, plan }) => !kept && !cache.get(signatureOf(plan.request))).map(({ plan }) => plan.request);
}

/** Seeds `cache` with the bands of a layout computed elsewhere (a worker), keyed by their exact requests. */
export function rememberBands(layout: FolderLayout, cache: BoundedCache<GraphLayout>): void {
  for (const graph of layout.graphs.values()) {
    const canonical = graph.canonical ?? { request: graph.plan.request, layout: graph.layout };
    cache.set(signatureOf(canonical.request), canonical.layout);
  }
}

function bandLayout(request: LayoutRequest, cache: BoundedCache<GraphLayout> | null, options: BandOptions): GraphLayout {
  if (!cache) return layoutGraph(request, options);
  const key = signatureOf(request);
  const known = cache.get(key);
  if (known) return known;
  const layout = layoutGraph(request, options);
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
  /** Band layout policy (A/B in `layout-eval`); production uses the defaults. */
  readonly band?: BandOptions;
}

function folderPlacementHistory(input: FolderLayoutInput, arrivals: ReadonlyMap<GraphId, ArrivalHistory>, basis: string): FolderPlacementHistory | undefined {
  const previous = input.previous;
  if (!previous) return undefined;
  const itemIds = previous.cells instanceof Map ? [...previous.cells.keys()] : null;
  const changedItems = itemIds && (itemIds.length !== input.items.length
    || input.items.some((item, i) => itemIds[i] !== item.id));
  const changedContents = previous.arrivals instanceof Map && [...arrivals].some(([id, arrival]) => {
    const old = previous.arrivals!.get(id);
    return old && old.contents !== arrival.contents && previous.graphs instanceof Map && previous.graphs.has(id)
      && (input.dataRevision === undefined || previous.dataRevision !== input.dataRevision);
  });
  if ((changedItems || changedContents) && previous.geometryBasis === basis) {
    const { arrivalPlacement: _placement, arrivals: _arrivals, ...layout } = previous;
    return { basis, layout };
  }
  return previous.arrivalPlacement?.basis === basis ? previous.arrivalPlacement : undefined;
}

export function createDefaultEngine(options: DefaultEngineOptions = {}): FolderLayoutEngine {
  const cache = options.bandCache === undefined ? createBoundedCache(estimateLayoutBytes) : options.bandCache;
  return (input) => {
    const { geometry, plans } = plansOf(input);
    const arrivals = arrivalsFor(input), geometryBasis = JSON.stringify([Math.max(0, input.width), input.tile, input.grid]);
    let relayout: 'pane-width' | 'tile-size' | undefined;
    if (input.previous?.geometryBasis && input.previous.geometryBasis !== geometryBasis) {
      try { relayout = JSON.parse(input.previous.geometryBasis)[0] !== Math.max(0,input.width) ? 'pane-width' : 'tile-size'; }
      catch { /* Malformed history supplies no basis to compare. */ }
    }
    const arrivalPlacement = folderPlacementHistory(input, arrivals, geometryBasis);
    const bands = layoutPlanned(plans, cache, options.band);
    let result = withCellFootprints(composeFolderLayout(input.items, geometry, bands), input);
    let failure = folderGeometryGate(result);
    let pinningFailed = false;
    if (arrivalPlacement && (failure || !preservesFolderRectangles(result, arrivalPlacement.layout))) {
      const pinned = pinnedFolderPlacement(input, plans, arrivalPlacement.layout, result);
      pinningFailed = pinned === null;
      result = pinned ?? result;
      if (pinned) failure = null; // The world candidate certifies its completed attached folder.
    }
    if (failure) {
      // A complete, isolated row per stack prevents attachment routes of neighbouring
      // bands from sharing stems. Build all rows before publishing the replacement.
      const serial = { ...geometry, columns: 1 };
      const fallback = new Map([...planBands(input, serial)].map(([id, { plan }]) => {
        const request = { ...plan.request, history: undefined, hint: undefined, anchorKey: undefined };
        return [id, { plan: { ...plan, request }, layout: safeLayout(request) }] as const;
      }));
      const isolated = withCellFootprints(composeFolderLayout(input.items, serial, fallback), input);
      // Attachment policy does not change the canonical band request or its cached result.
      // Workers remember those original requests, even when the final folder uses wider rows.
      const graphs = new Map([...isolated.graphs].map(([id, graph]) => {
        const canonical = bands.get(id)!;
        return [id, { ...graph, canonical: { request: canonical.plan.request, layout: canonical.layout } }] as const;
      }));
      result = { ...isolated, graphs, decision: { fallback: "isolated-rows", requestedColumns: geometry.columns } };
      failure = folderGeometryGate(result);
      if (failure) throw new RangeError("No certified folder layout: " + failure);
    }
    if (relayout) result = {...result,decision:{requestedColumns:geometry.columns,...result.decision,relayout}};
    return { ...result, ...(pinningFailed ? { decision: { ...(result.decision ?? { fallback: "pin-search-exhausted" as const, requestedColumns: geometry.columns }), pinning: "search-exhausted" as const } } : {}),
      geometryBasis, arrivalPlacement, arrivals, ...(input.dataRevision === undefined ? {} : { dataRevision: input.dataRevision }) };
  };
}

export const defaultFolderLayout: FolderLayoutEngine = createDefaultEngine();
