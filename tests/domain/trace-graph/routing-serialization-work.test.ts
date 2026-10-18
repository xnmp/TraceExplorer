import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { prepayRoutingSerialization } from '$lib/domain/trace-graph/routing-serialization-work';
import { routeCommittedIncremental } from '$lib/domain/trace-graph/incremental-routing';
import { hintRoutingFrame } from '$lib/domain/trace-graph/hint-routing';
import type { GraphLayout, LayoutRequest } from '$lib/domain/trace-graph/layout';

const fixture = (): { before: GraphLayout; beforeRequest: LayoutRequest } =>
  JSON.parse(readFileSync(new URL('./hint-shrink-committed.json', import.meta.url), 'utf8'),
    (_key, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value);

it('prepays escaped property names and every occurrence of shared metadata', () => {
  const extra = { ['"\n'.repeat(1000)]: '\\\t'.repeat(1000) };
  for (const value of [extra, Array(5).fill(extra)]) {
    let work = 0;
    expect(prepayRoutingSerialization(value, amount => { work += amount; })).toBe(true);
    expect(work).toBeGreaterThanOrEqual(2 * JSON.stringify(value).length);
  }
});

it('bounds exponential alias expansion before serializing it', () => {
  let value: unknown = 'leaf';
  for (let i = 0; i < 40; i++) value = [value, value];
  const limit = 1_000_000, exhausted = { exhausted: true };
  let work = 0, actual: unknown;
  try {
    prepayRoutingSerialization(value, amount => {
      if (amount > limit - work) throw exhausted;
      work += amount;
    });
  } catch (error) { actual = error; }
  expect(actual).toBe(exhausted);
  expect(work).toBeLessThanOrEqual(limit);
});

it('declines cyclic, excessively nested and executable serialization inputs', () => {
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  let deep: unknown = 0;
  for (let i = 0; i < 256; i++) deep = [deep];
  let executed = false;
  for (const value of [cycle, deep, { toJSON() { executed = true; return 1; } }, { extra: 1n }, Object(1n),
    new Number(1), new Boolean(true), new String('value')])
    expect(prepayRoutingSerialization(value, () => {})).toBe(false);
  expect(executed).toBe(false);
});

it('checks effective depth when a child subtree was already counted through another alias', () => {
  const chains: unknown[] = [];
  let child: unknown = 0;
  for (let i = 0; i < 256; i++) { child = { child }; chains.push(child); }
  expect(prepayRoutingSerialization(chains, () => {})).toBe(false);
});

it('withholds unchargeable property names and cyclic metadata at the actual routing boundary', () => {
  for (const mode of ['plain', 'key', 'cycle', 'boxed'] as const) {
    const { before, beforeRequest } = fixture(), extra: Record<string, unknown> = {};
    if (mode === 'key') extra['k'.repeat(2_000_000)] = 0;
    if (mode === 'cycle') extra.self = extra;
    if (mode === 'boxed') extra.value = Object(1n);
    const source = { ...before, routes: before.routes.map((route, index) => index ? route
      : { ...route, from: { ...route.from, extra } }) };
    const result = routeCommittedIncremental(beforeRequest, source, drawing => drawing, 1_000_000, undefined,
      hintRoutingFrame(new Map()));
    expect(result.work).toBeLessThanOrEqual(1_000_000);
    if (mode === 'plain') expect(result.ok, JSON.stringify(result)).toBe(true);
    else expect(result).toMatchObject({ ok: false, conflict: { reason: mode === 'key' ? 'budget-exhaustion' : 'unsupported-input' } });
  }
});
