/** Evaluation candidates only. None meets the complete click/quality contract. */
/** State-only prefixes. No click order, selected key or previous presentation is consulted. */
import type { GraphLayout, LayoutItem, LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { attachSingleBand } from '../src/lib/domain/trace-graph/band-geometry';
import { incrementalBudget, incrementalTree, incrementalWorld } from '../src/lib/domain/trace-graph/band-incremental';
import { createBoundedCache, estimateLayoutBytes, type BoundedCache } from '../src/lib/domain/trace-graph/folder-layout/bounded-cache';
import { layoutSignature } from '../src/lib/domain/trace-graph/layout-signature';
import { geometryGate } from '../src/lib/domain/trace-graph/geometry-gate';
export type CanonicalOrder = 'depth' | 'preorder' | 'creation' | 'reverse' | 'depth-reverse' | 'frontier' | 'full-frontier';
export function canonicalPrefixes(request: LayoutRequest, order: CanonicalOrder = 'depth'): readonly (readonly LayoutItem[])[] {
  const full=request.band?.items??request.items, byKey=new Map(full.map(n=>[n.key,n]));
  const children=new Map<string,string[]>();
  for(const n of full) for(const p of n.parents) {const list=children.get(p)??[];list.push(n.key);children.set(p,list);}
  const stable=(a:string,b:string)=>(byKey.get(a)?.order??0)-(byKey.get(b)?.order??0)||a.localeCompare(b);
  for(const list of children.values()) list.sort(stable);
  const roots=full.filter(n=>!n.parents.some(p=>byKey.has(p))).map(n=>n.key).sort(stable);
  const depth=new Map<string,number>(),preorder=new Map<string,number>();
  const queue: (readonly [string,number])[]=roots.map(k=>[k,0]);
  for(let i=0;i<queue.length;i++){const [k,d]=queue[i];if(depth.has(k))continue;depth.set(k,d);for(const child of children.get(k)??[])queue.push([child,d+1]);}
  const pending=[...roots].reverse();
  while(pending.length){const k=pending.pop()!;if(preorder.has(k))continue;preorder.set(k,preorder.size);pending.push(...[...(children.get(k)??[])].reverse());}
  const ordered=[...request.items].sort((a,b)=>stable(a.key,b.key));
  const wanted=new Map(ordered.map(n=>[n.key,n])),shown=new Set<string>(),prefixes: LayoutItem[][]=[];
  const include=(keys:readonly string[])=>{const pending=[...keys];while(pending.length){const k=pending.pop()!;if(shown.has(k)||!wanted.has(k))continue;shown.add(k);pending.push(...wanted.get(k)!.parents);}};
  const save=()=>{const items=ordered.filter(n=>shown.has(n.key));if(items.length && items.length!==prefixes.at(-1)?.length){prefixes.push(items);}};
  include(roots);for(const root of roots)include(children.get(root)??[]);save();
  if(order==='full-frontier'){
    const available=new Set<string>(),todo:string[]=[];
    const reveal=(keys:readonly string[])=>{const pending=[...keys];while(pending.length){const k=pending.pop()!;if(available.has(k)||!byKey.has(k))continue;available.add(k);pending.push(...byKey.get(k)!.parents);}};
    reveal(roots);for(const root of roots)reveal(children.get(root)??[]);
    for(;;){const next=[...available].filter(k=>(children.get(k)??[]).some(c=>!available.has(c))).sort((a,b)=>-stable(a,b))[0];if(next===undefined)break;todo.push(next);reveal(children.get(next)??[]);}
    for(const key of todo){include(children.get(key)??[]);save();}include([...wanted.keys()]);save();return prefixes;
  }
  if(order==='frontier'){
    for(;;){const next=[...shown].filter(k=>(children.get(k)??[]).some(c=>wanted.has(c)&&!shown.has(c))).sort((a,b)=>-stable(a,b))[0];if(next===undefined)break;include(children.get(next)??[]);save(next);}
    include([...wanted.keys()]);save();return prefixes;
  }
  const branches=[...wanted.keys()].sort((a,b)=>order==='reverse'?-stable(a,b):order==='depth-reverse'?(depth.get(a)??Infinity)-(depth.get(b)??Infinity)||-stable(a,b):order==='creation'?stable(a,b):order==='preorder'?(preorder.get(a)??Infinity)-(preorder.get(b)??Infinity)||stable(a,b):(depth.get(a)??Infinity)-(depth.get(b)??Infinity)||stable(a,b));
  for(const key of branches){include([key]);include(children.get(key)??[]);save();}
  return prefixes;
}
const prefixCaches=new WeakMap<(r:LayoutRequest)=>GraphLayout,BoundedCache<GraphLayout>>();
export function canonicalExpansion(request: LayoutRequest, cold: (request:LayoutRequest)=>GraphLayout, order:CanonicalOrder='depth'): GraphLayout {
  const prefixes=canonicalPrefixes(request,order);
  let result:GraphLayout|undefined;
  let cache=prefixCaches.get(cold);if(!cache)prefixCaches.set(cold,cache=createBoundedCache(estimateLayoutBytes));
  const basis=layoutSignature({...request,items:[],history:undefined,hint:undefined,anchorKey:undefined});
  const prefixIds=prefixes.map(items=>items.map(n=>[n.key,n.width,n.height,n.order,n.parents]));
  const resultKey=JSON.stringify([order,basis,prefixIds]);
  const complete=cache.get(resultKey);if(complete)return complete;
  const path:unknown[]=[];
  for(const items of prefixes){
    const next={...request,items,hint:undefined,anchorKey:undefined,history:undefined};
    path.push(prefixIds[path.length]);const key=JSON.stringify([order,basis,path]);const known=cache.get(key);if(known){result=known;continue;}
    const previous=result && attachSingleBand(result,next);
    const budget=incrementalBudget();
    let pinned=previous && incrementalTree(next,previous,budget);
    if(previous && (!pinned || geometryGate(attachSingleBand(pinned,next),items,request.band!.key,request.maxWidth))){
      const world=incrementalWorld(next,previous,budget);
      if(world)pinned={...world,bandBounds:{left:0,width:request.maxWidth,top:world.nodes.get(request.band!.key)!.height+34},preferredX:0};
    }
    result=pinned && !geometryGate(attachSingleBand(pinned,next),items,request.band!.key,request.maxWidth)
      ? {...pinned,decision:{candidate:'canonical-insertion',stability:true}}
      : cold(next);
    cache.set(key,result);
  }
  return result??cold(request);
}

import { filterRouteConsumers } from '../src/lib/domain/trace-graph/route-consumers';
import { bandExtent } from '../src/lib/domain/trace-graph/band-geometry';
import { pathNumbers } from '../src/lib/domain/trace-graph/path-data';
import { spacingFor } from '../src/lib/domain/trace-graph/metrics';
export function projectCanonical(full:GraphLayout,request:LayoutRequest):GraphLayout {
  const keys=new Set(request.items.map(n=>n.key)),nodes=new Map([...full.nodes].filter(([k])=>keys.has(k)));
  const routes=filterRouteConsumers(full.routes,c=>keys.has(c.parent)&&keys.has(c.child));
  const joins=new Set(routes.flatMap(r=>[r.from,r.to].filter(e=>e.kind==='junction').map(e=>e.id)));
  const extent=bandExtent(full,request.band!.key);
  const bottom=Math.max(0,...[...nodes.values()].map(n=>n.y+n.height),...routes.flatMap(r=>pathNumbers(r.path).filter((_,i)=>i%2)));
  return {...full,nodes,routes,junctions:new Map([...full.junctions].filter(([k])=>joins.has(k))),height:bottom+spacingFor(request.tileWidth).bottom,
    bandBounds:{left:extent.left,width:extent.width,top:full.bandBounds?.top??Math.min(...[...full.nodes.values()].filter(n=>n.key!==request.band!.key).map(n=>n.y))},preferredX:extent.left,
    readingOrder:new Map([...full.readingOrder].filter(([k])=>keys.has(k))),decision:{...full.decision,candidate:'canonical-projection',stability:true}};
}
export function canonicalSkeleton(request:LayoutRequest,cold:(r:LayoutRequest)=>GraphLayout):GraphLayout {
  if (!request.items.length) return cold(request);
  const full=request.band!.items,parents=new Set(full.flatMap(n=>n.parents));
  const items=full.filter(n=>parents.has(n.key)||n.key===request.band!.key);
  const skeletonRequest={...request,items,history:undefined,hint:undefined,anchorKey:undefined};
  // Projection must receive the same attachment frame with and without visible leaves.
  const normalized = (layout: GraphLayout, input: LayoutRequest): GraphLayout => {
    const attached = attachSingleBand(layout, input);
    return { ...attached, bandBounds: { left: 0, width: attached.width,
      top: attached.nodes.get(request.band!.key)!.height + 34 }, preferredX: 0 };
  };
  const skeleton=normalized(cold(skeletonRequest),skeletonRequest);
  const union={...skeletonRequest,items:full.filter(n=>parents.has(n.key)||request.items.some(i=>i.key===n.key))};
  const result=union.items.length===items.length?skeleton:incrementalTree(union,skeleton);
  if(!result || geometryGate(attachSingleBand(result,union),union.items,request.band!.key,request.maxWidth))return projectCanonical(normalized(cold({...request,items:full}),request),request);
  return projectCanonical(result,request);
}

export function canonicalLayers(request:LayoutRequest,cold:(r:LayoutRequest)=>GraphLayout):GraphLayout {
 const full=request.band!.items,depth=new Map<string,number>();
 for(const n of full)depth.set(n.key,Math.max(0,...n.parents.map(k=>(depth.get(k)??-1)+1)));
 const limit=Math.max(0,...request.items.map(n=>depth.get(n.key)??0));
 const items=full.filter(n=>(depth.get(n.key)??0)<=limit);
 return projectCanonical(cold({...request,items}),request);
}
