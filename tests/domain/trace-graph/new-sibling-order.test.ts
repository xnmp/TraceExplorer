import { expect, it } from 'vitest';
import { orderNewSiblingLeaves } from '$lib/domain/trace-graph/new-sibling-order';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { nodePenalties } from '../../../layout-eval/geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { readFileSync } from 'node:fs';
import { AUTOMATIC_ROUTING_WORK, automaticIncrementalBudget, constrainedBandInsertion } from '$lib/domain/trace-graph/band-incremental';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import type { GraphLayout, LayoutRequest } from '$lib/domain/trace-graph/layout';

it.each([['random-bushy-200-9202',360,96,3,1],['random-tree-100-8002',640,48,1,0]] as const)(
  'keeps newly revealed siblings in creation order in %s', (id,width,imagePx,target,limit) => {
    const fixture=corpus().find(c=>c.id===id)!;
    let previous:Optimized|undefined;
    for(const [step,focus] of fixture.focuses.entries()) {
      const request=requestFor(fixture,focus,width,imagePx);
      const next=optimizedBand(request,{previous,anchorKey:focus??undefined});
      if(step===target) {
        expect(nodePenalties(next.placed,request.band!.key,request.items).siblingInversions).toBeLessThanOrEqual(limit);
        expect(geometryGate(next.placed,request.items,request.band!.key,width)).toBeNull();
        break;
      }
      previous=next;
    }
  });

it('assigns interchangeable new leaves without moving geometry or retained identities', () => {
  const items=[['root',0,0],['retained',0,100],['early',200,100],['late',100,100],['future',50,100],['wide',350,100]].map(([key,x,y],order)=>({
    key:key as string,x:x as number,y:y as number,width:key==='wide'?100:80,height:80,order,parents:key==='root'?[]:['root'],row:key==='root'?0:1,band:0,
  }));
  const source:import('$lib/domain/trace-graph/layout').GraphLayout={orientation:'down',width:500,height:200,
    nodes:new Map(items.map(n=>[n.key,n])),junctions:new Map(),rows:[],readingOrder:new Map(items.map(n=>[n.key,n.order])),
    routes:items.filter(n=>n.parents.length).map(n=>({id:JSON.stringify(['incremental','root',n.key]),from:{kind:'node',id:'root'},to:{kind:'node',id:n.key},
      consumers:[{parent:'root',child:n.key}],terminal:true,path:`M40 80 L${n.x+40} 92`})),
  };
  const copy=structuredClone(source),retained=new Map(['root','retained'].map(key=>[key,source.nodes.get(key)!]));
  const result=orderNewSiblingLeaves(source,items,retained,new Set(['root','future']));
  expect(result.nodes.get('early')!.x).toBe(100);
  expect(result.nodes.get('late')!.x).toBe(200);
  for(const key of ['root','retained','future','wide']) expect(result.nodes.get(key)).toEqual(source.nodes.get(key));
  expect(result.routes.map(r=>r.path)).toEqual(source.routes.map(r=>r.path));
  expect(result.routes.find(r=>r.id===JSON.stringify(['incremental','root','early']))).toMatchObject({to:{kind:'node',id:'early'},consumers:[{parent:'root',child:'early'}],path:'M40 80 L140 92'});
  expect(source).toEqual(copy);
  const rectangles=(layout:typeof source)=>[...layout.nodes.values()].map(n=>[n.x,n.y,n.width,n.height].join(',')).sort();
  expect(rectangles(result)).toEqual(rectangles(source));
});

/** A captured tour click (18 new tiles) where no placement of one new tile keeps
 * creation order with its placed siblings and still routes. Order is a display
 * preference, so that tile is placed without it instead of the click falling
 * back to the legacy ladder. */
it('certifies an arrival whose creation order no routable placement satisfies', () => {
  const { request, previous } = JSON.parse(readFileSync(new URL('./fixtures/routing-adoption/sibling-order-relaxed.json', import.meta.url), 'utf8'),
    (_k, v) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v) as { request: LayoutRequest; previous: GraphLayout };
  const result = constrainedBandInsertion(request, previous, () => automaticIncrementalBudget(), AUTOMATIC_ROUTING_WORK);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict.constraints.slice(0, 3))).toBe(true);
  if (!result.ok) return;
  const published = attachSingleBand(structuredClone(result.drawing), request);
  expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
  for (const { key } of request.items) if (previous.nodes.has(key)) expect(published.nodes.get(key), key).toEqual(previous.nodes.get(key));
  expect(request.items.filter(({ key }) => !published.nodes.has(key))).toEqual([]);
}, 60_000);
