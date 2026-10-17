import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

// Bounded worker searches run under full-suite contention; latency is gated by layout:eval.
it('repositions non-anchor siblings when their fully pinned insertion cannot retain the clicked tile', () => {
  const fixture = { ...corpus().find(c => c.id === 'random-dag-40-7503')!, full: false };
  let previous: ReturnType<typeof optimizedBand> | undefined;
  const visited = new Set<string>();
  let focus: string | null = null;
  for (let step = 0; step <= 7; step++) {
    const request = requestFor(fixture, focus, 360, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    if (step === 7) {
      expect(focus).toBe('n20');
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
}, 30_000);
