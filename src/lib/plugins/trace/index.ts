import { hostSupportsFileViewEligibilityPending } from "../../../sdk";
import { compatibleFolderEligibility } from "$lib/domain/folder-eligibility";
import type { Plugin } from "../api";
import { traceInvalidation } from "./invalidation.svelte";
import { traceFolderVisibility } from "./folder-visibility.svelte";
import { registerLineage, lineageSubscriptions } from "./lineage";
import { traceBackend } from "./view/backend";
import { traceThumbnails } from "./thumbnail-cache";
import { promptTitles } from "./prompt-titles.svelte";
import { tracePanes, isTraceTargetData } from "./view/pane-registry.svelte";
import { disposeLayouts } from "./view/layout-client";
import { forgetFolderSnapshots } from "./view/folder-session.svelte";
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
    forgetFolderSnapshots();
    tracePanes.clear();
    traceFolderVisibility.clear();
    lineageSubscriptions.clear();
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
    // Backend is configured by src/index.ts before activation. Start before
    // registering views; capable hosts hold neutral first paint while eligibility is pending.
    const preload = traceFolderVisibility.preload();
    const supportsPending = hostSupportsFileViewEligibilityPending();
    ctx.registerFileView?.({
      id: TRACE_VIEW_ID,
      title: "Trace",
      component: TraceView,
      props: { toast: ctx.toast },
      reveal: async (targetId, pane, signal) => {
        const view = await tracePanes.waitFor(pane.paneId, pane.directory, signal);
        signal.throwIfAborted();
        await view.reveal(targetId, signal);
      },
      available: (directory) => compatibleFolderEligibility(traceFolderVisibility.available(directory), supportsPending),
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
    registerLineage(ctx, traceBackend, (directory) => traceFolderVisibility.available(directory), promptTitles);
    ctx.events.listen<string>("trace:changed", () => { traceInvalidation.bump(); traceFolderVisibility.refreshRecent(); lineageSubscriptions.notifyAll(); });
    ctx.workspace.onFilesChanged((directories) => { traceInvalidation.bump(); traceFolderVisibility.filesChanged(directories); lineageSubscriptions.notifyDirectories(directories); });
    return preload;
  },
};
