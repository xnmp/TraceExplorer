import type { GraphLayout, LayoutItem, PlacedNode } from './layout';

/** Greedy routing may fill an earlier hole with a later sibling. Assign interchangeable
 * new leaf identities to those slots in reading order after routing. Retained tiles,
 * geometry and shared consumer tables are untouched. Single-parent leaves have one
 * independent incoming route; equal dimensions and future-port needs make slots equivalent. */
export function orderNewSiblingLeaves(layout: GraphLayout, items: readonly LayoutItem[], retained: ReadonlyMap<string,PlacedNode>, futureSources: ReadonlySet<string>): GraphLayout {
  const parents=new Set(items.flatMap(n=>n.parents));
  const incoming=new Map(layout.routes.filter(r=>r.terminal && r.from.kind==='node' && r.to.kind==='node' &&
    Array.isArray(r.consumers) && r.consumers.length===1 && r.consumers[0].parent===r.from.id && r.consumers[0].child===r.to.id &&
    r.id===JSON.stringify(['incremental',r.from.id,r.to.id])).map(r=>[r.to.id,r]));
  const groups=new Map<string,LayoutItem[]>();
  for(const item of items) {
    if(retained.has(item.key) || parents.has(item.key) || item.parents.length!==1 || !incoming.has(item.key) || !layout.nodes.has(item.key)) continue;
    const signature=JSON.stringify([item.parents[0],item.width,item.height,futureSources.has(item.key)]);
    const group=groups.get(signature);
    if(group) group.push(item); else groups.set(signature,[item]);
  }
  const rename=new Map<string,string>(),slots=new Map<string,PlacedNode>();
  for(const group of groups.values()) {
    group.sort((a,b)=>a.order-b.order || a.key.localeCompare(b.key));
    const ordered=group.map(n=>layout.nodes.get(n.key)!).sort((a,b)=>layout.orientation==='right'
      ? a.row-b.row || a.x-b.x || a.y-b.y : a.y-b.y || a.x-b.x);
    group.forEach((item,i)=>{if(item.key!==ordered[i].key) {rename.set(ordered[i].key,item.key);slots.set(item.key,ordered[i]);}});
  }
  if(!rename.size) return layout;
  return {...layout,
    nodes:new Map([...layout.nodes].map(([key,node])=>[key,slots.has(key)?{...slots.get(key)!,key}:node])),
    rows:layout.rows.map(row=>({...row,keys:row.keys.map(key=>rename.get(key)??key)})),
    routes:layout.routes.map(route=>{
      const child=route.to.kind==='node' ? rename.get(route.to.id) : undefined;
      if(!child || incoming.get(route.to.id)!==route) return route;
      return {...route,id:JSON.stringify(['incremental',route.from.id,child]),to:{...route.to,id:child},
        consumers:[{parent:route.from.id,child}]};
    }),
  };
}
