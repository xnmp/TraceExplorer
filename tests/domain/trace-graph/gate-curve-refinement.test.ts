import { expect, it } from 'vitest';
import { routeClearanceViolation } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';

/** A cubic retreats from a trunk end; its first chord cuts closer than the curve. */
function retreat(gap: number, vertical: boolean, dx: number, dy: number, reverse: boolean): GraphLayout {
  const x = 200 + gap + dx, y = 200 + dy;
  const routes: PlacedRoute[] = [
    { id: 'trunk', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'a' },
      consumers: [{ parent: 'a', child: 'a-output' }], terminal: false,
      path: vertical ? `M${200 + dx} ${100 + dy} L${200 + dx} ${y}` : `M${100 + dx} ${y} L${200 + dx} ${y}` },
    { id: 'joining', from: { kind: 'node', id: 'b' }, to: { kind: 'junction', id: 'join' },
      consumers: [{ parent: 'b', child: 'b-output' }], terminal: false,
      path: `M${x + 30} ${y - 60} L${x} ${y - 60} L${x} ${y} C${x} ${y + 13.75},${x - 74} ${y + 13.75},${x - 74} ${y + 27.5}` },
  ];
  return { orientation: 'down', width: 500 + dx, height: 400 + dy, rows: [], readingOrder: new Map(),
    nodes: new Map([
      ['a', { key: 'a', x: (vertical ? 195 : 90) + dx, y: (vertical ? 90 : 195) + dy, width: 10, height: 10, row: 0, band: 0 }],
      ['b', { key: 'b', x: x + 30, y: y - 65, width: 10, height: 10, row: 1, band: 0 }],
    ]),
    junctions: new Map([['join', { id: 'join', x: x - 74, y: y + 27.5, parents: ['b'] }]]),
    routes: reverse ? routes.toReversed() : routes };
}

// Horizontal trunks isolate endpoint probes; vertical trunks also exercise
// conservative parallel-curve checks. These are distinct real source families.
for (const vertical of [false, true]) for (const translated of [false, true]) for (const reverse of [false, true]) {
  const suffix = `vertical=${vertical}, translated=${translated}, reversed=${reverse}`;
  it.each([3, 3.01])(`accepts an actual %f px curve clearance (${suffix})`, gap => {
    expect(routeClearanceViolation(retreat(gap, vertical, translated ? 37 : 0, translated ? 91 : 0, reverse))).toBeNull();
  });
  it(`rejects an actual 2.99 px curve clearance (${suffix})`, () => {
    expect(routeClearanceViolation(retreat(2.99, vertical, translated ? 37 : 0, translated ? 91 : 0, reverse))).toBe('route-contact');
  });
}

/** Curve endpoints remain 6px apart; only the two interiors approach. */
function bowedPair(gap: number, duplicatePoints: boolean): GraphLayout {
  const bow = (6 - gap) / 1.5;
  const route = (id: string, startY: number, y: number, bendY: number): PlacedRoute => ({
    id, from: { kind: 'node', id }, to: { kind: 'node', id }, terminal: false,
    consumers: [{ parent: id, child: `${id}-output` }],
    path: `M100 ${startY} ${duplicatePoints ? `L100 ${startY} ` : ''}L200 ${startY} L200 ${y} C233 ${bendY},266 ${bendY},300 ${y} L400 ${y}`,
  });
  return { orientation: 'down', width: 500, height: 300, rows: [], readingOrder: new Map(), junctions: new Map(),
    nodes: new Map([
      ['a', { key: 'a', x: 90, y: 45, width: 10, height: 10, row: 0, band: 0 }],
      ['b', { key: 'b', x: 90, y: 145, width: 10, height: 10, row: 1, band: 0 }],
    ]), routes: [route('a', 50, 100, 100 + bow), route('b', 150, 106, 106 - bow)] };
}

it.each([2.85, 2.99999, 3, 3.00001])('checks complete curve interiors at %f px clearance', gap => {
  const expected = gap < 3 ? 'route-contact' : null;
  expect(routeClearanceViolation(bowedPair(gap, false))).toBe(expected);
  // Removing duplicate path points must keep local primitives aligned with segments.
  expect(routeClearanceViolation(bowedPair(gap, true))).toBe(expected);
});
