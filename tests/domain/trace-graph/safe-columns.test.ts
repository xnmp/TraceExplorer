import {expect,it} from 'vitest';
import {safeColumns} from '$lib/domain/trace-graph/safe-columns';
import {geometryGate} from '$lib/domain/trace-graph/geometry-gate';
import {attachSingleBand} from '$lib/domain/trace-graph/band-geometry';
import {measure} from '$lib/domain/trace-graph/layout-quality';
it('draws a shared source channel once while preserving every output edge', () => {
  const items=Array.from({length:21},(_,i)=>({key:String(i),order:i,width:92,height:97,parents:i?['0']:[]}));
  const request={items,maxWidth:640,tileWidth:92,band:{key:'0',items},pinned:{key:'0',x:320}};
  const layout=attachSingleBand(safeColumns(request),request);
  expect(geometryGate(layout,items,'0',640)).toBeNull();
  const metrics=measure(layout,'0',640,items);
  expect(metrics.missingEdges).toBe(0);
  expect(metrics.disconnectedEdges).toBe(0);
  expect(metrics.length).toBeLessThan(7000);
});
