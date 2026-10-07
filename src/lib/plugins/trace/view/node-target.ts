/**
 * Preview targets for nodes that are not files of the displayed folder:
 * unsaved outputs, outside references, earlier revisions and placeholders.
 * Unsaved outputs carry explicit Save / Save as… / Delete actions; saving uses
 * the default collision-safe name unless Save as… picks one.
 */
import type { PreviewTarget } from "../../../../../integration/plugin-sdk";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { basename } from "$lib/domain/path";
import { discardGeneratedImage, imageSaveSuggestion, saveGeneratedImage } from "$lib/api/trace";
import { host } from "../../../../sdk";
import { imageActionState } from "../image-actions.svelte";
import { traceInvalidation } from "../invalidation.svelte";
import type { TraceTargetData } from "./pane-registry.svelte";

export interface TargetCallbacks {
  /** Captures the current selection; the returned check says whether it is unchanged. */
  capture?(): () => boolean;
  /** Called with the saved file's path (only while the selection is unchanged) so the view can focus it. */
  saved(path: string, key: string): void;
  discarded(key: string): void;
}

export function nodeTitle(node: TraceNode): string {
  if (node.path) return basename(node.path);
  return node.state === "running" ? "Generating…" : "Image";
}

export function nodeTypeLabel(node: TraceNode): string | undefined {
  const extension = node.path?.split(".").at(-1);
  return extension && extension !== node.path ? extension.toUpperCase() : undefined;
}

export function nodeStatus(node: TraceNode): string {
  if (node.discarded) return "Deleted";
  if (node.state === "running") return "Generating";
  if (node.state === "uncertain") return "Interrupted";
  if (node.state === "missing") return "Missing";
  if (node.state === "unavailable") return "Unavailable";
  if (node.earlierRevision) return "Earlier revision";
  return "";
}

async function guarded(id: number, work: () => Promise<void>): Promise<void> {
  if (!imageActionState.begin(id)) return;
  try { await work(); traceInvalidation.bump(); }
  finally { imageActionState.end(id); }
}

export function nodeTarget(node: TraceNode, componentId: string, directory: string, callbacks: TargetCallbacks): PreviewTarget {
  const data: TraceTargetData = { kind: "trace-node", key: node.key, componentId, directory };
  const status = nodeStatus(node);
  const unsaved = node.temporary && !node.discarded && node.artifactId !== null;
  const present = node.state === "present" && !node.earlierRevision && !node.discarded;
  const id = node.artifactId;
  const actions: PreviewTarget["actions"] = unsaved && id !== null ? [
    { id: "save", label: "Save", icon: "save", title: "Save with the default filename", disabled: !present || imageActionState.busy(id),
      run: () => guarded(id, async () => {
        const current = callbacks.capture?.() ?? (() => true);
        const { path } = await saveGeneratedImage(id);
        if (current()) callbacks.saved(path, node.key);
      }) },
    { id: "save-as", label: "Save as…", icon: "save-as", title: "Choose a filename and folder", disabled: !present || imageActionState.busy(id),
      run: () => guarded(id, async () => {
        const current = callbacks.capture?.() ?? (() => true);
        const suggestion = await imageSaveSuggestion(id);
        const picked = await host().pickSaveFile({ ...suggestion, title: "Save generated image" });
        if (!picked) return;
        const { path } = await saveGeneratedImage(id, picked);
        if (current()) callbacks.saved(path, node.key);
      }) },
    { id: "delete", label: `Delete ${nodeTitle(node)}`, icon: "delete", title: "Delete unsaved image", disabled: imageActionState.busy(id),
      run: () => guarded(id, async () => { await discardGeneratedImage(id); callbacks.discarded(node.key); }) },
  ] : [];
  return {
    id: `trace:${node.key}`,
    title: nodeTitle(node),
    typeLabel: nodeTypeLabel(node),
    imagePath: present && node.path ? node.path : undefined,
    badge: unsaved ? "Unsaved" : status || undefined,
    details: [{ label: "Location", value: node.location }],
    actions,
    data,
  };
}
