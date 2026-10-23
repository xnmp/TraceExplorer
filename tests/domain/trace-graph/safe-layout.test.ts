import {expect,it} from 'vitest';
import {safeLayout} from '$lib/domain/trace-graph/safe-layout';
import {geometryGate} from '$lib/domain/trace-graph/geometry-gate';
import {attachSingleBand} from '$lib/domain/trace-graph/band-geometry';
import {measure} from '$lib/domain/trace-graph/layout-quality';
it('draws a shared source channel once while preserving every output edge', () => {
  const items=Array.from({length:21},(_,i)=>({key:String(i),order:i,width:92,height:97,parents:i?['0']:[]}));
  const request={items,maxWidth:640,tileWidth:92,band:{key:'0',items},pinned:{key:'0',x:320}};
  const layout=attachSingleBand(safeLayout(request),request);
  expect(geometryGate(layout,items,'0',640)).toBeNull();
  const metrics=measure(layout,'0',640,items);
  expect(metrics.missingEdges).toBe(0);
  expect(metrics.disconnectedEdges).toBe(0);
  expect(metrics.length).toBeLessThan(7000);
});

// Slice 6 residue: why legacy serial rows stay in the band ladder. On a chain's
// first click the committed drawing is a cover over one left-aligned tile, which
// legacy rows reproduce and the centred serial embedding does not.
import {corpus,requestFor} from '../../../layout-eval/corpus';
import {optimizedBand} from '../../../layout-eval/engine';
import {ladderPins} from '$lib/domain/trace-graph/band-layout';
import {serialRowsEmbedding} from '$lib/domain/trace-graph/cold-embeddings';
it('keeps a first click\'s pins where the serial embedding does not (chain-8 at 454 px)', () => {
  const fixture={...corpus().find(c=>c.id==='chain-8')!,full:false};
  const first=optimizedBand(requestFor(fixture,null,454,96));
  const request={...requestFor(fixture,'n1',454,96),anchorKey:'n1',history:{signature:first.signature,layout:first.layout,placed:first.placed}};
  const pins=ladderPins(request);
  expect(pins.keys).toContain('n1');
  expect(geometryGate(attachSingleBand(safeLayout(request),request),request.items,request.band!.key,454)).toBeNull();
  expect(pins.held(safeLayout(request))).toBe(true);
  expect(pins.held(serialRowsEmbedding(request)!)).toBe(false);
});
