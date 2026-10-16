/** Serial fallback with early binary meetings and reusable source lanes. */
import type { GraphLayout, LayoutRequest, PlacedJunction, PlacedNode, PlacedRoute, RowBox } from './layout';
import { buildInputJunctions, endpointKey, type Endpoint } from './junctions';
import { boundedJunctions } from './bounded-junctions';
import { fallbackOrder, fallbackLanes } from './fallback-order';
import { streamingJunctions, type SharedRoute } from './streaming-junctions';
import { routeConsumers, consumerCount, type ConsumerSet } from './route-consumers';
import { safeChain } from './safe-chain';
import { ARROW } from './metrics';

export function safeLayout(request: LayoutRequest): GraphLayout {
  return serialLayout(request, false);
}

function serialLayout(request: LayoutRequest, streaming: boolean, arrivalRank?: ReadonlyMap<string, number>): GraphLayout {
  const items = [...request.items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const byKey = new Map(items.map(n => [n.key, n]));
  const original = buildInputJunctions(items.map(n => ({ child: n.key, parents: [...new Set(n.parents)].filter(p => byKey.has(p)) })));
  const plan = streaming ? streamingJunctions(original, arrivalRank!) : boundedJunctions(original, 2);
  const endpoints: Endpoint[] = [...items.map(n => ({ kind: 'node' as const, id: n.key })), ...plan.joins.map(j => ({ kind: 'junction' as const, id: j.id }))];
  const byEnd = new Map(endpoints.map(end => [endpointKey(end), end]));
  const children = new Map<string, string[]>(), parents = new Map(endpoints.map(end => [endpointKey(end), [] as string[]]));
  const incoming = new Map<string, SharedRoute[]>();
  for (const route of plan.routes) {
    const from = endpointKey(route.from), to = endpointKey(route.to);
    const outputs = children.get(from) ?? []; outputs.push(to); children.set(from, outputs);
    parents.get(to)!.push(from);
    const inputs = incoming.get(to) ?? []; inputs.push(route); incoming.set(to, inputs);
  }
  const cover = request.band?.key;
  const order = fallbackOrder([...byEnd.keys()], parents, children, cover ? endpointKey({kind:'node', id:cover}) : undefined);
  const widest = items.reduce((max, n) => Math.max(max, n.width), 1);
  const laneIndices = fallbackLanes(order, children);
  const laneCount = [...laneIndices.values()].reduce((max, lane) => Math.max(max, lane + 1), 0);
  const inset = Math.max(0, Math.min(8, request.maxWidth - widest - laneCount * 3));
  const center = widest / 2 + inset;
  const lanes = new Map([...laneIndices].map(([key, lane]) => [key, widest + inset + 3 + lane * 3]));
  const right = [...lanes.values()].reduce((max, x) => Math.max(max, x), widest + inset);
  if (right > request.maxWidth) {
    const chain = safeChain(request);
    if (chain && chain.width <= request.maxWidth) return chain;
    if (!streaming) return serialLayout(request, true, new Map(order.map((key, i) => [key, i])));
    // This is a limit of this construction, not a proof that the graph cannot fit.
    // Never disguise exhausted lane capacity by publishing a wider fallback.
    throw new RangeError('Bounded fallback lane capacity exhausted; feasibility unknown');
  }
  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [], rows: RowBox[] = [];
  const joins = new Map(plan.joins.map(j => [j.id, j])), positions = new Map<string, { x: number; y: number }>();
  const readingOrder = new Map<string, number>();
  let bottom = 0;
  for (const [i, key] of order.entries()) {
    const end = byEnd.get(key)!, y = i ? bottom + 64 : 0;
    if (end.kind === 'node') {
      const item = byKey.get(end.id)!, x = end.id === cover && request.pinned ? request.pinned.x : center;
      const row = rows.length;
      nodes.set(end.id, { key: end.id, x: x - item.width / 2, y, width: item.width, height: item.height, row, band: row });
      rows.push({ index: row, band: row, top: y, bottom: y + item.height, keys: [end.id] });
      positions.set(key, { x, y: y + item.height }); readingOrder.set(end.id, row); bottom = y + item.height;
    } else {
      junctions.set(end.id, { id: end.id, x: center, y, parents: joins.get(end.id)!.parents });
      positions.set(key, { x: center, y }); bottom = y;
    }
  }
  const branches = new Map<string, { y: number; consumers: ConsumerSet }[]>();
  for (const key of order) {
    const end = byEnd.get(key)!, inputs = incoming.get(key) ?? [];
    const targetY = end.kind === 'node' ? nodes.get(end.id)!.y : junctions.get(end.id)!.y;
    for (const [i, route] of inputs.entries()) {
      const source = endpointKey(route.from), y = targetY - (end.kind === 'node' ? 24 : i ? 0 : 12);
      const exits = branches.get(source) ?? []; exits.push({ y, consumers: route.consumers }); branches.set(source, exits);
      const points = [[lanes.get(source)!, y], [center, y]];
      if (end.kind === 'node') points.push([center, targetY - ARROW.length]);
      else if (y !== targetY) points.push([center, targetY]);
      routes.push({ id: JSON.stringify(['safe-branch', source, key]), ...route, terminal: end.kind === 'node',
        path: points.map(([x, py], j) => `${j ? 'L' : 'M'}${x} ${py}`).join(' ') });
    }
  }
  // Each source trunk is drawn once; suffix consumer ranges avoid copying fans.
  for (const [key, exits] of branches) {
    exits.sort((a, b) => a.y - b.y);
    const consumers = exits.length === 1 ? exits[0].consumers : exits.flatMap(routeConsumers);
    const table = Array.isArray(consumers) ? { entries: consumers, start: 0, end: consumers.length }
      : consumers as Exclude<ConsumerSet, readonly unknown[]>;
    const source = positions.get(key)!, x = lanes.get(key)!, end = byEnd.get(key)!;
    let start = table.start;
    for (let i = 0; i < exits.length; i++) {
      const points = i ? [[x, exits[i - 1].y], [x, exits[i].y]]
        : [[source.x, source.y], [source.x, source.y + 12], [x, source.y + 12], [x, exits[i].y]];
      routes.push({ id: JSON.stringify(['safe-trunk', key, i]), from: end, to: end,
        terminal: false, consumers: { entries: table.entries, start, end: table.end },
        path: points.map(([px, py], j) => `${j ? 'L' : 'M'}${px} ${py}`).join(' ') });
      start += consumerCount(exits[i]);
    }
  }
  return { orientation: 'down', width: Math.max(request.maxWidth, right), height: bottom + 14,
    nodes, junctions, routes, rows, readingOrder, preferredX: 0, decision: { candidate: 'safe-rows', stability: false, fallback: 'geometry-fallback' } };
}
