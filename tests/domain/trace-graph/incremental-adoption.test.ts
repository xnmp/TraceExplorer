/** Slice 4 production adoption: constrained incremental routing publishes first,
 * legacy runs only on an explicit decline, and the product contracts hold
 * through the default engine (publication), the next click and a revisit. */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adoptionFallback, movedRectangle } from '$lib/domain/trace-graph/incremental-adoption';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { profileLayout } from '$lib/domain/trace-graph/layout-profile';
import type { FolderLayout, FolderLayoutInput } from '$lib/domain/trace-graph/folder-layout';
import { TILE, tileMetrics } from '$lib/domain/trace-graph/metrics';
import { corpus, requestFor, node } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { decode } from './routing-hint-next-click-codec';
import { expectFolderArrivalPinned } from './folder-arrival-contract';
import { makeFolder, folderInput, corpusNode } from './folder-layout-fixtures';
import { projectDag, projectReferenceBadges } from '$lib/domain/trace-graph/projection';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { createFolderLayoutRuntime } from '$lib/plugins/trace/view/folder-layout-runtime';

type Rect = readonly [number, number, number, number];
const worldRects = (folder: FolderLayout): Map<string, Rect> => new Map([...folder.graphs.values()].flatMap(graph =>
  [...graph.attached.nodes].map(([key, n]) => [key, [n.x + graph.origin.x, n.y + graph.origin.y, n.width, n.height] as const])));
const outputs = (folder: FolderLayout) => new Set([...folder.graphs.values()].flatMap(g => (g.plan.request.band?.items ?? g.plan.request.items).flatMap(n => n.parents)));
const counters = <T>(run: () => T) => {
  const { result, profile } = profileLayout(run);
  return { result, count: (name: string) => profile.counters[name] ?? 0 };
};

const ancestry = (folder: FolderLayout, key: string): string[] => {
  const items = new Map([...folder.graphs.values()].flatMap(g => g.plan.request.items.map(n => [n.key, n] as const)));
  const found: string[] = [];
  for (const pending = [key]; pending.length;) { const at = pending.pop()!; if (found.includes(at) || !items.has(at)) continue; found.push(at); pending.push(...items.get(at)!.parents); }
  return found;
};

/** Independent world oracle for arrivals with hint growth or shrink: no tile moves
 * sideways or changes width; a height changes by exactly one hint only when that
 * tile gained its first or lost its last output; y changes only by one 16px
 * descent below a same-column source that gained its first output. */
function expectWorldHintPinned(before: FolderLayout, after: FolderLayout): void {
  const was = worldRects(before), now = worldRects(after), had = outputs(before), has = outputs(after);
  const grew = [...was].filter(([key, r]) => now.get(key)?.[3] === r[3] + TILE.hint);
  for (const [key, a] of was) {
    const b = now.get(key);
    if (!b) continue;
    expect([b[0], b[2]], `${key} x/width`).toEqual([a[0], a[2]]);
    const dh = b[3] - a[3];
    if (dh === TILE.hint) expect([had.has(key), has.has(key)], `${key} first output`).toEqual([false, true]);
    else if (dh === -TILE.hint) expect([had.has(key), has.has(key)], `${key} last output`).toEqual([true, false]);
    else expect(dh, `${key} height`).toBe(0);
    const below = grew.some(([source, s]) => source !== key && a[1] >= s[1] + s[3] && a[0] < s[0] + s[2] && s[0] < a[0] + a[2]);
    expect(below ? [0, TILE.hint] : [0], `${key} y`).toContain(b[1] - a[1]);
  }
}

describe('adoption contracts (pure)', () => {
  it('names the first moved, resized or missing rectangle and nothing else', () => {
    const r = (x: number, y = 0, width = 10, height = 10) => ({ x, y, width, height });
    const before = new Map([['a', r(0)], ['b', r(20)]]);
    expect(movedRectangle(before, new Map([['a', r(0)], ['b', r(20)], ['c', r(40)]]), ['a', 'b'])).toBeNull();
    expect(movedRectangle(before, new Map([['a', r(0)], ['b', r(20, 1)]]), ['a', 'b'])).toBe('b');
    expect(movedRectangle(before, new Map([['a', r(0, 0, 10, 26)], ['b', r(20)]]), ['a', 'b'])).toBe('a');
    expect(movedRectangle(before, new Map([['a', r(0)]]), ['a', 'b'])).toBe('b');
    expect(movedRectangle(before, before, ['ghost'])).toBe('ghost');
    expect(movedRectangle(before, new Map([['a', r(NaN)], ['b', r(20)]]), ['a'])).toBe('a');
    expect(movedRectangle(new Map(), new Map(), [])).toBeNull();
  });
  it('maps every constrained conflict to one fallback reason', () => {
    expect(['topology-conflict', 'metric-conflict', 'unsupported-input', 'budget-exhaustion'].map(r => adoptionFallback(r as never)))
      .toEqual(['topology', 'metric', 'unsupported', 'budget']);
  });
});

describe('band insertion through publication', () => {
  // Legacy insertion failed this click and published an anchored repack that moved
  // retained tiles; the constrained path keeps every retained rectangle.
  it.each([['random-bushy-40-7603', 2], ['random-bushy-100-8201', 2]] as const)('%s keeps every retained tile through the first %i clicks', (id, steps) => {
    const c = { ...corpus().find(f => f.id === id)!, full: false }, visited = new Set<string>();
    let focus: string | null = null, previous: Optimized | undefined, published = 0;
    for (let step = 0; step <= steps; step++) {
      const req = requestFor(c, focus, 400, 48);
      const { result: next, count } = counters(() => optimizedBand(req, { previous, anchorKey: focus ?? undefined }));
      published += count('adoption:band-insertion:published');
      if (previous) {
        for (const [key, was] of previous.placed.nodes) {
          const now = next.placed.nodes.get(key);
          if (now) expect([now.x, now.y, now.width, now.height], `step ${step} ${key}`).toEqual([was.x, was.y, was.width, was.height]);
        }
      }
      previous = next;
      const selected = req.items.filter(n => !visited.has(n.key) && req.band!.items.some(child => child.parents.includes(n.key)))
        .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
      focus = selected.key; visited.add(focus);
    }
    expect(published).toBeGreaterThan(0);
  });
});

describe('folder arrivals through publication', () => {
  const fixture = (name: string): FolderLayoutInput =>
    decode(fs.readFileSync(new URL(`./fixtures/routing-adoption/${name}.json`, import.meta.url), 'utf8')).at(-1);
  const close = (input: FolderLayoutInput, previous: FolderLayout, key: string): FolderLayoutInput => {
    return { ...input, previous, open: new Map([...input.open].map(([id, stack]) => [id, stack.members.includes(key)
      ? { ...stack, anchor: key, expanded: new Map([...stack.expanded, [key, false]]) } : stack])) };
  };

  it.each([
    ['world-hint-1', 'hint growth', 'folder-arrival'],
    ['world-hint-2', 'hint shrink', 'folder-arrival'],
    ['shrink-1', 'shrink-space reuse', 'band-insertion'],
    ['early-descent-1', 'a single 16px descent', 'band-insertion'],
  ] as const)('%s (%s) publishes the constrained drawing, then the next click and revisit keep it', (name, _label, site) => {
    const input = fixture(name), engine = createDefaultEngine();
    const { result: out, count } = counters(() => engine(input));
    expect(count(`adoption:${site}:published`)).toBeGreaterThan(0);
    expect(folderGeometryGate(out)).toBeNull();
    expectWorldHintPinned(input.previous!, out);
    const members = [...input.open.values()].flatMap(stack => stack.members);
    expect([...worldRects(out).keys()].sort()).toEqual([...members].sort());
    if (name === 'early-descent-1') {
      const was = worldRects(input.previous!), now = worldRects(out);
      expect([...was].filter(([key, r]) => now.get(key)![1] !== r[1]).map(([key, r]) => [key, now.get(key)![1] - r[1]])).toEqual([['s0:q', TILE.hint]]);
    }
    // Clicked ancestry stays put on the next ordinary click, and returning to the
    // published state restores it exactly.
    const clicked = engine(close(input, out, 's0:p'));
    expect(folderGeometryGate(clicked)).toBeNull();
    expect(ancestry(out, 's0:p').length).toBeGreaterThan(1);
    expect(movedRectangle(new Map([...worldRects(out)].map(([k, r]) => [k, { x: r[0], y: r[1], width: r[2], height: r[3] }])),
      new Map([...worldRects(clicked)].map(([k, r]) => [k, { x: r[0], y: r[1], width: r[2], height: r[3] }])), ancestry(out, 's0:p'))).toBeNull();
    const back = engine({ ...input, previous: clicked });
    expect(back.revisited).toBe(true);
    expect(worldRects(back)).toEqual(worldRects(out));
  });

  // Legacy placement declines malformed packing metadata; the constrained path
  // must decline it too rather than throw out of the layout request.
  it('declines a snapshot with malformed packing metadata and publishes the legacy result', () => {
    const input = fixture('world-hint-1');
    const malformed = { ...input, previous: { ...input.previous!, bounds: undefined as never } };
    const { result: out, count } = counters(() => createDefaultEngine()(malformed));
    expect(folderGeometryGate(out)).toBeNull();
    expect([count('adoption:folder-arrival:attempt'), count('adoption:folder-arrival:fallback:unsupported')]).toEqual([1, 1]);
  });

  // The constrained search spends up to a finite allowance before any legacy
  // fallback, so dispatch sends it to the worker; the exact revisit stays inline.
  it('dispatches constrained searches to the worker and keeps exact revisits inline', () => {
    const input = fixture('world-hint-1'), runtime = createFolderLayoutRuntime();
    expect(runtime.inline(input)).toBe(false);
    const out = runtime.engine(input);
    const closing = close(input, out, 's0:p');
    expect(runtime.inline(closing)).toBe(false);
    const clicked = runtime.engine(closing);
    const revisit = { ...input, previous: clicked };
    expect(runtime.inline(revisit)).toBe(true);
    expect(runtime.engine(revisit).revisited).toBe(true);
  });

  // A merge above later grid rows and a hint descent: every retained world
  // rectangle, keyed by tile identity, stays where the snapshot has it.
  it('keeps retained world rectangles through output arrivals and a component merge', () => {
    const engine = createDefaultEngine(), tile = tileMetrics(), options = { width: 400, tile, grid: fallbackGridMetrics(tile) };
    const c = corpus().find(f => f.id === 'random-dag-12-7221')!;
    let previous: FolderLayout | undefined, adopted = 0;
    for (let n = 2; n <= 8; n++) {
      const folder = makeFolder({ stacks: [c.nodes.slice(0, n), [node('other'), node('edit', ['other'], 1)]] });
      const { result: next, count } = counters(() => engine(folderInput(folder, { ...options, open: [...folder.stacks.keys()], previous })));
      expect(folderGeometryGate(next), `arrival ${n}`).toBeNull();
      if (previous) expectFolderArrivalPinned(previous, next);
      adopted += count('adoption:folder-arrival:published');
      previous = next;
    }
    expect(adopted).toBeGreaterThan(0);
  });

  it.each([true, false])('keeps merged tiles by identity through the constrained world path (absorbed open: %s)', absorbedOpen => {
    const folder = makeFolder({ stacks: [[corpusNode('root'), corpusNode('a', ['root'], 1)], [corpusNode('root', [], 2), corpusNode('b', ['root'], 3)]] });
    const engine = createDefaultEngine();
    const initial = folderInput(folder, { open: absorbedOpen ? [...folder.stacks.keys()] : ['s0:root'], width: 640 });
    const before = engine(initial);
    const graph = projectReferenceBadges(projectDag([...[...folder.stacks.values()].flatMap(s => s.nodes), corpusNode('merged', ['s0:a', 's1:b'], 4)]));
    const request = { ...initial, previous: before, items: initial.items.filter(i => i.id !== 's1:root'),
      open: new Map([['s0:root', { id: 's0:root', graph, members: graph.dag.order, anchor: null, expanded: new Map(graph.dag.order.map(k => [k, true])) }]]) };
    const { result: after, count } = counters(() => engine(request));
    expect(count('adoption:folder-arrival:published')).toBe(1);
    expect(folderGeometryGate(after)).toBeNull();
    expectFolderArrivalPinned(before, after);
    expect([...after.graphs.get('s0:root')!.attached.nodes.keys()].sort()).toEqual(['merged', 's0:a', 's0:root', 's1:b', 's1:root'].sort());
  });
});
