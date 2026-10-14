/** Ordered rectangles and routing-aware skyline compaction. */
import { nearestFree } from "./layout";
export interface StackGroup {
  readonly id: string;
  readonly center: number;
  readonly width: number;
  readonly height: number;
  readonly preferredX?: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
  /** Packed after every other group, so its placeholder never displaces them. */
  readonly deferred?: boolean;
}
export interface PackedStackGroup extends StackGroup {
  readonly x: number;
  readonly y: number;
  readonly line: number;
}
const nonnegative = (value: number) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("packing dimensions must be finite and nonnegative");
  return value;
};

/**
 * Fit as many consecutive groups as possible per line. Within a line, subtract occupied widths
 * and use pool-adjacent-violators to minimize squared displacement from the preferred centers.
 * Clamping the resulting shared slack keeps both edges in bounds. An indivisible oversized
 * graph owns a line (its graph layout already wraps generations; independent roots may scroll).
 */
export function packStackGroups(groups: readonly StackGroup[], rowWidth: number, gap = 16, verticalGap = gap, canPlace: (group: PackedStackGroup, placed: readonly PackedStackGroup[]) => boolean = () => true): readonly PackedStackGroup[] {
  nonnegative(rowWidth); nonnegative(gap); nonnegative(verticalGap);
  if (groups.length && rowWidth === 0) throw new RangeError("nonempty packing needs a positive row width");
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) throw new RangeError("duplicate stack group");
    seen.add(group.id);
    nonnegative(group.width); nonnegative(group.height);
    if (!Number.isFinite(group.center)) throw new RangeError("group centers must be finite");
  }
  const ordered = [...groups].sort((a, b) => Number(!!a.deferred) - Number(!!b.deferred) || a.center - b.center);
  const lines: StackGroup[][] = [];
  let occupied = 0;
  for (const group of ordered) {
    if (!lines.length || (lines.at(-1)!.length && occupied + gap + group.width > rowWidth)) { lines.push([]); occupied = 0; }
    const line = lines.at(-1)!;
    occupied = nonnegative(occupied + (line.length ? gap : 0) + group.width);
    line.push(group);
  }
  const result: PackedStackGroup[] = [];
  let y = 0;
  for (const [line, groups] of lines.entries()) {
    let offset = 0;
    const offsets = groups.map((group) => { const current = offset; offset = nonnegative(offset + group.width + gap); return current; });
    const slack = Math.max(0, rowWidth - (offset - gap));
    const blocks: { start: number; end: number; mean: number; weight: number }[] = [];
    for (const [i, group] of groups.entries()) {
      const mean = (group.preferredX ?? (group.center - group.width / 2)) - offsets[i];
      if (!Number.isFinite(mean)) throw new RangeError("packing coordinate overflow");
      blocks.push({ start: i, end: i, mean, weight: 1 });
      while (blocks.length > 1 && blocks.at(-2)!.mean > blocks.at(-1)!.mean) {
        const right = blocks.pop()!, left = blocks.pop()!, weight = left.weight + right.weight;
        blocks.push({ start: left.start, end: right.end, mean: left.mean * (left.weight / weight) + right.mean * (right.weight / weight), weight });
      }
    }
    for (const block of blocks) for (let i = block.start; i <= block.end; i++) {
      result.push({ ...groups[i], x: Math.max(0, Math.min(slack, block.mean)) + offsets[i], y, line });
    }
    // Preserve active click allocations before spending the remaining slack on neighbours.
    // Feasibility is separation inequalities between anchors and the row edges.
    const lineStart = result.length - groups.length;
    const anchors = groups.flatMap((g, i) => Number.isFinite(g.anchorX) ? [{ index: i, x: g.anchorX! }] : []);
    const boundaries = [{ index: -1, x: -gap }, ...anchors, { index: groups.length, x: rowWidth + gap }];
    const feasible = boundaries.slice(1).every((right, i) => {
      const left = boundaries[i];
      const start = left.index < 0 ? 0 : left.x + groups[left.index].width;
      const end = right.index === groups.length ? rowWidth : right.x;
      const count = right.index - left.index - 1;
      const need = groups.slice(left.index + 1, right.index).reduce((sum, g) => sum + g.width, 0)
        + Math.max(0, count - 1 + Number(left.index >= 0) + Number(right.index < groups.length)) * gap;
      return start + need <= end + .001 && (right.index === groups.length || right.x >= 0 && right.x + groups[right.index].width <= rowWidth);
    });
    if (anchors.length && feasible) {
      for (const a of anchors) result[lineStart + a.index] = { ...result[lineStart + a.index], x: a.x };
      for (let b = 1; b < boundaries.length; b++) {
        const left = boundaries[b - 1], right = boundaries[b];
        let max = right.index === groups.length ? rowWidth : right.x - gap;
        for (let i = right.index - 1; i > left.index; i--) {
          const at = lineStart + i; max -= groups[i].width;
          result[at] = { ...result[at], x: Math.min(result[at].x, max) }; max = result[at].x - gap;
        }
        let min = left.index < 0 ? 0 : left.x + groups[left.index].width + gap;
        for (let i = left.index + 1; i < right.index; i++) {
          const at = lineStart + i; result[at] = { ...result[at], x: Math.max(result[at].x, min) }; min = result[at].x + groups[i].width + gap;
        }
      }
    }
    y = nonnegative(y + Math.max(...groups.map((group) => group.height)) + verticalGap);
  }
  // Compact whole-line reservations into a skyline. Earlier groups keep their
  // positions; a later group can rise only where its entire routing rectangle fits.
  // Candidate boundaries are the skyline's corners, not a pixel scan. Choose the
  // least resulting height, then the lowest placement, then cover displacement.
  const compacted: PackedStackGroup[] = [];
  const reserved = result.filter(g => Number.isFinite(g.anchorX) && Number.isFinite(g.anchorY)
    && g.anchorX! >= 0 && g.anchorX! + g.width <= rowWidth && g.anchorY! >= 0)
    .map(g => ({ ...g, x: g.anchorX!, y: g.anchorY! }));
  for (const group of result) {
    const upcoming = reserved.filter(g => g.id !== group.id && !compacted.some(p => p.id === g.id));
    if (Number.isFinite(group.anchorX) && Number.isFinite(group.anchorY)) {
      const anchored = { ...group, x: group.anchorX!, y: group.anchorY! };
      const clear = anchored.x >= 0 && anchored.x + anchored.width <= rowWidth && anchored.y >= 0
        && compacted.every(other => anchored.x >= other.x + other.width + gap || other.x >= anchored.x + anchored.width + gap
          || anchored.y >= other.y + other.height + verticalGap || other.y >= anchored.y + anchored.height + verticalGap);
      if (clear && canPlace(anchored, compacted)) { compacted.push(anchored); continue; }
    }
    const maxX = Math.max(0, rowWidth - group.width);
    const candidates = [...new Set([group.x, ...(Number.isFinite(group.anchorX) ? [group.anchorX!] : []), 0, maxX, ...compacted.flatMap((other) => [other.x + other.width + gap, other.x - gap - group.width])])]
      .filter((x) => x >= 0 && x <= maxX);
    const currentHeight = Math.max(0, ...compacted.map((other) => other.y + other.height));
    const positions = candidates.map((x) => {
      const blockers = [...compacted, ...upcoming].filter((other) => x < other.x + other.width + gap && x + group.width + gap > other.x);
      const y = Math.max(0, ...blockers.map((other) => nonnegative(other.y + other.height + verticalGap)));
      return { x, y, height: Math.max(currentHeight, nonnegative(y + group.height)) };
    }).filter((at) => canPlace({ ...group, x: at.x, y: at.y }, compacted)).sort((a, b) => a.height - b.height || a.y - b.y || (Number.isFinite(group.anchorX) ? Math.abs(a.x - group.anchorX!) - Math.abs(b.x - group.anchorX!) : 0) || Math.abs(a.x - group.x) - Math.abs(b.x - group.x) || a.x - b.x);
    const best = positions[0];
    // Preserve the balanced first-line arrangement and never move a group down, unless an earlier
    // group was displaced into its slot (by an anchored reservation) or a reservation claims it.
    const clearOf = (others: readonly PackedStackGroup[]) => others.every(other => group.x >= other.x + other.width + gap || other.x >= group.x + group.width + gap
      || group.y >= other.y + other.height + verticalGap || other.y >= group.y + group.height + verticalGap);
    compacted.push(group.y === 0 && clearOf(upcoming) && clearOf(compacted) ? group : best ? { ...group, x: best.x, y: best.y } : { ...group, y: currentHeight + verticalGap });
  }
  return compacted;
}

/** Independent cover stems need a vertical bypass and a clear horizontal corridor
 * into their header. Conservatively treat every earlier group's routing rectangle
 * as occupied, including connectors. Same-source branches may share a lane. */
export function coverGutters(groups: readonly PackedStackGroup[], width: number): ReadonlyMap<string, number> | null {
  const result = new Map<string, number>(), used: number[] = [];
  for (const group of groups) {
    const earlier = groups.filter((other) => other.y < group.y);
    if (!earlier.length) continue;
    const beside = earlier.filter((other) => other.y + other.height > group.y);
    const low = Math.max(2, ...beside.filter((other) => other.x + other.width <= group.x).map((other) => other.x + other.width - 4));
    const high = Math.min(width - 2, ...beside.filter((other) => other.x >= group.x + group.width).map((other) => other.x + 4));
    const forbidden: [number, number][] = [...earlier.map((other): [number, number] => [other.x + 4, other.x + other.width - 4]), ...used.map((x): [number, number] => [x - 3.5, x + 3.5])];
    const gutter = low <= high ? nearestFree(group.center, forbidden, low, high) : null;
    if (gutter === null) return null;
    used.push(gutter); result.set(group.id, gutter);
  }
  return result;
}
