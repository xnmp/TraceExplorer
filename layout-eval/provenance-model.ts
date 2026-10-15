/**
 * A seeded generative model of realistic provenance folders, for layout evaluation.
 *
 * The Trace view draws what AI image editing leaves behind in a folder. One session is a
 * sequence of events, each one of:
 * - an import: a new image appears in the folder (a new root, a section only once edited);
 * - an edit: one or more input images produce `batch` outputs (variations).
 *
 * An edit's primary input is the image just created with probability `continueChain` (an edit of
 * an edit: chains), otherwise an earlier image chosen with weight `recency^age` (going back to try
 * another variation: fans), or, with probability `fresh`, the newest import. With probability
 * `merge` the edit also takes 1..`maxExtraInputs` further inputs: an earlier folder image (a
 * combination, which joins two lineages) or, with probability `reference`, a reference image from
 * outside the folder (a style), reused from a small pool with probability `reuse` (references become
 * badges, not tiles).
 *
 * `observed` reproduces the shapes of the one real folder measured (single-input edits only, fans of
 * up to three, chains up to three deep, half the edits continuing from the image just made; see
 * docs/trace-view-layout.md, "Optimality gap"). That folder is a sanity check, not a prior: it holds
 * 22 runs. The other profiles span what the product allows (one to eight inputs per edit, one to
 * eight outputs per prompt, references from outside the folder, retries) at frequencies taken from
 * public raw data where it exists (docs/trace-view-layout.md, "Workflow shapes"):
 * - `mj`: Midjourney's Discord lineage (3.0 M bot messages, 2023): 19% of image-conditioned jobs
 *   combine several images, in-degrees 2-8 as measured (`MJ_EXTRA_INPUTS`), half of all reference
 *   uses reuse an earlier one, and every job makes a batch of four.
 * - `merge-k8` and `batch8` push merges (35%, every extra input a folder image) and batches (eight
 *   outputs) to the product's limits; `variations`, `chains`, `combinations` and `mixed` stretch one
 *   dimension each. They bound what the engine must survive, not what users do.
 */
import type { TraceNode } from '../src/lib/domain/trace-graph/model';
import { rng } from './corpus';

export interface ProvenanceParams {
  /** Edits and imports in the session. */
  readonly events: number;
  /** Probability that an event imports a new image instead of editing. */
  readonly importRate: number;
  readonly continueChain: number;
  /** Geometric decay of the chance to go back to an older image (per image of age). */
  readonly recency: number;
  readonly fresh: number;
  readonly merge: number;
  readonly maxExtraInputs: number;
  readonly reference: number;
  readonly reuse: number;
  /** Probability of each further output of one edit (variations in one batch), at most `maxBatch`. */
  readonly batch: number;
  readonly maxBatch: number;
  /** Relative weights of 1, 2, … further inputs of a combination; replaces the uniform 1..`maxExtraInputs`. */
  readonly extraInputs?: readonly number[];
  /** Relative weights of batches of 1, 2, … outputs; replaces `batch` and `maxBatch`. */
  readonly batches?: readonly number[];
}

/**
 * Further inputs of a combination (in-degree 2..8, the product's limit), from the image links of
 * 40,161 multi-image Midjourney jobs (2023): 27,629 with 2 images, 6,654 with 3, 2,673 with 4,
 * 2,009 with 5, 429 with 6, 290 with 7 and 477 with 8 or more (folded into 8).
 */
export const MJ_EXTRA_INPUTS: readonly number[] = Object.freeze([27629, 6654, 2673, 2009, 429, 290, 477]);

export const profiles: Readonly<Record<string, ProvenanceParams>> = Object.freeze({
  observed: { events: 25, importRate: .35, continueChain: .2, recency: .6, fresh: .3, merge: 0, maxExtraInputs: 1, reference: 0, reuse: 0, batch: 0, maxBatch: 1 },
  variations: { events: 40, importRate: .15, continueChain: .3, recency: .85, fresh: .15, merge: .05, maxExtraInputs: 1, reference: .5, reuse: .7, batch: .6, maxBatch: 4 },
  chains: { events: 40, importRate: .1, continueChain: .85, recency: .6, fresh: .1, merge: .05, maxExtraInputs: 1, reference: .5, reuse: .7, batch: .1, maxBatch: 2 },
  combinations: { events: 40, importRate: .2, continueChain: .45, recency: .8, fresh: .15, merge: .35, maxExtraInputs: 2, reference: .4, reuse: .6, batch: .2, maxBatch: 3 },
  mixed: { events: 60, importRate: .15, continueChain: .5, recency: .8, fresh: .15, merge: .15, maxExtraInputs: 2, reference: .4, reuse: .6, batch: .35, maxBatch: 4 },
  mj: { events: 40, importRate: .2, continueChain: .45, recency: .8, fresh: .15, merge: .19, maxExtraInputs: 7, reference: .4, reuse: .55, batch: 0, maxBatch: 4, extraInputs: MJ_EXTRA_INPUTS, batches: [0, 0, 0, 1] },
  "merge-k8": { events: 40, importRate: .2, continueChain: .45, recency: .8, fresh: .15, merge: .35, maxExtraInputs: 7, reference: 0, reuse: 0, batch: 0, maxBatch: 1, extraInputs: MJ_EXTRA_INPUTS },
  batch8: { events: 40, importRate: .2, continueChain: .45, recency: .8, fresh: .15, merge: .05, maxExtraInputs: 1, reference: .4, reuse: .55, batch: 0, maxBatch: 8, batches: [0, 0, 0, 0, 0, 0, 0, 1] },
});

/** Index drawn with probability proportional to `weights[index]` (all finite and nonnegative, some positive). */
function weighted(weights: readonly number[], random: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let k = 0; k < weights.length; k++) { r -= weights[k]; if (r < 0) return k; }
  return weights.length - 1;
}

const image = (key: string, parents: readonly string[], order: number, scope: TraceNode['scope'] = 'current'): TraceNode => ({
  key, parents, order, artifactId: order, runId: parents.length ? order : null, path: `${key}.png`, scope, location: '', state: 'present',
  temporary: false, discarded: false, earlierRevision: false, prompt: key,
});

/** One session's images in creation order (`order`), references included. Deterministic in `seed`. */
export function provenanceSession(params: ProvenanceParams, seed: number): TraceNode[] {
  const random = rng(seed * 2654435761 + 1), nodes: TraceNode[] = [], folder: number[] = [], imports: number[] = [], styles: string[] = [];
  const add = (parents: readonly string[], scope: TraceNode['scope'] = 'current') => {
    const n = image(`i${nodes.length}`, parents, nodes.length, scope);
    nodes.push(n);
    if (scope === 'current') folder.push(nodes.length - 1);
    return n;
  };
  /** An earlier folder image, newer ones likelier (weight recency^age), excluding `not`. */
  const earlier = (not: ReadonlySet<number>): number | null => {
    const pool = folder.filter(i => !not.has(i));
    if (!pool.length) return null;
    const weights = pool.map((_, k) => params.recency ** (pool.length - 1 - k)), total = weights.reduce((a, b) => a + b, 0);
    let r = random() * total;
    for (let k = 0; k < pool.length; k++) { r -= weights[k]; if (r <= 0) return pool[k]; }
    return pool[pool.length - 1];
  };
  add([]);
  imports.push(0);
  for (let e = 1; e < params.events; e++) {
    if (random() < params.importRate) { add([]); imports.push(nodes.length - 1); continue; }
    const last = folder[folder.length - 1];
    const primary = random() < params.continueChain ? last : random() < params.fresh ? imports[imports.length - 1] : earlier(new Set()) ?? last;
    const inputs = [nodes[primary].key];
    if (random() < params.merge) {
      const extra = 1 + (params.extraInputs ? weighted(params.extraInputs, random) : Math.floor(random() * params.maxExtraInputs));
      for (let k = 0; k < extra; k++) {
        if (random() < params.reference) {
          const style = styles.length && random() < params.reuse ? styles[Math.floor(random() * styles.length)] : add([], 'external').key;
          if (!styles.includes(style)) styles.push(style);
          if (!inputs.includes(style)) inputs.push(style);
        } else {
          const other = earlier(new Set(inputs.map(key => Number(key.slice(1)))));
          if (other !== null) inputs.push(nodes[other].key);
        }
      }
    }
    let outputs = 1;
    if (params.batches) outputs = 1 + weighted(params.batches, random);
    else while (outputs < params.maxBatch && random() < params.batch) outputs++;
    for (let k = 0; k < outputs; k++) add(inputs);
  }
  return nodes;
}

/** Connected components (through folder images; a shared reference does not join them), each in creation order, with at least one edge. */
export function sessionComponents(nodes: readonly TraceNode[]): TraceNode[][] {
  const parent = nodes.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  for (const [i, n] of nodes.entries()) for (const p of n.parents) {
    const j = index.get(p)!;
    if (nodes[j].scope === 'current') parent[find(i)] = find(j);
  }
  const groups = new Map<number, TraceNode[]>();
  for (const [i, n] of nodes.entries()) if (n.scope === 'current') { const root = find(i); groups.set(root, [...groups.get(root) ?? [], n]); }
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    // References used by the component travel with it.
    const keys = new Set(g.map(n => n.key)), refs = nodes.filter(n => n.scope !== 'current' && g.some(m => m.parents.includes(n.key)));
    return [...g, ...refs].filter((n, i, all) => all.findIndex(m => m.key === n.key) === i && (keys.has(n.key) || n.scope !== 'current')).sort((a, b) => a.order - b.order);
  });
}
