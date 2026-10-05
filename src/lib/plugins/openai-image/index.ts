import type { Plugin, PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { parentDir } from "$lib/domain/path";
import OpenAIImageDialog from "./OpenAIImageDialog.svelte";
import OpenAIImageEditorTool from "./OpenAIImageEditorTool.svelte";
import OpenAIImageEditDialog from "./OpenAIImageEditDialog.svelte";
import OpenAIImageHistory from "./OpenAIImageHistory.svelte";

const DIALOG_ID = "openai-image.create";
const singleLocal = (entries: FileEntry[]) => entries.length === 1 && !isVirtualPath(entries[0].path) ? entries[0] : null;
const images = (entries: FileEntry[]): FileEntry[] => entries.length > 0 && entries.length <= 8
  && new Set(entries.map((entry) => entry.path)).size === entries.length
  && entries.every((entry) => entry.kind === "file" && !isVirtualPath(entry.path) && /\.(png|jpe?g|webp)$/i.test(entry.name)) ? entries : [];

async function open(ctx: PluginContext, sourcePath: string | null, outputDir: string, referencePaths: string[] = []): Promise<void> {
  const settings = await ctx.storage.get();
  ctx.openDialog(sourcePath ? "openai-image.edit-window" : DIALOG_ID, {
    sourcePath, referencePaths, outputDir,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
    codexPath: typeof settings.codexPath === "string" ? settings.codexPath : "",
    initialBackend: settings.backend === "api_key" ? "api_key" : "codex",
    jobs: ctx.jobs, toast: ctx.toast,
    storage: ctx.storage,
  });
}

export const openAIImagePlugin: Plugin = {
  id: "openai-image",
  name: "OpenAI Images",
  description: "Generate and edit images with GPT Image, with durable Trace provenance.",
  enabledByDefault: true,
  activate(ctx) {
    ctx.registerSettingsSection({
      id: "openai-image", title: "AI / OpenAI Images",
      rows: [{ id: "backend", label: "Image connection", type: "select", default: "codex",
        options: [{ value: "codex", label: "Codex ChatGPT sign-in" }, { value: "api_key", label: "OpenAI API key" }],
        description: "Codex mode uses the installed Codex CLI and its existing ChatGPT sign-in." },
        { id: "codexPath", label: "Codex executable path", type: "text", default: "",
        description: "Optional full executable path. Leave blank to search PATH and common installations, including NVM. Find it with command -v codex (Windows: where codex)." },
        { id: "apiKey", label: "OpenAI API Key", type: "password",
        description: "Used in API key mode. Leave blank to use OPENAI_API_KEY from the app environment." }],
    });
    ctx.registerImageEditorTool({
      id: "openai-image", title: "AI edit", component: OpenAIImageEditorTool,
      when: (source) => ["PNG", "JPEG", "WebP"].includes(source.format),
      props: { storage: ctx.storage, jobs: ctx.jobs, toast: ctx.toast },
    });
    ctx.registerDialog({ id: "openai-image.edit-window", component: OpenAIImageEditDialog });
    ctx.registerDialog({ id: DIALOG_ID, component: OpenAIImageDialog });
    ctx.registerDialog({ id: "openai-image.history", component: OpenAIImageHistory });
    ctx.registerCommand({
      id: "plugin.openai-image.history", label: "OpenAI: Image Run History", category: "plugins",
      handler: () => ctx.openDialog("openai-image.history"),
    });
    ctx.registerContextMenuItem({
      id: "openai-image.edit", label: "Edit with OpenAI", group: "ai",
      when: (entries) => images(entries).length > 0,
      handler: (entries) => {
        const selected = images(entries);
        if (selected.length) return open(ctx, selected[0].path, parentDir(selected[0].path), selected.slice(1).map((entry) => entry.path));
      },
    });
    ctx.registerContextMenuItem({
      id: "openai-image.generate", label: "Generate image with OpenAI…", group: "ai",
      when: (entries) => singleLocal(entries)?.kind === "directory",
      handler: (entries) => {
        const selected = singleLocal(entries);
        if (selected?.kind === "directory") return open(ctx, null, selected.path);
      },
    });
    ctx.registerCommand({
      id: "plugin.openai-image.edit", label: "AI Edit Image…", category: "plugins", shortcut: "Ctrl+E",
      when: () => images(ctx.workspace.getSelection()).length > 0,
      handler: () => {
        const selected = images(ctx.workspace.getSelection());
        if (selected.length) return open(ctx, selected[0].path, parentDir(selected[0].path), selected.slice(1).map((entry) => entry.path));
        ctx.toast.show("Select one to eight PNG, JPEG, or WebP images first", "info");
      },
    });
    ctx.registerCommand({
      id: "plugin.openai-image.generate", label: "OpenAI: Generate Image…", category: "plugins",
      handler: () => {
        const selected = singleLocal(ctx.workspace.getSelection());
        if (selected) return open(ctx, null, selected.kind === "directory" ? selected.path : parentDir(selected.path));
        ctx.toast.show("Select an output folder or a file in it first", "info");
      },
    });
  },
};
