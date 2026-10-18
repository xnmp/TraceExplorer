/** Critical channel dependencies are between departure/arrival pieces, not
 * disposable sorting preferences. Splitting replaces a bend's two endpoints
 * with separately ordered pieces; every original dependency survives. */
import type { CorridorSearch } from './corridor-search';
import type { Separation } from './separation';
import { LANE_SEPARATION } from './metrics';

export interface ChannelBend {
  readonly id: string;
  readonly source: string;
  readonly target: string | null;
  readonly x1: number;
  readonly x2: number;
}
export interface ChannelTrack { readonly track: number; readonly split?: { readonly x: number; readonly track: number } }
export interface ChannelTopology {
  readonly tracks: ReadonlyMap<string, ChannelTrack>;
  readonly count: number;
  /** Each critical edge binds the actual leaving and arriving pieces. */
  readonly dependencies: readonly Separation[];
  readonly positions: ReadonlyMap<string, number>;
}
interface Piece { readonly id: string; readonly bend: ChannelBend; readonly x1: number; readonly x2: number }
const near = (a: number, b: number) => Math.abs(a - b) < LANE_SEPARATION;
const compatible = (a: ChannelBend, b: ChannelBend) => a.source === b.source
  || a.target !== null && a.target === b.target && a.target.startsWith('junction:') && (a.x1 - a.x2) * (b.x1 - b.x2) < 0;

/** All free interval endpoints plus the preferred point, ordered by distance.
 * Intervals are open: exact minimum clearance remains legal. */
export function freeColumns(preferred: number, occupied: readonly number[], low: number, high: number): readonly number[] {
  const options = [Math.max(low, Math.min(high, preferred)), low, high,
    ...occupied.flatMap(x => [x - LANE_SEPARATION, x + LANE_SEPARATION])];
  return [...new Set(options)].filter(x => Number.isFinite(x) && x >= low && x <= high
    && occupied.every(other => !near(other, x))).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
}

export function solveChannelTopology(bends: readonly ChannelBend[], occupied: readonly number[], width: number, search: CorridorSearch): ChannelTopology {
  search.charge(bends.length + occupied.length);
  if (!Number.isFinite(width) || width < 0 || new Set(bends.map(b => b.id)).size !== bends.length
    || bends.some(b => !Number.isFinite(b.x1) || !Number.isFinite(b.x2))) return search.reject(['channel input'], 'invalid');
  const ordered = [...bends.filter(b => b.x2 < b.x1).sort((a,b) => a.x2-b.x2 || a.x1-b.x1),
    ...bends.filter(b => b.x2 >= b.x1).sort((a,b) => b.x2-a.x2 || b.x1-a.x1)];
  const splits = new Map<string, number>();
  for (;;) {
    const pieces: Piece[] = ordered.flatMap(b => splits.has(b.id)
      ? [{ id: b.id + ':leave', bend: b, x1: b.x1, x2: splits.get(b.id)! }, { id: b.id + ':arrive', bend: b, x1: splits.get(b.id)!, x2: b.x2 }]
      : [{ id: b.id, bend: b, x1: b.x1, x2: b.x2 }]);
    search.charge(pieces.length ** 2);
    const edges: Separation[] = [];
    for (const a of pieces) for (const b of pieces) {
      if (a === b) continue;
      if (a.bend === b.bend) {
        if (a.id.endsWith(':leave') && b.id.endsWith(':arrive')) edges.push({ id: 'split:' + a.bend.id, before: a.id, after: b.id, gap: 1 });
      } else if (!compatible(a.bend, b.bend) && near(a.x1, b.x2))
        edges.push({ id: `leave:${a.id}>${b.id}`, before: a.id, after: b.id, gap: 1 });
    }
    const indegree = new Map(pieces.map(p => [p.id, 0])), later = new Map<string, string[]>();
    for (const edge of edges) { indegree.set(edge.after, indegree.get(edge.after)! + 1); const list = later.get(edge.before) ?? []; list.push(edge.after); later.set(edge.before,list); }
    const sequence: Piece[] = [], used = new Set<string>();
    while (sequence.length < pieces.length) {
      search.charge(pieces.length);
      const next = pieces.find(p => !used.has(p.id) && indegree.get(p.id) === 0);
      if (!next) break;
      sequence.push(next); used.add(next.id);
      for (const id of later.get(next.id) ?? []) indegree.set(id, indegree.get(id)! - 1);
    }
    if (sequence.length !== pieces.length) {
      const remaining = pieces.filter(p => !used.has(p.id) && !splits.has(p.bend.id));
      const bend = search.choose('cycle-member:' + remaining.map(p => p.id).join(','), remaining).bend;
      const allColumns = [...occupied, ...splits.values()];
      search.charge(allColumns.length ** 2 + 1);
      const middle = (bend.x1 + bend.x2) / 2, low = Math.min(bend.x1,bend.x2) + LANE_SEPARATION, high = Math.max(bend.x1,bend.x2) - LANE_SEPARATION;
      const inside = low <= high ? freeColumns(middle, allColumns, low, high) : [];
      const outside = freeColumns(middle, allColumns, 0, width);
      const x = search.choose('split-column:' + bend.id, [...new Set([...inside, ...outside])]);
      splits.set(bend.id, x);
      continue;
    }
    const separations = [...edges];
    for (let i = 0; i < sequence.length; i++) for (let j = i+1; j < sequence.length; j++) {
      const a = sequence[i], b = sequence[j];
      if (!compatible(a.bend,b.bend) && Math.min(a.x1,a.x2)-LANE_SEPARATION < Math.max(b.x1,b.x2)+LANE_SEPARATION
        && Math.min(b.x1,b.x2)-LANE_SEPARATION < Math.max(a.x1,a.x2)+LANE_SEPARATION)
        separations.push({id:`span:${a.id}>${b.id}`,before:a.id,after:b.id,gap:1});
    }
    const solved = search.solve({ variables: sequence.map(p => ({id:p.id,preferred:0,bounds:{lower:0}})), order:sequence.map(p=>p.id), separations });
    const tracks = new Map<string, ChannelTrack>();
    for (const bend of bends) tracks.set(bend.id, splits.has(bend.id)
      ? { track: solved.positions.get(bend.id + ':arrive')!, split: { x: splits.get(bend.id)!, track: solved.positions.get(bend.id + ':leave')! } }
      : { track: solved.positions.get(bend.id)! });
    return { tracks, count: Math.max(0,...solved.positions.values()) + 1, dependencies:edges,positions:solved.positions };
  }
}
