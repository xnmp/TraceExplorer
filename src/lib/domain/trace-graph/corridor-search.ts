/** Deterministic topology search. One work ledger covers every construction,
 * constraint solve, backtrack and boundary alternative in a request. */
import { solveSeparation, type SeparationProblem, type SeparationResult } from './separation';

export interface CorridorConflict {
  readonly kind: 'topology' | 'metric' | 'search-exhausted' | 'invalid';
  readonly constraints: readonly string[];
}
export type CorridorResult<T> = { readonly ok: true; readonly value: T; readonly work: number; readonly candidates: number }
  | { readonly ok: false; readonly conflict: CorridorConflict; readonly work: number; readonly candidates: number };
export interface CorridorSearch {
  charge(work?: number): void;
  choose<T>(id: string, choices: readonly T[]): T;
  solve(problem: SeparationProblem): SeparationResult & { readonly ok: true };
  reject(constraints: readonly string[], kind?: CorridorConflict['kind']): never;
}
class Rejected {
  constructor(readonly conflict: CorridorConflict) {}
}
interface Decision { readonly id: string; readonly index: number; readonly count: number }

export function searchCorridors<T>(construct: (search: CorridorSearch) => T, budget = 250_000): CorridorResult<T> {
  if (!Number.isSafeInteger(budget) || budget < 0) return { ok: false, conflict: { kind: 'invalid', constraints: ['budget'] }, work: 0, candidates: 0 };
  let work = 0, candidates = 0, cursor = 0;
  const decisions: Decision[] = [];
  const reject: CorridorSearch['reject'] = (constraints, kind = 'topology') => { throw new Rejected({ kind, constraints }); };
  const charge = (amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0) reject(['work'], 'invalid');
    if (amount > budget - work) reject(['total work budget'], 'search-exhausted');
    work += amount;
  };
  const search: CorridorSearch = {
    charge, reject,
    choose(id, choices) {
      charge(choices.length + 1);
      if (!choices.length) return reject([id]);
      const saved = decisions[cursor];
      if (saved && saved.id !== id) decisions.length = cursor;
      const index = decisions[cursor]?.index ?? 0;
      if (index >= choices.length) return reject([id]);
      decisions[cursor++] = { id, index, count: choices.length };
      return choices[index];
    },
    solve(problem) {
      // The separation implementation performs a fixed number of linear passes.
      charge(8 * (problem.variables.length + problem.separations.length + 1));
      const result = solveSeparation(problem);
      if (!result.ok) return reject(result.conflict.constraints, 'metric');
      return result;
    },
  };
  for (;;) {
    cursor = 0;
    try {
      charge(); candidates++;
      const value = construct(search);
      return { ok: true, value, work, candidates };
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      if (error.conflict.kind === 'search-exhausted' || error.conflict.kind === 'invalid')
        return { ok: false, conflict: error.conflict, work, candidates };
      decisions.length = cursor;
      let at = decisions.length - 1;
      while (at >= 0 && decisions[at].index + 1 >= decisions[at].count) at--;
      if (at < 0) return { ok: false, conflict: error.conflict, work, candidates };
      decisions[at] = { ...decisions[at], index: decisions[at].index + 1 };
      decisions.length = at + 1;
    }
  }
}
