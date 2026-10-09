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
  /** Whether this view's pane is the window's active pane. */
  readonly active: boolean;
  /** The selected images in the order they were picked, including unlisted ones. */
  inputs(): readonly string[];
}

let views = $state.raw<ReadonlyMap<string, TracePaneView>>(new Map());

export const tracePanes = {
  get(paneId: string | null): TracePaneView | null { return paneId ? views.get(paneId) ?? null : null; },
  /** The view in the window's active pane, if that pane shows Trace. */
  active(): TracePaneView | null { for (const view of views.values()) if (view.active) return view; return null; },
  /** Registers a pane's view (safe to call from effects); returns the unregister function. */
  set(paneId: string, view: TracePaneView): () => void {
    untrack(() => { views = new Map(views).set(paneId, view); });
    return () => untrack(() => {
      if (views.get(paneId) !== view) return;
      const next = new Map(views);
      next.delete(paneId);
      views = next;
    });
  },
  clear() { views = new Map(); },
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
