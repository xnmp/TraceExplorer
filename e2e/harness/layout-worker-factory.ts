/**
 * Harness stand-in for `src/lib/plugins/trace/view/layout-worker-factory.ts`:
 * the real layout worker, with its replies routed through `layoutGate`.
 */
import LayoutWorker from "$lib/plugins/trace/view/layout.worker.ts?worker&inline";
import { layoutGate, type LayoutReplyInfo } from "./layout-gate";

interface PostedRequest { kind: "graph" | "folder"; itemKeys: string[]; bandKey: string | null; openKeys: string[] }

export function createLayoutWorker(): Worker {
  const real: Worker = new LayoutWorker();
  // The client assigns `onmessage`; capture it so every reply goes through the gate.
  let handler: ((event: MessageEvent) => unknown) | null = null;
  Object.defineProperty(real, "onmessage", { configurable: true, get: () => handler, set: (next) => { handler = next; } });
  const posted = new Map<number, PostedRequest>();
  // Resolved per call, so specs that patch `Worker.prototype.postMessage` still intercept.
  real.postMessage = ((message: any, options?: any) => {
    Worker.prototype.postMessage.call(real, message, options);
    // A folder run (the scene controller's whole-engine message) names its grid items, then every
    // open stack's members, and its open stacks.
    const folderKeys = (folder: any): string[] => [...(folder.items ?? []).map((item: { id: string }) => item.id),
      ...[...(folder.open?.values() ?? [])].flatMap((stack: { members?: readonly string[] }) => stack.members ?? [])];
    posted.set(message.id, message.folder
      ? { kind: "folder", itemKeys: folderKeys(message.folder), bandKey: null, openKeys: [...(message.folder.open?.keys() ?? [])] }
      : { kind: "graph", itemKeys: (message.request?.items ?? []).map((item: { key: string }) => item.key), bandKey: message.request?.band?.key ?? null, openKeys: [] });
  }) as Worker["postMessage"];
  real.addEventListener("message", (event) => {
    const data = event.data as { id: number; error?: string };
    const request = posted.get(data.id);
    posted.delete(data.id);
    const info: LayoutReplyInfo = { id: data.id, kind: request?.kind ?? "graph", itemKeys: request?.itemKeys ?? [], bandKey: request?.bandKey ?? null, openKeys: request?.openKeys ?? [], error: data.error ?? null };
    layoutGate.route(info, real, () => handler?.call(real, event));
  });
  const terminate = real.terminate.bind(real);
  real.terminate = () => { layoutGate.forget(real); terminate(); };
  return real;
}
