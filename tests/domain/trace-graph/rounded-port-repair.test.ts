import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { pathCommands } from '$lib/domain/trace-graph/path-sampling';
import { ARROW } from '$lib/domain/trace-graph/metrics';

it.each([
  ['random-bushy-200-9201', [3, 4, 5, 7]],
  ['random-bushy-200-9203', [6]],
] as const)('repairs rounded tracks blocking revealed source ports in %s', (id, pinnedSteps) => {
  const fixture = { ...corpus().find(c => c.id === id)!, full: false }, visited = new Set<string>();
  let previous: Optimized | undefined, focus: string | null = null;
  for (let step = 0; step < 9; step++) {
    const request = requestFor(fixture, focus, 454, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth), `step ${step}`).toBeNull();
    if ((pinnedSteps as readonly number[]).includes(step)) {
      for (const [key, before] of previous!.placed.nodes) {
        const after = next.placed.nodes.get(key);
        if (after) expect([after.x, after.y, after.width, after.height], `${step}/${key}`)
          .toEqual([before.x, before.y, before.width, before.height]);
      }
    }
    if (id === 'random-bushy-200-9201' && step === 3) {
      const repaired = next.placed.routes.find(r => r.from.kind === 'node' && r.from.id === 'n1' && r.to.kind === 'node' && r.to.id === 'n9')!;
      const commands = pathCommands(repaired.path)!;
      // Keep the available fillet, but clip the last one when its room belongs to the arrow approach.
      expect(commands.some(c => c.kind === 'C')).toBe(true);
      expect(commands.at(-1)!.kind).toBe('L');
      const end = commands.at(-1)!.values, before = commands.at(-2)!.values.slice(-2);
      expect(end[0]).toBe(before[0]);
      expect(end[1] - before[1]).toBeGreaterThanOrEqual(ARROW.length);
    }
    previous = next;
    const choices = request.items.filter(n => !visited.has(n.key) && request.band!.items.some(c => c.parents.includes(n.key)))
      .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
    focus = choices[0]?.key ?? null;
    if (focus) visited.add(focus);
  }
}, 30_000);
