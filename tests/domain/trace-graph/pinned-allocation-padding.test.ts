import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('keeps a clicked tile when pinned connector ink fits but comfortable allocation padding does not', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-100-8102')!;
  let previous: ReturnType<typeof optimizedBand> | undefined;
  for (const focus of [null, 'n33', 'n66']) {
    const request = requestFor(fixture, focus, 454, 48);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    if (focus === 'n66') {
      const before = previous!.placed.nodes.get(focus)!;
      expect(next.placed.nodes.get(focus)).toMatchObject({ x: before.x, y: before.y });
      expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
      expect(next.placed.width).toBeLessThanOrEqual(request.maxWidth);
    }
    previous = next;
  }
});
