/** Bounded visible-only generation shelves. Deterministic, no IO. */
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedNode, PlacedRoute } from "./layout";
import { ARROW, spacingFor, STACK_STEM_ROOM, TRACK_HEIGHT } from "./metrics";
interface Column {
    readonly items: readonly LayoutItem[];
    readonly height: number;
    readonly width: number;
    readonly channel: {
        readonly lanes: ReadonlyMap<string, number>;
        readonly count: number;
    };
}
interface Shelf {
    readonly start: number;
    readonly end: number;
    readonly width: number;
    readonly height: number;
    readonly left: number;
    readonly right: number;
    readonly gaps: readonly number[];
    readonly exits: readonly string[];
}
/** Width the band may allocate: the pane quantised to 32 px, never narrower than one tile. */
export function bandWidthBudget(width: number, tileWidth = 92): number {
    const minimum = Number.isFinite(tileWidth) && tileWidth > 0 ? tileWidth : 92;
    return Number.isFinite(width) && width > 0 ? Math.max(minimum, Math.floor(Math.min(100_000, width) / 32) * 32) : minimum;
}
const order = (a: LayoutItem, b: LayoutItem) => a.order - b.order || a.key.localeCompare(b.key);
/** Reject malformed raw requests explicitly. Normal application input has already passed projectDag. */
export function validate(items: readonly LayoutItem[]): void {
    if (Array.from(items).some(i => !i || typeof i.key !== 'string' || !i.key || !Array.isArray(i.parents) || i.parents.some(p => typeof p !== 'string')))
        throw new RangeError('malformed node or parents');
    const byKey = new Map(items.map(i => [i.key, i]));
    if (byKey.size !== items.length)
        throw new RangeError('duplicate node key');
    if (items.some(i => !Number.isFinite(i.width) || !Number.isFinite(i.height) || i.width <= 0 || i.height <= 0 || i.width > 100000 || i.height > 100000 || !Number.isFinite(i.order)))
        throw new RangeError('non-finite or nonpositive tile dimensions/order');
    const out = new Map(items.map(i => [i.key, [] as string[]]));
    const degree = new Map(items.map(i => [i.key, 0]));
    for (const i of items)
        for (const p of new Set(i.parents)) {
            if (p === i.key)
                throw new RangeError('cyclic input');
            if (byKey.has(p)) {
                out.get(p)!.push(i.key);
                degree.set(i.key, degree.get(i.key)! + 1);
            }
        }
    const ready = items.filter(i => !degree.get(i.key)).map(i => i.key);
    for (let j = 0; j < ready.length; j++)
        for (const k of out.get(ready[j])!) {
            degree.set(k, degree.get(k)! - 1);
            if (!degree.get(k))
                ready.push(k);
        }
    if (ready.length !== items.length)
        throw new RangeError('cyclic input; project history before layout');
}
export function columnsFor(items: readonly LayoutItem[], key: string, gap: number): Column[] | null {
    const byKey = new Map(items.map(i => [i.key, i])), root = byKey.get(key);
    if (!root || root.parents.some(p => byKey.has(p)))
        return null;
    const children = new Map<string, LayoutItem[]>();
    for (const item of items) {
        if (item.key === key)
            continue;
        const ps = [...new Set(item.parents)].filter(p => byKey.has(p));
        if (ps.length !== 1)
            return null;
        const list = children.get(ps[0]) ?? [];
        list.push(item);
        children.set(ps[0], list);
    }
    for (const list of children.values())
        list.sort(order);
    const columns: Column[] = [];
    let frontier = children.get(key) ?? [], count = 1;
    while (frontier.length) {
        const next = frontier.flatMap(n => children.get(n.key) ?? []);
        columns.push({ items: frontier, height: frontier.reduce((s, n) => s + n.height, 0) + (frontier.length - 1) * gap, width: Math.max(...frontier.map(n => n.width)), channel: channelFor(frontier, next, children, gap) });
        count += frontier.length;
        frontier = next;
    }
    return count === items.length ? columns : null;
}
/** Interval partitioning: only simultaneously occupied vertical spans need distinct x lanes. */
function channelFor(items: readonly LayoutItem[], next: readonly LayoutItem[], children: ReadonlyMap<string, readonly LayoutItem[]>, gap: number): Column['channel'] {
    const centers = (column: readonly LayoutItem[]) => {
        const result = new Map<string, number>();
        let top = 0;
        for (const item of column) { result.set(item.key, top + item.height / 2); top += item.height + gap; }
        return result;
    };
    const childCenters = centers(next), sourceCenters = centers(items);
    const spans = items.flatMap(item => {
        const targets = children.get(item.key);
        if (!targets?.length) return [];
        const ys = [sourceCenters.get(item.key)!, ...targets.map(child => childCenters.get(child.key)!)];
        return [{ item, low: Math.min(...ys) - 3, high: Math.max(...ys) + 3 }];
    }).sort((a, b) => a.low - b.low || a.high - b.high || order(a.item, b.item));
    const occupiedUntil: number[] = [], lanes = new Map<string, number>();
    for (const span of spans) {
        let lane = 0;
        while (lane < occupiedUntil.length && occupiedUntil[lane] > span.low) lane++;
        occupiedUntil[lane] = span.high;
        lanes.set(span.item.key, lane);
    }
    return { lanes, count: occupiedUntil.length };
}
function shelfFor(columns: readonly Column[], start: number, end: number, request: LayoutRequest, s = spacingFor(request.tileWidth)): Shelf {
    // Callers guarantee 0 <= start < end <= columns.length.
    const exits: string[] = [];
    if (end < columns.length) { const last = columns[end - 1]; for (const n of last.items) if (last.channel.lanes.has(n.key)) exits.push(n.key); }
    let incoming = 1;
    if (start) { const parents = new Set<string>(); for (const n of columns[start].items) for (const p of n.parents) parents.add(p); incoming = parents.size; }
    const left = Math.max(s.top, s.approach + s.clearance + Math.max(0, incoming - 1) * s.lane), right = Math.max(s.bottom, 2 * s.clearance + exits.length * s.lane);
    const gaps: number[] = [], heights: number[] = [];
    let widths = 0, gapSum = 0;
    for (let c = start; c < end - 1; c++) gaps.push(Math.max(s.bandChannel, s.approach + 2 * s.clearance + Math.max(0, columns[c].channel.count - 1) * s.lane));
    for (let c = start; c < end; c++) { widths += columns[c].width; heights.push(columns[c].height); }
    for (const gap of gaps) gapSum += gap;
    return { start, end, left, right, gaps, exits, width: left + right + widths + gapSum, height: Math.max(...heights) };
}
export function partitions(columns: readonly Column[], request: LayoutRequest): readonly number[][] {
    const budget = bandWidthBudget(request.maxWidth, request.tileWidth), n = columns.length;
    const cache = new Map<number, Shelf>(), spacing = spacingFor(request.tileWidth);
    const shelf = (a: number, b: number) => {
      const key = a * (n + 1) + b, found = cache.get(key);
      if (found) return found;
      const built = shelfFor(columns, a, b, request, spacing); cache.set(key, built); return built;
    };
    const feasible = (a: number, b: number) => shelf(a, b).width <= budget;
    const best = Array(n + 1).fill(Infinity), next = Array(n).fill(0);
    best[n] = 0;
    // Bounded scan prevents an unusually wide pane from making search quadratic in chain length.
    for (let a = n - 1; a >= 0; a--)
        for (let b = a + 1; b <= Math.min(n, a + 32); b++) {
            if (!feasible(a, b))
                break;
            const s = shelf(a, b), value = s.height + s.exits.length * TRACK_HEIGHT + spacing.approach + best[b] + .0001 * s.width;
            if (value < best[a]) {
                best[a] = value;
                next[a] = b;
            }
        }
    const plans: number[][] = [];
    if (Number.isFinite(best[0])) {
        const p: number[] = [];
        for (let a = 0; a < n; a = next[a])
            p.push(next[a]);
        plans.push(p);
    }
    for (const limit of [1, 2, 3, 32]) {
        const p: number[] = [];
        let a = 0;
        while (a < n) {
            let b = a + 1;
            if (!feasible(a, b)) {
                b = 0;
                break;
            }
            while (b < n && b - a < limit && feasible(a, b + 1))
                b++;
            p.push(b);
            a = b;
        }
        if (a === n)
            plans.push(p);
    }
    return [...new Map(plans.map(p => [p.join(','), p])).values()];
}
/** An orthogonal polyline as path data: repeated points and collinear interior points are dropped. */
const path = (ps: readonly (readonly [
    number,
    number
])[]): string => {
    const distinct: (readonly [number, number])[] = [];
    for (let i = 0; i < ps.length; i++) if (!i || ps[i][0] !== ps[i - 1][0] || ps[i][1] !== ps[i - 1][1]) distinct.push(ps[i]);
    let d = '';
    for (let i = 0, kept = 0; i < distinct.length; i++) {
        const p = distinct[i];
        if (i && i !== distinct.length - 1 && ((distinct[i - 1][0] === p[0] && p[0] === distinct[i + 1][0]) || (distinct[i - 1][1] === p[1] && p[1] === distinct[i + 1][1]))) continue;
        d += `${kept++ ? ' L' : 'M'}${p[0]} ${p[1]}`;
    }
    return d;
};
export function buildShelves(request: LayoutRequest, columns: readonly Column[], ends: readonly number[]): GraphLayout | null {
    const key = request.band!.key, root = request.items.find(i => i.key === key)!, s = spacingFor(request.tileWidth), budget = bandWidthBudget(request.maxWidth, request.tileWidth);
    const nodes = new Map<string, PlacedNode>(), routes: PlacedRoute[] = [], readingOrder = new Map<string, number>();
    const cx = Math.max(root.width / 2, Math.min(budget - root.width / 2, request.pinned?.x ?? budget / 2));
    nodes.set(key, { key, x: cx - root.width / 2, y: 0, width: root.width, height: root.height, band: 0, row: 0 });
    readingOrder.set(key, 0);
    const shelves: Shelf[] = [], bottoms: number[] = [], top = root.height + STACK_STEM_ROOM;
    let start = 0, y = top;
    for (let row = 0; row < ends.length; row++) {
        const end = ends[row];
        if (end <= start || end > columns.length)
            return null;
        const shelf = shelfFor(columns, start, end, request);
        if (shelf.width > budget)
            return null;
        shelves.push(shelf);
        let x = shelf.left, bottom = y;
        for (let col = start; col < end; col++) {
            let cy = y;
            for (const item of columns[col].items) {
                nodes.set(item.key, { key: item.key, x, y: cy, width: item.width, height: item.height, band: col + 1, row: row + 1 });
                readingOrder.set(item.key, readingOrder.size);
                cy += item.height + s.column;
            }
            bottom = Math.max(bottom, cy - s.column);
            x += columns[col].width + (shelf.gaps[col - start] ?? 0);
        }
        bottoms.push(bottom);
        y = bottom + s.approach + Math.max(1, shelf.exits.length + 1) * TRACK_HEIGHT;
        start = end;
    }
    if (start !== columns.length)
        return null;
    const exitRanks = new Map(shelves.flatMap((shelf, i) => shelf.exits.map((id, j) => [`${i}:${id}`, j] as const)));
    for (const item of request.items) {
        if (item.key === key)
            continue;
        const p = nodes.get(item.parents[0])!, t = nodes.get(item.key)!;
        let points: readonly (readonly [
            number,
            number
        ])[];
        if (p.key === key) {
            const entry = t.x - s.approach;
            points = [[cx, root.height], [cx, root.height + 2 * TRACK_HEIGHT], [entry, root.height + 2 * TRACK_HEIGHT], [entry, t.y + t.height / 2], [t.x - ARROW.length, t.y + t.height / 2]];
        }
        else if (p.row === t.row) {
            const rank = columns[p.band - 1].channel.lanes.get(p.key)!, lane = p.x + columns[p.band - 1].width + s.clearance + rank * s.lane;
            points = [[p.x + p.width, p.y + p.height / 2], [lane, p.y + p.height / 2], [lane, t.y + t.height / 2], [t.x - ARROW.length, t.y + t.height / 2]];
        }
        else {
            const shelf = shelves[p.row - 1], rank = exitRanks.get(`${p.row - 1}:${p.key}`)!, exit = shelf.width - shelf.right + s.clearance + (rank + 1) * s.lane, entry = t.x - s.approach - rank * s.lane, lane = bottoms[p.row - 1] + TRACK_HEIGHT * (rank + 1);
            if (entry < s.clearance || exit > budget - s.clearance)
                return null;
            points = [[p.x + p.width, p.y + p.height / 2], [exit, p.y + p.height / 2], [exit, lane], [entry, lane], [entry, t.y + t.height / 2], [t.x - ARROW.length, t.y + t.height / 2]];
        }
        routes.push({ id: `compact:${item.parents[0]}:${item.key}`, from: { kind: 'node', id: item.parents[0] }, to: { kind: 'node', id: item.key }, consumers: [{ parent: item.parents[0], child: item.key }], terminal: true, path: path(points) });
    }
    return { orientation: 'right', width: budget, height: (bottoms.at(-1) ?? root.height) + s.bottom, nodes, routes, junctions: new Map(), rows: [], readingOrder };
}

