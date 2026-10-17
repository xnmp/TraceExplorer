import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('uses additional bounded insertion search to retain the clicked tile', () => {
  const fixture = { ...corpus().find(c => c.id === 'random-dag-100-8103')!, full: false };
  let previous: ReturnType<typeof optimizedBand> | undefined;
  for (const focus of [null, 'n64']) {
    const request = requestFor(fixture, focus, 454, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    if (focus) {
      const before = previous!.placed.nodes.get(focus)!;
      expect(next.placed.nodes.get(focus)).toMatchObject({ x: before.x, y: before.y });
      expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
    }
    previous = next;
  }
});
