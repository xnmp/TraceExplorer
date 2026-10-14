/**
 * Harness stand-in for `src/lib/plugins/trace/view/layout-worker-factory.ts`:
 * the real layout worker, with its replies routed through `layoutGate`.
 */
import LayoutWorker from "$lib/plugins/trace/view/layout.worker.ts?worker&inline";
import { layoutGate, type LayoutReplyInfo } from "./layout-gate";

interface PostedRequest { itemKeys: string[]; bandKey: string | null }

export function createLayoutWorker(): Worker {
  const real: Worker = new LayoutWorker();
  // The client assigns `onmessage`; capture it so every reply goes through the gate.
  let handler: ((event: MessageEvent) => unknown) | null = null;
  Object.defineProperty(real, "onmessage", { configurable: true, get: () => handler, set: (next) => { handler = next; } });
  const posted = new Map<number, PostedRequest>();
  // Resolved per call, so specs that patch `Worker.prototype.postMessage` still intercept.
  real.postMessage = ((message: any, options?: any) => {
    Worker.prototype.postMessage.call(real, message, options);
    posted.set(message.id, { itemKeys: (message.request?.items ?? []).map((item: { key: string }) => item.key), bandKey: message.request?.band?.key ?? null });
  }) as Worker["postMessage"];
  real.addEventListener("message", (event) => {
    const data = event.data as { id: number; error?: string };
    const request = posted.get(data.id);
    posted.delete(data.id);
    const info: LayoutReplyInfo = { id: data.id, itemKeys: request?.itemKeys ?? [], bandKey: request?.bandKey ?? null, error: data.error ?? null };
    layoutGate.route(info, real, () => handler?.call(real, event));
  });
  const terminate = real.terminate.bind(real);
  real.terminate = () => { layoutGate.forget(real); terminate(); };
  return real;
}
