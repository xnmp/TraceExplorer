/// <reference lib="webworker" />
/**
 * Off-thread layout: pure computation only, no host or DOM access. Two message kinds:
 * one band (`request` → `layout`, the per-request path) and the whole folder (`folder` →
 * `folder`), which runs the registered default engine, memoised, on a complete input.
 */
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { engines, memoizeEngine, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";

type Message = { readonly id: number; readonly request: LayoutRequest } | { readonly id: number; readonly folder: FolderLayoutInput };

const folderEngine = memoizeEngine(engines.default);

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data, id = message.id;
  try {
    if ("folder" in message) (self as unknown as Worker).postMessage({ id, folder: folderEngine(message.folder) });
    else (self as unknown as Worker).postMessage({ id, layout: layoutGraph(message.request) });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
