import { expect, it } from 'vitest';
import { routeEnds, CORNER_BERTH } from '$lib/domain/trace-graph/route-contacts';
import type { PlacedRoute } from '$lib/domain/trace-graph/layout';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
it('reserves a junction trunk free end separately from its actual meeting dot', () => {
  const route: PlacedRoute = {id:'trunk',from:{kind:'junction',id:'j'},to:{kind:'junction',id:'j'},terminal:false,consumers:[],path:'M600 450 L615 467'};
  const segments = [[{x:600,y:450},{x:615,y:467}]] as const;
  expect(routeEnds(route,segments,new Map(),new Map([['j',{x:600,y:450}]]))).toEqual({start:0,end:CORNER_BERTH,arrow:false});
});
it('holds the clicked tile when insertion passes a retained junction trunk split', () => {
  const fixture={...corpus().find(c=>c.id==='random-dag-40-7502')!,full:false};
  let previous: Optimized | undefined, focus: string | null = null;
  const visited = new Set<string>();
  for(let step=0;step<=2;step++) {
    const request=requestFor(fixture,focus,900,96);
    const next=optimizedBand(request,{previous,anchorKey:focus??undefined});
    expect(geometryGate(next.placed,request.items,request.band!.key,900)).toBeNull();
    if(step===2) {
      expect(focus).toBe('n37');
      const a=previous!.placed.nodes.get(focus!)!, b=next.placed.nodes.get(focus!)!;
      expect([b.x,b.y]).toEqual([a.x,a.y]);
    }
    previous=next;
    const choices=request.items.filter(n=>!visited.has(n.key)&&request.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));
    focus=choices[0]?.key??null; if(focus) visited.add(focus);
  }
});
