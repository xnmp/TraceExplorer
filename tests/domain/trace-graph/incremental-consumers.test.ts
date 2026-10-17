import { expect, it } from 'vitest';
import { serialize } from 'node:v8';
import { incrementalTree } from '$lib/domain/trace-graph/band-incremental';
import { routeConsumers } from '$lib/domain/trace-graph/route-consumers';
import type { GraphLayout, LayoutItem } from '$lib/domain/trace-graph/layout';

function merging(count: number) {
  const items: LayoutItem[] = Array.from({ length: count + 1 }, (_, i) => ({ key: i ? `p${i}` : 'root', order: i, width: 92, height: 97, parents: [] }));
  const previous: GraphLayout = {
    nodes: new Map(items.map((n, i) => [n.key, { ...n, x: 24 + 120 * i, y: i ? 200 : 0, row: i ? 1 : 0, band: i ? 1 : 0 }])),
    routes: [], junctions: new Map(), rows: [], readingOrder: new Map(items.map((n, i) => [n.key, i])),
    width: 120 * (count + 2), height: 320, orientation: 'down',
  };
  const next = [...items, { key: 'child', order: 100, width: 92, height: 97, parents: items.slice(1).map(n => n.key) }];
  const result = incrementalTree({ items: next, maxWidth: previous.width, band: { key: 'root', items: next } }, previous);
  expect(result).not.toBeNull();
  return result!;
}

it('keeps incremental merge annotations proportional to parent count in worker serialization', () => {
  const bytes = (count: number) => serialize(merging(count).routes.map(r => r.consumers)).byteLength;
  expect(bytes(16) / bytes(8)).toBeLessThan(2.8);
});

it('highlights the complete source-to-output path for each parent after worker cloning', () => {
  const layout = structuredClone(merging(8));
  for (let i = 1; i <= 8; i++) {
    const parent = `p${i}`;
    const highlighted = layout.routes.filter(r => routeConsumers(r).some(c => c.parent === parent && c.child === 'child'));
    let endpoint = { kind: 'node', id: parent };
    const visited = new Set<string>();
    while (endpoint.id !== 'child') {
      const next = highlighted.find(r => r.from.kind === endpoint.kind && r.from.id === endpoint.id);
      expect(next, `path from ${parent} reaches ${endpoint.id}`).toBeDefined();
      expect(visited.has(next!.id)).toBe(false);
      visited.add(next!.id);
      endpoint = next!.to;
    }
    expect(visited.size).toBe(highlighted.length);
  }
});
