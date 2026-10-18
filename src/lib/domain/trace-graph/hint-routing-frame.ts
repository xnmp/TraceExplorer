/** Derive a permitted retained-only hint pose before route construction. */
import type { GraphLayout, PlacedNode, PlacedRoute, LayoutItem } from './layout';
import { pathCommands, type Point } from './path-sampling';
import { eachConsumer } from './route-consumers';
import { isLayoutShape } from './history-boundary';
import { hintChanges, eligibleDescent, translated, translatedBy } from './hint-routing-policy';
import { importRoutingPlan } from './routing-plan';
import { chargeRoutingSnapshot } from './routing-problem';
import { chargeRoutingConsumers } from './routing-consumer-work';
const end = (c: {
  values: number[];
}): Point => ({ x: c.values.at(-2)!, y: c.values.at(-1)! });
const source = (r: PlacedRoute) => JSON.stringify([r.from.kind, r.from.id]);
export const inferredItems = (b: GraphLayout): LayoutItem[] => {
  const parents = new Map([...b.nodes.keys()].map(k => [k, new Set<string>()]));
  for (const r of b.routes)
    for (const c of eachConsumer(r))
      parents.get(c.child)?.add(c.parent);
  return [...b.nodes].map(([key, n], order) => ({ ...n, key, order, parents: [...parents.get(key)!] }));
};
export function deriveHintRoutingDrawing(b: GraphLayout, heights: ReadonlyMap<string, number>, descend: boolean, charge: (n: number, s?: string) => void = () => { }): GraphLayout | null {
  chargeRoutingSnapshot([b, heights], charge);
  if (!isLayoutShape(b) || typeof descend !== 'boolean')
    return null;
  heights = hintChanges(b, heights);
  chargeRoutingConsumers(b, charge);
  const imported = importRoutingPlan(b, charge);
  const bytes = b.routes.reduce((sum, r) => sum + r.path.length, 0), k = b.routes.reduce((sum, r) => sum + [...eachConsumer(r)].length, 0);
  charge(8 * (heights.size + 1) * (b.nodes.size + b.routes.length + b.junctions.size + k + 1) ** 2
    + 64 * bytes * (heights.size + 1), 'finite hint frame passes');
  if (!heights.size)
    return b;
  const growth = [...heights].filter(([k, h]) => h > b.nodes.get(k)!.height).map(([k]) => b.nodes.get(k)!);
  const moves = (n: PlacedNode) => descend && eligibleDescent(n, growth) ? 16 : 0;
  const nodes = new Map([...b.nodes].map(([k, n]) => [k, { ...n, y: translated(n.y, moves(n)), height: heights.get(k) ?? n.height }]));
  const cuts = growth.map(tile => {
    const affected = (r: PlacedRoute) => [...eachConsumer(r)].some(c => [c.parent, c.child].some(k => { const n = b.nodes.get(k); return n && (k === tile.key || descend && eligibleDescent(n, [tile])); }));
    return { tile, y: tile.y + tile.height, sources: new Set(b.routes.filter(affected).map(source)) };
  });
  const affectedJoins = new Map<string, number>();
  for (const [key] of b.junctions) {
    const targets = b.routes.filter(r => [r.from, r.to].some(e => e.kind === 'junction' && e.id === key)).flatMap(r => [...eachConsumer(r)].map(c => b.nodes.get(c.child))).filter((n): n is PlacedNode => !!n);
    affectedJoins.set(key, Math.max(0, ...targets.map(moves)));
  }
  const junctions = new Map([...b.junctions].map(([k, j]) => [k, { ...j, y: translated(j.y, affectedJoins.get(k)!) }]));
  const routes: PlacedRoute[] = [];
  for (const r of b.routes) {
    const cs = pathCommands(r.path);
    if (!cs)
      return null;
    const relevant = descend ? cuts.filter(c => c.sources.has(source(r))) : [];
    const shift = (y: number) => relevant.some(c => y >= c.y) ? 16 : 0;
    const sourcePort = imported.ports.find(p => p.id === r.id + ':from');
    const sourceOwner = r.from.kind === 'node' ? b.nodes.get(r.from.id) : undefined;
    const shiftedSource = sourceOwner && nodes.get(sourceOwner.key)!;
    const sourceRecipe = sourceOwner && shiftedSource && sourcePort?.owner.kind === 'tile'
      ? [shiftedSource.y - sourceOwner.y, sourcePort.side === 'bottom' ? shiftedSource.height - sourceOwner.height
          : sourcePort.side === 'left' || sourcePort.side === 'right' ? (shiftedSource.height - sourceOwner.height) / 2 : 0] : [];
    const prefixCurves = new Set<number>();
    if (sourcePort?.owner.kind === 'tile') {
      const native = imported.paths.find(p => p.id === r.id)!.native, head = native[0][0];
      for (let i = 0; i < native.length; i++) {
        if (native[i].length === 4)
          prefixCurves.add(i + 1);
        const tail = native[i].at(-1)!;
        if (Math.abs(tail.x - head.x) > 6 || Math.abs(tail.y - head.y) > 6)
          break;
      }
    }
    const oldPoints = cs.map(end), out = cs.map(c => ({ ...c, values: c.values.map((v, j) => j % 2 ? translated(v, shift(v)) : v) }));
    const boundaryY = (index: number, y: number): boolean => {
      // A horizontal free chain carries the boundary equality back to the first
      // vertical run. Iterate so native input size never consumes call-stack depth.
      for (let at = index; at >= 0; at--) {
        if (cs[at].kind === 'C') return Object.is(out[at].values.at(-1), y);
        out[at] = { ...out[at], values: [out[at].values[0], y] };
        if (at === 0 || oldPoints[at - 1].y !== oldPoints[at].y || oldPoints[at - 1].x === oldPoints[at].x) return true;
      }
      return true;
    };
    for (let i = 1; i < cs.length; i++)
      if (cs[i].kind === 'C') {
        // A native curve crossing the column cut belongs wholly to the lower frame.
        // Reconnect its exact translated start through the preceding free core.
        const delta = Math.max(shift(oldPoints[i - 1].y), ...cs[i].values.filter((_, j) => j % 2).map(shift));
        const recipe = prefixCurves.has(i) ? sourceRecipe : [delta];
        out[i] = { ...cs[i], values: cs[i].values.map((v, j) => j % 2 ? translatedBy(v, recipe) : v) };
        if (!boundaryY(i - 1, translatedBy(oldPoints[i - 1].y, recipe)))
          return null;
      }
    const from = r.from.kind === 'node' ? b.nodes.get(r.from.id) : undefined;
    if (from && sourcePort?.owner.kind === 'tile') {
      const p = oldPoints[0], newFrom = nodes.get(from.key)!;
      const dy = newFrom.y - from.y, dh = newFrom.height - from.height;
      const y = translated(translated(p.y, dy), sourcePort.side === 'bottom' ? dh
        : sourcePort.side === 'left' || sourcePort.side === 'right' ? dh / 2 : 0);
      const delta = y - out[0].values[1];
      out[0] = { ...out[0], values: [out[0].values[0], y] };
      if (delta && out[1]?.kind === 'L' && oldPoints[1].y === p.y)
        out[1] = { ...out[1], values: [out[1].values[0], y] };
    }
    if (r.terminal && r.to.kind === 'node') {
      const target = b.nodes.get(r.to.id)!, next = nodes.get(target.key)!, last = out.length - 1, old = oldPoints[last];
      const port = imported.ports.find(p => p.id === r.id + ':to');
      if (port?.owner.kind !== 'tile')
        return null;
      const dh = next.height - target.height;
      const want = translated(translated(old.y, next.y - target.y), port.side === 'bottom' ? dh
        : port.side === 'left' || port.side === 'right' ? dh / 2 : 0);
      const current = out[last].values[1];
      if (want !== current) {
        if (out[last].kind !== 'L')
          return null;
        const prev = end(out[last - 1]);
        if (prev.x === old.x)
          out[last] = { ...out[last], values: [old.x, want] };
        else if (prev.y === current) {
          let k = last;
          while (k > 0 && out[k].kind === 'L' && end(out[k - 1]).y === current) {
            out[k] = { ...out[k], values: [out[k].values[0], want] };
            k--;
          }
          if (k > 0 && out[k].kind === 'L')
            out[k] = { ...out[k], values: [out[k].values[0], want] };
          else
            return null;
        }
        else
          return null;
      }
    }
    if (r.to.kind === 'junction') {
      const input = imported.meetings?.flatMap(m => m.inputs).find(i => i.path === r.id);
      if (!input)
        return null;
      const delta = affectedJoins.get(r.to.id) ?? 0;
      // The primitive containing the convergence entry is immutable in its dot frame.
      // Its authored start belongs to the retained fragment too.
      const start = input.entry.primitive;
      out[start] = { ...out[start], values: out[start].values.map((v, j) => j >= out[start].values.length - 2 && j % 2 ? translated(cs[start].values[j], delta) : j >= out[start].values.length - 2 ? cs[start].values[j] : v) };
      for (let i = start + 1; i < cs.length; i++)
        out[i] = { ...cs[i], values: cs[i].values.map((v, j) => j % 2 ? translated(v, delta) : v) };
    }
    if (r.from.kind === 'junction') {
      const delta = affectedJoins.get(r.from.id) ?? 0;
      if (r.to.kind === 'node' && moves(b.nodes.get(r.to.id)!) === delta)
        for (let i = 0; i < cs.length; i++)
          out[i] = { ...cs[i], values: cs[i].values.map((v, j) => j % 2 ? translated(v, delta) : v) };
    }
    const unchanged = out.every((c, i) => c.kind === cs[i].kind && c.values.every((v, j) => Object.is(v, cs[i].values[j])));
    const raw = [...r.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
    if (raw.length !== cs.length)
      return null;
    routes.push(unchanged ? r : { ...r, path: out.map((c, i) => c.values.every((v, j) => Object.is(v, cs[i].values[j])) ? raw[i] : c.kind + c.values.join(' ') + ' ').join('') });
  }
  const rows = b.orientation !== 'down' ? b.rows : b.rows.map(row => { const ns = row.keys.flatMap(k => nodes.has(k) ? [nodes.get(k)!] : []); return ns.length ? { ...row, top: Math.min(...ns.map(n => n.y)), bottom: Math.max(...ns.map(n => n.y + n.height)) } : row; });
  const bottom = (ns: ReadonlyMap<string, PlacedNode>) => Math.max(0, ...[...ns.values()].map(n => n.y + n.height));
  return { ...b, nodes, junctions, routes, rows, height: translated(b.height, Math.max(0, bottom(nodes) - bottom(b.nodes))) };
}
