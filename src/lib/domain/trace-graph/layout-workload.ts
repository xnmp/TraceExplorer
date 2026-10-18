/** Conservative deterministic work budget for synchronous layout dispatch. */
import type { LayoutRequest } from "./layout";
import type { GridItem } from "./grid-flow";
import type { FolderBandWork } from "./folder-layout/default-engine";
import type { FolderLayoutInput } from "./folder-layout/types";

export interface LayoutWorkload {
  readonly tiles: number;
  readonly edges: number;
  readonly pathBytes: number;
}

export function layoutWorkload(request: LayoutRequest): { tiles: number; edges: number; pathBytes: number } {
  const history = request.history?.layout;
  return { tiles: request.items.length + (history?.nodes.size ?? 0),
    edges: request.items.reduce((sum, n) => sum + n.parents.length, 0) + (history?.routes.length ?? 0),
    pathBytes: history?.routes.reduce((sum,r)=>sum+2*r.path.length,0) ?? 0 };
}

/** Certification is part of the budget, including retained path parsing. */
export function canLayoutInline(request: LayoutRequest): boolean {
  return withinInlineBudget(layoutWorkload(request));
}

export const withinInlineBudget = (work: ReturnType<typeof layoutWorkload>): boolean =>
  work.tiles <= 20 && work.edges <= 20 && work.pathBytes <= 16_384;

/**
 * Packing, display decoding and certification scale with the drawing, even when construction
 * is free. Count a cover once (it is both a grid cell and a band node), and use one drawing per
 * band, never request + history + attached copies. Routes and UTF-16 path bytes are counted once.
 * Include hidden band members: display snapshots decode their request metadata too. Use the
 * larger of route count and encoded parent relationships, rather than adding both representations.
 * For an unbuilt band, request parents estimate routes; retained geometry supplies path bytes
 * and any still-visible history nodes. The construction budget separately bounds that new work.
 * Unrelated serialized display entries are not drawings this run decodes.
 */
export function folderDrawingWorkload(items: readonly GridItem[], bands: readonly FolderBandWork[]): LayoutWorkload {
  const cells = new Set(items.map(item => item.id));
  let tiles = cells.size, edges = 0, pathBytes = 0;
  for (const { id, request, drawing } of bands) {
    const members = request.band?.items ?? request.items;
    const nodes = new Set([...members.map(item => item.key), ...request.items.map(item => item.key),
      ...(drawing?.nodes.keys() ?? [])]);
    tiles += nodes.size - Number(cells.has(id) && nodes.has(id));
    edges += Math.max(drawing?.routes.length ?? 0, members.reduce((sum, item) => sum + item.parents.length, 0));
    pathBytes += drawing?.routes.reduce((sum, route) => sum + 2 * route.path.length, 0) ?? 0;
  }
  return { tiles, edges, pathBytes };
}

/** Calibrated separately from construction; see the measurement table below. */
export const withinFolderRestoreBudget = (work: LayoutWorkload): boolean =>
  work.tiles <= 90 && work.edges <= 95 && work.pathBytes <= 30_720;

/** Reject large retained drawings before the dispatcher spends time planning their bands.
 * The engine inspects this previous geometry even when it cannot recall a display. This is the
 * same drawing budget, not an additional charge against the next drawing's construction work. */
export function canRetainFolderInline(input: FolderLayoutInput): boolean {
  return withinFolderRestoreBudget(folderDrawingWorkload(input.items,
    [...input.previous?.graphs ?? []].map(([id, graph]) => ({ id, request: graph.plan.request,
      cached: true, search: false, drawing: graph.attached }))));
}

/**
 * A band that runs a constrained incremental search never runs inline (see `FolderBandWork.search`).
 * Otherwise both independent costs must fit: only missing bands pay construction, while the whole drawing
 * pays restore/certification. Kept committed bands and remembered worker bands are equally free
 * to construct. This pure rule is shared by production dispatch and the inline performance set.
 *
 * Calibration: `bun layout-eval/calibrate-folder-inline.ts`, 2026-10-17 on this machine.
 * Real createFolderLayoutRuntime().engine, warm bands, 900px fan, 8 warmups then 20 samples
 * (nearest-rank p95). Short size sweep followed by a boundary sweep; observed p95 varies with system load.
 * Plans are prepared before timing (also for rejected sizes, for comparison). Production skips
 * planning large retained drawings. Restore has a cold certificate after
 * worker transport; revisit opens a closed state; status changes only dataRevision. No engine
 * output cache. Times in ms; the 90-tile / 95-route / 30 KiB limits target headroom below 5 ms.
 * Tiles  Routes  Path bytes  Restore  Revisit  Status refresh
 *    10      10       4700     0.80     0.49      0.45
 *    40      43      14232     1.81     1.27      1.55
 *    80      88      25310     3.94     2.85      2.27
 *    86      95      27308     4.07     2.48      2.47
 *    87      96      27346     4.01     3.61      3.45
 *    90      99      28474     3.95     2.83      2.71
 *   100     111      31380     4.47     4.26      3.02
 *   200     223      60618     9.17     6.23      8.58
 *   400     448     118648    19.22    14.68     16.38
 *  1000    1123     299308    43.64    34.22     35.19
 *  2000    2248     609558    86.90    57.71     60.47
 * The route cap stops the fan at 86 tiles, the first sweep's ~4 ms boundary;
 * fewer-route drawings can reach 90 members. Concurrent-load repeats were noisier: at 85 tiles
 * restore/revisit/status p95 was 5.56/5.74/5.32 ms (6.22/6.07/6.20 including dispatch).
 * Pinning the process did not stabilize it (6.07/3.63/4.20 at 85). Thus the initial sweep guides
 * these limits, but a <=4 ms wall-time p95 under current contention is unverified.
 * 30 KiB allows normal path-length variation at that boundary, without charging snapshot JSON
 * a second time as path text. These are dispatch estimates, not hard timing guarantees.
 */
export function canLayoutFolderInline(items: readonly GridItem[], bands: readonly FolderBandWork[]): boolean {
  // A constrained incremental search spends up to its finite allowance before any
  // legacy fallback; that is worker work whatever the drawing's size.
  if (bands.some(band => band.search)) return false;
  const construction = bands.filter(band => !band.cached).map(band => layoutWorkload(band.request))
    .reduce((sum, work) => ({ tiles: sum.tiles + work.tiles, edges: sum.edges + work.edges,
      pathBytes: sum.pathBytes + work.pathBytes }), { tiles: 0, edges: 0, pathBytes: 0 });
  return withinInlineBudget(construction) && withinFolderRestoreBudget(folderDrawingWorkload(items, bands));
}

/**
 * The scene on screen: how far it reaches horizontally, and the width it was laid out for. Both are
 * measured the same way, inside the grid's padding (the layout input's width), as is the next width.
 */
export interface DisplayedExtent {
  readonly extent: number;
  readonly width: number;
}

/**
 * Whether a folder layout must run before the next paint whatever its workload
 * (docs/scene-transactions.md, "Native findings fixes"). `width` is the width the next layout is
 * for. A scene on screen that the pane narrowed past (it reaches beyond the new width, which is
 * narrower than the one it was laid out for) would be drawn overflowing the pane while a heavy
 * layout runs off the main thread, so its replacement is computed at once instead. Otherwise the
 * scene on screen stays, unchanged and whole, until the worker's layout commits: one that still
 * fits, and one already wider than its own pane (it scrolls sideways now as it did before).
 * Nothing on screen (null), or a measure that is not a finite number, never forces it.
 */
export function mustLayoutBeforePaint(displayed: DisplayedExtent | null, width: number): boolean {
  return displayed !== null && [displayed.extent, displayed.width, width].every(Number.isFinite)
    && width < displayed.width && displayed.extent > width;
}
