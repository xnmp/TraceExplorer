import type { GraphLayout, LayoutItem, PlacedNode, PlacedRoute } from "./layout";
import { ARROW, STACK_STEM_ROOM } from "./metrics";
import { flattenInto, flattened, flattenPath, type Point } from "./path-sampling";
import { isSpace } from "./path-data";
export type Segment = readonly [
    Point,
    Point
];
export const segments = (path: string): Segment[] => {
    const p = flattenPath(path), out: Segment[] = [];
    if (p) for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
    return out;
};
const EPS = .001;
/** `Math.hypot(dx, dy)`, skipping it on an axis: hypot with a zero leg is exactly the other leg's magnitude. */
const distance = (dx: number, dy: number): number => dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.hypot(dx, dy);
export function intersectsTile(segment: Segment, r: PlacedNode, clearance = .25): boolean {
    const a = segment[0], b = segment[1];
    return clipsTile(a.x, a.y, b.x, b.y, r, clearance);
}
/** {@link intersectsTile} of the segment (ax, ay)-(bx, by), on plain coordinates. */
function clipsTile(ax: number, ay: number, bx: number, by: number, r: PlacedNode, clearance = .25): boolean {
    const left = r.x + clearance, right = r.x + r.width - clearance, top = r.y + clearance, bottom = r.y + r.height - clearance;
    if (right <= left || bottom <= top) return false;
    // Wholly on one side of the inset rectangle: the clip below would find no interior span either.
    if ((ax <= left && bx <= left) || (ax >= right && bx >= right) || (ay <= top && by <= top) || (ay >= bottom && by >= bottom)) return false;
    let lo = 0, hi = 1;
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) < EPS && (ax <= left || ax >= right) || Math.abs(dy) < EPS && (ay <= top || ay >= bottom)) return false;
    if (Math.abs(dx) < EPS) { if (ax <= left || ax >= right) return false; }
    else { const t1 = (left - ax) / dx, t2 = (right - ax) / dx; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
    if (Math.abs(dy) < EPS) { if (ay <= top || ay >= bottom) return false; }
    else { const t1 = (top - ay) / dy, t2 = (bottom - ay) / dy; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
    return hi > lo + EPS;
}
export function crossing([a, b]: Segment, [c, d]: Segment): Point | null {
    const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, det = dx * ey - dy * ex;
    if (Math.abs(det) < EPS)
        return null;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / det, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / det;
    // Non-collinear contacts count too; common endpoint/junction contacts are excluded by the caller.
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? { x: a.x + t * dx, y: a.y + t * dy } : null;
}
export function overlapLength([a, b]: Segment, [c, d]: Segment): number { return collinearOverlap(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y); }
/** {@link overlapLength} of segments (ax, ay)-(bx, by) and (cx, cy)-(ex, ey), on plain coordinates for the hot joins. */
function collinearOverlap(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, ex: number, ey: number): number {
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx * (cy - ay) - dy * (cx - ax)) > EPS || Math.abs(dx * (ey - ay) - dy * (ex - ax)) > EPS) return 0;
    const length = distance(dx, dy);
    if (length < EPS) return 0;
    const t1 = ((cx - ax) * dx + (cy - ay) * dy) / length, t2 = ((ex - ax) * dx + (ey - ay) * dy) / length;
    return Math.max(0, Math.min(length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)));
}
interface Bounds { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }
const boundsOf = ([a, b]: Segment): Bounds => ({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
const touches = (a: Bounds, b: Bounds, tolerance = EPS): boolean => a.maxX >= b.minX - tolerance && b.maxX >= a.minX - tolerance && a.maxY >= b.minY - tolerance && b.maxY >= a.minY - tolerance;


/** The reference broad phase: cells keyed by one number in a Map. Long spans use a bounded fallback rather than allocating unbounded bins. */
class KeyedBins {
    /** Cells keyed by one number; coordinates beyond ±2^20 cells share keys harmlessly (results are filtered exactly). */
    private readonly bins = new Map<number, number[]>();
    private readonly wide: number[] = [];
    private readonly seen: Uint32Array;
    private readonly result: number[] = [];
    private stamp = 0;
    constructor(private readonly bounds: readonly Bounds[], private readonly size = 96, private readonly margin = 0) { this.seen = new Uint32Array(bounds.length); }
    private static cell(x: number, y: number): number { return x * 2097152 + y; }
    add(index: number): void {
        const b = this.bounds[index], x0 = Math.floor((b.minX - this.margin) / this.size), x1 = Math.floor((b.maxX + this.margin) / this.size), y0 = Math.floor((b.minY - this.margin) / this.size), y1 = Math.floor((b.maxY + this.margin) / this.size);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.wide.push(index); return; }
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const key = KeyedBins.cell(x, y), list = this.bins.get(key);
            if (list) list.push(index); else this.bins.set(key, [index]);
        }
    }
    private append(index: number, query: Bounds): void {
        if (this.seen[index] === this.stamp) return;
        this.seen[index] = this.stamp;
        if (touches(query, this.bounds[index], this.margin + EPS)) this.result.push(index);
    }
    /** Result storage is reused; callers consume it before making another query. */
    candidates(b: Bounds): readonly number[] {
        this.result.length = 0;
        if (++this.stamp === 0xffffffff) { this.seen.fill(0); this.stamp = 1; }
        const x0 = Math.floor(b.minX / this.size), x1 = Math.floor(b.maxX / this.size), y0 = Math.floor(b.minY / this.size), y1 = Math.floor(b.maxY / this.size);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
            // Only already indexed entries are eligible during the incremental crossing join.
            for (const list of this.bins.values()) for (const index of list) this.append(index, b);
        } else {
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                const list = this.bins.get(KeyedBins.cell(x, y));
                if (list) for (let i = 0; i < list.length; i++) this.append(list[i], b);
            }
        }
        for (const index of this.wide) this.append(index, b);
        return this.result;
    }
}

/** Cell coordinates whose {@link KeyedBins} keys are exact and distinct: a dense array can stand in for the Map. */
const exactCells = (x0: number, x1: number, y0: number, y1: number) => x0 > -2147483648 && x1 < 2147483648 && y0 > -1048576 && y1 < 1048576;

/**
 * A sparse broad phase with exactly {@link KeyedBins}' candidates in exactly its order: cells
 * scanned x-major, each cell's entries in insertion order, first sighting wins, wide entries last.
 * Cells live in a dense array while every key involved is exact and distinct (and the grid is
 * small); the first entry or query outside that replays the insertions into a KeyedBins, which
 * then answers everything, so its aliasing of far-out keys is reproduced too.
 */
class SpatialBins {
    private readonly seen: Uint32Array;
    private readonly result: number[] = [];
    private readonly wide: number[] = [];
    /** Insertion log, replayed if the reference takes over. */
    private readonly added: number[] = [];
    /** Dense cell indices in first-use order: the reference Map's iteration order. */
    private readonly created: number[] = [];
    private readonly cells: (number[] | undefined)[] = [];
    private readonly gx0: number = Infinity;
    private readonly gx1: number = -Infinity;
    private readonly gy0: number = Infinity;
    private readonly gy1: number = -Infinity;
    private keyed: KeyedBins | undefined;
    private stamp = 0;
    constructor(private readonly bounds: readonly Bounds[], private readonly size = 96, private readonly margin = 0) {
        this.seen = new Uint32Array(bounds.length);
        let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
        for (const b of bounds) {
            const x0 = Math.floor((b.minX - margin) / size), x1 = Math.floor((b.maxX + margin) / size), y0 = Math.floor((b.minY - margin) / size), y1 = Math.floor((b.maxY + margin) / size);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096 || !exactCells(x0, x1, y0, y1)) continue;
            if (x0 < gx0) gx0 = x0;
            if (x1 > gx1) gx1 = x1;
            if (y0 < gy0) gy0 = y0;
            if (y1 > gy1) gy1 = y1;
        }
        const count = gx1 >= gx0 ? (gx1 - gx0 + 1) * (gy1 - gy0 + 1) : 0;
        if (count > Math.min(1 << 20, Math.max(4096, 16 * bounds.length))) { this.keyed = new KeyedBins(bounds, size, margin); return; }
        this.gx0 = gx0; this.gx1 = gx1; this.gy0 = gy0; this.gy1 = gy1;
        this.cells = new Array(count);
    }
    private reference(): KeyedBins {
        if (!this.keyed) {
            const keyed = new KeyedBins(this.bounds, this.size, this.margin);
            for (const index of this.added) keyed.add(index);
            this.keyed = keyed;
        }
        return this.keyed;
    }
    add(index: number): void {
        if (this.keyed) { this.keyed.add(index); return; }
        const b = this.bounds[index], x0 = Math.floor((b.minX - this.margin) / this.size), x1 = Math.floor((b.maxX + this.margin) / this.size), y0 = Math.floor((b.minY - this.margin) / this.size), y1 = Math.floor((b.maxY + this.margin) / this.size);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.wide.push(index); this.added.push(index); return; }
        if (!exactCells(x0, x1, y0, y1) || x0 < this.gx0 || x1 > this.gx1 || y0 < this.gy0 || y1 > this.gy1) { this.reference().add(index); return; }
        const height = this.gy1 - this.gy0 + 1;
        for (let x = x0; x <= x1; x++) for (let y = y0, cell = (x - this.gx0) * height + y0 - this.gy0; y <= y1; y++, cell++) {
            const list = this.cells[cell];
            if (list) list.push(index); else { this.cells[cell] = [index]; this.created.push(cell); }
        }
        this.added.push(index);
    }
    private append(index: number, query: Bounds): void {
        if (this.seen[index] === this.stamp) return;
        this.seen[index] = this.stamp;
        if (touches(query, this.bounds[index], this.margin + EPS)) this.result.push(index);
    }
    /** Result storage is reused; callers consume it before making another query. */
    candidates(b: Bounds): readonly number[] {
        if (this.keyed) return this.keyed.candidates(b);
        const x0 = Math.floor(b.minX / this.size), x1 = Math.floor(b.maxX / this.size), y0 = Math.floor(b.minY / this.size), y1 = Math.floor(b.maxY / this.size);
        const wideQuery = (x1 - x0 + 1) * (y1 - y0 + 1) > 4096;
        if (!wideQuery && !exactCells(x0, x1, y0, y1)) return this.reference().candidates(b);
        this.result.length = 0;
        if (++this.stamp === 0xffffffff) { this.seen.fill(0); this.stamp = 1; }
        if (wideQuery) {
            for (const cell of this.created) for (const index of this.cells[cell]!) this.append(index, b);
        } else {
            const height = this.gy1 - this.gy0 + 1, ya = Math.max(y0, this.gy0), yb = Math.min(y1, this.gy1);
            for (let x = Math.max(x0, this.gx0), xb = Math.min(x1, this.gx1); x <= xb; x++) for (let y = ya, cell = (x - this.gx0) * height + ya - this.gy0; y <= yb; y++, cell++) {
                const list = this.cells[cell];
                if (list) for (let i = 0; i < list.length; i++) this.append(list[i], b);
            }
        }
        for (const index of this.wide) this.append(index, b);
        return this.result;
    }
}

/** The flattener serves animation too; validity additionally rejects skipped punctuation and move-only paths.
 * Equal to checking the unwrapped body (`M` first and only, plain data) and then flattening `path`:
 * whenever the body passes, `flattenPath` unwraps `path` to that same body.
 * Returns the polyline's coordinates (x, y per point), or null. */
function routeCoordinates(path: string): Float64Array | null {
    const trimmed = isSpace(path.charCodeAt(0)) || isSpace(path.charCodeAt(path.length - 1)) ? path.trim() : path;
    const body = trimmed.startsWith('path(') ? trimmed.replace(/^path\(\s*["']?|["']?\s*\)$/g, "") : trimmed;
    const count = flattenInto(body, true);
    return count > 1 ? flattened().slice(0, 2 * count) : null;
}

export interface RoutePlan {
    readonly points: readonly Point[] | null;
    readonly segments: readonly Segment[];
    readonly bounds: Bounds;
    readonly length: number;
    readonly bends: number;
}

export interface RouteMetrics { readonly length: number; readonly bends: number }
/**
 * A route's parsed polyline. Points live as plain coordinates (point `k` at `xy[2k]`, `xy[2k + 1]`;
 * segment `k` runs from point `k` to point `k + 1`), so scoring allocates no point or segment objects.
 */
interface RouteData {
    /** The path this was parsed from: a mutated route object is parsed again. */
    readonly path: string;
    /** Null when the path is invalid. Private and never mutated. */
    readonly xy: Float64Array | null;
    /** Number of drawn segments: points minus one, or zero. */
    readonly count: number;
    readonly bounds: Bounds;
    /** Soft terms, computed on first use: hard validation needs only the samples. */
    metrics?: RouteMetrics;
    /** The frozen public views, built only when requested. */
    plan?: RoutePlan;
    publicBounds?: Bounds;
    publicPoints?: readonly Point[] | null;
    publicSegments?: readonly Segment[];
}

const routePlans = new WeakMap<PlacedRoute, RouteData>();

/** Geometry-only memoization: context and consumer metadata are never cached.
 * Frozen results remain immutable even for external callers; path equality detects mutated input objects. */
function routeData(route: PlacedRoute): RouteData {
    const cached = routePlans.get(route);
    if (cached?.path === route.path) return cached;
    const xy = routeCoordinates(route.path);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (xy) for (let k = 0; k < xy.length; k += 2) {
        const x = xy[k], y = xy[k + 1];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const data: RouteData = { path: route.path, xy, count: xy ? xy.length / 2 - 1 : 0, bounds: { minX, maxX, minY, maxY } };
    routePlans.set(route, data);
    return data;
}

function metricsOf(data: RouteData): RouteMetrics {
    if (data.metrics) return data.metrics;
    let length = 0, turning = 0, previousX = 0, previousY = 0, hasPrevious = false;
    const xy = data.xy;
    if (xy) for (let k = 2; k < xy.length; k += 2) {
        const dx = xy[k] - xy[k - 2], dy = xy[k + 1] - xy[k - 1], span = distance(dx, dy);
        length += span;
        if (span > EPS) {
            if (hasPrevious) {
                // |atan2| is exactly 0 straight ahead and exactly π/2 square to the last run (adding 0 changes no sum).
                const cross = previousX * dy - previousY * dx, dot = previousX * dx + previousY * dy;
                if (!(cross === 0 && dot > 0)) turning += dot === 0 && cross !== 0 && cross === cross ? Math.PI / 2 : Math.abs(Math.atan2(cross, dot));
            }
            previousX = dx; previousY = dy; hasPrevious = true;
        }
    }
    return data.metrics = Object.freeze({ length, bends: turning / (Math.PI / 2) });
}

/**
 * A connector's `length` and `bends`, exactly as {@link routePlan} reports them, without
 * materialising the public plan. The object is frozen and shared by later calls.
 */
export function routeMetrics(route: PlacedRoute): RouteMetrics { return metricsOf(routeData(route)); }

/** A connector's bounds, exactly as {@link routePlan} reports them (the same frozen object), without materialising the plan. */
export function routeBounds(route: PlacedRoute): Bounds { return publicBounds(routeData(route)); }
const publicBounds = (data: RouteData): Bounds => data.publicBounds ??= Object.freeze({ ...data.bounds });

/** The frozen public points; the coordinates stay private and are never mutated. */
function publicPoints(data: RouteData): readonly Point[] | null {
    if (data.publicPoints !== undefined) return data.publicPoints;
    const xy = data.xy;
    if (!xy) return data.publicPoints = null;
    const points: Point[] = [];
    for (let k = 0; k < xy.length; k += 2) points.push(Object.freeze({ x: xy[k], y: xy[k + 1] }));
    return data.publicPoints = Object.freeze(points);
}

function publicSegments(data: RouteData): readonly Segment[] {
    if (data.publicSegments) return data.publicSegments;
    const view = publicPoints(data), list: Segment[] = [];
    if (view) for (let index = 0; index < data.count; index++) list.push(Object.freeze([view[index], view[index + 1]] as const));
    return data.publicSegments = Object.freeze(list);
}

export function routePlan(route: PlacedRoute): RoutePlan {
    const data = routeData(route);
    // Frozen public views are materialized only when requested.
    return data.plan ??= Object.freeze({
        get points() { return publicPoints(data); },
        get segments() { return publicSegments(data); },
        bounds: publicBounds(data),
        get length() { return metricsOf(data).length; }, get bends() { return metricsOf(data).bends; } });
}

/** Count strict visual-order inversions, retaining the evaluator's coordinate tolerance. */
function countInversions(values: readonly number[]): number {
    let largest = -Infinity, ordered = true;
    for (const value of values) { if (value + EPS < largest) ordered = false; largest = Math.max(largest, value); }
    if (ordered) return 0;
    const sorted = [...values].sort((a, b) => a - b), counts = new Uint32Array(sorted.length + 1);
    const bound = (value: number, inclusive: boolean): number => {
        let low = 0, high = sorted.length;
        while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle] < value || (inclusive && sorted[middle] === value)) low = middle + 1; else high = middle; }
        return low;
    };
    let inversions = 0, seen = 0;
    for (const value of values) {
        let smaller = 0;
        for (let index = bound(value + EPS, true); index; index -= index & -index) smaller += counts[index];
        inversions += seen++ - smaller;
        for (let index = bound(value, false) + 1; index < counts.length; index += index & -index) counts[index]++;
    }
    return inversions;
}

/** A coordinate neighbor proves alignment; sorting avoids an all-pairs scan. Counts the nodes other than `coverKey`. */
function countUnaligned(layout: GraphLayout, coverKey: string, children: number): number {
    if (children < 2) return 0;
    if (children <= 32) {
        // The reference's all-pairs scan, over the children in Map order.
        let unaligned = 0;
        for (const n of layout.nodes.values()) {
            if (n.key === coverKey) continue;
            let aligned = false;
            for (const p of layout.nodes.values()) if (p.key !== coverKey && p.key !== n.key && (Math.abs(p.x - n.x) < .5 || Math.abs(p.y - n.y) < .5)) { aligned = true; break; }
            if (!aligned) unaligned++;
        }
        return unaligned;
    }
    const nodes = [...layout.nodes.values()].filter(n => n.key !== coverKey);
    const aligned = new Set<string>();
    for (const axis of ['x', 'y'] as const) {
        const ordered = [...nodes].sort((a, b) => a[axis] - b[axis]);
        for (let index = 1; index < ordered.length; index++) if (ordered[index][axis] - ordered[index - 1][axis] < .5) {
            aligned.add(ordered[index].key); aligned.add(ordered[index - 1].key);
        }
    }
    return nodes.length - aligned.size;
}

/**
 * Sibling groups of a request: items sharing one parent set, two or more, each in display order,
 * as item keys. They depend only on the items' keys, orders and parents, which the memo keeps
 * a copy of and compares in full, so an items array mutated in place is grouped afresh.
 */
interface SiblingGroups { readonly inputs: readonly unknown[]; readonly groups: readonly (readonly string[])[] }
const siblingMemo = new WeakMap<readonly LayoutItem[], SiblingGroups>();

function siblingInputs(items: readonly LayoutItem[]): unknown[] {
    const out: unknown[] = [items.length];
    for (const n of items) {
        const parents = n.parents;
        out.push(n.key, n.order, parents.length);
        for (let i = 0; i < parents.length; i++) out.push(parents[i]);
    }
    return out;
}

function sameSiblingInputs(items: readonly LayoutItem[], known: readonly unknown[]): boolean {
    if (!Object.is(known[0], items.length)) return false;
    let at = 1;
    for (const n of items) {
        const parents = n.parents;
        if (!Object.is(known[at++], n.key) || !Object.is(known[at++], n.order) || !Object.is(known[at++], parents.length)) return false;
        for (let i = 0; i < parents.length; i++) if (!Object.is(known[at++], parents[i])) return false;
    }
    return at === known.length;
}

function siblingGroups(items: readonly LayoutItem[]): readonly (readonly string[])[] {
    const memo = siblingMemo.get(items);
    if (memo && sameSiblingInputs(items, memo.inputs)) return memo.groups;
    const byParents = new Map<string, LayoutItem[]>();
    for (const n of items) {
        const k = n.parents.length === 1 ? n.parents[0] : [...n.parents].sort().join('\u0000');
        if (!k)
            continue;
        const group = byParents.get(k);
        if (group) group.push(n); else byParents.set(k, [n]);
    }
    const groups: string[][] = [];
    for (const group of byParents.values()) {
        // A lone sibling has no order to invert.
        if (group.length < 2) continue;
        group.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
        groups.push(group.map(n => n.key));
    }
    siblingMemo.set(items, { inputs: siblingInputs(items), groups });
    return groups;
}

/** Sibling order inversions: the reference's `countInversions` of each group's placed visual positions. */
function siblingInversions(layout: GraphLayout, items: readonly LayoutItem[]): number {
    let inversions = 0;
    const right = layout.orientation === 'right';
    for (const group of siblingGroups(items)) {
        // countInversions' ordered pass, streamed: the values are built only when it finds an inversion.
        let largest = -Infinity, ordered = true;
        for (const key of group) {
            const n = layout.nodes.get(key);
            if (!n) continue;
            const value = right ? n.row * 1e9 + n.x * 1e5 + n.y : n.y * 1e5 + n.x;
            if (value + EPS < largest) ordered = false;
            largest = Math.max(largest, value);
        }
        if (ordered) continue;
        const values: number[] = [];
        for (const key of group) { const n = layout.nodes.get(key); if (n) values.push(right ? n.row * 1e9 + n.x * 1e5 + n.y : n.y * 1e5 + n.x); }
        inversions += countInversions(values);
    }
    return inversions;
}

export interface Measures {
    height: number;
    width: number;
    area: number;
    tileArea: number;
    whitespace: number;
    paneWhitespace: number;
    length: number;
    bends: number;
    crossings: number;
    sharedLanePx: number;
    tileIntersections: number;
    overlaps: number;
    directionViolations: number;
    mixedDirections: number;
    siblingInversions: number;
    unaligned: number;
    overflow: number;
    displacement: number;
    maxDisplacement: number;
    movedFraction: number;
    anchorDisplacement: number;
    missingEdges: number;
    extraEdges: number;
    missingNodes: number;
    extraNodes: number;
    invalidGeometry: number;
    invalidPaths: number;
    terminalViolations: number;
    disconnectedEdges: number;
}

/** Parent-to-child placements: violations are hard, the rightward/downward split prices mixing. */
function directionCounts(layout: GraphLayout, items: readonly LayoutItem[]) {
    let directionViolations = 0, right = 0, down = 0;
    for (const item of items) {
        if (!item.parents.length) continue;
        const c = layout.nodes.get(item.key);
        for (const id of item.parents) {
            const p = layout.nodes.get(id);
            if (!p || !c)
                continue;
            if (c.x >= p.x + p.width - EPS && c.row === p.row && layout.orientation === 'right')
                right++;
            else if (c.y >= p.y + p.height - EPS)
                down++;
            else if (c.x >= p.x + p.width - EPS)
                right++;
            else
                directionViolations++;
        }
    }
    return { directionViolations, right, down };
}

/** The node penalties beyond the direction counts; they never gate. */
function softPenalties(layout: GraphLayout, coverKey: string, items: readonly LayoutItem[], previous: GraphLayout | undefined, anchorKey: string | undefined,
    directionViolations: number, right: number, down: number) {
    const inversions = siblingInversions(layout, items);
    let children = 0, moved = 0, total = 0, largest = 0, far = 0;
    for (const n of layout.nodes.values()) {
        if (n.key === coverKey) continue;
        children++;
        const p = previous?.nodes.get(n.key);
        if (!p) continue;
        const move = distance(n.x - p.x, n.y - p.y);
        moved++; total = total + move; largest = Math.max(largest, move);
        if (move > .5) far++;
    }
    if (moved > SPREAD_SAFE) {
        // The reference spread `Math.max(0, ...moves)` may throw here; let it.
        const moves: number[] = [];
        for (const n of layout.nodes.values()) { if (n.key === coverKey) continue; const p = previous?.nodes.get(n.key); if (p) moves.push(distance(n.x - p.x, n.y - p.y)); }
        largest = Math.max(0, ...moves);
    }
    const anchor = anchorKey ? layout.nodes.get(anchorKey) : undefined, oldAnchor = anchorKey ? previous?.nodes.get(anchorKey) : undefined;
    return { directionViolations, mixedDirections: Math.min(right, down), siblingInversions: inversions, unaligned: countUnaligned(layout, coverKey, children),
        displacement: moved ? total / moved : 0,
        maxDisplacement: largest, movedFraction: moved ? far / moved : 0,
        anchorDisplacement: anchor && oldAnchor ? distance(anchor.x - oldAnchor.x, anchor.y - oldAnchor.y) : 0 };
}

const gatePenalties = (directionViolations: number) => ({ directionViolations, mixedDirections: 0, siblingInversions: 0, unaligned: 0,
    displacement: 0, maxDisplacement: 0, movedFraction: 0, anchorDisplacement: 0 });

/** Pure node penalties, shared by the complete objective and its optimistic bound. */
export function nodePenalties(layout: GraphLayout, coverKey: string, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string, gatesOnly = false) {
    const { directionViolations, right, down } = directionCounts(layout, items);
    return gatesOnly ? gatePenalties(directionViolations) : softPenalties(layout, coverKey, items, previous, anchorKey, directionViolations, right, down);
}

/** A requested parent-child edge and the routes drawing it, in route order. */
interface ExpectedEdge { readonly parent: string; readonly child: string; readonly carriers: readonly number[] }

/** Requested edges (each once, in request order), how many requested edges are not drawn and drawn ones not requested, and which routes share an edge (whose connectivity needs geometric joins). */
interface EdgeIndex {
    readonly expected: readonly ExpectedEdge[];
    readonly missing: number;
    readonly extra: number;
    readonly joinedRoutes: Uint8Array;
    readonly needsJoins: boolean;
}

/** The requested item keys, each once in first-seen order, numbered in that order. */
function wantedKeys(items: readonly LayoutItem[]): Map<string, number> {
    const wanted = new Map<string, number>();
    for (const n of items) if (!wanted.has(n.key)) wanted.set(n.key, wanted.size);
    return wanted;
}

/**
 * The reference keys an edge by `${parent}\u0000${child}`. When every requested key is a string
 * without U+0000, those keys are equal exactly when both endpoints are, and splitting one gives
 * back its endpoints, so edges can be keyed by their endpoints' numbers instead of building strings.
 */
function edgeIndex(layout: GraphLayout, items: readonly LayoutItem[], wanted: ReadonlyMap<string, number>): EdgeIndex {
    for (const key of wanted.keys()) if (typeof key !== "string" || key.indexOf("\u0000") >= 0) return keyedEdgeIndex(layout, items, wanted);
    const keys = wanted.size, small = keys * keys <= 4096;
    // Edge records: requested ones first (in request order), then those only drawn.
    const parents: string[] = [], children: string[] = [], carriers: number[][] = [], requested: boolean[] = [], drawn: boolean[] = [];
    const slots = small ? new Int32Array(keys * keys).fill(-1) : undefined, slotMap = small ? undefined : new Map<number, number>();
    const record = (pair: number, parent: string, child: string, isRequested: boolean): number => {
        let slot = slots ? slots[pair] : slotMap!.get(pair) ?? -1;
        if (slot < 0) {
            slot = parents.length;
            parents.push(parent); children.push(child); carriers.push([]); requested.push(isRequested); drawn.push(false);
            if (slots) slots[pair] = slot; else slotMap!.set(pair, slot);
        }
        return slot;
    };
    for (const item of items) {
        const child = wanted.get(item.key)!;
        for (const parent of item.parents) {
            const from = wanted.get(parent);
            if (from !== undefined) record(from * keys + child, parent, item.key, true);
        }
    }
    for (let i = 0; i < layout.routes.length; i++) for (const c of layout.routes[i].consumers) {
        const from = wanted.get(c.parent), to = wanted.get(c.child);
        if (from === undefined || to === undefined) continue;
        const slot = record(from * keys + to, c.parent, c.child, false), list = carriers[slot];
        drawn[slot] = true;
        if (list[list.length - 1] !== i) list.push(i);
    }
    const joinedRoutes = new Uint8Array(layout.routes.length), expected: ExpectedEdge[] = [];
    let needsJoins = false, missing = 0, extra = 0;
    for (let slot = 0; slot < parents.length; slot++) {
        if (!requested[slot]) { if (drawn[slot]) extra++; continue; }
        if (!drawn[slot]) missing++;
        const list = carriers[slot];
        if (list.length > 1) { needsJoins = true; for (const index of list) joinedRoutes[index] = 1; }
        expected.push({ parent: parents[slot], child: children[slot], carriers: list });
    }
    return { expected, missing, extra, joinedRoutes, needsJoins };
}

/** The reference edge index, on string keys. */
function keyedEdgeIndex(layout: GraphLayout, items: readonly LayoutItem[], wanted: ReadonlyMap<string, number>): EdgeIndex {
    const expected = new Set<string>(), drawn = new Set<string>(), carrying = new Map<string, number[]>();
    for (const item of items) for (const parent of item.parents) if (wanted.has(parent)) expected.add(`${parent}\u0000${item.key}`);
    layout.routes.forEach((r, i) => {
        for (const c of r.consumers) if (wanted.has(c.parent) && wanted.has(c.child)) {
            const key = `${c.parent}\u0000${c.child}`; drawn.add(key);
            const list = carrying.get(key);
            if (!list) carrying.set(key, [i]); else if (list.at(-1) !== i) list.push(i);
        }
    });
    const joinedRoutes = new Uint8Array(layout.routes.length);
    let needsJoins = false, missing = 0, extra = 0;
    for (const edge of expected) {
        const indices = carrying.get(edge);
        if (indices && indices.length > 1) { needsJoins = true; for (const index of indices) joinedRoutes[index] = 1; }
    }
    for (const e of expected) if (!drawn.has(e)) missing++;
    for (const e of drawn) if (!expected.has(e)) extra++;
    const list: ExpectedEdge[] = [];
    for (const edge of expected) { const [parent, child] = edge.split('\u0000'); list.push({ parent, child, carriers: carrying.get(edge) ?? [] }); }
    return { expected: list, missing, extra, joinedRoutes, needsJoins };
}

/** Every hard gate except connectivity, plus what connectivity and the soft terms reuse. */
interface HardGates {
    readonly height: number;
    readonly width: number;
    readonly area: number;
    readonly tileArea: number;
    readonly whitespace: number;
    readonly paneWhitespace: number;
    readonly tileIntersections: number;
    readonly overlaps: number;
    readonly directionViolations: number;
    readonly overflow: number;
    readonly missingEdges: number;
    readonly extraEdges: number;
    readonly missingNodes: number;
    readonly extraNodes: number;
    readonly invalidGeometry: number;
    readonly invalidPaths: number;
    readonly terminalViolations: number;
    /** The rightward and downward placements behind the soft `mixedDirections`. */
    readonly right: number;
    readonly down: number;
    /** Long joined routes: connectivity then queries a segment index even without the crossing join. */
    readonly tallJoins: boolean;
}

/** Argument counts beyond which the reference spread `Math.min(...)`/`Math.max(...)` may throw; loops stop standing in for it there. */
const SPREAD_SAFE = 32768;

/** `Math.min(...ys)` of the non-cover nodes, as the reference spread computes it (a fold gives the same value, NaN and signed zeros included). */
function firstChildRow(layout: GraphLayout, coverKey: string): { first: number; children: number } {
    let first = Infinity, children = 0;
    for (const n of layout.nodes.values()) if (n.key !== coverKey) { first = Math.min(first, n.y); children++; }
    if (children > SPREAD_SAFE) first = Math.min(...[...layout.nodes.values()].filter(n => n.key !== coverKey).map(n => n.y));
    return { first, children };
}

/** The requested item `key` resolves to: the last one with that key, as a Map built from the list holds. */
function requestedItem(items: readonly LayoutItem[], byKey: ReadonlyMap<string, LayoutItem> | undefined, key: string): LayoutItem | undefined {
    if (byKey) return byKey.get(key);
    for (let i = items.length - 1; i >= 0; i--) { const k = items[i].key; if (k === key || (k !== k && key !== key)) return items[i]; }
    return undefined;
}

function hardGates(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[], routeGeometry: readonly RouteData[], edges: EdgeIndex, wanted: ReadonlyMap<string, number>): HardGates {
    let missingNodes = 0, extraNodes = 0;
    for (const k of wanted.keys()) if (!layout.nodes.has(k)) missingNodes++;
    for (const k of layout.nodes.keys()) if (!wanted.has(k)) extraNodes++;
    // Small requests are scanned directly (Map keys compare as SameValueZero, as the scan does).
    let requested: Map<string, LayoutItem> | undefined;
    if (items.length > 16) { requested = new Map(); for (const n of items) requested.set(n.key, n); }
    const orientation = layout.orientation, bandBounds = layout.bandBounds;
    let invalidGeometry = Number(!Number.isFinite(layout.width) || !Number.isFinite(layout.height) || layout.width < 0 || layout.height < 0 || !(orientation === "right" || orientation === "down"));
    layout.nodes.forEach((n, key) => {
        const item = requestedItem(items, requested, n.key);
        if (key !== n.key || !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.width) || !Number.isFinite(n.height)
            || n.width <= 0 || n.height <= 0 || n.x < -.1 || n.y < -.1 || n.x + n.width > layout.width + .1 || n.y + n.height > layout.height + .1
            || Math.abs(n.width - (item?.width ?? n.width)) > .1 || Math.abs(n.height - (item?.height ?? n.height)) > .1) invalidGeometry++;
    });
    let invalidPaths = 0;
    for (const plan of routeGeometry) if (!plan.xy) invalidPaths++;
    const { first, children } = firstChildRow(layout, coverKey);
    const needEnvelope = bandBounds?.left == null || bandBounds?.width == null;
    let envelopeLeft = Infinity, envelopeRight = -Infinity, tileArea = 0;
    for (const n of layout.nodes.values()) if (n.key !== coverKey) {
        if (needEnvelope) { envelopeLeft = Math.min(envelopeLeft, n.x - (orientation === 'right' ? 16 : 0)); envelopeRight = Math.max(envelopeRight, n.x + n.width); }
        tileArea = tileArea + n.width * n.height;
    }
    for (let route = 0; route < routeGeometry.length; route++) {
        const plan = routeGeometry[route], b = plan.bounds, xy = plan.xy;
        if (xy) {
            if (!Number.isFinite(b.minX) || !Number.isFinite(b.minY) || !Number.isFinite(b.maxX) || !Number.isFinite(b.maxY)
                || b.minX < -.1 || b.minY < -.1 || b.maxX > layout.width + .1 || b.maxY > layout.height + .1) invalidGeometry++;
            if (needEnvelope) {
                if (layout.routes[route].from.id !== coverKey) { envelopeLeft = Math.min(envelopeLeft, b.minX); envelopeRight = Math.max(envelopeRight, b.maxX); }
                else for (let k = 0; k < xy.length; k += 2) if (xy[k + 1] >= first - 16) { envelopeLeft = Math.min(envelopeLeft, xy[k]); envelopeRight = Math.max(envelopeRight, xy[k]); }
            }
        }
    }
    for (const j of layout.junctions.values()) if (!(Number.isFinite(j.x) && Number.isFinite(j.y)) || j.x < -.1 || j.y < -.1 || j.x > layout.width + .1 || j.y > layout.height + .1) invalidGeometry++;
    const left = bandBounds?.left ?? envelopeLeft - 8, width = children ? bandBounds?.width ?? envelopeRight + 8 - left : 0;
    const height = children ? Math.max(0, layout.height - (bandBounds?.top ?? first) + STACK_STEM_ROOM) : 0;
    const area = width * height;
    const { tileIntersections, overlaps } = tileContacts(layout, routeGeometry, invalidGeometry);
    let terminalViolations = 0;
    const terminalCounts = new Map<string, number>();
    for (const route of layout.routes) if (route.terminal && route.to.kind === 'node') terminalCounts.set(route.to.id, (terminalCounts.get(route.to.id) ?? 0) + 1);
    for (const item of items) {
        let hasParents = false;
        for (const p of item.parents) if (wanted.has(p)) { hasParents = true; break; }
        if ((terminalCounts.get(item.key) ?? 0) !== (hasParents ? 1 : 0)) terminalViolations++;
    }
    for (let i = 0; i < layout.routes.length; i++) {
        const r = layout.routes[i];
        if (!r.terminal) continue;
        const n = layout.nodes.get(r.to.id), xy = routeGeometry[i].xy;
        if (!n || r.to.kind !== 'node' || !xy) { terminalViolations++; continue; }
        // The last drawn segment, from point (ax, ay) to (bx, by).
        const end = xy.length, ax = xy[end - 4], ay = xy[end - 3], bx = xy[end - 2], by = xy[end - 1];
        const vertical = Math.abs(bx - n.x - n.width / 2) < .1 && Math.abs(by - n.y + ARROW.length) < .1 && Math.abs(ax - bx) < .1 && by - ay >= ARROW.length - .1;
        const horizontal = Math.abs(bx - n.x + ARROW.length) < .1 && Math.abs(by - n.y - n.height / 2) < .1 && Math.abs(ay - by) < .1 && bx - ax >= ARROW.length - .1;
        if (!vertical && !horizontal) terminalViolations++;
    }
    const missingEdges = edges.missing, extraEdges = edges.extra;
    const { directionViolations, right, down } = directionCounts(layout, items);
    let tallJoins = false;
    if (!invalidGeometry && edges.needsJoins) for (let route = 0; route < routeGeometry.length && !tallJoins; route++) {
        const b = routeGeometry[route].bounds;
        tallJoins = !!edges.joinedRoutes[route] && b.maxY - b.minY > 384 && b.maxX - b.minX > 96;
    }
    return { height, width, area, tileArea, whitespace: area ? 1 - tileArea / area : 0, paneWhitespace: height ? 1 - tileArea / (Math.max(paneWidth, width) * height) : 0,
        tileIntersections, overlaps, directionViolations, overflow: Math.max(0, width - paneWidth), missingEdges, extraEdges, missingNodes, extraNodes,
        invalidGeometry, invalidPaths, terminalViolations, right, down, tallJoins };
}

/** Connectors (and arrowheads) through tiles, and overlapping tiles. Both are counts, so the broad phase cannot change them. */
function tileContacts(layout: GraphLayout, routeGeometry: readonly RouteData[], invalidGeometry: number): { tileIntersections: number; overlaps: number } {
    let tileIntersections = 0, overlaps = 0;
    const boxes = [...layout.nodes.values()];
    if (!invalidGeometry) {
        if (boxes.length <= 32) {
            for (let route = 0; route < routeGeometry.length; route++) {
                const { bounds, xy } = routeGeometry[route];
                if (!xy) continue;
                // A terminal route's arrowhead runs from its end (ex, ey) on to the tip (tx, ty).
                const end = xy.length, ex = xy[end - 2], ey = xy[end - 1];
                let arrow = false, tx = 0, ty = 0;
                if (layout.routes[route].terminal) {
                    const ax = xy[end - 4], ay = xy[end - 3], len = distance(ex - ax, ey - ay);
                    if (len) { arrow = true; tx = ex + (ex - ax) / len * ARROW.length; ty = ey + (ey - ay) / len * ARROW.length; }
                }
                const envMinX = arrow ? Math.min(bounds.minX, tx) : bounds.minX, envMaxX = arrow ? Math.max(bounds.maxX, tx) : bounds.maxX;
                const envMinY = arrow ? Math.min(bounds.minY, ty) : bounds.minY, envMaxY = arrow ? Math.max(bounds.maxY, ty) : bounds.maxY;
                for (let tile = 0; tile < boxes.length; tile++) {
                    // The clip's inset rectangle, as clipsTile computes it. A segment can clip it only
                    // if it is not wholly on one side, which the reference's bounds tests (with their
                    // EPS tolerance) then also pass; so those tests reduce to these.
                    const node = boxes[tile], left = node.x + .25, right = node.x + node.width - .25, top = node.y + .25, bottom = node.y + node.height - .25;
                    if (right <= left || bottom <= top) continue;
                    // Every point (the arrowhead's too) on one side: no segment clips.
                    if (envMaxX <= left || envMinX >= right || envMaxY <= top || envMinY >= bottom) continue;
                    let hit = arrow && clipsTile(ex, ey, tx, ty, node);
                    for (let k = 0; !hit && k + 2 < end; k += 2) {
                        const x0 = xy[k], y0 = xy[k + 1], x1 = xy[k + 2], y1 = xy[k + 3];
                        hit = !((x0 <= left && x1 <= left) || (x0 >= right && x1 >= right) || (y0 <= top && y1 <= top) || (y0 >= bottom && y1 >= bottom)) && clipsTile(x0, y0, x1, y1, node);
                    }
                    if (hit) tileIntersections++;
                }
            }
        } else {
            // One sweep in ascending minY over drawn segments, arrowheads and tiles. Both results
            // are counts: a connector crossing a tile's interior strictly overlaps its bounds,
            // as do overlapping tiles, so every such pair meets here with both still active.
            let total = boxes.length;
            for (let route = 0; route < routeGeometry.length; route++) {
                const { count, xy } = routeGeometry[route];
                total += count;
                if (xy && layout.routes[route].terminal) total++;
            }
            // Entry s: a segment or arrowhead (x0, y0)-(x1, y1) of route owner[s], or (isTile) tile owner[s].
            const isTile = new Uint8Array(total), owner = new Int32Array(total);
            const sx0 = new Float64Array(total), sy0 = new Float64Array(total), sx1 = new Float64Array(total), sy1 = new Float64Array(total);
            const minX = new Float64Array(total), maxX = new Float64Array(total), minY = new Float64Array(total), maxY = new Float64Array(total);
            let at = 0;
            const push = (route: number, x0: number, y0: number, x1: number, y1: number) => {
                owner[at] = route; sx0[at] = x0; sy0[at] = y0; sx1[at] = x1; sy1[at] = y1;
                minX[at] = Math.min(x0, x1); maxX[at] = Math.max(x0, x1); minY[at] = Math.min(y0, y1); maxY[at] = Math.max(y0, y1); at++;
            };
            for (let route = 0; route < routeGeometry.length; route++) {
                const xy = routeGeometry[route].xy;
                if (!xy) continue;
                const end = xy.length;
                for (let k = 0; k + 2 < end; k += 2) push(route, xy[k], xy[k + 1], xy[k + 2], xy[k + 3]);
                if (layout.routes[route].terminal) {
                    const ax = xy[end - 4], ay = xy[end - 3], ex = xy[end - 2], ey = xy[end - 1], len = distance(ex - ax, ey - ay);
                    if (len) push(route, ex, ey, ex + (ex - ax) / len * ARROW.length, ey + (ey - ay) / len * ARROW.length);
                }
            }
            // Tiles carry their box index as owner.
            for (let tile = 0; tile < boxes.length; tile++) {
                const n = boxes[tile];
                isTile[at] = 1; owner[at] = tile; minX[at] = n.x; maxX[at] = n.x + n.width; minY[at] = n.y; maxY[at] = n.y + n.height; at++;
            }
            const order = sortedBy(minY, at);
            // Active lists live in typed arrays: truncating a plain array's length is slow.
            const hit = new Set<number>(), activeSegments = new Uint32Array(at), activeTiles = new Uint32Array(at), countOverlaps = boxes.length > 64;
            let segmentCount = 0, tileCount = 0;
            for (let k = 0; k < at; k++) {
                const s = order[k], x0 = minX[s], x1 = maxX[s], y1 = maxY[s], low = minY[s] - EPS, segment = !isTile[s];
                let kept = 0;
                for (let a = 0; a < tileCount; a++) {
                    const t = activeTiles[a];
                    if (maxY[t] < low) continue;
                    activeTiles[kept++] = t;
                    if (!(x1 >= minX[t] - EPS && maxX[t] >= x0 - EPS && y1 >= minY[t] - EPS)) continue;
                    const tile = owner[t];
                    if (segment) {
                        const key = owner[s] * boxes.length + tile;
                        if (!hit.has(key) && clipsTile(sx0[s], sy0[s], sx1[s], sy1[s], boxes[tile])) { hit.add(key); tileIntersections++; }
                    } else if (countOverlaps) {
                        const a = boxes[owner[s]], b = boxes[tile];
                        if (a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS) overlaps++;
                    }
                }
                tileCount = kept;
                if (segment) { activeSegments[segmentCount++] = s; continue; }
                kept = 0;
                for (let a = 0; a < segmentCount; a++) {
                    const t = activeSegments[a];
                    if (maxY[t] < low) continue;
                    activeSegments[kept++] = t;
                    if (!(x1 >= minX[t] - EPS && maxX[t] >= x0 - EPS && y1 >= minY[t] - EPS)) continue;
                    const key = owner[t] * boxes.length + owner[s];
                    if (!hit.has(key) && clipsTile(sx0[t], sy0[t], sx1[t], sy1[t], boxes[owner[s]])) { hit.add(key); tileIntersections++; }
                }
                segmentCount = kept;
                activeTiles[tileCount++] = s;
            }
        }
    }
    if (invalidGeometry || boxes.length <= 64) {
        // Small sets need no index join; invalid coordinates cannot be indexed.
        // Keep the reported overlap diagnostic exact.
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS) overlaps++;
        }
    }
    return { tileIntersections, overlaps };
}

/** The drawn segments of some routes in route order: their bounds (as `boundsOf` computes them), routes and first points. */
function flatSegments(routeGeometry: readonly RouteData[], include?: Uint8Array) {
    const bounds: Bounds[] = [], routes: number[] = [], starts: number[] = [];
    for (let route = 0; route < routeGeometry.length; route++) if (!include || include[route]) {
        const xy = routeGeometry[route].xy;
        if (xy) for (let k = 0; k + 2 < xy.length; k += 2) {
            bounds.push({ minX: Math.min(xy[k], xy[k + 2]), maxX: Math.max(xy[k], xy[k + 2]), minY: Math.min(xy[k + 1], xy[k + 3]), maxY: Math.max(xy[k + 1], xy[k + 3]) });
            routes.push(route); starts.push(k);
        }
    }
    return { bounds, routes, starts };
}

/** Indices of the first `count` keys ordered by ascending key (stable; keys are finite). */
function sortedBy(keys: Float64Array, count = keys.length): Uint32Array {
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    sortIndices(order, count, keys);
    return order;
}

/** Sorts the first `count` entries of `order` (indices into `keys`, ascending) stably by key; keys are finite. */
function sortIndices(order: Uint32Array, count: number, keys: Float64Array): void {
    if (count <= 32) {
        for (let i = 1; i < count; i++) {
            const index = order[i], key = keys[index];
            let at = i;
            while (at > 0 && key < keys[order[at - 1]]) { order[at] = order[at - 1]; at--; }
            order[at] = index;
        }
        return;
    }
    let from: Uint32Array = order, to: Uint32Array = new Uint32Array(count);
    for (let width = 1; width < count; width *= 2) {
        for (let low = 0; low < count; low += 2 * width) {
            const middle = Math.min(low + width, count), high = Math.min(low + 2 * width, count);
            let a = low, b = middle, k = low;
            while (a < middle && b < high) to[k++] = keys[from[b]] < keys[from[a]] ? from[b++] : from[a++];
            while (a < middle) to[k++] = from[a++];
            while (b < high) to[k++] = from[b++];
        }
        const swap = from; from = to; to = swap;
    }
    if (from !== order) order.set(from.subarray(0, count));
}

/**
 * Whether the reference crossing join's candidate order is known in closed form: every query is
 * narrow (no scan over all cells) and every cell key involved is exact and distinct.
 */
function cellOrderExact(routeGeometry: readonly RouteData[]): boolean {
    for (const plan of routeGeometry) {
        const xy = plan.xy;
        if (xy) for (let k = 0; k + 2 < xy.length; k += 2) {
            const minX = Math.min(xy[k], xy[k + 2]), maxX = Math.max(xy[k], xy[k + 2]), minY = Math.min(xy[k + 1], xy[k + 3]), maxY = Math.max(xy[k + 1], xy[k + 3]);
            const x0 = Math.floor(minX / 48), x1 = Math.floor(maxX / 48), y0 = Math.floor(minY / 48), y1 = Math.floor(maxY / 48);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096 || !exactCells(x0, x1, y0, y1)) return false;
            const rx0 = Math.floor((minX - .15) / 48), rx1 = Math.floor((maxX + .15) / 48), ry0 = Math.floor((minY - .15) / 48), ry1 = Math.floor((maxY + .15) / 48);
            if ((rx1 - rx0 + 1) * (ry1 - ry0 + 1) <= 4096 && !exactCells(rx0, rx1, ry0, ry1)) return false;
        }
    }
    return true;
}

/** Distinct crossing points per route pair, excluding contacts at the pair's shared endpoints. */
class CrossingCounter {
    crossings = 0;
    // Created on the first crossing: most evaluations record none.
    private hits: Map<number, Set<number | string>> | undefined;
    private allowedByPair: Map<number, readonly Point[]> | undefined;
    private readonly routeCount: number;
    // Consecutive visits mostly share a route pair; its state stays at hand.
    private pair = -1;
    private pairHits: Set<number | string> | undefined;
    private allowed: readonly Point[] = [];
    constructor(private readonly layout: GraphLayout) { this.routeCount = layout.routes.length; }
    /** Contacts at a shared endpoint (a junction, or a common tile's ports) are joins, not crossings. */
    private allowedFor(route: number, otherRoute: number): readonly Point[] {
        const layout = this.layout, r = layout.routes[route], t = layout.routes[otherRoute], allowed: Point[] = [];
        for (const e of [r.from, r.to]) {
            if (!((e.kind === t.from.kind && e.id === t.from.id) || (e.kind === t.to.kind && e.id === t.to.id))) continue;
            if (e.kind === 'junction') { const p = layout.junctions.get(e.id); if (p) allowed.push({ x: p.x, y: p.y }); }
            else { const n = layout.nodes.get(e.id); if (n) allowed.push({ x: n.x + n.width / 2, y: n.y }, { x: n.x + n.width / 2, y: n.y + n.height }); }
        }
        return allowed;
    }
    /** Records a crossing of the later route's segment `i` with the earlier's `j` (in `coordinates`); returns their shared length. */
    visit(route: number, otherRoute: number, coordinates: Float64Array, i: number, j: number): number {
        const ax = coordinates[4 * i], ay = coordinates[4 * i + 1], bx = coordinates[4 * i + 2], by = coordinates[4 * i + 3];
        const cx = coordinates[4 * j], cy = coordinates[4 * j + 1], ex = coordinates[4 * j + 2], ey = coordinates[4 * j + 3];
        // crossing(segment, other), inlined on coordinates.
        const dx = bx - ax, dy = by - ay, fx = ex - cx, fy = ey - cy, det = dx * fy - dy * fx;
        if (!(Math.abs(det) < EPS)) {
            const t = ((cx - ax) * fy - (cy - ay) * fx) / det, u = ((cx - ax) * dy - (cy - ay) * dx) / det;
            if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) this.record(otherRoute * this.routeCount + route, route, otherRoute, ax + t * dx, ay + t * dy);
        }
        return collinearOverlap(ax, ay, bx, by, cx, cy, ex, ey);
    }
    private record(pair: number, route: number, otherRoute: number, px: number, py: number): void {
        if (pair !== this.pair) {
            this.hits ??= new Map(); this.allowedByPair ??= new Map();
            this.pair = pair; this.pairHits = this.hits.get(pair);
            let allowed = this.allowedByPair.get(pair);
            if (!allowed) { allowed = this.allowedFor(route, otherRoute); this.allowedByPair.set(pair, allowed); }
            this.allowed = allowed;
        }
        for (const q of this.allowed) if (distance(px - q.x, py - q.y) < 1) return;
        // Distinct points per pair at 0.1 px. Small integers get an injective numeric key
        // (-0 and 0 share one, as their strings do); anything else keeps the string key.
        const x = Math.round(px * 10), y = Math.round(py * 10);
        const key = Math.abs(x) < 33554432 && Math.abs(y) < 33554432 ? (x + 33554432) * 67108864 + (y + 33554432) : `${x},${y}`;
        let hits = this.pairHits;
        if (!hits) { hits = this.pairHits = new Set(); this.hits!.set(pair, hits); }
        if (!hits.has(key)) { hits.add(key); this.crossings++; }
    }
}

/**
 * Routes grouped by source (`from` kind and id): `of[route]` is the source's id, equal exactly when
 * the reference's `${kind}\u0000${id}` keys are equal. Each source with drawn segments has the
 * bounds of all of them; `drawn` lists those sources in order of first appearance.
 */
interface Sources {
    readonly of: Int32Array;
    readonly drawn: readonly number[];
    readonly minX: Float64Array;
    readonly maxX: Float64Array;
    readonly minY: Float64Array;
    readonly maxY: Float64Array;
}

/** Whether every route's source kind and id are strings without U+0000. */
function plainSources(layout: GraphLayout): boolean {
    for (const route of layout.routes) {
        const { kind, id } = route.from;
        if (typeof kind !== "string" || typeof id !== "string" || kind.indexOf("\u0000") >= 0 || id.indexOf("\u0000") >= 0) return false;
    }
    return true;
}

function sourcesOf(layout: GraphLayout, routeGeometry: readonly RouteData[]): Sources {
    const routeCount = routeGeometry.length, of = new Int32Array(routeCount);
    let count = 0;
    if (routeCount <= 16 && plainSources(layout)) {
        // Few routes intern by scanning. With string kinds and ids free of U+0000, the reference
        // keys are equal exactly when both kind and id are.
        const kinds: string[] = [], ids: string[] = [];
        for (let route = 0; route < routeCount; route++) {
            const from = layout.routes[route].from;
            let id = -1;
            for (let k = 0; k < kinds.length; k++) if (kinds[k] === from.kind && ids[k] === from.id) { id = k; break; }
            if (id < 0) { id = kinds.length; kinds.push(from.kind); ids.push(from.id); }
            of[route] = id;
        }
        count = kinds.length;
    } else {
        const byKey = new Map<string, number>();
        for (let route = 0; route < routeCount; route++) {
            const from = layout.routes[route].from, key = `${from.kind}\u0000${from.id}`;
            let id = byKey.get(key);
            if (id === undefined) byKey.set(key, id = byKey.size);
            of[route] = id;
        }
        count = byKey.size;
    }
    const minX = new Float64Array(count), maxX = new Float64Array(count), minY = new Float64Array(count), maxY = new Float64Array(count);
    const drawn: number[] = [], seen = new Uint8Array(count);
    for (let route = 0; route < routeCount; route++) if (routeGeometry[route].count) {
        const id = of[route], b = routeGeometry[route].bounds;
        if (!seen[id]) { seen[id] = 1; drawn.push(id); minX[id] = b.minX; maxX[id] = b.maxX; minY[id] = b.minY; maxY[id] = b.maxY; }
        else { minX[id] = Math.min(minX[id], b.minX); maxX[id] = Math.max(maxX[id], b.maxX); minY[id] = Math.min(minY[id], b.minY); maxY[id] = Math.max(maxY[id], b.maxY); }
    }
    return { of, drawn, minX, maxX, minY, maxY };
}

/** Whether two drawn sources' bounds may hold a crossing: the reference's sweep over sources sorted by `minX`, including where it stops. */
function sourcesMayCross(sources: Sources): boolean {
    const { minX, maxX, minY, maxY } = sources, order = [...sources.drawn];
    // Stable insertion sort on `minX` (finite): the reference's stable `a.minX - b.minX` order.
    for (let i = 1; i < order.length; i++) {
        const id = order[i], key = minX[id];
        let at = i;
        while (at > 0 && key < minX[order[at - 1]]) { order[at] = order[at - 1]; at--; }
        order[at] = id;
    }
    for (let i = 0; i < order.length; i++) {
        const a = order[i];
        for (let j = i + 1; j < order.length && minX[order[j]] <= maxX[a] + EPS; j++) {
            const b = order[j];
            if (maxX[a] >= minX[b] - EPS && maxX[b] >= minX[a] - EPS && maxY[a] >= minY[b] - EPS && maxY[b] >= minY[a] - EPS) return true;
        }
    }
    return false;
}

/** Sources beyond which crossingJoin's source-bounds prefilter costs more than it saves. */
const PREFILTER_SOURCES = 16;

/**
 * Crossings between routes of different sources, and their shared lane length.
 *
 * Both reference joins visit the same set: every pair of touching segments from routes of
 * different sources, the later route's segment first. Crossing points are counted per route
 * pair, so their order is irrelevant; only the `sharedLanePx` float sum depends on the visit
 * order. A sweep over y therefore finds the pairs, and the few nonzero shared lengths are summed
 * in the reference order (zero terms leave a sum of nonnegative values unchanged):
 * - large layouts used an incremental segment index (48 px cells, .15 px margin): later segment
 *   first, then the first cell both share in x-major order, then the earlier segment, with wide
 *   entries after all cells;
 * - others used route pairs, then segment pairs.
 * Those orders are total on segment pairs, so they do not depend on the order the sweep finds them.
 * When that cell order is not exact (very wide queries, or cell keys that alias), the
 * reference index itself runs.
 */
function crossingJoin(layout: GraphLayout, routeGeometry: readonly RouteData[], sources: Sources, spatial: boolean): { crossings: number; sharedLanePx: number } {
    const counter = new CrossingCounter(layout), source = sources.of;
    let count = 0;
    for (const plan of routeGeometry) count += plan.count;
    let sharedLanePx = 0;
    if (spatial && !cellOrderExact(routeGeometry)) {
        // Every segment in route order: coordinates (x0, y0, x1, y1) and route.
        const coordinates = new Float64Array(4 * count), routes = new Int32Array(count);
        for (let route = 0, at = 0; route < routeGeometry.length; route++) {
            const xy = routeGeometry[route].xy;
            if (xy) for (let k = 0; k + 2 < xy.length; k += 2, at++) {
                coordinates[4 * at] = xy[k]; coordinates[4 * at + 1] = xy[k + 1]; coordinates[4 * at + 2] = xy[k + 2]; coordinates[4 * at + 3] = xy[k + 3];
                routes[at] = route;
            }
        }
        const bounds = flatSegments(routeGeometry).bounds, bins = new SpatialBins(bounds, 48, .15);
        for (let index = 0; index < count; index++) {
            const entry = bounds[index], route = routes[index];
            for (const otherIndex of bins.candidates(entry)) {
                const otherRoute = routes[otherIndex];
                if (route !== otherRoute && source[route] !== source[otherRoute] && touches(entry, bounds[otherIndex])) sharedLanePx += counter.visit(route, otherRoute, coordinates, index, otherIndex);
            }
            bins.add(index);
        }
        return { crossings: counter.crossings, sharedLanePx };
    }
    // The segments that may meet one of another source, in route order. A segment touching another
    // lies within that one's source bounds (floating-point subtraction is monotone), so it touches
    // those bounds too: dropping every segment that touches no other source's bounds (and every
    // route that does not) keeps every visited pair. Entry `e` is segment `id[e]` of the reference
    // numbering (all segments in route order), whose order decides which comes first in a pair.
    const work = crossingScratch(count), { coordinates, minX, maxX, minY, maxY, routes, id, order, active } = work;
    const filter = sources.drawn.length <= PREFILTER_SOURCES, { drawn, minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY } = sources;
    const near = new Int32Array(filter ? drawn.length : 0);
    let entries = 0;
    for (let route = 0, next = 0; route < routeGeometry.length; route++) {
        const plan = routeGeometry[route], xy = plan.xy, b = plan.bounds, own = source[route], first = next;
        next += plan.count;
        if (!xy) continue;
        let nearCount = 0;
        if (filter) {
            for (const other of drawn) if (other !== own && b.maxX >= sMinX[other] - EPS && sMaxX[other] >= b.minX - EPS && b.maxY >= sMinY[other] - EPS && sMaxY[other] >= b.minY - EPS) near[nearCount++] = other;
            if (!nearCount) continue;
        }
        for (let k = 0, segment = first; k + 2 < xy.length; k += 2, segment++) {
            const x0 = xy[k], y0 = xy[k + 1], x1 = xy[k + 2], y1 = xy[k + 3];
            const lowX = Math.min(x0, x1), highX = Math.max(x0, x1), lowY = Math.min(y0, y1), highY = Math.max(y0, y1);
            if (filter) {
                let meets = false;
                for (let n = 0; n < nearCount; n++) {
                    const other = near[n];
                    if (highX >= sMinX[other] - EPS && sMaxX[other] >= lowX - EPS && highY >= sMinY[other] - EPS && sMaxY[other] >= lowY - EPS) { meets = true; break; }
                }
                if (!meets) continue;
            }
            const e = entries++;
            coordinates[4 * e] = x0; coordinates[4 * e + 1] = y0; coordinates[4 * e + 2] = x1; coordinates[4 * e + 3] = y1;
            minX[e] = lowX; maxX[e] = highX; minY[e] = lowY; maxY[e] = highY;
            routes[e] = route; id[e] = segment; order[e] = e;
        }
    }
    // Sweep in ascending minY (stable, so ties keep route order). An earlier segment ending above
    // this one's touch tolerance cannot touch it or any later one (minY only grows), so it leaves
    // the active list. The test below is the reference `touches` expression on the same values.
    sortIndices(order, entries, minY);
    const sharedFirst: number[] = [], sharedSecond: number[] = [], sharedLength: number[] = [];
    let activeCount = 0;
    for (let k = 0; k < entries; k++) {
        const s = order[k], x0 = minX[s], x1 = maxX[s], y0 = minY[s], y1 = maxY[s], low = y0 - EPS;
        let still = 0;
        for (let a = 0; a < activeCount; a++) {
            const t = active[a];
            if (maxY[t] < low) continue;
            active[still++] = t;
            if (!(x1 >= minX[t] - EPS && maxX[t] >= x0 - EPS && y1 >= minY[t] - EPS && maxY[t] >= low)) continue;
            // The later segment in the reference numbering comes first.
            const i = id[s] > id[t] ? s : t, j = id[s] > id[t] ? t : s;
            if (routes[i] === routes[j] || source[routes[i]] === source[routes[j]]) continue;
            const shared = counter.visit(routes[i], routes[j], coordinates, i, j);
            if (shared !== 0) { sharedFirst.push(i); sharedSecond.push(j); sharedLength.push(shared); }
        }
        active[still++] = s;
        activeCount = still;
    }
    if (sharedLength.length) {
        // Reference order of each shared length: [later, a, b, earlier] compared lexicographically.
        const keys = sharedLength.map((_, r) => {
            const i = sharedFirst[r], j = sharedSecond[r];
            if (!spatial) return [routes[i], routes[j], id[i], id[j]];
            const ex0 = Math.floor((minX[j] - .15) / 48), ex1 = Math.floor((maxX[j] + .15) / 48), ey0 = Math.floor((minY[j] - .15) / 48), ey1 = Math.floor((maxY[j] + .15) / 48);
            if ((ex1 - ex0 + 1) * (ey1 - ey0 + 1) > 4096) return [id[i], Infinity, Infinity, id[j]];
            return [id[i], Math.max(Math.floor(minX[i] / 48), ex0), Math.max(Math.floor(minY[i] / 48), ey0), id[j]];
        });
        const ranked = keys.map((_, r) => r).sort((a, b) => keys[a][0] - keys[b][0] || keys[a][1] - keys[b][1] || keys[a][2] - keys[b][2] || keys[a][3] - keys[b][3]);
        for (const r of ranked) sharedLanePx += sharedLength[r];
    }
    return { crossings: counter.crossings, sharedLanePx };
}

interface CrossingScratch {
    readonly coordinates: Float64Array;
    readonly minX: Float64Array;
    readonly maxX: Float64Array;
    readonly minY: Float64Array;
    readonly maxY: Float64Array;
    readonly routes: Int32Array;
    readonly id: Uint32Array;
    readonly order: Uint32Array;
    readonly active: Uint32Array;
}
const crossingArrays = (size: number): CrossingScratch => ({ coordinates: new Float64Array(4 * size), minX: new Float64Array(size), maxX: new Float64Array(size),
    minY: new Float64Array(size), maxY: new Float64Array(size), routes: new Int32Array(size), id: new Uint32Array(size), order: new Uint32Array(size), active: new Uint32Array(size) });
/** Reused join buffers up to this many segments; larger joins allocate their own rather than pin memory. */
const SCRATCH_SEGMENTS = 4096;
let sharedScratch: CrossingScratch | undefined;
/** Buffers for {@link crossingJoin}'s entries; it is not re-entered, and every slot it reads it wrote first. */
function crossingScratch(size: number): CrossingScratch {
    if (size > SCRATCH_SEGMENTS) return crossingArrays(size);
    if (!sharedScratch || sharedScratch.minX.length < size) sharedScratch = crossingArrays(Math.min(SCRATCH_SEGMENTS, Math.max(size, 2 * (sharedScratch?.minX.length ?? 128))));
    return sharedScratch;
}

/**
 * Requested edges whose routes do not connect the parent's port to the child's arrowhead.
 * Shared routes are joined geometrically through a segment index (`segmentJoins`) or a route
 * index. Their joins agree except in floating-point corner cases, so each mode keeps the index
 * the reference evaluator used.
 */
function disconnected(layout: GraphLayout, routeGeometry: readonly RouteData[], edges: EdgeIndex, segmentJoins: boolean): number {
    const { expected, joinedRoutes, needsJoins } = edges;
    const routeCount = routeGeometry.length;
    let disconnectedEdges = 0;
    /** Whether (px, py) lies within .15 of the segment (ax, ay)-(bx, by). */
    const on = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
        return distance(px - ax - t * dx, py - ay - t * dy) < .15;
    };
    /** Whether (px, py) lies on any segment of the route. */
    const onRoute = (px: number, py: number, xy: Float64Array) => {
        for (let k = 0; k + 2 < xy.length; k += 2) if (on(px, py, xy[k], xy[k + 1], xy[k + 2], xy[k + 3])) return true;
        return false;
    };
    // Every geometric join is found once, then reused by all consumers of shared trunks.
    const joins: Set<number>[] = [];
    if (needsJoins) for (let route = 0; route < routeCount; route++) joins.push(new Set<number>());
    // Indexing only joined routes' segments finds the same joined segments as indexing all of them.
    const indexed = needsJoins && segmentJoins ? flatSegments(routeGeometry, joinedRoutes) : undefined;
    const segmentBins = indexed ? new SpatialBins(indexed.bounds, 48, .15) : undefined;
    if (segmentBins) for (let index = 0; index < indexed!.bounds.length; index++) segmentBins.add(index);
    let routeBins: SpatialBins | undefined;
    if (needsJoins && !segmentBins) {
        const routeBounds: Bounds[] = [];
        for (const plan of routeGeometry) routeBounds.push(plan.bounds);
        routeBins = new SpatialBins(routeBounds, 96, .15);
        for (let index = 0; index < routeCount; index++) if (routeGeometry[index].xy && joinedRoutes[index]) routeBins.add(index);
    }
    if (needsJoins) for (let route = 0; route < routeCount; route++) {
        const xy = routeGeometry[route].xy;
        if (!xy || !joinedRoutes[route]) continue;
        // The route's first point, then its last.
        for (let end = 0; end < 2; end++) {
            const px = end ? xy[xy.length - 2] : xy[0], py = end ? xy[xy.length - 1] : xy[1];
            const near = { minX: px - .15, maxX: px + .15, minY: py - .15, maxY: py + .15 };
            if (routeBins) {
                for (const other of routeBins.candidates(near)) if (route !== other && !joins[route].has(other) && onRoute(px, py, routeGeometry[other].xy!)) {
                    joins[route].add(other); joins[other].add(route);
                }
            } else if (segmentBins) {
                for (const index of segmentBins.candidates(near)) {
                    const otherRoute = indexed!.routes[index];
                    if (route !== otherRoute && joinedRoutes[otherRoute] && !joins[route].has(otherRoute)) {
                        const other = routeGeometry[otherRoute].xy!, k = indexed!.starts[index];
                        if (on(px, py, other[k], other[k + 1], other[k + 2], other[k + 3])) { joins[route].add(otherRoute); joins[otherRoute].add(route); }
                    }
                }
            }
        }
    }
    const startBounds: Bounds[] = [];
    if (needsJoins && routeCount > 128) for (const plan of routeGeometry) {
        const xy = plan.xy;
        startBounds.push(xy ? { minX: xy[0], maxX: xy[0], minY: xy[1], maxY: xy[1] } : { minX: Infinity, maxX: Infinity, minY: Infinity, maxY: Infinity });
    }
    const startBins = startBounds.length ? new SpatialBins(startBounds) : undefined;
    if (startBins) for (let index = 0; index < routeCount; index++) if (routeGeometry[index].xy && joinedRoutes[index]) startBins.add(index);
    const sourceStarts = new Map<string, ReadonlySet<number>>();
    const startsFor = (parent: string, p: PlacedNode): ReadonlySet<number> => {
        const cached = sourceStarts.get(parent); if (cached) return cached;
        const starts = new Set<number>(), x = p.x + p.width / 2, y = p.y + p.height, rightX = p.x + p.width, rightY = p.y + p.height / 2;
        if (startBins) {
            for (const port of [{ x, y }, { x: rightX, y: rightY }]) for (const index of startBins.candidates({ minX: port.x - .15, maxX: port.x + .15, minY: port.y - .15, maxY: port.y + .15 })) {
                const xy = routeGeometry[index].xy!;
                if (distance(xy[0] - port.x, xy[1] - port.y) < .15) starts.add(index);
            }
        } else for (let index = 0; index < routeCount; index++) {
            const xy = joinedRoutes[index] ? routeGeometry[index].xy : null;
            if (!xy) continue;
            const px = xy[0], py = xy[1];
            // A port farther than .3 on either axis is beyond .15: hypot is never below its larger leg.
            if ((Math.abs(px - x) < .3 && Math.abs(py - y) < .3 && distance(px - x, py - y) < .15)
                || (Math.abs(px - rightX) < .3 && Math.abs(py - rightY) < .3 && distance(px - rightX, py - rightY) < .15)) starts.add(index);
        }
        sourceStarts.set(parent, starts); return starts;
    };
    const membership = new Uint32Array(needsJoins ? routeCount : 0), visited = new Uint32Array(needsJoins ? routeCount : 0);
    let stamp = 0;
    for (const edge of expected) {
        stamp++;
        const parent = edge.parent, child = edge.child, p = layout.nodes.get(parent), indices = edge.carriers;
        if (!p) { disconnectedEdges++; continue; }
        if (indices.length <= 1) {
            const index = indices[0], xy = index === undefined ? null : routeGeometry[index].xy, route = layout.routes[index];
            const atPort = !!xy && (distance(xy[0] - (p.x + p.width / 2), xy[1] - (p.y + p.height)) < .15 || distance(xy[0] - (p.x + p.width), xy[1] - (p.y + p.height / 2)) < .15);
            if (!atPort || !route?.terminal || route.to.id !== child) disconnectedEdges++;
            continue;
        }
        const starts = startsFor(parent, p);
        const pending: number[] = [];
        for (const index of indices) {
            membership[index] = stamp;
            if (starts.has(index)) { visited[index] = stamp; pending.push(index); }
        }
        let connected = false;
        for (let k = 0; k < pending.length; k++) {
            const index = pending[k], route = layout.routes[index];
            if (route.terminal && route.to.id === child) { connected = true; break; }
            for (const next of joins[index]) if (membership[next] === stamp && visited[next] !== stamp) { visited[next] = stamp; pending.push(next); }
        }
        if (!connected) disconnectedEdges++;
    }
    return disconnectedEdges;
}

/**
 * Every value the hard gates read from a layout and its items, in a fixed order. The gate memo
 * compares it in full, so a layout or item mutated in place (despite its readonly type) is
 * never served stale gates. If `hardGates` or `disconnected` starts reading another field, add
 * it here too (and to `sameGateInputs`, which must read exactly the same sequence), or the memo
 * can return stale gates.
 */
function gateInputs(layout: GraphLayout, items: readonly LayoutItem[]): unknown[] {
    const bounds = layout.bandBounds, out: unknown[] = [layout.width, layout.height, layout.orientation, bounds?.left, bounds?.width, bounds?.top, layout.nodes.size];
    for (const [key, n] of layout.nodes) out.push(key, n.key, n.x, n.y, n.width, n.height, n.row);
    out.push(layout.junctions.size);
    for (const j of layout.junctions.values()) out.push(j.x, j.y);
    out.push(layout.routes.length);
    for (const r of layout.routes) {
        out.push(r.path, r.terminal, r.from.kind, r.from.id, r.to.kind, r.to.id, r.consumers.length);
        for (const c of r.consumers) out.push(c.parent, c.child);
    }
    out.push(items.length);
    for (const item of items) {
        out.push(item.key, item.width, item.height, item.parents.length);
        for (const parent of item.parents) out.push(parent);
    }
    return out;
}

interface GateMemo {
    readonly coverKey: string;
    readonly paneWidth: number;
    readonly items: readonly LayoutItem[];
    readonly inputs: readonly unknown[];
    readonly gates: HardGates;
    /** Connectivity, with the index it was computed by (irrelevant without shared routes or with invalid geometry). */
    readonly disconnectedEdges: number;
    readonly segmentJoins: boolean;
    readonly needsJoins: boolean;
    /** The crossing join validation ran for the shared-lane gate, reused by measure. */
    readonly join?: { readonly crossings: number; readonly sharedLanePx: number; readonly spatial: boolean };
}

/**
 * Hard gates of the last validation of each layout object. `validateLayout` and `measure` compute
 * identical hard fields (they differ only in soft terms, and in which index joins shared routes),
 * so either one run after validating the same layout object, cover key, pane width and items array
 * reuses them when every value they read is unchanged.
 */
const gateMemo = new WeakMap<GraphLayout, GateMemo>();

/** Whether {@link gateInputs} of the layout and items would equal `known`, element by element, without building it. */
function sameGateInputs(layout: GraphLayout, items: readonly LayoutItem[], known: readonly unknown[]): boolean {
    let at = 0;
    const same = (value: unknown) => Object.is(known[at++], value);
    const bounds = layout.bandBounds;
    if (!same(layout.width) || !same(layout.height) || !same(layout.orientation) || !same(bounds?.left) || !same(bounds?.width) || !same(bounds?.top) || !same(layout.nodes.size)) return false;
    for (const [key, n] of layout.nodes) if (!same(key) || !same(n.key) || !same(n.x) || !same(n.y) || !same(n.width) || !same(n.height) || !same(n.row)) return false;
    if (!same(layout.junctions.size)) return false;
    for (const j of layout.junctions.values()) if (!same(j.x) || !same(j.y)) return false;
    if (!same(layout.routes.length)) return false;
    for (const r of layout.routes) {
        if (!same(r.path) || !same(r.terminal) || !same(r.from.kind) || !same(r.from.id) || !same(r.to.kind) || !same(r.to.id) || !same(r.consumers.length)) return false;
        for (const c of r.consumers) if (!same(c.parent) || !same(c.child)) return false;
    }
    if (!same(items.length)) return false;
    for (const item of items) {
        if (!same(item.key) || !same(item.width) || !same(item.height) || !same(item.parents.length)) return false;
        for (const parent of item.parents) if (!same(parent)) return false;
    }
    return at === known.length;
}

function recallGates(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[]): GateMemo | undefined {
    const memo = gateMemo.get(layout);
    if (!memo || memo.items !== items || memo.coverKey !== coverKey || !Object.is(memo.paneWidth, paneWidth)) return undefined;
    return sameGateInputs(layout, items, memo.inputs) ? memo : undefined;
}

/** Crossings and shared lane length between different sources' routes (none with invalid geometry). */
function joinRoutes(layout: GraphLayout, routeGeometry: readonly RouteData[], invalidGeometry: number): { readonly crossings: number; readonly sharedLanePx: number; readonly spatial: boolean } {
    const sources = sourcesOf(layout, routeGeometry);
    let segmentCount = 0;
    for (const plan of routeGeometry) segmentCount += plan.count;
    const mayCross = sourcesMayCross(sources);
    const spatial = !invalidGeometry && mayCross && (routeGeometry.length > 64 || segmentCount > 1024);
    if (invalidGeometry || !mayCross) return { crossings: 0, sharedLanePx: 0, spatial };
    return { ...crossingJoin(layout, routeGeometry, sources, spatial), spatial };
}

/** Shared-lane lengths already measured, per (immutable) layout object. */
const laneLengths = new WeakMap<GraphLayout, number>();
/**
 * Length along which routes from different sources run together: the `sharedLanePx` of
 * {@link measure} for valid geometry, for layouts reused without ranking. Unparsable routes contribute nothing.
 * Memoised per layout object, so a committed layout reused request after request is joined once.
 */
export function sharedLaneLength(layout: GraphLayout): number {
    let known = laneLengths.get(layout);
    if (known === undefined) laneLengths.set(layout, known = joinRoutes(layout, layout.routes.map(routeData), 0).sharedLanePx);
    return known;
}

/** Complete deterministic diagnostics; shared route geometry is parsed and indexed once per invocation. */
function evaluate(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string, gatesOnly = false): Measures {
    const routeGeometry = layout.routes.map(routeData);
    const memo = recallGates(layout, coverKey, paneWidth, items);
    let edges: EdgeIndex | undefined;
    const edgesFor = () => edges ??= edgeIndex(layout, items, wantedKeys(items));
    let gates = memo?.gates;
    if (!gates) {
        const wanted = wantedKeys(items);
        edges = edgeIndex(layout, items, wanted);
        gates = hardGates(layout, coverKey, paneWidth, items, routeGeometry, edges, wanted);
    }
    const invalidGeometry = gates.invalidGeometry;
    let length = 0, turning = 0;
    if (!gatesOnly) for (const plan of routeGeometry) { const metrics = metricsOf(plan); length += metrics.length; turning += metrics.bends * (Math.PI / 2); }
    // Shared lanes are a hard gate, so validation joins routes too; measure reuses its join.
    const join = memo?.join ?? joinRoutes(layout, routeGeometry, invalidGeometry);
    const { sharedLanePx, spatial: spatialCrossings } = join, crossings = gatesOnly ? 0 : join.crossings;
    // The reference evaluator joins shared routes through its segment index whenever it built one.
    const segmentJoins = spatialCrossings || gates.tallJoins;
    let disconnectedEdges: number;
    if (invalidGeometry) disconnectedEdges = 0;
    else if (memo && (!memo.needsJoins || memo.segmentJoins === segmentJoins)) disconnectedEdges = memo.disconnectedEdges;
    else disconnectedEdges = disconnected(layout, routeGeometry, edgesFor(), segmentJoins);
    // Only validation records gates: the engine ranks (measures) a candidate after validating it,
    // never the reverse, so a record made by measure would only cost its snapshot.
    if (!memo && gatesOnly) {
        gateMemo.set(layout, { coverKey, paneWidth, items, inputs: gateInputs(layout, items), gates, disconnectedEdges, segmentJoins, needsJoins: edgesFor().needsJoins, join });
    }
    const penalties = gatesOnly ? gatePenalties(gates.directionViolations) : softPenalties(layout, coverKey, items, previous, anchorKey, gates.directionViolations, gates.right, gates.down);
    const { height, width, area, tileArea, whitespace, paneWhitespace, tileIntersections, overlaps, overflow, missingEdges, extraEdges, missingNodes, extraNodes, invalidPaths, terminalViolations } = gates;
    return { height, width, area, tileArea, whitespace, paneWhitespace, length, bends: turning / (Math.PI / 2), crossings, sharedLanePx, tileIntersections, overlaps, ...penalties, overflow, missingEdges, extraEdges, missingNodes, extraNodes, invalidGeometry, invalidPaths, terminalViolations, disconnectedEdges };
}
/** Complete objective and every hard gate; callers cannot disable connectivity checks. */
export function measure(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string): Measures {
    return evaluate(layout, coverKey, paneWidth, items, previous, anchorKey);
}

/** Exact hard constraints for a sole cold constructive candidate; objective ranking is vacuous.
 * Soft diagnostic fields are zero; `sharedLanePx`, a hard gate, is exact. A choice between candidates must use full measure(). */
export function validateLayout(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[]): Measures {
    return evaluate(layout, coverKey, paneWidth, items, undefined, undefined, true);
}

export const HEIGHT_WEIGHT = 16;
/**
 * Band height, in tile widths, one more crossing must save to be worth drawing: the
 * objective's exchange rate between crossings and height, and the readability acceptance
 * threshold (docs/trace-scene-plan.md, phase 2 §4). Calibrated on the evaluation corpus
 * (docs/trace-view-layout.md, "Crossings"): raising it barely lowers crossings (mean 335.2
 * to 333.5 at 1 tile) but makes legal tours taller and less stable, and fails the
 * displacement target at 1 tile.
 */
export const CROSSING_HEIGHT_TILES = .1 / 16;
export const CROSSING_WEIGHT = HEIGHT_WEIGHT * CROSSING_HEIGHT_TILES;

/**
 * Cost of a band that places children both down and right. Calibrated on the evaluation
 * corpus (layout-eval, readability sweep): 1 lowers mixed placements and unpriced crossing
 * regressions with every other target unchanged; 2 lowers them further but makes one layout
 * more than 10% taller than the baseline without a stability reason.
 */
export const MIXED_DIRECTIONS_WEIGHT = 1;

export interface Weights {
    readonly stability: number;
    /**
     * Routes from different sources sharing a lane: a hard gate (the default), or priced
     * like the other soft terms. Pricing serves only the explicit fallback when no
     * candidate can avoid them.
     */
    readonly sharedLanes?: "gate" | "priced";
}
/** Tile-size normalized perceptual cost, with hard geometry/parentage gates. Whitespace is reported separately: area and height already price it. */
const DEFAULT_WEIGHTS: Weights = Object.freeze({ stability: 1.5 });
export function cost(m: Measures, tileWidth: number, weights: Weights = DEFAULT_WEIGHTS): number {
    if (m.overlaps || m.tileIntersections || m.directionViolations || m.missingEdges || m.extraEdges || m.missingNodes || m.extraNodes || m.invalidGeometry || m.invalidPaths || m.terminalViolations || m.disconnectedEdges)
        return Infinity;
    if (m.sharedLanePx > 0 && weights.sharedLanes !== "priced") return Infinity;
    return HEIGHT_WEIGHT * m.height / tileWidth + 2 * m.area / (tileWidth * tileWidth) + .08 * m.length / tileWidth + .12 * m.bends + CROSSING_WEIGHT * m.crossings + 4 * m.sharedLanePx / tileWidth + MIXED_DIRECTIONS_WEIGHT * m.mixedDirections + 3 * m.siblingInversions + .25 * m.unaligned + 100 * m.overflow / tileWidth + weights.stability * (m.displacement / tileWidth + .25 * m.maxDisplacement / tileWidth + 2 * m.anchorDisplacement / tileWidth);
}
