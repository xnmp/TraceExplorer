import { describe, expect, it } from 'vitest';
import { classifySceneChange, geometryMotion, type CommittedGraph, type GeometryInputs } from '$lib/domain/trace-graph/scene-change';
import { layoutGraph } from '$lib/domain/trace-graph/layout';
import { projectDag, projectReferenceBadges } from '$lib/domain/trace-graph/projection';
import { planBandScene } from '$lib/domain/trace-graph/scene';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { node } from './fixtures';

const dag = projectDag([node('root'), node('a', ['root']), node('b', ['root']), node('aa', ['a']), node('bb', ['b'])]);
const scene = (focus: string | null = null, width = 454): CommittedGraph => {
  const tile = tileMetrics();
  const plan = planBandScene(projectReferenceBadges(dag), dag.order, focus, width, { pinned: { key: 'root', x: 46 }, tile });
  return { plan, layout: layoutGraph(plan.request), data: dag, componentId: 'component', revision: 0, tile };
};
const changedGeometry = (s: CommittedGraph): CommittedGraph => ({ ...s, layout: { ...s.layout, height: s.layout.height + 1 } });

describe('committed scene motion policy', () => {
  it('snaps focus and visibility swaps with unchanged component and layout inputs', () => {
    const a = scene('a'), b = scene('b');
    expect(classifySceneChange(a, b)).toBe('reveal');
    expect(classifySceneChange(b, a)).toBe('reveal');
    expect(classifySceneChange(scene(), a)).toBe('reveal');
    expect(classifySceneChange(a, { ...b, plan: { ...b.plan, lineage: a.plan.lineage } })).toBe('reveal');
  });
  it('restyles identical geometry even after data refresh or focus changes', () => {
    const a = scene('a');
    expect(classifySceneChange(a, scene('a'))).toBe('restyle');
    expect(classifySceneChange(a, { ...a, data: {}, revision: 1 })).toBe('restyle');
  });
  it.each([
    ['DAG identity', (s: CommittedGraph) => ({ ...s, data: {} })],
    ['component identity', (s: CommittedGraph) => ({ ...s, componentId: 'merged' })],
    ['revision', (s: CommittedGraph) => ({ ...s, revision: 1 })],
    ['width', (s: CommittedGraph) => ({ ...s, plan: { ...s.plan, request: { ...s.plan.request, maxWidth: 455 } } })],
    ['pin', (s: CommittedGraph) => ({ ...s, plan: { ...s.plan, request: { ...s.plan.request, pinned: { key: 'root', x: 47 } } } })],
    ['obstacles', (s: CommittedGraph) => ({ ...s, plan: { ...s.plan, request: { ...s.plan.request, pinned: { key: 'root', x: 46, obstacles: [{ x: 100, width: 92 }] } } } })],
    ['metrics', (s: CommittedGraph) => ({ ...s, tile: { ...s.tile, image: 52 } })],
    ['orientation', (s: CommittedGraph) => ({ ...s, layout: { ...s.layout, orientation: s.layout.orientation === 'down' ? 'right' as const : 'down' as const } })],
  ])('reflows changed %s when geometry differs', (_, change) => {
    expect(classifySceneChange(scene('a'), change(scene('b')))).toBe('reflow');
  });
  it('reflows geometry-only changes and the first layout', () => {
    const a = scene('a');
    expect(classifySceneChange(a, changedGeometry(a))).toBe('reflow');
    expect(classifySceneChange(null, a)).toBe('reflow');
  });
  it('handles empty scenes and empty-to-visible swaps', () => {
    const a = scene();
    const plan = { ...a.plan, tiles: new Map(), request: { ...a.plan.request, items: [] } };
    const empty = { ...a, plan, layout: layoutGraph(plan.request) };
    expect(classifySceneChange(empty, empty)).toBe('restyle');
    expect(classifySceneChange(empty, a)).toBe('reveal');
  });
  it('compares extremely large finite widths without arithmetic overflow', () => {
    const wide = (s: CommittedGraph) => ({ ...s, plan: { ...s.plan, request: { ...s.plan.request, maxWidth: Number.MAX_VALUE } } });
    expect(classifySceneChange(wide(scene('a')), wide(scene('b')))).toBe('reveal');
  });
  it.each([null, undefined, {}, { plan: {} }, { ...scene(), tile: null }, { ...scene(), layout: { ...scene().layout, nodes: null } },
    { ...scene(), layout: { ...scene().layout, height: NaN } },
    { ...scene(), plan: { ...scene().plan, request: { ...scene().plan.request, pinned: { key: 'root', x: NaN } } } },
    { ...scene(), plan: { ...scene().plan, request: { ...scene().plan.request, pinned: { key: 'root', x: 46, obstacles: [null] } } } },
    { ...scene(), plan: { ...scene().plan, request: { items: [null], maxWidth: 454 } } },
    { ...scene(), data: 'not a component' },
    { ...scene(), plan: { ...scene().plan, request: { items: [{ key: 'root', parents: [], order: 0, width: -1, height: 97 }], maxWidth: 454 } } }, { ...scene(), plan: { ...scene().plan, request: { items: [], maxWidth: Infinity } } },
  ])('conservatively reflows malformed input %#', value => {
    expect(classifySceneChange(value as CommittedGraph, scene())).toBe('reflow');
    expect(classifySceneChange(scene(), value as CommittedGraph)).toBe('reflow');
  });
});

describe('geometry motion policy', () => {
  const dataA = {}, dataB = {};
  const base: GeometryInputs = {
    current: true, width: 880, padding: 8, tile: { width: 96, image: 72 }, grid: { cellWidth: 104, cellHeight: 120, gap: 8 },
    items: ['stack\0a1', 'stack\0b1', 'file\0/f/notes.txt'], token: 't1',
    open: new Map([['b1', { componentId: 'cb', revision: 1, data: dataB }]]), requested: new Set(['b1']), failed: new Set(), focus: null,
  };
  const with_ = (change: Partial<GeometryInputs>): GeometryInputs => ({ ...base, ...change });
  const opened = with_({ open: new Map([...base.open, ['a1', { componentId: 'ca', revision: 1, data: dataA }]]), requested: new Set(['a1', 'b1']) });

  it('animates the spatial changes the user makes: an expand, a collapse, a focus change', () => {
    expect(geometryMotion(base, opened), 'expand').toBe('animate');
    expect(geometryMotion(opened, base), 'collapse').toBe('animate');
    expect(geometryMotion(base, with_({ focus: 'b2' })), 'selection').toBe('animate');
    expect(geometryMotion(with_({ focus: 'b2' }), with_({ focus: null })), 'deselection').toBe('animate');
    // Show image: the stack opens and the image is focused in one commit.
    expect(geometryMotion(base, { ...opened, focus: 'a3' }), 'reveal').toBe('animate');
  });

  it('animates Retry: a failed stack the user asks to read again opens', () => {
    const failed = with_({ requested: new Set(['a1', 'b1']), failed: new Set(['a1']) });
    expect(geometryMotion(failed, opened)).toBe('animate');
  });

  it.each([
    ['a wider pane', { width: 1200 }], ['a narrower pane', { width: 600 }], ['the grid padding', { padding: 0 }],
    ['the tile size', { tile: { width: 160, image: 120 } }], ['the tile image', { tile: { width: 96, image: 80 } }],
    ['the cell width', { grid: { ...base.grid, cellWidth: 140 } }], ['the cell height', { grid: { ...base.grid, cellHeight: 90 } }], ['the gap', { grid: { ...base.grid, gap: 4 } }],
    ['the listing order', { items: ['stack\0b1', 'stack\0a1', 'file\0/f/notes.txt'] }], ['a new file', { items: [...base.items, 'file\0/f/new.png'] }],
    ['an item kind', { items: ['stack\0a1', 'stack\0b1', 'folder\0/f/notes.txt'] }],
    ['the index token', { token: 't2' }], ['an open stack\'s data object', { open: new Map([['b1', { componentId: 'cb', revision: 1, data: {} }]]) }],
    ['an open stack\'s revision', { open: new Map([['b1', { componentId: 'cb', revision: 2, data: dataB }]]) }],
    ['an open stack\'s component', { open: new Map([['b1', { componentId: 'cc', revision: 1, data: dataB }]]) }],
  ] as const)('snaps a change of %s, whatever else the user changed with it', (_, change) => {
    expect(geometryMotion(base, with_(change))).toBe('snap');
    expect(geometryMotion(base, { ...opened, ...change }), 'with an expand').toBe('snap');
    expect(geometryMotion(base, with_({ ...change, focus: 'b2' })), 'with a selection').toBe('snap');
  });

  it('snaps arriving, and completing an arrival', () => {
    expect(geometryMotion(null, opened), 'nothing on screen').toBe('snap');
    // A saved scene shown as it was laid out on a return: whatever commits next completes the return.
    expect(geometryMotion(with_({ current: false }), with_({ focus: 'b2' }))).toBe('snap');
    expect(geometryMotion(with_({ current: false }), opened)).toBe('snap');
  });

  it('snaps a requested stack opening once its data arrives after the scene on screen already asked for it', () => {
    // A return whose saved data lacked the stack, or a cold open with a click committed in between.
    expect(geometryMotion(with_({ requested: new Set(['a1', 'b1']) }), opened)).toBe('snap');
  });

  it('snaps a stack closing while it is still requested (it failed in its cover)', () => {
    expect(geometryMotion(opened, { ...base, requested: new Set(['a1', 'b1']), failed: new Set(['a1']) })).toBe('snap');
  });

  it('snaps a stack opening that nobody requested', () => {
    expect(geometryMotion(base, { ...opened, requested: base.requested })).toBe('snap');
  });

  it('snaps geometry that changed although no input did', () => {
    expect(geometryMotion(base, with_({}))).toBe('snap');
  });

  it('decides from the inputs, not which transaction commits: the same change gives the same answer in either order of arrival', () => {
    const wide = with_({ width: 1200 });
    // A resize then an expand, committed together, or the expand alone after a committed resize.
    expect(geometryMotion(base, { ...opened, width: 1200 })).toBe('snap');
    expect(geometryMotion(wide, { ...opened, width: 1200 })).toBe('animate');
  });

  it.each([NaN, Infinity, -Infinity])('treats a non-finite measure (%s) as a change: it snaps', (bad) => {
    expect(geometryMotion(with_({ width: bad }), with_({ width: bad, focus: 'b2' }))).toBe('snap');
    expect(geometryMotion(base, with_({ tile: { width: bad, image: 72 } }))).toBe('snap');
  });

  it('handles empty scenes and huge listings', () => {
    const empty = with_({ items: [], open: new Map(), requested: new Set() });
    expect(geometryMotion(empty, with_({ items: [], open: new Map(), requested: new Set(), focus: 'x' }))).toBe('animate');
    const many = Array.from({ length: 50_000 }, (_, index) => `file\0/f/${index}.png`);
    expect(geometryMotion(with_({ items: many }), with_({ items: [...many], focus: 'b2' }))).toBe('animate');
    expect(geometryMotion(with_({ items: many }), with_({ items: [...many.slice(1), many[0]], focus: 'b2' }))).toBe('snap');
  });
});
