/// <reference lib="webworker" />
/** Off-thread layout: pure computation only, no host or DOM access. */
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";

interface Message { readonly id: number; readonly request: LayoutRequest }

self.onmessage = (event: MessageEvent<Message>) => {
  const { id, request } = event.data;
  try {
    (self as unknown as Worker).postMessage({ id, layout: layoutGraph(request) });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
