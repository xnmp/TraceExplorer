import { describe, expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { validHistory } from '$lib/domain/trace-graph/history-boundary';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-history';
import { corpusNode as node, makeFolder, folderInput, sourcesOf } from './folder-layout-fixtures';
import { buildFolderScene } from '$lib/domain/trace-graph/folder-scene';
import { posePath, settledPose, staticPresentation } from '$lib/plugins/trace/view/presentation';
import { expectFolderArrivalPinned } from './folder-arrival-contract';
import { rng } from '../../../layout-eval/corpus';
import type { TraceNode } from '$lib/domain/trace-graph/model';

const inputFor = (nodes: readonly TraceNode[], width: number, px: number, previous?: FolderLayout) => {
  const base = folderInput(makeFolder({ stacks: [nodes], files: 2 }), { open: ['s0:root'], width, tile: tileMetrics(px), previous });
  return { ...base, open: new Map([...base.open].map(([id, stack]) => [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
};

describe('folder packing as constraints (slice 5c)', () => {
  it('attaches a cover-only band as a drawing that contains its cover and is valid history', () => {
    const layout = createDefaultEngine()(inputFor([node('root')], 360, 96));
    const id = 's0:root', graph = layout.graphs.get(id)!, cell = layout.cells.get(id)!, band = layout.bands.find(b => b.id === id)!;
    const cover = graph.attached.nodes.get(id)!;
    expect(graph.attached.nodes.size).toBe(1);
    expect(graph.attached.height).toBeGreaterThanOrEqual(cover.y + cover.height);
    expect(validHistory({ signature: bandHistorySignature(graph.plan.request), layout: graph.layout, placed: graph.attached,
      attachment: { bandTop: band.y - cell.y, placement: graph.placement } }, id)).toBe(true);
  });

  it.each([[360, 96], [454, 96], [360, 64]])('keeps every cell and tile when a closed-row cover gains its first child (%i px, %i px tiles)', (width, px) => {
    const engine = createDefaultEngine(), nodes = [node('root')];
    const before = engine(inputFor(nodes, width, px));
    const after = engine(inputFor([...nodes, node('n1', ['root'], 1)], width, px, before));
    expect(folderGeometryGate(after)).toBeNull();
    expect(after.decision?.pinning).toBeUndefined();
    expectFolderArrivalPinned(before, after);
  });

  it('publishes a certified packed folder, never isolated rows, when a world-placed band cannot be continued', () => {
    // Seed 49 at 360 px with 96 px tiles: arrival 10 merges five parents, and no world search pins it.
    const random = rng(49), nodes = [node('root')], engine = createDefaultEngine();
    let previous: FolderLayout | undefined;
    for (let i = 0; i <= 10; i++) {
      if (i) {
        const parents = nodes.filter(() => random() < .25).map(n => n.key);
        if (!parents.length) parents.push(nodes[Math.floor(random() * nodes.length)].key);
        nodes.push(node(`n${i}`, parents, i));
      }
      const next = engine(inputFor(nodes, 360, 96, previous));
      expect(folderGeometryGate(next), `arrival ${i}`).toBeNull();
      expect(next.decision?.fallback, `arrival ${i}`).not.toBe('isolated-rows');
      expect(next.columns).toBe(2);
      previous = next;
    }
  }, 30_000);

  it.each([[1, 900, 64, 2], [49, 360, 96, 1], [49, 360, 96, 9], [49, 360, 96, 10], [4, 360, 96, 11]])(
    'gives a root connector a motion stem only when that stem is the drawn connector (seed %i, %i px, %i px tiles, arrival %i)', (seed, width, px, last) => {
      // World-placed drawings and identity frames keep their drawn root paths; a stem rebuilt from the placement would snap.
      const random = rng(seed), nodes = [node('root')], engine = createDefaultEngine();
      let previous: FolderLayout | undefined;
      for (let i = 0; i <= last; i++) {
        if (i) {
          const parents = nodes.filter(() => random() < .25).map(n => n.key);
          if (!parents.length) parents.push(nodes[Math.floor(random() * nodes.length)].key);
          nodes.push(node(`n${i}`, parents, i));
        }
        previous = engine(inputFor(nodes, width, px, previous));
      }
      const input = inputFor(nodes, width, px, previous), layout = engine(input);
      const scene = buildFolderScene({ scope: { paneId: 'p', directory: '/f', generation: 1 }, layoutInput: input, layout,
        sources: sourcesOf(makeFolder({ stacks: [nodes], files: 2 })), styling: { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null } });
      let stems = 0;
      for (const presented of staticPresentation(scene).live.values()) {
        if (!presented.attachment || presented.record.kind !== 'route') continue;
        stems++;
        const norm = (path: string) => path.replace(/\s+/g, ' ').trim().slice(0, 48);
        expect(norm(posePath({ ...settledPose(presented.record), stem: presented.attachment }, presented.record.rect)!)).toBe(norm(presented.record.route.path));
      }
      if (seed === 1) expect(stems).toBeGreaterThan(0);
    });
});
