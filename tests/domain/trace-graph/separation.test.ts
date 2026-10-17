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

  it('preserves decimal pins when reverse subtraction rounds below their value', () => {
    expect(positions({ variables: [{ id: 'a', preferred: .3, pin: { value: .3, reason: 'old' } },
      { id: 'b', preferred: 3.3, pin: { value: 3.3, reason: 'old' } }, { id: 'new', preferred: 0 }], order: ['a', 'b', 'new'],
      separations: [{ id: 'ab', before: 'a', after: 'b', gap: 3 }, { id: 'bn', before: 'b', after: 'new', gap: 3 }] })).toEqual({ a: .3, b: 3.3, new: 6.3 });
  });

  it('does not perturb a feasible decimal component while another component needs solving', () => {
    expect(positions({ variables: [{ id: 'a', preferred: .1 }, { id: 'b', preferred: 3.1 },
      { id: 'c', preferred: 6.1, pin: { value: 6.1, reason: 'old' } }, { id: 'd', preferred: 0 }, { id: 'e', preferred: 0 }],
      order: ['a', 'b', 'c', 'd', 'e'], separations: [{ id: 'ab', before: 'a', after: 'b', gap: 3 },
        { id: 'bc', before: 'b', after: 'c', gap: 3 }, { id: 'de', before: 'd', after: 'e', gap: 3 }] })).toEqual({ a: .1, b: 3.1, c: 6.1, d: 0, e: 3 });
  });

  it.each([[-.4, .3], [-.3, 3]])('finds a feasible free predecessor of a negative decimal pin (%s, gap %s)', (value, gap) => {
    const result = positions({ variables: [{ id: 'a', preferred: 10 }, { id: 'b', preferred: 0, pin: { value, reason: 'retained' } }],
      order: ['a', 'b'], separations: [{ id: 'ab', before: 'a', after: 'b', gap }] });
    expect(result.b).toBe(value);
    expect(result.a + gap).toBeLessThanOrEqual(value);
  });

  it('agrees with exhaustive bounded feasibility, including branching and interior pins', () => {
    for (let seed = 0; seed < 120; seed++) {
      const variables = Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, preferred: (seed + i * 3) % 7,
        bounds: { lower: 0, upper: 6 }, ...(seed % 3 === i ? { pin: { value: seed % 7, reason: 'retained' } } : {}) }));
      const separations = variables.flatMap((a, i) => variables.slice(i + 1).flatMap((b, j) =>
        (seed + i * 3 + j) % 3 ? [{ id: `${a.id}:${b.id}`, before: a.id, after: b.id, gap: 1 + seed % 3 }] : []));
      const feasible: number[][] = [];
      for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) for (let c = 0; c <= 6; c++) for (let d = 0; d <= 6; d++) {
        const values = [a, b, c, d];
        if (variables.every((v, i) => !v.pin || values[i] === v.pin.value)
          && separations.every(e => values[Number(e.after)] >= values[Number(e.before)] + e.gap)) feasible.push(values);
      }
      const result = solveSeparation({ variables, order: variables.map(v => v.id), separations });
      expect(result.ok, `seed ${seed}`).toBe(feasible.length > 0);
      if (result.ok) {
        const actual = [...result.positions.values()];
        expect(feasible).toContainEqual(actual);
        // On this integer population, clamping also prioritizes the earliest preference.
        expect(feasible.some(other => {
          const first = other.findIndex((v, i) => Math.abs(v - variables[i].preferred) !== Math.abs(actual[i] - variables[i].preferred));
          return first >= 0 && Math.abs(other[first] - variables[first].preferred) < Math.abs(actual[first] - variables[first].preferred);
        })).toBe(false);
      }
    }
  });

  it('handles a long ordered channel without copying every prefix witness', () => {
    const variables = Array.from({ length: 10000 }, (_, i) => ({ id: `${i}`, preferred: 0, bounds: { lower: 0 } }));
    const result = solveSeparation({ variables, order: variables.map(v => v.id),
      separations: variables.slice(1).map((v, i) => ({ id: `${i}`, before: `${i}`, after: v.id, gap: 3 })) });
    expect(result.ok && result.positions.get('9999')).toBe(29997);
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
