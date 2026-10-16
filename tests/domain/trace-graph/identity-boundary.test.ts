import { expect, it } from 'vitest';
import { buildInputJunctions } from '$lib/domain/trace-graph/junctions';
import { orderLayers } from '$lib/domain/trace-graph/layer-order';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { spawnSync } from 'node:child_process';

it('preserves distinct edges whose node IDs contain endpoint delimiters', () => {
  const edges = [{ child: 'b>node:c', parents: ['a'] }, { child: 'c', parents: ['a>node:b'] }];
  const plan = buildInputJunctions(edges);
  expect(plan.routes.map(r => [r.from.id, r.to.id]).sort()).toEqual([['a', 'b>node:c'], ['a>node:b', 'c']]);
  const items = ['a', 'a>node:b', 'b>node:c', 'c'].map((key, order) => ({ key, order, width: 92, height: 81, parents: edges.find(e => e.child === key)?.parents ?? [] }));
  const result = layoutLayered({ items, maxWidth: 640 });
  expect(new Set(result.routes.map(r => r.id)).size).toBe(result.routes.length);
  expect(result.routes.filter(r => r.terminal).map(r => [r.from.id, r.to.id]).sort()).toEqual([['a', 'b>node:c'], ['a>node:b', 'c']]);
});

it('keeps NUL-prefixed real nodes even when long edges introduce virtual nodes', () => {
  const layers = [['root'], ['\0virtual:0', '\0child'], ['leaf']];
  expect(orderLayers({ layers, parents: key => key === 'root' ? [] : ['root'], rank: () => 0 }).flat().sort()).toEqual(layers.flat().sort());
});

it('plans a large sparse two-parent chain within a bounded process', () => {
  const result = spawnSync('bun', ['-e', `import { buildInputJunctions } from './src/lib/domain/trace-graph/junctions';
    const rows = Array.from({length: 16000}, (_, i) => ({ child: String(i), parents: i < 2 ? [] : [String(i-1), String(i-2)] }));
    const plan = buildInputJunctions(rows); console.log(plan.joins.length, plan.routes.length);`], { timeout: 4000, encoding: 'utf8', killSignal: 'SIGKILL' });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stdout.trim()).toBe('15998 47994');
}, 6000);

it('keeps serialized trunk annotations proportional to a sparse graph', async () => {
  const { serialize } = await import('node:v8');
  const bytes = (count: number) => {
    const items = Array.from({ length: count }, (_, i) => ({ key: String(i), order: i, width: 92, height: 81, parents: i ? i === 1 ? ['0'] : ['0', String(i - 1)] : [] }));
    const layout = layoutLayered({ items, maxWidth: 640 });
    return serialize(layout.routes).byteLength;
  };
  expect(bytes(800) / bytes(400)).toBeLessThan(2.8);
});
