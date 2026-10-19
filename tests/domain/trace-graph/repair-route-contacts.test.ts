import { expect, it } from 'vitest';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedRoute } from '$lib/domain/trace-graph/layout';
import { repairRouteContacts } from '$lib/domain/trace-graph/repair-route-contacts';
import { segments } from '$lib/domain/trace-graph/layout-quality';
import { pathCommands } from '$lib/domain/trace-graph/path-sampling';

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
  const repaired=repairRouteContacts(layout, request, 'band');
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
  expect(repairRouteContacts(blocked, request, 'band')).toBeNull();
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
}, 30_000);

it.each([false, true])('bypasses a mixed-curve run without diagonal shortcuts (redundant point: %s)', redundant => {
  const base=fixture(true),obstacle: LayoutItem={key:'obstacle',order:4,width:20,height:20,parents:[]};
  const items=[...base.request.items,obstacle],request={...base.request,items,band:{key:'a',items}};
  const curve='C150 25,150 35,150 40';
  const layout:GraphLayout={...base.layout,nodes:new Map([...base.layout.nodes,['obstacle',{key:'obstacle',x:110,y:70,width:20,height:20,row:4,band:0}]]),
    routes:[base.layout.routes[0],{...base.layout.routes[1],path:`M150 20 ${curve} L150 98 ${redundant ? 'L90 98 ' : ''}L30 98 L30 140 L150 140 L150 172`}]};
  const original=structuredClone(layout);
  expect(geometryGate(layout,items,'a',200)).toBe('route-contact');
  const repaired=repairRouteContacts(layout, request, 'band');
  expect(repaired).not.toBeNull();
  expect(geometryGate(repaired!,items,'a',200)).toBeNull();
  expect(repaired!.routes[1].path).toContain(curve);
  expect(repaired!.routes.every(route => {
    const commands = pathCommands(route.path)!;
    return commands.every((command, i) => command.kind !== 'L'
      || command.values[0] === commands[i - 1].values.at(-2) || command.values[1] === commands[i - 1].values.at(-1));
  })).toBe(true);
  expect(repaired!.routes.map(r=>r.path.match(/C[^MLC]*/g)?.map(c=>c.trim())??[]))
    .toEqual(original.routes.map(r=>r.path.match(/C[^MLC]*/g)?.map(c=>c.trim())??[]));
  expect(repaired!.nodes).toEqual(original.nodes);
  expect(repaired!.junctions).toEqual(original.junctions);
  expect(repaired!.routes.map(({path,...route})=>route)).toEqual(original.routes.map(({path,...route})=>route));
  expect(repaired!.routes.map(r=>[segments(r.path)[0][0],segments(r.path).at(-1)![1]]))
    .toEqual(original.routes.map(r=>[segments(r.path)[0][0],segments(r.path).at(-1)![1]]));
  expect(layout).toEqual(original);
});

function occupiedDeparture(blockBottom = false): {layout:GraphLayout;request:LayoutRequest} {
  const coordinates:[string,number,number,number,number][]=[['a',40,40,20,40],['b',52,0,20,20],['a-out',60,180,20,20],['b-out',100,180,20,20],['wall',72,35,20,80]];
  if(blockBottom)coordinates.push(['bottom-wall',40,82,20,20]);
  const items:LayoutItem[]=coordinates.map(([key,,,width,height],order)=>({key,width,height,order,parents:key.endsWith('-out')?[key.slice(0,1)]:[]}));
  const route=(id:string,path:string):PlacedRoute=>({id,path,from:{kind:'node',id},to:{kind:'node',id:id+'-out'},terminal:true,consumers:[{parent:id,child:id+'-out'}]});
  const layout:GraphLayout={orientation:'down',width:140,height:200,rows:[],readingOrder:new Map(items.map(n=>[n.key,n.order])),junctions:new Map(),
    nodes:new Map(coordinates.map(([key,x,y,width,height],row)=>[key,{key,x,y,width,height,row,band:0}])),
    routes:[route('a','M60 60 L70 60 L70 130 C70 140 70 150 70 160 L70 172'),route('b','M62 20 L62 120 L110 120 L110 172')]};
  return {layout,request:{items,maxWidth:140,tileWidth:20,band:{key:'a',items}}};
}

it('uses the other real source port when a fixed corridor blocks its departure',()=>{
  const {layout,request}=occupiedDeparture(),before=structuredClone(layout);
  expect(geometryGate(layout,request.items,'a',140)).toBe('route-contact');
  const repaired=repairRouteContacts(layout, request, 'band');
  expect(repaired).not.toBeNull();
  expect(geometryGate(repaired!,request.items,'a',140)).toBeNull();
  expect(segments(repaired!.routes[0].path)[0][0]).toEqual({x:50,y:80});
  expect(repaired!.routes[0].path).toContain('C70 140 70 150 70 160');
  expect(repaired!.routes.map(r=>segments(r.path).at(-1)![1])).toEqual(before.routes.map(r=>segments(r.path).at(-1)![1]));
  expect(repaired!.nodes).toEqual(before.nodes);
  expect(repaired!.junctions).toEqual(before.junctions);
  expect(repaired!.routes.map(({path,...route})=>route)).toEqual(before.routes.map(({path,...route})=>route));
  expect(layout).toEqual(before);
});

it('rejects a pinned drawing when both real source departures are blocked',()=>{
  const {layout,request}=occupiedDeparture(true);
  expect(geometryGate(layout,request.items,'a',140)).toBe('route-contact');
  expect(repairRouteContacts(layout, request, 'band')).toBeNull();
});

it('repairs a shared departure lane only when the complete pinned drawing clears the gate', () => {
  const { layout, request } = occupiedDeparture();
  const shared = { ...layout, routes: [layout.routes[0], { ...layout.routes[1],
    path: 'M62 20 L62 25 L70 25 L70 120 L110 120 L110 172' }] };
  const before = structuredClone(shared);
  expect(geometryGate(shared, request.items, 'a', 140)).toBe('shared-lane');
  const repaired = repairRouteContacts(shared, request, 'band');
  expect(repaired).not.toBeNull();
  expect(geometryGate(repaired!, request.items, 'a', 140)).toBeNull();
  expect(repaired!.nodes).toEqual(before.nodes);
  expect(repaired!.junctions).toEqual(before.junctions);
  expect(repaired!.routes.map(({ path, ...route }) => route)).toEqual(before.routes.map(({ path, ...route }) => route));
  expect(shared).toEqual(before);
});

it('does not replace an authored curved departure to switch source ports',()=>{
  const {layout,request}=occupiedDeparture();
  const curved={...layout,routes:[{...layout.routes[0],path:layout.routes[0].path.replace('L70 60','C63 60 67 60 70 60')},layout.routes[1]]};
  const before=structuredClone(curved);
  expect(geometryGate(curved,request.items,'a',140)).toBe('route-contact');
  expect(repairRouteContacts(curved, request, 'band')).toBeNull();
  expect(curved).toEqual(before);
});
