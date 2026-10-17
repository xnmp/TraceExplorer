import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { pinnedBandExtent } from '$lib/domain/trace-graph/pinned-band-extent';
import { bandExtent } from '$lib/domain/trace-graph/band-geometry';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('preserves retained tiles when an internal gutter fits inside the pane without arrow-width padding', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-40-7502')!;
  let previous: ReturnType<typeof optimizedBand> | undefined;
  for (const focus of [null, 'n13', 'n26', 'n39']) {
    const request = requestFor(fixture, focus, 360, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
    if (focus === 'n39') {
      for (const [key, before] of previous!.placed.nodes) {
        if (!next.placed.nodes.has(key)) continue;
        expect(next.placed.nodes.get(key), key).toMatchObject({ x: before.x, y: before.y, width: before.width, height: before.height });
      }
      expect(next.placed.width).toBeLessThanOrEqual(request.maxWidth);
    }
    previous = next;
  }
});

function edgeDrawing(x: number, terminal = false, dot = false): GraphLayout {
  return { orientation: 'down', width: 100, height: 100, rows: [], readingOrder: new Map(),
    nodes: new Map([['cover', { key: 'cover', x: 40, y: 0, width: 20, height: 20, row: 0, band: 0 }],
      ['child', { key: 'child', x: 40, y: 70, width: 20, height: 20, row: 1, band: 0 }]]),
    junctions: new Map(dot ? [['dot', { id: 'dot', x, y: 50, parents: ['cover'] }]] : []),
    routes: dot ? [] : [{ id: 'route', from: { kind: 'node', id: 'cover' }, to: { kind: 'node', id: 'child' },
      consumers: [{ parent: 'cover', child: 'child' }], terminal, path: 'M' + x + ' 40 L' + x + ' 60' }] };
}

it('keeps a narrow gutter when every highlighted stroke fits', () => {
  expect(pinnedBandExtent(edgeDrawing(2), 'cover')).not.toBeNull();
});

it.each([
  ['highlighted stroke', edgeDrawing(1)],
  ['terminal arrow', edgeDrawing(2, true)],
  ['junction stroke', edgeDrawing(3.2, false, true)],
])('rejects actual %s paint outside the pane', (_kind, layout) => {
  expect(pinnedBandExtent(layout as GraphLayout, 'cover')).toBeNull();
});

it('preserves the comfortable allocation when it fits', () => {
  const layout = edgeDrawing(20, true);
  expect(pinnedBandExtent(layout, 'cover')).toEqual(bandExtent(layout, 'cover'));
});
