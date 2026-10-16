import { expect, it } from 'vitest';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import { layoutGraph, type GraphLayout } from '../../../src/lib/domain/trace-graph/layout';
import { validHistory } from '../../../src/lib/domain/trace-graph/history-boundary';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';

it.each(['missing', 'child'])('rejects a false source claim (%s), including retained history', source => {
  const items = [{key:'root',width:64,height:80,order:0,parents:[]}, {key:'child',width:64,height:80,order:1,parents:['root']}];
  const request = {items,maxWidth:900,tileWidth:64,band:{key:'root',items}};
  const original = layoutGraph(request);
  const corrupt = (layout: GraphLayout): GraphLayout => ({...layout,routes:layout.routes.map(r => ({...r,from:{kind:'node',id:source}}))});
  const layout = corrupt(original), placed = corrupt(attachSingleBand(original,request));
  expect(geometryGate(layout,items,'root',900)).not.toBeNull();
  expect(validHistory({signature:bandHistorySignature(request),layout,placed},'root')).toBe(false);
});

it('rejects a cubic through a tile between the old fixed samples', () => {
  const t=1/24,u=1-t,x=u*u*u*100+3*u*u*t*100+3*u*t*t*1000+t*t*t*1000,y=u*u*u*100+3*u*u*t*1000+3*u*t*t*1000+t*t*t*100;
  const nodes=[{key:'root',x:68,y:20,width:64,height:80},{key:'child',x:968,y:900,width:64,height:80},{key:'obstacle',x:x-1,y:y-1,width:2,height:2}].map(n=>({...n,row:0,band:0}));
  const items=nodes.map((n,i)=>({...n,order:i,parents:i===1?['root']:[]}));
  const layout: GraphLayout={nodes:new Map(nodes.map(n=>[n.key,n])),junctions:new Map(),routes:[{id:'r',from:{kind:'node',id:'root'},to:{kind:'node',id:'child'},terminal:true,consumers:[{parent:'root',child:'child'}],path:'M100 100 C100 1000 1000 1000 1000 100 L1000 892'}],rows:[],readingOrder:new Map(),width:1100,height:1000,orientation:'down'};
  expect(geometryGate(layout,items,'root',1100)).not.toBeNull();
});

import { node, requestFor } from '../../../layout-eval/corpus';
it('rejects an existing junction claimed as the origin of an input to that junction', () => {
  const request=requestFor({id:'claims',nodes:[node('root'),node('a',['root'],1),node('b',['root'],2),node('c',['a','b'],3)],focuses:[],full:true},null,900,64);
  const original=layoutGraph(request), junction=original.junctions.keys().next().value!;
  const routes=original.routes.map(r=>r.from.kind==='node' && r.from.id==='a' ? {...r,from:{kind:'junction' as const,id:junction}} : r);
  expect(geometryGate({...original,routes},request.items,'root',900)).not.toBeNull();
});
it('rejects an unrelated route touching the arrow base', () => {
  const nodes=[{key:'a',x:90,y:0},{key:'b',x:90,y:100},{key:'c',x:0,y:82},{key:'d',x:200,y:82}].map(n=>({...n,width:20,height:20,row:0,band:0}));
  const items=nodes.map(n=>({...n,order:0,parents:n.key==='b'?['a']:n.key==='d'?['c']:[]}));
  const routes=[['a','b','M100 20 L100 92'],['c','d','M20 92 L192 92']].map(([parent,child,path])=>({id:parent,from:{kind:'node' as const,id:parent},to:{kind:'node' as const,id:child},terminal:true,consumers:[{parent,child}],path}));
  const layout: GraphLayout={nodes:new Map(nodes.map(n=>[n.key,n])),junctions:new Map(),routes,rows:[],readingOrder:new Map(),width:220,height:120,orientation:'down'};
  expect(geometryGate(layout,items,'a',220)).not.toBeNull();
});
