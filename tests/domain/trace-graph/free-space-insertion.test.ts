import { describe, expect, it } from 'vitest';
import { freeSpaceInsertions, FREE_SPACE_GAP, MAX_OBSTACLES } from '$lib/domain/trace-graph/folder-layout/free-space-insertion';
import { importedRoute } from '$lib/domain/trace-graph/routing-plan';
import { ARROW } from '$lib/domain/trace-graph/metrics';
import { TILE_GRAZE } from '$lib/domain/trace-graph/route-contacts';
import type { GraphLayout, LayoutItem, PlacedNode } from '$lib/domain/trace-graph/layout';

const tile = (key: string, x: number, y: number, width = 140, height = 112): PlacedNode => ({ key, x, y, width, height, row: 0, band: 0 });
const item = (key: string, parents: string[] = [], width = 140, height = 112): LayoutItem => ({ key, width, height, parents, order: 0 });
const world = (nodes: PlacedNode[], routes: GraphLayout['routes'] = []): GraphLayout => ({
  nodes: new Map(nodes.map(n => [n.key, n])), junctions: new Map(), routes, rows: [], readingOrder: new Map(), orientation: 'down',
  width: 368, height: Math.max(...nodes.map(n => n.y + n.height)),
});
/** Two grid rows of 176 × 128 cells, 8 px apart, with the bottom-right cell empty: the 360 px, 96 px-tile folder. */
const grid = () => world([tile('cover', 26, 0, 140, 128), tile('file-0', 192, 0, 176, 128), tile('file-1', 8, 136, 176, 128)]);
const pane = { left: 8, right: 368 };
const separated = (a: PlacedNode, b: PlacedNode, gap: number) => a.x + a.width + gap <= b.x + 1e-6 || b.x + b.width + gap <= a.x + 1e-6
  || a.y + a.height + gap <= b.y + 1e-6 || b.y + b.height + gap <= a.y + 1e-6;
/** Distance from point p to the box, zero inside. */
const boxDistance = (p: { x: number; y: number }, b: PlacedNode) => Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.width), Math.max(b.y - p.y, 0, p.y - b.y - b.height));

describe('free-space world insertion', () => {
  it('places a new child in the empty grid slot, every retained rectangle constant', () => {
    const drawing = grid(), items = [item('cover'), item('file-0'), item('file-1'), item('child', ['cover'])];
    const [first] = freeSpaceInsertions({ items, drawing, pane });
    expect(first).toBeDefined();
    for (const [key, node] of drawing.nodes) expect(first.nodes.get(key)).toEqual(node);
    const child = first.nodes.get('child')!;
    // Within the pane, clear of every obstacle, and adding no height: the bottom-right slot.
    expect(child.x).toBeGreaterThanOrEqual(pane.left);
    expect(child.x + child.width).toBeLessThanOrEqual(pane.right);
    for (const node of drawing.nodes.values()) expect(separated(child, node, FREE_SPACE_GAP), node.key).toBe(true);
    expect(child.y + child.height).toBeLessThanOrEqual(264);
    // Its one connector runs from the cover's bottom port into its top port with a straight arrow approach.
    const route = first.routes.find(r => r.to.kind === 'node' && r.to.id === 'child')!;
    expect(route.from).toEqual({ kind: 'node', id: 'cover' });
    expect(route.terminal).toBe(true);
    const points = importedRoute(route).points, start = points[0], end = points.at(-1)!, before = points.at(-2)!;
    expect(start).toEqual({ x: 96, y: 128 });
    expect(end).toEqual({ x: child.x + child.width / 2, y: child.y - ARROW.length });
    expect(before.x).toBe(end.x);
    expect(end.y - before.y).toBeGreaterThanOrEqual(ARROW.length);
    // The run through the 8 px row gap is centred in it, clear of both rows.
    for (const p of points.slice(2, -1)) for (const node of drawing.nodes.values()) expect(boxDistance(p, node), node.key).toBeGreaterThanOrEqual(TILE_GRAZE - 1e-9);
    expect(points.some(p => p.y === 132)).toBe(true);
  });

  it('is deterministic and proposes distinct rectangles, best first', () => {
    const drawing = grid(), items = [item('cover'), item('file-0'), item('file-1'), item('child', ['cover'])];
    const a = [...freeSpaceInsertions({ items, drawing, pane })], b = [...freeSpaceInsertions({ items, drawing, pane })];
    expect(a.map(d => d.routes.at(-1)!.path)).toEqual(b.map(d => d.routes.at(-1)!.path));
    expect(a.length).toBeGreaterThan(1);
    const places = a.map(d => JSON.stringify(d.nodes.get('child')));
    expect(new Set(places).size).toBe(places.length);
    const added = a.map(d => Math.max(0, d.nodes.get('child')!.y + 112 - 264));
    expect(added).toEqual([...added].sort((x, y) => x - y));
    expect(a.length).toBeLessThanOrEqual(12);
    expect([...freeSpaceInsertions({ items, drawing, pane, limit: 2 })]).toHaveLength(2);
  });

  it('places a chain of new tiles, each below its own new parent', () => {
    const drawing = grid(), items = [item('cover'), item('file-0'), item('file-1'), item('a', ['cover']), item('b', ['a'])];
    const [first] = freeSpaceInsertions({ items, drawing, pane });
    expect(first).toBeDefined();
    const a = first.nodes.get('a')!, b = first.nodes.get('b')!;
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect(separated(a, b, FREE_SPACE_GAP)).toBe(true);
    expect(first.routes.map(r => [r.from.id, r.to.id])).toEqual([['cover', 'a'], ['a', 'b']]);
  });

  it('meets several parents at one dot above the new tile', () => {
    const drawing = world([tile('a', 8, 0), tile('b', 228, 0)]), items = [item('a'), item('b'), item('m', ['b', 'a'])];
    const [first] = freeSpaceInsertions({ items, drawing, pane });
    expect(first).toBeDefined();
    const m = first.nodes.get('m')!, [dot] = [...first.junctions.values()];
    expect(dot.parents).toEqual(['a', 'b']);
    expect(dot.x).toBe(m.x + m.width / 2);
    expect(dot.y).toBeLessThan(m.y - ARROW.length);
    const inputs = first.routes.filter(r => r.to.kind === 'junction');
    expect(inputs.map(r => r.from.id).sort()).toEqual(['a', 'b']);
    for (const r of inputs) {
      expect(r.terminal).toBe(false);
      expect(r.consumers).toEqual([{ parent: r.from.id, child: 'm' }]);
      expect(importedRoute(r).points.at(-1)).toEqual({ x: dot.x, y: dot.y });
    }
    const stem = first.routes.find(r => r.from.kind === 'junction')!;
    expect(stem.terminal).toBe(true);
    expect(stem.consumers).toEqual([{ parent: 'a', child: 'm' }, { parent: 'b', child: 'm' }]);
    expect(importedRoute(stem).points).toEqual([{ x: dot.x, y: dot.y }, { x: dot.x, y: m.y - ARROW.length }]);
  });

  it('declines roots, missing parents, too many inputs, malformed sizes and complete drawings', () => {
    const drawing = grid(), cells = [item('cover'), item('file-0'), item('file-1')];
    expect([...freeSpaceInsertions({ items: [...cells, item('m', [])], drawing, pane })]).toEqual([]);
    expect([...freeSpaceInsertions({ items: [...cells, item('m', ['absent'])], drawing, pane })]).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => tile(`p${i}`, 8 + 60 * i, 0, 50, 50));
    expect([...freeSpaceInsertions({ items: [...many.map(n => item(n.key)), item('m', many.map(n => n.key), 50, 50)], drawing: world(many), pane })]).toEqual([]);
    for (const size of [NaN, Infinity, 0, -1]) expect([...freeSpaceInsertions({ items: [...cells, item('m', ['cover'], size)], drawing, pane })]).toEqual([]);
    expect([...freeSpaceInsertions({ items: cells, drawing, pane })]).toEqual([]);
  });

  it('declines a world with more obstacles than its bound, in bounded time', () => {
    const many = Array.from({ length: MAX_OBSTACLES + 1 }, (_, i) => tile(`t${i}`, 8 + 20 * (i % 17), 20 * Math.floor(i / 17), 10, 10));
    const started = performance.now();
    expect([...freeSpaceInsertions({ items: [...many.map(n => item(n.key)), item('m', ['t0'], 10, 10)], drawing: world(many), pane })]).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('bounds its work for a long arrival in a cluttered world', () => {
    // 100 small obstacles and a chain of 160 new tiles: unbounded, the corridor searches grow with the chain.
    let state = 7;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const nodes = [tile('p0', 150, 0, 60, 40), ...Array.from({ length: 99 }, (_, i) =>
      tile(`o${i}`, 8 + Math.floor(random() * 330), 60 + Math.floor(random() * 1500), 14 + Math.floor(random() * 20), 14 + Math.floor(random() * 20)))];
    const items = [...nodes.map(n => item(n.key, [], n.width, n.height)), ...Array.from({ length: 160 }, (_, i) => item(`c${i}`, [i ? `c${i - 1}` : 'p0'], 60, 40))];
    const started = performance.now();
    for (const proposed of freeSpaceInsertions({ items, drawing: world(nodes), pane })) for (const n of nodes) expect(proposed.nodes.get(n.key)).toEqual(n);
    expect(performance.now() - started).toBeLessThan(6000);
  }, 30_000);

  it('declines when no free rectangle in the pane fits', () => {
    const drawing = grid(), items = [item('cover'), item('file-0'), item('file-1'), item('wide', ['cover'], 400)];
    expect([...freeSpaceInsertions({ items, drawing, pane })]).toEqual([]);
  });

  it('never runs along another source’s connector', () => {
    // A foreign connector occupies the row gap's centre line over the right half of the pane.
    const foreign = { id: 'foreign', from: { kind: 'node' as const, id: 'file-0' }, to: { kind: 'node' as const, id: 'file-0' },
      consumers: [], terminal: false, path: 'M200 132 L368 132' };
    const drawing = world([...grid().nodes.values()], [foreign]);
    const items = [item('cover'), item('file-0'), item('file-1'), item('child', ['cover'])];
    const proposals = [...freeSpaceInsertions({ items, drawing, pane })];
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposed of proposals) {
      const points = importedRoute(proposed.routes.at(-1)!).points;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.y === b.y && Math.abs(a.x - b.x) > 1e-6) expect(Math.abs(a.y - 132) >= 3 - 1e-6 || Math.max(a.x, b.x) <= 200 || Math.min(a.x, b.x) >= 368).toBe(true);
      }
    }
  });

  it('ignores the excluded anchor as an obstacle', () => {
    // The anchor fills the empty grid slot: only its exclusion frees the slot.
    const drawing = world([...grid().nodes.values(), tile('anchor', 192, 136, 176, 128)]);
    const items = [item('anchor'), item('cover'), item('file-0'), item('file-1'), item('child', ['cover'])];
    const inSlot = (d: GraphLayout) => { const c = d.nodes.get('child')!; return c.y + c.height <= 264; };
    const [blocked] = freeSpaceInsertions({ items, drawing, pane });
    const [freed] = freeSpaceInsertions({ items, drawing, pane, exclude: new Set(['anchor']) });
    expect(inSlot(blocked)).toBe(false);
    expect(inSlot(freed)).toBe(true);
  });
});
