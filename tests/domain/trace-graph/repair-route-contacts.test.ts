import { expect, it } from 'vitest';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedRoute } from '$lib/domain/trace-graph/layout';
import { repairRouteContacts } from '$lib/domain/trace-graph/repair-route-contacts';
import { segments } from '$lib/domain/trace-graph/layout-quality';

function fixture(arrow: boolean): { layout: GraphLayout; request: LayoutRequest } {
  const coordinates = arrow ? [['a',40,0],['b',140,0],['a-out',40,100],['b-out',140,180]] as const
    : [['a',40,0],['b',140,0],['a-out',42,180],['b-out',140,180]] as const;
  const items: LayoutItem[] = coordinates.map(([key], order) => ({key, order, width:20,height:20,parents:key.endsWith('-out')?[key.slice(0,1)]:[]}));
  const route = (id:string,path:string): PlacedRoute => ({id,path,from:{kind:'node',id},to:{kind:'node',id:id+'-out'},terminal:true,consumers:[{parent:id,child:id+'-out'}]});
  const layout: GraphLayout = {orientation:'down',width:200,height:220,rows:[],readingOrder:new Map(items.map(n=>[n.key,n.order])),junctions:new Map(),
    nodes:new Map(coordinates.map(([key,x,y],row)=>[key,{key,x,y,width:20,height:20,row,band:0}])),
    routes:arrow?[route('a','M50 20 L50 92'),route('b','M150 20 L150 98 L30 98 L30 140 L150 140 L150 172')]
      :[route('a','M50 20 L50 100 L52 100 L52 172'),route('b','M150 20 L150 100 L54 100 L54 105 L150 105 L150 172')]};
  return {layout,request:{items,maxWidth:200,tileWidth:20,band:{key:'a',items}}};
}

for (const arrow of [false,true]) it(`repairs ${arrow?'an arrow-tip contact':'a short dogleg contact'} with pinned tiles and route endpoints`,()=>{
  const {layout,request}=fixture(arrow),before=structuredClone(layout);
  expect(geometryGate(layout,request.items,'a',200)).toBe('route-contact');
  const repaired=repairRouteContacts(layout,request);
  expect(repaired).not.toBeNull();
  expect(geometryGate(repaired!,request.items,'a',200)).toBeNull();
  expect(repaired!.nodes).toEqual(before.nodes);
  expect(repaired!.junctions).toEqual(before.junctions);
  expect(repaired!.routes.map(({path,...route})=>route)).toEqual(before.routes.map(({path,...route})=>route));
  expect(repaired!.routes.map(r=>[segments(r.path)[0][0],segments(r.path).at(-1)![1]]))
    .toEqual(before.routes.map(r=>[segments(r.path)[0][0],segments(r.path).at(-1)![1]]));
  expect(layout).toEqual(before);
});

it('does not admit an unrepaired fixed terminal contact',()=>{
  const {layout,request}=fixture(true);
  const blocked={...layout,routes:[layout.routes[0],{...layout.routes[1],path:'M150 20 L150 98 L50 98'}]};
  expect(repairRouteContacts(blocked,request)).toBeNull();
});

it('keeps the clicked n24 tile when a reveal introduces short doglegs beside retained routes', async()=>{
  const {corpus,requestFor}=await import('../../../layout-eval/corpus');
  const {optimizedBand}=await import('../../../layout-eval/engine');
  const fixture={...corpus().find(c=>c.id==='random-dag-40-7503')!,full:false};
  let previous: ReturnType<typeof optimizedBand> | undefined;
  for (const focus of [null,'n18','n21','n28','n26','n34','n17','n20','n24']) {
    const request=requestFor(fixture,focus,454,96);
    const next=optimizedBand({...request,hint:previous?.layout.readingOrder},{previous,anchorKey:focus??undefined});
    if(focus==='n24') {
      expect(next.placed.nodes.get(focus)).toMatchObject({x:previous!.placed.nodes.get(focus)!.x,y:previous!.placed.nodes.get(focus)!.y});
      expect(geometryGate(next.placed,request.items,request.band!.key,request.maxWidth)).toBeNull();
    }
    previous=next;
  }
});
