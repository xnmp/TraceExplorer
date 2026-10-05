<script lang="ts">
  import { tick, untrack } from "svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginStorage, PluginToast } from "../api";
  import { pluginSettingsSections } from "../settings-registry.svelte";
  import { startOpenAIImageJob, type OpenAIImageRequest } from "$lib/api/openai-image";
  import { basename } from "$lib/domain/path";
  import { imageOutputFilename } from "$lib/domain/image-output-filename";
  import { imageGenerationSize, type ImageResolution, type ImageAspectRatio } from "$lib/domain/image-generation-settings";

  interface Props {
    open: boolean;
    sourceDigest?: string;
    sourceSize?: { readonly width: number; readonly height: number };
    onBusyChange?: (busy: boolean) => void;
    sourcePath: string | null;
    referencePaths?: string[];
    outputDir: string;
    apiKey: string;
    codexPath?: string;
    initialBackend?: "codex" | "api_key";
    storage: PluginStorage;
    jobs: PluginJobs;
    toast: PluginToast;
    onClose: () => void;
  }
  let { open, sourceDigest, sourceSize, onBusyChange = () => {}, sourcePath, referencePaths = [], outputDir,
    apiKey, codexPath = "", initialBackend = "codex", storage, jobs, toast, onClose }: Props = $props();
  let selectedModel = $state("codex");
  let prompt = $state("");
  let resolution = $state<ImageResolution>("2k");
  let aspectRatio = $state<ImageAspectRatio>("keep");
  let submitting = $state(false);
  let error = $state("");
  let settingsOpen = $state(false);
  let savingSettings = $state(false);
  let connectionKey = $state(untrack(() => apiKey));
  let executable = $state(untrack(() => codexPath));
  let draftKey = $state("");
  let draftExecutable = $state("");
  let formRef = $state<HTMLFormElement | null>(null);
  let promptRef = $state<HTMLTextAreaElement | null>(null);
  $effect(() => { onBusyChange(submitting || savingSettings); });
  $effect(() => {
    if (!open) return;
    untrack(() => { selectedModel = initialBackend === "api_key" ? "gpt-image-2" : "codex"; });
    void tick().then(() => promptRef?.focus());
  });

  async function submit(): Promise<void> {
    if (submitting || settingsOpen || !prompt.trim()) return;
    submitting = true;
    error = "";
    try {
      if (sourcePath && aspectRatio === "keep" && !sourceSize) throw new Error("Wait for the source image to load, or choose an aspect ratio");
      const size = imageGenerationSize(resolution, aspectRatio, sourceSize);
      const outputFilename = imageOutputFilename(sourcePath ? basename(sourcePath) : null, crypto.randomUUID());
      const backend = selectedModel === "codex" ? "codex" : "api_key";
      const result = await jobs.accept(
        { kind: "openai-image", label: outputFilename, detail: prompt.trim() },
        () => startOpenAIImageJob({ sourcePath, expectedSourceDigest: sourceDigest, referencePaths, outputDir,
          prompt: prompt.trim(), outputFilename, backend, codexPath: backend === "codex" ? executable : undefined,
          model: (selectedModel === "codex" ? "gpt-image-2" : selectedModel) as OpenAIImageRequest["model"],
          size, resolution, aspectRatio, quality: "auto", background: "auto" }, backend === "api_key" ? connectionKey : ""),
      );
      if (!result.ok) throw new Error(result.error);
      onClose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      submitting = false;
    }
  }

  function openSettings(): void {
    draftKey = connectionKey;
    draftExecutable = executable;
    error = "";
    settingsOpen = true;
  }
  async function saveSettings(): Promise<void> {
    if (savingSettings) return;
    savingSettings = true;
    error = "";
    const patch = { apiKey: draftKey.trim(), codexPath: draftExecutable.trim(), backend: selectedModel === "codex" ? "codex" : "api_key" };
    try {
      const section = pluginSettingsSections.sections.find((section) => section.pluginId === "openai-image");
      if (section) await section.save(patch);
      else {
        const next = { ...await storage.get(), ...patch };
        await (storage.setChecked?.(next) ?? storage.set(next));
      }
      connectionKey = patch.apiKey;
      executable = patch.codexPath;
      settingsOpen = false;
      await tick();
      promptRef?.focus();
    } catch (cause) {
      error = `Could not save connection settings: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally { savingSettings = false; }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.target instanceof Node && formRef?.contains(event.target)) keydown(event); }} />

{#if settingsOpen}
  <form onsubmit={(event) => { event.preventDefault(); void saveSettings(); }} aria-label="Image connection settings">
    <div class="dialog-body">
      <h3>Connection settings</h3>
      <label class="prompt-field">Codex executable path
        <input class="prompt-input" bind:value={draftExecutable} placeholder="Automatic discovery" disabled={savingSettings} />
      </label>
      <label class="prompt-field">OpenAI API key
        <input class="prompt-input" type="password" bind:value={draftKey} autocomplete="off" disabled={savingSettings} />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <button type="button" class="btn btn-secondary" disabled={savingSettings} onclick={() => { settingsOpen = false; error = ""; }}>Back</button>
      <button type="submit" class="btn btn-primary" disabled={savingSettings}>{savingSettings ? "Saving…" : "Save settings"}</button>
    </footer>
  </form>
{:else}
  <form bind:this={formRef} onsubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Image generation">
    <div class="dialog-body">
      <div class="model-row">
        <label class="prompt-field model-field">Model
          <select class="model-select" aria-label="Model" bind:value={selectedModel} disabled={submitting}>
            <option value="codex">Codex</option>
            <option value="gpt-image-2">GPT Image 2</option>
            <option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option>
            <option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option>
          </select>
        </label>
        <button type="button" class="btn btn-secondary settings-button" aria-label="Connection settings" title="Connection settings" disabled={submitting} onclick={openSettings}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <label class="prompt-field">{sourcePath ? "Edit prompt" : "Image prompt"}
        <textarea class="prompt-input" rows="6" maxlength="16000" bind:value={prompt} bind:this={promptRef} disabled={submitting} required placeholder={sourcePath ? "Describe your edit…" : "Describe your image…"}></textarea>
      </label>
      {#if referencePaths.length}<p class="references">References: {referencePaths.map(basename).join(", ")}</p>{/if}
      <div class="options">
        <label class="prompt-field">Resolution
          <select class="model-select" aria-label="Resolution" bind:value={resolution} disabled={submitting}>
            <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
          </select>
        </label>
        <label class="prompt-field">Aspect ratio
          <select class="model-select" aria-label="Aspect ratio" bind:value={aspectRatio} disabled={submitting}>
            <option value="keep">Keep the same</option>
            {#each ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as ratio}<option value={ratio}>{ratio}</option>{/each}
          </select>
        </label>
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <label class="seed-field">Seed
        <input class="prompt-input" aria-label="Seed" value="Not supported" disabled title="This model does not expose a seed" />
      </label>
      <button class="btn btn-primary" type="submit" disabled={!prompt.trim() || submitting} title="Ctrl+Enter">{submitting ? "Starting…" : "Generate"}</button>
    </footer>
  </form>
{/if}

<style>
  form { display: flex; flex-direction: column; min-height: 0; }
  .dialog-body { overflow: auto; min-height: 0; }
  .model-row { display: flex; align-items: end; gap: 8px; margin-bottom: 16px; }
  .model-field { flex: 1; min-width: 0; margin: 0; }
  .settings-button { min-width: 0; width: 36px; height: 36px; padding: 0; display: grid; place-items: center; }
  footer { padding: 12px 20px; display: flex; align-items: end; justify-content: flex-end; gap: 8px; }
  .seed-field { display: flex; flex-direction: column; gap: 6px; width: 150px; margin-right: auto; }
  .options { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 12px; }
  .options .prompt-field { margin-bottom: 0; }
  label { font-size: 12px; color: var(--text-secondary); }
  h3 { margin: 0 0 16px; font-size: 14px; color: var(--text-primary); }
  textarea { resize: vertical; min-height: 140px; box-sizing: border-box; }
  .references { margin: 0 0 16px; font-size: 12px; overflow-wrap: anywhere; }
  .error { color: var(--system-critical-text); font-size: 12px; overflow-wrap: anywhere; margin: 12px 0 0; }
  @media (max-width: 400px) { .options { grid-template-columns: 1fr; } }
</style>
