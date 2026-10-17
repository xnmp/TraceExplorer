import { rerouteRetainedRoute } from './band-incremental';
import { resizedTiles } from './band-history';
import { ARROW, PORT_BERTH } from './metrics';
import { mapPathNumbers, pathNumbers } from './path-data';
import { pathCommands } from './path-sampling';
import { repairRouteContacts } from './repair-route-contacts';
import { intersectsTile, segments } from './layout-quality';
import { eachConsumer } from './route-consumers';
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute } from './layout';

/** Fixed retained rectangles, with either no descent or one complete hint-height column descent. */
export function rerouteResizedHistory(request: LayoutRequest, before: GraphLayout, heights: ReadonlyMap<string, number>, shiftColumns: boolean, paneLeft = 0): GraphLayout | null {
  for (const minimal of shiftColumns ? [true, false] : [false]) {
    const result = reroute(request, before, heights, shiftColumns, paneLeft, false, false, minimal)
      ?? reroute(request, before, heights, shiftColumns, paneLeft, true, false, minimal)
      ?? reroute(request, before, heights, shiftColumns, paneLeft, true, true, minimal);
    if (result) return result;
  }
  return null;
}

function reroute(request: LayoutRequest, before: GraphLayout, heights: ReadonlyMap<string, number>, shiftColumns: boolean, paneLeft: number, clearObsolete: boolean, reverse: boolean, minimal: boolean): GraphLayout | null {
  if (!heights.size) return null;
  let nodes = shiftColumns ? resizedTiles(before, heights).nodes
    : new Map([...before.nodes].map(([key, node]) => [key, { ...node, height: heights.get(key) ?? node.height }]));
  if (minimal) {
    // A free vertical gap can absorb the hint: do not force a distant junction's whole
    // column to descend. This is only a search candidate; the complete ink gate admits it.
    const settled = new Map<string, PlacedNode>();
    for (const old of [...before.nodes.values()].sort((a, b) => a.y - b.y)) {
      const proposed = nodes.get(old.key)!;
      const needed = [...settled.values()].some(upper => {
        const was = before.nodes.get(upper.key)!;
        return upper.y + upper.height > was.y + was.height && was.y + was.height <= old.y
          && old.x < upper.x + upper.width && upper.x < old.x + old.width
          && old.y - upper.y - upper.height < 2 * PORT_BERTH;
      });
      settled.set(old.key, needed ? proposed : { ...proposed, y: old.y });
    }
    nodes = settled;
  }
  const descent = (key: string) => (nodes.get(key)?.y ?? 0) - (before.nodes.get(key)?.y ?? 0);
  const junctions = new Map([...before.junctions].map(([key, join]) => {
    const children = before.routes.filter(route => [route.from, route.to].some(e => e.kind === 'junction' && e.id === key))
      .flatMap(route => [...eachConsumer(route)].map(c => c.child));
    return [key, { ...join, y: join.y + Math.max(0, ...children.map(descent)) }] as const;
  }));
  const endpointDescent = (end: PlacedRoute['from']) => end.kind === 'node' ? descent(end.id)
    : (junctions.get(end.id)?.y ?? 0) - (before.junctions.get(end.id)?.y ?? 0);
  // Retain rigidly translated ink; junction branches can stretch their final vertical approach.
  const routes = before.routes.map(route => {
    const from = endpointDescent(route.from), to = endpointDescent(route.to), points = pathNumbers(route.path);
    if (from && from === to && (route.from.kind !== 'node' || !heights.has(route.from.id)))
      return { ...route, path: mapPathNumbers(route.path, (v, i) => i % 2 ? v + from : v) };
    if (route.from.kind !== 'junction') return route;
    if (!from && !to) return route;
    // Preserve the junction's branch geometry and extend/shorten its final vertical approach
    // independently when the target stayed in a neighbouring column.
    if (points.length < 4 || points.at(-4) !== points.at(-2)) return route;
    return { ...route, path: mapPathNumbers(route.path, (v, i) => i % 2 ? v + (i === points.length - 1 ? to : from) : v) };
  });
  const rows = before.orientation !== 'down' ? before.rows : before.rows.map(row => {
    const members = row.keys.flatMap(key => nodes.has(key) ? [nodes.get(key)!] : []);
    return members.length ? { ...row, top: Math.min(...members.map(n => n.y)), bottom: Math.max(...members.map(n => n.y + n.height)) } : row;
  });
  const bottom = (tiles: GraphLayout['nodes']) => Math.max(0, ...[...tiles.values()].map(n => n.y + n.height));
  let draft: GraphLayout = { ...before, nodes, junctions, routes, rows,
    height: before.height + Math.max(0, bottom(nodes) - bottom(before.nodes)) };
  const changed = [...nodes.values()].filter(n => n.y !== before.nodes.get(n.key)!.y || n.height !== before.nodes.get(n.key)!.height);
  const sidePortChanged = (route: PlacedRoute): boolean => {
    const target = route.to.kind === 'node' ? before.nodes.get(route.to.id) : undefined, points = pathNumbers(route.path);
    return !!target && heights.has(target.key) && points.at(-2) === target.x - ARROW.length && points.at(-1) === target.y + target.height / 2;
  };
  const replacements = before.routes.filter(route => route.from.kind === 'node' && (sidePortChanged(route)
    || endpointDescent(route.from) || endpointDescent(route.to)
    || changed.some(tile => segments(route.path).some(piece => intersectsTile(piece, tile)))));
  const translated = new Set(replacements.filter(route => {
    const updated = routes.find(r => r.id === route.id)!;
    return updated !== route && !changed.some(tile => segments(updated.path).some(piece => intersectsTile(piece, tile)));
  }).map(route => route.id));
  if (clearObsolete) {
    const replaced = new Set(replacements.filter(route => !translated.has(route.id)).map(route => route.id));
    draft = { ...draft, routes: draft.routes.filter(route => !replaced.has(route.id)) };
  }
  for (const route of reverse ? [...replacements].reverse() : replacements) {
    if (translated.has(route.id)) continue;
    const target = route.to.kind === 'node' ? before.nodes.get(route.to.id) : undefined, sidePort = sidePortChanged(route);
    const join = route.to.kind === 'junction' ? before.junctions.get(route.to.id) : undefined;
    const joinDescent = endpointDescent(route.to);
    const channelTop = join ? Math.min(join.y - 2 * PORT_BERTH,
      Math.max(0, ...join.parents.map(key => { const n = before.nodes.get(key); return n ? n.y + n.height : 0; }))) : 0;
    const reconnected = join && joinDescent ? { ...route,
      path: mapPathNumbers(route.path, (v, i) => i % 2 && v >= channelTop ? v + joinDescent : v) } : route;
    draft = { ...draft, routes: clearObsolete ? [...draft.routes, reconnected] : draft.routes.map(r => r.id === route.id ? reconnected : r) };
    const rerouted = rerouteRetainedRoute(request, draft, route.id, undefined, paneLeft);
    if (rerouted) { draft = rerouted; continue; }
    if (!sidePort || endpointDescent(route.from) || endpointDescent(route.to)) {
      const source = route.from.kind === 'node' ? before.nodes.get(route.from.id) : undefined;
      const shifted = source && nodes.get(source.key), commands = pathCommands(route.path), values = pathNumbers(route.path);
      const down = source ? descent(source.key) : 0;
      // The old channel can still be legal when the bounded router cannot rediscover
      // it. Move its right-port departure with the source and retain the fixed suffix.
      // Keep the following vertical run's direction so a native curve cannot gain a cusp.
      if (source && shifted && shifted.height === source.height && down && !endpointDescent(route.to)
        && commands?.[1]?.kind === 'L' && commands?.[2]?.kind === 'L'
        && values[0] === source.x + source.width && values[1] === source.y + source.height / 2
        && values[2] > values[0] && values[3] === values[1] && values[4] === values[2]
        && (values[5] - values[3]) * (values[5] - values[3] - down) > 0) {
        draft = { ...draft, routes: draft.routes.map(r => r.id === route.id
          ? { ...r, path: mapPathNumbers(route.path, (value, i) => i === 1 || i === 3 ? value + down : value) } : r) };
        continue;
      }
      return null;
    }
    // A short side approach can only follow the new centre by crossing foreign ink. The bounded
    // contact repair can move that foreign departure; only its independently certified result survives.
    const from = target!.y + target!.height / 2, to = target!.y + heights.get(target!.key)! / 2;
    draft = { ...draft, routes: draft.routes.map(r => r.id === route.id
      ? { ...r, path: mapPathNumbers(r.path, (v, i) => i % 2 && i > 1 && v === from ? to : v) } : r) };
  }
  const byId = new Map(draft.routes.map(route => [route.id, route]));
  draft = { ...draft, routes: before.routes.map(route => byId.get(route.id)!) };
  const retained = request.items.filter(item => nodes.has(item.key));
  return repairRouteContacts(draft, { ...request, items: retained });
}
