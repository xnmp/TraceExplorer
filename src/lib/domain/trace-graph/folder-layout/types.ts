/**
 * The folder layout seam: one pure function from what the folder holds and
 * what is open to every rectangle and connector the Trace view draws.
 *
 *     type FolderLayoutEngine = (input: FolderLayoutInput) => FolderLayout
 *
 * This is the only place layout policy lives. Grid flow, band layout,
 * packing and attachment are internals of an engine; the scene controller
 * runs an engine (inline or in a worker: input and output are plain,
 * structured-cloneable data), the renderer draws its output and motion diffs
 * two outputs. Changing the layout means writing another function of this
 * type; `layout-eval` benchmarks any engine through it, and the contract
 * suite in `tests/domain/trace-graph/folder-layout-contract.test.ts` runs
 * against every registered engine. Caching is a wrapper (`memoizeEngine`),
 * never part of the seam.
 *
 * Geometry only: styling that cannot move a rectangle (tones, selection,
 * badge hover highlighting, route emphasis) is derived by the caller from
 * the output and the current focus, and must not be an input here. Neither
 * is the selection: what a band shows is the user's explicit expansion
 * (`OpenStack.expanded`), and its anchor the node last toggled.
 *
 * Coordinates are folder coordinates: (0, 0) is the grid's top-left inside
 * the pane's grid padding.
 */
import type { NodeKey } from "../model";
import type { BadgeProjection } from "../projection";
import type { TileMetrics } from "../metrics";
import type { GridBand, GridCell, GridItem, GridItemId, GridRect } from "../grid-flow";
import type { BandPlacement } from "../band-geometry";
import type { BandScenePlan } from "../scene";
import type { GraphLayout } from "../layout";

/** A stack's stable identity: its cover node key (component ids change when components merge). */
export type GraphId = GridItemId;

/** Host tile-grid metrics (the host's `tileGridMetrics`), or the fallback derived from the tile. */
export interface FolderGridMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly gap: number;
}

/** One open stack, with its complete component (a partial page never becomes one). */
export interface OpenStack {
  readonly id: GraphId;
  /** Projection of the complete component DAG, reference badges included. */
  readonly graph: BadgeProjection;
  /** Drawable keys of the component, in the component's order. */
  readonly members: readonly NodeKey[];
  /**
   * The node the user last expanded or collapsed in this stack (`expansionAnchor`), which the
   * layout holds still; null for none. Never the selection: selecting changes no geometry.
   */
  readonly anchor: NodeKey | null;
  /**
   * The stack's expanded keys (`expandedKeys` in `expansion.ts`): members and reference badge keys
   * whose children (a badge's consumers) are shown while they are visible. The cover is always one.
   * What the band shows follows from this alone (`bandVisibleKeys`). Keys outside the stack are ignored.
   */
  readonly expanded: ReadonlySet<NodeKey>;
}

export interface FolderLayoutInput {
  /**
   * Grid items in host order with each stack collapsed to one item at its
   * cover's position (`folderCells`). A stack's item id is its `GraphId`.
   */
  readonly items: readonly GridItem[];
  /** Open stacks by id. Ids that are not stack items are ignored. */
  readonly open: ReadonlyMap<GraphId, OpenStack>;
  /** Inner width available to the grid (pane width minus grid padding), quantised by the caller. */
  readonly width: number;
  readonly tile: TileMetrics;
  readonly grid: FolderGridMetrics;
  /**
   * The previous committed output, as a stability hint only: an engine may
   * keep reading order, positions and band decisions from it, but must
   * produce a valid layout without it and must not read anything else from
   * it (it may come from another width or tile size, or be malformed).
   */
  readonly previous?: FolderLayout | null;
}

/** One open stack's band, laid out and attached below its cover's row. */
export interface FolderGraph {
  readonly id: GraphId;
  /** Visible tiles, lineage of the focus and the request the band was laid out from. */
  readonly plan: BandScenePlan;
  /** The band as laid out, in cover-relative coordinates (history and caching use this). */
  readonly layout: GraphLayout;
  /**
   * The same band attached to the packed grid: tile rects and connector paths relative to
   * `origin` (x is already the folder's; y counts from the cover cell's top).
   */
  readonly attached: GraphLayout;
  /** Folder coordinates of `attached`'s (0, 0): the grid's left edge at the cover cell's top. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly placement: BandPlacement;
}

export interface FolderLayout {
  readonly columns: number;
  /** The grid's own box from (0, 0): what the grid element is sized to (connectors may overhang it; see `bounds`). */
  readonly size: { readonly width: number; readonly height: number };
  /** Folder-coordinate bounds of everything drawn (cells, bands, connectors). */
  readonly bounds: GridRect;
  /** Every grid item's cell, in input order. */
  readonly cells: ReadonlyMap<GridItemId, GridCell>;
  /** Each open stack's band rect, in grid order. */
  readonly bands: readonly GridBand[];
  /** One background rect per grid row that holds open bands. */
  readonly rowBands: readonly GridBand[];
  readonly graphs: ReadonlyMap<GraphId, FolderGraph>;
}

export type FolderLayoutEngine = (input: FolderLayoutInput) => FolderLayout;
