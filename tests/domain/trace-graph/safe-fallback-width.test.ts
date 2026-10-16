import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { safeLayout } from '$lib/domain/trace-graph/safe-layout';
import { safeColumns } from '$lib/domain/trace-graph/safe-columns';
import { safeChain } from '$lib/domain/trace-graph/safe-chain';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';

it.each(['fan-30','random-dag-100-8103','random-dag-200-9102'])('wraps safe constructions within the pane, including pinned covers: %s', id => {
  const fixture = corpus().find(c=>c.id===id)!;
  for (const width of [360,640]) for (const position of ['left','middle','right'] as const) {
    const initial=requestFor(fixture,fixture.focuses.at(-1)??null,width,96);
    const half=initial.items.find(n=>n.key===initial.band!.key)!.width/2;
    const request={...initial,pinned:{key:initial.band!.key,x:position==='left'?half:position==='right'?width-half:width/2}};
    for (const construct of [safeLayout,safeColumns]) {
      const raw=construct(request), layout=attachSingleBand(raw,request);
      expect(raw.width).toBeLessThanOrEqual(width);
      expect(measure(layout,request.band!.key,width,request.items).overflow).toBe(0);
      expect(geometryGate(layout,request.items,request.band!.key,width)).toBeNull();
      expect(raw.nodes.get(request.band!.key)!.x).toBe(request.pinned.x-half);
    }
  }
},30_000);

it('does not reserve unused padding beyond a chain cover pinned to the pane edge', () => {
  const fixture=corpus().find(c=>c.id==='chain-20')!;
  const initial=requestFor(fixture,'n19',360,96), half=initial.items[0].width/2;
  const request={...initial,pinned:{key:initial.band!.key,x:360-half}};
  expect(safeChain(request)!.width).toBeLessThanOrEqual(360);
});

it('retires a wide merge frontier by joining parents before placing its output', () => {
  const inputs = Array.from({length:100}, (_,i)=>({key:`p${i}`,order:i+1,width:96,height:96,parents:['root']}));
  const items=[{key:'root',order:0,width:96,height:96,parents:[]},...inputs,{key:'out',order:101,width:96,height:96,parents:inputs.map(n=>n.key)}];
  const request={items,maxWidth:360,band:{key:'root',items},pinned:{key:'root',x:180}};
  const raw=safeLayout(request);
  expect(raw.width).toBeLessThanOrEqual(360);
  expect(geometryGate(attachSingleBand(raw,request),items,'root',360)).toBeNull();
});

it('uses a single vertical column when a chain tile fits but standard gutters do not', () => {
  const items=Array.from({length:10},(_,i)=>({key:String(i),order:i,width:100,height:100,parents:i?[String(i-1)]:[]}));
  const request={items,maxWidth:120,band:{key:'0',items},pinned:{key:'0',x:60}};
  const raw=safeChain(request)!;
  expect(raw.width).toBeLessThanOrEqual(120);
  expect(geometryGate(attachSingleBand(raw,request),items,'0',120)).toBeNull();
});

it.each([16,32,100].flatMap(count => [true,false].map(padded => ({count,padded}))))('streams $count merge inputs with padded=$padded within the pane capacity', ({count,padded}) => {
  const inputs=Array.from({length:count},(_,i)=>({key:`p${padded?String(i).padStart(3,'0'):i}`,order:i+1,width:96,height:96,parents:['root']}));
  const items=[{key:'root',order:0,width:96,height:96,parents:[]},...inputs,{key:'out',order:count+1,width:96,height:96,parents:inputs.map(n=>n.key)}];
  const request={items,maxWidth:108,band:{key:'root',items},pinned:{key:'root',x:54}};
  const raw=safeLayout(request);
  expect(raw.width).toBeLessThanOrEqual(108);
  const attached=attachSingleBand(raw,request);
  expect(geometryGate(attached,items,'root',108)).toBeNull();
  expect(measure(attached,'root',108,items).overflow).toBe(0);
  const tables=new Set(raw.routes.map(r=>Array.isArray(r.consumers)?r.consumers:(r.consumers as {entries:readonly unknown[]}).entries));
  expect([...tables].reduce((sum,entries)=>sum+entries.length,0)).toBeLessThanOrEqual(count*8);
});
