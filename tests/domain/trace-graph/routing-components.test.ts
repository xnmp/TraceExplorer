import { describe, expect, it } from 'vitest';
import { solveRoutingComponents, type RoutingMetricProblem } from '../../../src/lib/domain/trace-graph/routing-components';

const variable = (id: string, preferred: number, pin?: number) => ({ id, preferred, ...(pin === undefined ? {} : { pin: { value: pin, reason: 'retained' } }) });
const edge = (before: string, after: string, gap: number) => ({ id: before + '→' + after, before, after, gap });
const problem = (variables: RoutingMetricProblem['variables'], separations: RoutingMetricProblem['separations']): RoutingMetricProblem =>
  ({ variables, order: variables.map(v => v.id), separations });

describe('affected metric components with exact retained constants', () => {
  it('keeps a common fixed port from coupling two independent free regions', () => {
    const p = problem([variable('port', 0, 0), variable('left', 1), variable('right', 20)], [edge('port', 'left', 3), edge('port', 'right', 3)]);
    const result = solveRoutingComponents(p);
    expect(result).toMatchObject({ ok: true, solved: [['left']] });
    if (result.ok) expect([...result.positions]).toEqual([['port', 0], ['left', 3], ['right', 20]]);
  });
  it('solves a coupled free neighborhood together while leaving other coordinates exact', () => {
    const p = { ...problem([variable('port', 10, 10), variable('a', 11), variable('b', 12), variable('unrelated', .1)], [edge('port', 'a', 3), edge('a', 'b', 3)]), dependencies: [['a', 'b']] };
    const result = solveRoutingComponents(p);
    expect(result).toMatchObject({ ok: true, solved: [['a', 'b']] });
    if (result.ok) expect([...result.positions]).toEqual([['port', 10], ['a', 13], ['b', 16], ['unrelated', .1]]);
  });
  it('propagates an interior pin backward into its free predecessor', () => {
    const p = problem([variable('a', 100), variable('pin', 10, 10), variable('b', 100)], [edge('a', 'pin', 3), edge('pin', 'b', 3)]);
    const result = solveRoutingComponents(p);
    expect(result).toMatchObject({ ok: true, solved: [['a']] });
    if (result.ok) expect([...result.positions]).toEqual([['a', 7], ['pin', 10], ['b', 100]]);
  });
  it('retains fixed obstacles in each solve after substitution', () => {
    const p = problem([variable('start', 0, 0), variable('free', 0), variable('end', 5, 5)], [edge('start', 'free', 3), edge('free', 'end', 3)]);
    expect(solveRoutingComponents(p)).toMatchObject({ ok: false, conflict: { kind: 'metric' } });
  });
  it('reports a contradictory saved equality with both pin reasons', () => {
    const p = { ...problem([variable('n4.y', 321, 321)], []), equalities: [{ id: 'saved-revisit', variable: 'n4.y', value: 312 }] };
    expect(solveRoutingComponents(p)).toEqual({ ok: false, conflict: { kind: 'equality', variable: 'n4.y', constraints: ['n4.y:pin', 'saved-revisit'] } });
  });
  it('does not replace the bit pattern of a retained signed zero', () => {
    const p = { ...problem([variable('zero', 0, -0)], []), equalities: [{ id: 'different-zero', variable: 'zero', value: 0 }] };
    expect(solveRoutingComponents(p)).toMatchObject({ ok: false, conflict: { kind: 'equality' } });
  });
  it('never substitutes a close or very large coordinate for the original binary64 pin', () => {
    for (const pin of [.1, 2 ** 40 + .125, Number.MAX_VALUE]) {
      const p = problem([variable('pin', 0, pin)], []);
      const result = solveRoutingComponents(p, ['pin']);
      expect(result.ok && result.positions.get('pin')).toBe(pin);
      expect(result).toMatchObject({ ok: true, solved: [] });
    }
  });
  it('keeps an already feasible disconnected drawing byte-exact and does no solves', () => {
    const p = problem([variable('a', .1), variable('b', .1 + 3), variable('c', -0)], [edge('a', 'b', 3)]);
    const result = solveRoutingComponents(p);
    expect(result).toMatchObject({ ok: true, solved: [] });
    if (result.ok) expect(Object.is(result.positions.get('c'), -0)).toBe(true);
  });
  it('honors explicitly affected free dependencies after eliminating fixed entries', () => {
    const p = { ...problem([variable('fixed', 0, 0), variable('a', 1), variable('b', 2), variable('c', 3)], []), dependencies: [['fixed', 'a'], ['fixed', 'b', 'c']] };
    expect(solveRoutingComponents(p, ['a'])).toMatchObject({ ok: true, solved: [['a']] });
  });
  it.each([
    { ...problem([variable('a', NaN)], []) },
    { ...problem([variable('a', 1)], []), order: ['missing'] },
    { ...problem([variable('a', 1)], []), equalities: [{ id: 'bad', variable: 'missing', value: 1 }] },
    { ...problem([variable('a', 1)], []), dependencies: [['missing']] },
    problem([variable('a', 1), variable('b', 2)], [edge('b', 'a', 3)]),
    problem([variable('a', 1), variable('b', 2)], [edge('a', 'b', Infinity)]),
  ])('rejects malformed chosen topologies before using them (%#)', p => {
    expect(solveRoutingComponents(p)).toMatchObject({ ok: false, conflict: { kind: 'invalid' } });
  });
  it('charges skipped and solved work to the caller ledger and does not swallow exhaustion', () => {
    const charges: number[] = [];
    solveRoutingComponents(problem([variable('a', 0), variable('b', 1)], [edge('a', 'b', 3)]), [], work => charges.push(work));
    expect(charges.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const stop = new Error('exhausted');
    expect(() => solveRoutingComponents(problem([], []), [], () => { throw stop; })).toThrow(stop);
  });
  it('bounds whole-problem scans across many independent local solves', () => {
    const count = 1000, free = Array.from({ length: count }, (_, i) => variable('free:' + i, 1));
    const p = problem([variable('port', 0, 0), ...free], free.map(v => edge('port', v.id, 3)));
    let remaining = 100_000;
    const exhausted = new Error('shared ledger exhausted');
    expect(() => solveRoutingComponents(p, [], work => {
      if (work > remaining) throw exhausted;
      remaining -= work;
    })).toThrow(exhausted);
  });
  it('charges repeated affected identities before scanning them', () => {
    const exhausted = new Error('affected list budget');
    expect(() => solveRoutingComponents(problem([variable('fixed', 0, 0)], []), Array(10_000).fill('fixed'), work => {
      if (work > 1000) throw exhausted;
    })).toThrow(exhausted);
  });
});
