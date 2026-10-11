/**
 * Mounted Trace views by pane. The Preview-info section renders outside the
 * view, so it reaches the owning pane's nodes and focus actions through here.
 * Each entry belongs to one pane; nothing here is global focus state.
 */
import { untrack } from "svelte";
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";

export interface TracePaneView {
  readonly directory: string;
  node(key: NodeKey): TraceNode | null;
  nodeForPath(path: string): TraceNode | null;
  /** Focus a node in this pane (expanding its component), like clicking it. */
  focus(key: NodeKey): void;
  reveal(targetId: string, signal: AbortSignal): Promise<void>;
  /** Whether this view's pane is the window's active pane. */
  readonly active: boolean;
  /** The selected images in the order they were picked, including unlisted ones. */
  inputs(): readonly string[];
  /** A highlighted Preview target that cannot be used as an image input. */
  hasUnusableTarget(): boolean;
}

let views = $state.raw<ReadonlyMap<string, TracePaneView>>(new Map());

const mounted = new Map<() => void, () => void>();

export const tracePanes = {
  /** The host may request reveal before the view's registration effect runs. */
  async waitFor(paneId: string, directory: string, signal: AbortSignal): Promise<TracePaneView> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const clean = () => { mounted.delete(check); signal.removeEventListener("abort", abort); };
      const abort = () => { clean(); reject(signal.reason ?? new DOMException("Reveal aborted", "AbortError")); };
      const check = () => {
        const view = views.get(paneId);
        if (view?.directory === directory) { clean(); resolve(view); }
      };
      mounted.set(check, () => { clean(); reject(new Error("Trace view is no longer available")); });
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  },
  get(paneId: string | null): TracePaneView | null { return paneId ? views.get(paneId) ?? null : null; },
  /** The view in the window's active pane, if that pane shows Trace. */
  active(): TracePaneView | null { for (const view of views.values()) if (view.active) return view; return null; },
  /** Registers a pane's view (safe to call from effects); returns the unregister function. */
  set(paneId: string, view: TracePaneView): () => void {
    untrack(() => { views = new Map(views).set(paneId, view); });
    for (const check of mounted.keys()) check();
    return () => untrack(() => {
      if (views.get(paneId) !== view) return;
      const next = new Map(views);
      next.delete(paneId);
      views = next;
    });
  },
  clear() { views = new Map(); for (const reject of mounted.values()) reject(); },
};

/** Payload carried by this plugin's Preview targets. */
export interface TraceTargetData {
  readonly kind: "trace-node";
  readonly key: NodeKey;
  readonly componentId: string;
  readonly directory: string;
}

export const isTraceTargetData = (value: unknown): value is TraceTargetData =>
  !!value && typeof value === "object" && (value as TraceTargetData).kind === "trace-node" && typeof (value as TraceTargetData).key === "string";
