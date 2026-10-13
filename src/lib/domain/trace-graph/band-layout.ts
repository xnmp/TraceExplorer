/** Visible-first, bounded band optimisation. Geometry and history are immutable inputs. */
import { layoutLayered, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedNode } from "./layout";
import { spacingFor, STACK_STEM_ROOM } from "./metrics";
import { bandWidthBudget, columnsFor, partitions, buildShelves, validate } from "./band-shelves";
import { attachSingleBand, attachPackedBand, localBandPlacement, bandExtent, withBandBounds, singleBandSkeleton } from "./band-geometry";
import { measure, validateLayout, cost, type Measures } from "./layout-quality";
import { incrementalTree } from "./band-incremental";
import { isPlainPathData, mapPathNumbers, pathNumbers } from "./path-data";
import { extentCost, optimisticCost, rectangleCost } from "./layout-cost-bound";

export { bandWidthBudget };

/** Geometry-compatible history expires on membership, relationships, width, pin or metrics changes. */
export function bandHistorySignature(request: LayoutRequest): string {
  return JSON.stringify([request.maxWidth, request.tileWidth, request.pinned,
    [...(request.band?.items ?? request.items)].sort((a, b) => a.key.localeCompare(b.key)).map(n => [n.key, n.width, n.height, n.order, [...new Set(n.parents)].sort()])]);
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

/** Click ancestry is a hard preference among the feasible constructive candidates. */
function anchorKeys(request: LayoutRequest, previous: GraphLayout): readonly string[] {
  const byKey = new Map(request.items.map(n => [n.key, n]));
  const found = new Set<string>();
  const pending = request.anchorKey && previous.nodes.has(request.anchorKey) ? [request.anchorKey] : [];
  for (let i = 0; i < pending.length; i++) {
    const key = pending[i];
    if (found.has(key) || !byKey.has(key)) continue;
    found.add(key);
    pending.push(...byKey.get(key)!.parents);
  }
  return [...found];
}

/** Keep a subset's embedding and trim trailing space; retained leading space has an explicit price. */
function projected(previous: GraphLayout, request: LayoutRequest): GraphLayout | null {
  const keys = new Set(request.items.map(n => n.key));
  if (!request.items.every(n => previous.nodes.has(n.key))) return null;
  const nodes = new Map([...previous.nodes].filter(([key]) => keys.has(key)));
  const routes = previous.routes.filter(r => r.consumers.some(c => keys.has(c.parent) && keys.has(c.child)))
    .map(r => ({ ...r, consumers: r.consumers.filter(c => keys.has(c.parent) && keys.has(c.child)) }));
  const joins = new Set(routes.flatMap(r => [r.from, r.to].filter(e => e.kind === "junction").map(e => e.id)));
  const extent = bandExtent(previous, request.band!.key);
  const first = Math.min(...[...previous.nodes.values()].filter(n => n.key !== request.band!.key).map(n => n.y));
  const bottom = Math.max(0, ...[...nodes.values()].map(n => n.y + n.height), ...routes.flatMap(r => pathNumbers(r.path).filter((_, i) => i % 2)));
  return { ...previous, nodes, routes, junctions: new Map([...previous.junctions].filter(([key]) => joins.has(key))),
    height: bottom + spacingFor(request.tileWidth).bottom,
    bandBounds: { left: extent.left, width: extent.width, top: Number.isFinite(first) ? first : 0 }, preferredX: extent.left,
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

/** The anchored translation with its connectors; null when its connector envelope leaves the pane. */
function anchoredLayout(candidate: GraphLayout, request: LayoutRequest, shift: AnchorShift): GraphLayout | null {
  const key = request.band!.key, { dx, dy } = shift;
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
  if (extent.left < 0 || extent.left + extent.width > Math.max(request.maxWidth, candidate.width) + .01) return null;
  return { ...provisional, bandBounds: { left: extent.left, width: extent.width, top: shift.skeleton.bandBounds!.top }, preferredX: extent.left };
}

/** Lower bound of a downward embedding's band height: every child lies below its parent. */
function downwardHeightFloor(items: readonly LayoutItem[], key: string): number {
  const byKey = new Map(items.map(n => [n.key, n]));
  const below = new Map<string, number>(), pending = new Map(items.map(n => [n.key, n.parents.filter(p => byKey.has(p)).length]));
  const children = new Map<string, string[]>();
  for (const n of items) for (const p of n.parents) if (byKey.has(p)) children.set(p, [...(children.get(p) ?? []), n.key]);
  const ready = items.filter(n => !pending.get(n.key)).map(n => n.key);
  let best = 0;
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i], n = byKey.get(id)!;
    const chain = (id === key ? 0 : n.height) + Math.max(0, ...n.parents.filter(p => p !== key && byKey.has(p)).map(p => below.get(p) ?? 0));
    below.set(id, chain); best = Math.max(best, chain);
    for (const child of children.get(id) ?? []) { pending.set(child, pending.get(child)! - 1); if (!pending.get(child)) ready.push(child); }
  }
  return best;
}

/** History is plain committed geometry; anything non-finite or unparsable is treated as no history. */
function usableHistory(history: import("./layout").BandHistory): boolean {
  const finite = (...values: readonly (number | undefined)[]) => values.every(v => v === undefined || Number.isFinite(v));
  const geometry = (layout: GraphLayout | undefined) => !!layout && [...layout.nodes.values()].every(n => finite(n.x, n.y, n.width, n.height))
    && layout.routes.every(r => isPlainPathData(r.path)) && [...layout.junctions.values()].every(j => finite(j.x, j.y));
  const a = history.attachment;
  return geometry(history.layout) && geometry(history.placed) && (!a || finite(a.bandTop, a.placement.x, a.placement.coverX,
    a.placement.coverHeight, a.placement.width, a.placement.left, a.placement.right, a.placement.track, a.placement.stemRoom,
    a.placement.bridge?.top, a.placement.bridge?.gutter, ...(a.placement.coverColumns ?? []), ...(a.placement.bypassColumns ?? [])));
}

/** Undo only the row's packing offset; x and every committed relative tile position survive. */
function normalizedHistory(history: import("./layout").BandHistory, request: LayoutRequest): GraphLayout {
  const key = request.band!.key, cover = history.layout.nodes.get(key);
  if (!cover || !history.attachment) return history.placed;
  return attachPackedBand(history.layout, key, cover.height, localBandPlacement(history.attachment.placement, cover.height));
}

export function layoutBand(input: LayoutRequest): GraphLayout {
  if (!input || !Array.isArray(input.items) || !input.band) throw new RangeError("malformed band request");
  validate(input.items);
  if (input.tileWidth !== undefined && (!Number.isFinite(input.tileWidth) || input.tileWidth <= 0 || input.tileWidth > 100_000)) throw new RangeError("invalid tile metrics");
  const width = bandWidthBudget(input.maxWidth, input.tileWidth);
  const keys = new Set(input.items.map(n => n.key));
  let request: LayoutRequest = { ...input, history: input.history && input.history.signature === bandHistorySignature(input) && input.items.some(n => n.key === input.band!.key) && usableHistory(input.history) ? input.history : undefined, maxWidth: Number.isFinite(input.maxWidth) && input.maxWidth > 0 ? Math.min(100_000, input.maxWidth) : width,
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
  if (previous && request.items.length === previous.nodes.size && request.items.every(n => {
    const p = previous.nodes.get(n.key);
    return p && p.width === n.width && p.height === n.height;
  })) {
    const retained = input.history!.layout;
    if (retained) return { ...retained, preferredX: bandExtent(previous, key).left, anchorY: anchors.length && compatible?.attachment ? compatible.attachment.bandTop - compatible.attachment.placement.coverHeight : undefined, anchorX: anchors.length ? bandExtent(previous, key).left : undefined, decision: { candidate: "unchanged-visible", stability: true, partition: input.history?.layout.decision?.partition } };
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
  let down: Candidate | undefined;
  const visibleDown = (): Candidate => down ??= (() => {
    const half = (request.items.find(n => n.key === request.pinned?.key)?.width ?? 0) / 2;
    const pin = request.pinned ? { ...request.pinned, x: Math.max(half, Math.min(width - half, request.pinned.x)) } : undefined;
    const layout = layoutLayered({ ...request, pinned: pin, history: undefined, band: undefined, maxWidth: width, orientation: "down" });
    return { name: "visible-down", layout: withBandBounds(request.items.length === 2 && request.items.some(n => n.key !== key && n.parents.length === 1 && n.parents[0] === key) ? { ...layout, preferredX: 0 } : layout, key) };
  })();
  const history: Candidate[] = [];
  if (previous) {
    const incremental = incrementalTree(request, previous);
    if (incremental) history.push({ name: "incremental-tree", layout: incremental });
    // Re-embed other retained tiles only when the fixed warm embedding exceeds
    // the compact height budget (shelves and the downward layout); otherwise its
    // zero displacement is valuable. Build the downward layout only if its height decides.
    const fixed = new Set([...anchors, key]);
    if (anchors.length && fixed.size < previous.nodes.size) {
      const compactShelf = Math.min(...shelves.map(c => bandExtent(c.layout, key).height));
      const height = incremental ? bandExtent(incremental, key).height : Infinity;
      const repack = !incremental || height > compactShelf * 1.1
        || (wantsDown && height > downFloor * 1.1 && height > bandExtent(visibleDown().layout, key).height * 1.1);
      const subset = repack ? projected(previous, { ...request, items: request.items.filter(n => fixed.has(n.key)) }) : null;
      const compact = subset && incrementalTree(request, { ...subset, bandBounds: undefined, anchorX: undefined, anchorY: undefined });
      if (compact) history.push({ name: "anchored-repack", layout: compact });
    }
    const retained = projected(previous, request);
    if (retained) history.push({ name: "retained-visible", layout: retained, partition: input.history?.layout.decision?.partition });
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
    const metrics = complete ? evaluate(c) : validateLayout(placementFor(c), key, request.maxWidth, request.items);
    gates.set(c.layout, { metrics, complete });
    return metrics;
  };
  const feasible = (m: Measures) => Number.isFinite(cost(m, tileWidth));

  const prepared: Prepared[] = [...shelves, ...history].map(prepare);
  const lazy: Pending[] = [];
  /** The downward layout before it is built: a height lower bound and the objective bound it implies. */
  const downPending = (): Pending => ({ name: "visible-down", orientation: "down", height: downFloor,
    floor: extentCost(downFloor, Math.max(0, ...request.items.filter(n => n.key !== key).map(n => n.width)), request.maxWidth, tileWidth), build: visibleDown });
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
    if (wantsDown && downFloor < shortest) prepared.unshift(prepare(visibleDown()));
    minimumFeasibleHeight = firstFeasible(prepared);
    if (wantsDown && !down) {
      if (downFloor < minimumFeasibleHeight) {
        prepared.unshift(prepare(visibleDown()));
        minimumFeasibleHeight = firstFeasible(prepared);
      // Otherwise it cannot lower the budget; it matters only if eligible and able to beat the ranked scores.
      } else if (!(downFloor > minimumFeasibleHeight * 1.1 + .01)) lazy.push(downPending());
    }
  } else {
    // Translations onto the click anchor, and the downward family, stay rectangles until needed.
    if (wantsDown) {
      if (down) prepared.unshift(prepare(down));
      else lazy.push(downPending());
    }
    for (const c of prepared) lazy.push(...anchoredPending(c));
  }
  prepared.sort(byHeight);

  function anchoredPending(c: Candidate): Pending[] {
    const shift = anchorShift(c.layout, request, previous!, anchors);
    if (!shift) return [];
    return [{ name: `anchored-${c.name}`, partition: c.partition, orientation: c.layout.orientation, height: bandExtent(shift.skeleton, key).height,
      floor: rectangleCost(shift.skeleton, key, request.maxWidth, tileWidth, request.items, previous, request.anchorKey),
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
    const placed = placementFor(c);
    if (Number.isFinite(bestAnchored) && beaten(optimisticCost(placed, key, request.maxWidth, tileWidth, request.items, previous, request.anchorKey), c.layout.orientation)) return;
    const known = gates.get(c.layout);
    const metrics = known && (known.complete || !previous && !lazy.length && prepared.filter(eligible).length === 1) ? known.metrics : gate(c, true);
    const score = cost(metrics, tileWidth);
    if (!Number.isFinite(score)) return;
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
  const done = new Set<Prepared | Pending>();
  // Score the most promising constructed candidate first: its score is the
  // incumbent that lets the bounds skip building pending candidates at all.
  const incumbent = prepared.filter(c => c.holds).sort(byFloor)[0];
  if (incumbent) { done.add(incumbent); consider(incumbent); }
  for (;;) {
    const next = [...prepared.filter(c => c.holds), ...lazy].filter(c => !done.has(c)).sort(byFloor)[0];
    if (!next) break;
    done.add(next);
    if (!("build" in next)) consider(next);
    else if (!beaten(next.floor, next.orientation)) realise(next);
  }
  if (!Number.isFinite(bestAnchored)) {
    for (let i = 0; i < lazy.length; i++) realise(lazy[i]);
    for (const c of prepared.filter(c => !c.holds).sort(byFloor)) consider(c);
  }
  // Malformed input (a cover with a visible parent) can defeat every candidate. Show the
  // downward layout, flagged, rather than no graph at all.
  if (!scored.length) return { ...visibleDown().layout, decision: { candidate: "visible-down", stability: false, fallback: "gate-infeasible" } };
  const holding = scored.filter(c => c.anchors);
  const preserving = holding.length ? holding : scored;
  const minimumHeight = anchors.length ? Math.min(...scored.map(c => c.metrics.height)) : minimumFeasibleHeight;
  const compact = preserving.filter(c => c.metrics.height <= minimumHeight * 1.1 + .01);
  const pool = anchors.length && holding.length ? preserving : compact.length ? compact : preserving;
  pool.sort((a, b) => a.score - b.score);
  let winner = pool[0];
  // A direction switch must earn a visible quality saving, not a rounding-sized difference.
  const same = previous && pool.filter(c => c.layout.orientation === previous.orientation).sort((a, b) => a.score - b.score)[0];
  if (same && winner.layout.orientation !== same.layout.orientation && winner.score > same.score * .85) winner = same;
  let stability = !!previous && (winner.metrics.height > minimumHeight * 1.1 || winner.name.startsWith("anchored") || winner.name === "retained-visible" || winner.name === "incremental-tree");
  // A shorter safe embedding may have been pruned because it moved an anchor.
  // Its existence still explains a height-for-stability exception; certify only
  // the hard constraints needed for that diagnostic, without rescoring routes.
  if (!stability && previous && anchors.length) {
    const checked = new Set<Prepared | Pending>();
    for (;;) {
      const c = [...prepared, ...lazy].filter(c => !checked.has(c) && c.height * 1.1 + .01 < winner.metrics.height).sort(byHeight)[0];
      if (!c) break;
      checked.add(c);
      // A pending height is exact for translations and a lower bound for the downward layout.
      if ("build" in c) { realise(c); continue; }
      if (!Number.isFinite(c.floor)) continue;
      if (feasible(scored.find(s => s.layout === c.layout)?.metrics ?? gate(c, false))) { stability = true; break; }
    }
  }
  return { ...winner.layout, anchorY: anchors.length && winner.anchors && compatible?.attachment ? compatible.attachment.bandTop - compatible.attachment.placement.coverHeight : undefined, anchorX: anchors.length && winner.anchors ? bandExtent(winner.placed, key).left : undefined, decision: { candidate: winner.name, partition: winner.partition, stability,
    ...(anchors.length && !winner.anchors ? { fallback: "anchor-infeasible" as const } : {}) } };
}
