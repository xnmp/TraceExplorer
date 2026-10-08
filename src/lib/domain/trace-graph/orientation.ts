/**
 * Which way a component's generations run (dagre's `rankdir` TB vs LR).
 *
 * The rule looks only at the whole component's settled images and the pane
 * width, never at the focus or which tiles are currently shown, so selecting
 * nodes can never flip a component between orientations (tiles would jump).
 * Running and unsaved outputs do not count either: generating a batch into a
 * component, or discarding it, leaves its orientation alone.
 *
 * A component fits left to right when
 * - it has at least two generations,
 * - it has at least as many generations as its widest generation has images
 *   (top to bottom it would be at least as tall as it is wide), and
 * - all its generations fit side by side in the pane.
 * Otherwise it runs top to bottom, where wide generations wrap onto rows.
 *
 * Hysteresis: given the orientation it was last shown with, a component keeps
 * it until the rule fails by a clear margin (see `chooseOrientation`), so a
 * component near the threshold does not flip back and forth as images are
 * saved or the pane is resized by a few pixels.
 */
import type { NodeKey, TraceNode } from "./model";
import type { TraceDag } from "./projection";
import { TRACK_HEIGHT, type Orientation } from "./layout";
import { buildInputJunctions, type Junction } from "./junctions";
import { SPACING, TILE } from "./metrics";

export interface GenerationProfile {
  /** Number of generations (longest parent chain, counted in images). */
  readonly depth: number;
  /** Images in the largest generation. */
  readonly breadth: number;
  /**
   * Estimated width the channels between generations need beyond their plain
   * `bandChannel`, summed over the channels: junction levels and crowded bend
   * tracks. Estimated from the whole component, so it does not depend on the focus.
   */
  readonly channelExtra: number;
}

/** Whether a node counts toward its component's shape: running and unsaved (or discarded) outputs do not. */
export const settled = (node: TraceNode | undefined): boolean => !!node && node.state !== "running" && !node.temporary;

/**
 * Longest-path generations over the component's own relationships, the same
 * bands the layout engine uses, counting only settled images (unsaved ones
 * still carry their children's generations). Iterative (Kahn), so deep chains
 * are safe; relationships closing a cycle (rejected upstream) are ignored.
 */
export function generationProfile(dag: TraceDag, members: readonly NodeKey[]): GenerationProfile {
  // Focus changes re-plan a scene without changing its component: reuse the profile.
  const known = profiles.get(members);
  if (known?.dag === dag) return known.profile;
  const profile = computeProfile(dag, members);
  profiles.set(members, { dag, profile });
  return profile;
}

const profiles = new WeakMap<readonly NodeKey[], { readonly dag: TraceDag; readonly profile: GenerationProfile }>();

function computeProfile(dag: TraceDag, members: readonly NodeKey[]): GenerationProfile {
  const inside = new Set(members);
  const generation = new Map<NodeKey, number>();
  const waiting = new Map<NodeKey, number>();
  const ready: NodeKey[] = [];
  const parentsOf = (key: NodeKey) => (dag.parents.get(key) ?? []).filter((parent) => inside.has(parent));
  for (const key of inside) {
    const count = parentsOf(key).length;
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
  const counted = ready.filter((key) => settled(dag.nodes.get(key)));
  const sizes = new Map<number, number>();
  for (const key of counted) { const level = generation.get(key)!; sizes.set(level, (sizes.get(level) ?? 0) + 1); }
  const depth = counted.reduce((most, key) => Math.max(most, generation.get(key)! + 1), 0);
  const breadth = [...sizes.values()].reduce((most, size) => Math.max(most, size), 0);
  return { depth, breadth, channelExtra: channelExtra(counted, parentsOf, generation, depth) };
}

/**
 * Extra channel width (see `GenerationProfile.channelExtra`). Mirrors how the
 * engine sizes a channel: each junction level adds `junctionLevel`, and a
 * channel whose bends need more tracks than fit its default width grows by a
 * track per bend. Both are estimated over every settled relationship.
 */
function channelExtra(counted: readonly NodeKey[], parentsOf: (key: NodeKey) => NodeKey[], generation: ReadonlyMap<NodeKey, number>, depth: number): number {
  if (depth < 2) return 0;
  const relationships = counted.map((child) => ({ child, parents: parentsOf(child) })).filter((row) => row.parents.length > 0);
  const levels = junctionLevels(relationships.filter((row) => row.parents.length > 1), (id) => generation.get(id) ?? 0);
  // Distinct sources whose routes cross each channel, each of which may need
  // its own bend track there: a source crosses every channel from its own
  // generation to its deepest child's (a difference array keeps this linear).
  const reach = new Map<NodeKey, number>();
  for (const { child, parents } of relationships) for (const parent of parents) reach.set(parent, Math.max(reach.get(parent) ?? 0, generation.get(child)!));
  const delta = new Array<number>(depth + 1).fill(0);
  for (const [source, deepest] of reach) { delta[generation.get(source)!]++; delta[Math.min(deepest, depth)]--; }
  let extra = 0;
  for (let band = 0, tracks = 0; band < depth - 1; band++) {
    tracks += delta[band];
    const plain = SPACING.bandChannel + (levels.get(band) ?? 0) * SPACING.junctionLevel;
    extra += Math.max(plain, tracks * TRACK_HEIGHT) - SPACING.bandChannel;
  }
  return extra;
}

/** Above this many multi-input outputs, junction nesting is bounded rather than computed (grouping inputs is quadratic in them). */
const EXACT_JUNCTIONS = 200;

/**
 * Junction levels per generation channel, keyed by the band of each
 * junction's deepest parent, as the engine nests them: shared input subsets
 * combine first, one level above the junction they feed. For very many
 * multi-input outputs it falls back to an upper bound: an output with n
 * inputs nests at most n − 1 junctions.
 */
function junctionLevels(rows: readonly { readonly child: NodeKey; readonly parents: readonly NodeKey[] }[], band: (id: NodeKey) => number): Map<number, number> {
  const levels = new Map<number, number>();
  const raise = (at: number, level: number) => levels.set(at, Math.max(levels.get(at) ?? 0, level));
  const bandOf = (parents: readonly NodeKey[]) => parents.reduce((most, id) => Math.max(most, band(id)), 0);
  if (rows.length > EXACT_JUNCTIONS) {
    for (const row of rows) raise(bandOf(row.parents), row.parents.length - 1);
    return levels;
  }
  const plan = buildInputJunctions(rows);
  const joins = new Map(plan.joins.map((join) => [join.id, join]));
  const nesting = new Map<string, number>();
  const nest = (join: Junction): number => {
    const known = nesting.get(join.id);
    if (known !== undefined) return known;
    const inner = join.inputs.filter((input) => input.kind === "junction" && bandOf(joins.get(input.id)!.parents) === bandOf(join.parents));
    const value = 1 + inner.reduce((most, input) => Math.max(most, nest(joins.get(input.id)!)), 0);
    nesting.set(join.id, value);
    return value;
  };
  for (const join of plan.joins) raise(bandOf(join.parents), nest(join));
  return levels;
}

/** Canvas width of the profile's generations side by side. */
export function sidewaysWidth(profile: GenerationProfile): number {
  const { depth, channelExtra: extra } = profile;
  return depth <= 0 ? 0 : SPACING.top + depth * TILE.width + (depth - 1) * SPACING.bandChannel + extra + SPACING.bottom;
}

/**
 * Margins of the hysteresis band. Leaving left to right needs a generation
 * clearly broader than the component is deep; entering it needs the component
 * clearly deeper than broad and clear room in the pane. Width never gets
 * slack the other way: a left-to-right canvas stays within the pane.
 */
const KEEP_BREADTH = (depth: number) => Math.max(1, Math.floor(depth / 2));
const ENTER_BREADTH = 1;
const ENTER_WIDTH = 0.9;

/**
 * The orientation for a component with this profile in a pane `maxWidth`
 * wide. `previous`, the orientation it is currently shown with, if any, adds
 * hysteresis; without it the plain rule applies.
 */
export function chooseOrientation(profile: GenerationProfile, maxWidth: number, previous?: Orientation): Orientation {
  const budget = Number.isFinite(maxWidth) || maxWidth === Infinity ? maxWidth : 0;
  const { depth, breadth } = profile;
  const fits = (breadthSlack: number, widthShare: number) =>
    depth >= 2 && breadth <= depth + breadthSlack && budget > 0 && sidewaysWidth(profile) <= budget * widthShare;
  if (previous === "right") return fits(KEEP_BREADTH(depth), 1) ? "right" : "down";
  if (previous === "down") return fits(-ENTER_BREADTH, ENTER_WIDTH) ? "right" : "down";
  return fits(0, 1) ? "right" : "down";
}

/**
 * A component's identity for remembering its orientation: its earliest
 * image. Adding images (new outputs are always later) never changes it.
 */
export function componentIdentity(dag: TraceDag, members: readonly NodeKey[]): NodeKey | null {
  let best: TraceNode | null = null;
  for (const key of members) {
    const node = dag.nodes.get(key);
    if (node && (!best || node.order < best.order || (node.order === best.order && node.key < best.key))) best = node;
  }
  return best?.key ?? null;
}
