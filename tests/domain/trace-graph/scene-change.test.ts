import { describe, expect, it } from 'vitest';
import { classifySceneChange, type CommittedGraph } from '$lib/domain/trace-graph/scene-change';
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
