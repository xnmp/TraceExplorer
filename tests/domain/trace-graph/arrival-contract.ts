import { expect } from 'vitest';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';
import { TILE } from '$lib/domain/trace-graph/metrics';

/** Independent arrival oracle: exact hint growth, no horizontal drift, only its column may descend. */
export function expectArrivalPinned(before: GraphLayout, after: GraphLayout, context = ''): void {
  const gained = [...before.nodes.values()].filter(n => after.nodes.get(n.key)?.height === n.height + TILE.hint);
  for (const [key, was] of before.nodes) {
    expect(after.nodes.has(key), `${context} ${key}: retained node`).toBe(true);
    const now = after.nodes.get(key)!;
    expect(now.width, `${context} ${key}`).toBe(was.width);
    expect(now.x, `${context} ${key}`).toBe(was.x);
    expect([0, TILE.hint], `${context} ${key}: height`).toContain(now.height - was.height);
    const belowHint = gained.some(n => n.key !== key && was.y >= n.y + n.height
      && was.x < n.x + n.width && n.x < was.x + was.width);
    expect(belowHint ? [0, TILE.hint] : [0], `${context} ${key}: y`).toContain(now.y - was.y);
  }
}
