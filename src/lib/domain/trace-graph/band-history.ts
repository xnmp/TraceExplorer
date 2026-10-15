/**
 * Which committed band history a new request may build on, and the committed geometry adjusted
 * to the request. Pure; no IO.
 *
 * A component's history only grows: an image's inputs never change, and an edit adds outputs.
 * History is therefore kept across *growth* (North 1995, "Incremental Layout in DynaDAG": new
 * nodes are inserted into the previous drawing rather than the drawing being recomputed), as it
 * already is across selection changes. It stays compatible when the pane width, tile size and
 * pinned cover are unchanged and every image both requests know keeps its order, its inputs and
 * its size, with one exception: an image's first output gives it an expansion hint (`TILE.hint`),
 * so its tile grows downward. Images may also leave (a discard); the retained subset survives.
 * Anything else (a resize, another cover column, changed relationships) is incompatible, and the
 * band is laid out afresh.
 */
import type { GraphLayout, LayoutRequest, PlacedNode, RowBox } from "./layout";
import { ARROW } from "./metrics";
import { mapPathNumbers, pathNumbers } from "./path-data";

/** Identity of a band request's geometry: what its committed history must match. */
type Fact = readonly [key: string, width: number, height: number, order: number, parents: readonly string[]];
type Signature = readonly [maxWidth: number, tileWidth: number | undefined, pinned: unknown, facts: readonly Fact[]];

export function bandHistorySignature(request: LayoutRequest): string {
  return JSON.stringify([request.maxWidth, request.tileWidth, request.pinned,
    [...(request.band?.items ?? request.items)].sort((a, b) => a.key.localeCompare(b.key)).map(n => [n.key, n.width, n.height, n.order, [...new Set(n.parents)].sort()])]);
}

function parse(signature: string): Signature | null {
  try {
    const value: unknown = JSON.parse(signature);
    if (!Array.isArray(value) || value.length !== 4 || !Array.isArray(value[3])) return null;
    for (const fact of value[3]) if (!Array.isArray(fact) || fact.length !== 5 || typeof fact[0] !== "string" || !Array.isArray(fact[4])) return null;
    return value as unknown as Signature;
  } catch { return null; }
}

/** How a committed history relates to a request: the same component, a grown one (with the tiles that grew), or neither. */
export type HistoryFit = { readonly kind: "same" } | { readonly kind: "grown"; readonly heights: ReadonlyMap<string, number> } | null;

export function historyFit(signature: string, request: LayoutRequest): HistoryFit {
  const now = bandHistorySignature(request);
  if (signature === now) return { kind: "same" };
  const before = parse(signature), after = parse(now);
  if (!before || !after || JSON.stringify(before.slice(0, 3)) !== JSON.stringify(after.slice(0, 3))) return null;
  const known = new Map(after[3].map(f => [f[0], f]));
  const hadChildren = new Set(before[3].flatMap(f => f[4]));
  const heights = new Map<string, number>();
  let shared = 0;
  for (const old of before[3]) {
    const fact = known.get(old[0]);
    if (!fact) continue;
    shared++;
    if (fact[1] !== old[1] || fact[3] !== old[3] || JSON.stringify(fact[4]) !== JSON.stringify(old[4])) return null;
    if (fact[2] === old[2]) continue;
    // Only a first output changes a tile: it gains the expansion hint and grows downward.
    if (!(fact[2] > old[2]) || hadChildren.has(old[0])) return null;
    heights.set(old[0], fact[2]);
  }
  return shared ? { kind: "grown", heights } : null;
}

const EPS = 1e-6;

/**
 * `layout` with each listed tile grown to its new height in place (top-left fixed), room made
 * below it: everything strictly below the first horizontal line at or under the tile's old bottom
 * that crosses no tile moves down by what the grown tile needs. A connector arriving at the tile's
 * left side (running right) follows its new centre. The tile had no outputs, so no connector
 * leaves it. Geometry the engine cannot use is caught by its hard gates like any candidate's.
 */
export function grownLayout(layout: GraphLayout, heights: ReadonlyMap<string, number>): GraphLayout {
  let current = layout;
  for (const [key, height] of heights) {
    const tile = current.nodes.get(key);
    if (!tile || !(height > tile.height)) continue;
    current = growTile(current, tile, height);
  }
  return current;
}

function growTile(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout {
  let line = tile.y + tile.height;
  // Settle the line below every tile it would cut through.
  for (let moved = true; moved;) {
    moved = false;
    for (const n of layout.nodes.values()) if (n.y < line - EPS && n.y + n.height > line + EPS) { line = n.y + n.height; moved = true; }
  }
  const shift = Math.max(0, tile.y + height - line);
  const below = (y: number) => y > line + EPS;
  const oldCentre = tile.y + tile.height / 2, newCentre = tile.y + height / 2, entry = tile.x - ARROW.length;
  const nodes = new Map<string, PlacedNode>();
  layout.nodes.forEach((n, id) => nodes.set(id, id === tile.key ? { ...n, height } : below(n.y) ? { ...n, y: n.y + shift } : n));
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, below(j.y) ? { ...j, y: j.y + shift } : j] as const));
  const routes = layout.routes.map(route => {
    const moved = shift ? mapPathNumbers(route.path, (v, i) => i % 2 === 1 && below(v) ? v + shift : v) : route.path;
    const arrives = route.terminal && route.to.kind === "node" && route.to.id === tile.key;
    const followed = arrives ? followCentre(moved, entry, oldCentre, newCentre) : moved;
    return followed === route.path ? route : { ...route, path: followed };
  });
  const rows: RowBox[] = layout.rows.map(r => ({ ...r, top: below(r.top) ? r.top + shift : r.top,
    bottom: below(r.bottom) ? r.bottom + shift : r.keys.includes(tile.key) ? Math.max(r.bottom, tile.y + height) : r.bottom }));
  return { ...layout, nodes, junctions, routes, rows, height: layout.height + shift };
}

/**
 * A polyline arriving horizontally at `entry` on the line `from` moved onto the line `to`: its
 * trailing run on `from` moves with it from the vertical joint before it; a run that starts the
 * path keeps its start and takes a vertical step one arrow length before the end, so the arrow
 * still lies on a straight approach. Curved paths and other arrivals are returned unchanged.
 */
function followCentre(path: string, entry: number, from: number, to: number): string {
  if (path.includes("C") || from === to) return path;
  const numbers = pathNumbers(path), points: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  const last = points.length - 1;
  if (last < 1 || Math.abs(points[last][0] - entry) > .01 || Math.abs(points[last][1] - from) > .01) return path;
  let run = last;
  while (run > 0 && Math.abs(points[run - 1][1] - from) < .01) run--;
  const out = points.map(p => [...p] as [number, number]);
  if (run > 0 && Math.abs(points[run - 1][0] - points[run][0]) < .01) for (let i = run; i <= last; i++) out[i][1] = to;
  else {
    const step = points[last][0] - ARROW.length;
    out.splice(last, 1, [step, from], [step, to], [points[last][0], to]);
  }
  return out.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
}
