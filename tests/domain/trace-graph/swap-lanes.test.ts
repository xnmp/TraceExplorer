import { it, expect } from 'vitest';
import { node, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph, type GraphLayout, type PlacedRoute } from '$lib/domain/trace-graph/layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-layout';
import { sharedLaneLength } from '$lib/domain/trace-graph/layout-quality';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderInput, makeFolder } from './folder-layout-fixtures';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';

const nodes = [
  node('root'), node('n1',['root'],1), node('n2',['n1'],2),
  node('n3',['n1','root','n2'],3), node('n4',['n2','root'],4),
  node('n5',['n4','n1'],5), node('n6',['n5','n2'],6), node('n7',['n3'],7),
  node('n8',['n6'],8), node('n9',['root','n8','n1'],9), node('n10',['n1'],10),
  node('n12',['n10','n5','n9'],12), node('n13',['n6','n9','n7'],13),
  node('n14',['n10'],14), node('n16',['n1','n8','n14'],16),
];

// Read only exact straight SVG L segments, independently of the production flattener/metric.
function verticalRuns(route: PlacedRoute) {
  const out:{x:number,top:number,bottom:number}[]=[];
  let x=NaN,y=NaN;
  for(const match of route.path.matchAll(/([MLC])([^MLC]*)/g)) {
    const values=match[2].match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)!.map(Number);
    const arity=match[1]==='C'?6:2;
    for(let i=0;i<values.length;i+=arity) {
      const ex=values[i+arity-2],ey=values[i+arity-1];
      if(match[1]==='L' && Math.abs(x-ex)<1e-6 && y!==ey)out.push({x,top:Math.min(y,ey),bottom:Math.max(y,ey)});
      x=ex;y=ey;
    }
  }
  return out;
}


function expectSeparateStems(layout: GraphLayout) {
  const conflicts: unknown[] = [];
  for (let i = 0; i < layout.routes.length; i++) for (let j = i + 1; j < layout.routes.length; j++) {
    const a = layout.routes[i], b = layout.routes[j];
    if (a.from.kind === b.from.kind && a.from.id === b.from.id) continue;
    const sameJoin = a.to.kind === 'junction' && b.to.kind === 'junction' && a.to.id === b.to.id;
    for (const s of verticalRuns(a)) for (const t of verticalRuns(b)) {
      const distance = Math.abs(s.x - t.x), length = Math.min(s.bottom, t.bottom) - Math.max(s.top, t.top);
      if ((distance < 1e-6 && length > 1e-6) || (!sameJoin && distance < 2.99 && length > 8)) conflicts.push({ a: a.id, b: b.id, distance, length });
    }
  }
  expect(conflicts).toEqual([]);
  expect(sharedLaneLength(layout)).toBe(0);
}

it('separates swapping band stems without moving the clicked tile', () => {
  const request = requestFor({ id: 'swap-stems', nodes, focuses: [], full: true }, null, 900, 128);
  const raw = layoutGraph(request), drawn = attachSingleBand(raw, request);
  expectSeparateStems(drawn);
  // The tile after the affected channel keeps its pre-fix position: routing must not displace it.

  const clicked = layoutGraph({ ...request, anchorKey: 'n5', history: { signature: bandHistorySignature(request), layout: raw, placed: drawn } });
  expect([...clicked.nodes]).toEqual([...raw.nodes]);
  expectSeparateStems(attachSingleBand(clicked, request));
});

it('keeps folder fan-in stems clear of swapping routes at 928 px without moving the clicked tile', () => {
  const stack=[node('root'),node('n1',['root'],1),node('n2',['n1'],2),node('n3',['n2'],3),node('n4',['n3'],4),
    node('n5',['n4','n1','n2'],5),node('n6',['n3','n5'],6),node('n7',['n3'],7),node('n8',['n5','n6','n2','n1'],8),
    node('n9',['n5'],9),node('n10',['n7'],10),node('n11',['n7'],11),node('n12',['n6','root'],12),node('n13',['n9'],13),node('n17',['n1'],17)];
  const folder=makeFolder({stacks:[stack],files:5});
  const input=folderInput(folder,{open:['s0:root'],width:928,tile:tileMetrics(128),expansion:{choices:new Map(stack.map(n=>[`s0:${n.key}`,true])),reveals:[]}});
  const items=[input.items[1],input.items[0],...input.items.slice(2)], request={...input,items};

  const engine = createDefaultEngine(), result = engine(request), graph = result.graphs.get('s0:root')!;
  expectSeparateStems(graph.attached);
  const tile = graph.attached.nodes.get('s0:n3')!;

  const clicked = engine({ ...request, previous: result, open: new Map([...request.open].map(([id, stack]) => [id, { ...stack, anchor: 's0:n3' }])) }).graphs.get('s0:root')!;
  expect([...clicked.attached.nodes]).toEqual([...graph.attached.nodes]);
  expectSeparateStems(clicked.attached);
});
