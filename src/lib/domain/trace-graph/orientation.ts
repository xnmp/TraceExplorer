/**
 * Which way a component's generations run (dagre's `rankdir` TB vs LR).
 *
 * The rule looks only at the whole component and the pane width, never at
 * the focus or which tiles are currently shown, so selecting nodes can never
 * flip a component between orientations (tiles would jump). It changes only
 * when the pane is resized across the threshold or the component itself
 * gains or loses images.
 *
 * A component runs left to right when
 * - it has at least two generations,
 * - it has at least as many generations as its widest generation has images
 *   (top to bottom it would be at least as tall as it is wide), and
 * - all its generations fit side by side in the pane.
 * Otherwise it runs top to bottom, where wide generations wrap onto rows.
 */
import type { NodeKey } from "./model";
import type { TraceDag } from "./projection";
import type { Orientation } from "./layout";
import { SPACING, TILE } from "./metrics";

export interface GenerationProfile {
  /** Number of generations (longest parent chain, counted in images). */
  readonly depth: number;
  /** Images in the largest generation. */
  readonly breadth: number;
}

/**
 * Longest-path generations over the component's own relationships, the same
 * bands the layout engine uses. Iterative (Kahn), so deep chains are safe;
 * relationships closing a cycle (rejected upstream) are ignored.
 */
export function generationProfile(dag: TraceDag, members: readonly NodeKey[]): GenerationProfile {
  const inside = new Set(members);
  const generation = new Map<NodeKey, number>();
  const waiting = new Map<NodeKey, number>();
  const ready: NodeKey[] = [];
  for (const key of inside) {
    const count = (dag.parents.get(key) ?? []).filter((parent) => inside.has(parent)).length;
    waiting.set(key, count);
    if (count === 0) { ready.push(key); generation.set(key, 0); }
  }
  for (let index = 0; index < ready.length; index++) {
    const key = ready[index];
    const level = generation.get(key)!;
    for (const child of dag.children.get(key) ?? []) {
      if (!inside.has(child)) continue;
      generation.set(child, Math.max(generation.get(child) ?? 0, level + 1));
      const left = waiting.get(child)! - 1;
      waiting.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  const sizes = new Map<number, number>();
  for (const key of ready) { const level = generation.get(key)!; sizes.set(level, (sizes.get(level) ?? 0) + 1); }
  return { depth: sizes.size, breadth: [...sizes.values()].reduce((most, size) => Math.max(most, size), 0) };
}

/** Canvas width of `depth` generations side by side (junction levels can add a little; the canvas then scrolls). */
export function sidewaysWidth(depth: number): number {
  return depth <= 0 ? 0 : SPACING.top + depth * TILE.width + (depth - 1) * SPACING.bandChannel + SPACING.bottom;
}

export function chooseOrientation(profile: GenerationProfile, maxWidth: number): Orientation {
  const budget = Number.isFinite(maxWidth) || maxWidth === Infinity ? maxWidth : 0;
  const { depth, breadth } = profile;
  return depth >= 2 && depth >= breadth && budget > 0 && sidewaysWidth(depth) <= budget ? "right" : "down";
}

export function componentOrientation(dag: TraceDag, members: readonly NodeKey[], maxWidth: number): Orientation {
  return chooseOrientation(generationProfile(dag, members), maxWidth);
}
