import { expect, it } from 'vitest';
import { routeClearanceViolation } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';

const drawing = (paths: readonly string[]): GraphLayout => ({
  orientation: 'down', width: 100, height: 100, nodes: new Map(), rows: [], readingOrder: new Map(),
  junctions: new Map([['join', { id: 'join', x: 0, y: 0, parents: ['a', 'b'] }]]),
  routes: paths.map((path, i): PlacedRoute => ({ id: String(i), path,
    from: { kind: 'node', id: i ? 'b' : 'a' }, to: { kind: 'junction', id: 'join' }, consumers: [], terminal: false })),
});

it('accepts the bounded final fan into a declared junction', () => {
  expect(routeClearanceViolation(drawing(['M-3 -20 L-3 -6 C-3 -3 0 -3 0 0', 'M0 -20 L0 0']))).toBeNull();
});

it('still rejects nearby inputs outside the final junction berth', () => {
  expect(routeClearanceViolation(drawing(['M-2 -40 L-2 -6 C-2 -3 0 -3 0 0', 'M0 -40 L0 0']))).toBe('route-contact');
});
