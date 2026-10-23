/**
 * Wrapped rightward embeddings (routing slice 5b): graph wrapping in the
 * manner of ELK Layered (`elk.layered.wrapping.strategy`; Rüegg and von
 * Hanxleden, "Wrapping Layered Graphs", Diagrams 2018 / Kiel report 1803).
 * Generations run left to right as columns; cut indices split the
 * layering into chunks, and each chunk is stacked below the one before.
 *
 * The generator makes discrete choices only: the cut indices, and the order of
 * the breaking points. Each chunk is solved by the common layered solve
 * (`layoutLayered`, rightward), with one breaking-point dummy per cut parent as
 * the chunk's sources, so the shared router draws every fan-out into a chunk.
 * The dummies are then removed and each cut edge is joined by its wrapped
 * connector (ELK's `BreakingPointRemover`): out of the parent's free right side,
 * down a track in the gap below its chunk, back left and into the dummy's port.
 * Connector exits, gap tracks and entries take one strict nesting order (the
 * topmost parent outermost on the right, lowest in the gap, innermost on the
 * left), so wrapped connectors never cross each other.
 *
 * The domain is the shelf router's: a tree under the band cover, every edge
 * spanning exactly one generation. Null means the embedding does not apply or
 * does not fit its pane; it is not a proof of infeasibility.
 */
import { layoutLayered, RoutingConflictError, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedJunction, type PlacedNode, type PlacedRoute } from './layout';
import { mapPathNumbers } from './path-data';
import { pathCommands } from './path-sampling';
import { routeConsumers } from './route-consumers';
import { ARROW, spacingFor, STACK_STEM_ROOM, TRACK_HEIGHT } from './metrics';
import type { NodeKey } from './model';

/** Width the band may allocate: the pane quantised to 32 px, never narrower than one tile. */
const widthBudget = (width: number, tileWidth = 92): number => {
  const minimum = Number.isFinite(tileWidth) && tileWidth > 0 ? tileWidth : 92;
  return Number.isFinite(width) && width > 0 ? Math.max(minimum, Math.floor(Math.min(100_000, width) / 32) * 32) : minimum;
};

/** Breaking-point dummies: thin sources, as tall as their parent tiles so a one-to-one cut stays straight. */
const DUMMY_WIDTH = 2;
const DUMMY_PREFIX = '\u0001wrap:';
const dummyKey = (index: number) => `${DUMMY_PREFIX}${index}`;

/** The cover's descendants by generation, in display order; null outside the tree domain. */
export function wrappedGenerations(request: LayoutRequest): readonly (readonly LayoutItem[])[] | null {
  const key = request.band?.key, byKey = new Map(request.items.map(item => [item.key, item]));
  const cover = key === undefined ? undefined : byKey.get(key);
  if (!cover || byKey.size !== request.items.length || cover.parents.some(p => byKey.has(p))) return null;
  // Breaking-point dummies take keys in a namespace no item may hold.
  if (request.items.some(item => typeof item.key !== 'string' || item.key.startsWith(DUMMY_PREFIX))) return null;
  const children = new Map<NodeKey, LayoutItem[]>();
  for (const item of request.items) {
    if (item.key === key) continue;
    const parents = [...new Set(item.parents)].filter(p => byKey.has(p));
    if (parents.length !== 1 || parents[0] === item.key) return null;
    (children.get(parents[0]) ?? children.set(parents[0], []).get(parents[0])!).push(item);
  }
  const order = (a: LayoutItem, b: LayoutItem) => a.order - b.order || a.key.localeCompare(b.key);
  for (const list of children.values()) list.sort(order);
  const generations: LayoutItem[][] = [];
  let count = 1;
  for (let frontier = children.get(cover.key) ?? []; frontier.length; frontier = frontier.flatMap(n => children.get(n.key) ?? [])) {
    generations.push(frontier);
    count += frontier.length;
  }
  return count === request.items.length && generations.length ? generations : null;
}

interface Span { readonly left: number; readonly right: number; readonly height: number }

/**
 * Cut indices (ELK's cut-index selection, here exact rather than by aspect
 * ratio): the column spans of one unwrapped rightward solve estimate each
 * chunk's width and height; a dynamic programme then minimises the wrapped
 * height within the pane, and a greedy fill (the fewest chunks) follows as a
 * second plan. Each plan lists chunk ends, as `partitions` did for shelves.
 */
export function wrapCuts(spans: readonly Span[], budget: number, entryWidth: (start: number) => number, exitWidth: (end: number) => number, gapHeight: (start: number) => number,
  overflows: (start: number, end: number) => boolean = () => false): number[][] {
  const n = spans.length;
  // The width estimate grows with `b`, so a chunk too wide ends the scan; a
  // chunk proved to overflow is only skipped (its exit lanes need not grow with `b`).
  const estimated = (a: number, b: number) => entryWidth(a) + spans[b - 1].right - spans[a].left + exitWidth(b) <= budget;
  const fits = (a: number, b: number) => estimated(a, b) && !overflows(a, b);
  const height = (a: number, b: number) => { let h = 0; for (let c = a; c < b; c++) h = Math.max(h, spans[c].height); return h; };
  const best = Array<number>(n + 1).fill(Infinity), next = Array<number>(n).fill(0);
  best[n] = 0;
  for (let a = n - 1; a >= 0; a--)
    for (let b = a + 1; b <= Math.min(n, a + 32); b++) {
      if (!estimated(a, b)) break;
      if (overflows(a, b)) continue;
      const value = height(a, b) + gapHeight(a) + best[b];
      if (value < best[a] - 1e-9) { best[a] = value; next[a] = b; }
    }
  const plans: number[][] = [];
  if (Number.isFinite(best[0])) { const p: number[] = []; for (let a = 0; a < n; a = next[a]) p.push(next[a]); plans.push(p); }
  // The greedy fill: the fewest chunks, each as wide as fits.
  const greedy: number[] = [];
  for (let a = 0; a < n;) {
    let b = a + 1;
    if (!fits(a, b)) { greedy.length = 0; break; }
    for (let c = b + 1; c <= Math.min(n, a + 32) && estimated(a, c); c++) if (!overflows(a, c)) b = c;
    greedy.push(b); a = b;
  }
  if (greedy.length) plans.push(greedy);
  return [...new Map(plans.map(p => [p.join(','), p])).values()];
}

interface Solved {
  readonly nodes: Map<NodeKey, PlacedNode>;
  readonly junctions: Map<string, PlacedJunction>;
  readonly routes: PlacedRoute[];
  /** Breaking-point dummies by parent, in this chunk's frame. */
  readonly dummies: ReadonlyMap<NodeKey, PlacedNode>;
}

/** One chunk through the common rightward solve, the cut parents as dummy sources ordered as given. */
function solveChunk(request: LayoutRequest, generations: readonly (readonly LayoutItem[])[], parents: readonly NodeKey[], heights: readonly number[]): Solved | null {
  const dummyOf = new Map(parents.map((p, i) => [p, dummyKey(i)]));
  const floor = Math.min(0, ...generations.flat().map(item => Number.isFinite(item.order) ? item.order : 0)) - parents.length - 1;
  const items: LayoutItem[] = [
    ...parents.map((p, i) => ({ key: dummyOf.get(p)!, width: DUMMY_WIDTH, height: heights[i], order: floor + i, parents: [] })),
    ...generations.flat().map(item => ({ ...item, parents: item.parents.map(p => dummyOf.get(p) ?? p) })),
  ];
  let layout: GraphLayout;
  try { layout = layoutLayered({ items, maxWidth: Infinity, orientation: 'right', tileWidth: request.tileWidth, hint: request.hint }, { channelStyle: 'orthogonal', rowAlign: 'start' }); }
  catch (error) { if (error instanceof RoutingConflictError) return null; throw error; }
  const parentOf = new Map([...dummyOf].map(([p, d]) => [d, p]));
  const nodes = new Map<NodeKey, PlacedNode>(), dummies = new Map<NodeKey, PlacedNode>();
  for (const [key, node] of layout.nodes) { const p = parentOf.get(key); if (p === undefined) nodes.set(key, node); else dummies.set(p, node); }
  // Dummies keep their given order: a sweep that reordered them would cross wrapped connectors.
  const ys = parents.map(p => dummies.get(p)!.y);
  if (ys.some((y, i) => i && y <= ys[i - 1])) return null;
  const rename = (id: string) => parentOf.get(id) ?? id;
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, { ...j, parents: j.parents.map(rename) }]));
  // Route ids are the solve's JSON key arrays; a dummy's key in them becomes its parent's.
  const renameId = (id: string) => {
    if (!parentOf.size || !id.startsWith('[')) return id;
    const parts: unknown = JSON.parse(id);
    return Array.isArray(parts) ? JSON.stringify(parts.map(part => typeof part === 'string' ? rename(part) : part)) : id;
  };
  const routes = layout.routes.map(route => ({ ...route, id: renameId(route.id),
    from: { ...route.from, id: route.from.kind === 'node' ? rename(route.from.id) : route.from.id },
    to: { ...route.to, id: route.to.kind === 'node' ? rename(route.to.id) : route.to.id },
    consumers: routeConsumers(route).map(c => parentOf.has(c.parent) ? { ...c, parent: parentOf.get(c.parent)! } : c) }));
  return { nodes, junctions, routes, dummies };
}

const starts = (path: string, x: number, y: number) => path.startsWith(`M${x} ${y}`) && !/^[\d.]/.test(path.slice(`M${x} ${y}`.length));

/**
 * One-dimensional compaction of an entry channel: the routes leaving a source
 * port, and the leftmost x its wrapped entry column may take. A port whose one
 * route leaves along the port's line lets the entry move up to that run's end
 * (the arrow approach when it ends at its tile); otherwise the column keeps
 * clear of the port.
 */
function entryFan(routes: readonly PlacedRoute[], source: NodeKey, exact: { readonly x: number; readonly y: number }, s: ReturnType<typeof spacingFor>) {
  // The port as the solve prints it.
  const at = { x: round(exact.x), y: round(exact.y) };
  const fanned = routes.filter(route => route.from.kind === 'node' && route.from.id === source && starts(route.path, at.x, at.y));
  const commands = fanned.length === 1 ? pathCommands(fanned[0].path) : null;
  const run = commands && commands.length > 1 && commands[1].kind === 'L' && commands[1].values[1] === at.y && commands[1].values[0] > at.x ? commands[1].values[0] : null;
  const inner = run === null ? at.x - s.clearance : run - (commands!.length === 2 && fanned[0].terminal ? ARROW.length : s.clearance);
  return { fanned, run, inner };
}

/** Path data of an orthogonal polyline; repeated and collinear interior points are dropped. */
function polyline(points: readonly (readonly [number, number])[]): string {
  const kept: (readonly [number, number])[] = [];
  for (const [x, y] of points) {
    const p = [round(x), round(y)] as const;
    if (kept.length && kept.at(-1)![0] === p[0] && kept.at(-1)![1] === p[1]) continue;
    if (kept.length >= 2) {
      const a = kept.at(-2)!, b = kept.at(-1)!;
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) kept.pop();
    }
    kept.push(p);
  }
  return kept.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
}

const round = (value: number) => Math.round(value * 100) / 100;
const shifted = (path: string, dx: number, dy: number) => mapPathNumbers(path, (v, i) => round(v + (i % 2 ? dy : dx)));

/** Extent of a solved chunk's real tiles and ink, dummies and their prefixes excluded. */
function extent(solved: Solved): { left: number; right: number; top: number; bottom: number } {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const n of solved.nodes.values()) { left = Math.min(left, n.x); right = Math.max(right, n.x + n.width); top = Math.min(top, n.y); bottom = Math.max(bottom, n.y + n.height); }
  for (const route of solved.routes) mapPathNumbers(route.path, (v, i) => {
    if (i % 2) { top = Math.min(top, v); bottom = Math.max(bottom, v); } else right = Math.max(right, v);
    return v;
  });
  return { left, right, top, bottom };
}

/**
 * The wrapped embedding for one plan of chunk ends (each an exclusive
 * generation index). Chunks are solved in order: a chunk's breaking points
 * follow its cut parents' order in the chunk above.
 */
export function wrappedEmbedding(request: LayoutRequest, ends: readonly number[], generations = wrappedGenerations(request)): GraphLayout | null {
  const result = embed(request, ends, generations, new Map());
  return result && 'nodes' in result ? result : null;
}

/** Chunk solves by generation range and breaking-point order, shared by a request's plans. */
type ChunkCache = Map<string, Solved | null>;
/** The overflowing chunk when a plan's estimate proved too narrow. */
interface Overflow { readonly overflow: readonly [number, number] }

function embed(request: LayoutRequest, ends: readonly number[], generations: readonly (readonly LayoutItem[])[] | null, cache: ChunkCache): GraphLayout | Overflow | null {
  if (!generations || !ends.length || ends.at(-1) !== generations.length || ends.some((e, i) => e <= (i ? ends[i - 1] : 0))) return null;
  const key = request.band!.key, cover = request.items.find(item => item.key === key)!, s = spacingFor(request.tileWidth);
  const budget = widthBudget(request.maxWidth, request.tileWidth);
  const cx = Math.max(cover.width / 2, Math.min(budget - cover.width / 2, request.pinned?.x ?? budget / 2));
  const nodes = new Map<NodeKey, PlacedNode>([[key, { key, x: cx - cover.width / 2, y: 0, width: cover.width, height: cover.height, band: 0, row: 0 }]]);
  const junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [];
  // First every chunk is solved. A chunk's breaking points follow its cut
  // parents' order in the chunk above, which translation does not change.
  interface Chunk { readonly start: number; readonly end: number; readonly solved: Solved; readonly parents: readonly NodeKey[];
    readonly fans: ReadonlyMap<NodeKey, ReturnType<typeof entryFan>>; readonly inner: number; readonly box: ReturnType<typeof extent> }
  const chunks: Chunk[] = [];
  let parents: { readonly key: NodeKey; readonly height: number }[] = [{ key, height: DUMMY_WIDTH }];
  for (let chunk = 0, start = 0; chunk < ends.length; start = ends[chunk++]) {
    const members = generations.slice(start, ends[chunk]), keys = parents.map(p => p.key);
    const memo = `${start},${ends[chunk]},${keys.join('\u0000')}`;
    const solved = cache.has(memo) ? cache.get(memo)! : cache.set(memo, solveChunk(request, members, keys, parents.map(p => p.height))).get(memo)!;
    if (!solved) return null;
    const port = (p: NodeKey) => { const d = solved.dummies.get(p)!; return { x: d.x + d.width, y: d.y + d.height / 2 }; };
    const fans = new Map(keys.map(p => [p, entryFan(solved.routes, p, port(p), s)] as const));
    chunks.push({ start, end: ends[chunk], solved, parents: keys, fans, inner: Math.min(...[...fans.values()].map(f => f.inner)), box: extent(solved) });
    const more = new Set((generations[ends[chunk]] ?? []).flatMap(item => item.parents));
    parents = members.at(-1)!.filter(item => more.has(item.key)).map(item => solved.nodes.get(item.key)!)
      .sort((a, b) => a.y - b.y).map(n => ({ key: n.key, height: n.height }));
  }
  // Then their columns are aligned: every chunk's first column starts where the
  // chunk needing the most entry room puts it, so wrapped columns line up. When
  // that overflows the pane, each chunk takes only its own entry room.
  const need = (c: Chunk) => s.clearance + (c.parents.length - 1) * s.lane + c.box.left - c.inner;
  const exitRoom = (c: Chunk, i: number) => i + 1 < chunks.length ? 2 * s.clearance + chunks[i + 1].parents.length * s.lane : 0;
  const lastRight = (c: Chunk) => Math.max(...generations[c.end - 1].map(item => { const n = c.solved.nodes.get(item.key)!; return n.x + n.width; }));
  const fitsAt = (left: (c: Chunk) => number) => chunks.findIndex((c, i) => {
    const dx = left(c) - c.box.left;
    return c.box.right + dx > budget || (exitRoom(c, i) && lastRight(c) + dx + exitRoom(c, i) > budget);
  });
  const aligned = Math.max(...chunks.map(need));
  let left: (c: Chunk) => number = () => aligned;
  if (fitsAt(left) >= 0) {
    left = need;
    const failed = fitsAt(left);
    if (failed >= 0) return { overflow: [chunks[failed].start, chunks[failed].end] };
  }

  // Cut parents leaving the previous chunk, top to bottom, with their exit ports.
  let leaving: { readonly key: NodeKey; readonly x: number; readonly y: number }[] = [{ key, x: cx, y: cover.height }];
  let exitRight = cx, bottom = cover.height, fromCover = true;
  for (const [index, chunk] of chunks.entries()) {
    const { solved, fans, inner, box, start } = chunk, m = leaving.length;
    // Gap tracks below the previous chunk: the topmost cut parent takes the lowest.
    const firstTrack = fromCover ? cover.height + 2 * TRACK_HEIGHT : bottom + TRACK_HEIGHT;
    const track = (rank: number) => firstTrack + (m - 1 - rank) * TRACK_HEIGHT;
    const top = Math.max(fromCover ? cover.height + STACK_STEM_ROOM : 0, track(0) + s.approach);
    // Entry columns left of the dummies' ports: the topmost parent innermost.
    const port = (p: NodeKey) => { const d = solved.dummies.get(p)!; return { x: round(d.x + d.width), y: round(d.y + d.height / 2) }; };
    const dx = round(left(chunk) - box.left), dy = round(top - box.top);
    const entry = (rank: number) => round(inner + dx - rank * s.lane);
    for (const [id, node] of solved.nodes) nodes.set(id, { ...node, x: node.x + dx, y: node.y + dy, band: node.band + start, row: index + 1 });
    for (const [id, j] of solved.junctions) {
      if (junctions.has(id)) return null;
      junctions.set(id, { ...j, x: round(j.x + dx), y: round(j.y + dy) });
    }
    // Each cut parent's connector extends its dummy's one route (or trunk) back to
    // the parent; when several routes leave the dummy, it is their trunk, carrying
    // every consumer, and they branch where it ends.
    const shiftedRoutes = solved.routes.map(route => ({ ...route, path: shifted(route.path, dx, dy) }));
    for (const [rank, parent] of leaving.entries()) {
      const fan = fans.get(parent.key)!, at = port(parent.key), x = round(at.x + dx), y = round(at.y + dy), lane = track(rank);
      const exitX = exitRight + s.clearance + (m - 1 - rank) * s.lane;
      const points: [number, number][] = fromCover
        ? [[parent.x, parent.y], [parent.x, lane], [entry(rank), lane], [entry(rank), y]]
        : [[parent.x, parent.y], [exitX, parent.y], [exitX, lane], [entry(rank), lane], [entry(rank), y]];
      if (!fan.fanned.length) return null;
      if (fan.fanned.length > 1) {
        routes.push({ id: JSON.stringify(['wrap', 'node', parent.key]), from: { kind: 'node', id: parent.key }, to: { kind: 'node', id: parent.key }, terminal: false,
          consumers: fan.fanned.flatMap(route => routeConsumers(route)), path: polyline([...points, [x, y]]) });
        continue;
      }
      const at2 = solved.routes.indexOf(fan.fanned[0]), path = shiftedRoutes[at2].path;
      if (!starts(path, x, y)) return null;
      // Past the port: the run's own end when it was compacted, else the port itself.
      shiftedRoutes[at2] = { ...shiftedRoutes[at2], path: polyline(points) + (fan.run === null ? ' L' + path.slice(1) : ' ' + path.slice(`M${x} ${y}`.length).trimStart()) };
    }
    routes.push(...shiftedRoutes);
    leaving = (chunks[index + 1]?.parents ?? []).map(p => { const n = nodes.get(p)!; return { key: p, x: n.x + n.width, y: round(n.y + n.height / 2) }; });
    exitRight = Math.max(...generations[chunk.end - 1].map(item => nodes.get(item.key)!.x + nodes.get(item.key)!.width));
    bottom = box.bottom + dy;
    fromCover = false;
  }
  if (new Set(routes.map(route => route.id)).size !== routes.length) return null;
  const readingOrder = new Map<NodeKey, number>([[key, 0]]);
  for (const generation of generations) for (const item of [...generation].sort((a, b) => nodes.get(a.key)!.y - nodes.get(b.key)!.y)) readingOrder.set(item.key, readingOrder.size);
  return { orientation: 'right', width: budget, height: round(bottom + s.bottom), nodes, routes, junctions, rows: [], readingOrder,
    decision: { candidate: 'wrapped-right', stability: false, partition: ends } };
}

/**
 * Every plan's wrapped embedding that fits, best plan first. One unwrapped
 * rightward solve measures the column spans the cut selection reads.
 */
export function wrappedEmbeddings(request: LayoutRequest, limit = Infinity): { readonly layout: GraphLayout; readonly partition: readonly number[] }[] {
  const generations = wrappedGenerations(request);
  if (!generations) return [];
  const all = solveChunk(request, generations, [request.band!.key], [DUMMY_WIDTH]);
  if (!all) return [];
  const spans: Span[] = generations.map(generation => {
    const placed = generation.map(item => all.nodes.get(item.key)!);
    const top = Math.min(...placed.map(n => n.y)), bottom = Math.max(...placed.map(n => n.y + n.height));
    return { left: Math.min(...placed.map(n => n.x)), right: Math.max(...placed.map(n => n.x + n.width)), height: bottom - top };
  });
  const s = spacingFor(request.tileWidth), budget = widthBudget(request.maxWidth, request.tileWidth);
  const parentsAt = generations.map((_, c) => c ? new Set(generations[c].flatMap(item => item.parents)).size : 1);
  // The channel into column `a` carries the same edges in the unwrapped solve
  // as from the chunk's breaking points, so its measured width is the estimate.
  const coverDummy = [...all.dummies.values()][0];
  const portOf = (c: number) => (c < 0 ? [{ key: request.band!.key, x: coverDummy.x + coverDummy.width, y: coverDummy.y + coverDummy.height / 2 }]
    : generations[c].map(item => { const n = all.nodes.get(item.key)!; return { key: item.key, x: n.x + n.width, y: n.y + n.height / 2 }; }));
  const entryWidth = (a: number) => {
    const into = new Set(generations[a].flatMap(item => item.parents));
    const inner = Math.min(...portOf(a - 1).filter(p => into.has(p.key)).map(p => entryFan(all.routes, p.key, p, s).inner));
    return s.clearance + (parentsAt[a] - 1) * s.lane + spans[a].left - inner;
  };
  const exitWidth = (b: number) => b < spans.length ? 2 * s.clearance + parentsAt[b] * s.lane : 0;
  // A chunk whose solved width overflows the estimate is excluded and the cuts
  // are chosen again (a bounded number of times), as a validated cut index is.
  const overflowing = new Set<string>(), tried = new Set<string>(), cache: ChunkCache = new Map();
  const out: { layout: GraphLayout; partition: readonly number[] }[] = [];
  for (let round = 0; round < 6 && out.length < limit; round++) {
    const plans = wrapCuts(spans, budget, entryWidth, exitWidth, a => (parentsAt[a] + 1) * TRACK_HEIGHT + s.approach, (a, b) => overflowing.has(`${a},${b}`))
      .filter(plan => !tried.has(plan.join(',')));
    if (!plans.length) break;
    let recut = false;
    for (const ends of plans) {
      if (out.length >= limit) break;
      tried.add(ends.join(','));
      const result = embed(request, ends, generations, cache);
      if (result && 'nodes' in result) out.push({ layout: result, partition: ends });
      else if (result) { overflowing.add(result.overflow.join(',')); recut = true; }
    }
    if (!recut) break;
  }
  return out;
}
