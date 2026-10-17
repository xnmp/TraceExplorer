import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('lays out every tile of a large finite chain within bounded geometry', () => {
  const result = spawnSync('bun', ['-e', `
    import { layoutGraph } from './src/lib/domain/trace-graph/layout';
    import { attachSingleBand } from './src/lib/domain/trace-graph/band-geometry';
    import { geometryGate } from './src/lib/domain/trace-graph/geometry-gate';
    const items=Array.from({length:43},(_,i)=>({key:String(i),order:i,width:100000,height:100000,parents:i?[String(i-1)]:[]}));
    const request={items,maxWidth:100000,tileWidth:92,band:{key:'0',items},pinned:{key:'0',x:50000}};
    const raw=layoutGraph(request), result=attachSingleBand(raw,request);
    console.log(JSON.stringify({count:result.nodes.size, gate:geometryGate(result,items,'0',request.maxWidth), cover:result.nodes.get('0'), width:result.width,height:result.height}));
  `], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.count).toBe(43);
  expect(output.gate).toBeNull();
  expect(output.cover).toMatchObject({ x: 0, y: 0, width: 100000, height: 100000 });
  expect(Math.max(output.width, output.height)).toBeLessThan(1_000_000);
}, 6000);

import { safeChain } from '$lib/domain/trace-graph/safe-chain';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';

it.each([2, 3, 7, 16, 43, 100])('keeps all %i unequal chain tiles and routes without crossings', count => {
  const items = Array.from({ length: count }, (_, i) => ({ key: String(i), order: count - i, width: 92 + (i % 3) * 16, height: 97 + (i % 4) * 16, parents: i ? [String(i - 1)] : [] }));
  const request = { items, maxWidth: 640, tileWidth: 92, band: { key: '0', items }, pinned: { key: '0', x: 320 } };
  const raw = safeChain(request)!;
  expect(raw).not.toBeNull();
  expect(raw.width).toBeLessThanOrEqual(request.maxWidth);
  const result = attachSingleBand(raw, request);
  expect(geometryGate(result, items, '0', 640)).toBeNull();
  expect(measure(result, '0', 640, items).crossings).toBe(0);
  expect(result.nodes.size).toBe(count);
  expect(result.nodes.get('0')).toMatchObject({ x: 274, y: 0 });
  expect(safeChain({ ...request, items: [...items].reverse() })).toEqual(raw);
});

it('declines branching or cyclic graphs instead of dropping their nodes', () => {
  const items = [{ key: 'root', width: 92, height: 97, order: 0, parents: [] },
    { key: 'a', width: 92, height: 97, order: 1, parents: ['root'] }, { key: 'b', width: 92, height: 97, order: 2, parents: ['root'] }];
  expect(safeChain({ items, maxWidth: 640, band: { key: 'root', items } })).toBeNull();
  const cycle = items.map(n => ({ ...n, parents: n.key === 'root' ? ['b'] : n.key === 'b' ? ['a'] : n.parents }));
  expect(safeChain({ items: cycle, maxWidth: 640, band: { key: 'root', items: cycle } })).toBeNull();
});
