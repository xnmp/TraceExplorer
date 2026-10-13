/** Route-following tile travel, shared by band opening and its reverse. Pure CSS-pixel geometry. */
import { resample, samplePathString, type Point } from "./path-sampling";
export interface TravelRoute { readonly from: string; readonly to: string; readonly path: string }
export interface TravelBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

const TRAVEL_SAMPLES = 48;
/** Sample/index once per transition. Iterative breadth-first traversal tolerates cycles and deep chains. */
export function planBandTravel(routes: readonly TravelRoute[], coverKey: string) {
  const outgoing = new Map<string, Array<TravelRoute & { points: readonly Point[] }>>();
  const trunks = new Map<string, readonly Point[]>();
  for (const route of routes) {
    const points = samplePathString(route.path, 16) ?? [];
    if (route.from === route.to) trunks.set(route.from, points);
    else {
      const siblings = outgoing.get(route.from) ?? [];
      siblings.push({ ...route, points });
      outgoing.set(route.from, siblings);
    }
  }
  const coverEndpoint = `node:${coverKey}`;
  const trails = new Map<string, readonly Point[]>([[coverEndpoint, []]]);
  const queue = [coverEndpoint];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index], upstream = trails.get(from)!;
    for (const route of outgoing.get(from) ?? []) {
      if (trails.has(route.to)) continue;
      const points = [...upstream, ...(trunks.get(from) ?? []), ...route.points];
      trails.set(route.to, points.length > TRAVEL_SAMPLES + 1 ? resample(points, TRAVEL_SAMPLES) : points);
      queue.push(route.to);
    }
  }
  return (key: string, cover: TravelBox, tile: TravelBox, displayed?: Point): readonly Point[] => {
    const points = trails.get(`node:${key}`) ?? [];
    // The moving tile's centre follows the route; endpoints are the cover and settled tile boxes.
    const path = [{ x: cover.x, y: cover.y }, ...points.map(({ x, y }) => ({ x: x - tile.width / 2, y: y - tile.height / 2 })), { x: tile.x, y: tile.y }];
    return displayed ? trimTravel(path, displayed) : path;
  };
}

export function bandTravel(routes: readonly TravelRoute[], coverKey: string, key: string, cover: TravelBox, tile: TravelBox, displayed?: Point): readonly Point[] {
  return planBandTravel(routes, coverKey)(key, cover, tile, displayed);
}

/** Reverse only the already travelled prefix, starting at the actual displayed position. */
export function trimTravel(points: readonly Point[], displayed: Point): readonly Point[] {
  const { segment, projected } = projectTravel(points, displayed);
  return [...points.slice(0, segment), projected, displayed];
}

/** Continue an interrupted emergence from its displayed progress along the remaining route. */
export function remainingTravel(points: readonly Point[], displayed: Point): readonly Point[] {
  const { segment, projected } = projectTravel(points, displayed);
  return [displayed, projected, ...points.slice(segment)];
}

function projectTravel(points: readonly Point[], displayed: Point): { segment: number; projected: Point } {
  let closest = Infinity, segment = 0, projected = points[0] ?? displayed;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((displayed.x - a.x) * dx + (displayed.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = Math.hypot(displayed.x - point.x, displayed.y - point.y);
    if (distance < closest) { closest = distance; segment = index; projected = point; }
  }
  return { segment, projected };
}

export function travelFrames(points: readonly Point[], destination: Point, reverse = false): Keyframe[] {
  const ordered = reverse ? [...points].reverse() : points;
  const distances = ordered.map((point, index) => index ? Math.hypot(point.x - ordered[index - 1].x, point.y - ordered[index - 1].y) : 0);
  const total = distances.reduce((sum, distance) => sum + distance, 0);
  let traveled = 0;
  return ordered.map((point, index) => {
    traveled += distances[index];
    const offset = total ? traveled / total : index / Math.max(1, ordered.length - 1);
    return { transform: `translate(${point.x - destination.x}px, ${point.y - destination.y}px)`, opacity: reverse ? 1 - offset : offset, offset };
  });
}

/** Eased progress when a retiring child meets the boundary of reclaimed space. */
export function departureVisibility(fromHeight: number, toHeight: number, childTop: number, shift = 0): number {
  if (![fromHeight, toHeight, childTop, shift].every(Number.isFinite)) return 0;
  if (childTop >= fromHeight) return 0;
  // Normalize before subtracting: finite, extremely large inputs must not
  // overflow into a NaN keyframe offset.
  const scale = Math.max(1, Math.abs(fromHeight), Math.abs(toHeight), Math.abs(childTop), Math.abs(shift));
  const closing = fromHeight / scale - toHeight / scale + shift / scale;
  return closing > 0 ? Math.max(0, Math.min(1, (fromHeight / scale - childTop / scale) / closing)) : 1;
}
