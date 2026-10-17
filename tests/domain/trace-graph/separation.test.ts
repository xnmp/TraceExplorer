import { describe, expect, it } from 'vitest';
import { solveChannel, solveSeparation, type SeparationProblem } from '$lib/domain/trace-graph/separation';

const positions = (problem: SeparationProblem) => {
  const result = solveSeparation(problem);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.conflict));
  return Object.fromEntries(result.positions);
};

describe('ordered separation constraints', () => {
  it('moves free tracks on both sides of an exact interior pin', () => {
    expect(positions({
      variables: [{ id: 'a', preferred: 8 }, { id: 'b', preferred: 100, pin: { value: 6, reason: 'retained' } }, { id: 'c', preferred: 0 }],
      order: ['a', 'b', 'c'], separations: [{ id: 'ab', before: 'a', after: 'b', gap: 3 }, { id: 'bc', before: 'b', after: 'c', gap: 3 }],
    })).toEqual({ a: 3, b: 6, c: 9 });
  });

  it('returns the conflicting bounds and separation instead of squeezing a channel', () => {
    const result = solveSeparation({ variables: [{ id: 'a', preferred: 0, bounds: { lower: 0 } }, { id: 'b', preferred: 2, bounds: { upper: 2 } }],
      order: ['a', 'b'], separations: [{ id: 'clearance', before: 'a', after: 'b', gap: 3 }] });
    expect(result).toMatchObject({ ok: false, conflict: { constraints: ['a:lower', 'clearance', 'b:upper'] } });
  });

  it('names infeasible exact pins and never silently unpins', () => {
    const result = solveSeparation({ variables: [{ id: 'a', preferred: 0, pin: { value: 6, reason: 'old track' } }, { id: 'b', preferred: 0, pin: { value: 8, reason: 'old track' } }],
      order: ['a', 'b'], separations: [{ id: 'clearance', before: 'a', after: 'b', gap: 3 }] });
    expect(result).toMatchObject({ ok: false, conflict: { constraints: ['a:pin', 'clearance', 'b:pin'] } });
  });

  it('inserts an ordered track between pins without perturbing either endpoint', () => {
    expect(positions({ variables: [{ id: 'old-a', preferred: 0, pin: { value: 3, reason: 'old' } }, { id: 'new', preferred: 3 }, { id: 'old-b', preferred: 0, pin: { value: 9, reason: 'old' } }],
      order: ['old-a', 'new', 'old-b'], separations: [{ id: 'a-new', before: 'old-a', after: 'new', gap: 3 }, { id: 'new-b', before: 'new', after: 'old-b', gap: 3 }] })).toEqual({ 'old-a': 3, new: 6, 'old-b': 9 });
  });

  it('is deterministic under variable and constraint storage permutations', () => {
    const problem: SeparationProblem = { variables: [{ id: 'a', preferred: 4 }, { id: 'b', preferred: 2 }, { id: 'c', preferred: 1 }], order: ['a', 'b', 'c'],
      separations: [{ id: 'ac', before: 'a', after: 'c', gap: 3 }, { id: 'bc', before: 'b', after: 'c', gap: 3 }] };
    expect(positions({ ...problem, variables: [...problem.variables].reverse(), separations: [...problem.separations].reverse() })).toEqual(positions(problem));
  });

  it('reports malformed orders and nonfinite data explicitly', () => {
    expect(solveSeparation({ variables: [{ id: 'a', preferred: NaN }], order: ['a'], separations: [] })).toMatchObject({ ok: false });
    expect(solveSeparation({ variables: [{ id: 'a', preferred: 0 }], order: ['missing'], separations: [] })).toMatchObject({ ok: false });
    expect(solveSeparation({ variables: [{ id: 'a', preferred: 0 }], order: ['a'], separations: [{ id: 'cycle', before: 'a', after: 'a', gap: 3 }] })).toMatchObject({ ok: false });
  });

  it('preserves feasible preferred positions exactly, including fractional pins', () => {
    expect(positions({ variables: [{ id: 'a', preferred: 2.125, pin: { value: 2.125, reason: 'exact' } }, { id: 'b', preferred: 7.375 }], order: ['a', 'b'], separations: [{ id: 'ab', before: 'a', after: 'b', gap: 3 }] })).toEqual({ a: 2.125, b: 7.375 });
  });
});

describe('swept channel intervals', () => {
  it('reuses tracks across disconnected lifetimes and compatible shared trunks', () => {
    const result = solveChannel({ segments: [
      { id: 'a', preferred: 0, span: [0, 4], net: 'source-a' },
      { id: 'branch', preferred: 0, span: [1, 3], net: 'source-a' },
      { id: 'b', preferred: 0, span: [3, 8] },
      { id: 'c', preferred: 0, span: [8, 12] },
    ], order: ['a', 'branch', 'b', 'c'], gap: 3 });
    expect(result.ok && Object.fromEntries(result.positions)).toEqual({ a: 0, branch: 0, b: 3, c: 0 });
  });

  it('differentially matches left-edge allocation over interval lifetimes', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const segments = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, preferred: 0, span: [i, i + 1 + (seed * (i + 3) % 5)] as const }));
      const expected: number[] = [];
      segments.forEach((s, i) => { expected[i] = Math.max(0, ...segments.slice(0, i).flatMap((p, j) => p.span[1] > s.span[0] ? [expected[j] + 3] : [])); });
      const solved = solveChannel({ segments, order: segments.map(s => s.id), gap: 3 });
      expect(solved.ok && [...solved.positions.values()]).toEqual(expected);
    }
  });
});
