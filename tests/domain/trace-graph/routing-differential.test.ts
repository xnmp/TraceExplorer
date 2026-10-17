import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { packedGridFlow, bandPlacements } from '$lib/domain/trace-graph/band-geometry';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { node } from '../../../layout-eval/corpus';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { folderInput, makeFolder } from './folder-layout-fixtures';

it('preserves serialized layered drawings across the existing corpus and channel scopes', () => {
  // Captured by running the unmodified 6768262 engine, not by updating a snapshot
  // from this implementation. Includes ordinary channels and unsupported cycles,
  // swaps, fans and narrow gaps. Maps/Sets and route strings are included verbatim.
  const hash = createHash('sha256');
  for (const c of corpus()) for (const width of [360, 640, 1000]) {
    const drawing = layoutLayered(requestFor(c, null, width, 48));
    hash.update(JSON.stringify(drawing, (_, value) => value instanceof Map || value instanceof Set ? [...value] : value));
  }
  expect(hash.digest('hex')).toBe('6bb1aad43b76b091ad1b6709d13c02ddccdca68409a54f6bedc06f48512f71df');
}, 20000);

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
