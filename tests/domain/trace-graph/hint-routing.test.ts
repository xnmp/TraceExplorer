import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { incrementalBudget, constrainedIncremental } from '$lib/domain/trace-graph/band-incremental';
import { hintRoutingFrame } from '$lib/domain/trace-graph/hint-routing';
import { bandHistorySignature, historyFit } from '$lib/domain/trace-graph/band-history';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutRequest } from '$lib/domain/trace-graph/layout';
import { RoutingImportError } from '$lib/domain/trace-graph/routing-plan';
import { HintRoutingError } from '$lib/domain/trace-graph/hint-routing-policy';

const fixture = (): { before: GraphLayout; beforeRequest: LayoutRequest; request: LayoutRequest } =>
  JSON.parse(readFileSync(new URL('./hint-shrink-committed.json', import.meta.url), 'utf8'),
    (_key, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value);

it('reuses released hint pixels for an arrival while retaining committed native paint', () => {
  const input = fixture(), original = structuredClone(input), { before, beforeRequest, request } = input;
  const fit = historyFit(bandHistorySignature(beforeRequest), request);
  expect(fit?.kind).toBe('grown');
  if (!fit || fit.kind !== 'grown') return;
  expect([...fit.heights]).toEqual([['s', 81]]);
  const pane = { left: 0, right: request.maxWidth };
  expect(constrainedIncremental(request, before, incrementalBudget(), pane, 64_000_000))
    .toMatchObject({ ok: false, conflict: { reason: 'unsupported-input' } });
  const result = constrainedIncremental(request, before, incrementalBudget(), pane, 64_000_000,
    hintRoutingFrame(fit.heights));
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (!result.ok) return;
  expect(geometryGate(result.drawing, request.items, request.band!.key, request.maxWidth)).toBeNull();
  expect([...result.drawing.nodes.keys()].sort()).toEqual(request.items.map(item => item.key).sort());
  const old = before.nodes.get('s')!, shrunk = result.drawing.nodes.get('s')!, arrival = result.drawing.nodes.get('n')!;
  expect(shrunk.height).toBe(81);
  expect(Math.min(arrival.x + arrival.width, old.x + old.width) - Math.max(arrival.x, old.x)).toBeGreaterThan(0);
  expect(Math.min(arrival.y + arrival.height, old.y + old.height) - Math.max(arrival.y, shrunk.y + shrunk.height)).toBeGreaterThan(0);
  expect(result.drawing.nodes.has('d')).toBe(false);
  for (const [key, node] of before.nodes) if (key !== 'd') {
    expect(result.drawing.nodes.get(key)).toEqual({ ...node, height: key === 's' ? 81 : node.height });
  }
  for (const route of before.routes) if (route.id !== 's-d') {
    expect(result.drawing.routes.find(next => next.id === route.id)).toEqual(route);
  }
  expect(result.work).toBeLessThanOrEqual(64_000_000);
  expect(input).toEqual(original);
});

it('declines malformed or undeclared hint sizes without changing the committed drawing', () => {
  const { before, request } = fixture(), original = structuredClone(before);
  for (const height of [NaN, Infinity, -1, 82]) {
    const result = constrainedIncremental(request, before, incrementalBudget(),
      { left: 0, right: request.maxWidth }, 64_000_000, hintRoutingFrame(new Map([['s', height]])));
    expect(result).toMatchObject({ ok: false, conflict: { reason: 'unsupported-input' } });
  }
  expect(before).toEqual(original);
});

it('propagates unexpected work failures from the request-local frame policy', () => {
  const { before } = fixture();
  for (const failure of [new RangeError('external ledger stopped'), new RoutingImportError('work', 'external failure'),
    new HintRoutingError('external failure'), { exhausted: true }]) {
    let actual: unknown;
    try { hintRoutingFrame(new Map([['s', 81]]))(before, () => { throw failure; }, (_label, choices) => choices[0]); }
    catch (error) { actual = error; }
    expect(actual).toBe(failure);
  }
});

it('withholds the complete hint request when its shared ledger is exhausted', () => {
  const { before, request } = fixture(), original = structuredClone(before);
  expect(constrainedIncremental(request, before, incrementalBudget(),
    { left: 0, right: request.maxWidth }, 0, hintRoutingFrame(new Map([['s', 81]]))))
    .toMatchObject({ ok: false, work: 0, conflict: { reason: 'budget-exhaustion' } });
  expect(before).toEqual(original);
});

it('derives semantic hint frames when optional ownership metadata is cyclic', () => {
  const { before } = fixture();
  const extra: { self?: unknown } = {}; extra.self = extra;
  const source = { ...before, routes: before.routes.map(route => ({ ...route,
    from: { ...route.from, extra }, consumers: [...(route.consumers as readonly { parent: string; child: string }[])].map(c => ({ ...c, extra })) })) };
  const result = hintRoutingFrame(new Map([['s', 81]]))(source, () => {}, (_label, choices) => choices[0]);
  expect('preferred' in result).toBe(true);
  if ('preferred' in result) expect(result.preferred.nodes.get('s')?.height).toBe(81);
});

it('bounds repeated long consumer identities before native import work', () => {
  const { before } = fixture(), consumer = { parent: 'p'.repeat(1000), child: 'q'.repeat(1000) };
  const source = { ...before, routes: [{ ...before.routes[0], consumers: Array(800).fill(consumer) }] };
  const limit = 512_000, exhausted = { exhausted: true };
  let work = 0, actual: unknown;
  try {
    hintRoutingFrame(new Map())(source, amount => {
      if (amount > limit - work) throw exhausted;
      work += amount;
    }, (_label, choices) => choices[0]);
  } catch (error) { actual = error; }
  expect(actual).toBe(exhausted);
  expect(work).toBeLessThanOrEqual(limit);
});
