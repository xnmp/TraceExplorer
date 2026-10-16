/** Evaluation adapter: every proposed layout runs the public production entry point. */
import { layoutGraph, type GraphLayout, type LayoutRequest, type BandHistory } from "../src/lib/domain/trace-graph/layout";
import { attachSingleBand } from "../src/lib/domain/trace-graph/band-geometry";
import { layoutSignature } from "../src/lib/domain/trace-graph/layout-signature";
import { bandHistorySignature } from "../src/lib/domain/trace-graph/band-layout";
export interface Optimized { readonly signature: string; readonly contents: string; readonly layout: GraphLayout; readonly placed: GraphLayout; readonly candidate: string; readonly history?: BandHistory; readonly revisited?: boolean; readonly displays?: readonly (readonly [string, GraphLayout])[] }
export function optimizedBand(request: LayoutRequest, options: { previous?: Optimized; anchorKey?: string; stability?: number } = {}): Optimized {
  const signature = bandHistorySignature(request);
  const contents = JSON.stringify([...(request.band?.items ?? request.items)].sort((a,b) => a.key.localeCompare(b.key))
    .map(n => [n.key,n.order,[...new Set(n.parents)].sort()]));
  const previous = options.previous;
  const captured = previous ? { signature: previous.signature, layout: previous.layout, placed: previous.placed } : undefined;
  const key = layoutSignature({ ...request, history: undefined, hint: undefined, anchorKey: undefined });
  const displays = previous?.contents === contents ? previous.displays ?? [] : [];
  const restored = displays.find(([id]) => id === key)?.[1];
  const layout = restored ? structuredClone(restored) : layoutGraph({ ...request, hint: request.hint ?? previous?.layout.readingOrder,
    anchorKey: options.anchorKey, history: captured });
  return { signature, contents, revisited: !!restored, layout, placed: attachSingleBand(layout, request), candidate: layout.decision?.candidate ?? "empty", history:captured,
    displays: [...displays.filter(([id]) => id !== key).slice(-63), [key, structuredClone(layout)]] };
}
