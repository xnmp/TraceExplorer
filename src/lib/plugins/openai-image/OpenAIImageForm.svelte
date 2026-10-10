<script lang="ts">
  import { tick, untrack, onDestroy, onMount } from "svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginToast } from "../api";
  import { describeImageInputs, describeImageService, type ImageServiceAvailability, type OpenAIImageRequest } from "$lib/api/openai-image";
  import { availabilityProblem, capabilityProblem, connectionFields, connectionFor, connectionNeedsReview, type ImageConnection } from "./connections";
  import { startImageJob } from "./image-jobs";
  import { describeInputs, inputRequestFields, moveInput, removeInput, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";
  import TraceThumbnail from "../trace/TraceThumbnail.svelte";
  import { basename } from "$lib/domain/path";
  import { imageOutputFilename } from "$lib/domain/image-output-filename";
  import { imageGenerationSize, type ImageResolution, type ImageAspectRatio } from "$lib/domain/image-generation-settings";

  interface Props {
    open: boolean;
    onBusyChange?: (busy: boolean) => void;
    captureSelection?: ()=>()=>boolean;
    /** The images to edit, in the order they are numbered and sent; none for a new image. */
    inputs?: readonly ImageInput[];
    outputDir: string;
    configureConnections?: () => Promise<void>;
    jobs: PluginJobs;
    toast: PluginToast;
    onClose: () => void;
  }
  let { open, onBusyChange = () => {}, captureSelection, inputs = [], outputDir,
    configureConnections, jobs, toast, onClose }: Props = $props();
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
  let availability = $state.raw<ImageServiceAvailability | null>(null);
  let connectionError = $state("");
  let loadingConnections = $state(true);
  let configuring = $state(false);
  let configurationError = $state("");
  let selectedConnection = $state<string | null>(null);
  let pinnedConnection = $state.raw<ImageConnection | null>(null);
  let pinnedProvider = $state<string | undefined>(undefined);
  let modelOverride = $state("");
  let quality = $state<OpenAIImageRequest["quality"]>("auto");
  let background = $state<OpenAIImageRequest["background"]>("auto");
  const profile = $derived(pinnedConnection);
  const latestConnection = $derived(connectionFor(availability?.description, selectedConnection));
  const removedConnection = $derived(!!availability?.available && !!profile && !latestConnection);
  const needsReview = $derived(!!profile && !!latestConnection && connectionNeedsReview(profile, latestConnection, pinnedProvider, availability?.providerDigest));
  const availabilityError = $derived(connectionError || availabilityProblem(availability));
  let connectionReads = 0;
  async function refreshConnections(): Promise<void> {
    const read = ++connectionReads;
    loadingConnections = true;
    const result = await describeImageService();
    if (!alive || read !== connectionReads) return;
    loadingConnections = false;
    connectionError = result.ok ? "" : result.error;
    availability = result.ok ? result.data : null;
    if (result.ok && selectedConnection === null) {
      selectedConnection = result.data.description?.defaultConnectionId ?? "";
      chooseConnection(selectedConnection);
    }
  }
  function chooseConnection(id: string): void {
    selectedConnection = id;
    pinnedConnection = connectionFor(availability?.description, id);
    pinnedProvider = availability?.providerDigest;
    modelOverride = pinnedConnection?.transport === "openai-images" ? pinnedConnection.defaultModel : "";
    quality = "auto";
    background = "auto";
  }
  function reviewConnection(): void {
    if (!latestConnection) return;
    pinnedConnection = latestConnection;
    pinnedProvider = availability?.providerDigest;
  }
  async function configure(): Promise<void> {
    if (configuring || submitting) return;
    configuring = true;
    configurationError = "";
    try {
      if (!configureConnections) throw new Error("This host cannot open shared image settings. Update the host, then configure Image Generation in Plugins.");
      await configureConnections();
      if (alive) await refreshConnections();
    } catch (cause) { if (alive) configurationError = cause instanceof Error ? cause.message : String(cause); }
    finally { if (alive) configuring = false; }
  }
  let alive = true;
  onDestroy(()=>{alive=false;});
  let prompt = $state("");
  let resolution = $state<ImageResolution>("2k");
  let aspectRatio = $state<ImageAspectRatio>(editing ? "keep" : "1:1");
  let count = $state(1);
  let submitting = $state(false);
  let error = $state("");
  let formRef = $state<HTMLFormElement | null>(null);
  let promptRef = $state<HTMLTextAreaElement | null>(null);
  $effect(() => { onBusyChange(submitting || configuring); });
  $effect(() => {
    if (!open) return;
    void tick().then(() => { if (alive) promptRef?.focus(); });
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
    void refreshConnections();
    if (!arranged.length) return;
    void describe().then((problem) => { if (problem && alive && submits === 0) error = problem; });
  });

  async function move(index: number, to: number, control: "left" | "right"): Promise<void> {
    const path = images[index]?.path;
    arranged = moveInput(arranged, index, to);
    await tick();
    if (!alive) return;
    // Keep focus on the moved image's control, so repeated presses keep moving it.
    const card = [...stripRef?.querySelectorAll<HTMLElement>("[data-input-path]") ?? []].find((element) => element.dataset.inputPath === path);
    const button = card?.querySelector<HTMLButtonElement>(`[data-move="${control}"]`);
    (button && !button.disabled ? button : card?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)"))?.focus();
  }
  async function remove(index: number): Promise<void> {
    arranged = removeInput(arranged, index);
    await tick();
    if (!alive) return;
    // Focus moves to the next image's Remove button (the previous one's, after the last), or the strip.
    const buttons = [...stripRef?.querySelectorAll<HTMLButtonElement>("[data-remove]") ?? []];
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next && !next.disabled ? next : stripRef)?.focus();
  }
  async function submit(): Promise<void> {
    if (submitting || configuring || loadingConnections || !prompt.trim()) return;
    submits += 1;
    submitting = true;
    error = "";
    let accepted = 0;
    try {
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Choose between 1 and 8 images");
      if (availabilityError) throw new Error(availabilityError);
      if (removedConnection) throw new Error("The selected connection was removed. Select another connection.");
      if (needsReview) throw new Error("Review the updated connection before generating.");
      const connection = profile;
      if (!connection) throw new Error("Select a configured image connection.");
      const keepsSize = editing && aspectRatio === "keep";
      // A failed or unfinished read is tried again: it pins revisions and gives Image 1's size.
      if (images.some((input) => !input.digest && !input.error) || (keepsSize && !images[0]?.size)) {
        const problem = await describe();
        if (problem && keepsSize && !images[0]?.size) throw new Error(`${problem}. Try again, or choose an aspect ratio`);
      }
      if (!alive) return;
      const unusable = images.find((input) => input.error);
      if (unusable) throw new Error(`Remove ${basename(unusable.path)}: ${unusable.error}`);
      if (keepsSize && !images[0]?.size) throw new Error("Wait for Image 1 to load, or choose an aspect ratio");
      const size = imageGenerationSize(resolution, aspectRatio, images[0]?.size);
      const outputFilename = imageOutputFilename(images[0] ? basename(images[0].path) : null);
      const fields = inputRequestFields(images);
      const settings = { ...connectionFields(connection, modelOverride), size, quality, background };
      const problem = capabilityProblem(connection, settings, images.length);
      if (problem) throw new Error(problem);
      const batchId = count > 1 ? crypto.randomUUID() : null;
      for (let index = 0; index < count; index += 1) {
      if (!alive) break;
      const result = await startImageJob({ jobs },
        { label: count > 1 ? `${outputFilename} (${index + 1}/${count})` : outputFilename, detail: prompt.trim() },
        { ...fields, outputDir,
          ...(batchId ? {batch:{id:batchId,index,count}} : {}),
          prompt: prompt.trim(), outputFilename, ...settings, resolution, aspectRatio });
      if (!result.ok) throw new Error(result.error);
      accepted += 1;
      }
      if (alive) onClose();
    } catch (cause) {
      if (accepted) { if (alive) { toast.error(`Started ${accepted} of ${count} images: ${cause instanceof Error ? cause.message : String(cause)}`); onClose(); } return; }
      if (!alive) return;
      error = cause instanceof Error ? cause.message : String(cause);
      submitting = false;
      // The prompt was disabled while submitting, which dropped its focus: give it back to try again.
      await tick();
      if (alive) promptRef?.focus();
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.target instanceof Node && formRef?.contains(event.target)) keydown(event); }} />

  <form bind:this={formRef} onsubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Image generation">
    <div class="dialog-body">
      <div class="model-row">
        <label class="prompt-field model-field">Image connection
          <select class="model-select" aria-label="Image connection" value={latestConnection?.id ?? ""} disabled={submitting || configuring || loadingConnections}
            onchange={(event) => chooseConnection(event.currentTarget.value)}>
            <option value="">Select a connection</option>
            {#each availability?.description?.profiles ?? [] as connection (connection.id)}<option value={connection.id}>{connection.name}</option>{/each}
          </select>
        </label>
        <button type="button" class="btn btn-secondary" disabled={submitting || configuring} onclick={() => void configure()}>{configuring ? "Configuring…" : "Configure connections"}</button>
        <button type="button" class="btn btn-secondary" disabled={submitting || configuring || loadingConnections} onclick={() => void refreshConnections()}>Reload connections</button>
      </div>
      {#if availabilityError}<p class="error" role="status">{availabilityError}</p>{/if}
      {#if configurationError}<p class="error" role="alert">{configurationError}</p>{/if}
      {#if removedConnection}<p class="error" role="status">The selected connection was removed. Select another connection.</p>{/if}
      {#if needsReview}
        <p class="error" role="status">This connection changed. Review its updated model and options before generating.</p>
        <p class="hint">Updated connection: {latestConnection?.name} · {latestConnection?.transport === "codex-cli" ? "Codex, adapter-managed model" : `HTTP, default model ${latestConnection?.defaultModel}`}</p>
        <button type="button" class="btn btn-secondary" disabled={submitting || configuring || loadingConnections} onclick={reviewConnection}>Use updated connection</button>
      {/if}
      {#if profile?.transport === "openai-images"}
        <label class="prompt-field">Image model
          <input class="prompt-input" aria-label="Image model" bind:value={modelOverride} placeholder={profile.defaultModel} disabled={submitting || configuring} maxlength="256" />
          <span class="hint">Leave blank to use {profile.defaultModel}. Custom model IDs are supported.</span>
        </label>
      {:else if profile}<p class="hint">Codex uses saved login. The image model is adapter-managed.</p>{/if}
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
          <select class="model-select" aria-label="Resolution" bind:value={resolution} disabled={submitting || configuring}>
            <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
          </select>
        </label>
        <label class="prompt-field">Aspect ratio
          <select class="model-select" aria-label="Aspect ratio" bind:value={aspectRatio} disabled={submitting || configuring}>
            {#if editing}<option value="keep">Keep (Image 1)</option>{/if}
            {#each ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as ratio}<option value={ratio}>{ratio}</option>{/each}
          </select>
        </label>
        <label class="prompt-field">Images
          <input class="prompt-input" type="number" min="1" max="8" step="1" bind:value={count} disabled={submitting} aria-label="Images" />
        </label>
        <label class="prompt-field">Quality
          <select class="model-select" aria-label="Quality" bind:value={quality} disabled={submitting || configuring || !profile}>
            {#each profile?.capabilities.quality ?? ["auto"] as option}<option value={option}>{option}</option>{/each}
          </select>
        </label>
        <label class="prompt-field">Background
          <select class="model-select" aria-label="Background" bind:value={background} disabled={submitting || configuring || !profile}>
            {#each profile?.capabilities.background ?? ["auto"] as option}<option value={option}>{option}</option>{/each}
          </select>
        </label>
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <button class="btn btn-primary" type="submit" disabled={!prompt.trim() || submitting || configuring || loadingConnections || !profile || !!availabilityError || removedConnection || needsReview} title="Ctrl+Enter">{submitting ? "Starting…" : "Generate"}</button>
    </footer>
  </form>

<style>
  form { display: flex; flex-direction: column; min-height: 0; }
  .dialog-body { overflow: auto; min-height: 0; }
  .model-row { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .model-field { flex: 1; min-width: 150px; margin: 0; }
  footer { flex-shrink: 0; padding: 0 20px 16px; display: flex; align-items: end; justify-content: flex-end; gap: 8px; }
  /* One row of settings in the dialog; fewer columns where it is narrow (the image editor's tool panel). */
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 12px; }
  .options .prompt-input, .options .model-select { width: 100%; box-sizing: border-box; min-width: 0; }
  .options .prompt-field { margin-bottom: 0; }
  label { font-size: 12px; color: var(--text-secondary); }
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
