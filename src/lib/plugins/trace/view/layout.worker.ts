/// <reference lib="webworker" />
/**
 * Off-thread layout: pure computation only, no host or DOM access. One message kind: a whole
 * folder (`folder` → `folder`), run by the registered default engine, memoised, on a complete input.
 */
import { engines, memoizeEngine, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";

type Message = { readonly id: number; readonly folder: FolderLayoutInput };

const folderEngine = memoizeEngine(engines.default);

self.onmessage = (event: MessageEvent<Message>) => {
  const { id, folder } = event.data;
  try {
    (self as unknown as Worker).postMessage({ id, folder: folderEngine(folder) });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
