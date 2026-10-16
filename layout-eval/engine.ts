/** Evaluation adapter: every proposed layout runs the public production entry point. */
import { layoutGraph, type GraphLayout, type LayoutRequest, type BandHistory } from "../src/lib/domain/trace-graph/layout";
import { attachSingleBand } from "../src/lib/domain/trace-graph/band-geometry";
import { bandHistorySignature } from "../src/lib/domain/trace-graph/band-layout";
export interface Optimized { readonly signature: string; readonly contents: string; readonly layout: GraphLayout; readonly placed: GraphLayout; readonly candidate: string; readonly arrivalHistory?: BandHistory }
export function optimizedBand(request: LayoutRequest, options: { previous?: Optimized; anchorKey?: string; stability?: number; historyPolicy?: "committed" | "arrival-only" } = {}): Optimized {
  const signature = bandHistorySignature(request);
  const contents = JSON.stringify([...(request.band?.items ?? request.items)].sort((a,b) => a.key.localeCompare(b.key))
    .map(n => [n.key,n.order,[...new Set(n.parents)].sort()]));
  const previous = options.previous;
  const captured = previous ? { signature: previous.signature, layout: previous.layout, placed: previous.placed } : undefined;
  const arrivalHistory = previous && previous.contents !== contents ? captured : previous?.arrivalHistory;
  const arrivalOnly = options.historyPolicy === "arrival-only";
  const layout = layoutGraph({ ...request, hint: arrivalOnly ? undefined : request.hint,
    anchorKey: arrivalOnly ? undefined : options.anchorKey, history: arrivalOnly ? arrivalHistory : captured });
  return { signature, contents, layout, placed: attachSingleBand(layout, request), candidate: layout.decision?.candidate ?? "empty", arrivalHistory };
}
