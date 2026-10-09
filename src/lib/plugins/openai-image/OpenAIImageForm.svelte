<script lang="ts">
  import { tick, untrack, onDestroy, onMount } from "svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginStorage, PluginToast } from "../api";
  import { describeImageInputs, type OpenAIImageRequest } from "$lib/api/openai-image";
  import { startImageJob } from "./image-jobs";
  import { describeInputs, inputRequestFields, moveInput, removeInput, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";
  import TraceThumbnail from "../trace/TraceThumbnail.svelte";
  import { basename } from "$lib/domain/path";
  import { imageOutputFilename } from "$lib/domain/image-output-filename";
  import { imageGenerationSize, type ImageResolution, type ImageAspectRatio } from "$lib/domain/image-generation-settings";
  import { promptTitles } from "../trace/prompt-titles.svelte";

  interface Props {
    open: boolean;
    onBusyChange?: (busy: boolean) => void;
    captureSelection?: ()=>()=>boolean;
    /** The images to edit, in the order they are numbered and sent; none for a new image. */
    inputs?: readonly ImageInput[];
    outputDir: string;
    apiKey: string;
    codexPath?: string;
    initialBackend?: "codex" | "api_key";
    storage: PluginStorage;
    onSaveSettings: (patch: Record<string, unknown>) => Promise<void>;
    jobs: PluginJobs;
    toast: PluginToast;
    onClose: () => void;
  }
  let { open, onBusyChange = () => {}, captureSelection, inputs = [], outputDir,
    apiKey, codexPath = "", initialBackend = "codex", storage, onSaveSettings, jobs, toast, onClose }: Props = $props();
  /** The edit's images as arranged here: order, removals, and what the backend reported. */
  let arranged = $state.raw<readonly ImageInput[]>(untrack(() => inputs));
  /**
   * The edit's images, numbered in this order, which is the order they are
   * sent. The caller stays live: the image editor keeps this form mounted while
   * its source fills in (Image 1's size arrives once its preview has loaded).
   */
  const images = $derived(withLiveInputs(arranged, inputs));
  const editing = untrack(() => inputs.length > 0);
  let stripRef = $state<HTMLOListElement | null>(null);
  let selectedModel = $state("codex");
  let alive = true;
  onDestroy(()=>{alive=false;});
  let prompt = $state("");
  let resolution = $state<ImageResolution>("2k");
  let aspectRatio = $state<ImageAspectRatio>(editing ? "keep" : "1:1");
  let count = $state(1);
  let submitting = $state(false);
  let error = $state("");
  let settingsOpen = $state(false);
  let savingSettings = $state(false);
  let connectionKey = $state(untrack(() => apiKey));
  let executable = $state(untrack(() => codexPath));
  let draftKey = $state("");
  let draftExecutable = $state("");
  let titleGenerator = $state("codex");
  let titleExecutable = $state("");
  let titleSettingsReady = $state(false);
  let formRef = $state<HTMLFormElement | null>(null);
  let promptRef = $state<HTMLTextAreaElement | null>(null);
  $effect(() => { onBusyChange(submitting || savingSettings); });
  $effect(() => {
    if (!open) return;
    untrack(() => { selectedModel = initialBackend === "api_key" ? "gpt-image-2" : "codex"; });
    void tick().then(() => promptRef?.focus());
  });
  let describing: Promise<string | null> | null = null;
  /** Reads each input's revision and size; resolves to why it could not, if it could not. Inputs keep what is already known. */
  function describe(): Promise<string | null> {
    describing ??= describeImageInputs(arranged.map((input) => input.path))
      .then((result) => {
        if (!result.ok) return `Could not read the input images: ${result.error}`;
        if (alive) arranged = describeInputs(arranged, result.data.map(({ path, digest, width, height, error }) => ({
          path, digest, error, size: width && height ? { width, height } : undefined,
        })));
        return null;
      }, (cause: unknown) => `Could not read the input images: ${cause instanceof Error ? cause.message : String(cause)}`)
      .finally(() => { describing = null; });
    return describing;
  }
  /** Generate presses so far: a later one owns the error shown. */
  let submits = 0;
  onMount(() => {
    if (!arranged.length) return;
    void describe().then((problem) => { if (problem && alive && submits === 0) error = problem; });
  });

  async function move(index: number, to: number, control: "left" | "right"): Promise<void> {
    const path = images[index]?.path;
    arranged = moveInput(arranged, index, to);
    await tick();
    // Keep focus on the moved image's control, so repeated presses keep moving it.
    const card = [...stripRef?.querySelectorAll<HTMLElement>("[data-input-path]") ?? []].find((element) => element.dataset.inputPath === path);
    const button = card?.querySelector<HTMLButtonElement>(`[data-move="${control}"]`);
    (button && !button.disabled ? button : card?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)"))?.focus();
  }
  async function remove(index: number): Promise<void> {
    arranged = removeInput(arranged, index);
    await tick();
    // Focus moves to the next image's Remove button (the previous one's, after the last), or the strip.
    const buttons = [...stripRef?.querySelectorAll<HTMLButtonElement>("[data-remove]") ?? []];
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next && !next.disabled ? next : stripRef)?.focus();
  }
  async function submit(): Promise<void> {
    if (submitting || settingsOpen || !prompt.trim()) return;
    submits += 1;
    submitting = true;
    error = "";
    let accepted = 0;
    try {
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Choose between 1 and 8 images");
      const keepsSize = editing && aspectRatio === "keep";
      // A failed or unfinished read is tried again: it pins revisions and gives Image 1's size.
      if (images.some((input) => !input.digest && !input.error) || (keepsSize && !images[0]?.size)) {
        const problem = await describe();
        if (problem && keepsSize && !images[0]?.size) throw new Error(`${problem}. Try again, or choose an aspect ratio`);
      }
      const unusable = images.find((input) => input.error);
      if (unusable) throw new Error(`Remove ${basename(unusable.path)}: ${unusable.error}`);
      if (keepsSize && !images[0]?.size) throw new Error("Wait for Image 1 to load, or choose an aspect ratio");
      const size = imageGenerationSize(resolution, aspectRatio, images[0]?.size);
      const outputFilename = imageOutputFilename(images[0] ? basename(images[0].path) : null);
      const fields = inputRequestFields(images);
      const backend = selectedModel === "codex" ? "codex" : "api_key";
      const batchId = count > 1 ? crypto.randomUUID() : null;
      for (let index = 0; index < count; index += 1) {
      const result = await startImageJob({ jobs, storage },
        { label: count > 1 ? `${outputFilename} (${index + 1}/${count})` : outputFilename, detail: prompt.trim() },
        { ...fields, outputDir,
          ...(batchId ? {batch:{id:batchId,index,count}} : {}),
          prompt: prompt.trim(), outputFilename, backend, codexPath: backend === "codex" ? executable : undefined,
          model: (selectedModel === "codex" ? "gpt-image-2" : selectedModel) as OpenAIImageRequest["model"],
          size, resolution, aspectRatio, quality: "auto", background: "auto" }, backend === "api_key" ? connectionKey : "");
      if (!result.ok) throw new Error(result.error);
      accepted += 1;
      }
      if (alive) onClose();
    } catch (cause) {
      if (accepted) { toast.error(`Started ${accepted} of ${count} images: ${cause instanceof Error ? cause.message : String(cause)}`); if (alive) onClose(); return; }
      error = cause instanceof Error ? cause.message : String(cause);
      submitting = false;
      // The prompt was disabled while submitting, which dropped its focus: give it back to try again.
      await tick();
      promptRef?.focus();
    }
  }

  function openSettings(): void {
    draftKey = connectionKey;
    draftExecutable = executable;
    error = "";
    settingsOpen = true;
    titleSettingsReady = false;
    void storage.get().then(settings=>{
      if (settingsOpen) {
        titleGenerator = settings.titleGenerator === "disabled" ? "disabled" : "codex";
        titleExecutable = typeof settings.titleCodexPath === "string" ? settings.titleCodexPath : "";
        titleSettingsReady = true;
      }
    }).catch(()=>{ error = "Could not load title generator settings"; });
  }
  async function saveSettings(): Promise<void> {
    if (savingSettings || !titleSettingsReady) return;
    savingSettings = true;
    error = "";
    const patch = { apiKey: draftKey.trim(), codexPath: draftExecutable.trim(), backend: selectedModel === "codex" ? "codex" : "api_key", titleGenerator, titleCodexPath: titleExecutable.trim() };
    try {
      await onSaveSettings(patch);
      if (!storage.subscribe) void promptTitles.configure(patch);
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
      <label class="prompt-field">Title generator
        <select class="model-select" bind:value={titleGenerator} disabled={savingSettings || !titleSettingsReady}>
          <option value="codex">Codex credentials (Luna, low effort)</option><option value="disabled">Off</option>
        </select>
      </label>
      {#if titleGenerator === "codex"}
        <label class="prompt-field">Title generator Codex path
          <input class="prompt-input" bind:value={titleExecutable} placeholder="Use image connection" disabled={savingSettings || !titleSettingsReady}/>
        </label>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <button type="button" class="btn btn-secondary" disabled={savingSettings} onclick={() => { settingsOpen = false; error = ""; }}>Back</button>
      <button type="submit" class="btn btn-primary" disabled={savingSettings || !titleSettingsReady}>{savingSettings ? "Saving…" : "Save settings"}</button>
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
      {#if images.length}
        <div class="prompt-field">
          <span id="openai-image-inputs-label">Inputs <span class="hint">— Image 1, Image 2, … in the order sent</span></span>
          <ol class="strip" aria-labelledby="openai-image-inputs-label" tabindex="-1" bind:this={stripRef}>
            {#each images as input, index (input.path)}
              <li class="input-card" class:invalid={!!input.error} data-input-path={input.path} aria-label="Image {index + 1}: {basename(input.path)}">
                <span class="thumb"><TraceThumbnail path={input.path} present={!input.error} revision={0} label="" /></span>
                <span class="number">Image {index + 1}</span>
                <span class="name" title={input.path}>{basename(input.path)}</span>
                {#if input.error}<span class="input-error" title={input.error}>Can’t use: {input.error}</span>{/if}
                <span class="card-actions">
                  <button type="button" data-move="left" aria-label="Move Image {index + 1} earlier" title="Move earlier" disabled={submitting || index === 0} onclick={() => void move(index, index - 1, "left")}>‹</button>
                  <button type="button" data-move="right" aria-label="Move Image {index + 1} later" title="Move later" disabled={submitting || index === images.length - 1} onclick={() => void move(index, index + 1, "right")}>›</button>
                  <button type="button" data-remove aria-label="Remove Image {index + 1}" title={images.length > 1 ? "Remove" : "An edit needs at least one image"} disabled={submitting || images.length <= 1} onclick={() => void remove(index)}>×</button>
                </span>
              </li>
            {/each}
          </ol>
        </div>
      {/if}
      <label class="prompt-field">{editing ? "Edit prompt" : "Image prompt"}
        <textarea class="prompt-input" rows="4" maxlength="16000" bind:value={prompt} bind:this={promptRef} disabled={submitting} required
          placeholder={images.length > 1 ? "Describe your edit. Refer to images by number, e.g. “the hat in Image 2”…" : editing ? "Describe your edit…" : "Describe your image…"}></textarea>
      </label>
      <div class="options">
        <label class="prompt-field">Resolution
          <select class="model-select" aria-label="Resolution" bind:value={resolution} disabled={submitting}>
            <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
          </select>
        </label>
        <label class="prompt-field">Aspect ratio
          <select class="model-select" aria-label="Aspect ratio" bind:value={aspectRatio} disabled={submitting}>
            {#if editing}<option value="keep">Keep (Image 1)</option>{/if}
            {#each ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as ratio}<option value={ratio}>{ratio}</option>{/each}
          </select>
        </label>
        <label class="prompt-field">Images
          <input class="prompt-input" type="number" min="1" max="8" step="1" bind:value={count} disabled={submitting} aria-label="Images" />
        </label>
        <label class="prompt-field">Temperature
          <input class="prompt-input" value="Not supported" disabled aria-label="Temperature" />
        </label>
        <label class="prompt-field">Seed
          <input class="prompt-input" aria-label="Seed" value="Not supported" disabled title="This model does not expose a seed" />
        </label>
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <button class="btn btn-primary" type="submit" disabled={!prompt.trim() || submitting} title="Ctrl+Enter">{submitting ? "Starting…" : "Generate"}</button>
    </footer>
  </form>
{/if}

<style>
  form { display: flex; flex-direction: column; min-height: 0; }
  .dialog-body { overflow: auto; min-height: 0; }
  .model-row { display: flex; align-items: end; gap: 8px; }
  .model-field { flex: 1; min-width: 0; margin: 0; }
  .settings-button { min-width: 0; width: 36px; height: 36px; padding: 0; display: grid; place-items: center; }
  footer { flex-shrink: 0; padding: 0 20px 16px; display: flex; align-items: end; justify-content: flex-end; gap: 8px; }
  /* One row of settings in the dialog; fewer columns where it is narrow (the image editor's tool panel). */
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 12px; }
  .options .prompt-input, .options .model-select { width: 100%; box-sizing: border-box; min-width: 0; }
  .options .prompt-field { margin-bottom: 0; }
  label { font-size: 12px; color: var(--text-secondary); }
  h3 { margin: 0 0 16px; font-size: 14px; color: var(--text-primary); }
  textarea { resize: vertical; min-height: 88px; box-sizing: border-box; }
  .hint { color: var(--text-tertiary); }
  .strip { display: flex; gap: 8px; margin: 0; padding: 2px 2px 6px; list-style: none; overflow-x: auto; }
  .strip:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .input-card { position: relative; flex: 0 0 96px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); }
  .input-card.invalid { border-color: var(--system-critical); }
  .thumb { display: block; height: 56px; overflow: hidden; border-radius: 4px; }
  .thumb :global(.thumbnail) { height: 56px !important; flex-basis: auto !important; }
  .number { font-size: 12px; font-weight: 600; color: var(--text-primary); }
  .name { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .input-error { font-size: 11px; color: var(--system-critical-text, var(--system-critical)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-actions { display: flex; gap: 4px; }
  .card-actions button { flex: 1; min-width: 0; height: 22px; padding: 0; font: inherit; font-size: 14px; line-height: 1; color: var(--text-primary); background: var(--subtle-fill); border: 1px solid var(--control-stroke); border-radius: 4px; cursor: pointer; }
  .card-actions button:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .card-actions button:disabled { opacity: 0.4; cursor: default; }
  .card-actions button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .error { color: var(--system-critical-text, var(--system-critical)); font-size: 12px; overflow-wrap: anywhere; margin: 12px 0 0; }
</style>
