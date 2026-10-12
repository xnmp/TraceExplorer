import type { PluginFileDropHandler, PluginFileDropSource, PluginFileDropTargetOptions } from "../../integration/plugin-sdk";

/** Host stand-in: nearest live target claims the gesture before async delivery; disabled targets consume it. */
export function createFileDropTargets() {
  const targets = new Map<HTMLElement, { handler: PluginFileDropHandler; options?: PluginFileDropTargetOptions }>();
  return {
    register(element: HTMLElement, handler: PluginFileDropHandler, options?: PluginFileDropTargetOptions): () => void {
      const registration = { handler, options };
      targets.set(element, registration);
      return () => { if (targets.get(element) === registration) targets.delete(element); };
    },
    clear(): void { targets.clear(); },
    get size(): number { return targets.size; },
    async deliver(hit: Element | null, paths: readonly string[], source: PluginFileDropSource): Promise<"delivered" | "blocked" | "unclaimed"> {
      if (!hit?.isConnected || hit.closest('[inert], [hidden], [aria-hidden="true"]')) return "blocked";
      for (let element: Element | null = hit; element; element = element.parentElement) {
        const target = targets.get(element as HTMLElement);
        if (!target) continue;
        if (target.options?.enabled?.() === false) return "blocked";
        // Snapshot before awaiting, just as a host must when registration/drag state changes.
        await target.handler(Object.freeze([...paths]), source);
        return "delivered";
      }
      return hit.closest('[role="dialog"]') ? "blocked" : "unclaimed";
    },
  };
}
