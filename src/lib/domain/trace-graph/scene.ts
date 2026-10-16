import { routeConsumers } from "./route-consumers";
/**
 * Scene composition: the pure pipeline from a component's DAG and the current
 * focus to everything a renderer needs (visible tiles, sizes, tones, layout
 * request and route styling). Layout itself may run in a worker; everything
 * here is cheap and synchronous.
 */
import type { NodeKey, TraceNode } from "./model";
import type { BadgeProjection, ReferenceBadge, TraceDag } from "./projection";
import { lineage, lineageWithBadges, toneOf, type Lineage, type NodeTone } from "./lineage";
import { bandCarets, hiddenDescendantCount, visibleKeys, type BandExpansion } from "./visibility";
import { tileMetrics, tileSize, type TileMetrics, type TileSize } from "./metrics";
import { chooseOrientation, generationProfile, sidewaysWidth, type OrientationHistory } from "./orientation";
import type { GraphLayout, BandHistory, LayoutItem, LayoutRequest, PinnedCover, PlacedRoute } from "./layout";

export interface SceneTile {
  readonly key: NodeKey;
  readonly node: TraceNode;
  readonly tone: NodeTone;
  readonly size: TileSize;
  readonly childCount: number;
  readonly hiddenDescendants: number;
  /**
   * Whether the node has children to show, in any scope (an output saved outside the folder can be
   * edited further): it carries the expansion hint row, so its size never depends on what is shown.
   */
  readonly expandable: boolean;
  /** Whether the node reads expanded: in a band, all of its children are shown (`bandCarets`); in the legacy view, the focus. */
  readonly expanded: boolean;
  /**
   * Whether its caret changes what is shown (`bandCarets`): only then is it offered. Children all
   * shown and held by something else leave nothing for this one to show or hide.
   */
  readonly togglable: boolean;
}

export interface ScenePlan {
  readonly lineage: Lineage;
  readonly tiles: ReadonlyMap<NodeKey, SceneTile>;
  readonly request: LayoutRequest;
}

export interface SceneOptions {
  /** Component identity disambiguates references copied into several stacks. */
  readonly componentId?: string;
  /** Previous reading order, so siblings keep their places (see `LayoutRequest.hint`). */
  readonly hint?: ReadonlyMap<NodeKey, number>;
  /**
   * Orientations last displayed at each tile width. Hysteresis uses only this
   * size's committed orientation, so a resize round trip restores it while
   * the profile and pane width still allow it (orientation.ts).
   */
  readonly previous?: OrientationHistory;
  /** The size of the view's tiles (`tileMetrics`); defaults to the default tile. */
  readonly tile?: TileMetrics;
}

export interface ComponentFocus { readonly key: NodeKey; readonly componentId: string }

export function planScene(dag: TraceDag, members: readonly NodeKey[], focus: NodeKey | ComponentFocus | null, maxWidth: number, options: SceneOptions = {}): ScenePlan {
  const { hint, previous, tile = tileMetrics() } = options;
  const key = typeof focus === "object" ? focus?.key ?? null : focus;
  const ownsFocus = typeof focus !== "object" || focus === null || focus.componentId === options.componentId;
  const inComponent = key !== null && ownsFocus && members.includes(key);
  const context = lineage(dag, inComponent ? key : null);
  // Lineage of an out-of-component focus still dims this component entirely.
  const effective: Lineage = key !== null && !inComponent ? { focus: key, related: new Set() } : context;
  const focused = inComponent ? key : null;
  const { tiles, items } = sceneTiles(dag, visibleKeys(dag, members, focused), effective, tile, new Set(focused === null ? [] : [focused]));
  // Decided from the whole component, never the focus, so selection cannot flip it.
  // Running right, the canvas is sized for the whole component, so it does not re-centre as generations appear.
  const profile = generationProfile(dag, members);
  const orientation = chooseOrientation(profile, maxWidth, previous?.get(tile.width), tile);
  const extent = orientation === "right" ? sidewaysWidth(profile, tile) : undefined;
  return { lineage: effective, tiles, request: { items, maxWidth, hint, orientation, extent, tileWidth: tile.width } };
}

function sceneTiles(dag: TraceDag, visible: readonly NodeKey[], context: Lineage, tile: TileMetrics, expanded: ReadonlySet<NodeKey>, togglable?: ReadonlySet<NodeKey>, reserveHint = false) {
  const shown = new Set(visible);
  const tiles = new Map<NodeKey, SceneTile>();
  const items: LayoutItem[] = [];
  for (const key of visible) {
    const node = dag.nodes.get(key)!;
    const childCount = dag.children.get(key)!.length;
    const expandable = childCount > 0;
    // Sizes depend only on the node, never on the focus.
    const size = tileSize({ foreign: node.scope !== "current", hint: reserveHint || expandable }, tile);
    tiles.set(key, { key, node, tone: toneOf(context, key), size, childCount, hiddenDescendants: hiddenDescendantCount(dag, key, shown), expandable, expanded: expanded.has(key),
      togglable: expandable && (togglable ? togglable.has(key) : true) });
    items.push({ key, width: size.width, height: size.height, order: node.order, parents: dag.parents.get(key)!.filter((parent) => shown.has(parent)) });
  }
  return { tiles, items };
}

export interface BandSceneOptions extends Pick<SceneOptions, "hint" | "tile"> {
  readonly pinned: PinnedCover;
  /**
   * The stack's expansion (`expandedKeys`): what decides the visible tiles (`bandVisibleKeys`).
   * The selection never does.
   */
  readonly expanded: BandExpansion;
  readonly history?: BandHistory;
}

export interface BandScenePlan extends ScenePlan {
  /** Badges docked on visible consumers; all references survive the display's three-badge limit. */
  readonly badges: ReadonlyMap<NodeKey, readonly ReferenceBadge[]>;
}

/** How a band's focus applies to it: the lineage its tiles and routes are toned by, and whether the focus is its own. */
export interface BandFocus {
  readonly membership: ReadonlySet<NodeKey>;
  /** Members consuming the focus when it is one of the band's reference badges. */
  readonly badgeConsumers: readonly NodeKey[];
  /** The focus is a member, or a badge some member consumes. */
  readonly inComponent: boolean;
  /** Focus lineage (dimming everything for another stack's focus), widened by a hovered badge's consumers. */
  readonly lineage: Lineage;
}

/** Styling only (`buildFolderScene` tones a band's tiles and routes with it): never an input of a band's geometry. */
export function bandFocus(graph: BadgeProjection, members: readonly NodeKey[], focus: NodeKey | null, badgeHighlight: NodeKey | null = null): BandFocus {
  const membership = new Set(members);
  const badgeConsumers = focus !== null && graph.badges.has(focus)
    ? members.filter((key) => graph.byConsumer.get(key)?.some((badge) => badge.key === focus)) : [];
  const inComponent = focus !== null && (membership.has(focus) || badgeConsumers.length > 0);
  const context = lineageWithBadges(graph, inComponent ? focus : null, membership);
  const selected: Lineage = focus !== null && !inComponent ? { focus, related: new Set() } : context;
  const highlight = badgeHighlight && graph.badges.has(badgeHighlight) ? lineageWithBadges(graph, badgeHighlight, membership) : null;
  const lineage: Lineage = highlight ? { focus: selected.focus ?? highlight.focus, related: new Set([...selected.related, ...highlight.related]) } : selected;
  return { membership, badgeConsumers, inComponent, lineage };
}

const NO_LINEAGE: Lineage = { focus: null, related: new Set() };

/**
 * A band's plan: geometry only. Reference badges are projected before computing drawable
 * components; members contain drawable keys only. The visible tiles are the stack's explicit
 * expansion (`bandVisibleKeys`); complete lineage supplies stable sizes and parentage. `anchor`
 * (the node last expanded or collapsed) is held still by the layout. Tiles are planned neutral:
 * selection, focus lineage and hover tone them later (`bandFocus`), so they never move anything.
 */
export function planBandScene(graph: BadgeProjection, members: readonly NodeKey[], anchor: NodeKey | null, maxWidth: number, options: BandSceneOptions): BandScenePlan {
  const { dag } = graph;
  const membership = new Set(members);
  const anchored = anchor !== null && (membership.has(anchor) || graph.badges.has(anchor)) ? anchor : undefined;
  const tile = options.tile ?? tileMetrics();
  const carets = bandCarets(graph, members, options.expanded);
  const { tiles, items } = sceneTiles(dag, carets.visible, NO_LINEAGE, tile, carets.open, carets.togglable, true);
  const badges = new Map([...tiles.keys()].flatMap((key) => {
    const references = graph.byConsumer.get(key);
    return references ? [[key, references] as const] : [];
  }));
  return { lineage: NO_LINEAGE, tiles, badges, request: { items, maxWidth, history: options.history, anchorKey: anchored, hint: options.hint, tileWidth: tile.width, orientation: "down", pinned: options.pinned, band: { key: options.pinned.key, items: members.map((key) => {
    const node = dag.nodes.get(key)!;
    const size = tileSize({ foreign: node.scope !== "current", hint: true }, tile);
    return { key, ...size, order: node.order, parents: (dag.parents.get(key) ?? []).filter((parent) => membership.has(parent)) };
  }) } } };
}

export type RouteKind = "current" | "subfolder" | "external";

export interface RouteStyle { readonly kind: RouteKind; readonly related: boolean; readonly highlighted: boolean }

export function routeStyle(route: PlacedRoute, dag: TraceDag, context: Lineage): RouteStyle {
  const kinds = routeConsumers(route).map((item) => dag.nodes.get(item.parent)?.scope ?? "current");
  const kind: RouteKind = kinds.every((value) => value === "external") ? "external" : kinds.every((value) => value === "subfolder") ? "subfolder" : "current";
  if (context.focus === null) return { kind, related: true, highlighted: false };
  return {
    kind,
    related: routeConsumers(route).some((item) => context.related.has(item.parent) && context.related.has(item.child)),
    highlighted: context.related.has(context.focus) && routeConsumers(route).some((item) => item.parent === context.focus || item.child === context.focus),
  };
}

export function junctionRelated(parents: readonly NodeKey[], context: Lineage): boolean {
  return context.focus !== null && parents.some((id) => context.related.has(id));
}

export type { GraphLayout };
