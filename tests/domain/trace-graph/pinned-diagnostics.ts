import type { GraphLayout, LayoutItem, LayoutRequest } from "$lib/domain/trace-graph/layout";
import { ARROW, spacingFor, SPACING } from "$lib/domain/trace-graph/metrics";
import { arrowStemProblems, channelProblems, foreignJunctionContacts, junctionOverlaps, routeCollisions, samplePath, sharedLanes, sourcesReaching, tileOverlaps } from "./fixtures";

export type Failures = Record<string, string[]>;
export const invariantNames = ["tile-overlap", "tile-route", "junction-overlap", "foreign-junction", "shared-lane", "parentage", "parent-order", "arrow-stem", "on-canvas", "width-5%", "route-id", "channel-size", "pinned-x", "cover-alone", "cover-incoming", "obstacle-route", "foreign-grid-channel", "obstacle-tile"];
export function invariants(items: LayoutItem[], layout: GraphLayout, width: number, pinned: NonNullable<LayoutRequest["pinned"]>): Failures {
  const result: Failures = Object.fromEntries(invariantNames.map((name) => [name, []]));
  result["tile-overlap"] = tileOverlaps(layout);
  result["tile-route"] = routeCollisions(layout);
  result["junction-overlap"] = junctionOverlaps(layout);
  result["foreign-junction"] = foreignJunctionContacts(layout, 5);
  result["shared-lane"] = sharedLanes(layout);
  result["arrow-stem"] = arrowStemProblems(layout, ARROW.length);
  result["channel-size"] = channelProblems(layout, spacingFor());
  const sorted = (values: Iterable<string>) => [...values].sort().join("|");
  for (const item of items) {
    const expected = item.parents.filter((key) => layout.nodes.has(key));
    if (sorted(sourcesReaching(layout, item.key)) !== sorted(expected)) result.parentage.push(item.key);
    for (const parent of expected) {
      const source = layout.nodes.get(parent)!, child = layout.nodes.get(item.key)!;
      if (source.y + source.height >= child.y) result["parent-order"].push(`${parent}>${item.key}`);
    }
  }
  const onCanvas = (x: number, y: number, what: string) => {
    if (!(x >= 0 && x <= layout.width && y >= 0 && y <= layout.height)) result["on-canvas"].push(`${what}: ${x},${y}`);
  };
  for (const tile of layout.nodes.values()) { onCanvas(tile.x, tile.y, tile.key); onCanvas(tile.x + tile.width, tile.y + tile.height, tile.key); }
  for (const dot of layout.junctions.values()) onCanvas(dot.x, dot.y, dot.id);
  for (const route of layout.routes) for (const [, x, y] of route.path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) onCanvas(Number(x), Number(y), route.id);
  if (layout.width > width * 1.05) result["width-5%"].push(`${layout.width} > ${width * 1.05}`);
  const ids = layout.routes.map((route) => route.id);
  result["route-id"] = ids.filter((id, i) => ids.indexOf(id) !== i);
  const cover = layout.nodes.get(pinned.key)!;
  if (Math.abs(cover.x + cover.width / 2 - pinned.x) > 0.01) result["pinned-x"].push(`${cover.x + cover.width / 2} != ${pinned.x}`);
  if (layout.rows[0]?.keys.length !== 1 || layout.rows[0]?.keys[0] !== pinned.key) result["cover-alone"].push(layout.rows[0]?.keys.join(",") ?? "no row");
  result["cover-incoming"] = layout.routes.filter((route) => route.terminal && route.to.id === pinned.key).map((route) => route.id);
  // Obstacles occupy the requested grid row, even if the non-root fallback
  // draws its cover elsewhere. Check path samples and arrowhead tip.
  const gridTop = SPACING.top, gridBottom = gridTop + cover.height;
  for (const tile of layout.nodes.values()) for (const [i, box] of (pinned.obstacles ?? []).entries()) {
    if (tile.x < box.x + box.width && box.x < tile.x + tile.width && tile.y < gridBottom && gridTop < tile.y + tile.height) result["obstacle-tile"].push(`${tile.key}>obstacle${i}`);
  }
  for (const route of layout.routes) {
    const points = samplePath(route.path, 60);
    if (route.terminal) { const end = points.at(-1)!; points.push({ x: end.x, y: end.y + ARROW.length }); }
    for (const [i, box] of (pinned.obstacles ?? []).entries()) {
      if (points.some((point) => point.x > box.x + 0.5 && point.x < box.x + box.width - 0.5 && point.y > gridTop + 0.5 && point.y < gridBottom - 0.5)) result["obstacle-route"].push(`${route.id}>obstacle${i}`);
    }
    const bandTop = layout.rows[1]?.top;
    if (bandTop !== undefined && !(route.from.kind === "node" && route.from.id === pinned.key)
      && points.some((point) => point.y > gridBottom + 0.5 && point.y < bandTop - 0.5)) result["foreign-grid-channel"].push(route.id);
  }
  return result;
}

/** Physical ink length: shared trunks counted once. Cubics sampled 60 times. */
export function routeLength(path: string): number {
  const points = samplePath(path, 60);
  return points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0);
}
export function metrics(layout: GraphLayout, cover: string) {
  const lengths = new Map(layout.routes.map((route) => [route.id, routeLength(route.path)]));
  const children = new Set(layout.routes.flatMap((route) => route.consumers.filter((consumer) => consumer.parent === cover).map((consumer) => consumer.child)));
  // Complete cover→child course, including shared trunks and junction tails;
  // each consumer appears on precisely the drawn segments that carry it.
  const coverLengths = [...children].map((child) => layout.routes.filter((route) => route.consumers.some((consumer) => consumer.parent === cover && consumer.child === child)).reduce((sum, route) => sum + lengths.get(route.id)!, 0) + ARROW.length);
  return {
    width: layout.width, height: layout.height,
    routeLength: [...lengths.values()].reduce((sum, length) => sum + length, 0),
    // Each nontrivial S-curve changes course twice (two bends).
    bends: layout.routes.reduce((sum, route) => sum + 2 * (route.path.match(/C/g)?.length ?? 0), 0),
    coverMax: Math.max(0, ...coverLengths),
    coverInk: layout.routes.filter((route) => route.from.kind === "node" && route.from.id === cover).reduce((sum, route) => sum + lengths.get(route.id)!, 0),
  };
}
