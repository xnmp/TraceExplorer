/**
 * Which way a component's generations run (dagre's `rankdir` TB vs LR).
 *
 * The rule looks only at the whole component's settled images and the pane
 * width, never at the focus or which tiles are currently shown, so selecting
 * nodes can never flip a component between orientations (tiles would jump).
 * Running and unsaved outputs do not count toward its shape: generating a
 * batch into a component, or discarding it, leaves the shape alone. They do
 * count toward its width, since they are drawn: a pending output in a new,
 * deeper generation needs a column, and if the generations then no longer fit
 * side by side the component turns rather than overflow the pane.
 *
 * A component fits left to right when
 * - it has at least two generations,
 * - it has at least as many generations as its widest generation has images
 *   (top to bottom it would be at least as tall as it is wide), and
 * - all its drawn generations fit side by side in the pane.
 * Otherwise it runs top to bottom, where wide generations wrap onto rows.
 *
 * Hysteresis: given the orientation it was last shown with, a component keeps
 * it until the rule fails by a clear margin (see `chooseOrientation`), so a
 * component near the threshold does not flip back and forth as images are
 * saved or the pane is resized by a few pixels.
 */
import type { NodeKey, TraceNode } from "./model";
import type { TraceDag } from "./projection";
import type { Orientation } from "./layout";
import { buildInputJunctions, type Junction } from "./junctions";
import { spacingFor, tileMetrics, TRACK_HEIGHT, type Spacing, type TileMetrics } from "./metrics";

export interface GenerationProfile {
  /** Number of generations of the component's settled images (longest parent chain, counted in images). */
  readonly depth: number;
  /** Settled images in the largest generation. */
  readonly breadth: number;
  /**
   * Generations drawn, pending outputs included: how many columns the canvas
   * holds side by side. At least `depth`.
   */
  readonly span: number;
  /**
   * Estimated width the channels between the drawn generations need beyond
   * their plain `bandChannel`, summed over the channels: junction levels and
   * crowded bend tracks. Estimated from the whole component, so it does not
   * depend on the focus. The channels' contents are computed on first use (it
   * can be costly), then remembered; their extra width follows the spacing.
   */
  readonly channelExtra: (spacing?: Spacing) => number;
}

/** Whether a node counts toward its component's shape: running and unsaved (or discarded) outputs do not. */
export const settled = (node: TraceNode | undefined): boolean => !!node && node.state !== "running" && !node.temporary;

/**
 * The component's shape and drawn extent. Longest-path generations over its
 * own relationships, the same bands the layout engine uses; iterative (Kahn),
 * so deep chains are safe; relationships closing a cycle (rejected upstream)
 * are ignored.
 *
 * Depth and breadth count only the component's settled core: its largest
 * group of settled images connected without going through a pending output.
 * A pending output therefore changes neither, not even through the reference
 * inputs it pulls into the component. The span, and the width estimate, cover
 * everything drawn, pending outputs included.
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
  const core = settledCore(dag, ready);
  const sizes = new Map<number, number>();
  for (const key of core) { const level = generation.get(key)!; sizes.set(level, (sizes.get(level) ?? 0) + 1); }
  const deepest = (keys: Iterable<NodeKey>) => { let most = 0; for (const key of keys) most = Math.max(most, generation.get(key)! + 1); return most; };
  const depth = deepest(core);
  const span = Math.max(depth, deepest(ready));
  const breadth = [...sizes.values()].reduce((most, size) => Math.max(most, size), 0);
  let channels: readonly ChannelLoad[] | undefined;
  return { depth, breadth, span, channelExtra: (spacing = spacingFor()) => extraWidth(channels ??= channelLoads(ready, parentsOf, generation, span), spacing) };
}

/**
 * The largest group of settled images connected through settled images only
 * (ties: the group holding the earliest image). Linear in the component.
 */
function settledCore(dag: TraceDag, keys: readonly NodeKey[]): NodeKey[] {
  const counts = new Set(keys.filter((key) => settled(dag.nodes.get(key))));
  const seen = new Set<NodeKey>();
  let best: NodeKey[] = [];
  let bestFirst = Infinity;
  for (const start of counts) {
    if (seen.has(start)) continue;
    const group: NodeKey[] = [];
    let first = Infinity;
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const key = pending.pop()!;
      group.push(key);
      first = Math.min(first, dag.nodes.get(key)!.order);
      for (const next of [...dag.parents.get(key) ?? [], ...dag.children.get(key) ?? []]) {
        if (counts.has(next) && !seen.has(next)) { seen.add(next); pending.push(next); }
      }
    }
    if (group.length > best.length || (group.length === best.length && first < bestFirst)) { best = group; bestFirst = first; }
  }
  return best;
}

/** What one channel between generations must hold: its junction levels and the bend tracks its crossing sources may need. */
interface ChannelLoad { readonly levels: number; readonly tracks: number }

/**
 * Extra channel width (see `GenerationProfile.channelExtra`). Mirrors how the
 * engine sizes a channel: each junction level adds `junctionLevel`, and a
 * channel whose bends need more tracks than fit its bend room grows by a
 * track per bend.
 */
function extraWidth(channels: readonly ChannelLoad[], spacing: Spacing): number {
  // Bend room only: the approach into the next column never bends, so it never grows.
  const bend = spacing.bandChannel - spacing.approach;
  return channels.reduce((sum, { levels, tracks }) => sum + Math.max(bend + levels * spacing.junctionLevel, tracks * TRACK_HEIGHT) - bend, 0);
}

/** Every channel's load, estimated over every drawn relationship. */
function channelLoads(keys: readonly NodeKey[], parentsOf: (key: NodeKey) => NodeKey[], generation: ReadonlyMap<NodeKey, number>, span: number): ChannelLoad[] {
  if (span < 2) return [];
  const relationships = keys.map((child) => ({ child, parents: parentsOf(child) })).filter((row) => row.parents.length > 0);
  const levels = junctionLevels(relationships.filter((row) => row.parents.length > 1), (id) => generation.get(id) ?? 0);
  // Distinct sources whose routes cross each channel, each of which may need
  // its own bend track there: a source crosses every channel from its own
  // generation to its deepest child's (a difference array keeps this linear).
  const reach = new Map<NodeKey, number>();
  for (const { child, parents } of relationships) for (const parent of parents) reach.set(parent, Math.max(reach.get(parent) ?? 0, generation.get(child)!));
  const delta = new Array<number>(span + 1).fill(0);
  for (const [source, deepest] of reach) { delta[generation.get(source)!]++; delta[Math.min(deepest, span)]--; }
  const loads: ChannelLoad[] = [];
  for (let band = 0, tracks = 0; band < span - 1; band++) {
    tracks += delta[band];
    loads.push({ levels: levels.get(band) ?? 0, tracks });
  }
  return loads;
}

/**
 * Above this many multi-input outputs, or inputs to them in all, junction
 * nesting is bounded rather than computed (grouping inputs is quadratic).
 */
const EXACT_JUNCTIONS = 200;
const EXACT_INPUTS = 800;

/**
 * Junction nesting per generation channel, keyed by the band of each
 * junction's deepest parent, as the engine nests junctions: shared input
 * subsets combine first, one level above the junction they feed. For very
 * many multi-input outputs it falls back to a bound on nesting: an output with
 * n inputs nests at most n − 1 junctions. (Neither counts the further levels
 * the engine opens when a level is full.)
 */
function junctionLevels(rows: readonly { readonly child: NodeKey; readonly parents: readonly NodeKey[] }[], band: (id: NodeKey) => number): Map<number, number> {
  const levels = new Map<number, number>();
  const raise = (at: number, level: number) => levels.set(at, Math.max(levels.get(at) ?? 0, level));
  const bandOf = (parents: readonly NodeKey[]) => parents.reduce((most, id) => Math.max(most, band(id)), 0);
  if (rows.length > EXACT_JUNCTIONS || rows.reduce((sum, row) => sum + row.parents.length, 0) > EXACT_INPUTS) {
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

/**
 * Canvas width of the profile's drawn generations side by side, for tiles of
 * the given metrics (and the spacing that goes with them), without and with
 * the channel extra.
 */
function plainWidth(span: number, tile: TileMetrics): number {
  const spacing = spacingFor(tile.width);
  return span <= 0 ? 0 : spacing.top + span * tile.width + (span - 1) * spacing.bandChannel + spacing.bottom;
}
export function sidewaysWidth(profile: GenerationProfile, tile: TileMetrics = tileMetrics()): number {
  return profile.span <= 0 ? 0 : plainWidth(profile.span, tile) + profile.channelExtra(spacingFor(tile.width));
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
 * hysteresis; without it the plain rule applies. The cheap checks come first,
 * so the channel estimate is only computed for components that could run
 * left to right.
 */
export function chooseOrientation(profile: GenerationProfile, maxWidth: number, previous?: Orientation, tile: TileMetrics = tileMetrics()): Orientation {
  const budget = Number.isFinite(maxWidth) || maxWidth === Infinity ? maxWidth : 0;
  const { depth, breadth, span } = profile;
  const fits = (breadthSlack: number, widthShare: number) =>
    depth >= 2 && breadth <= depth + breadthSlack && budget > 0 && plainWidth(span, tile) <= budget * widthShare && sidewaysWidth(profile, tile) <= budget * widthShare;
  if (previous === "right") return fits(KEEP_BREADTH(depth), 1) ? "right" : "down";
  if (previous === "down") return fits(-ENTER_BREADTH, ENTER_WIDTH) ? "right" : "down";
  return fits(0, 1) ? "right" : "down";
}
