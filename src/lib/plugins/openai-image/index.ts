import type { Plugin, PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { basename, parentDir } from "$lib/domain/path";
import OpenAIImageDialog from "./OpenAIImageDialog.svelte";
import OpenAIImageEditorTool from "./OpenAIImageEditorTool.svelte";
import OpenAIImageHistory from "./OpenAIImageHistory.svelte";
import { tracePanes } from "../trace/view/pane-registry.svelte";
import { imageInputPaths, singleImagePath } from "$lib/domain/image-inputs";
import { aiEditIntent, type AIEditIntent } from "$lib/domain/ai-edit-intent";
import { combinedSelection } from "./workspace-selection";
import { aiOutputDirectory, outputLocationProblem } from "$lib/domain/target-location";
import { hostCapturePane, hostRegisterFileDropTarget } from "../../../sdk";

const EDITOR_TOOL_ID = "openai-image";
const DIALOG_ID = "openai-image.create";
const singleLocal = (entries: FileEntry[]) => entries.length === 1 && !isVirtualPath(entries[0].path) ? entries[0] : null;
const images = (entries: FileEntry[]): string[] => entries.every((entry) => entry.kind === "file" && /\.(png|jpe?g|webp)$/i.test(entry.name))
  ? imageInputPaths(entries.map((entry) => entry.path)) : [];

/**
 * The images an AI edit starts with, numbered in this order. In a Trace view
 * that is its ordered selection, which can include unsaved and outside
 * images the host cannot select; elsewhere, the host's file selection.
 */
function selectedImages(ctx: PluginContext, entries: FileEntry[] = ctx.workspace.getSelection()): { paths: string[]; outputDir: string } {
  const trace = tracePanes.active();
  const picked = trace?.inputs() ?? [];
  // Outputs are suggested for the folder the user is in, even when Image 1 is unsaved or elsewhere.
  if (trace && picked.length && entries.every((entry) => picked.includes(entry.path))) return { paths: imageInputPaths(picked), outputDir: trace.directory };
  const paths = images(entries);
  return { paths, outputDir: paths.length ? parentDir(paths[0]) : "" };
}

/** Trace picks preserve click order and unlisted inputs; other panes' selected
 * files follow them. Keep the raw entries so an invalid selection stays invalid.
 */
function commandIntent(ctx: PluginContext): { intent: AIEditIntent; outputDir: string } {
  const entries = ctx.workspace.getSelection();
  const trace = tracePanes.active();
  const picks = trace?.inputs() ?? [];
  const ordered = picks.length && entries.every((entry) => picks.includes(entry.path))
    ? picks.map((path) => entries.find((entry) => entry.path === path) ?? { path, name: basename(path), kind: "file" as const })
    : entries;
  const intent = aiEditIntent([...ordered, ...combinedSelection(ctx.workspace)], trace?.hasUnusableTarget() ?? false);
  // An older host can still supply the current Trace pane, or an edit's folder.
  const outputDir = aiOutputDirectory(ctx.workspace.getCurrentDirectory?.() ?? trace?.directory,
    intent.kind === "edit" ? intent.inputs : []);
  return { intent, outputDir };
}

async function open(ctx: PluginContext, inputs: readonly string[], outputDir: string): Promise<void> {
  // Capture synchronously: later async preparation must never retarget to another active pane.
  const capturePane = hostCapturePane(ctx.workspace);
  const pane = capturePane?.();
  if (capturePane && !pane) throw new Error("The dialog's pane is unavailable. Choose an open pane and try again.");
  // The Trace view in the pane the dialog was opened from shows the job's outputs. It is looked up
  // when a job is accepted: the pane's view may have remounted, or gone, since.
  const tracePane = pane ? (tracePanes.get(pane.paneId) ? pane.paneId : null) : tracePanes.activeId();
  const props = {
    inputs: inputs.map((path) => ({ path })), outputDir,
    onStart: tracePane ? (paths: readonly string[]) => tracePanes.get(tracePane)?.expandForOutputs(paths) : undefined,
    jobs: ctx.jobs, toast: ctx.toast,
    configureConnections: () => configureConnections(ctx),
    captureSelection: ctx.workspace.captureSelection,
    registerFileDropTarget: hostRegisterFileDropTarget(ctx.workspace) ?? undefined,
  };
  if (pane) ctx.openDialog(DIALOG_ID, props, { scope: "pane", pane });
  else ctx.openDialog(DIALOG_ID, props);
}

/** Await the provider-owned modal so callers can refresh capability state after closure. */
async function configureConnections(ctx: PluginContext): Promise<void> {
  if (!ctx.presentation?.openDialog) throw new Error("This host cannot open shared image settings. Update the host, then configure Image Generation in Plugins.");
  await ctx.presentation.openDialog("image-generation.connections");
}

export const openAIImagePlugin: Plugin = {
  id: "openai-image",
  name: "AI Images",
  description: "Generate and edit images through your Image Generation connections, with durable Trace provenance.",
  enabledByDefault: true,
  activate(ctx) {
    ctx.registerSettingsSection({
      id: "openai-image", title: "AI / Images",
      rows: [], actions: [{ id: "configure-connections", label: "Configure connections", description: "Image connections belong to the Image Generation package. Enable its settings contribution in Plugins.", run: () => configureConnections(ctx) }],
    });
    ctx.registerImageEditorTool({
      id: EDITOR_TOOL_ID, title: "AI edit", component: OpenAIImageEditorTool,
      when: (source) => ["PNG", "JPEG", "WebP"].includes(source.format),
      props: { configureConnections: () => configureConnections(ctx), jobs: ctx.jobs, toast: ctx.toast, captureSelection: ctx.workspace.captureSelection },
    });
    ctx.registerDialog({ id: DIALOG_ID, component: OpenAIImageDialog });
    ctx.registerDialog({ id: "openai-image.history", component: OpenAIImageHistory });
    ctx.registerCommand({
      id: "plugin.openai-image.history", label: "AI: Image Run History", category: "plugins",
      handler: () => ctx.openDialog("openai-image.history", { jobs: ctx.jobs }),
    });
    ctx.registerContextMenuItem({
      id: "openai-image.edit", label: "Edit with AI…", group: "ai",
      when: (entries) => selectedImages(ctx, entries).paths.length > 0,
      handler: (entries) => {
        const selected = selectedImages(ctx, entries);
        if (selected.paths.length) return open(ctx, selected.paths, selected.outputDir);
      },
    });
    ctx.registerContextMenuItem({
      id: "openai-image.generate", label: "Generate image with AI…", group: "ai",
      when: (entries) => singleLocal(entries)?.kind === "directory",
      handler: (entries) => {
        const selected = singleLocal(entries);
        if (selected?.kind === "directory") return open(ctx, [], selected.path);
      },
    });
    ctx.registerCommand({
      id: "plugin.openai-image.edit", label: "AI Edit Image…", category: "plugins", shortcut: "Ctrl+E",
      handler: () => {
        const { intent, outputDir } = commandIntent(ctx);
        if (intent.kind === "invalid") { ctx.toast.show(intent.reason, "info"); return; }
        const problem = intent.kind === "generate" && outputDir ? outputLocationProblem(outputDir) : null;
        if (problem) { ctx.toast.show(problem, "info"); return; }
        return open(ctx, intent.kind === "edit" ? intent.inputs : [], outputDir);
      },
    });
    // Feature-detected: older hosts have no direct editor entry, so neither contribution is offered there.
    const openInEditor = ctx.presentation?.openImageEditor?.bind(ctx.presentation);
    if (openInEditor) {
      // A Trace view's picks win over the host selection: the editor opens a real file only when it is the sole pick.
      const editable = (entries: FileEntry[]) => singleImagePath(entries, tracePanes.active()?.inputs() ?? []);
      const edit = async (path: string) => {
        try { await openInEditor({ path, tool: EDITOR_TOOL_ID }); }
        catch (error) { ctx.toast.show(error instanceof Error ? error.message : String(error), "error"); }
      };
      ctx.registerContextMenuItem({
        id: "openai-image.edit-in-editor", label: "Edit in image editor with AI…", group: "ai",
        when: (entries) => editable(entries) !== null,
        handler: (entries) => { const path = editable(entries); if (path) return edit(path); },
      });
      ctx.registerCommand({
        id: "plugin.openai-image.edit-in-editor", label: "AI Edit in Image Editor…", category: "plugins",
        when: () => editable(ctx.workspace.getSelection()) !== null,
        handler: () => {
          const path = editable(ctx.workspace.getSelection());
          if (path) return edit(path);
          ctx.toast.show("Select one PNG, JPEG, or WebP image first", "info");
        },
      });
    }
    ctx.registerCommand({
      id: "plugin.openai-image.generate", label: "AI: Generate Image…", category: "plugins",
      handler: () => {
        const selected = singleLocal(ctx.workspace.getSelection());
        if (selected) return open(ctx, [], selected.kind === "directory" ? selected.path : parentDir(selected.path));
        ctx.toast.show("Select an output folder or a file in it first", "info");
      },
    });
  },
};
