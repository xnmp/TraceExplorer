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
  readonly remaining: number;
  readonly growth: { readonly left: number; readonly right: number };
  grow(left: number, right: number): never;
  boundaryFeasible(): void;
  charge(work?: number, reason?:string): void;
  /** Admit a bounded subsearch before execution; settle only its own unused
   * reservation on normal return. Other charges and exceptional exits persist. */
  reserve<T>(maximum: number, execute: () => { readonly value: T; readonly work: number }, reason?: string): T;
  choose<T>(id: string, choices: readonly T[]): T;
  solve(problem: SeparationProblem, decisions?: readonly string[]): SeparationResult & { readonly ok: true };
  reject(constraints: readonly string[], kind?: CorridorConflict['kind'], decisions?: readonly string[]): never;
}
class Rejected {
  constructor(readonly conflict: CorridorConflict, readonly decisions?: readonly string[]) {}
}
interface Decision { readonly id: string; readonly index: number; readonly count: number }

export function searchCorridors<T>(construct: (search: CorridorSearch) => T, budget = 250_000,
  objective?: { readonly score: (value:T, search:CorridorSearch)=>number; readonly samples:number }): CorridorResult<T> {
  if (!Number.isSafeInteger(budget) || budget < 0 || objective && (!Number.isSafeInteger(objective.samples) || objective.samples<1)) return { ok: false, conflict: { kind: 'invalid', constraints: ['budget'] }, work: 0, candidates: 0 };
  let work = 0, candidates = 0, cursor = 0, boundaryCandidates = 0;
  let growth = { left: 0, right: 0 }, requested = { left: 0, right: 0 };
  const decisions: Decision[] = [];
  const reject: CorridorSearch['reject'] = (constraints, kind = 'topology', decisions) => { throw new Rejected({ kind, constraints }, decisions); };
  let previousConflict: CorridorConflict | undefined;
  let best: {value:T;score:number} | undefined;
  let solutions=0;
  const success=():CorridorResult<T>=>({ok:true,value:best!.value,work,candidates});
  const charge = (amount = 1, reason = "construction") => {
    if (!Number.isSafeInteger(amount) || amount < 0) reject(['work'], 'invalid');
    if (amount > budget - work) reject(['total work budget',reason,`requested:${amount}`,`used:${work}`,...(previousConflict?.constraints??[])], 'search-exhausted');
    work += amount;
  };
  const search: CorridorSearch = {
    charge, reject,
    reserve(maximum, execute, reason = 'bounded construction') {
      charge(maximum, reason);
      const result = execute();
      if (!Number.isSafeInteger(result.work) || result.work < 0 || result.work > maximum)
        return reject(['reservation settlement', reason], 'invalid');
      work -= maximum - result.work;
      return result.value;
    },
    get remaining() { return budget - work; },
    get growth() { return growth; },
    boundaryFeasible() { requested={left:0,right:0}; },
    grow(left, right) {
      if (![left,right].every(n=>Number.isFinite(n) && n>=0)) return reject(['free boundary growth'], 'invalid');
      requested = {left:Math.max(requested.left,Math.ceil(left)),right:Math.max(requested.right,Math.ceil(right))};
      return reject(['channel capacity']);
    },
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
    solve(problem, decisions) {
      // The separation implementation performs a fixed number of linear passes.
      charge(8 * (problem.variables.length + problem.separations.length + 1));
      const result = solveSeparation(problem);
      if (!result.ok) return reject(result.conflict.constraints, 'metric', decisions);
      return result;
    },
  };
  for (;;) {
    cursor = 0;
    try {
      const startWork=work;
      charge(); candidates++; boundaryCandidates++;
      const value = construct(search);
      if(!objective) return { ok:true,value,work,candidates };
      decisions.length=cursor;
      let at=decisions.length-1;
      while(at>=0 && decisions[at].index+1>=decisions[at].count) at--;
      // No competing topology: objective ranking is vacuous.
      if(candidates===1 && at<0) return {ok:true,value,work,candidates};
      const score=objective.score(value,search);
      if(!Number.isFinite(score)) reject(['quality']);
      if(!best || score<best.score) best={value,score};
      solutions++;
      // Optimization is optional once a complete feasible candidate exists.
      // Reserve a full construction before starting another scored sample.
      if(solutions>=objective.samples || at<0 || budget-work<2*(work-startWork)) return success();
      decisions[at]={...decisions[at],index:decisions[at].index+1};
      decisions.length=at+1;
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      // charge() checks before starting work. Optional optimization can stop
      // at that boundary with its already complete feasible incumbent.
      if(best && error.conflict.kind!=='invalid') return success();
      if (error.conflict.kind === 'search-exhausted' || error.conflict.kind === 'invalid')
        return { ok: false, conflict: error.conflict, work, candidates };
      previousConflict = error.conflict;
      decisions.length = cursor;
      let at = decisions.length - 1;
      if (error.decisions) while (at>=0 && !error.decisions.includes(decisions[at].id)) at--;
      while (at >= 0 && (decisions[at].index + 1 >= decisions[at].count || error.decisions && !error.decisions.includes(decisions[at].id))) at--;
      // At least one alternative assignment is constructed before capacity is
      // increased. Boundary retries consume this same ledger, never a fresh one.
      if ((at < 0 || boundaryCandidates >= 2) && (requested.left || requested.right)) {
        growth = {left:growth.left+requested.left,right:growth.right+requested.right};
        requested = {left:0,right:0}; decisions.length = 0; boundaryCandidates = 0;
        continue;
      }
      if (at < 0) return { ok: false, conflict: error.conflict, work, candidates };
      decisions[at] = { ...decisions[at], index: decisions[at].index + 1 };
      decisions.length = at + 1;
    }
  }
}
