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

it('retains a crowded later click with the larger bounded search', () => {
  const fixture = { ...corpus().find(c => c.id === 'random-dag-100-8101')!, full: false };
  let previous: ReturnType<typeof optimizedBand> | undefined;
  const visited = new Set<string>();
  let focus: string | null = null;
  for (let step = 0; step <= 6; step++) {
    const request = requestFor(fixture, focus, 640, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    if (step === 6) {
      expect(focus).toBe('n69');
      const before = previous!.placed.nodes.get(focus!)!;
      expect(next.placed.nodes.get(focus!)).toMatchObject({ x: before.x, y: before.y });
      expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
    }
    previous = next;
    const choices = request.items.filter(n => !visited.has(n.key) && request.band!.items.some(c => c.parents.includes(n.key)))
      .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
    focus = choices[0]?.key ?? null;
    if (focus) visited.add(focus);
  }
});
