import { layoutStage, countLayoutWork } from '../layout-profile';
/**
 * The default folder layout, computed completely before publication as one pure function.
 *
 * 1. Columns and cell size from the width, tile and grid metrics (`folderGridGeometry`).
 * 2. Each open stack is planned (`planBandScene`, pinned at its cover's column by `gridPins`,
 *    with the displayed drawing and click anchor) and laid out (`layoutGraph`).
 *    Selection never enters the request. Displayed states restore from committed history. Every band is complete before packing.
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
 *   basis. A bounded per-folder ledger restores previously displayed geometry exactly.
 *
 * Output is plain data, never mutated afterwards; treat it as readonly (it may share objects
 * with earlier outputs, the band cache and `previous`). Canonical raw band cache entries are kept
 * separately when a folder fallback changes attachment. A world placement has no band transform
 * to replay; its exact local drawing supplies history, and its canonical request supplies caching.
 */
import { TRACK_HEIGHT, STACK_STEM_ROOM } from "../metrics";
import type { NodeKey } from "../model";
import { gridFlow, type GridItem, type GridMetrics, type GridRect } from "../grid-flow";
import { attachPackedBand, bandExtent, bandPlacements, packedGridFlow } from "../band-geometry";
import { BAND_DEFAULTS, bandHistorySignature, ladderPins, type BandOptions } from "../band-layout";
import { serialRowsEmbedding } from "../cold-embeddings";
import { folderGridGeometry, gridPins, type FolderGridGeometry } from "../folder-grid";
import { layoutGraph, type BandHistory, type GraphLayout, type LayoutRequest, type LayoutItem } from "../layout";
import { layoutSignature } from "../layout-signature";
import { pathNumbers } from "../path-data";
import { isLayoutShape, validHistory } from "../history-boundary";
import { recallDisplay, rememberDisplay, displayIdentity } from "./display-memory";
import { withCellFootprints } from "./cell-footprints";
import { folderGeometryGate } from "./geometry-gate";
import { safeLayout } from "../safe-layout";
import { pinnedFolderPlacement, preservesFolderRectangles, type WorldSearchOrder } from "./pinned-placement";
import { planBandScene, type BandScenePlan } from "../scene";
import type { BandExpansion } from "../visibility";
import { createBoundedCache, estimateLayoutBytes, type BoundedCache } from "./bounded-cache";
import { routeBounds, unionRect } from "./route-bounds";
import type { ArrivalHistory, FolderGraph, FolderLayout, FolderLayoutEngine, FolderLayoutInput, FolderPlacementHistory, GraphId, OpenStack } from "./types";

/** One open band before packing: its plan and its raw (cover-relative) layout. */
export interface PlannedBand {
  readonly plan: BandScenePlan;
  readonly layout: GraphLayout;
  readonly retainedAttachment?: { readonly track: number; readonly stemRoom: number; readonly x: number; readonly bandTop: number; readonly columns: readonly number[] };
}

export const gridMetricsOf = (geometry: FolderGridGeometry): GridMetrics =>
  ({ cellWidth: geometry.cellWidth, cellHeight: geometry.cellHeight, columnGap: geometry.gap, rowGap: geometry.gap });

/** Geometry from the currently displayed component. */
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
const displayBasis = (request: LayoutRequest): string => requestBasis({ ...request, anchorKey: undefined });

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
  if (graph.worldPlaced === true) {
    const framed = worldBandFrame(graph.attached as GraphLayout, id, placement as unknown as FolderGraph["placement"]);
    return { hint, committed: { layout: graph.layout, basis }, history: { signature, layout: framed, placed: framed } };
  }
  return { hint, committed: { layout: graph.layout, basis },
    history: { signature, layout: graph.layout, placed: graph.attached,
      attachment: { bandTop, placement: placement as unknown as FolderGraph["placement"] } } };
}

/**
 * A world-placed drawing is already attached in its cover's frame. Declare that
 * frame explicitly: the body belongs to a band whose top is the cover bottom and
 * whose child allocation starts one stem room below it. Re-attaching a layout
 * derived from it at that band top is the identity, so a later click translates
 * the body only by an actual change of band top or stem room, never by
 * re-inferring the frame from wherever the first child row happens to sit.
 */
function worldBandFrame(attached: GraphLayout, id: GraphId, placement: FolderGraph["placement"]): GraphLayout {
  const cover = attached.nodes.get(id);
  if (attached.bandBounds || !cover) return attached;
  const extent = bandExtent(attached, id);
  return { ...attached, bandBounds: { left: extent.left, width: extent.width,
    top: cover.y + cover.height + (placement.stemRoom ?? STACK_STEM_ROOM) } };
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
  const present = new Set(input.items.filter(item => item.kind === 'stack').map(item => item.id));
  const arrivals = new Map(previous?.arrivals instanceof Map
    ? [...previous.arrivals].filter(([id]) => present.has(id)) : []);
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
  // Bound closed-stack history too: removal pruning alone does not limit a long
  // visit through a folder with many still-present components.
  const bounded = createBoundedCache<ArrivalHistory>(arrival => 64 + 2 * arrival.contents.length
    + (arrival.history ? 2 * arrival.history.signature.length
      + estimateLayoutBytes(arrival.history.layout) + estimateLayoutBytes(arrival.history.placed) : 0));
  for (const [id, arrival] of arrivals) {
    try { bounded.set(id, arrival); } catch { /* Malformed history is not retained. */ }
  }
  return new Map([...arrivals.keys()].flatMap(id => {
    const arrival = bounded.get(id);
    return arrival ? [[id, arrival] as const] : [];
  }));
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
interface BandPlan {
  readonly plan: BandScenePlan;
  /** The request's geometry is unchanged, including when its drawing lives in the folder frame. */
  readonly unchanged: boolean;
  /** Raw band geometry only: a world drawing must never be attached a second time. */
  readonly kept: GraphLayout | null;
}

function canonicalBand(graph: FolderGraph | undefined, request: LayoutRequest): GraphLayout | null {
  try {
    const canonical = graph?.canonical;
    return canonical && isLayoutShape(canonical.layout) && canonical.layout.width >= 0 && canonical.layout.height >= 0
      && (!canonical.layout.bandBounds || canonical.layout.bandBounds.width >= 0)
      && requestBasis(canonical.request) === requestBasis(request)
      && canonical.layout.nodes.size === request.items.length && request.items.every(item => {
        const node = canonical.layout.nodes.get(item.key);
        return node?.width === item.width && node.height === item.height;
      })
      ? canonical.layout : null;
  } catch { return null; } // Transported canonical metadata is untrusted too.
}

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
    const unchanged = !!prior?.committed && isLayoutShape(prior.committed.layout)
      && prior.committed.basis === requestBasis(plan.request);
    const graph = input.previous?.graphs instanceof Map ? input.previous.graphs.get(id) : undefined;
    const kept = !unchanged ? null : graph?.worldPlaced
      ? canonicalBand(graph, plan.request)
      : prior!.committed!.layout;
    plans.set(id, { plan, unchanged, kept });
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
const fieldsOf = (input: FolderLayoutInput): readonly unknown[] => [input.items, input.open, input.width, input.tile, input.grid, input.previous, input.dataRevision, input.folderKey, input.contents];
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
    if (layout.nodes.has(id)) bands.set(id, { plan, layout, ...(kept && plan.request.history?.attachment && validHistory(plan.request.history, id) ? { retainedAttachment: {
      track: plan.request.history.attachment.placement.track ?? TRACK_HEIGHT,
      stemRoom: plan.request.history.attachment.placement.stemRoom ?? STACK_STEM_ROOM,
      x: plan.request.history.attachment.placement.x, bandTop: plan.request.history.attachment.bandTop,
      columns: [...new Set(plan.request.history.placed.routes.filter(route => route.from.kind === 'node' && route.from.id === id)
        .flatMap(route => pathNumbers(route.path).filter((_, i) => i % 2 === 0)))],
    } } : {}) });
  }
  return bands;
}

/**
 * The band layout requests an engine run with `cache` would compute, the ones it does not hold:
 * what a caller weighs to decide where to run the engine (Phase 2's per-request workload rule).
 * Throws as the engine does for invalid geometry.
 */
export function uncachedBandRequests(input: FolderLayoutInput, cache: BoundedCache<GraphLayout>): readonly LayoutRequest[] {
  return folderBandWork(input, cache).filter(band => !band.cached).map(band => band.request);
}

/** The dispatch rule's inputs; reading them never constructs or decodes a drawing. */
export interface FolderBandWork {
  readonly id: GraphId;
  readonly request: LayoutRequest;
  readonly cached: boolean;
  readonly drawing: GraphLayout | undefined;
}

export function folderBandWork(input: FolderLayoutInput, cache: BoundedCache<GraphLayout>): readonly FolderBandWork[] {
  return [...plansOf(input).plans].map(([id, { kept, plan }]) => {
    const cached = kept ?? cache.get(signatureOf(plan.request));
    return { id, request: plan.request, cached: !!cached,
      drawing: kept ? input.previous?.graphs.get(id)?.attached ?? kept : cached ?? plan.request.history?.placed };
  });
}

/** Every band needs packing and certification even if its raw layout is cached. */
export function folderBandRequests(input: FolderLayoutInput): readonly LayoutRequest[] {
  return [...plansOf(input).plans.values()].map(({ plan }) => plan.request);
}

/** Seeds `cache` with the bands of a layout computed elsewhere (a worker), keyed by their exact requests. */
export function rememberBands(layout: FolderLayout, cache: BoundedCache<GraphLayout>): void {
  // Restored geometry was chosen under an earlier history, not the current request.
  if (layout.revisited) return;
  for (const graph of layout.graphs.values()) {
    // World geometry has no raw-band transform. Missing/invalid provenance cannot seed the cache.
    const canonical = graph.canonical ?? (graph.worldPlaced ? null : { request: graph.plan.request, layout: graph.layout });
    if (!canonical || graph.canonical && !canonicalBand(graph, canonical.request)) continue;
    try { cache.set(signatureOf(canonical.request), canonical.layout); }
    catch { /* Malformed history/hints cannot supply a canonical cache key. */ }
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
export function composeFolderLayout(items: readonly GridItem[], geometry: FolderGridGeometry, bands: ReadonlyMap<GraphId, PlannedBand>, identityFrames = false): FolderLayout {
  const extents = new Map(items.flatMap((item) => {
    const band = item.kind === "stack" ? bands.get(item.id) : undefined;
    return band ? [[item.id, bandExtent(band.layout, item.id)] as const] : [];
  }));
  const flow = packedGridFlow(items, extents, geometry.columns, gridMetricsOf(geometry), new Map([...bands].flatMap(([id, band]) => band.retainedAttachment ? [[id, band.retainedAttachment] as const] : [])));
  const placements = bandPlacements(flow, geometry.cellHeight);
  const graphs = new Map<GraphId, FolderGraph>();
  for (const band of flow.bands) {
    const cell = flow.cells.get(band.id)!, packed = placements.get(band.id)!, { plan, layout } = bands.get(band.id)!;
    // With `identityFrames`, a band the packing puts exactly where its own certified frame
    // declares (same band top, cover and band x) keeps that frame, and so its exact drawing.
    const frame = identityFrames ? layout.routingAttachment : undefined;
    const placement = frame && frame.key === band.id && frame.bandTop === band.y - cell.y && frame.placement.x === packed.x
      && frame.placement.coverX === packed.coverX && frame.placement.coverHeight === packed.coverHeight ? frame.placement : packed;
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
  /** How an arrival that packing could not pin searches the world (slice 5c); production uses the default. */
  readonly worldSearch?: WorldSearchOrder;
}

function folderPlacementHistory(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, BandPlan>, basis: string): FolderPlacementHistory | undefined {
  const previous = input.previous;
  if (!previous) return undefined;
  const itemIds = previous.cells instanceof Map ? [...previous.cells.keys()] : null;
  const changedItems = itemIds && (itemIds.length !== input.items.length
    || input.items.some(item => !previous.cells.has(item.id)));
  // The bounded arrival ledger may evict a component; the currently displayed
  // graph remains the authority for whether its membership changed.
  const changedContents = (input.dataRevision === undefined || previous.dataRevision !== input.dataRevision)
    && previous.graphs instanceof Map && [...plans].some(([id, { plan }]) => {
      try {
        const old = previous.graphs.get(id)?.plan?.request?.band?.items;
        const facts = (items: readonly LayoutItem[]) => items.map(n => [n.key, n.order, n.parents]);
        return Array.isArray(old) && JSON.stringify(facts(old)) !== JSON.stringify(facts(plan.request.band?.items ?? []));
      } catch { return false; } // Invalid previous facts cannot establish an arrival.
    });
  if ((changedItems || changedContents) && previous.geometryBasis === basis) {
    const { arrivalPlacement: _placement, arrivals: _arrivals, displays: _displays, ...layout } = previous;
    return { basis, layout };
  }
  return undefined;
}

/** Validate packing metadata too: the geometry gate certifies ink, not row/background records. */
function validFolderFrame(previous: FolderLayout | null | undefined): previous is FolderLayout {
  try {
    const size = (value: unknown): value is { width: number; height: number } => isObject(value)
      && finite(value.width, value.height) && Number(value.width) >= 0 && Number(value.height) >= 0;
    const rect = (value: unknown): boolean => size(value) && finite((value as GridRect).x, (value as GridRect).y);
    const row = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
    return !!previous && Number.isSafeInteger(previous.columns) && previous.columns >= 1
      && previous.cells instanceof Map && previous.graphs instanceof Map && size(previous.size) && rect(previous.bounds)
      && Array.isArray(previous.bands) && Array.isArray(previous.rowBands)
      && [...previous.cells].every(([id, cell]) => cell.id === id && rect(cell) && row(cell.row) && row(cell.col))
      && previous.bands.length === previous.graphs.size && new Set(previous.bands.map(band => band.id)).size === previous.graphs.size
      && previous.bands.every(band => rect(band) && row(band.row) && previous.graphs.has(band.id))
      && previous.rowBands.every(band => rect(band) && row(band.row));
  } catch { return false; }
}

/** A metadata refresh retains the complete drawing in its original coordinate frame. */
function retainedFolder(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, BandPlan>, basis: string): FolderLayout | null {
  try {
    const previous = input.previous;
    if (!validFolderFrame(previous) || previous.geometryBasis !== basis || previous.cells.size !== input.items.length
      || [...previous.cells.keys()].some((id, i) => id !== input.items[i].id) || previous.graphs.size !== plans.size
      || [...plans].some(([id, band]) => !band.unchanged || !previous.graphs.has(id) || !validHistory(band.plan.request.history, id))) return null;
    const graphs = new Map([...previous.graphs].map(([id, graph]) => [id, { ...graph, plan: plans.get(id)!.plan }]));
    const result = withCellFootprints({ columns: previous.columns, size: previous.size, bounds: previous.bounds,
      cells: previous.cells, bands: previous.bands, rowBands: previous.rowBands, graphs,
      ...(previous.decision ? { decision: previous.decision } : {}) }, input);
    return folderGeometryGate(result) ? null : result;
  } catch { return null; } // Invalid retained folder metadata cannot authorize reuse.
}

/** Unchanged world bands retain their folder frame when another band opens, closes or changes. */
function retainedWorldPlacement(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, BandPlan>, basis: string): FolderPlacementHistory | undefined {
  const previous = input.previous;
  if (!validFolderFrame(previous) || previous.geometryBasis !== basis
    || previous.cells.size !== input.items.length || [...previous.cells.keys()].some((id, i) => id !== input.items[i].id)
    || ![...plans].some(([id, band]) => band.unchanged && previous.graphs.get(id)?.worldPlaced)) return undefined;
  const { arrivalPlacement: _placement, arrivals: _arrivals, displays: _displays, ...layout } = previous;
  return { basis, layout };
}

/**
 * Isolation (T38, slice 5c): one stack per row, so no two bands' attachments share a
 * row. Each rung is certified in full before the next is tried:
 * 1. the requested band layouts in the one-column grid. Band requests do not change,
 *    only the grid does, so every band keeps its own drawing and pin set exactly. A band
 *    first keeps its own certified attachment frame where the packing allows it
 *    (`identityFrames`), then takes the packed attachment;
 * 2. the serial embedding (slice 5a) through the common solve for every band whose
 *    pin set it keeps; any other band keeps its requested layout;
 * 3. legacy serial rows (`safeLayout`) planned for the one-column grid, as before 5c,
 *    counted as `legacy:T38`, with the bands whose pins it drops (`legacy:T38:pins-lost`).
 */
function isolatedFolder(input: FolderLayoutInput, geometry: FolderGridGeometry,
  bands: ReadonlyMap<GraphId, PlannedBand>, policy: BandOptions = BAND_DEFAULTS): FolderLayout {
  const serial = { ...geometry, columns: 1 };
  // Attachment policy does not change the canonical band request or its cached result.
  // Workers remember those original requests, even when the final folder uses wider rows.
  const compose = (laid: ReadonlyMap<GraphId, PlannedBand>, identityFrames = false): FolderLayout => {
    const isolated = withCellFootprints(composeFolderLayout(input.items, serial, laid, identityFrames), input);
    const graphs = new Map([...isolated.graphs].map(([id, graph]) => {
      const canonical = bands.get(id)!;
      return [id, { ...graph, canonical: { request: canonical.plan.request, layout: canonical.layout } }] as const;
    }));
    return { ...isolated, graphs, decision: { fallback: "isolated-rows", requestedColumns: geometry.columns } };
  };
  countLayoutWork('isolation:attempt');
  const framed = compose(bands, true);
  if (!folderGeometryGate(framed)) { countLayoutWork('isolation:framed:published'); return framed; }
  const requested = compose(bands);
  if (!folderGeometryGate(requested)) { countLayoutWork('isolation:requested:published'); return requested; }
  const embedded = new Map([...bands].map(([id, band]) => {
    const request = band.plan.request;
    const layout = serialRowsEmbedding(request, { ordering: policy.ordering, passing: policy.passing });
    return [id, layout && layout.nodes.has(id) && ladderPins(request, policy).held(layout) ? { plan: band.plan, layout } : band] as const;
  }));
  // With no band adopting an embedding, this is the requested composition that just failed.
  if ([...embedded].some(([id, band]) => band !== bands.get(id))) {
    const viaEmbedding = compose(embedded);
    if (!folderGeometryGate(viaEmbedding)) { countLayoutWork('isolation:serial-embedding:published'); return viaEmbedding; }
  }
  const legacy = new Map([...planBands(input, serial)].flatMap(([id, { plan }]) => {
    const request = { ...plan.request, history: undefined, hint: undefined, anchorKey: undefined };
    return bands.has(id) ? [[id, { plan: { ...plan, request }, layout: safeLayout(request) }] as const] : [];
  }));
  const viaLegacy = compose(legacy);
  countLayoutWork('legacy:T38:published');
  const lost = [...bands].filter(([id, band]) => {
    const keys = ladderPins(band.plan.request, policy).keys;
    if (!keys.length) return false;
    const before = band.layout.nodes.get(id), after = legacy.get(id)?.layout.nodes.get(id);
    if (!before || !after) return true;
    // Compare in the cover's frame: the grid moves covers, the band frame must not change.
    return keys.some(key => {
      const a = band.layout.nodes.get(key), b = legacy.get(id)!.layout.nodes.get(key);
      return !a || !b || Math.abs((a.x - before.x) - (b.x - after.x)) > .01 || Math.abs((a.y - before.y) - (b.y - after.y)) > .01;
    });
  }).length;
  if (lost) countLayoutWork('legacy:T38:pins-lost', lost);
  return viaLegacy;
}

export function createDefaultEngine(options: DefaultEngineOptions = {}): FolderLayoutEngine {
  const cache = options.bandCache === undefined ? createBoundedCache(estimateLayoutBytes) : options.bandCache;
  // Certificates are bound to immutable serialized bytes and the requested state, not
  // mutable Maps or a transported trust flag. A new worker validates its first restore.
  const certifiedDisplays = createBoundedCache<boolean>(() => 8);
  const certificateKey = (key: string, payload: string) => JSON.stringify([key, payload]);
  return (given) => {
    const prior = given.previous;
    const malformed = prior && (!(prior.graphs instanceof Map) || [...prior.graphs.values()].some(g =>
      !g || !isLayoutShape(g.layout) || !isLayoutShape(g.attached)));
    const rejectedDrawing = malformed && prior.graphs instanceof Map && [...prior.graphs.values()].some(g =>
      g && isLayout(g.layout) && isLayout(g.attached) && (!isLayoutShape(g.layout) || !isLayoutShape(g.attached)));
    const foreign = prior?.displays && prior.displays.folder !== undefined && prior.displays.folder !== (given.folderKey ?? '');
    const input = malformed || foreign ? { ...given, previous: undefined } : given;
    const { geometry, plans } = plansOf(input);
    const arrivals = arrivalsFor(input), geometryBasis = JSON.stringify([Math.max(0, input.width), input.tile, input.grid]);
    let relayout: 'pane-width' | 'tile-size' | undefined;
    if (input.previous?.geometryBasis && input.previous.geometryBasis !== geometryBasis) {
      try { relayout = JSON.parse(input.previous.geometryBasis)[0] !== Math.max(0,input.width) ? 'pane-width' : 'tile-size'; }
      catch { /* Malformed history supplies no basis to compare. */ }
    }
    const identity = displayIdentity(input, plans, options.band);
    let restored: FolderLayout | undefined;
    try {
      const recalled = recallDisplay(input.previous?.displays, identity);
      if (recalled?.geometryBasis === geometryBasis && recalled.cells.size === input.items.length &&
        [...recalled.cells.keys()].every((id, i) => id === input.items[i].id) && recalled.graphs.size === plans.size &&
        [...recalled.graphs].every(([id, graph]) => plans.has(id) &&
          displayBasis(graph.canonical?.request ?? graph.plan.request) === displayBasis(plans.get(id)!.plan.request))) {
        const rebound = { ...recalled, graphs: new Map([...recalled.graphs].map(([id, graph]) =>
          [id, { ...graph, plan: plans.get(id)?.plan ?? graph.plan }])) };
        const payload = input.previous!.displays!.entries.find(([key]) => key === identity.key)![1];
        const certificate = certificateKey(identity.key, payload);
        const endValidation = layoutStage('restore-validation');
        try {
          if (certifiedDisplays.get(certificate)) restored = rebound;
          else {
            countLayoutWork('restore-validation');
            if (!folderGeometryGate(rebound)) {
              certifiedDisplays.set(certificate, true);
              restored = rebound;
            }
          }
        } finally { endValidation(); }
      }
    } catch { /* Invalid stored geometry is never an authority. Rebuild through the normal gate. */ }
    if (restored) return { ...restored, revisited: true, arrivals, geometryBasis, dataRevision: input.dataRevision,
      displays: rememberDisplay(input.previous?.displays, identity, restored, true) };
    const arrivalPlacement = folderPlacementHistory(input, plans, geometryBasis);
    const placement = arrivalPlacement ?? retainedWorldPlacement(input, plans, geometryBasis);
    const retained = retainedFolder(input, plans, geometryBasis);
    // A certified continuation needs no raw-band reconstruction, even if its canonical cache metadata is absent.
    const bands = retained ? new Map<GraphId, PlannedBand>() : layoutPlanned(plans, cache, options.band);
    let result = retained ?? withCellFootprints(composeFolderLayout(input.items, geometry, bands), input);
    let failure = folderGeometryGate(result);
    let pinningFailed = false;
    if (placement && (failure || !preservesFolderRectangles(result, placement.layout))) {
      const pinned = pinnedFolderPlacement(input, plans, placement.layout, result, options.worldSearch);
      pinningFailed = pinned === null;
      result = pinned ?? result;
      if (pinned) failure = null; // The world candidate certifies its completed attached folder.
    }
    if (failure && bands.size) {
      // Packing keeps each band's own certified attachment frame where the packed
      // position allows it, before any band leaves its requested column (slice 5c).
      const framed = withCellFootprints(composeFolderLayout(input.items, geometry, bands, true), input);
      if (!folderGeometryGate(framed)) {
        countLayoutWork('packing:identity-frames:published');
        result = framed; failure = null;
      }
    }
    if (failure) {
      result = isolatedFolder(input, geometry, bands, options.band);
      failure = folderGeometryGate(result);
      if (failure) throw new RangeError("No certified folder layout: " + failure);
    }
    if (relayout) result = {...result,decision:{requestedColumns:geometry.columns,...result.decision,relayout}};
    if (rejectedDrawing) result = { ...result, graphs: new Map([...result.graphs].map(([id, graph]) => [id, {
      ...graph,
      layout: { ...graph.layout, decision: { ...graph.layout.decision!, fallback: 'invalid-history' } },
      attached: { ...graph.attached, decision: { ...graph.attached.decision!, fallback: 'invalid-history' } },
    }])) };
    const completed: FolderLayout = { ...result, ...(pinningFailed ? { decision: { ...(result.decision ?? { fallback: "pin-search-exhausted" as const, requestedColumns: geometry.columns }), pinning: "search-exhausted" as const } } : {}),
      geometryBasis, arrivalPlacement, arrivals, ...(input.dataRevision === undefined ? {} : { dataRevision: input.dataRevision }) };
    const displays = rememberDisplay(input.previous?.displays, identity, completed);
    // `completed` passed the full folder gate (or the independently certified pinned path).
    const payload = displays.entries.find(([key]) => key === identity.key)![1];
    certifiedDisplays.set(certificateKey(identity.key, payload), true);
    return { ...completed, displays };
  };
}

export const defaultFolderLayout: FolderLayoutEngine = createDefaultEngine();
