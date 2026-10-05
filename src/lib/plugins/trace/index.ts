import type { Plugin } from "../api";
import { isImageFile, isSvgFile } from "$lib/domain/file-types";
import { isVirtualPath } from "$lib/domain/virtual-path";
import TraceInspector from "./TraceInspector.svelte";
import { traceVisibility } from "./visibility.svelte";
import { traceInvalidation } from "./invalidation.svelte";
import { clearTraceCache } from "./view-cache";

export const tracePlugin: Plugin = {
  id: "trace",
  name: "Trace",
  description: "Read-only provenance for image edits recorded by Tauri Explorer.",
  enabledByDefault: true,
  deactivate: clearTraceCache,
  activate(ctx) {
    ctx.registerInspector({
      id: "trace.lineage",
      title: "Trace",
      component: TraceInspector,
      props: { onSelectFile: ctx.workspace.selectFile, captureSelection: ctx.workspace.captureSelection },
      when: (entries) => {
        if(!traceVisibility.visible)return false;
        const image=entries.length===1&&!isVirtualPath(entries[0].path)&&(isImageFile(entries[0])||isSvgFile(entries[0]));
        return image||(entries.length===0&&traceVisibility.keepsEmpty);
      },
    });
    ctx.registerCommand({
      id: "plugin.trace.toggle", label: "Toggle Trace Pane", category: "view",
      handler: () => traceVisibility.toggle(),
    });
    ctx.events.listen<string>("trace:changed", () => traceInvalidation.bump());
    ctx.workspace.onFilesChanged(() => traceInvalidation.bump());
  },
};
