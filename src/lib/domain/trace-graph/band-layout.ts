import { filterRouteConsumers } from "./route-consumers";
/** Visible-first, bounded band optimisation. Geometry and history are immutable inputs. */
import { downwardBandBound, layoutLayered, type GraphLayout, type LayoutItem, type LayoutRequest, type Ordering, type Passing, type PlacedNode } from "./layout";
import { geometryGate, routeClearanceViolation } from "./geometry-gate";
import { safeChain } from "./safe-chain";
import { safeFanGrid } from "./safe-grid";
import { safeColumns } from "./safe-columns";
import { safeLayout } from "./safe-layout";
import { validHistory } from "./history-boundary";
import { spacingFor, STACK_STEM_ROOM } from "./metrics";
import { bandWidthBudget, columnsFor, partitions, buildShelves, validate } from "./band-shelves";
import { attachSingleBand, attachPackedBand, localBandPlacement, bandExtent, withBandBounds, singleBandSkeleton } from "./band-geometry";
import { measure, validateLayout, cost, routePlan, sharedLaneLength, type Measures, type Weights } from "./layout-quality";
import { incrementalBudget, incrementalTree, inReach, usableRetainedRoute } from "./band-incremental";
import { forEachPathNumber, mapPathNumbers, pathNumbers } from "./path-data";
import { extentCost, optimisticCost, rectangleCost } from "./layout-cost-bound";
import { bandHistorySignature, historyFit, historyRelayoutReason, resizedLayout, resizedTiles } from "./band-history";

export { bandWidthBudget };

export { bandHistorySignature };

/** Band policies that `layout-eval` and the registered engines compare (A/B); production uses {@link BAND_DEFAULTS}. */
export interface BandOptions {
  /** Keep committed history when the component grew (`band-history.ts`); otherwise it expires on any membership change. */
  readonly growthHistory: boolean;
  /** When the component grew, anchors yield (`anchor-yield`) if holding them makes the band this many times taller than the best unanchored layout; Infinity: never. */
  readonly anchorHeightRatio: number;
  /** How the downward layout orders each generation (`layout.ts`, `Ordering`). */
  readonly ordering: Ordering;
  /** How the downward layout's routes pass the rows between their ends (`layout.ts`, `Passing`). */
  readonly passing: Passing;
}
export const BAND_DEFAULTS: BandOptions = Object.freeze({ growthHistory: true, anchorHeightRatio: 1.5, ordering: "barycenter" as const, passing: "straight" as const });
/** The engine as merged in plan phase 3 (#79), for A/B comparison. */
export const BAND_PHASE3: BandOptions = Object.freeze({ growthHistory: false, anchorHeightRatio: Infinity, ordering: "barycenter" as const, passing: "nearest-end" as const });

/**
 * The committed history this request may build on, adjusted to the request's tile sizes;
 * whether it needed adjusting (`resized`); and whether the component itself changed since
 * (`grew`: images arrived or left), as opposed to a click on the same component.
 */
function fittedHistory(input: LayoutRequest, options: BandOptions): { readonly history?: import("./layout").BandHistory; readonly resized: boolean; readonly grew: boolean } {
  const none = { resized: false, grew: false };
  const history = input.history;
  if (!history || typeof history.signature !== "string" || !input.items.some(n => n.key === input.band!.key)) return none;
  const fit = historyFit(history.signature, input);
  if (!fit || (fit.kind === "grown" && !options.growthHistory)) return none;
  if (fit.kind === "same") return { history, ...none };
  if (!fit.heights.size) return { history, resized: false, grew: true };
  // With an attachment, the placed geometry is attached afresh from `layout` (`normalizedHistory`)
  // and never read, so only `layout` is resized. Geometry that cannot be resized in place keeps
  // only its tiles: they hold the band where it was while it is laid out again.
  const layout = resizedLayout(history.layout, fit.heights);
  const placed = history.attachment ? history.placed : layout && resizedLayout(history.placed, fit.heights);
  if (layout && placed) return { history: { ...history, layout, placed }, resized: true, grew: true };
  return { history: { ...history, layout: resizedTiles(history.layout, fit.heights), placed: resizedTiles(history.placed, fit.heights) }, resized: true, grew: true };
}

interface Candidate { readonly name: string; readonly layout: GraphLayout; readonly partition?: readonly number[] }
interface Prepared extends Candidate {
  readonly height: number;
  /** Whether attachment keeps the clicked tile and its visible ancestors where they were. */
  readonly holds: boolean;
  /** Admissible objective lower bound from attached rectangles and allocation alone. */
  readonly floor: number;
}
/** A candidate known by rectangles only: exact height for translations, a lower bound for the downward layout. */
interface Pending {
  readonly name: string;
  readonly partition?: readonly number[];
  readonly orientation: GraphLayout["orientation"];
  readonly height: number;
  readonly floor: number;
  readonly build: () => Candidate | null;
}
interface Scored extends Prepared { readonly placed: GraphLayout; readonly metrics: Measures; readonly score: number; readonly anchors: boolean }

/** Every retained arrival rectangle is a pin; selection and click ancestry are irrelevant. */
function anchorKeys(request: LayoutRequest, previous: GraphLayout): readonly string[] {
  return request.items.filter(n => previous.nodes.has(n.key)).map(n => n.key);
}

/** Keep a subset's embedding and trim trailing space; retained leading space has an explicit price. */
function projected(previous: GraphLayout, request: LayoutRequest): GraphLayout | null {
  const keys = new Set(request.items.map(n => n.key));
  if (!request.items.every(n => previous.nodes.has(n.key))) return null;
  const nodes = new Map([...previous.nodes].filter(([key]) => keys.has(key)));
  const routes = filterRouteConsumers(previous.routes, c => keys.has(c.parent) && keys.has(c.child));
  const joins = new Set(routes.flatMap(r => [r.from, r.to].filter(e => e.kind === "junction").map(e => e.id)));
  const extent = bandExtent(previous, request.band!.key);
  const first = Math.min(...[...previous.nodes.values()].filter(n => n.key !== request.band!.key).map(n => n.y));
  const bottom = Math.max(0, ...[...nodes.values()].map(n => n.y + n.height), ...routes.flatMap(r => pathNumbers(r.path).filter((_, i) => i % 2)));
  return { ...previous, nodes, routes, junctions: new Map([...previous.junctions].filter(([key]) => joins.has(key))),
    height: bottom + spacingFor(request.tileWidth).bottom,
    bandBounds: { left: extent.left, width: extent.width, top: previous.bandBounds?.top ?? (Number.isFinite(first) ? first : 0) }, preferredX: extent.left,
    readingOrder: new Map([...previous.readingOrder].filter(([key]) => keys.has(key))) };
}

/** A translation of a candidate onto the committed click anchor, known by rectangles before connectors are moved. */
interface AnchorShift {
  readonly dx: number;
  readonly dy: number;
  /**
   * Translated rectangles with the exact band height. Allocation is the
   * rectangles' envelope, a lower bound of the final connector envelope.
   */
  readonly skeleton: GraphLayout;
}

/** Whether the candidate can be translated onto the click anchor, decided from rectangles alone. */
function anchorShift(candidate: GraphLayout, request: LayoutRequest, previous: GraphLayout, anchors: readonly string[]): AnchorShift | null {
  const key = request.band!.key, focus = request.anchorKey;
  if (!focus || focus === key) return null;
  const origin = candidate.nodes.get(focus), oldOrigin = previous.nodes.get(focus);
  if (!origin || !oldOrigin) return null;
  // X attachment is one translation. Y attachment has separate cover-row and
  // child branches; only equal-branch relative Y differences prove infeasibility.
  const coverBottom = candidate.nodes.get(key)!.y + candidate.nodes.get(key)!.height;
  if (anchors.some(id => {
    if (id === key) return false;
    const next = candidate.nodes.get(id), old = previous.nodes.get(id);
    return !next || !old || Math.abs(next.x - origin.x - old.x + oldOrigin.x) >= .01
      || ((next.y <= coverBottom) === (origin.y <= coverBottom)
        && Math.abs(next.y - origin.y - old.y + oldOrigin.y) >= .01);
  })) return null;
  const attached = singleBandSkeleton(candidate, request), next = attached.nodes.get(focus);
  if (!next) return null;
  const dx = oldOrigin.x - next.x, dy = oldOrigin.y - next.y;
  if (Math.abs(dx) < .001 && Math.abs(dy) < .001) return null;
  const cover = attached.nodes.get(key)!;
  let first = Infinity, left = Infinity, right = -Infinity;
  const nodes = new Map<string, PlacedNode>();
  for (const [id, n] of attached.nodes) {
    if (id === key) { nodes.set(id, n); continue; }
    const moved = { ...n, x: n.x + dx, y: n.y + dy };
    nodes.set(id, moved);
    first = Math.min(first, moved.y);
    left = Math.min(left, moved.x - (candidate.orientation === "right" ? 16 : 0)); right = Math.max(right, moved.x + moved.width);
  }
  if (first < cover.height + STACK_STEM_ROOM - .01) return null;
  const top = cover.height + (request.history?.attachment?.placement.stemRoom ?? STACK_STEM_ROOM);
  return { dx, dy, skeleton: { ...attached, nodes, height: attached.height + dy,
    bandBounds: { left: Number.isFinite(left) ? left - 8 : cover.x, width: Number.isFinite(left) ? right - left + 16 : 0, top } } };
}

/**
 * Whether part of the anchored translation's connector envelope already leaves the pane: tiles,
 * and connectors not leaving the cover, which attachment and the anchor shift both translate in x
 * (monotone under rounding, so their extremes map to extremes). A subset of the coordinates
 * {@link anchoredLayout} checks, with a margin far above rounding, so it rules out only what that check would.
 */
function leavesPane(candidate: GraphLayout, shift: AnchorShift, key: string, limit: number): boolean {
  let left = Infinity, right = -Infinity, offset = NaN;
  const nudge = candidate.orientation === "right" ? 16 : 0;
  for (const [id, n] of shift.skeleton.nodes) {
    if (id === key) continue;
    left = Math.min(left, n.x - nudge); right = Math.max(right, n.x + n.width);
    if (offset !== offset) offset = n.x - shift.dx - candidate.nodes.get(id)!.x;
  }
  if (offset === offset) for (const route of candidate.routes) {
    if (route.from.kind === "node" && route.from.id === key) continue;
    let index = 0;
    forEachPathNumber(route.path, value => { if (!(index++ % 2)) { const x = value + offset + shift.dx; left = Math.min(left, x); right = Math.max(right, x); } });
  }
  return left - 8 < -1e-6 || right + 8 > limit + 1e-6;
}

/** The anchored translation with its connectors; null when its connector envelope leaves the pane. */
function anchoredLayout(candidate: GraphLayout, request: LayoutRequest, shift: AnchorShift): GraphLayout | null {
  const key = request.band!.key, { dx, dy } = shift, limit = Math.max(request.maxWidth, candidate.width) + .01;
  if (leavesPane(candidate, shift, key, limit)) return null;
  const placed = attachSingleBand(candidate, request);
  const cover = placed.nodes.get(key)!, coverX = cover.x + cover.width / 2;
  const routes = placed.routes.map(r => {
    const [x, y] = pathNumbers(r.path, 2);
    // A stem leaving the fixed cover keeps its start there; everything else shifts.
    const keepStart = r.from.kind === "node" && r.from.id === key && Math.abs(x - coverX) < .1 && Math.abs(y - cover.height) < .1;
    return { ...r, path: mapPathNumbers(r.path, (value, index) => keepStart && index < 2 ? (index ? cover.height : coverX) : value + (index % 2 ? dy : dx)) };
  });
  const provisional = { ...placed, bandBounds: undefined, nodes: shift.skeleton.nodes, routes,
    junctions: new Map([...placed.junctions].map(([id, j]) => [id, { ...j, x: j.x + dx, y: j.y + dy }])), height: shift.skeleton.height };
  const extent = bandExtent(provisional, key);
  if (extent.left < 0 || extent.left + extent.width > limit) return null;
  return { ...provisional, bandBounds: { left: extent.left, width: extent.width, top: shift.skeleton.bandBounds!.top }, preferredX: extent.left };
}

/** Lower bound of a downward embedding's band height: every child lies below its parent. */
function downwardHeightFloor(items: readonly LayoutItem[], key: string): number {
  const byKey = new Map<string, LayoutItem>();
  for (const n of items) byKey.set(n.key, n);
  const below = new Map<string, number>(), pending = new Map<string, number>(), children = new Map<string, string[]>(), ready: string[] = [];
  for (const n of items) {
    let count = 0;
    for (const p of n.parents) if (byKey.has(p)) { count++; const list = children.get(p); if (list) list.push(n.key); else children.set(p, [n.key]); }
    pending.set(n.key, count);
    if (!count) ready.push(n.key);
  }
  let best = 0;
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i], n = byKey.get(id)!;
    let deepest = 0;
    for (const p of n.parents) if (p !== key && byKey.has(p)) deepest = Math.max(deepest, below.get(p) ?? 0);
    const chain = (id === key ? 0 : n.height) + deepest;
    below.set(id, chain); best = Math.max(best, chain);
    for (const child of children.get(id) ?? []) { const left = pending.get(child)! - 1; pending.set(child, left); if (!left) ready.push(child); }
  }
  return best;
}

/**
 * The crossing cap. An anchor-preserving layout may cross more than the best unanchored one
 * by at most the larger of these (an absolute count, and a share of the unanchored layout's
 * crossings); beyond that the anchors yield (`anchor-yield`). Calibrated on the evaluation
 * corpus and legal tours (docs/trace-view-layout.md, "Crossing cap").
 */
const ANCHOR_CROSSING_SLACK = 50;
const ANCHOR_CROSSING_RATIO = .25;
const PRICED_LANES: Weights = Object.freeze({ stability: 1.5, sharedLanes: "priced" });

const NO_COST: Measures = { height: 0, width: 0, area: 0, tileArea: 0, whitespace: 0, paneWhitespace: 0, length: 0, bends: 0, crossings: 0, sharedLanePx: 0,
  tileIntersections: 0, overlaps: 0, directionViolations: 0, mixedDirections: 0, siblingInversions: 0, unaligned: 0, overflow: 0, displacement: 0,
  maxDisplacement: 0, movedFraction: 0, anchorDisplacement: 0, missingEdges: 0, extraEdges: 0, missingNodes: 0, extraNodes: 0, invalidGeometry: 0,
  invalidPaths: 0, terminalViolations: 0, disconnectedEdges: 0 };

/**
 * Objective share of the connectors attachment moves rigidly: routes not leaving the
 * cover whose every point lies below it are only translated, so their ink and turning
 * survive attachment (to float rounding). Lets a candidate be pruned before it is attached.
 * Zero when a route is unparsable (the attached bound then certifies nothing either).
 */
function rigidConnectorCost(layout: GraphLayout, key: string, tileWidth: number): number {
  const cover = layout.nodes.get(key);
  if (!cover || !layout.bandBounds) return 0;
  const bottom = cover.y + cover.height;
  let length = 0, bends = 0;
  for (const route of layout.routes) {
    const plan = routePlan(route);
    if (!Number.isFinite(plan.length) || !Number.isFinite(plan.bends)) return 0;
    if ((route.from.kind === "node" && route.from.id === key) || !(plan.bounds.minY > bottom)) continue;
    length += plan.length; bends += plan.bends;
  }
  return cost({ ...NO_COST, length, bends }, tileWidth);
}

/** Undo only the row's packing offset; x and every committed relative tile position survive. */
function normalizedHistory(history: import("./layout").BandHistory, request: LayoutRequest): GraphLayout {
  const key = request.band!.key, cover = history.layout.nodes.get(key);
  if (!cover || !history.attachment) return history.placed;
  return attachPackedBand(history.layout, key, cover.height, localBandPlacement(history.attachment.placement, cover.height));
}

/** Machine-readable decisions retain a concise diagnostic for the view and evaluator. */
export function fallbackReason(layout: GraphLayout): string | null {
  const reason = layout.decision?.fallback;
  if (reason === "gate-infeasible" && layout.pinnedViolation) return "gate-infeasible: malformed cover placement";
  if (reason === "geometry-fallback") return "geometry-fallback: rejected geometry; certified wider channels or isolated rows";
  if (reason === "invalid-history") return "invalid-history: discarded malformed or unsafe committed geometry";
  return reason ? `${reason}: no accepted candidate preserves the requested placement` : null;
}

export function layoutBand(input: LayoutRequest, options: BandOptions = BAND_DEFAULTS): GraphLayout {
  const invalid = input?.history !== undefined && !validHistory(input.history, input.band?.key ?? "");
  let request = input ? { ...input, history: invalid ? undefined : input.history, maxWidth: Number.isFinite(input.maxWidth) && input.maxWidth > 0 ? Math.min(100_000, input.maxWidth) : bandWidthBudget(input.maxWidth, input.tileWidth) } : input;
  if (request?.pinned && Array.isArray(request.items)) {
    const half = (request.items.find(n => n?.key === request.pinned!.key)?.width ?? request.tileWidth ?? 92) / 2;
    const x = Number.isFinite(request.pinned.x) ? request.pinned.x : request.maxWidth / 2;
    request = { ...request, pinned: { ...request.pinned, x: Math.max(half, Math.min(request.maxWidth - half, x)) } };
  }
  let result = layoutBandCandidates(request, options);
  if (request.items.length && geometryGate(attachSingleBand(result, request), request.items, request.band!.key, request.maxWidth)) {
    let replacement: GraphLayout | undefined;
    for (const scale of [1.5, 2, 3]) {
      const candidate = withBandBounds(layoutLayered({ ...request, history: undefined, band: undefined, tileWidth: (request.tileWidth ?? 92) * scale, orientation: "down" }, { ordering: options.ordering, passing: options.passing, channelStyle: "orthogonal" }), request.band!.key);
      if (!geometryGate(attachSingleBand(candidate, request), request.items, request.band!.key, request.maxWidth)) {
        replacement = { ...candidate, decision: { candidate: "wide-channels", stability: false, fallback: "geometry-fallback" } }; break;
      }
    }
    if (!replacement) {
      const chain = safeChain(request);
      if (chain && !geometryGate(attachSingleBand(chain, request), request.items, request.band!.key, request.maxWidth)) replacement = chain;
    }
    if (!replacement) {
      const fan = safeFanGrid(request);
      if (fan && !geometryGate(attachSingleBand(fan, request), request.items, request.band!.key, request.maxWidth)) replacement = fan;
    }
    if (!replacement) {
      const columns = safeColumns(request);
      if (!geometryGate(attachSingleBand(columns, request), request.items, request.band!.key, request.maxWidth)) replacement = columns;
    }
    result = replacement ?? safeLayout(request);
    const failure = geometryGate(attachSingleBand(result, request), request.items, request.band!.key, request.maxWidth);
    if (failure) throw new RangeError("No certified layout: " + failure);
  }
  if (result.pinnedViolation) result = { ...result, decision: { ...result.decision!, fallback: "gate-infeasible" } };
  const relayout = !invalid && input.history ? historyRelayoutReason(input.history.signature,input) : undefined;
  if (relayout) result = {...result,decision:{...result.decision!,relayout}};
  return invalid ? { ...result, decision: { ...result.decision!, fallback: "invalid-history" } } : result;
}

function layoutBandCandidates(input: LayoutRequest, options: BandOptions): GraphLayout {
  if (!input || !Array.isArray(input.items) || !input.band) throw new RangeError("malformed band request");
  validate(input.items);
  if (input.tileWidth !== undefined && (!Number.isFinite(input.tileWidth) || input.tileWidth <= 0 || input.tileWidth > 100_000)) throw new RangeError("invalid tile metrics");
  const width = bandWidthBudget(input.maxWidth, input.tileWidth);
  const keys = new Set(input.items.map(n => n.key));
  const fitted = fittedHistory(input, options);
  let request: LayoutRequest = { ...input, history: fitted.history, maxWidth: Number.isFinite(input.maxWidth) && input.maxWidth > 0 ? Math.min(100_000, input.maxWidth) : width,
    items: input.items.map(n => ({ ...n, parents: [...new Set(n.parents)].filter(p => keys.has(p)) })).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)) };
  const key = request.band!.key;
  if (request.pinned) {
    const half = (request.items.find(n => n.key === request.pinned!.key)?.width ?? request.tileWidth ?? 92) / 2;
    const x = Number.isFinite(request.pinned.x) ? request.pinned.x : request.maxWidth / 2;
    request = { ...request, pinned: { ...request.pinned, x: Math.max(half, Math.min(request.maxWidth - half, x)) } };
  }
  if (!request.items.length) return { orientation: "down", width, height: 0, nodes: new Map(), routes: [], junctions: new Map(), rows: [], readingOrder: new Map(), decision: { candidate: "empty", stability: false } };
  if (request.items.length === 1 && request.items[0].key === key) {
    const item = request.items[0], canvasWidth = Math.max(width, request.maxWidth, item.width);
    const x = Math.max(item.width / 2, Math.min(canvasWidth - item.width / 2, request.pinned?.x ?? canvasWidth / 2));
    return { orientation: "down", width: canvasWidth, height: item.height,
      nodes: new Map([[key, { key, x: x - item.width / 2, y: 0, width: item.width, height: item.height, row: 0, band: 0 }]]),
      routes: [], junctions: new Map(), rows: [], readingOrder: new Map([[key, 0]]), decision: { candidate: "cover", stability: false } };
  }
  const compatible = request.history;
  const previous = compatible?.attachment ? normalizedHistory(compatible, request) : compatible?.placed;
  const anchors = previous ? anchorKeys(request, previous) : [];
  // Unchanged geometry is kept as is, unless it shares lanes between sources (an
  // earlier fallback): then the search below looks for a layout that does not. When the
  // visible tiles are the same but some gained or lost their expansion hint (an output arrived
  // or left out of sight), the committed geometry was resized in place; it is kept the same way
  // if it passes the hard gates, since nothing more became visible to make room for.
  if (previous && request.items.length === previous.nodes.size && request.items.every(n => {
    const p = previous.nodes.get(n.key);
    return p && p.width === n.width && p.height === n.height;
  }) && !(sharedLaneLength(previous) > 0)
    && (!fitted.resized || Number.isFinite(cost(validateLayout(previous, key, request.maxWidth, request.items), request.tileWidth ?? 92)))) {
    const retained = request.history!.layout;
    if (retained) return { ...retained, preferredX: bandExtent(previous, key).left, anchorY: anchors.length && compatible?.attachment ? compatible.attachment.bandTop - compatible.attachment.placement.coverHeight : undefined, anchorX: anchors.length ? bandExtent(previous, key).left : undefined, decision: { candidate: fitted.resized ? "resized-visible" : "unchanged-visible", stability: true, partition: request.history?.layout.decision?.partition } };
  }
  const tileWidth = request.tileWidth ?? 92;
  const prepare = (c: Candidate): Prepared => {
    // Rectangles and allocation translate exactly with attachment; connectors are
    // attached only for candidates whose rectangle-only bound survives pruning.
    const skeleton = singleBandSkeleton(c.layout, request);
    const holds = anchors.every(id => {
      const a = skeleton.nodes.get(id), b = previous?.nodes.get(id);
      return !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < .01;
    });
    return { ...c, height: bandExtent(skeleton, key).height, holds,
      floor: rectangleCost(skeleton, key, request.maxWidth, tileWidth, request.items, previous, request.anchorKey) };
  };
  const byHeight = (a: { height: number }, b: { height: number }) => a.height - b.height;

  // Constructive candidates. Shelves are cheap; the downward layered layout is
  // built only when its height or objective lower bound leaves it a chance.
  const shelves: Candidate[] = [];
  const columns = columnsFor(request.items, key, spacingFor(request.tileWidth).column);
  const chain = !!columns && columns.length >= 2 && columns.every(c => c.items.length === 1);
  if (columns && columns.length >= 2) {
    const plans = partitions(columns, request);
    for (const ends of chain ? plans.slice(0, 1) : plans) {
      const layout = buildShelves(request, columns, ends);
      if (layout) shelves.push({ name: "top-shelves", layout: withBandBounds(layout, key), partition: ends });
    }
  }
  // A serial chain's bounded shelves dominate its one-tile downward column.
  // Keep downward routing when shelves cannot fit, or anchors need another embedding.
  const wantsDown = !chain || !shelves.length || !!previous;
  const downFloor = wantsDown ? downwardHeightFloor(request.items, key) : Infinity;
  // The downward layout's display rows bound its height, width and tree ink before it is
  // routed. An anchored translation keeps width and ink; its first row can rise only into
  // stem room beyond the default, so its height bound gives up exactly that.
  // Bounds of the downward layout as built below: at the band's own width budget.
  const rows = wantsDown ? downwardBandBound({ ...request, maxWidth: width }, key, STACK_STEM_ROOM, { channelStyle: "orthogonal" }) : null;
  const rowsHeight = rows ? Math.max(downFloor, rows.height) : downFloor;
  const shiftedRowsHeight = rows ? Math.max(downFloor, rows.height - Math.max(0, (request.history?.attachment?.placement.stemRoom ?? STACK_STEM_ROOM) - STACK_STEM_ROOM) - .01) : downFloor;
  let down: Candidate | undefined;
  const visibleDown = (): Candidate => down ??= (() => {
    const half = (request.items.find(n => n.key === request.pinned?.key)?.width ?? 0) / 2;
    const pin = request.pinned ? { ...request.pinned, x: Math.max(half, Math.min(width - half, request.pinned.x)) } : undefined;
    const layout = layoutLayered({ ...request, pinned: pin, history: undefined, band: undefined, maxWidth: width, orientation: "down" }, { ordering: options.ordering, passing: options.passing, channelStyle: "orthogonal" });
    return { name: "visible-down", layout: withBandBounds(request.items.length === 2 && request.items.some(n => n.key !== key && n.parents.length === 1 && n.parents[0] === key) ? { ...layout, preferredX: 0 } : layout, key) };
  })();
  const history: Candidate[] = [];
  if (previous) {
    // One grid-work budget for every incremental embedding this request tries.
    const budget = incrementalBudget();
    const incremental = incrementalTree(request, previous, budget);
    if (incremental) history.push({ name: "incremental-tree", layout: incremental });
    // With nothing new to place, the retained tiles as they are (`retained-visible`).
    const retained = projected(previous, request);
    // Re-embed other retained tiles around the anchors when there is no fixed warm embedding
    // (the incremental one failed) or it exceeds the compact height budget (shelves and the
    // downward layout); otherwise its zero displacement is valuable. With nothing new to place,
    // the warm embedding is the retained geometry itself, if it passes the hard gates as the
    // unchanged geometry must above. Build the downward layout only if its height decides.
    const fixed = new Set([...anchors, key]);
    if (anchors.length && fixed.size < previous.nodes.size) {
      const warm = incremental ?? (retained && !(sharedLaneLength(retained) > 0)
        && (!fitted.resized || Number.isFinite(cost(validateLayout(retained, key, request.maxWidth, request.items), tileWidth))) ? retained : null);
      const compactShelf = Math.min(...shelves.map(c => bandExtent(c.layout, key).height));
      const height = warm ? bandExtent(warm, key).height : Infinity;
      const repack = !warm || height > compactShelf * 1.1
        || (wantsDown && height > rowsHeight * 1.1 && height > bandExtent(visibleDown().layout, key).height * 1.1);
      const subset = repack ? projected(previous, { ...request, items: request.items.filter(n => fixed.has(n.key)) }) : null;
      const compact = subset && incrementalTree(request, { ...subset, bandBounds: undefined, anchorX: undefined, anchorY: undefined }, budget);
      if (compact) history.push({ name: "anchored-repack", layout: compact });
    }
    if (retained) history.push({ name: "retained-visible", layout: retained, partition: request.history?.layout.decision?.partition });
  }

  const placements = new Map<GraphLayout, GraphLayout>();
  const placementFor = (c: Candidate) => {
    const found = placements.get(c.layout);
    if (found) return found;
    const placed = attachSingleBand(c.layout, request); placements.set(c.layout, placed); return placed;
  };
  const evaluate = (c: Candidate) => measure(placementFor(c), key, request.maxWidth, request.items, previous, request.anchorKey);
  // Gate results: hard gates only, or complete metrics once a candidate has been ranked.
  const gates = new Map<GraphLayout, { readonly metrics: Measures; readonly complete: boolean }>();
  const gate = (c: Prepared, complete: boolean) => {
    const known = gates.get(c.layout);
    if (known && (known.complete || !complete)) return known.metrics;
    let metrics = complete ? evaluate(c) : validateLayout(placementFor(c), key, request.maxWidth, request.items);
    if (routeClearanceViolation(placementFor(c))) metrics = { ...metrics, invalidGeometry: metrics.invalidGeometry + 1 };
    gates.set(c.layout, { metrics, complete });
    return metrics;
  };
  const feasible = (m: Measures) => Number.isFinite(cost(m, tileWidth));

  // A certified pinned solution wins before soft compactness/crossing objectives.
  // Keep the pane-bounded construction whenever it can preserve the retained tiles.
  if (previous) {
    const pins = (layout: GraphLayout) => request.items.every(item => {
      const old = previous.nodes.get(item.key), now = layout.nodes.get(item.key);
      return !old || !!now && old.x === now.x && old.y === now.y && old.width === now.width && old.height === now.height;
    });
    const pinned = history.filter(c => pins(placementFor(c)) && !geometryGate(placementFor(c), request.items, key, request.maxWidth));
    const added = request.items.filter(n => !previous.nodes.has(n.key));
    if (added.length && !pinned.length) {
      const edge = [...previous.nodes.values()].reduce((right, n) => Math.max(right, n.x + n.width), request.maxWidth);
      const extra = added.reduce((sum, n) => sum + n.width + 48, 48);
      const extended = incrementalTree({ ...request, maxWidth: Math.min(100_000, edge + extra) }, previous, incrementalBudget());
      if (extended) {
        const c = { name: "pinned-extension", layout: extended };
        if (pins(placementFor(c)) && !geometryGate(placementFor(c), request.items, key, request.maxWidth)) pinned.unshift(c);
      }
    }
    if (pinned.length) return { ...pinned[0].layout, decision: { candidate: pinned[0].name, stability: true } };
  }

  const prepared: Prepared[] = [...shelves, ...history].map(prepare);
  const lazy: Pending[] = [];
  /** The downward layout before it is built: a height lower bound and the objective bound it implies. */
  /** The downward layout before it is built: lower bounds of its (and, with anchors, its translations') height and objective. */
  const downPending = (height: number): Pending => ({ name: "visible-down", orientation: "down", height,
    floor: extentCost(height, Math.max(rows?.width ?? 0, ...request.items.filter(n => n.key !== key).map(n => n.width)), request.maxWidth, tileWidth, rows?.length), build: visibleDown });
  let minimumFeasibleHeight = Infinity;
  if (!anchors.length) {
    // Exact cold semantics: the shortest feasible embedding sets the compact
    // height budget. The downward layout is skipped only when it provably exceeds it.
    // Gating checks hard constraints only; ranking evaluates the soft terms of eligible candidates.
    const firstFeasible = (list: readonly Prepared[]) => {
      for (const c of [...list].sort(byHeight)) if (Number.isFinite(c.floor) && feasible(gate(c, false))) return c.height;
      return Infinity;
    };
    // Build the downward layout up front when it may be the shortest: it then sets the budget.
    const shortest = Math.min(...prepared.map(c => c.height));
    if (wantsDown && rowsHeight < shortest) prepared.unshift(prepare(visibleDown()));
    minimumFeasibleHeight = firstFeasible(prepared);
    if (wantsDown && !down) {
      if (rowsHeight < minimumFeasibleHeight) {
        prepared.unshift(prepare(visibleDown()));
        minimumFeasibleHeight = firstFeasible(prepared);
      // Otherwise it cannot lower the budget; it matters only if eligible and able to beat the ranked scores.
      } else if (!(rowsHeight > minimumFeasibleHeight * 1.1 + .01)) lazy.push(downPending(rowsHeight));
    }
  } else {
    // Translations onto the click anchor, and the downward family, stay rectangles until needed.
    if (wantsDown) {
      if (down) prepared.unshift(prepare(down));
      else lazy.push(downPending(shiftedRowsHeight));
    }
    for (const c of prepared) lazy.push(...anchoredPending(c));
  }
  prepared.sort(byHeight);

  function anchoredPending(c: Candidate): Pending[] {
    const shift = anchorShift(c.layout, request, previous!, anchors);
    if (!shift) return [];
    // The translation moves the candidate's connectors below the cover rigidly, so their cost bounds it too.
    const rectangles = rectangleCost(shift.skeleton, key, request.maxWidth, tileWidth, request.items, previous, request.anchorKey);
    return [{ name: `anchored-${c.name}`, partition: c.partition, orientation: c.layout.orientation, height: bandExtent(shift.skeleton, key).height,
      floor: rectangles && (rectangles + rigidConnectorCost(c.layout, key, tileWidth)) * (1 - 1e-9),
      build: () => { const layout = anchoredLayout(c.layout, request, shift); return layout ? { name: `anchored-${c.name}`, layout, partition: c.partition } : null; } }];
  }
  /** Build a pending candidate once, adding it (and, for a fresh embedding, its anchored translation) to the known set. */
  const realised = new Set<Pending>();
  function realise(p: Pending): void {
    if (realised.has(p)) return;
    realised.add(p);
    const built = p.build();
    if (!built) return;
    const c = prepare(built);
    prepared.push(c);
    if (p.name === "visible-down" && anchors.length) lazy.push(...anchoredPending(c));
  }

  // Candidates kept out only by shared lanes, priced instead, for when no candidate avoids them.
  const laneScored: Scored[] = [];
  const eligible = (c: Prepared) => Number.isFinite(c.floor) && (anchors.length > 0 || c.height <= minimumFeasibleHeight * 1.1 + .01)
    && (!gates.has(c.layout) || feasible(gates.get(c.layout)!.metrics));
  const scored: Scored[] = [];
  // Best anchor-preserving scores, split by whether they keep the committed orientation.
  let bestAnchored = Infinity, bestSame = Infinity, bestTurned = Infinity;
  // The score below which a candidate could still change the choice, given the
  // orientation rule at the end: a turn must beat the best same-orientation score by 15%.
  const threshold = (orientation: GraphLayout["orientation"]) => !previous ? bestAnchored
    : orientation === previous.orientation ? Math.min(bestSame, bestTurned / .85) : Math.min(bestTurned, bestSame * .85);
  // Every cost term is nonnegative, so a lower bound above the threshold proves
  // a candidate cannot change the outcome without building or evaluating its connectors.
  const beaten = (floor: number, orientation: GraphLayout["orientation"]) => floor > threshold(orientation) + 1e-7;
  const consider = (c: Prepared) => {
    if (!eligible(c) || beaten(c.floor, c.layout.orientation)) return;
    // Rectangles plus rigidly moved connectors, slightly shaded for rounding: attach only if it may still win.
    if (Number.isFinite(bestAnchored) && !placements.has(c.layout)
      && beaten((c.floor + rigidConnectorCost(c.layout, key, tileWidth)) * (1 - 1e-9), c.layout.orientation)) return;
    const placed = placementFor(c);
    if (Number.isFinite(bestAnchored) && beaten(optimisticCost(placed, key, request.maxWidth, tileWidth, request.items, previous, request.anchorKey), c.layout.orientation)) return;
    const known = gates.get(c.layout);
    const metrics = known && (known.complete || !previous && !lazy.length && prepared.filter(eligible).length === 1) ? known.metrics : gate(c, true);
    const score = cost(metrics, tileWidth);
    if (!Number.isFinite(score)) {
      const priced = cost(metrics, tileWidth, PRICED_LANES);
      if (Number.isFinite(priced)) laneScored.push({ ...c, placed, metrics, score: priced, anchors: c.holds });
      return;
    }
    scored.push({ ...c, placed, metrics, score, anchors: c.holds });
    minimumFeasibleHeight = Math.min(minimumFeasibleHeight, metrics.height);
    if (!c.holds) return;
    bestAnchored = Math.min(bestAnchored, score);
    if (previous && c.layout.orientation === previous.orientation) bestSame = Math.min(bestSame, score); else bestTurned = Math.min(bestTurned, score);
  };
  const byFloor = (a: { floor: number; height: number }, b: { floor: number; height: number }) => a.floor - b.floor || a.height - b.height;
  // Anchor-preserving embeddings win whenever one is feasible, so the others are
  // evaluated only when none is. Without anchors every candidate preserves them.
  // Pending candidates are anchored translations or the downward layout, assumed to hold until built.
  // Candidates are taken in order of their lower bounds, except that anchored translations
  // wait for a first score: building one costs an attachment, and that score usually prunes them.
  // In a downward layout every tile lies below its ancestors (the cover alone heads it when
  // `rows` exists). The click anchor's anchored ancestors are its ancestors, so if one of them was
  // not above it, the downward layout can neither hold the anchors nor be translated onto them:
  // it then matters only when nothing holds, and is built only in that case.
  const focusAt = request.anchorKey ? previous?.nodes.get(request.anchorKey) : undefined;
  const downAnchors = !(rows && focusAt && anchors.some(id => id !== key && id !== request.anchorKey && !((previous!.nodes.get(id)?.y ?? Infinity) < focusAt.y)));
  const done = new Set<Prepared | Pending>();
  const open = (c: Prepared | Pending) => !done.has(c) && ("build" in c ? Number.isFinite(bestAnchored) || c.name === "visible-down" && downAnchors : c.holds);
  for (;;) {
    const next = [...prepared, ...lazy].filter(open).sort(byFloor)[0] ?? lazy.filter(c => !done.has(c)).sort(byFloor)[0];
    if (!next) break;
    done.add(next);
    if (!("build" in next)) consider(next);
    else if (!beaten(next.floor, next.orientation) && (downAnchors || next.name !== "visible-down" || !Number.isFinite(bestAnchored))) realise(next);
  }
  if (!Number.isFinite(bestAnchored)) {
    for (let i = 0; i < lazy.length; i++) realise(lazy[i]);
    for (const c of prepared.filter(c => !c.holds).sort(byFloor)) consider(c);
  }
  // No candidate is lane-free: the gates kept every one out, so none was ranked. Price the
  // lanes of those that fail on lanes alone and show the best of them (`lane-infeasible`).
  if (!scored.length && !laneScored.length) {
    for (let i = 0; i < lazy.length; i++) realise(lazy[i]);
    if (wantsDown) visibleDown();
    if (down && !prepared.some(c => c.layout === down!.layout)) prepared.push(prepare(down));
    for (const c of [...prepared].sort(byFloor)) {
      if (!Number.isFinite(c.floor)) continue;
      const metrics = gate(c, true), priced = cost(metrics, tileWidth, PRICED_LANES);
      if (Number.isFinite(priced)) laneScored.push({ ...c, placed: placementFor(c), metrics, score: priced, anchors: c.holds });
    }
  }
  // Malformed input (a cover with a visible parent) can defeat every candidate. Show the
  // downward layout, flagged, rather than no graph at all.
  // When every candidate shares lanes between sources, the best of them is shown, flagged.
  const lanesShared = !scored.length && laneScored.length > 0;
  const ranked = lanesShared ? laneScored : scored;
  if (!ranked.length) return { ...visibleDown().layout, decision: { candidate: "visible-down", stability: false, fallback: "gate-infeasible" } };
  const holding = ranked.filter(c => c.anchors);
  const preserving = holding.length ? holding : ranked;
  const minimumHeight = anchors.length || lanesShared ? Math.min(...ranked.map(c => c.metrics.height)) : minimumFeasibleHeight;
  const compact = preserving.filter(c => c.metrics.height <= minimumHeight * 1.1 + .01);
  const pool = anchors.length && holding.length ? preserving : compact.length ? compact : preserving;
  pool.sort((a, b) => a.score - b.score);
  let winner = pool[0];
  // A direction switch must earn a visible quality saving, not a rounding-sized difference.
  const same = previous && pool.filter(c => c.layout.orientation === previous.orientation).sort((a, b) => a.score - b.score)[0];
  if (same && winner.layout.orientation !== same.layout.orientation && winner.score > same.score * .85) winner = same;
  const yielded = false;
  let stability = !yielded && !!previous && (winner.metrics.height > minimumHeight * 1.1 || winner.name.startsWith("anchored") || winner.name === "retained-visible" || winner.name === "incremental-tree");
  // A shorter safe embedding may have been pruned because it moved an anchor.
  // Its existence still explains a height-for-stability exception; certify only
  // the hard constraints needed for that diagnostic, without rescoring routes.
  if (!stability && !yielded && previous && anchors.length) {
    const checked = new Set<Prepared | Pending>();
    for (;;) {
      const c = [...prepared, ...lazy].filter(c => !checked.has(c) && c.height * 1.1 + .01 < winner.metrics.height).sort(byHeight)[0];
      if (!c) break;
      checked.add(c);
      // A pending height is exact for translations and a lower bound for the downward layout.
      if ("build" in c) { realise(c); continue; }
      if (!Number.isFinite(c.floor)) continue;
      if (feasible(ranked.find(s => s.layout === c.layout)?.metrics ?? gate(c, false))) { stability = true; break; }
    }
  }
  return { ...winner.layout, anchorY: anchors.length && winner.anchors && compatible?.attachment ? compatible.attachment.bandTop - compatible.attachment.placement.coverHeight : undefined, anchorX: anchors.length && winner.anchors ? bandExtent(winner.placed, key).left : undefined, decision: { candidate: winner.name, partition: winner.partition, stability,
    ...(lanesShared ? { fallback: "lane-infeasible" as const } : yielded ? { fallback: "anchor-yield" as const } : anchors.length && !winner.anchors ? { fallback: "anchor-infeasible" as const } : {}) } };
}
