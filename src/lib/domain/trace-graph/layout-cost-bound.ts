/** Cheap admissible objective bounds; they never substitute for geometry validation. */
import type { GraphLayout, LayoutItem } from "./layout";
import { bandExtent } from "./band-geometry";
import { cost, nodePenalties, routePlan, type Measures } from "./layout-quality";

function boundWith(layout: GraphLayout, coverKey: string, paneWidth: number, tileWidth: number,
  items: readonly LayoutItem[], previous: GraphLayout | undefined, anchorKey: string | undefined, length: number, bends: number): number {
  const extent = bandExtent(layout, coverKey);
  const bound: Measures = { height: extent.height, width: extent.width, area: extent.height * extent.width,
    tileArea: 0, whitespace: 0, paneWhitespace: 0, length, bends, crossings: 0, sharedLanePx: 0,
    ...nodePenalties(layout, coverKey, items, previous, anchorKey), overflow: Math.max(0, extent.width - paneWidth),
    tileIntersections: 0, overlaps: 0, missingEdges: 0, extraEdges: 0, missingNodes: 0, extraNodes: 0,
    invalidGeometry: 0, invalidPaths: 0, terminalViolations: 0, disconnectedEdges: 0 };
  return cost(bound, tileWidth);
}

// Legacy/foreign layouts may use cubic control envelopes instead of the exact
// captured allocation. No positive envelope bound is certified for those.
const uncertified = (layout: GraphLayout, coverKey: string) => !layout.bandBounds && layout.nodes.size > Number(layout.nodes.has(coverKey));

/** Bound including every connector's exact length and turning. */
export function optimisticCost(layout: GraphLayout, coverKey: string, paneWidth: number, tileWidth: number,
  items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string): number {
  if (uncertified(layout, coverKey)) return 0;
  let length = 0, bends = 0;
  for (const route of layout.routes) {
    const plan = routePlan(route);
    if (!Number.isFinite(plan.length) || !Number.isFinite(plan.bends)) return 0;
    length += plan.length; bends += plan.bends;
  }
  return boundWith(layout, coverKey, paneWidth, tileWidth, items, previous, anchorKey, length, bends);
}

/**
 * Bound from rectangles and allocation alone (connector terms taken as zero), so it
 * needs no connector geometry: it accepts an attached skeleton. Never above
 * {@link optimisticCost} for the same rectangles. Infinite for a direction violation.
 */
export function rectangleCost(layout: GraphLayout, coverKey: string, paneWidth: number, tileWidth: number,
  items: readonly LayoutItem[], previous?: GraphLayout, anchorKey?: string): number {
  return uncertified(layout, coverKey) ? 0 : boundWith(layout, coverKey, paneWidth, tileWidth, items, previous, anchorKey, 0, 0);
}

/** Bound from a band extent alone, for an embedding not yet constructed: height and width must be lower bounds. */
export function extentCost(height: number, width: number, paneWidth: number, tileWidth: number): number {
  return cost({ height, width, area: height * width, tileArea: 0, whitespace: 0, paneWhitespace: 0, length: 0, bends: 0, crossings: 0, sharedLanePx: 0,
    directionViolations: 0, mixedDirections: 0, siblingInversions: 0, unaligned: 0, displacement: 0, maxDisplacement: 0, movedFraction: 0, anchorDisplacement: 0,
    overflow: Math.max(0, width - paneWidth), tileIntersections: 0, overlaps: 0, missingEdges: 0, extraEdges: 0, missingNodes: 0, extraNodes: 0,
    invalidGeometry: 0, invalidPaths: 0, terminalViolations: 0, disconnectedEdges: 0 }, tileWidth);
}
