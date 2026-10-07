/**
 * Scene composition: the pure pipeline from a component's DAG and the current
 * focus to everything a renderer needs (visible tiles, sizes, tones, layout
 * request and route styling). Layout itself may run in a worker; everything
 * here is cheap and synchronous.
 */
import type { NodeKey, TraceNode } from "./model";
import type { TraceDag } from "./projection";
import { lineage, toneOf, type Lineage, type NodeTone } from "./lineage";
import { hiddenDescendantCount, visibleKeys } from "./visibility";
import { tileSize, type TileSize } from "./metrics";
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedRoute } from "./layout";

export interface SceneTile {
  readonly key: NodeKey;
  readonly node: TraceNode;
  readonly large: boolean;
  readonly tone: NodeTone;
  readonly size: TileSize;
  readonly childCount: number;
  readonly hiddenDescendants: number;
  /** Only folder images can expand to reveal their children. */
  readonly expandable: boolean;
}

export interface ScenePlan {
  readonly lineage: Lineage;
  readonly tiles: ReadonlyMap<NodeKey, SceneTile>;
  readonly request: LayoutRequest;
}

export function planScene(dag: TraceDag, members: readonly NodeKey[], focus: NodeKey | null, maxWidth: number, hint?: ReadonlyMap<NodeKey, number>): ScenePlan {
  const inComponent = focus !== null && members.includes(focus);
  const context = lineage(dag, inComponent ? focus : null);
  // Lineage of an out-of-component focus still dims this component entirely.
  const effective: Lineage = focus !== null && !inComponent ? { focus, large: new Set(), related: new Set() } : context;
  const visible = visibleKeys(dag, members, inComponent ? focus : null);
  const shown = new Set(visible);
  const tiles = new Map<NodeKey, SceneTile>();
  const items: LayoutItem[] = [];
  for (const key of visible) {
    const node = dag.nodes.get(key)!;
    const childCount = dag.children.get(key)!.length;
    const expandable = node.scope === "current" && childCount > 0;
    const large = effective.large.has(key);
    const size = tileSize({ large, foreign: node.scope !== "current", hint: expandable });
    tiles.set(key, { key, node, large, tone: toneOf(effective, key), size, childCount, hiddenDescendants: hiddenDescendantCount(dag, key, shown), expandable });
    items.push({ key, width: size.width, height: size.height, order: node.order, parents: dag.parents.get(key)!.filter((parent) => shown.has(parent)) });
  }
  return { lineage: effective, tiles, request: { items, maxWidth, hint } };
}

export type RouteKind = "current" | "subfolder" | "external";

export interface RouteStyle { readonly kind: RouteKind; readonly related: boolean; readonly highlighted: boolean }

export function routeStyle(route: PlacedRoute, dag: TraceDag, context: Lineage): RouteStyle {
  const kinds = route.consumers.map((item) => dag.nodes.get(item.parent)?.scope ?? "current");
  const kind: RouteKind = kinds.every((value) => value === "external") ? "external" : kinds.every((value) => value === "subfolder") ? "subfolder" : "current";
  if (context.focus === null) return { kind, related: true, highlighted: false };
  return {
    kind,
    related: route.consumers.some((item) => context.related.has(item.parent) && context.related.has(item.child)),
    highlighted: route.consumers.some((item) => item.parent === context.focus || item.child === context.focus),
  };
}

export function junctionRelated(parents: readonly NodeKey[], context: Lineage): boolean {
  return context.focus !== null && parents.some((id) => context.related.has(id));
}

export type { GraphLayout };
