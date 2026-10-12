/** Ordered one-dimensional interval packing. Groups keep their parent's reading order. */
export interface StackGroup {
  readonly id: string;
  readonly center: number;
  readonly width: number;
  readonly height: number;
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
export function packStackGroups(groups: readonly StackGroup[], rowWidth: number, gap = 16): readonly PackedStackGroup[] {
  nonnegative(rowWidth); nonnegative(gap);
  if (groups.length && rowWidth === 0) throw new RangeError("nonempty packing needs a positive row width");
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) throw new RangeError("duplicate stack group");
    seen.add(group.id);
    nonnegative(group.width); nonnegative(group.height);
    if (!Number.isFinite(group.center)) throw new RangeError("group centers must be finite");
  }
  const ordered = [...groups].sort((a, b) => a.center - b.center);
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
      const mean = group.center - group.width / 2 - offsets[i];
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
    y = nonnegative(y + Math.max(...groups.map((group) => group.height)) + gap);
  }
  return result;
}
