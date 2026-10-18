import { expectFolderArrivalPinned } from './folder-arrival-contract';
import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { corpusNode as node, makeFolder, folderInput } from './folder-layout-fixtures';
import { rng } from '../../../layout-eval/corpus';

it.each(Array.from({ length: 20 }, (_, index) => index + 1))('preserves every retained rect across multi-parent arrivals (seed %i)', (seed) => {
  const random = rng(seed), nodes = [node('root')], engine = createDefaultEngine();
  let previous: FolderLayout | undefined;
  for (let i = 0; i < 12; i++) {
    if (i) {
      const parents = nodes.filter(() => random() < .25).map(n => n.key);
      if (!parents.length) parents.push(nodes[Math.floor(random() * nodes.length)].key);
      nodes.push(node(`n${i}`, parents, i));
    }
    const folder = makeFolder({ stacks: [nodes], files: 2 });
    const base = folderInput(folder, { open: ['s0:root'], width: 360, tile: tileMetrics(64), previous });
    const input = { ...base, open: new Map([...base.open].map(([id, stack]) => [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
    const next = engine(input);
    expect(folderGeometryGate(next), `arrival ${i}`).toBeNull();
    if (previous) expectFolderArrivalPinned(previous, next);
    if (seed === 12 && i === 10) {
      // Free the new parent's departure by moving straight connector tails;
      // curved attachment headers and logical route identities remain intact.
      const before = previous!.graphs.get('s0:root')!.attached;
      const after = next.graphs.get('s0:root')!.attached;
      const curves = (path: string) => [...path.matchAll(/C[^MLC]*/g)].map(match => match[0].trim());
      const curved = before.routes.filter(route => curves(route.path).length);
      expect(curved.length).toBeGreaterThan(0);
      for (const route of curved) {
        const retained = after.routes.find(now => now.id === route.id)!;
        expect(retained).toBeDefined();
        expect([retained.from, retained.to]).toEqual([route.from, route.to]);
        expect(curves(retained.path)).toEqual(curves(route.path));
      }
    }
    previous = next;
  }
}, 30_000); // A budget fallback spends the constrained search's finite allowance before legacy runs.
