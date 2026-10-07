/** Resolves a Preview subject to the Trace node it shows, if any. */
import type { PreviewSubject } from "../../../../../integration/plugin-sdk";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { samePath } from "$lib/domain/path";
import { tracePanes, isTraceTargetData } from "./pane-registry.svelte";

export function subjectNode(subject: PreviewSubject): TraceNode | null {
  const view = tracePanes.get(subject.paneId);
  if (!view) return null;
  if (subject.kind === "file") return view.nodeForPath(subject.entry.path);
  const data = subject.target.data;
  return isTraceTargetData(data) && samePath(data.directory, view.directory) ? view.node(data.key) : null;
}
