/** Evaluation adapter: every proposed layout runs the public production entry point. */
import { layoutGraph, type GraphLayout, type LayoutRequest } from "../src/lib/domain/trace-graph/layout";
import { attachSingleBand } from "../src/lib/domain/trace-graph/band-geometry";
import { bandHistorySignature } from "../src/lib/domain/trace-graph/band-layout";
export interface Optimized { readonly signature: string; readonly layout: GraphLayout; readonly placed: GraphLayout; readonly candidate: string }
export function optimizedBand(request: LayoutRequest, options: { previous?: Optimized; anchorKey?: string; stability?: number } = {}): Optimized {
  const layout = layoutGraph({ ...request, anchorKey: options.anchorKey, history: options.previous ? { signature: options.previous.signature, layout: options.previous.layout, placed: options.previous.placed } : undefined });
  return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request), candidate: layout.decision?.candidate ?? "empty" };
}
