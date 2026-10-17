/** Small deterministic priority queue; entries are immutable after insertion. */
class Queue<T> {
  private readonly values: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}
  get size(): number { return this.values.length; }
  peek(): T | undefined { return this.values[0]; }
  push(value: T): void {
    let at = this.values.length;
    this.values.push(value);
    while (at) {
      const parent = (at - 1) >>> 1;
      if (!this.before(value, this.values[parent])) break;
      this.values[at] = this.values[parent]; at = parent;
    }
    this.values[at] = value;
  }
  pop(): T {
    const first = this.values[0], last = this.values.pop()!;
    if (!this.values.length) return first;
    let at = 0;
    while (2 * at + 1 < this.values.length) {
      let child = 2 * at + 1;
      if (child + 1 < this.values.length && this.before(this.values[child + 1], this.values[child])) child++;
      if (!this.before(this.values[child], last)) break;
      this.values[at] = this.values[child]; at = child;
    }
    this.values[at] = last;
    return first;
  }
}

/** Topological order that first retires the most live source lanes, O((V+E) log V). */
export function fallbackOrder(keys: readonly string[], parents: ReadonlyMap<string, readonly string[]>, children: ReadonlyMap<string, readonly string[]>, cover?: string): string[] {
  const rank = new Map(keys.map((key, i) => [key, i]));
  const pending = new Map(keys.map(key => [key, parents.get(key)!.length]));
  const remaining = new Map([...children].map(([key, list]) => [key, list.length]));
  const scores = new Map(keys.map(key => [key, parents.get(key)!.reduce((sum, parent) => sum + Number(remaining.get(parent) === 1), 0) - Number(children.has(key))]));
  type Entry = { key: string; score: number };
  const ready = new Queue<Entry>((a, b) => a.key === cover || (b.key !== cover && (a.score > b.score || (a.score === b.score && rank.get(a.key)! < rank.get(b.key)!))));
  const enqueue = (key: string) => ready.push({ key, score: scores.get(key)! });
  for (const key of keys) if (!pending.get(key)) enqueue(key);
  const ordered: string[] = [], placed = new Set<string>();
  while (ready.size) {
    const { key, score } = ready.pop();
    if (placed.has(key) || score !== scores.get(key)) continue;
    ordered.push(key); placed.add(key);
    for (const parent of parents.get(key)!) {
      const left = remaining.get(parent)! - 1; remaining.set(parent, left);
      if (left !== 1) continue;
      // Each parent's adjacency is scanned once, when only one consumer remains.
      const last = children.get(parent)!.find(child => !placed.has(child))!;
      scores.set(last, scores.get(last)! + 1);
      if (!pending.get(last)) enqueue(last);
    }
    for (const child of children.get(key) ?? []) {
      const left = pending.get(child)! - 1; pending.set(child, left);
      if (!left) enqueue(child);
    }
  }
  return ordered;
}

/** Interval colouring: a lane is free after its source's final consumer row. */
export function fallbackLanes(order: readonly string[], children: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const rank = new Map(order.map((key, i) => [key, i]));
  const active = new Queue<{ end: number; lane: number }>((a, b) => a.end < b.end || (a.end === b.end && a.lane < b.lane));
  const free = new Queue<number>((a, b) => a < b), lanes = new Map<string, number>();
  let count = 0;
  for (const [i, key] of order.entries()) {
    while (active.peek() && active.peek()!.end <= i) free.push(active.pop().lane);
    const outputs = children.get(key);
    if (!outputs) continue;
    const lane = free.size ? free.pop() : count++;
    const end = outputs.reduce((last, child) => Math.max(last, rank.get(child)!), i);
    lanes.set(key, lane); active.push({ end, lane });
  }
  return lanes;
}
