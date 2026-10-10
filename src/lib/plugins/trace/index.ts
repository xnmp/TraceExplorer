import type { Plugin } from "../api";
import { traceInvalidation } from "./invalidation.svelte";
import { traceFolderVisibility } from "./folder-visibility.svelte";
import { traceThumbnails } from "./thumbnail-cache";
import { promptTitles } from "./prompt-titles.svelte";
import { tracePanes, isTraceTargetData } from "./view/pane-registry.svelte";
import { disposeLayouts } from "./view/layout-client";
import { subjectNode } from "./view/preview-subject";
import { previewData } from "./view/preview-data.svelte";
import TraceView from "./view/TraceView.svelte";
import TracePreviewInfo from "./view/TracePreviewInfo.svelte";

export const TRACE_VIEW_ID = "trace.view";
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;

export const tracePlugin: Plugin = {
  id: "trace",
  name: "Trace",
  description: "Provenance view for image edits recorded by Tauri Explorer.",
  enabledByDefault: true,
  deactivate: () => {
    disposeLayouts();
    tracePanes.clear();
    traceFolderVisibility.clear();
    traceThumbnails.clear();
    promptTitles.unbind();
    previewData.clear();
  },
  activate(ctx) {
    promptTitles.bind(ctx);
    ctx.registerSettingsSection({
      id: "trace.summaries", title: "Trace / Prompt titles",
      rows: [{ id: "summarizePrompts", label: "Summarize prompts", type: "toggle", default: true,
        description: "Use the global language model in Settings → AI → Language models. The full prompt remains available." }],
    });
    if (ctx.text) ctx.registerCommand({
      id: "plugin.trace.language-models", label: "Trace: Configure language model", category: "plugins",
      handler: () => ctx.text?.openSettings(),
    });
    traceFolderVisibility.clear();
    ctx.registerFileView?.({
      id: TRACE_VIEW_ID,
      title: "Trace",
      component: TraceView,
      available: (directory) => traceFolderVisibility.available(directory),
    });
    ctx.registerPreviewInfo?.({
      id: "trace.info",
      component: TracePreviewInfo,
      when: (subject) => subject.kind === "target"
        ? isTraceTargetData(subject.target.data)
        : subjectNode(subject) !== null || (subject.entry.kind === "file" && IMAGE.test(subject.entry.name)),
    });
    ctx.registerCommand({
      id: "plugin.trace.toggle", label: "Toggle Trace View", category: "view", shortcut: "Alt+M P",
      handler: () => ctx.workspace.toggleFileView?.(TRACE_VIEW_ID),
    });
    ctx.events.listen<string>("trace:changed", () => { traceInvalidation.bump(); traceFolderVisibility.refreshRecent(); });
    ctx.workspace.onFilesChanged((directories) => { traceInvalidation.bump(); traceFolderVisibility.filesChanged(directories); });
  },
};
