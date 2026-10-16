import type { JunctionPlan, Junction, Route, Endpoint } from './junctions';

/** Factor wide meetings into balanced groups of at most four inputs before routing. */
export function boundedJunctions(plan: JunctionPlan, maxInputs: 2 | 4 = 4): JunctionPlan {
  const joins: Junction[] = [], spines: Route[] = [];
  const replacements = new Map<Route, Route>();
  const byId = new Map(plan.joins.map(j => [j.id,j]));
  const incoming = new Map<string, Route[]>();
  for (const route of plan.routes) {
    if (route.to.kind === 'junction') { const list = incoming.get(route.to.id) ?? []; list.push(route); incoming.set(route.to.id,list); }
  }
  for (const [ordinal, join] of plan.joins.entries()) {
    const inputs = incoming.get(join.id) ?? [];
    if (inputs.length <= maxInputs) { joins.push(join); continue; }
    let serial = 0;
    const build = (list: readonly Route[], id: string): { end: Endpoint; parents: readonly string[]; consumers: Route['consumers'] } => {
      const end: Endpoint = {kind:'junction',id};
      const pieces: Route[][] = [];
      for (let start = 0, groups = Math.min(maxInputs, list.length); groups > 0; groups--) {
        const end = start + Math.ceil((list.length - start) / groups);
        pieces.push(list.slice(start, end)); start = end;
      }
      const inputs: Endpoint[] = [], parents: string[] = [], consumers: Route['consumers'][number][] = [];
      for (const piece of pieces) {
        if (piece.length === 1) {
          const route = piece[0]; inputs.push(route.from); replacements.set(route, {...route,to:end});
          parents.push(...(route.from.kind === 'node' ? [route.from.id] : byId.get(route.from.id)!.parents));
          consumers.push(...route.consumers);
        } else {
          // Original IDs start with j:, so this namespace is disjoint. An ordinal
          // avoids copying the complete parent-set identity into every subtree.
          const child = build(piece,JSON.stringify(['bounded-join',ordinal,serial++]));
          inputs.push(child.end); parents.push(...child.parents); consumers.push(...child.consumers);
          spines.push({from:child.end,to:end,consumers:child.consumers});
        }
      }
      parents.sort(); joins.push({id,parents,inputs});
      return {end,parents,consumers};
    };
    build(inputs,join.id);
  }
  return {joins,routes:[...plan.routes.map(route => replacements.get(route) ?? route), ...spines]};
}
