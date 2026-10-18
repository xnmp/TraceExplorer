/** Source-derived retained fragment equations. Free straight cores receive no pins. */
import type { GraphLayout } from './layout';
import { importRoutingPlan } from './routing-plan';
import { routingCoordinate, type RoutingFrameEquality } from './routing-problem';
import { isLayoutShape } from './history-boundary';
import { HintRoutingError, hintChanges, eligibleDescent, translatedBy } from './hint-routing-policy';
import { eachConsumer } from './route-consumers';
import { sameRoutingOwnership, chargeRoutingConsumers } from './routing-consumer-work';
import { chargeRoutingSnapshot } from './routing-problem';
import { ARROW } from './metrics';
export function declareHintRoutingFrame(before: GraphLayout, after: GraphLayout, charge: (n: number, s?: string) => void = () => { }, heights: ReadonlyMap<string, number> = new Map(), descend = false) {
  chargeRoutingSnapshot([before, after, heights], charge);
  if (!isLayoutShape(before) || !isLayoutShape(after) || typeof descend !== 'boolean')
    throw new HintRoutingError('hint frame shape', 'unsupported-input');
  const changes = hintChanges(before, heights);
  charge(before.routes.length + 1, 'hint certificate input table');
  const pathBytes = before.routes.reduce((sum, route) => sum + route.path.length, 0);
  const consumers = before.routes.reduce((sum, route) => sum + (Array.isArray(route.consumers) ? route.consumers.length : (route.consumers as {
    readonly end: number;
    readonly start: number;
  }).end - (route.consumers as {
    readonly end: number;
    readonly start: number;
  }).start), 0);
  charge(4 * pathBytes * (before.routes.length + 1) ** 2
    + 64 * pathBytes * (changes.size + 1)
    + 8 * (changes.size + before.junctions.size + 1) * (before.nodes.size + before.routes.length + consumers + 1) ** 2, 'finite hint certificate passes');
  const growing = [...changes].filter(([key, height]) => height > before.nodes.get(key)!.height).map(([key]) => before.nodes.get(key)!);
  const descent = (key: string) => {
    const node = before.nodes.get(key);
    if (!node)
      throw new HintRoutingError('unknown hint member', 'unsupported-input');
    return descend && eligibleDescent(node, growing) ? 16 : 0;
  };
  if (before.nodes.size !== after.nodes.size || before.junctions.size !== after.junctions.size || before.routes.length !== after.routes.length)
    throw new HintRoutingError('hint membership changed');
  const dotDescent = (key: string) => Math.max(0, ...before.routes.filter(r => [r.from, r.to].some(e => e.kind === 'junction' && e.id === key)).flatMap(r => [...eachConsumer(r)].map(c => descent(c.child))));
  const source = (r: GraphLayout['routes'][number]) => JSON.stringify([r.from.kind, r.from.id]);
  const cuts = growing.map(tile => ({ y: tile.y + tile.height, sources: new Set(before.routes.filter(r => [...eachConsumer(r)].some(c => [c.parent, c.child].some(key => key === tile.key || descend && eligibleDescent(before.nodes.get(key)!, [tile])))).map(source)) }));
  chargeRoutingConsumers(before, charge);
  chargeRoutingConsumers(after, charge);
  const old = importRoutingPlan(before, charge), next = importRoutingPlan(after, charge), frames = new Map<string, RoutingFrameEquality>();
  const bind = (address: readonly (string | number)[], a: number, b: number, delta: number | readonly number[]) => {
    charge(10 + address.reduce((sum: number, part) => sum + (typeof part === 'string' ? part.length : 1), 0), 'hint retained frame binding');
    const operations: readonly number[] = typeof delta === 'number' ? delta ? [delta] : [] : delta.filter(n => n !== 0);
    const expected = translatedBy(a, operations);
    if (!Object.is(expected, b))
      throw new HintRoutingError('retained frame mismatch ' + JSON.stringify({ address, a, b, delta }));
    let current = a;
    const id = JSON.stringify(address), frame = { id, input: routingCoordinate('before', ...address), output: routingCoordinate('derived', ...address), steps: operations.map(operand => { current += operand; return { operation: 'add' as const, operand, result: current }; }) };
    const prior = frames.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(frame))
      throw new HintRoutingError('contradictory retained recipes');
    frames.set(id, frame);
  };
  const point = (address: readonly (string | number)[], a: {
    x: number;
    y: number;
  }, b: {
    x: number;
    y: number;
  }, delta: number | readonly number[]) => { bind([...address, 'x'], a.x, b.x, 0); bind([...address, 'y'], a.y, b.y, delta); };
  const equation = (input: readonly (string | number)[], output: readonly (string | number)[], initial: number, result: number, operations: readonly {
    operation: 'add' | 'subtract';
    operand: number;
  }[]) => {
    charge(12 + 3 * operations.length + [...input, ...output].reduce((sum: number, part) => sum + (typeof part === 'string' ? part.length : 1), 0), 'ordered owner port equation');
    let value = initial;
    const steps = operations.map(operation => { value = operation.operation === 'add' ? value + operation.operand : value - operation.operand; return { ...operation, result: value }; });
    if (!Object.is(value, result))
      throw new HintRoutingError('ordered owner port equation mismatch');
    const id = JSON.stringify(['owner-port', input, output]);
    frames.set(id, { id, input: routingCoordinate('before', ...input), output: routingCoordinate('derived', ...output), steps });
  };
  const ownedPort = (port: typeof old.ports[number], nextPort: typeof old.ports[number], raw: {
    x: number;
    y: number;
  }, rawAddress: readonly (string | number)[], recipe: readonly number[]) => {
    if (port.owner.kind !== 'tile')
      throw new HintRoutingError('owner port kind');
    const owner = after.nodes.get(port.owner.id)!;
    const additions = recipe.filter(operand => operand !== 0).map(operand => ({ operation: 'add' as const, operand }));
    const horizontal = port.side === 'top' || port.side === 'bottom';
    const axis = horizontal ? 'x' : 'y', origin = owner[axis];
    const operations = [...(horizontal ? [] : additions), { operation: 'subtract' as const, operand: origin }];
    equation([...rawAddress, axis], ['port', port.id, 'offset'], raw[axis], nextPort.offset, operations);
    equation([...rawAddress, axis], ['port', port.id, 'point', axis], raw[axis], nextPort.point[axis], [...operations, { operation: 'add', operand: origin }]);
    const other = horizontal ? 'y' : 'x', oldOwner = before.nodes.get(port.owner.id)!;
    const ownerOperations: {
      operation: 'add' | 'subtract';
      operand: number;
    }[] = [];
    if (horizontal && descent(port.owner.id))
      ownerOperations.push({ operation: 'add', operand: descent(port.owner.id) });
    if (port.side === 'bottom' || port.side === 'right')
      ownerOperations.push({ operation: 'add', operand: horizontal ? owner.height : owner.width });
    equation(['tile', port.owner.id, other], ['port', port.id, 'point', other], oldOwner[other], nextPort.point[other], ownerOperations);
  };
  for (const [k, n] of before.nodes) {
    const a = after.nodes.get(k);
    if (!a)
      throw new HintRoutingError('lost tile');
    const dy = descent(k);
    point(['tile', k], n, a, dy);
    bind(['tile', k, 'width'], n.width, a.width, 0);
    const height = changes.get(k) ?? n.height;
    if (!Object.is(a.height, height))
      throw new HintRoutingError('undeclared hint height');
    bind(['tile', k, 'height'], n.height, a.height, height - n.height);
  }
  for (const [k, j] of before.junctions) {
    const a = after.junctions.get(k);
    if (!a)
      throw new HintRoutingError('lost dot');
    if (JSON.stringify(j.parents) !== JSON.stringify(a.parents))
      throw new HintRoutingError('painted dot declaration changed');
    point(['dot', k], j, a, dotDescent(k));
  }
  for (const p of old.paths) {
    const a = next.paths.find(q => q.id === p.id);
    if (!a)
      throw new HintRoutingError('lost route');
    const oldRoute = p.route!, newRoute = a.route!;
    if (!sameRoutingOwnership(oldRoute, newRoute, charge))
      throw new HintRoutingError('retained route declaration changed');
    const oldStart = old.ports.find(port => port.id === p.start)!, newStart = next.ports.find(port => port.id === a.start)!;
    const oldEnd = old.ports.find(port => port.id === p.end)!, newEnd = next.ports.find(port => port.id === a.end)!;
    for (const [u, v] of [[oldStart, newStart], [oldEnd, newEnd]])
      if (u.owner.kind !== v.owner.kind || u.owner.id !== v.owner.id || u.side !== v.side)
        throw new HintRoutingError('retained semantic port changed');
    const rawBefore = [...p.route!.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]), rawAfter = [...a.route!.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
    const primitive = (i: number, delta: number | readonly number[]) => {
      const u = p.native[i], v = a.native[i];
      if (!u || !v || u.length !== v.length)
        throw new HintRoutingError('native identity');
      for (let j = 0; j < u.length; j++)
        point(['path', p.id, 'native', i, j], u[j], v[j], delta);
      if ((typeof delta === 'number' ? delta === 0 : delta.every(n => n === 0)) && rawBefore[i + 1] !== rawAfter[i + 1])
        throw new HintRoutingError('retained raw primitive reserialized');
    };
    const sourceOwner = p.route!.from.kind === 'node' ? before.nodes.get(p.route!.from.id) : undefined;
    const sourceHeightDelta = sourceOwner ? (changes.get(sourceOwner.key) ?? sourceOwner.height) - sourceOwner.height : 0;
    const sourceRecipe = sourceOwner ? [descent(sourceOwner.key), oldStart.side === 'bottom' ? sourceHeightDelta
        : oldStart.side === 'left' || oldStart.side === 'right' ? sourceHeightDelta / 2 : 0] : [];
    const prefixCurves = new Set<number>();
    if (oldStart.owner.kind === 'tile') {
      const head = p.native[0][0];
      for (let i = 0; i < p.native.length; i++) {
        if (p.native[i].length === 4)
          prefixCurves.add(i);
        const end = p.native[i].at(-1)!;
        if (Math.abs(end.x - head.x) > 6 || Math.abs(end.y - head.y) > 6)
          break;
      }
    }
    // Derive every curve recipe from its declared source/dot/column frame.
    for (let i = 0; i < p.native.length; i++)
      if (p.native[i].length === 4) {

        const join = old.meetings?.find(m => m.inputs.some(input => input.path === p.id && i >= input.entry.primitive));
        const shift = (y: number) => descend && cuts.some(c => c.sources.has(source(p.route!)) && y >= c.y) ? 16 : 0;
        const recipe = join ? [dotDescent(join.id)] : prefixCurves.has(i) ? sourceRecipe : [Math.max(...p.native[i].map(q => shift(q.y)))];
        primitive(i, recipe);
      }
    if (oldStart.owner.kind === 'junction') {
      const shift = descend && cuts.some(c => c.sources.has(source(p.route!)) && oldStart.point.y >= c.y) ? 16 : 0;
      const delta = p.route!.from.kind === 'junction' && oldStart.owner.id === p.route!.from.id ? dotDescent(p.route!.from.id) : shift;
      point(['port', oldStart.id, 'point'], oldStart.point, newStart.point, delta);
      point(['path', p.id, 'native', 0, 0], p.native[0][0], a.native[0][0], delta);
    }
    const from = p.route!.from;
    if (from.kind === 'node') {
      const tile = before.nodes.get(from.id)!, head = p.native[0][0];
      if (oldStart.owner.kind === 'tile') {
        const shifted = after.nodes.get(from.id)!, dh = shifted.height - tile.height;
        const delta = sourceRecipe;
        ownedPort(oldStart, newStart, head, ['path', p.id, 'native', 0, 0], delta);
        const inside = (q: {
          x: number;
          y: number;
        }) => Math.abs(q.x - head.x) <= 6 && Math.abs(q.y - head.y) <= 6;
        for (let i = 0; i < p.native.length; i++) {
          const run = p.native[i], last = run.at(-1)!;
          if (run.length === 4 || inside(last)) {
            primitive(i, delta);

            if (!inside(last))
              break;
            continue;
          }
          // A straight primitive can cross the semantic departure berth. Only its
          // exact in-berth interval is retained; its distant endpoint is free core.
          const first = run[0], other = a.native[i];
          if (run.length !== 2 || other.length !== 2)
            throw new HintRoutingError('prefix primitive shape');
          const axis = first.x === last.x ? 'y' : first.y === last.y ? 'x' : null;
          if (!axis)
            throw new HintRoutingError('nonorthogonal source prefix');
          const value = head[axis] + Math.sign(last[axis] - first[axis]) * 6;
          const boundary = { ...first, [axis]: value }, held = { x: boundary.x, y: translatedBy(boundary.y, delta) };
          point(['path', p.id, 'native', i, 0], first, other[0], delta);
          const [u, v] = other;
          if (axis === 'x' ? (held.y !== u.y || held.y !== v.y || held.x < Math.min(u.x, v.x) || held.x > Math.max(u.x, v.x)) : (held.x !== u.x || held.x !== v.x || held.y < Math.min(u.y, v.y) || held.y > Math.max(u.y, v.y)))
            throw new HintRoutingError('lost exact departure interval');

          break;
        }
      }
    }
    if (p.stub) {
      const u = old.stubs.find(s => s.id === p.stub)!, v = next.stubs.find(s => s.id === p.stub)!;
      if (!v)
        throw new HintRoutingError('lost terminal arrow');
      const target = p.route!.to;
      if (target.kind !== 'node')
        throw new HintRoutingError('terminal owner');
      const n = before.nodes.get(target.id)!, m = after.nodes.get(target.id)!;
      const dh = m.height - n.height;
      const delta = [descent(target.id), oldEnd.side === 'bottom' ? dh : oldEnd.side === 'left' || oldEnd.side === 'right' ? dh / 2 : 0];
      ownedPort(oldEnd, newEnd, u.tip, ['stub', u.id, 'tip'], delta);
      point(['stub', u.id, 'base'], u.base, v.base, delta);
      point(['stub', u.id, 'tip'], u.tip, v.tip, delta);
      for (let i = 0; i < 2; i++)
        point(['stub', u.id, 'shaft', i], u.shaft[i], v.shaft[i], delta);
      let length = 0;
      for (let i = p.native.length - 1; i >= 0; i--) {
        const run = p.native[i];
        if (run.length !== 2) break;
        length += Math.hypot(run[1].x - run[0].x, run[1].y - run[0].y);
        if (length > ARROW.length) break;
        primitive(i, delta);
      }
    }
    for (const meeting of old.meetings ?? [])
      for (const input of meeting.inputs)
        if (input.path === p.id) {
          const changed = next.meetings?.find(m => m.id === meeting.id)?.inputs.find(i => i.path === p.id && i.source === input.source);
          if (!changed || changed.entry.side !== input.entry.side || changed.entry.primitive !== input.entry.primitive || !Object.is(changed.entry.parameter, input.entry.parameter))
            throw new HintRoutingError('changed convergence entry');
          const delta = dotDescent(meeting.id);
          for (let i = input.entry.primitive; i < p.native.length; i++) {
            primitive(i, delta);

          }
          const address = ['meeting', meeting.id, 'input', p.id, input.source];
          bind([...address, 'primitive'], input.entry.primitive, changed.entry.primitive, 0);
          bind([...address, 'parameter'], input.entry.parameter, changed.entry.parameter, 0);
          point([...address, 'point'], input.entry.point, changed.entry.point, delta);
          const inputPort = old.ports.find(port => port.id === input.port)!, nextPort = next.ports.find(port => port.id === changed.port)!;
          point(['port', inputPort.id, 'point'], inputPort.point, nextPort.point, delta);
        }
    if (oldEnd.owner.kind === 'junction') {
      // A native carrier can end at a virtual branch port rather than a painted
      // dot. Its exact endpoint follows its declared native or column recipe.
      const last = p.native.length - 1, end = p.native[last].length - 1;
      const native = frames.get(JSON.stringify(['path', p.id, 'native', last, end, 'y']));
      const column = descend && cuts.some(c => c.sources.has(source(oldRoute)) && oldEnd.point.y >= c.y) ? 16 : 0;
      const recipe = oldRoute.to.kind === 'junction' ? [dotDescent(oldRoute.to.id)]
        : native ? native.steps.map(step => step.operation === 'add' ? step.operand : -step.operand) : [column];
      point(['port', oldEnd.id, 'point'], oldEnd.point, newEnd.point, recipe);
    }
  }
  return [...frames.values()];
}
