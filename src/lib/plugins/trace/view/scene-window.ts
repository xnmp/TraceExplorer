/**
 * Windowing (docs/scene-transactions.md §7): which part of the published scene is mounted. Pure:
 * a function of the published presentation, the epoch time it is displayed at, and the viewport in
 * folder coordinates as displayed now (the grid's running camera included). The renderers measure
 * only the viewport (`SceneMotion.viewport`) and the displayed time, and recompute on scroll,
 * resize, every publication, its motion start, and every frame while the presentation moves, so no
 * frame shows an in-view region whose records are not mounted.
 */
import { entityId, type GraphId } from "$lib/domain/trace-graph/folder-scene";
import { sampleTrack, type Presentation } from "./presentation";

/** Windows are whole multiples of this, so small scrolls and motion do not re-render. */
export const WINDOW_STEP = 200;

/** A vertical span (top ≤ bottom). */
export interface Span { readonly top: number; readonly bottom: number }

/** The viewport assumed before one is measured. */
export const UNMEASURED: Span = { top: 0, bottom: 2000 };

/** What was measured: the displayed viewport (folder coordinates) and the presentation epoch and time it was displayed at. */
export interface ShownViewport extends Span {
  readonly epoch: number;
  readonly at: number;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

/** `span` widened to whole steps (null when it is not finite). */
export function quantise(span: Span, step = WINDOW_STEP): Span | null {
  if (!finite(span.top, span.bottom)) return null;
  return { top: Math.floor(span.top / step) * step, bottom: Math.ceil(span.bottom / step) * step };
}

/**
 * The epoch time `presentation` is displayed at, given a measurement: the measured time when it
 * was of this epoch; a newer epoch not measured yet still shows its first poses (time 0); a
 * presentation without motion shows its targets (Infinity).
 */
export function displayedTime(presentation: Presentation, shown: ShownViewport | null): number {
  if (!(presentation.duration > 0)) return Infinity;
  return shown && shown.epoch === presentation.epoch ? shown.at : 0;
}

/**
 * Where stack `graph`'s band canvas is displayed at epoch time `at`, in folder coordinates: its
 * laid-out top (`top`, the cover cell's) moved by its section, which follows the cover's vertical
 * motion.
 */
export function bandTopAt(presentation: Presentation, graph: GraphId, top: number, at: number): number {
  const cover = presentation.live.get(entityId("tile", graph, graph));
  if (!cover?.track) return top;
  return top + sampleTrack(cover.track, at).rect.y - cover.record.rect.y;
}

/** The span of a band's canvas (its own coordinates) to mount: the viewport within `margin`, where the canvas is displayed at `top`. */
export function bandWindow(viewport: Span, top: number, margin: number): Span | null {
  return quantise({ top: viewport.top - top - margin, bottom: viewport.bottom - top + margin });
}
