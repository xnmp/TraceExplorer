/** New shared-source branches carry their exact authored source prefix. A branch
 * point alone does not carry the new edge's consumer membership back to a tile.
 * Retained routes and native command spans are never rewritten. */
import type { GraphLayout, PlacedNode, PlacedRoute } from './layout';
import { pathCommands, type Point } from './path-sampling';

type Charge = (work: number, reason?: string) => void;
export type SourcePrefixResult = { readonly ok: true; readonly drawing: GraphLayout }
  | { readonly ok: false; readonly conflict: { readonly reason: 'unsupported-input'; readonly constraints: readonly string[] } };
interface Carrier {
  readonly route: PlacedRoute;
  readonly raw: readonly string[];
  readonly points: readonly Point[];
  readonly kinds: readonly string[];
  readonly start: string;
}

const port = (node: PlacedNode, p: Point): boolean =>
  p.x === node.x + node.width / 2 && p.y === node.y + node.height
  || p.x === node.x + node.width && p.y === node.y + node.height / 2;
const scalar = (value: number): string => Object.is(value, -0) ? '-0' : String(value);

/** Authored endpoints and strict axis-aligned L interiors can be resolved
 * without splitting a cubic primitive. Unsupported native splits return witnesses. Every
 * parse, index visit and authored string copy debits the caller's shared ledger. */
export function materializeSourcePrefixes(drawing: GraphLayout, retained: ReadonlySet<string>, charge: Charge): SourcePrefixResult {
  const fail = (identity: string, detail: string): SourcePrefixResult => ({ ok: false,
    conflict: { reason: 'unsupported-input', constraints: ['authored source prefix', identity, detail] } });
  charge(drawing.routes.length + drawing.nodes.size, 'source-prefix scene scan');
  const carriers: Carrier[] = [];
  const waiting = new Map<string, Carrier[]>();
  const startsBySource = new Map<string, { readonly key:string; readonly point:Point }[]>();
  const targets = new Map<string, string>();
  const key = (source: string, point: Point): string => {
    charge(6 * source.length + 64, 'source-prefix endpoint key');
    return JSON.stringify([source, scalar(point.x), scalar(point.y)]);
  };
  for (const route of drawing.routes) {
    if (route.from.kind !== 'node') continue;
    const node = drawing.nodes.get(route.from.id);
    if (!node) return fail(route.id, 'missing source tile');
    charge(2 * route.path.length + 1, 'source-prefix native parse');
    const commands = pathCommands(route.path), raw = [...route.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
    if (!commands || !commands.length || commands.length !== raw.length) return fail(route.id, 'unsupported native path');
    charge(commands.length, 'source-prefix native endpoints');
    const points = commands.map(command => ({ x: command.values.at(-2)!, y: command.values.at(-1)! }));
    const start = key(route.from.id, points[0]);
    const record: Carrier = { route, raw, points, start, kinds:commands.map(command=>command.kind) };
    if(!waiting.has(start)){const starts=startsBySource.get(route.from.id)??[];starts.push({key:start,point:points[0]});startsBySource.set(route.from.id,starts);}
    carriers.push(record);
    const pending = waiting.get(start) ?? [];
    pending.push(record); waiting.set(start, pending);
    if (!retained.has(route.id) && !port(node, points[0])) targets.set(route.id, start);
  }
  if (!targets.size) return { ok: true, drawing };

  // Reachable starts form a source-local graph. Each route is expanded once;
  // cycles without an actual source port remain unreachable and are declined.
  const prefixes = new Map<string, string>();
  const queue: { readonly carrier: Carrier; readonly head: string }[] = [];
  const admitted = new Set<string>();
  for (const carrier of carriers) {
    charge(1, 'source-prefix port roots');
    if (port(drawing.nodes.get(carrier.route.from.id)!, carrier.points[0])) {
      admitted.add(carrier.route.id); queue.push({ carrier, head: '' });
    }
  }
  const expose = (endpoint:string, raw:string):void => {
    if(prefixes.has(endpoint))return;
    prefixes.set(endpoint,raw);
    const pending=waiting.get(endpoint)??[];
    charge(pending.length+1,'source-prefix reachable carriers');
    for(const next of pending)if(!admitted.has(next.route.id)){admitted.add(next.route.id);queue.push({carrier:next,head:raw});}
  };
  for (let at = 0; at < queue.length; at++) {
    const { carrier, head } = queue[at];
    let raw = head || carrier.raw[0];
    for (let i = 1; i < carrier.raw.length; i++) {
      const prior=raw;
      charge(raw.length+carrier.raw[i].length+1,'source-prefix authored span copy');
      raw+=carrier.raw[i];
      expose(key(carrier.route.from.id,carrier.points[i]),raw);
      if(carrier.kinds[i]!=='L')continue;
      const a=carrier.points[i-1],b=carrier.points[i];
      const vertical=a.x===b.x&&a.y!==b.y,horizontal=a.y===b.y&&a.x!==b.x;
      if(!vertical&&!horizontal)continue;
      const starts=startsBySource.get(carrier.route.from.id)??[];
      charge(8*starts.length+1,'source-prefix strict L interior scan');
      for(const candidate of starts){
        if(prefixes.has(candidate.key))continue;
        const p=candidate.point;
        if(!(vertical?p.x===a.x&&p.y>Math.min(a.y,b.y)&&p.y<Math.max(a.y,b.y):p.y===a.y&&p.x>Math.min(a.x,b.x)&&p.x<Math.max(a.x,b.x)))continue;
        charge(prior.length+64,'source-prefix partial L authored span');
        expose(candidate.key,prior+'L'+scalar(p.x)+' '+scalar(p.y));
      }
    }
  }
  const paths = new Map<string, string>();
  for (const carrier of carriers) {
    const target = targets.get(carrier.route.id);
    if (!target) continue;
    const head = prefixes.get(target);
    if (!head) return fail(carrier.route.id, 'no authored endpoint/L chain reaches a source port');
    charge(2 * carrier.raw.length + 1, 'source-prefix completed span scan');
    charge(head.length + carrier.raw.reduce((sum, raw) => sum + raw.length, 0), 'source-prefix completed path');
    paths.set(carrier.route.id, head + carrier.raw.slice(1).join(''));
  }
  charge(drawing.routes.length, 'source-prefix output routes');
  return { ok: true, drawing: { ...drawing,
    routes: drawing.routes.map(route => paths.has(route.id) ? { ...route, path: paths.get(route.id)! } : route) } };
}
