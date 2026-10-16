import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('keeps all 44 huge fan-out tiles within the index reach without throwing', () => {
  const child = spawnSync('bun', ['-e', `
    import {layoutGraph} from './src/lib/domain/trace-graph/layout';
    import {attachSingleBand} from './src/lib/domain/trace-graph/band-geometry';
    import {geometryGate} from './src/lib/domain/trace-graph/geometry-gate';
    const items=Array.from({length:44},(_,i)=>({key:'n'+i,width:100000,height:100000,order:i,parents:i?['n0']:[]}));
    const request={items,band:{key:'n0',items},maxWidth:900,tileWidth:100000};
    const raw=layoutGraph(request), placed=attachSingleBand(raw,request);
    console.log(JSON.stringify({size:placed.nodes.size,gate:geometryGate(placed,items,'n0',900),width:placed.width,height:placed.height}));
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.size).toBe(44);
  expect(result.gate).toBeNull();
  expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(4194304);
}, 6000);

import { safeFanGrid } from '$lib/domain/trace-graph/safe-grid';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it.each([1, 2, 7, 43, 100])('preserves all %i unequal fan tiles and parent edges under permutation', count => {
  const items = Array.from({ length: count }, (_, i) => ({ key: String(i), order: count - i,
    width: 92 + i % 3 * 16, height: 97 + i % 4 * 16, parents: i ? ['0'] : [] }));
  const request = { items, band: { key: '0', items }, maxWidth: 640, tileWidth: 92, pinned: { key: '0', x: 320 } };
  const raw = safeFanGrid(request)!;
  expect(raw).not.toBeNull();
  const placed = attachSingleBand(raw, request);
  expect(placed.nodes.size).toBe(count);
  expect(placed.routes).toHaveLength(count - 1);
  expect(geometryGate(placed, items, '0', 640)).toBeNull();
  expect(safeFanGrid({ ...request, items: [...items].reverse() })).toEqual(raw);
});

it('declines a non-fan graph without dropping descendants', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ key: String(i), order: i, width: 92, height: 97, parents: i ? [String(i - 1)] : [] }));
  expect(safeFanGrid({ items, band: { key: '0', items }, maxWidth: 640 })).toBeNull();
});
