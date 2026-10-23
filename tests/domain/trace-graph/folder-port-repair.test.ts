/** Folder arrivals whose legacy insertion needs a newly active port cleared:
 * the retained-track port repair (the metric's own move) clears it before
 * legacy T24 is consulted, so every retained rectangle stays pinned. */
import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { profileLayout } from '$lib/domain/trace-graph/layout-profile';
import { expectFolderArrivalPinned } from './folder-arrival-contract';
import { corpusNode as node, makeFolder, folderInput } from './folder-layout-fixtures';
import { rng } from '../../../layout-eval/corpus';

/** The folder-pinned-arrival generator: arrival `i` adds n<i> under random earlier parents. */
function arrivals(seed: number, width: number, px: number, last: number) {
  const random = rng(seed), nodes = [node('root')], engine = createDefaultEngine();
  let previous: FolderLayout | undefined;
  const input = () => {
    const base = folderInput(makeFolder({ stacks: [nodes], files: 2 }), { open: ['s0:root'], width, tile: tileMetrics(px), previous });
    return { ...base, open: new Map([...base.open].map(([id, stack]) => [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
  };
  for (let i = 0; i < last; i++) {
    if (i) {
      const parents = nodes.filter(() => random() < .25).map(n => n.key);
      if (!parents.length) parents.push(nodes[Math.floor(random() * nodes.length)].key);
      nodes.push(node(`n${i}`, parents, i));
    }
    previous = engine(input());
  }
  const parents = nodes.filter(() => random() < .25).map(n => n.key);
  if (!parents.length) parents.push(nodes[Math.floor(random() * nodes.length)].key);
  nodes.push(node(`n${last}`, parents, last));
  return { engine, previous: previous!, input: input() };
}

it('clears an occluded port with the metric repair and keeps every retained rectangle (pinned-arrival seed 14, arrival 9)', () => {
  const { engine, previous, input } = arrivals(14, 360, 64, 9);
  const { result: next, profile } = profileLayout(() => engine(input));
  expect(folderGeometryGate(next)).toBeNull();
  expect(next.decision?.pinning).toBeUndefined();
  expectFolderArrivalPinned(previous, next);
  expect(profile.counters['retained-port-repair:legacy-insertion']).toBeGreaterThan(0);
  expect(profile.counters['legacy:T24']).toBeUndefined();
}, 30_000);
