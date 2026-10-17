import { expect, it } from 'vitest';
import { solveOrderedTracks } from '$lib/domain/trace-graph/ordered-tracks';

it('grows a zone to respect port departure and parallel track berths', () => {
  const solved = solveOrderedTracks(3, 6, 6, 3);
  expect(solved.ok && Object.fromEntries(solved.positions)).toEqual({ 0: 6, 1: 9, 2: 12, end: 15 });
});

it('differentially preserves pre-consolidation plain zone heights and spreading', () => {
  for (const leading of [3, 6]) for (const minimum of [6, 12, 25, 30, 40]) for (let count = 1; count <= 20; count++) {
    const tall = Math.max(minimum, (count - 1) * 3 + 3 + leading);
    const last = tall - 3;
    const solved = solveOrderedTracks(count, minimum, leading, 3);
    expect(solved.ok).toBe(true);
    if (solved.ok) {
      expect(solved.positions.get('end')).toBe(tall);
      for (let i = 0; i < count; i++) expect(solved.positions.get(`${i}`)).toBe(count === 1 ? (leading + last) / 2 : leading + (last - leading) * i / (count - 1));
    }
  }
});

it('rejects malformed dimensions and track counts explicitly', () => {
  for (const count of [0, -1, .5, Infinity, NaN]) expect(solveOrderedTracks(count, 6, 3, 3)).toMatchObject({ ok: false });
  expect(solveOrderedTracks(1, NaN, 3, 3)).toMatchObject({ ok: false });
});
