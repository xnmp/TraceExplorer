/** Width-bounded band candidates. The grid cover is an anchor, not a graph column. */
import { layoutLayered, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedNode, type PlacedRoute } from "./layout";
import { ARROW, spacingFor, STACK_STEM_ROOM, TRACK_HEIGHT } from "./metrics";

/** Buckets prevent a one-pixel resize from changing generation shelves. Invalid widths use one tile. */
export function bandWidthBudget(width: number, tileWidth = 92): number {
  const minimum = Number.isFinite(tileWidth) && tileWidth > 0 ? tileWidth : 92;
  return Number.isFinite(width) && width > 0 ? Math.max(minimum, Math.floor(Math.min(100_000, width) / 32) * 32) : minimum;
}

export interface BandCandidate {
  readonly layout: GraphLayout;
  readonly height: number;
  readonly connectorLength: number;
  readonly coverDistance: number;
}

/** Lexicographic cost: occupied band height, connector ink, cover displacement, then down as a stable tie. */
export function chooseBandArrangement(candidates: readonly BandCandidate[]): GraphLayout | null {
  return [...candidates].filter((candidate) => [candidate.height, candidate.connectorLength, candidate.coverDistance].every(Number.isFinite))
    .sort((a, b) => a.height - b.height || a.connectorLength - b.connectorLength || a.coverDistance - b.coverDistance
      || Number(a.layout.orientation === "right") - Number(b.layout.orientation === "right"))[0]?.layout ?? null;
}

const pathCoordinates = (path: string): number[] => path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
const shiftPath = (path: string, dx: number, dy: number): string => {
  let index = 0;
  return path.replace(/-?\d+(?:\.\d+)?/g, (value) => String(Number(value) + (++index % 2 ? dx : dy)));
};

function score(layout: GraphLayout, key: string, coverX: number): BandCandidate {
  const children = [...layout.nodes].filter(([id]) => id !== key).map(([, node]) => node);
  const first = Math.min(...children.map((node) => node.y));
  const length = layout.routes.reduce((total, route) => {
    const coordinates = pathCoordinates(route.path);
    // Control polygon is a deterministic upper bound for cubic length. All
    // candidates use the same routing primitives, so no DOM sampling is needed.
    for (let i = 2; i < coordinates.length; i += 2) total += Math.hypot(coordinates[i] - coordinates[i - 2], coordinates[i + 1] - coordinates[i - 1]);
    return total;
  }, 0);
  const left = Math.min(...children.map((node) => node.x)), right = Math.max(...children.map((node) => node.x + node.width));
  return { layout, height: children.length ? layout.height - first + STACK_STEM_ROOM : 0, connectorLength: length,
    coverDistance: children.length ? Math.abs((left + right) / 2 - coverX) : 0 };
}

/** A horizontal forest in bounded generation shelves. Multi-input DAGs retain the junction-aware layered candidate. */
function sideways(items: readonly LayoutItem[], key: string, budget: number, request: LayoutRequest): GraphLayout | null {
  const cover = items.find((item) => item.key === key);
  if (!cover || cover.parents.length) return null;
  const byKey = new Map(items.map((item) => [item.key, item]));
  const children = new Map<string, LayoutItem[]>();
  for (const item of items) {
    if (item.key === key) continue;
    const parents = item.parents.filter((parent) => byKey.has(parent));
    if (parents.length !== 1) return null;
    const siblings = children.get(parents[0]) ?? []; siblings.push(item); children.set(parents[0], siblings);
  }
  const generations: LayoutItem[][] = [];
  let frontier = children.get(key) ?? [], visited = 1;
  while (frontier.length) {
    generations.push(frontier); visited += frontier.length;
    if (visited > items.length) return null;
    frontier = frontier.flatMap((item) => children.get(item.key) ?? []);
  }
  if (visited !== items.length || generations.length < 2) return null;
  const spacing = spacingFor(request.tileWidth);
  const chunks: LayoutItem[][] = [];
  let used = spacing.top + spacing.bottom;
  for (const generation of generations) {
    const width = Math.max(...generation.map((item) => item.width));
    if (!chunks.length || used + spacing.bandChannel + width > budget) { chunks.push([]); used = spacing.top + spacing.bottom; }
    used += (chunks.at(-1)!.length ? spacing.bandChannel : 0) + width;
    chunks.at(-1)!.push(...generation);
  }
  const nodes = new Map<string, PlacedNode>();
  const routes: PlacedRoute[] = [], readingOrder = new Map<string, number>();
  const chunkOf = new Map<string, number>(), bottoms: number[] = [], rights: number[] = [];
  const coverX = Number.isFinite(request.pinned?.x) ? Math.round(request.pinned!.x / 32) * 32 : budget / 2;
  nodes.set(key, { key, x: coverX - cover.width / 2, y: 0, width: cover.width, height: cover.height, row: 0, band: 0 });
  readingOrder.set(key, 0);
  let top = cover.height + STACK_STEM_ROOM;
  for (const [index, chunk] of chunks.entries()) {
    const inside = new Set(chunk.map((item) => item.key));
    const local = layoutLayered({ items: chunk.map((item) => ({ ...item, parents: item.parents.filter((parent) => inside.has(parent)) })),
      maxWidth: budget, orientation: "right", tileWidth: request.tileWidth, hint: request.hint });
    // Reject width overflow; the down candidate already has pixel wrapping.
    if (local.width > budget && chunk.length > 1) return null;
    const incoming = new Set(chunk.filter((item) => item.parents.some((parent) => parent !== key && !inside.has(parent))).flatMap((item) => item.parents.filter((parent) => !inside.has(parent))));
    const firstX = Math.min(...[...local.nodes.values()].map((node) => node.x));
    const dx = Math.max(0, spacing.approach + Math.max(0, incoming.size - 1) * spacing.lane + 2 - firstX);
    if (local.width + dx > budget) return null;
    const first = Math.min(...[...local.nodes.values()].map((node) => node.y));
    const dy = top - first;
    for (const [id, node] of local.nodes) {
      nodes.set(id, { ...node, x: node.x + dx, y: node.y + dy, row: index + 1 }); chunkOf.set(id, index); readingOrder.set(id, readingOrder.size);
    }
    routes.push(...local.routes.map((route) => ({ ...route, path: shiftPath(route.path, dx, dy) })));
    const bottom = Math.max(...[...local.nodes.values()].map((node) => node.y + dy + node.height));
    bottoms.push(bottom);
    // Every independent source gets its own cross-shelf bend track.
    const exits = new Set(chunk.filter((item) => (children.get(item.key) ?? []).some((child) => !inside.has(child.key))).map((item) => item.key));
    const right = Math.max(...[...local.nodes.values()].map((node) => node.x + dx + node.width));
    if (right + spacing.clearance + Math.max(1, exits.size) * spacing.lane > budget) return null;
    rights.push(right);
    top = bottom + spacing.approach + Math.max(3, exits.size + 1) * TRACK_HEIGHT;
  }
  const tracks = new Map<string, number>();
  for (const item of items) {
    if (item.key === key) continue;
    const parent = item.parents[0], source = nodes.get(parent)!, target = nodes.get(item.key)!;
    if (parent !== key && chunkOf.get(parent) === chunkOf.get(item.key)) continue;
    const sourceChunk = chunkOf.get(parent) ?? -1;
    const peers = tracks.get(`${sourceChunk}:${parent}`) ?? [...tracks.keys()].filter((id) => id.startsWith(`${sourceChunk}:`)).length;
    tracks.set(`${sourceChunk}:${parent}`, peers);
    const lane = parent === key ? cover.height + 2 * TRACK_HEIGHT : bottoms[sourceChunk] + TRACK_HEIGHT * (peers + 1);
    const sx = source.x + source.width / 2, sy = source.y + source.height;
    const side = (rights[sourceChunk] ?? 0) + spacing.clearance + (peers + 1) * spacing.lane;
    const entry = target.x - spacing.approach - peers * spacing.lane;
    routes.push({ id: `band:${parent}:${item.key}`, from: { kind: "node", id: parent }, to: { kind: "node", id: item.key },
      consumers: [{ parent, child: item.key }], terminal: true,
      path: parent === key
        ? `M${sx} ${sy} L${sx} ${lane} L${target.x - spacing.approach} ${lane} L${target.x - spacing.approach} ${target.y + target.height / 2} L${target.x - ARROW.length} ${target.y + target.height / 2}`
        : `M${source.x + source.width} ${source.y + source.height / 2} L${side} ${source.y + source.height / 2} L${side} ${lane} L${entry} ${lane} L${entry} ${target.y + target.height / 2} L${target.x - ARROW.length} ${target.y + target.height / 2}` });
  }
  return { orientation: "right", width: Math.max(budget, ...[...nodes.values()].map((node) => node.x + node.width)),
    height: Math.max(...bottoms) + spacing.bottom, nodes, routes, junctions: new Map(), rows: [], readingOrder };
}

/** Choose orientation on the complete lineage; sideways shelves retain their full origin across visibility changes. */
export function layoutBand(request: LayoutRequest): GraphLayout {
  const band = request.band!;
  const width = bandWidthBudget(request.maxWidth, request.tileWidth);
  const full = band.items;
  const coverX = Number.isFinite(request.pinned?.x) ? Math.round(request.pinned!.x / 32) * 32 : width / 2;
  const down = layoutLayered({ ...request, band: undefined, items: full, maxWidth: width,
    pinned: request.pinned ? { ...request.pinned, x: Math.max((request.tileWidth ?? 92) / 2, Math.min(width - (request.tileWidth ?? 92) / 2, coverX)) } : undefined, orientation: "down" });
  const right = sideways(full, band.key, width, request);
  const choice = chooseBandArrangement([score(down, band.key, coverX), ...(right ? [score(right, band.key, coverX)] : [])]) ?? down;
  // Hidden junctions and wrapped rows do not reserve vertical holes in downward DAGs.
  const chosen = choice.orientation === "down" ? layoutLayered({ ...request, band: undefined, maxWidth: width }) : choice;
  const fullChildren = [...chosen.nodes].filter(([id]) => id !== band.key).map(([, node]) => node);
  const left = Math.min(...fullChildren.map((node) => node.x - 16)) - 8;
  const rightEdge = Math.max(...fullChildren.map((node) => node.x + node.width), ...chosen.routes.filter((route) => route.from.id !== band.key).flatMap((route) => pathCoordinates(route.path).filter((_, i) => i % 2 === 0))) + 8;
  const bandBounds = chosen.orientation === "right" && fullChildren.length ? { left, width: rightEdge - left, top: Math.min(...fullChildren.map((node) => node.y)) } : undefined;
  const visible = new Set(request.items.map((item) => item.key));
  const routes = chosen.routes.filter((route) => route.consumers.some(({ parent, child }) => visible.has(parent) && visible.has(child)));
  const junctions = new Set(routes.flatMap((route) => [route.from, route.to].filter((endpoint) => endpoint.kind === "junction").map((endpoint) => endpoint.id)));
  const nodes = new Map([...chosen.nodes].filter(([id]) => visible.has(id)));
  // Preserve the complete layout's origin even when its first tile is hidden.
  const bottom = Math.max(0, ...[...nodes.values()].map((node) => node.y + node.height), ...routes.flatMap((route) => pathCoordinates(route.path).filter((_, i) => i % 2 === 1)));
  return { ...chosen, bandBounds, nodes, routes, junctions: new Map([...chosen.junctions].filter(([id]) => junctions.has(id))),
    height: bottom + spacingFor(request.tileWidth).bottom, rows: chosen.rows.map((row) => ({ ...row, keys: row.keys.filter((id) => visible.has(id)) })) };
}
