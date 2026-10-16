import { expect, it } from 'vitest';
import { layoutLayered, downwardBandBound } from '$lib/domain/trace-graph/layout';
import { attachSingleBand, withBandBounds } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('sizes orthogonal channel clearance for strokes independently of thumbnail width', () => {
  const items = Array.from({length:3},(_,i)=>({key:String(i),parents:i?[String(i-1)]:[],width:140,height:128,order:i}));
  const request = {items,maxWidth:454,tileWidth:140,band:{key:'0',items}};
  const layout = layoutLayered({...request,band:undefined,orientation:'down'}, {channelStyle:'orthogonal'});
  const a=layout.nodes.get('1')!, b=layout.nodes.get('2')!;
  expect(b.y-a.y-a.height).toBe(22);
  const placed=attachSingleBand(withBandBounds(layout,'0'),request);
  expect(geometryGate(placed,items,'0',454)).toBeNull();
  const bound=downwardBandBound(request,'0',34,{channelStyle:'orthogonal'})!;
  expect(bound.height).toBeLessThanOrEqual(placed.height);
});
