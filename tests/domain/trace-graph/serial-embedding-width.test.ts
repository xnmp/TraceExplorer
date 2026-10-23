// The embeddings the band ladder publishes ahead of the legacy rows, on the
// narrow-pane fixtures the legacy rows were written for (slice 6).
import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { serialRowsEmbedding, gridRowsEmbedding } from '$lib/domain/trace-graph/cold-embeddings';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';

it.each(['fan-30','random-dag-100-8103','random-dag-200-9102'])('certifies serial rows with the cover pinned anywhere in the pane: %s', id => {
  const fixture = corpus().find(c=>c.id===id)!;
  for (const width of [360,640]) for (const position of ['left','middle','right'] as const) {
    const initial=requestFor(fixture,fixture.focuses.at(-1)??null,width,96);
    const half=initial.items.find(n=>n.key===initial.band!.key)!.width/2;
    const request={...initial,pinned:{key:initial.band!.key,x:position==='left'?half:position==='right'?width-half:width/2}};
    {
      const raw=serialRowsEmbedding(request)!, layout=attachSingleBand(raw,request);
      // Serial rows keep standard lane spacing, so many live lanes can widen the
      // drawing beyond the pane (the deleted legacy rows packed 3 px lanes).
      expect(geometryGate(layout,request.items,request.band!.key,width)).toBeNull();
      expect(raw.nodes.get(request.band!.key)!.x).toBe(request.pinned.x-half);
    }
  }
},30_000);

it('certifies a wide merge frontier within a narrow pane', () => {
  const inputs = Array.from({length:100}, (_,i)=>({key:`p${i}`,order:i+1,width:96,height:96,parents:['root']}));
  const items=[{key:'root',order:0,width:96,height:96,parents:[]},...inputs,{key:'out',order:101,width:96,height:96,parents:inputs.map(n=>n.key)}];
  const request={items,maxWidth:360,band:{key:'root',items},pinned:{key:'root',x:180}};
  for (const raw of [gridRowsEmbedding(request)!, serialRowsEmbedding(request)!])
    expect(geometryGate(attachSingleBand(raw,request),items,'root',360)).toBeNull();
});

it.each([16,32,100].flatMap(count => [true,false].map(padded => ({count,padded}))))('certifies $count merge inputs with padded=$padded in a pane one tile wide', ({count,padded}) => {
  const inputs=Array.from({length:count},(_,i)=>({key:`p${padded?String(i).padStart(3,'0'):i}`,order:i+1,width:96,height:96,parents:['root']}));
  const items=[{key:'root',order:0,width:96,height:96,parents:[]},...inputs,{key:'out',order:count+1,width:96,height:96,parents:inputs.map(n=>n.key)}];
  const request={items,maxWidth:108,band:{key:'root',items},pinned:{key:'root',x:54}};
  const raw=serialRowsEmbedding(request)!;
  const attached=attachSingleBand(raw,request);
  expect(geometryGate(attached,items,'root',108)).toBeNull();
  const tables=new Set(raw.routes.map(r=>Array.isArray(r.consumers)?r.consumers:(r.consumers as {entries:readonly unknown[]}).entries));
  // Bounded meetings share consumer tables: O(n log n) entries, never a copy per input.
  expect([...tables].reduce((sum,entries)=>sum+entries.length,0)).toBeLessThanOrEqual(2*count*Math.log2(count));
});

