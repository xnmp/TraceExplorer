/** Import the existing embedding; certification here is local containment, not
 * admission of a drawing. The independent geometry gates remain authoritative. */
import { nearestFree, type GraphLayout, type PlacedNode, type PlacedRoute, type PlacedJunction } from './layout';
import type { BandPlacement } from './band-geometry';
import { pathTailAtY } from './path-geometry';
import type { Point } from './path-sampling';
import { pathTokens } from './path-data';
import { segments } from './layout-quality';
import { arrowTip, BERTH_SLACK } from './route-contacts';
import { ARROW, PORT_BERTH, TRACK_HEIGHT, LANE_SEPARATION } from './metrics';
import { CONNECTOR_STROKE, CONNECTOR_FILLET_RADIUS, JUNCTION_RADIUS, JUNCTION_STROKE_WIDTH } from './connector-ink';
import { solveSeparation, type CoordinateBounds, type CoordinatePin } from './separation';
import { consumerKey, endpointKey, type Consumer, type Junction } from './junctions';
import { eachConsumer } from './route-consumers';
import { convergenceBounds, convergenceInput, type ConvergenceInput } from './routing-convergence';
import { convergenceChart, validateConvergenceChart, independentConvergence, type ConvergenceChart } from './routing-chart';

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
/** A distinct approach column terminating inside one junction's convergence
 * region. Semantic input identity is separate from geometric approach order. */
export interface JunctionInputPort {
  readonly id: string;
  readonly junction: string;
  readonly source: string;
  readonly x: number;
  readonly dotX: number;
}
export function junctionInputPorts(join: Junction, dotX: number, inputs: readonly { readonly source: string; readonly x: number }[]): readonly JunctionInputPort[] {
  const expected = new Set(join.inputs.map(endpointKey));
  if (!Number.isFinite(dotX) || inputs.length < 2 || inputs.length !== expected.size || new Set(inputs.map(p=>p.source)).size !== inputs.length
    || inputs.some(p=>!expected.has(p.source) || !Number.isFinite(p.x))) throw new RangeError('Invalid junction inputs: ' + join.id);
  const ordered = [...inputs].sort((a,b)=>a.x-b.x || a.source.localeCompare(b.source));
  return ordered.map((input,i)=>({id:JSON.stringify(['junction-input',join.id,input.source]),junction:join.id,source:input.source,dotX,
    x:dotX + (ordered.length === 2 ? (i ? LANE_SEPARATION : -LANE_SEPARATION) : (i-(ordered.length-1)/2)*LANE_SEPARATION)}));
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
  readonly meetings?: readonly JunctionMeeting[];
  /** Original painted dots, including historical declarations after pruning. */
  readonly junctions?: readonly PlacedJunction[];
}
export interface JunctionMeeting {
  readonly id: string;
  readonly dot: Point;
  readonly parents: readonly string[];
  /** Parentage carried now, distinct from the retained dot's old declaration. */
  readonly projection: { readonly declaredParents: readonly string[] };
  readonly convergence: InkBounds;
  readonly inputs: readonly { readonly source: string; readonly port: string; readonly path: string; readonly parents: readonly string[]; readonly entry: ConvergenceInput;
    }[];
  readonly chart?: ConvergenceChart;
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
/** Validate ranges before iteration: structured-cloned history is untrusted. */
function projectedConsumers(route: PlacedRoute, charge: (work:number,reason?:string)=>void): readonly Consumer[] {
  const consumers = route.consumers;
  if (!consumers || typeof consumers !== 'object') return reject(route.id, 'invalid consumer range');
  if (!Array.isArray(consumers)) {
    const range = consumers as Exclude<typeof consumers, readonly unknown[]>;
    if (!Array.isArray(range.entries) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end > range.entries.length) return reject(route.id, 'invalid consumer range');
  }
  const length = Array.isArray(consumers) ? consumers.length : (consumers as Exclude<typeof consumers, readonly unknown[]>).end - (consumers as Exclude<typeof consumers, readonly unknown[]>).start;
  charge(length, 'consumer projection');
  const result: Consumer[] = [];
  for(const c of eachConsumer(route)) {
    if (!c || typeof c.parent !== 'string' || !c.parent || typeof c.child !== 'string' || !c.child) return reject(route.id, 'invalid consumer');
    result.push(c);
  }
  return result;
}
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
function followsPort(side: PortSide, first: Point, next: Point): boolean {
  const length = Math.hypot(next.x - first.x, next.y - first.y), ux = (next.x - first.x) / length, uy = (next.y - first.y) / length;
  return side === 'top' ? -uy > 0 && Math.abs(ux) <= BERTH_SLACK : side === 'bottom' ? uy > 0 && Math.abs(ux) <= BERTH_SLACK
    : side === 'left' ? -ux > 0 && Math.abs(uy) <= BERTH_SLACK : ux > 0 && Math.abs(uy) <= BERTH_SLACK;
}
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

function tilePortPoint(tile: Pick<PlacedNode, 'x' | 'y' | 'width' | 'height'>, side: PortSide, offset: number): Point {
  const { x, y, width, height } = tile;
  return side === 'top' ? { x: x + offset, y } : side === 'bottom' ? { x: x + offset, y: y + height }
    : side === 'left' ? { x, y: y + offset } : { x: x + width, y: y + offset };
}
export function tilePort(tile: Pick<PlacedNode, 'key' | 'x' | 'y' | 'width' | 'height'>, side: PortSide, offset = (side === 'top' || side === 'bottom' ? tile.width : tile.height) / 2,
  identity = JSON.stringify(['tile', tile.key, side, offset])): RoutingPort {
  const { x, y, width, height } = tile;
  return { id: identity, owner: { kind: 'tile', id: tile.key, rect: { x, y, width, height } }, side, offset, point: tilePortPoint(tile, side, offset) };
}
const junctionPort = (id: string, point: Point, side: PortSide, identity = JSON.stringify(['junction', id, side])): RoutingPort => ({ id: identity, owner: { kind: 'junction', id, point }, side, offset: 0, point });

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
export function importRoutingPlan(topology: RoutingTopology, charge: (work:number, reason?:string)=>void = ()=>{}): RoutingPlan {
  if ('points' in topology) {
    charge(8*topology.points.length+1,'polyline import');
    const { points, turns } = importTurnPlan(topology.points, topology.radiusAt);
    const start = topology.start ?? junctionPort('polyline:start', points[0], 'bottom');
    const end = junctionPort('polyline:end', points.at(-1)!, 'top');
    const plan = { ports: [start, end], stubs: [], corridors: [certifiedCorridor('polyline:stroke', points, STROKE_RADIUS)], turns,
      paths: [{ id: 'polyline:path', kind: 'polyline' as const, start: start.id, end: end.id, points,
        native: points.slice(1).map((p, i): NativeInk => [points[i], p]), turns: turns.map(t => t.id), corridors: ['polyline:stroke'] }] };
    validateRoutingPlan(plan,charge); return plan;
  }
  const ports: RoutingPort[] = [], stubs: ArrowStub[] = [], corridors: CertifiedCorridor[] = [], paths: RoutingPath[] = [];
  charge(topology.junctions.size,'painted junction import');
  for (const id of topology.departures ?? []) {
    const tile = topology.nodes.get(id);
    if (!tile) return reject(id, 'unknown departure owner');
    ports.push(tilePort(tile, 'bottom'));
  }
  const seen = new Set<string>();
  for (const route of topology.routes) {
    charge(route.path.length+1,'native path import');
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
        return junctionPort(atDot ? dot.id : `${route.id}:${end}:branch`, atDot ? dot : p, end === 'from' ? 'bottom' : 'top', `${route.id}:${end}`);
      }
      const node = topology.nodes.get(endpoint.id);
      if (!node) return reject(route.id, 'unknown tile owner');
      const points = geometry.points, first = end === 'from' ? points[0] : points.at(-1)!;
      let next: Point | undefined;
      for (let i = end === 'from' ? 1 : points.length - 2; i >= 0 && i < points.length; i += end === 'from' ? 1 : -1)
        if (!same(points[i], first)) { next = points[i]; break; }
      let touchesEdge = false;
      for (const side of ['bottom', 'right', 'top', 'left'] as const) {
        const horizontal = side === 'top' || side === 'bottom', offset = horizontal ? p.x - node.x : p.y - node.y;
        if (offset < 0 || offset > (horizontal ? node.width : node.height)) continue;
        const point = tilePortPoint(node, side, offset);
        if (Math.hypot(point.x - p.x, point.y - p.y) > BERTH_SLACK) continue;
        touchesEdge = true;
        // Tiny rectangles can put opposite edges within serialization slack.
        // Native direction, rather than side enumeration, owns that port.
        if (next && !followsPort(side, first, next)) continue;
        return tilePort(node, side, offset, `${route.id}:${end}`);
      }
      if (touchesEdge) return reject(route.id, 'native tangent does not match port side');
      if (end === 'to' && route.terminal) return reject(route.id, 'terminal port off tile edge');
      return junctionPort(`${route.id}:${end}`, p, end === 'from' ? 'bottom' : 'top', `${route.id}:${end}`);
    };
    const start = ownerPort('from', geometry.start); ports.push(start);
    const target = ownerPort('to', stub?.tip ?? geometry.end); ports.push(target);
    // Tile coordinates precede decimal path serialization. Keep the authored tip
    // on the stub and the exact tile equation on its port; validation permits only
    // the existing serialization allowance, never a changed solver equality.
    if (stub) stubs.push(stub);
    corridors.push(...paint.corridors);
    paths.push({ id: route.id, kind: 'native', route, native: geometry.ink, turns: [], start: start.id, end: target.id, points: geometry.points,
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
      charge(1,'branch propagation');
      const point = importedRoute(route).start;
      if (topology.routes.some(other => {
        charge(1,'branch candidate');
        return connected.has(other.id) && source(other) === source(route) && importedRoute(other).ink.some(ink => {
          charge(1,'branch connection'); return on(point,ink);
        });
      })) {
        connected.add(route.id); changed = true;
      }
    }
  }
  if (connected.size !== topology.routes.length) reject(topology.routes.find(r => !connected.has(r.id))!.id, 'disconnected source port/branch');
  for (const dot of topology.junctions.values()) {
    corridors.push(certifiedCorridor(`dot:${dot.id}`, [dot], JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2));
  }
  const meetings: JunctionMeeting[] = [];
  for (const dot of topology.junctions.values()) {
    charge(topology.routes.length,'junction input lookup');
    const inputs = topology.routes.filter(route => route.to.kind === 'junction' && route.to.id === dot.id
      && (route.from.kind !== 'junction' || route.from.id !== dot.id));
    if (!inputs.length) continue;
    const arrivals = inputs.map(route=>{
      const entry = convergenceInput(importedRoute(route).ink, dot, charge);
      const source=endpointKey(route.from);
      const port=junctionPort(`${dot.id}:input:${source}`,entry.point,entry.side,JSON.stringify(['junction-input',dot.id,source]));
      ports.push(port);
      const parents = [...new Set(projectedConsumers(route, charge).map(c => c.parent))].sort();
      return {source,port:port.id,path:route.id,parents,entry};
    });
    meetings.push({id:dot.id,dot:{x:dot.x,y:dot.y},parents:[...new Set(arrivals.flatMap(a=>a.parents))].sort(),
      projection:{declaredParents:dot.parents},convergence:convergenceBounds(dot),inputs:arrivals,
      ...(!independentConvergence(arrivals.map(a=>a.entry),charge) ? {chart:convergenceChart(arrivals.map(input=>({path:input.path,entry:input.entry})),dot,charge)} : {})});
  }
  const plan = { ports, stubs, corridors, turns: [], paths, meetings, junctions:[...topology.junctions.values()] };
  validateRoutingPlan(plan,charge); return plan;
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

export function validateRoutingPlan(plan: RoutingPlan, charge: (work:number, reason?:string)=>void = ()=>{}): void {
  charge(plan.ports.length+plan.paths.length+plan.corridors.length+plan.turns.length+plan.stubs.length+(plan.meetings?.length??0)+(plan.junctions?.length??0),'routing plan validation');
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
      const expected = tilePortPoint(r, port.side, port.offset);
      if (r.width < 0 || r.height < 0 || port.offset < 0 || port.offset > size || !same(port.point, expected)) reject(port.id, 'port off owner tile edge');
    } else {
      finite(port.id, port.owner.point.x, port.owner.point.y);
      if (port.offset !== 0 || !same(port.point, port.owner.point)) reject(port.id, 'port off junction owner');
    }
  }
  const meetings=new Map((plan.meetings??[]).map(meeting=>[meeting.id,meeting]));
  const junctions=new Map((plan.junctions??[]).map(dot=>[dot.id,dot]));
  if(junctions.size!==(plan.junctions??[]).length) reject('junctions','duplicate painted junction');
  for(const dot of junctions.values()) {
    finite(dot.id,dot.x,dot.y);
    if(!dot.id || !Array.isArray(dot.parents)) reject(dot.id,'invalid painted junction parent declaration');
    charge(dot.parents.length+1,'retained junction declaration');
    if(Array.from(dot.parents).some(parent=>typeof parent!=='string' || !parent) || new Set(dot.parents).size!==dot.parents.length) reject(dot.id,'invalid painted junction parent declaration');
  }
  const pathsById=new Map(plan.paths.map(path=>[path.id,path]));
  const consumersByPath=new Map(plan.paths.filter(path=>path.route).map(path=>[path.id,projectedConsumers(path.route!,charge)]));
  if(meetings.size!==(plan.meetings??[]).length) reject('junctions','duplicate junction meeting');
  for(const path of plan.paths) if(path.route?.to.kind==='junction'
    && (path.route.from.kind!=='junction' || path.route.from.id!==path.route.to.id) && !meetings.has(path.route.to.id))
    reject(path.route.to.id,'missing junction meeting');
  const represented=new Map<string,ReadonlySet<string>>();
  const representedConsumers=new Map<string,ReadonlySet<string>>();
  const unresolved=new Set(meetings.keys());
  while(unresolved.size) {
    let progressed=false;
    for(const id of unresolved) {
      const meeting=meetings.get(id)!;
      if(!Array.isArray(meeting.parents) || !Array.isArray(meeting.projection?.declaredParents)) reject(id,'invalid junction parent projection');
      charge(meeting.parents.length+meeting.projection.declaredParents.length,'junction declaration projection');
      charge(meeting.inputs.length+1,'junction parentage');
      const sources=meeting.inputs.map(input=>pathsById.get(input.path)?.route?.from);
      if(sources.some(source=>!source)) reject(id,'invalid junction parent binding');
      if(sources.some(source=>source!.kind==='junction' && !represented.has(source!.id))) continue;
      const parents=new Set<string>();
      const consumers=new Set<string>();
      for(const [index,source] of sources.entries()) {
        const input=meeting.inputs[index],route=pathsById.get(input.path)!.route!;
        const available=source!.kind==='node' ? new Set([source!.id]) : represented.get(source!.id)!;
        const carried=consumersByPath.get(route.id)!,inputParents=new Set(carried.map(c=>c.parent));
        if(source!.kind==='junction' && carried.some(c=>!representedConsumers.get(source!.id)!.has(consumerKey(c)))) reject(id,'disconnected junction consumer projection');
        for(const consumer of carried) consumers.add(consumerKey(consumer));
        if(!Array.isArray(input.parents)) reject(id,'invalid junction input parent projection');
        charge(input.parents.length,'junction input projection');
        if(new Set(input.parents).size!==input.parents.length || input.parents.length!==inputParents.size
          || Array.from(input.parents).some(parent=>!inputParents.has(parent)) || [...inputParents].some(parent=>!available.has(parent))) reject(id,'invalid junction input parent projection');
        charge(inputParents.size,'junction parent union');
        for(const parent of inputParents) {
          if(parents.has(parent)) reject(id,'overlapping junction input parentage');
          parents.add(parent);
        }
      }
      if(!Array.isArray(meeting.parents) || new Set(meeting.parents).size!==meeting.parents.length || meeting.parents.length!==parents.size || Array.from(meeting.parents).some(parent=>!parents.has(parent))) reject(id,'incorrect junction parentage');
      const dot=junctions.get(id),declared=meeting.projection?.declaredParents;
      if(!dot || !same(dot,meeting.dot) || !Array.isArray(declared) || declared.length!==dot.parents.length
        || Array.from(declared).some((parent,i)=>parent!==dot.parents[i]) || new Set(declared).size!==declared.length
        || meeting.parents.some(parent=>!declared.includes(parent))) reject(id,'invalid retained junction parent projection');
      represented.set(id,parents);representedConsumers.set(id,consumers);unresolved.delete(id);progressed=true;
    }
    if(!progressed) reject([...unresolved][0],'cyclic or missing junction parentage');
  }
  for(const path of plan.paths) if(path.route) {
    const route=path.route,consumers=consumersByPath.get(path.id)!;
    if(consumers.some(consumer=>route.from.kind==='node' ? consumer.parent!==route.from.id
      : !representedConsumers.get(route.from.id)?.has(consumerKey(consumer)))) reject(path.id,'disconnected source consumer projection');
    if(route.terminal && route.to.kind==='node' && consumers.some(consumer=>consumer.child!==route.to.id)) reject(path.id,'invalid terminal consumer projection');
  }
  for (const meeting of plan.meetings??[]) {
    finite(meeting.id,meeting.dot.x,meeting.dot.y);
    charge(plan.paths.length,'junction path lookup');
    const incoming=plan.paths.filter(path=>path.route?.to.kind==='junction' && path.route.to.id===meeting.id
      && (path.route.from.kind!=='junction' || path.route.from.id!==meeting.id));
    if (!meeting.inputs.length || new Set(meeting.inputs.map(input=>input.source)).size!==meeting.inputs.length || incoming.length!==meeting.inputs.length)
      reject(meeting.id,'incomplete junction inputs');
    const region=convergenceBounds(meeting.dot);
    if(!meeting.convergence || region.left!==meeting.convergence.left || region.top!==meeting.convergence.top
      || region.right!==meeting.convergence.right || region.bottom!==meeting.convergence.bottom) reject(meeting.id,'invalid junction convergence bounds');
    const entries=meeting.inputs.map(input=>convergenceInput(pathsById.get(input.path)!.native,meeting.dot,charge));
    for (const [index,input] of meeting.inputs.entries()) {
      const path=incoming.find(path=>path.id===input.path),port=ports.get(input.port);
      if (!path?.route || !port || input.source!==endpointKey(path.route.from) || !same(path.points.at(-1)!,meeting.dot)) reject(meeting.id,'invalid junction port binding');
      const entry=entries[index],point=port!.point;
      const binding=input.entry;
      if(!binding || binding.primitive!==entry.primitive || binding.parameter!==entry.parameter || binding.side!==entry.side
        || !binding.point || !same(binding.point,entry.point) || !Array.isArray(binding.suffix) || binding.suffix.length!==entry.suffix.length
        || !same(entry.point,point) || port!.side!==entry.side) reject(meeting.id,'junction approach off native path');
      charge(entry.suffix.length,'convergence suffix binding');
      if(Array.from(binding.suffix).some((run,i)=>!Array.isArray(run) || run.length!==entry.suffix[i].length
        || Array.from(run).some((point,j)=>!point || !same(point,entry.suffix[i][j])))) reject(meeting.id,'junction native convergence suffix changed');
    }
    const chartEntries=meeting.chart ? validateConvergenceChart(meeting.chart,
      meeting.inputs.map((input,i)=>({path:input.path,entry:entries[i]})),meeting.dot,charge) : undefined;
    if(!independentConvergence(entries,charge) && (!chartEntries || !independentConvergence(chartEntries,charge)))
      reject(meeting.id,'junction inputs need independent approach ports');
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
    charge(path.native.length+path.points.length+path.corridors.length+path.turns.length+1,'native path validation');
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
    let previous = first, pointIndex = 1;
    for (const run of path.native) {
      if (run.length !== 2 && run.length !== 4 || !previous || !same(run[0], previous)) reject(path.id, 'disconnected native primitives');
      for (let i = 1; i < run.length; i++) {
        const point = path.points[pointIndex++];
        if (!point || !same(run[i], point)) reject(path.id, 'native primitives differ from path points');
      }
      previous = run.at(-1)!;
    }
    if (pointIndex !== path.points.length) reject(path.id, 'native primitives differ from path points');
    if (path.route) {
      const authored = importedRoute(path.route);
      if (authored.points.length !== path.points.length || authored.points.some((p, i) => !same(p, path.points[i]))
        || authored.ink.length !== path.native.length || authored.ink.some((run, i) => run.length !== path.native[i].length || run.some((p, j) => !same(p, path.native[i][j])))) reject(path.id, 'native primitives differ from authored route');
    }
    const tangent = (port: RoutingPort, points: readonly Point[]) => {
      if (port.owner.kind !== 'tile') return;
      const first = points[0], next = points.find(p => !same(p, first));
      if (!next) return reject(path.id, 'port has no native tangent');
      if (!followsPort(port.side, first, next)) reject(path.id, 'native tangent does not match port side');
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
  return stemTurns(corners, radiusAt);
}

/** Local emission needs only normalized points and certified turn envelopes.
 * Endpoints, arrows and route bindings are certified by the completed native
 * plan; allocating a temporary whole path plan here adds no input constraint. */
export function importTurnPlan(points: readonly Point[], radiusAt?: (before: Point, corner: Point, after: Point) => number): {
  readonly points: readonly Point[]; readonly turns: readonly CertifiedTurn[];
} {
  if (!points.length) return reject('polyline', 'empty path');
  for (const point of points) finite('point', point.x, point.y);
  const corners = stemCorners(points);
  return { points: corners, turns: stemTurns(corners, radiusAt) };
}

function stemTurns(corners: readonly Point[], radiusAt?: (before: Point, corner: Point, after: Point) => number): readonly CertifiedTurn[] {
  return corners.slice(1, -1).map((corner, i) => {
    const before = corners[i], after = corners[i + 2];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.max(0, Math.min(FILLET_RADIUS, incoming / 2, outgoing / 2, radiusAt?.(before, corner, after) ?? FILLET_RADIUS));
    return certifiedTurn(`turn:${i}`, before, corner, after, radius);
  });
}
