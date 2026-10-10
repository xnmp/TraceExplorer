import type { Plugin, PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { parentDir } from "$lib/domain/path";
import OpenAIImageDialog from "./OpenAIImageDialog.svelte";
import OpenAIImageEditorTool from "./OpenAIImageEditorTool.svelte";
import OpenAIImageHistory from "./OpenAIImageHistory.svelte";
import { tracePanes } from "../trace/view/pane-registry.svelte";
import { imageInputPaths, singleImagePath } from "$lib/domain/image-inputs";

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

async function open(ctx: PluginContext, inputs: readonly string[], outputDir: string): Promise<void> {
  ctx.openDialog(DIALOG_ID, {
    inputs: inputs.map((path) => ({ path })), outputDir,
    jobs: ctx.jobs, toast: ctx.toast,
    configureConnections: () => configureConnections(ctx),
    captureSelection: ctx.workspace.captureSelection,
  });
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
      when: () => selectedImages(ctx).paths.length > 0,
      handler: () => {
        const selected = selectedImages(ctx);
        if (selected.paths.length) return open(ctx, selected.paths, selected.outputDir);
        ctx.toast.show("Select one to eight PNG, JPEG, or WebP images first", "info");
      },
    });
    // Feature-detected: older hosts have no direct editor entry, so neither contribution is offered there.
    const openInEditor = ctx.presentation?.openImageEditor?.bind(ctx.presentation);
    if (openInEditor) {
      const edit = async (path: string) => {
        try { await openInEditor({ path, tool: EDITOR_TOOL_ID }); }
        catch (error) { ctx.toast.show(error instanceof Error ? error.message : String(error), "error"); }
      };
      ctx.registerContextMenuItem({
        id: "openai-image.edit-in-editor", label: "Edit in image editor with AI…", group: "ai",
        when: (entries) => singleImagePath(entries) !== null,
        handler: (entries) => { const path = singleImagePath(entries); if (path) return edit(path); },
      });
      ctx.registerCommand({
        id: "plugin.openai-image.edit-in-editor", label: "AI Edit in Image Editor…", category: "plugins",
        when: () => singleImagePath(ctx.workspace.getSelection()) !== null,
        handler: () => {
          const path = singleImagePath(ctx.workspace.getSelection());
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
