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
 * Geometry only: tones, selection, badge highlighting and route emphasis are derived from the
 * output. Visibility comes from explicit expansion (`OpenStack.expanded`); the last click anchor
 * holds the new layout near the click. Displayed states are committed history, so revisits restore
 * exactly while never-seen states may depend on the path taken to them.
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
import type { BandHistory, GraphLayout, LayoutRequest } from "../layout";
import type { BandExpansion } from "../visibility";

/** A stack's stable identity: its cover node key (component ids change when components merge). */
export type GraphId = GridItemId;

/** Host tile-grid metrics (the host's `tileGridMetrics`), or the fallback derived from the tile. */
export interface FolderGridMetrics {
  /** Centered painted ordinary-tile width, when known by its renderer; otherwise the entire cell is an obstacle. */
  readonly contentWidth?: number;
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
   * The node last toggled, retained for callers that also use it for viewport navigation.
   * New states use it for click-time anchoring. Selection is never an input.
   */
  readonly anchor: NodeKey | null;
  /**
   * The stack's expansion (`expandedKeys` in `expansion.ts`): members and reference badge keys,
   * each expanded or collapsed, oldest first. Each node follows the latest entry among its parents
   * and badges; the cover counts as expanded (oldest) unless an entry decides it. What the band shows follows from this alone
   * (`bandVisibleKeys`). Keys outside the stack are ignored.
   */
  readonly expanded: BandExpansion;
}

export interface FolderLayoutInput {
  readonly folderKey?: string;
  /** Contents identity from the folder index/listing, including closed stacks. */
  readonly contents?: string;
  /** Backend observation epoch, stable across clicks. It is not proof of a contents change:
   * status-only updates may advance it. Complete member facts still decide arrivals. */
  readonly dataRevision?: string;
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
   * The previous displayed output carries click history and the bounded revisit ledger.
   * Speculative results are not committed until displayed and passed here. Folder content
   * changes clear the ledger and pin retained rectangles from this drawing. Validate any geometry before reuse: this value
   * can be malformed or belong to another width/tile/grid basis.
   */
  readonly previous?: FolderLayout | null;
}

/** One open stack's band, laid out and attached below its cover's row. */
export interface FolderGraph {
  readonly id: GraphId;
  /** Visible tiles, lineage of the focus and the request the band was laid out from. */
  readonly plan: BandScenePlan;
  /** The local drawing used for history. For world placement it equals `attached`; see `canonical`. */
  readonly layout: GraphLayout;
  /**
   * The same band attached to the packed grid: tile rects and connector paths relative to
   * `origin` (x is already the folder's; y counts from the cover cell's top).
   */
  readonly attached: GraphLayout;
  /** Folder coordinates of `attached`'s (0, 0): the grid's left edge at the cover cell's top. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly placement: BandPlacement;
  /** Original request and raw band drawing: caching never reattaches a world/fallback drawing as raw. */
  readonly canonical?: { readonly request: LayoutRequest; readonly layout: GraphLayout };
  /** World placement has no band attachment transform to replay. */
  readonly worldPlaced?: true;
}

export interface ArrivalHistory {
  readonly contents: string;
  readonly history?: BandHistory;
}

/** Exact folder coordinates retained at the last contents change, never an interaction. */
export interface FolderPlacementHistory {
  readonly basis: string;
  readonly layout: Omit<FolderLayout, 'arrivalPlacement' | 'arrivals'>;
}

export interface FolderLayout {
  /** Recalled geometry must never seed a band cache under its new request. */
  readonly revisited?: true;
  readonly displays?: import("./display-memory").DisplayMemory;
  /** Physical tile obstacles; allocations in cells retain their independent pinning contract. */
  readonly cellFootprints?: ReadonlyMap<GridItemId, GridRect>;
  /** Observation epoch used to distinguish freshly loaded facts from a new arrival. */
  readonly dataRevision?: string;
  readonly geometryBasis?: string;
  readonly arrivalPlacement?: FolderPlacementHistory;
  readonly decision?: { readonly fallback?: "isolated-rows" | "pin-search-exhausted"; readonly requestedColumns: number; readonly pinning?: "search-exhausted"; readonly relayout?: 'pane-width' | 'tile-size' };
  /** Updated only by component membership/parentage changes, never by a scene interaction. */
  readonly arrivals?: ReadonlyMap<GraphId, ArrivalHistory>;
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
