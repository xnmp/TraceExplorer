/** Narrow-pane alternative: accumulate meeting inputs as soon as they arrive. */
import { endpointKey, type Endpoint, type Junction, type JunctionPlan, type Route } from './junctions';
import type { ConsumerSet } from './route-consumers';

export type SharedRoute = Omit<Route, 'consumers'> & { readonly consumers: ConsumerSet };
export interface SharedJunctionPlan { readonly joins: readonly Junction[]; readonly routes: readonly SharedRoute[] }

export function streamingJunctions(plan: JunctionPlan, arrivalRank: ReadonlyMap<string, number>): SharedJunctionPlan {
  const joins: Junction[] = [], spines: SharedRoute[] = [], replacements = new Map<Route, SharedRoute>();
  const byId = new Map(plan.joins.map(join => [join.id, join]));
  const incoming = new Map<string, Route[]>();
  for (const route of plan.routes) if (route.to.kind === 'junction') {
    const list = incoming.get(route.to.id) ?? []; list.push(route); incoming.set(route.to.id, list);
  }
  for (const [ordinal, join] of plan.joins.entries()) {
    const inputs = [...(incoming.get(join.id) ?? [])].sort((a, b) => arrivalRank.get(endpointKey(a.from))! - arrivalRank.get(endpointKey(b.from))!);
    if (inputs.length <= 2) { joins.push(join); continue; }
    // All prefix consumers refer to this one table, including the trunk geometry.
    const entries = inputs.flatMap(route => route.consumers);
    let previous: Endpoint = inputs[0].from, end = inputs[0].consumers.length;
    const accumulated = [...(previous.kind === 'node' ? [previous.id] : byId.get(previous.id)!.parents)];
    for (let i = 1; i < inputs.length; i++) {
      const id = i === inputs.length - 1 ? join.id : JSON.stringify(['streaming-join', ordinal, i]);
      const target: Endpoint = { kind: 'junction', id }, input = inputs[i];
      if (i === 1) replacements.set(inputs[0], { ...inputs[0], to: target });
      else spines.push({ from: previous, to: target, consumers: { entries, start: 0, end } });
      replacements.set(input, { ...input, to: target });
      accumulated.push(...(input.from.kind === 'node' ? [input.from.id] : byId.get(input.from.id)!.parents));
      // Junction tooltips require the complete parent list. This output metadata
      // grows with the explicit left-deep drawing; edge consumers remain shared.
      joins.push({ id, inputs: [previous, input.from], parents: [...accumulated].sort() });
      end += input.consumers.length; previous = target;
    }
  }
  return { joins, routes: [...plan.routes.map(route => replacements.get(route) ?? route), ...spines] };
}
