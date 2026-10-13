import type { GraphLayout, LayoutItem, PlacedNode, PlacedRoute } from "./layout";
import { ARROW, STACK_STEM_ROOM } from "./metrics";
import { flattenPath, type Point } from "./path-sampling";
import { isPlainPathData } from "./path-data";
export type Segment = readonly [
    Point,
    Point
];
export const segments = (path: string): Segment[] => { const p = flattenPath(path) ?? []; return p.slice(1).map((b, i) => [p[i], b]); };
const EPS = .001;
export function intersectsTile(segment: Segment, r: PlacedNode, clearance = .25): boolean {
    const a = segment[0], b = segment[1];
    const left = r.x + clearance, right = r.x + r.width - clearance, top = r.y + clearance, bottom = r.y + r.height - clearance;
    if (right <= left || bottom <= top) return false;
    // Wholly on one side of the inset rectangle: the clip below would find no interior span either.
    if ((a.x <= left && b.x <= left) || (a.x >= right && b.x >= right) || (a.y <= top && b.y <= top) || (a.y >= bottom && b.y >= bottom)) return false;
    let lo = 0, hi = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < EPS && (a.x <= left || a.x >= right) || Math.abs(dy) < EPS && (a.y <= top || a.y >= bottom)) return false;
    if (Math.abs(dx) < EPS) { if (a.x <= left || a.x >= right) return false; }
    else { const t1 = (left - a.x) / dx, t2 = (right - a.x) / dx; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
    if (Math.abs(dy) < EPS) { if (a.y <= top || a.y >= bottom) return false; }
    else { const t1 = (top - a.y) / dy, t2 = (bottom - a.y) / dy; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
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
export function overlapLength([a, b]: Segment, [c, d]: Segment): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x)) > EPS || Math.abs(dx * (d.y - a.y) - dy * (d.x - a.x)) > EPS) return 0;
    const length = dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.hypot(dx, dy);
    if (length < EPS) return 0;
    const t1 = ((c.x - a.x) * dx + (c.y - a.y) * dy) / length, t2 = ((d.x - a.x) * dx + (d.y - a.y) * dy) / length;
    return Math.max(0, Math.min(length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)));
}
interface Bounds { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }
interface IndexedSegment extends Bounds { readonly route: number; readonly segment: Segment }
const boundsOf = ([a, b]: Segment): Bounds => ({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
const touches = (a: Bounds, b: Bounds, tolerance = EPS): boolean => a.maxX >= b.minX - tolerance && b.maxX >= a.minX - tolerance && a.maxY >= b.minY - tolerance && b.maxY >= a.minY - tolerance;

/** A sparse broad phase. Long spans use a bounded fallback rather than allocating unbounded bins. */
class SpatialBins {
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
            const key = SpatialBins.cell(x, y), list = this.bins.get(key);
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
                const list = this.bins.get(SpatialBins.cell(x, y));
                if (list) for (let i = 0; i < list.length; i++) this.append(list[i], b);
            }
        }
        for (const index of this.wide) this.append(index, b);
        return this.result;
    }
}

/** The flattener serves animation too; validity additionally rejects skipped punctuation and move-only paths. */
function routePoints(path: string): readonly Point[] | null {
    const trimmed = path.trim();
    const body = trimmed.startsWith('path(') ? trimmed.replace(/^path\(\s*["']?|["']?\s*\)$/g, "") : trimmed;
    if (body[0] !== 'M' || body.indexOf('M', 1) >= 0 || !isPlainPathData(body)) return null;
    const points = flattenPath(path);
    return points && points.length > 1 ? points : null;
}

export interface RoutePlan {
    readonly points: readonly Point[] | null;
    readonly segments: readonly Segment[];
    readonly bounds: Bounds;
    readonly length: number;
    readonly bends: number;
}

interface RouteData {
    readonly points: readonly Point[] | null;
    readonly segments: readonly Segment[];
    readonly segmentBounds: readonly Bounds[];
    readonly bounds: Bounds;
    readonly plan: RoutePlan;
}

const routePlans = new WeakMap<PlacedRoute, { readonly path: string; readonly data: RouteData }>();

/** Geometry-only memoization: context and consumer metadata are never cached.
 * Frozen results remain immutable even for external callers; path equality detects mutated input objects. */
function routeData(route: PlacedRoute): RouteData {
    const cached = routePlans.get(route);
    if (cached?.path === route.path) return cached.data;
    const points = routePoints(route.path);
    const ss: Segment[] = [], bounds: Bounds[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (points) {
        points.forEach((point, index) => {
            minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
            if (index) { const segment: Segment = [points[index - 1], point]; ss.push(segment); bounds.push(boundsOf(segment)); }
        });
    }
    // Hard validation needs the samples but no objective arithmetic; compute both soft fields only on demand.
    let derived: { readonly length: number; readonly bends: number } | undefined;
    const metrics = () => {
        if (derived) return derived;
        let length = 0, turning = 0, previousX = 0, previousY = 0, hasPrevious = false;
        for (const [a, b] of ss) {
            const dx = b.x - a.x, dy = b.y - a.y, span = Math.hypot(dx, dy);
            length += span;
            if (span > EPS) {
                if (hasPrevious) turning += Math.abs(Math.atan2(previousX * dy - previousY * dx, previousX * dx + previousY * dy));
                previousX = dx; previousY = dy; hasPrevious = true;
            }
        }
        return derived = { length, bends: turning / (Math.PI / 2) };
    };
    // These buffers stay private and are never mutated. Frozen public views are materialized only
    // when requested; freezing the internal arrays deoptimizes their repeated geometric scans.
    let publicPoints: readonly Point[] | null | undefined, publicSegments: readonly Segment[] | undefined;
    const pointView = () => publicPoints ??= points ? Object.freeze(points.map(point => Object.freeze({ ...point }))) : null;
    const routeBounds = { minX, maxX, minY, maxY };
    const plan: RoutePlan = Object.freeze({
        get points() { return pointView(); },
        get segments() {
            if (!publicSegments) {
                const view = pointView();
                publicSegments = Object.freeze(view ? ss.map((_, index) => Object.freeze([view[index], view[index + 1]] as const)) : []);
            }
            return publicSegments;
        },
        bounds: Object.freeze({ ...routeBounds }),
        get length() { return metrics().length; }, get bends() { return metrics().bends; } });
    const data: RouteData = { points, segments: ss, segmentBounds: bounds, bounds: routeBounds, plan };
    routePlans.set(route, { path: route.path, data });
    return data;
}

export function routePlan(route: PlacedRoute): RoutePlan { return routeData(route).plan; }

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

/** A coordinate neighbor proves alignment; sorting avoids an all-pairs scan. */
function countUnaligned(nodes: readonly PlacedNode[]): number {
    if (nodes.length < 2) return 0;
    if (nodes.length <= 32) return nodes.filter(n => !nodes.some(p => p.key !== n.key && (Math.abs(p.x - n.x) < .5 || Math.abs(p.y - n.y) < .5))).length;
    const aligned = new Set<string>();
    for (const axis of ['x', 'y'] as const) {
        const ordered = [...nodes].sort((a, b) => a[axis] - b[axis]);
        for (let index = 1; index < ordered.length; index++) if (ordered[index][axis] - ordered[index - 1][axis] < .5) {
            aligned.add(ordered[index].key); aligned.add(ordered[index - 1].key);
        }
    }
    return nodes.length - aligned.size;
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
/** Pure node penalties, shared by the complete objective and its optimistic bound. */
export function nodePenalties(layout: GraphLayout, coverKey: string, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string, gatesOnly = false) {
    const children = [...layout.nodes.values()].filter(n => n.key !== coverKey);
    let directionViolations = 0, right = 0, down = 0;
    for (const item of items)
        for (const id of item.parents) {
            const p = layout.nodes.get(id), c = layout.nodes.get(item.key);
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
    const siblingGroups = new Map<string, LayoutItem[]>();
    if (!gatesOnly) for (const n of items) {
        const k = n.parents.length === 1 ? n.parents[0] : [...n.parents].sort().join('\u0000');
        if (!k)
            continue;
        const group = siblingGroups.get(k) ?? [];
        group.push(n);
        siblingGroups.set(k, group);
    }
    let siblingInversions = 0;
    const visual = (n: PlacedNode) => layout.orientation === 'right' ? n.row * 1e9 + n.x * 1e5 + n.y : n.y * 1e5 + n.x;
    for (const group of siblingGroups.values()) {
        group.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
        const values = group.flatMap(n => { const placed = layout.nodes.get(n.key); return placed ? [visual(placed)] : []; });
        siblingInversions += countInversions(values);
    }
    const unaligned = gatesOnly ? 0 : countUnaligned(children);
    const moves = gatesOnly ? [] : children.flatMap(n => { const p = previous?.nodes.get(n.key); return p ? [Math.hypot(n.x - p.x, n.y - p.y)] : []; });
    const anchor = anchorKey ? layout.nodes.get(anchorKey) : undefined, oldAnchor = anchorKey ? previous?.nodes.get(anchorKey) : undefined;
    return { directionViolations, mixedDirections: gatesOnly ? 0 : Math.min(right, down), siblingInversions, unaligned,
        displacement: moves.length ? moves.reduce((s, x) => s + x, 0) / moves.length : 0,
        maxDisplacement: Math.max(0, ...moves), movedFraction: moves.length ? moves.filter(x => x > .5).length / moves.length : 0,
        anchorDisplacement: !gatesOnly && anchor && oldAnchor ? Math.hypot(anchor.x - oldAnchor.x, anchor.y - oldAnchor.y) : 0 };
}

/** Complete deterministic diagnostics; shared route geometry is parsed and indexed once per invocation. */
function evaluate(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string, gatesOnly = false): Measures {
    const full = true;
    const wanted = new Set(items.map(n => n.key));
    const missingNodes = [...wanted].filter(k => !layout.nodes.has(k)).length, extraNodes = [...layout.nodes.keys()].filter(k => !wanted.has(k)).length;
    const requested = new Map(items.map(n => [n.key, n]));
    let invalidGeometry = Number(!Number.isFinite(layout.width) || !Number.isFinite(layout.height) || layout.width < 0 || layout.height < 0 || !["right", "down"].includes(layout.orientation));
    for (const [key, n] of layout.nodes) {
        const item = requested.get(n.key);
        if (key !== n.key || !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.width) || !Number.isFinite(n.height)
            || n.width <= 0 || n.height <= 0 || n.x < -.1 || n.y < -.1 || n.x + n.width > layout.width + .1 || n.y + n.height > layout.height + .1
            || Math.abs(n.width - (item?.width ?? n.width)) > .1 || Math.abs(n.height - (item?.height ?? n.height)) > .1) invalidGeometry++;
    }
    const routeGeometry = layout.routes.map(routeData);
    const points = routeGeometry.map(plan => plan.points);
    const invalidPaths = points.filter(p => !p).length;
    const children = [...layout.nodes.values()].filter(n => n.key !== coverKey), first = Math.min(...children.map(n => n.y));
    const lines = routeGeometry.map(plan => plan.segments);
    // One bound per drawn segment, reused by tile, crossing and consumer-connectivity queries.
    let segmentPlans: IndexedSegment[][] | undefined;
    const plansFor = (): IndexedSegment[][] => segmentPlans ??= routeGeometry.map((plan, route) => {
        const bounds = plan.segmentBounds;
        return plan.segments.map((segment, index) => { const b = bounds[index]; return { route, segment, minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY }; });
    });
    const needEnvelope = layout.bandBounds?.left == null || layout.bandBounds?.width == null;
    let envelopeLeft = Infinity, envelopeRight = -Infinity;
    if (needEnvelope) for (const n of children) { envelopeLeft = Math.min(envelopeLeft, n.x - (layout.orientation === 'right' ? 16 : 0)); envelopeRight = Math.max(envelopeRight, n.x + n.width); }
    const routeBounds = routeGeometry.map((plan, route) => {
        const b = plan.bounds;
        if (plan.points) {
            if (!Number.isFinite(b.minX) || !Number.isFinite(b.minY) || !Number.isFinite(b.maxX) || !Number.isFinite(b.maxY)
                || b.minX < -.1 || b.minY < -.1 || b.maxX > layout.width + .1 || b.maxY > layout.height + .1) invalidGeometry++;
            if (needEnvelope) {
                if (layout.routes[route].from.id !== coverKey) { envelopeLeft = Math.min(envelopeLeft, b.minX); envelopeRight = Math.max(envelopeRight, b.maxX); }
                else for (const point of plan.points) if (point.y >= first - 16) { envelopeLeft = Math.min(envelopeLeft, point.x); envelopeRight = Math.max(envelopeRight, point.x); }
            }
        }
        return b;
    });
    const expected = new Set<string>(), drawn = new Set<string>(), carrying = new Map<string, number[]>();
    for (const item of items) for (const parent of item.parents) if (wanted.has(parent)) expected.add(`${parent}\u0000${item.key}`);
    layout.routes.forEach((r, i) => {
        for (const c of r.consumers) if (wanted.has(c.parent) && wanted.has(c.child)) {
            const key = `${c.parent}\u0000${c.child}`; drawn.add(key);
            const list = carrying.get(key);
            if (!list) carrying.set(key, [i]); else if (list.at(-1) !== i) list.push(i);
        }
    });
    const joinedRoutes = new Uint8Array(lines.length);
    let needsJoins = false;
    if (full) for (const edge of expected) {
        const indices = carrying.get(edge);
        if (indices && indices.length > 1) { needsJoins = true; for (const index of indices) joinedRoutes[index] = 1; }
    }
    invalidGeometry += [...layout.junctions.values()].filter(j => ![j.x,j.y].every(Number.isFinite) || j.x < -.1 || j.y < -.1 || j.x > layout.width + .1 || j.y > layout.height + .1).length;
    const left = layout.bandBounds?.left ?? envelopeLeft - 8, width = children.length ? layout.bandBounds?.width ?? envelopeRight + 8 - left : 0;
    const height = children.length ? Math.max(0, layout.height - (layout.bandBounds?.top ?? first) + STACK_STEM_ROOM) : 0;
    const area = width * height, tileArea = children.reduce((sum, n) => sum + n.width * n.height, 0);
    let length = 0, turning = 0, tileIntersections = 0, overlaps = 0, crossings = 0, sharedLanePx = 0;
    const boxes = [...layout.nodes.values()];
    if (!gatesOnly) for (const plan of routeGeometry) { length += plan.plan.length; turning += plan.plan.bends * (Math.PI / 2); }
    const withArrows = lines.map((ss, i) => {
        const last = ss.at(-1);
        if (!last || !layout.routes[i].terminal)
            return ss;
        const [a, b] = last, len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!len)
            return ss;
        return [...ss, [b, { x: b.x + (b.x - a.x) / len * ARROW.length, y: b.y + (b.y - a.y) / len * ARROW.length }] as Segment];
    });
    if (!invalidGeometry) {
        const tileBounds = boxes.map(n => ({ minX: n.x, maxX: n.x + n.width, minY: n.y, maxY: n.y + n.height }));
        if (boxes.length <= 32) {
            for (let route = 0; route < withArrows.length; route++) {
                const bounds = routeBounds[route], arrow = withArrows[route].length > lines[route].length ? withArrows[route].at(-1) : undefined;
                const envelope = arrow ? { minX: Math.min(bounds.minX, arrow[1].x), maxX: Math.max(bounds.maxX, arrow[1].x), minY: Math.min(bounds.minY, arrow[1].y), maxY: Math.max(bounds.maxY, arrow[1].y) } : bounds;
                const segmentBounds = routeGeometry[route].segmentBounds;
                for (let tile = 0; tile < boxes.length; tile++) {
                    const box = tileBounds[tile];
                    if (!touches(envelope, box)) continue;
                    // Per-segment bounds reject most samples before the exact clip test.
                    let hit = !!arrow && touches(boundsOf(arrow), box) && intersectsTile(arrow, boxes[tile]);
                    for (let i = 0; !hit && i < segmentBounds.length; i++) hit = touches(segmentBounds[i], box) && intersectsTile(lines[route][i], boxes[tile]);
                    if (hit) tileIntersections++;
                }
            }
        } else {
            const tiles = new SpatialBins(tileBounds);
            boxes.forEach((_, i) => tiles.add(i));
            const hits = new Uint32Array(boxes.length), preparedPlans = plansFor();
            for (let route = 0; route < withArrows.length; route++) {
                const plans = withArrows[route].length > lines[route].length
                    ? [...preparedPlans[route], { route, segment: withArrows[route].at(-1)!, ...boundsOf(withArrows[route].at(-1)!) }] : preparedPlans[route];
                for (const plan of plans) for (const index of tiles.candidates(plan)) {
                    if (hits[index] !== route + 1 && intersectsTile(plan.segment, boxes[index])) { hits[index] = route + 1; tileIntersections++; }
                }
            }
            if (boxes.length > 64) for (let i = 0; i < boxes.length; i++) for (const j of tiles.candidates(tileBounds[i])) {
                const a = boxes[i], b = boxes[j];
                if (j > i && a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS) overlaps++;
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
    const sameSource = layout.routes.map(r => `${r.from.kind}\u0000${r.from.id}`);
    const sourceBounds = new Map<string, Bounds>();
    if (!gatesOnly) for (let route = 0; route < lines.length; route++) if (lines[route].length) {
        const key = sameSource[route], b = routeBounds[route], old = sourceBounds.get(key);
        sourceBounds.set(key, old ? { minX: Math.min(old.minX, b.minX), maxX: Math.max(old.maxX, b.maxX), minY: Math.min(old.minY, b.minY), maxY: Math.max(old.maxY, b.maxY) } : b);
    }
    const sources = [...sourceBounds.values()].sort((a, b) => a.minX - b.minX);
    let mayCross = false;
    for (let i = 0; i < sources.length && !mayCross; i++) for (let j = i + 1; j < sources.length && sources[j].minX <= sources[i].maxX + EPS; j++) if (touches(sources[i], sources[j])) { mayCross = true; break; }
    const spatialCrossings = full && !gatesOnly && !invalidGeometry && mayCross && (lines.length > 64 || lines.reduce((sum, ss) => sum + ss.length, 0) > 1024);
    // Long routed polylines have huge mostly empty route envelopes; joins need the sparse segment index too.
    const spatialJoins = !spatialCrossings && full && !invalidGeometry && needsJoins && routeBounds.some((b, route) => joinedRoutes[route] && b.maxY - b.minY > 384 && b.maxX - b.minX > 96);
    const indexed: readonly IndexedSegment[] = spatialCrossings ? plansFor().flat() : spatialJoins ? plansFor().flatMap((plans, route) => joinedRoutes[route] ? plans : []) : [];
    const segmentBins = spatialCrossings || spatialJoins ? new SpatialBins(indexed, 48, .15) : undefined;
    if (segmentBins && !spatialCrossings) indexed.forEach((_, index) => segmentBins.add(index));
    if (full && !gatesOnly && !invalidGeometry && mayCross) {
        const pairHits = new Map<number, Set<string>>(), routeCount = layout.routes.length;
        const allowedCache = new Map<number, Point[]>();
        const visit = (route: number, otherRoute: number, segment: Segment, other: Segment) => {
            const pair = otherRoute * routeCount + route;
            const point = crossing(segment, other);
            if (point) {
                let allowed = allowedCache.get(pair);
                if (!allowed) {
                    const r = layout.routes[route], t = layout.routes[otherRoute];
                    const common = [r.from, r.to].filter(e => [t.from, t.to].some(f => e.kind === f.kind && e.id === f.id));
                    allowed = common.flatMap(e => e.kind === 'junction'
                        ? [layout.junctions.get(e.id)].filter(Boolean).map(p => ({ x: p!.x, y: p!.y }))
                        : [layout.nodes.get(e.id)].filter(Boolean).flatMap(n => [{ x: n!.x + n!.width / 2, y: n!.y }, { x: n!.x + n!.width / 2, y: n!.y + n!.height }]));
                    allowedCache.set(pair, allowed);
                }
                if (!allowed.some(q => Math.hypot(point.x - q.x, point.y - q.y) < 1)) {
                    let hits = pairHits.get(pair);
                    if (!hits) { hits = new Set(); pairHits.set(pair, hits); }
                    hits.add(`${Math.round(point.x * 10)},${Math.round(point.y * 10)}`);
                }
            }
            sharedLanePx += overlapLength(segment, other);
        };
        if (spatialCrossings && segmentBins) {
            for (let index = 0; index < indexed.length; index++) {
                const entry = indexed[index], route = entry.route;
                for (const otherIndex of segmentBins.candidates(entry)) {
                    const other = indexed[otherIndex];
                    if (route !== other.route && sameSource[route] !== sameSource[other.route] && touches(entry, other)) visit(route, other.route, entry.segment, other.segment);
                }
                segmentBins.add(index);
            }
        } else {
            const preparedPlans = plansFor();
            for (let route = 0; route < lines.length; route++) for (let other = 0; other < route; other++) if (sameSource[route] !== sameSource[other] && touches(routeBounds[route], routeBounds[other])) {
                for (const a of preparedPlans[route]) for (const b of preparedPlans[other]) if (touches(a, b)) visit(route, other, a.segment, b.segment);
            }
        }
        crossings = [...pairHits.values()].reduce((sum, points) => sum + points.size, 0);
    }
    let terminalViolations = 0;
    const terminalCounts = new Map<string, number>();
    for (const route of layout.routes) if (route.terminal && route.to.kind === 'node') terminalCounts.set(route.to.id, (terminalCounts.get(route.to.id) ?? 0) + 1);
    for (const item of items) {
        const hasParents = item.parents.some(p => wanted.has(p));
        if ((terminalCounts.get(item.key) ?? 0) !== (hasParents ? 1 : 0)) terminalViolations++;
    }
    layout.routes.forEach((r, i) => { if (!r.terminal)
        return; const n = layout.nodes.get(r.to.id), last = lines[i].at(-1); if (!n || r.to.kind !== 'node' || !last) {
        terminalViolations++;
        return;
    } const [a, b] = last; const vertical = Math.abs(b.x - n.x - n.width / 2) < .1 && Math.abs(b.y - n.y + ARROW.length) < .1 && Math.abs(a.x - b.x) < .1 && b.y - a.y >= ARROW.length - .1; const horizontal = Math.abs(b.x - n.x + ARROW.length) < .1 && Math.abs(b.y - n.y - n.height / 2) < .1 && Math.abs(a.y - b.y) < .1 && b.x - a.x >= ARROW.length - .1; if (!vertical && !horizontal)
        terminalViolations++; });
    let disconnectedEdges = 0;
    if (full && !invalidGeometry) {
        const on = (p: Point, [a, b]: Segment) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < .15; };
        // Every geometric join is found once, then reused by all consumers of shared trunks.
        const joins = needsJoins ? lines.map(() => new Set<number>()) : [];
        const routeBins = needsJoins && !segmentBins ? new SpatialBins(routeBounds, 96, .15) : undefined;
        if (routeBins) lines.forEach((ss, index) => { if (ss.length && joinedRoutes[index]) routeBins.add(index); });
        if (needsJoins) lines.forEach((ss, route) => {
            if (!ss.length || !joinedRoutes[route]) return;
            for (const point of [ss[0][0], ss.at(-1)![1]]) {
                const near = { minX: point.x - .15, maxX: point.x + .15, minY: point.y - .15, maxY: point.y + .15 };
                if (routeBins) {
                    for (const other of routeBins.candidates(near)) if (route !== other && !joins[route].has(other) && lines[other].some(segment => on(point, segment))) {
                        joins[route].add(other); joins[other].add(route);
                    }
                } else if (segmentBins) {
                    for (const index of segmentBins.candidates(near)) {
                        const other = indexed[index];
                        if (route !== other.route && joinedRoutes[other.route] && !joins[route].has(other.route) && on(point, other.segment)) {
                            joins[route].add(other.route); joins[other.route].add(route);
                        }
                    }
                }
            }
        });
        const startBounds = needsJoins && lines.length > 128 ? lines.map(ss => { const p = ss[0]?.[0]; return p ? { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y } : { minX: Infinity, maxX: Infinity, minY: Infinity, maxY: Infinity }; }) : [];
        const startBins = startBounds.length ? new SpatialBins(startBounds) : undefined;
        if (startBins) lines.forEach((ss, index) => { if (ss.length && joinedRoutes[index]) startBins.add(index); });
        const sourceStarts = new Map<string, ReadonlySet<number>>();
        const startsFor = (parent: string, p: PlacedNode): ReadonlySet<number> => {
            const cached = sourceStarts.get(parent); if (cached) return cached;
            const starts = new Set<number>(), x = p.x + p.width / 2, y = p.y + p.height, rightX = p.x + p.width, rightY = p.y + p.height / 2;
            if (startBins) {
                for (const port of [{ x, y }, { x: rightX, y: rightY }]) for (const index of startBins.candidates({ minX: port.x - .15, maxX: port.x + .15, minY: port.y - .15, maxY: port.y + .15 })) {
                    const point = lines[index][0][0];
                    if (Math.hypot(point.x - port.x, point.y - port.y) < .15) starts.add(index);
                }
            } else lines.forEach((ss, index) => { const point = joinedRoutes[index] ? ss[0]?.[0] : undefined; if (point && (Math.hypot(point.x - x, point.y - y) < .15 || Math.hypot(point.x - rightX, point.y - rightY) < .15)) starts.add(index); });
            sourceStarts.set(parent, starts); return starts;
        };
        const membership = new Uint32Array(needsJoins ? lines.length : 0), visited = new Uint32Array(needsJoins ? lines.length : 0);
        let stamp = 0;
        for (const edge of expected) {
            stamp++;
            const [parent, child] = edge.split('\u0000'), p = layout.nodes.get(parent), indices = carrying.get(edge) ?? [];
            if (!p) { disconnectedEdges++; continue; }
            if (indices.length <= 1) {
                const index = indices[0], start = index === undefined ? undefined : lines[index][0]?.[0], route = layout.routes[index];
                const atPort = start && (Math.hypot(start.x - (p.x + p.width / 2), start.y - (p.y + p.height)) < .15 || Math.hypot(start.x - (p.x + p.width), start.y - (p.y + p.height / 2)) < .15);
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
    }
    const penalties = nodePenalties(layout, coverKey, items, previous, anchorKey, gatesOnly);
    return { height, width, area, tileArea, whitespace: area ? 1 - tileArea / area : 0, paneWhitespace: height ? 1 - tileArea / (Math.max(paneWidth, width) * height) : 0, length, bends: turning / (Math.PI / 2), crossings, sharedLanePx, tileIntersections, overlaps, ...penalties, overflow: Math.max(0, width - paneWidth), missingEdges: [...expected].filter(e => !drawn.has(e)).length, extraEdges: [...drawn].filter(e => !expected.has(e)).length, missingNodes, extraNodes, invalidGeometry, invalidPaths, terminalViolations, disconnectedEdges };
}
/** Complete objective and every hard gate; callers cannot disable connectivity checks. */
export function measure(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string): Measures {
    return evaluate(layout, coverKey, paneWidth, items, previous, anchorKey);
}

/** Exact hard constraints for a sole cold constructive candidate; objective ranking is vacuous.
 * Soft diagnostic fields are zero. A choice between candidates must use full measure(). */
export function validateLayout(layout: GraphLayout, coverKey: string, paneWidth: number, items: readonly LayoutItem[]): Measures {
    return evaluate(layout, coverKey, paneWidth, items, undefined, undefined, true);
}

export const HEIGHT_WEIGHT = 16;
export const CROSSING_WEIGHT = .1;

export interface Weights {
    readonly stability: number;
}
/** Tile-size normalized perceptual cost, with hard geometry/parentage gates. Whitespace is reported separately: area and height already price it. */
export function cost(m: Measures, tileWidth: number, weights: Weights = { stability: 1.5 }): number {
    if (m.overlaps || m.tileIntersections || m.directionViolations || m.missingEdges || m.extraEdges || m.missingNodes || m.extraNodes || m.invalidGeometry || m.invalidPaths || m.terminalViolations || m.disconnectedEdges)
        return Infinity;
    return HEIGHT_WEIGHT * m.height / tileWidth + 2 * m.area / (tileWidth * tileWidth) + .08 * m.length / tileWidth + .12 * m.bends + CROSSING_WEIGHT * m.crossings + 4 * m.sharedLanePx / tileWidth + .5 * m.mixedDirections + 3 * m.siblingInversions + .25 * m.unaligned + 100 * m.overflow / tileWidth + weights.stability * (m.displacement / tileWidth + .25 * m.maxDisplacement / tileWidth + 2 * m.anchorDisplacement / tileWidth);
}
