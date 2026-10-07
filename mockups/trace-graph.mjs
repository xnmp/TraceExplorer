// Pure graph rules shared by the offline mockup and its contract checks.
export const selectionContext = (nodes, selected) => {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(selected)) return {large: new Set(), related: new Set()};
  const children = new Map(nodes.map(node => [node.id, []]));
  nodes.forEach(node => node.parents.forEach(parent => children.get(parent)?.push(node.id)));
  const walk = next => {
    const seen = new Set([selected]); const pending = [selected];
    while (pending.length) for (const id of next(pending.pop())) if (!seen.has(id)) { seen.add(id); pending.push(id); }
    return seen;
  };
  const ancestors = walk(id => byId.get(id)?.parents || []);
  const descendants = walk(id => children.get(id) || []);
  return {
    large: new Set([selected, ...byId.get(selected).parents, ...children.get(selected)]),
    related: new Set([...ancestors, ...descendants])
  };
};

const normalizeRelationships = rows => {
  if (!Array.isArray(rows)) throw new TypeError('Relationships must be an array');
  const normalized = new Map();
  for (const row of rows) {
    if (!row || typeof row.child !== 'string' || !row.child || !Array.isArray(row.parents) || row.parents.some(p => typeof p !== 'string' || !p)) throw new TypeError('Each relationship needs a child ID and parent IDs');
    const parents = [...new Set(row.parents)].sort();
    const previous = normalized.get(row.child);
    if (previous && JSON.stringify(previous) !== JSON.stringify(parents)) throw new Error('A child cannot have conflicting parent sets');
    normalized.set(row.child, parents);
  }
  const nodes = new Set([...normalized.keys(), ...[...normalized.values()].flat()]);
  const degrees = new Map([...nodes].map(id => [id, normalized.get(id)?.length || 0]));
  const children = new Map([...nodes].map(id => [id, []]));
  normalized.forEach((parents, child) => parents.forEach(parent => children.get(parent).push(child)));
  const ready = [...nodes].filter(id => degrees.get(id) === 0); let count = 0;
  for (let i = 0; i < ready.length; i++) {
    count++;
    children.get(ready[i]).forEach(child => { const degree = degrees.get(child) - 1; degrees.set(child, degree); if (degree === 0) ready.push(child); });
  }
  if (count !== nodes.size) throw new Error('Provenance must be acyclic');
  return [...normalized].sort(([a],[b]) => a.localeCompare(b)).map(([child, parents]) => ({child, parents}));
};

export const buildInputJunctions = relationships => {
  const rows = normalizeRelationships(relationships);
  const key = ids => JSON.stringify(ids);
  const fullSets = new Map(rows.filter(row => row.parents.length > 1).map(row => [key(row.parents), row.parents]));
  const sets = [...fullSets.values()];
  const intersections = new Map();
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const other = new Set(sets[j]); const shared = sets[i].filter(parent => other.has(parent));
    if (shared.length > 1 && !fullSets.has(key(shared))) intersections.set(key(shared), shared);
  }
  const support = ids => rows.filter(row => ids.every(id => row.parents.includes(id))).length;
  // Only an optimization is capped. Every complete parent set is always retained.
  const useful = [...intersections.values()].sort((a,b) => (b.length - 1) * support(b) - (a.length - 1) * support(a) || key(a).localeCompare(key(b))).slice(0,128);
  const allSets = [...new Map([...fullSets, ...useful.map(ids => [key(ids),ids])]).values()].sort((a,b) => a.length - b.length || key(a).localeCompare(key(b)));
  const joins = [];
  const bySet = new Map();
  for (const parents of allSets) {
    const remaining = new Set(parents); const inputs = [];
    // Disjoint smaller groups partition this input set; overlapping alternatives
    // are never both reused within one join, avoiding duplicate/false input paths.
    const candidates = joins.filter(join => join.parents.length < parents.length && join.parents.every(p => remaining.has(p))).sort((a,b) => b.parents.length - a.parents.length || support(b.parents) - support(a.parents) || key(a.parents).localeCompare(key(b.parents)));
    for (const candidate of candidates) if (candidate.parents.every(p => remaining.has(p))) {
      inputs.push({kind:'junction', id:candidate.id}); candidate.parents.forEach(p => remaining.delete(p));
    }
    inputs.push(...[...remaining].map(id => ({kind:'node', id})));
    const join = {id:`j${joins.length}`, parents, inputs}; joins.push(join); bySet.set(key(parents),join);
  }
  const byJoin = new Map(joins.map(join => [join.id, join]));
  const routes = new Map(); const used = new Set();
  const endpointKey = end => `${end.kind}:${JSON.stringify(end.id)}`;
  const edgeKey = (from,to) => `${endpointKey(from)}>${endpointKey(to)}`;
  const visit = (input, child, downstream) => {
    if (input.kind === 'node') {
      for (const edge of downstream) {
        const id = edgeKey(edge.from,edge.to); const route = routes.get(id) || {...edge, consumers: new Map()};
        route.consumers.set(JSON.stringify([input.id,child]),{parent:input.id,child}); routes.set(id,route);
      }
      return;
    }
    used.add(input.id);
    for (const source of byJoin.get(input.id).inputs) visit(source,child,[{from:source,to:input},...downstream]);
  };
  for (const row of rows) {
    if (!row.parents.length) continue;
    const input = row.parents.length === 1 ? {kind:'node',id:row.parents[0]} : {kind:'junction',id:bySet.get(key(row.parents)).id};
    visit(input,row.child,[{from:input,to:{kind:'node',id:row.child}}]);
  }
  return {
    joins: joins.filter(join => used.has(join.id)),
    routes: [...routes.values()].map(route => ({...route, consumers:[...route.consumers.values()]}))
  };
};
