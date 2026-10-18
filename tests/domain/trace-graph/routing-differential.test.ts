import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { packedGridFlow, bandPlacements } from '$lib/domain/trace-graph/band-geometry';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { importRoutingPlan } from '$lib/domain/trace-graph/routing-plan';
import { eachConsumer } from '$lib/domain/trace-graph/route-consumers';
import { corpus, requestFor, node } from '../../../layout-eval/corpus';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { folderInput, makeFolder } from './folder-layout-fixtures';
import { sourcesReaching } from './fixtures';

it('preserves exact provenance and native port contracts across the existing corpus and channel scopes',()=>{
  // Keep slice 1's complete 195-drawing population; slice 3 intentionally changes
  // its coordinates, so verify the semantic/native contract instead of old bytes.
  for(const c of corpus()) for(const width of [360,640,1000]) {
    const request=requestFor(c,null,width,48),drawing=layoutLayered(request);
    expect(new Set(drawing.nodes.keys())).toEqual(new Set(request.items.map(item=>item.key)));
    for(const item of request.items) expect(sourcesReaching(drawing,item.key),`${c.id}/${width}/${item.key}`)
      .toEqual(new Set(item.parents.filter(parent=>drawing.nodes.has(parent))));
    const expected=new Set(request.items.flatMap(item=>item.parents.filter(parent=>drawing.nodes.has(parent))
      .map(parent=>JSON.stringify([parent,item.key]))));
    const actual=new Set(drawing.routes.flatMap(route=>[...eachConsumer(route)].map(({parent,child})=>JSON.stringify([parent,child]))));
    expect(actual,`${c.id}/${width} consumer coverage`).toEqual(expected);
    expect(()=>importRoutingPlan(structuredClone(drawing))).not.toThrow();
  }
},20000);

it('preserves cold attachment, packing and corridor bytes outside retained channels', () => {
  // Unmodified 6768262: 63 cold packing states, including wrapped shared headers.
  const hash = createHash('sha256');
  for (let count = 1; count <= 7; count++) for (const columns of [1, 3, 7]) for (const width of [90, 140, 300]) {
    const items = Array.from({ length: count }, (_, i) => ({ id: `g${i}`, kind: 'stack' as const }));
    const flow = packedGridFlow(items, new Map(items.map(({ id }, i) => [id, { width, height: 80 + i * 13 }])),
      columns, { cellWidth: 100, cellHeight: 100, columnGap: 10, rowGap: 10 });
    hash.update(JSON.stringify([flow, bandPlacements(flow, 100)], (_, value) => value instanceof Map ? [...value] : value));
  }
  expect(hash.digest('hex')).toBe('6eb4484fa650409026121bbfa296678eff305e0cd5504feb6054a241102f8ee2');
});

it('leaves port conflicts and multiple bypasses byte-identical instead of adopting incomplete pins', () => {
  // Unmodified 6768262 outputs for the independent review's scope counterexamples.
  const hash = createHash('sha256'), tile = tileMetrics();
  for (const [width, count] of [[550, 2], [600, 3], [700, 4]]) {
    const folder = makeFolder({ stacks: Array.from({ length: count }, (_, j) => [node('root'),
      ...Array.from({ length: j ? 20 : 2 }, (_, i) => node(`f${i}`, ['root'], i + 1))]) });
    const ids = [...folder.stacks.keys()], options = { width, tile, grid: fallbackGridMetrics(tile) }, engine = createDefaultEngine();
    const previous = engine(folderInput(folder, { ...options, open: [ids[0]] }));
    const after = engine(folderInput(folder, { ...options, open: ids, previous }));
    expect(after.decision?.fallback).toBeUndefined();
    hash.update(JSON.stringify(after, (_, value) => value instanceof Map || value instanceof Set ? [...value] : value));
  }
  expect(hash.digest('hex')).toBe('d2362a9cff0b7129b9728efacbda43e8485dd08c20ffea57d6b159e41fe3d293');
});
