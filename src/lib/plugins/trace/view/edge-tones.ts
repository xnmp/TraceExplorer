/**
 * Connector tones, shared by every renderer of connectors (live bands, motion layers, exit
 * groups): a line's colour class and its arrowhead marker. Pure.
 */
import type { RouteStyle } from "$lib/domain/trace-graph/scene";

/** One arrowhead per line colour, so every arrowhead matches its line. */
export const MARKER_TONES = ["", "subfolder", "external", "branch", "highlight"] as const;
export type MarkerTone = (typeof MARKER_TONES)[number];

/** A line's colour: highlight and branch (with a focus in its graph) win over the route's scope. */
export const lineTone = (style: RouteStyle, branch: boolean): MarkerTone =>
  style.highlighted ? "highlight" : branch && style.related ? "branch" : style.kind === "current" ? "" : style.kind;

export const markerId = (uid: string, tone: MarkerTone): string => `arrow-${uid}${tone ? `-${tone}` : ""}`;
