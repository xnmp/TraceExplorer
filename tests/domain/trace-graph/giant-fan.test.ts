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
