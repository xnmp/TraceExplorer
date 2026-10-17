/** Import the existing embedding; certification here is local containment, not
 * admission of a drawing. The independent geometry gates remain authoritative. */
import { nearestFree, type GraphLayout, type PlacedNode, type PlacedRoute } from './layout';
import type { BandPlacement } from './band-geometry';
import { pathTailAtY } from './path-geometry';
import type { Point } from './path-sampling';
import { pathTokens } from './path-data';
import { segments } from './layout-quality';
import { arrowTip, BERTH_SLACK } from './route-contacts';
import { ARROW, PORT_BERTH, TRACK_HEIGHT } from './metrics';
import { CONNECTOR_STROKE, CONNECTOR_FILLET_RADIUS, JUNCTION_RADIUS, JUNCTION_STROKE_WIDTH } from './connector-ink';
import { solveSeparation, type CoordinateBounds, type CoordinatePin } from './separation';

export const STROKE_RADIUS = Math.max(...Object.values(CONNECTOR_STROKE)) / 2;
export const FILLET_RADIUS = CONNECTOR_FILLET_RADIUS;
export type PortSide = 'top' | 'right' | 'bottom' | 'left';
export interface InkBounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export type NativeInk = readonly [Point, Point] | readonly [Point, Point, Point, Point];
export interface PathGeometry {
  readonly points: readonly Point[];
  readonly ink: readonly NativeInk[];
  readonly start: Point;
  readonly end: Point;
  readonly hull: InkBounds;
  readonly stroke: InkBounds;
}
export type PortOwner = { readonly kind: 'tile'; readonly id: string; readonly rect: Pick<PlacedNode, 'x' | 'y' | 'width' | 'height'> }
  | { readonly kind: 'junction'; readonly id: string; readonly point: Point };
export interface RoutingPort {
  readonly id: string;
  readonly owner: PortOwner;
  readonly side: PortSide;
  readonly offset: number;
  readonly point: Point;
}
export interface ArrowStub {
  readonly id: string;
  readonly port: string;
  readonly base: Point;
  readonly tip: Point;
  readonly shaft: readonly [Point, Point];
  readonly ink: InkBounds;
  readonly paint: readonly Point[];
}
export interface CertifiedCorridor {
  readonly id: string;
  readonly ink: InkBounds;
  readonly bounds: InkBounds;
  readonly paint: { readonly points: readonly Point[]; readonly radius: number };
}
export interface CertifiedTurn extends CertifiedCorridor {
  readonly before: Point;
  readonly corner: Point;
  readonly after: Point;
  readonly radius: number;
}
export interface RoutingPlan {
  readonly ports: readonly RoutingPort[];
  readonly stubs: readonly ArrowStub[];
  readonly corridors: readonly CertifiedCorridor[];
  readonly turns: readonly CertifiedTurn[];
  /** Geometry-to-port/paint bindings: removing an allocation cannot certify ink. */
  readonly paths: readonly RoutingPath[];
}
export interface RoutingPath {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly points: readonly Point[];
  readonly kind: 'native' | 'polyline';
  readonly native: readonly NativeInk[];
  readonly corridors: readonly string[];
  readonly turns: readonly string[];
  readonly stub?: string;
  /** Keep exact consumer ranges and original path bytes; branch endpoints are
   * geometric ports, not replacements for the semantic from/to identities. */
  readonly route?: PlacedRoute;
}
export class RoutingImportError extends Error {
  constructor(readonly identity: string, message: string) { super(`Routing import ${identity}: ${message}`); this.name = 'RoutingImportError'; }
}
const reject = (id: string, message: string): never => { throw new RoutingImportError(id, message); };
const finite = (id: string, ...values: number[]) => { if (!values.every(Number.isFinite)) reject(id, 'geometry must be finite'); };
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const inflate = (b: InkBounds, radius: number): InkBounds => ({ left: b.left - radius, top: b.top - radius, right: b.right + radius, bottom: b.bottom + radius });
export function inkBounds(points: readonly Point[], radius = 0): InkBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { finite('point', p.x, p.y); left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  const b = inflate({ left, top, right, bottom }, radius);
  finite('bounds', b.left, b.top, b.right, b.bottom);
  return b;
}

export function certifiedCorridor(id: string, points: readonly Point[], radius: number): CertifiedCorridor {
  finite(id, radius);
  if (radius < 0) return reject(id, 'negative paint radius');
  const ink = inkBounds(points, radius);
  return { id, paint: { points, radius }, ink, bounds: ink };
}

/** Absolute M/L/C import retains native control points, never sampled polylines. */
export function importPathGeometry(path: string): PathGeometry {
  if (path.replace(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[MLC]|[\s,]/g, '')) return reject('path', 'malformed path grammar');
  const tokens = pathTokens(path), points: Point[] = [], ink: NativeInk[] = [];
  let index = 0;
  const point = (): Point => {
    const x = tokens[index++], y = tokens[index++];
    if (typeof x !== 'number' || typeof y !== 'number') return reject('path', 'malformed point');
    finite('path', x, y);
    const p = { x, y }; points.push(p); return p;
  };
  if (tokens[index++] !== 'M') return reject('path', 'expected initial M');
  let from = point(); const start = from;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'L') { const to = point(); ink.push([from, to]); from = to; }
    else if (command === 'C') { const a = point(), b = point(), to = point(); ink.push([from, a, b, to]); from = to; }
    else return reject('path', `unsupported command ${command}`);
  }
  const hull = inkBounds(points);
  return { start, end: from, points, ink, hull, stroke: inflate(hull, STROKE_RADIUS) };
}

const routeGeometry = new WeakMap<PlacedRoute, { readonly path: string; readonly geometry: PathGeometry }>();
/** A retained route is immutable; still guard its path for callers holding old objects. */
export function importedRoute(route: PlacedRoute): PathGeometry {
  const cached = routeGeometry.get(route);
  if (cached?.path === route.path) return cached.geometry;
  const geometry = importPathGeometry(route.path);
  routeGeometry.set(route, { path: route.path, geometry }); return geometry;
}

/** Paint projection shared by allocation and the topology import. Allocation
 * measures candidate ink even when its endpoint semantics are not admissible;
 * it must not silently drop that ink because a tile port is disconnected. */
export function importPaintedRoute(route: PlacedRoute): { readonly geometry: PathGeometry; readonly stub?: ArrowStub; readonly corridors: readonly CertifiedCorridor[] } {
  const geometry = importedRoute(route);
  const stub = route.terminal ? importArrowStub(`${route.id}:arrow`, route.path, `${route.id}:to`) : undefined;
  return { geometry, stub, corridors: [certifiedCorridor(`${route.id}:stroke`, geometry.points, STROKE_RADIUS),
    ...(stub ? [certifiedCorridor(`${route.id}:arrow-ink`, stub.paint, 0)] : [])] };
}

export function importPaintedCorridors(topology: Pick<GraphLayout, 'routes' | 'junctions'>): readonly CertifiedCorridor[] {
  const corridors = topology.routes.flatMap(route => importPaintedRoute(route).corridors);
  for (const dot of topology.junctions.values()) corridors.push(certifiedCorridor(`dot:${dot.id}`, [dot], JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2));
  const plan = { ports: [], stubs: [], paths: [], corridors, turns: [] };
  validateRoutingPlan(plan); return corridors;
}

export function tilePort(tile: Pick<PlacedNode, 'key' | 'x' | 'y' | 'width' | 'height'>, side: PortSide, offset = (side === 'top' || side === 'bottom' ? tile.width : tile.height) / 2): RoutingPort {
  const { x, y, width, height } = tile;
  const point = side === 'top' ? { x: x + offset, y } : side === 'bottom' ? { x: x + offset, y: y + height }
    : side === 'left' ? { x, y: y + offset } : { x: x + width, y: y + offset };
  return { id: JSON.stringify(['tile', tile.key, side, offset]), owner: { kind: 'tile', id: tile.key, rect: { x, y, width, height } }, side, offset, point };
}
const junctionPort = (id: string, point: Point, side: PortSide): RoutingPort => ({ id: JSON.stringify(['junction', id, side]), owner: { kind: 'junction', id, point }, side, offset: 0, point });

/** Same final-segment direction as today's renderer/gate, including native cubics. */
export function importArrowStub(id: string, path: string, port: string): ArrowStub {
  const last = segments(path).at(-1), tip = last && arrowTip(last);
  if (!last || !tip) return reject(id, 'arrow stub has no direction');
  const [a, base] = last, length = Math.hypot(base.x - a.x, base.y - a.y);
  const ux = (base.x - a.x) / length, uy = (base.y - a.y) / length;
  const wing = ARROW.width / 2;
  // Preserve the allocation's multiply-before-divide arithmetic, including
  // slanted native endpoints. The hull reserves both arrow wings explicitly.
  const wingX = wing * Math.abs(base.y - a.y) / length, wingY = wing * Math.abs(base.x - a.x) / length;
  const normalX = Math.sign(base.y - a.y) * wingX, normalY = Math.sign(base.x - a.x) * wingY;
  const paint = [{ x: base.x - normalX, y: base.y + normalY }, { x: base.x + normalX, y: base.y - normalY }, tip];
  return { id, port, base, tip, shaft: [{ x: base.x - ux * ARROW.length, y: base.y - uy * ARROW.length }, base],
    paint, ink: inkBounds(paint) };
}

export type RoutingTopology = (Pick<GraphLayout, 'nodes' | 'junctions' | 'routes'> & { readonly departures?: readonly string[] })
  | { readonly points: readonly Point[]; readonly start?: RoutingPort; readonly radiusAt?: (before: Point, corner: Point, after: Point) => number };

/** The one import boundary for the current generators' topology. Ports in a
 * row-local frame, completed shared nets, and cut attachment/channel polylines
 * become the same validated representation without choosing new geometry. */
export function importRoutingPlan(topology: RoutingTopology): RoutingPlan {
  if ('points' in topology) {
    const points = stemCorners(topology.points);
    if (!points.length) return reject('polyline', 'empty path');
    const start = topology.start ?? junctionPort('polyline:start', points[0], 'bottom');
    const end = junctionPort('polyline:end', points.at(-1)!, 'top');
    const turns = importStemTurns(points, topology.radiusAt);
    const plan = { ports: [start, end], stubs: [], corridors: [certifiedCorridor('polyline:stroke', points, STROKE_RADIUS)], turns,
      paths: [{ id: 'polyline:path', kind: 'polyline' as const, start: start.id, end: end.id, points,
        native: points.slice(1).map((p, i): NativeInk => [points[i], p]), turns: turns.map(t => t.id), corridors: ['polyline:stroke'] }] };
    validateRoutingPlan(plan); return plan;
  }
  const ports: RoutingPort[] = [], stubs: ArrowStub[] = [], corridors: CertifiedCorridor[] = [], paths: RoutingPath[] = [];
  for (const id of topology.departures ?? []) {
    const tile = topology.nodes.get(id);
    if (!tile) return reject(id, 'unknown departure owner');
    ports.push(tilePort(tile, 'bottom'));
  }
  const seen = new Set<string>();
  for (const route of topology.routes) {
    if (seen.has(route.id)) reject(route.id, 'duplicate route identity'); seen.add(route.id);
    const paint = importPaintedRoute(route), { geometry, stub } = paint;
    const ownerPort = (end: 'from' | 'to', p: Point): RoutingPort => {
      const endpoint = route[end];
      if (endpoint.kind === 'junction') {
        const dot = topology.junctions.get(endpoint.id);
        if (!dot) return reject(route.id, 'unknown junction owner');
        // A shared prefix may start/stop away from its semantic source's dot.
        const atDot = Math.hypot(dot.x - p.x, dot.y - p.y) <= BERTH_SLACK;
        if (!atDot && end === 'to' && route.from !== route.to && (route.from.kind !== route.to.kind || route.from.id !== route.to.id)) return reject(route.id, 'port off junction owner');
        const owner = junctionPort(atDot ? dot.id : `${route.id}:${end}:branch`, atDot ? dot : p, end === 'from' ? 'bottom' : 'top');
        return { ...owner, id: `${route.id}:${end}` };
      }
      const node = topology.nodes.get(endpoint.id);
      if (!node) return reject(route.id, 'unknown tile owner');
      const candidates = (['bottom', 'right', 'top', 'left'] as const).map(side => tilePort(node, side,
        side === 'top' || side === 'bottom' ? p.x - node.x : p.y - node.y));
      const port = candidates.find(c => Math.hypot(c.point.x - p.x, c.point.y - p.y) <= BERTH_SLACK);
      if (port) return { ...port, id: `${route.id}:${end}` };
      if (end === 'to' && route.terminal) return reject(route.id, 'terminal port off tile edge');
      return { ...junctionPort(`${route.id}:${end}`, p, end === 'from' ? 'bottom' : 'top'), id: `${route.id}:${end}` };
    };
    ports.push(ownerPort('from', geometry.start));
    const target = ownerPort('to', stub?.tip ?? geometry.end); ports.push(target);
    // Tile coordinates precede decimal path serialization. Keep the authored tip
    // on the stub and the exact tile equation on its port; validation permits only
    // the existing serialization allowance, never a changed solver equality.
    if (stub) stubs.push(stub);
    corridors.push(...paint.corridors);
    paths.push({ id: route.id, kind: 'native', route, native: geometry.ink, turns: [], start: `${route.id}:from`, end: `${route.id}:to`, points: geometry.points,
      corridors: [`${route.id}:stroke`, ...(stub ? [`${route.id}:arrow-ink`] : [])], ...(stub ? { stub: stub.id } : {}) });
  }
  // The semantic source may name a shared prefix, but a branch must be on a
  // connected same-source primitive. A detached path is never a new junction.
  const byId = new Map(ports.map(p => [p.id, p]));
  const connected = new Set<string>();
  const at = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= BERTH_SLACK;
  const on = (p: Point, ink: NativeInk) => at(p, ink[0]) || at(p, ink.at(-1)!) || ink.length === 2 &&
    (ink[0].x === ink[1].x && Math.abs(p.x - ink[0].x) <= BERTH_SLACK && p.y >= Math.min(ink[0].y, ink[1].y) && p.y <= Math.max(ink[0].y, ink[1].y)
      || ink[0].y === ink[1].y && Math.abs(p.y - ink[0].y) <= BERTH_SLACK && p.x >= Math.min(ink[0].x, ink[1].x) && p.x <= Math.max(ink[0].x, ink[1].x));
  const source = (r: PlacedRoute) => `${r.from.kind}:${r.from.id}`;
  for (const route of topology.routes) {
    const port = byId.get(`${route.id}:from`)!;
    if (port.owner.kind === 'tile' || route.from.kind === 'junction' && port.owner.id === route.from.id) connected.add(route.id);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const route of topology.routes) if (!connected.has(route.id)) {
      const point = importedRoute(route).start;
      if (topology.routes.some(other => connected.has(other.id) && source(other) === source(route) && importedRoute(other).ink.some(ink => on(point, ink)))) {
        connected.add(route.id); changed = true;
      }
    }
  }
  if (connected.size !== topology.routes.length) reject(topology.routes.find(r => !connected.has(r.id))!.id, 'disconnected source port/branch');
  for (const dot of topology.junctions.values()) {
    corridors.push(certifiedCorridor(`dot:${dot.id}`, [dot], JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2));
  }
  const plan = { ports, stubs, corridors, turns: [], paths };
  validateRoutingPlan(plan); return plan;
}

/** A fixed imported track is checked using slice 1's bounds/pin solver. Free
 * tracks in later slices use the same bounds without a pin, not another clamp. */
export function corridorCoordinate(id: string, value: number, bounds: CoordinateBounds, pin: CoordinatePin = { value, reason: 'imported topology' }): number {
  const solved = solveSeparation({ variables: [{ id, preferred: value, bounds, pin }], order: [id], separations: [] });
  if (!solved.ok) return reject(id, `corridor bound conflict ${JSON.stringify(solved.conflict)}`);
  return solved.positions.get(id)!;
}

/** Import the certified local radius supplied by the existing curve-clearance
 * certifier. Its control hull plus highlight stroke is the turn's ink envelope. */
export function certifiedTurn(id: string, before: Point, corner: Point, after: Point, radius: number): CertifiedTurn {
  const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
  finite(id, radius);
  if (radius < 0 || radius > Math.min(FILLET_RADIUS, incoming / 2, outgoing / 2)) return reject(id, 'turn radius outside bounds');
  const r = radius;
  const a = incoming ? { x: corner.x - (corner.x - before.x) / incoming * r, y: corner.y - (corner.y - before.y) / incoming * r } : corner;
  const b = outgoing ? { x: corner.x + (after.x - corner.x) / outgoing * r, y: corner.y + (after.y - corner.y) / outgoing * r } : corner;
  return { ...certifiedCorridor(id, [a, corner, b], STROKE_RADIUS), before, corner, after, radius: r };
}

/** Imported departure port's exclusion, in the source row's coordinate frame. */
export const departureBerth = (port: RoutingPort) => ({ left: port.point.x - PORT_BERTH, right: port.point.x + PORT_BERTH });

/** Track ownership imported from the existing ordered topology, including tracks
 * belonging to this same net or to a disjoint horizontal span. */
export function turnWindow(corner: Point, channel: { readonly top: number; readonly bottom: number }, centers: readonly number[]): CoordinateBounds {
  const neighbours = centers.filter(y => y !== corner.y).map(y => Math.abs(y - corner.y) / 2);
  return { lower: 0, upper: Math.max(0, Math.min(corner.y - channel.top, channel.bottom - corner.y, ...neighbours)) };
}

export interface AttachmentStem extends RoutingPlan {
  readonly points: readonly Point[];
  readonly tail: string;
}
/** One topology import for packed attachment and motion's pre-rounding skeleton.
 * The cut tail remains authored text: reconnecting must never re-emit it. */
export function importAttachmentStem(path: string, bandTop: number, stemRoom: number, placement: BandPlacement, cover?: RoutingPort): AttachmentStem {
  const cut = pathTailAtY(path, bandTop + stemRoom - 2 * ARROW.length);
  const preferredLane = bandTop + (placement.track ?? 2 * TRACK_HEIGHT);
  const lane = corridorCoordinate('attachment:lane', preferredLane, { lower: placement.coverHeight, upper: bandTop + stemRoom - 2 * ARROW.length });
  const dropX = nearestFree(cut.point.x, [...(placement.coverColumns ?? []), ...(placement.bypassColumns ?? [])]
    .map((x): [number, number] => [x - ARROW.width / 2, x + ARROW.width / 2]), placement.left, placement.right) ?? cut.point.x;
  const start = { x: placement.coverX, y: placement.coverHeight };
  const points = [start, ...(placement.bridge ? [{ x: placement.coverX, y: placement.bridge.top },
    { x: placement.bridge.gutter, y: placement.bridge.top }, { x: placement.bridge.gutter, y: lane }] : [{ x: placement.coverX, y: lane }]),
    { x: dropX, y: lane }, { x: dropX, y: cut.point.y }, cut.point];
  return { ...importRoutingPlan({ points, ...(cover ? { start: cover } : {}) }), points, tail: cut.tail };
}

export function validateRoutingPlan(plan: RoutingPlan): void {
  const ids = new Set<string>();
  const identity = (id: string) => { if (!id || ids.has(id)) reject(id, 'duplicate or empty identity'); ids.add(id); };
  const bounds = (id: string, b: InkBounds) => {
    finite(id, b.left, b.top, b.right, b.bottom);
    if (b.left > b.right || b.top > b.bottom) reject(id, 'inverted bounds');
  };
  const contains = (a: InkBounds, b: InkBounds) => a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
  const ports = new Map<string, RoutingPort>();
  for (const port of plan.ports) {
    identity(port.id); ports.set(port.id, port);
    finite(port.id, port.offset, port.point.x, port.point.y);
    if (!['top', 'right', 'bottom', 'left'].includes(port.side) || !port.owner.id || !['tile', 'junction'].includes(port.owner.kind)) reject(port.id, 'invalid port owner or side');
    if (port.owner.kind === 'tile') {
      const r = port.owner.rect;
      finite(port.id, r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height);
      const size = port.side === 'top' || port.side === 'bottom' ? r.width : r.height;
      const expected = tilePort({ ...r, key: port.owner.id }, port.side, port.offset);
      if (r.width < 0 || r.height < 0 || port.offset < 0 || port.offset > size || !same(port.point, expected.point)) reject(port.id, 'port off owner tile edge');
    } else {
      finite(port.id, port.owner.point.x, port.owner.point.y);
      if (port.offset !== 0 || !same(port.point, port.owner.point)) reject(port.id, 'port off junction owner');
    }
  }
  for (const stub of plan.stubs) {
    identity(stub.id);
    const port = ports.get(stub.port);
    finite(stub.id, stub.base.x, stub.base.y, stub.tip.x, stub.tip.y, ...stub.shaft.flatMap(p => [p.x, p.y]));
    if (!port || Math.hypot(stub.tip.x - port.point.x, stub.tip.y - port.point.y) > BERTH_SLACK) reject(stub.id, 'stub does not meet port');
    if (!same(stub.shaft[1], stub.base) || Math.abs(Math.hypot(stub.tip.x - stub.base.x, stub.tip.y - stub.base.y) - ARROW.length) > BERTH_SLACK
      || Math.abs(Math.hypot(stub.shaft[0].x - stub.base.x, stub.shaft[0].y - stub.base.y) - ARROW.length) > BERTH_SLACK) reject(stub.id, 'invalid arrow stub shaft');
    if (Math.hypot(stub.tip.x - stub.base.x - (stub.base.x - stub.shaft[0].x), stub.tip.y - stub.base.y - (stub.base.y - stub.shaft[0].y)) > BERTH_SLACK) reject(stub.id, 'arrow stub shaft has wrong direction');
    bounds(stub.id, stub.ink);
    if (!contains(stub.ink, inkBounds(stub.paint))) reject(stub.id, 'stub envelope excludes painted arrow');
    if (stub.paint.length !== 3) reject(stub.id, 'invalid painted arrow');
    const [a, b, tip] = stub.paint, ux = (stub.tip.x - stub.base.x) / ARROW.length, uy = (stub.tip.y - stub.base.y) / ARROW.length;
    const wx = a.x - stub.base.x, wy = a.y - stub.base.y;
    if (!same(tip, stub.tip) || Math.hypot((a.x + b.x) / 2 - stub.base.x, (a.y + b.y) / 2 - stub.base.y) > BERTH_SLACK
      || Math.abs(Math.hypot(wx, wy) - ARROW.width / 2) > BERTH_SLACK || Math.abs(wx * ux + wy * uy) > BERTH_SLACK) reject(stub.id, 'invalid painted arrow wings');
  }
  for (const corridor of [...plan.corridors, ...plan.turns]) {
    identity(corridor.id); bounds(corridor.id, corridor.bounds); bounds(corridor.id, corridor.ink);
    if (!contains(corridor.bounds, corridor.ink)) reject(corridor.id, 'corridor narrower than painted ink');
    finite(corridor.id, corridor.paint.radius);
    if (corridor.paint.radius < 0 || !contains(corridor.ink, inkBounds(corridor.paint.points, corridor.paint.radius))) reject(corridor.id, 'corridor excludes actual painted ink');
  }
  for (const turn of plan.turns) {
    finite(turn.id, turn.radius, turn.before.x, turn.before.y, turn.corner.x, turn.corner.y, turn.after.x, turn.after.y);
    const expected = certifiedTurn(turn.id, turn.before, turn.corner, turn.after, turn.radius);
    if (!contains(turn.ink, expected.ink)) reject(turn.id, 'turn narrower than painted fillet');
  }
  const corridors = new Map(plan.corridors.map(c => [c.id, c])), stubs = new Map(plan.stubs.map(s => [s.id, s])), turns = new Map(plan.turns.map(t => [t.id, t]));
  for (const path of plan.paths) {
    identity(path.id);
    if (!['native', 'polyline'].includes(path.kind)) reject(path.id, 'invalid path kind');
    const start = ports.get(path.start), end = ports.get(path.end), first = path.points[0], last = path.points.at(-1);
    const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= BERTH_SLACK;
    if (!start || !end || !first || !last || !near(start.point, first)) reject(path.id, 'path does not meet start port');
    const stub = path.stub ? stubs.get(path.stub) : undefined;
    if (path.stub && !stub || !near(stub?.base ?? end!.point, last!) || stub && stub.port !== end!.id) reject(path.id, 'path does not meet end port/stub');
    if (!path.corridors.length || path.corridors.some(id => !corridors.has(id))) reject(path.id, 'path missing painted corridor');
    const stroke = inkBounds(path.points, STROKE_RADIUS);
    if (!path.corridors.some(id => contains(corridors.get(id)!.ink, stroke))) reject(path.id, 'path outside painted corridor');
    const nativePoints: Point[] = first ? [first] : [];
    let previous = first;
    for (const run of path.native) {
      if (run.length !== 2 && run.length !== 4 || !previous || !same(run[0], previous)) reject(path.id, 'disconnected native primitives');
      nativePoints.push(...run.slice(1)); previous = run.at(-1)!;
    }
    if (nativePoints.length !== path.points.length || nativePoints.some((p, i) => !same(p, path.points[i]))) reject(path.id, 'native primitives differ from path points');
    if (path.route) {
      const authored = importedRoute(path.route);
      if (authored.points.length !== path.points.length || authored.points.some((p, i) => !same(p, path.points[i]))
        || authored.ink.length !== path.native.length || authored.ink.some((run, i) => run.length !== path.native[i].length || run.some((p, j) => !same(p, path.native[i][j])))) reject(path.id, 'native primitives differ from authored route');
    }
    const normal = (side: PortSide): Point => side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 } : side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
    const tangent = (port: RoutingPort, points: readonly Point[]) => {
      if (port.owner.kind !== 'tile') return;
      const first = points[0], next = points.find(p => !same(p, first));
      if (!next) return reject(path.id, 'port has no native tangent');
      const n = normal(port.side), length = Math.hypot(next.x - first.x, next.y - first.y), ux = (next.x - first.x) / length, uy = (next.y - first.y) / length;
      if (ux * n.x + uy * n.y <= 0 || Math.abs(ux * n.y - uy * n.x) > BERTH_SLACK) reject(path.id, 'native tangent does not match port side');
    };
    tangent(start!, path.points);
    // A terminal stub is on the same native tangent as its final straight run.
    tangent(end!, [...path.points].reverse());
    if (path.kind === 'polyline') {
      if (path.native.some(run => run.length !== 2)) reject(path.id, 'polyline contains native cubic');
      if (path.turns.length !== Math.max(0, path.points.length - 2)) reject(path.id, 'path missing certified turn');
      path.turns.forEach((id, i) => {
        const turn = turns.get(id);
        if (!turn || !same(turn.before, path.points[i]) || !same(turn.corner, path.points[i + 1]) || !same(turn.after, path.points[i + 2])
          || !path.corridors.some(id => contains(corridors.get(id)!.bounds, turn.bounds))) reject(path.id, 'turn does not belong to path/corridor');
      });
    }
    if (stub) {
      if (!path.corridors.some(id => contains(corridors.get(id)!.ink, stub.ink))) reject(path.id, 'arrow outside painted corridor');
      // Prove the extra straight shaft using native primitives, not flattened
      // cubic samples or a synthesized line behind the arrow base.
      const ux = (stub.tip.x - stub.base.x) / ARROW.length, uy = (stub.tip.y - stub.base.y) / ARROW.length;
      let length = 0;
      for (let i = path.native.length - 1; i >= 0; i--) {
        const run = path.native[i];
        if (run.length !== 2) break;
        const dx = run[1].x - run[0].x, dy = run[1].y - run[0].y;
        if (Math.abs(dx * uy - dy * ux) > BERTH_SLACK || dx * ux + dy * uy < 0) break;
        length += Math.hypot(dx, dy);
      }
      if (length < ARROW.length - BERTH_SLACK) reject(path.id, 'arrow shaft is not native straight ink');
    }
  }
}

/** The emitter and importer use the same normalization of redundant orthogonal runs. */
export function stemCorners(points: readonly Point[]): readonly Point[] {
  // Drop repeated points, then points inside straight runs, until neither is left: a run that
  // doubles back leaves two equal corners, whose zero-length run has no direction to round.
  let corners: readonly { readonly x: number; readonly y: number }[] = points;
  for (let changed = true; changed;) {
    const distinct: { readonly x: number; readonly y: number }[] = [];
    for (let i = 0; i < corners.length; i++) if (!i || corners[i].x !== corners[i - 1].x || corners[i].y !== corners[i - 1].y) distinct.push(corners[i]);
    const kept: { readonly x: number; readonly y: number }[] = [];
    for (let i = 0; i < distinct.length; i++) {
      const point = distinct[i];
      if (!i || i === distinct.length - 1 || !((distinct[i - 1].x === point.x && point.x === distinct[i + 1].x) || (distinct[i - 1].y === point.y && point.y === distinct[i + 1].y))) kept.push(point);
    }
    changed = kept.length !== corners.length;
    corners = kept;
  }
  return corners;
}

export function importStemTurns(points: readonly Point[], radiusAt?: (before: Point, corner: Point, after: Point) => number): readonly CertifiedTurn[] {
  const corners = stemCorners(points);
  return corners.slice(1, -1).map((corner, i) => {
    const before = corners[i], after = corners[i + 2];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.max(0, Math.min(FILLET_RADIUS, incoming / 2, outgoing / 2, radiusAt?.(before, corner, after) ?? FILLET_RADIUS));
    return certifiedTurn(`turn:${i}`, before, corner, after, radius);
  });
}
