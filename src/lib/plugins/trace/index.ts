import type { Plugin } from "../api";
import { selectedTraceImage } from "$lib/domain/trace-selection";
import TraceInspector from "./TraceInspector.svelte";
import { traceVisibility } from "./visibility.svelte";
import { traceInvalidation } from "./invalidation.svelte";
import { clearTraceCache } from "./view-cache";
import { traceFolderVisibility } from "./folder-visibility.svelte";

export const tracePlugin: Plugin = {
  id: "trace",
  name: "Trace",
  description: "Read-only provenance for image edits recorded by Tauri Explorer.",
  enabledByDefault: true,
  deactivate: () => { clearTraceCache(); traceFolderVisibility.clear(); },
  activate(ctx) {
    traceFolderVisibility.bind(ctx);
    ctx.registerInspector({
      id: "trace.lineage",
      title: "Trace",
      component: TraceInspector,
      props: { onSelectFile: ctx.workspace.selectFile, captureSelection: ctx.workspace.captureSelection },
      when: (entries) => {
        if(!traceVisibility.visible)return false;
        if (traceFolderVisibility.supported && !traceFolderVisibility.eligible) return false;
        return traceVisibility.isOpen || selectedTraceImage(entries) !== null;
      },
    });
    ctx.registerCommand({
      id: "plugin.trace.toggle", label: "Toggle Trace Pane", category: "view",
      handler: () => traceVisibility.toggle(),
    });
    ctx.events.listen<string>("trace:changed", () => {traceInvalidation.bump();traceFolderVisibility.refresh();});
    ctx.workspace.onFilesChanged(() => traceInvalidation.bump());
  },
};
