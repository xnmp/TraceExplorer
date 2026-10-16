/**
 * How the renderers draw a presentation (docs/scene-transactions.md §6): which live connectors and
 * junctions draw on their own motion layer this epoch, and which retiring records each open band
 * or exit group draws. Pure; derived from one presentation, memoised per presentation.
 *
 * A band record moves inside its stack's section, which follows its cover's vertical motion. A
 * record whose track moves exactly with its section needs no effect of its own; a live connector
 * or junction that does not gets an HTML layer (its SVG source is hidden while it lasts), because
 * native effects on SVG children can lag accelerated HTML tiles.
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { EntityId, GraphId, SceneRecord } from "$lib/domain/trace-graph/folder-scene";
import { coverOf, ridesWithSection, type Presentation, type RetiringRecord, type Track } from "./presentation";

export interface GraphPresentation {
  /** Live connectors and junctions drawn on their own motion layer (their SVG source hidden). */
  readonly layered: ReadonlySet<EntityId>;
  /** Retiring tiles, connectors and junctions drawn in this band (not in an exit group). */
  readonly retiring: readonly RetiringRecord[];
}

export interface ExitGroupView {
  /** The group: its record is the container (folder coordinates), its track the shared fade and clip. */
  readonly group: RetiringRecord;
  readonly tiles: readonly RetiringRecord[];
  readonly routes: readonly RetiringRecord[];
  readonly junctions: readonly RetiringRecord[];
}

export interface PresentationView {
  readonly graphs: ReadonlyMap<GraphId, GraphPresentation>;
  readonly exits: readonly ExitGroupView[];
  /** Graphs with a pinned record (moving this epoch) or an in-band retiree: their bands stay mounted until they settle. */
  readonly pinnedGraphs: ReadonlySet<GraphId>;
  /**
   * In-band retirees of a band no longer open (a publication closed it while they faded): no band
   * draws them, so the grid does, in folder coordinates, for the rest of their own tracks.
   */
  readonly orphans: readonly RetiringRecord[];
  /** Render ids of `orphans`, whose effects are not relative to any section. */
  readonly orphaned: ReadonlySet<string>;
}

/** The motion frame a band record moves in: its cover's track and rect (the section follows its vertical motion). */
export interface SectionFrame { readonly track: Track | null; readonly base: GridRect }

export const NO_GRAPH: GraphPresentation = { layered: new Set(), retiring: [] };

/** Band records: what an open band draws (its cover is a grid cell). */
const inBand = (record: SceneRecord) => record.kind === "route" || record.kind === "junction" || (record.kind === "tile" && !record.cover);

export function sectionFrame(presentation: Presentation, record: SceneRecord): SectionFrame | null {
  const cover = coverOf(record), presented = cover !== null ? presentation.live.get(cover) : undefined;
  return presented ? { track: presented.track, base: presented.record.rect } : null;
}

/** Whether a band record's track moves exactly with its section (so it needs no effect of its own). */
export function ridesSection(presentation: Presentation, record: SceneRecord, track: Track | null): boolean {
  if (track?.frames[0].pose.stem || track?.frames[0].pose.shape) return false;
  const frame = sectionFrame(presentation, record);
  return frame ? ridesWithSection(track, record.rect, frame.track, frame.base) : !track;
}

const views = new WeakMap<Presentation, PresentationView>();

export function presentationView(presentation: Presentation): PresentationView {
  const known = views.get(presentation);
  if (known) return known;
  const graphs = new Map<GraphId, { layered: Set<EntityId>; retiring: RetiringRecord[] }>();
  const graph = (id: GraphId) => graphs.get(id) ?? graphs.set(id, { layered: new Set(), retiring: [] }).get(id)!;
  for (const { record, track } of presentation.live.values()) {
    if ((record.kind === "route" || record.kind === "junction") && record.graphId !== null && track && !ridesSection(presentation, record, track)) graph(record.graphId).layered.add(record.id);
  }
  const open = new Set<GraphId>();
  for (const { record } of presentation.live.values()) if (record.graphId !== null && inBand(record)) open.add(record.graphId);
  const orphans: RetiringRecord[] = [];
  const exits = new Map<string, { group: RetiringRecord; tiles: RetiringRecord[]; routes: RetiringRecord[]; junctions: RetiringRecord[] }>();
  for (const retiree of presentation.retiring.values()) if (retiree.record.kind === "band") exits.set(retiree.renderId, { group: retiree, tiles: [], routes: [], junctions: [] });
  for (const retiree of presentation.retiring.values()) {
    const { record } = retiree;
    if (record.kind === "band") continue;
    if (retiree.group !== null) {
      const exit = exits.get(retiree.group);
      if (!exit) continue;
      if (record.kind === "tile") exit.tiles.push(retiree);
      else if (record.kind === "route") exit.routes.push(retiree);
      else if (record.kind === "junction") exit.junctions.push(retiree);
    } else if (record.graphId !== null) {
      if (open.has(record.graphId)) graph(record.graphId).retiring.push(retiree);
      else orphans.push(retiree);
    }
  }
  const pinnedGraphs = new Set<GraphId>(graphs.keys());
  for (const id of presentation.pinned) {
    const graphId = presentation.live.get(id)?.record.graphId;
    if (graphId !== undefined && graphId !== null) pinnedGraphs.add(graphId);
  }
  const view: PresentationView = { graphs, pinnedGraphs, orphans, orphaned: new Set(orphans.map((retiree) => retiree.renderId)),
    exits: [...exits.values()].filter((exit) => exit.tiles.length + exit.routes.length + exit.junctions.length > 0) };
  views.set(presentation, view);
  return view;
}
