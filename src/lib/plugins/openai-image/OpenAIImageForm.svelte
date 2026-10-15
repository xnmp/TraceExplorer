<script lang="ts">
  import { tick, untrack, onDestroy, onMount, type Snippet } from "svelte";
  import "../plugin-dialog.css";
  import type { PluginContext, PluginJobs, PluginToast } from "../api";
  import { describeImageInputs, describeImageService, type ImageServiceAvailability, type OpenAIImageRequest } from "$lib/api/openai-image";
  import { availabilityProblem, capabilityProblem, connectionFields, connectionFor, connectionNeedsReview, fallbackOption, isApiConnection, offeredOptions, transportLabel, type ImageConnection } from "./connections";
  import { startImageJob } from "./image-jobs";
  import { describeInputSnapshot, inputRequestFields, moveInput, removeInput, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";
  import TraceThumbnail from "../trace/TraceThumbnail.svelte";
  import Select, { type SelectOption } from "../../../../integration/ui/Select.svelte";
  import { basename } from "$lib/domain/path";
  import { imageOutputFilename } from "$lib/domain/image-output-filename";
  import { imageGenerationSize, type ImageResolution, type ImageAspectRatio } from "$lib/domain/image-generation-settings";
  import { outputLocationProblem } from "$lib/domain/target-location";
  import { createImageInputIntake, imageInputIntakeStatus, type ImageInputIntakeIssue } from "./image-input-intake";
  import { prepareImageInputSubmission } from "./image-input-submission";

  interface Props {
    open: boolean;
    onBusyChange?: (busy: boolean) => void;
    captureSelection?: ()=>()=>boolean;
    registerFileDropTarget?: PluginContext["workspace"]["registerFileDropTarget"];
    header?: Snippet<[editing: boolean]>;
    /** The images to edit, in the order they are numbered and sent; none for a new image. */
    inputs?: readonly ImageInput[];
    outputDir: string;
    configureConnections?: () => Promise<void>;
    jobs: PluginJobs;
    toast: PluginToast;
    onClose: () => void;
  }
  let { open, onBusyChange = () => {}, captureSelection, registerFileDropTarget, header, inputs = [], outputDir,
    configureConnections, jobs, toast, onClose }: Props = $props();
  /** The edit's images as arranged here: order, removals, and what the backend reported. */
  let arranged = $state.raw<readonly ImageInput[]>(untrack(() => inputs.map((input) => ({ ...input, id: Symbol() }))));
  /**
   * The edit's images, numbered in this order, which is the order they are
   * sent. The caller stays live: the image editor keeps this form mounted while
   * its source fills in (Image 1's size arrives once its preview has loaded).
   */
  const images = $derived(withLiveInputs(arranged, inputs));
  const editing = $derived(images.length > 0);
  const locationProblem = $derived(outputLocationProblem(outputDir));
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
    modelOverride = pinnedConnection && isApiConnection(pinnedConnection) ? pinnedConnection.defaultModel : "";
    // Controls the new connection does not offer return to their defaults; a value it does not
    // accept falls back to a preferred, then any, offered value, so no Select is left blank.
    const offered = offeredOptions(pinnedConnection);
    const caps = pinnedConnection?.capabilities;
    quality = fallbackOption<typeof quality>("auto", "auto", caps?.quality as (typeof quality)[] | undefined);
    background = fallbackOption<typeof background>("auto", "auto", caps?.background as (typeof background)[] | undefined);
    resolution = offered.resolution || caps?.resolution?.length ? fallbackOption<ImageResolution>(resolution, "2k", caps?.resolution as ImageResolution[] | undefined) : "2k";
    aspectRatio = offered.aspectRatio || caps?.aspectRatio?.length
      ? fallbackOption<ImageAspectRatio>(aspectRatio, defaultAspectRatio, (caps?.aspectRatio as ImageAspectRatio[] | undefined)?.filter((v) => editing || v !== "keep"))
      : defaultAspectRatio;
  }
  function reviewConnection(): void {
    if (!latestConnection) return;
    pinnedConnection = latestConnection;
    pinnedProvider = availability?.providerDigest;
  }
  async function configure(): Promise<void> {
    if (configuring || submitting || inspectingDrops) return;
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
  onDestroy(()=>{alive=false; intake.dispose();});
  let prompt = $state("");
  let resolution = $state<ImageResolution>("2k");
  // This initial default is deliberately stable when an empty form receives inputs.
  const defaultAspectRatio: ImageAspectRatio = untrack(() => inputs.length > 0 ? "keep" : "1:1");
  let aspectRatio = $state<ImageAspectRatio>(defaultAspectRatio);
  let count = $state(1);
  let submitting = $state(false);
  let error = $state("");
  let formRef = $state<HTMLFormElement | null>(null);
  let promptRef = $state<HTMLTextAreaElement | null>(null);
  let inspectingDrops = $state(false);
  let dropIssues = $state.raw<readonly ImageInputIntakeIssue[]>([]);
  let dropStatus = $state("");
  // Replace the message nodes for every completion, even when their text is unchanged.
  let dropResult = $state(0);
  let feedbackLimit = $state(8);
  const visibleDropIssues = $derived(dropIssues.slice(0, feedbackLimit));
  // Pagination limits visual clutter, while every result remains in the atomic announcement.
  const remainingDropIssueText = $derived(dropIssues.slice(feedbackLimit)
    .map((issue) => `${issue.path ? basename(issue.path) : "Invalid path"}: ${issue.message}`).join(". "));
  const intake = createImageInputIntake({
    getInputs: () => images,
    inspect: async (paths) => {
      // Initial/editor inputs may still be awaiting inspection. Learn their
      // physical identities before comparing dropped aliases against them.
      if (images.some((input) => !input.canonicalPath && !input.error)) {
        const problem = await describe();
        if (problem) throw new Error(problem);
      }
      const result = await describeImageInputs(paths);
      if (!result.ok) throw new Error(result.error);
      return result.data.map(({ path, canonicalPath, digest, width, height, error }) => ({
        path, canonicalPath, id: Symbol(), digest, error, size: width && height ? { width, height } : undefined,
      }));
    },
    commit: (result) => { arranged = result.inputs; },
    blockedReason: () => !open || !alive ? "The form is closed" : submitting ? "Wait for submission to finish" : configuring ? "Close connection settings before adding inputs" : null,
    onPendingChange: (pending) => { inspectingDrops = pending; },
    onFeedback: (addedPaths, issues) => {
      dropIssues = issues;
      feedbackLimit = 8;
      dropStatus = imageInputIntakeStatus(addedPaths.length, images.length, issues.length);
      dropResult += 1;
    },
  });
  /** False when the host refused the Inputs element as a drop target; the form then works without drops. */
  let dropsAccepted = $state(true);
  function registerInputs(element: HTMLElement): { destroy: () => void } {
    let dispose: (() => void) | undefined;
    try {
      dispose = registerFileDropTarget?.(element, (paths) => intake.enqueue(paths),
        { enabled: () => open && alive && !submitting && !configuring });
    } catch (error) {
      console.warn("Image inputs cannot accept drops here:", error);
      dropsAccepted = false;
    }
    return { destroy: () => dispose?.() };
  }
  $effect(() => { onBusyChange(submitting || configuring); });
  $effect(() => {
    if (!open) return;
    void tick().then(() => { if (alive) promptRef?.focus(); });
  });
  let describing: Promise<string | null> | null = null;
  /** Reads each input's revision and size; resolves to why it could not, if it could not. Inputs keep what is already known. */
  function describe(): Promise<string | null> {
    if (describing) return describing;
    const snapshot = images;
    describing = describeImageInputs(snapshot.map((input) => input.path))
      .then((result) => {
        if (!result.ok) return `Could not read the input images: ${result.error}`;
        if (alive) arranged = describeInputSnapshot(images, snapshot, result.data.map(({ path, canonicalPath, digest, width, height, error }) => ({
          path, canonicalPath, digest, error, size: width && height ? { width, height } : undefined,
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
    if (submitting || configuring || inspectingDrops || loadingConnections || !prompt.trim()) return;
    submits += 1;
    submitting = true;
    error = "";
    let accepted = 0;
    try {
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Choose between 1 and 8 images");
      if (locationProblem) throw new Error(locationProblem);
      if (availabilityError) throw new Error(availabilityError);
      if (removedConnection) throw new Error("The selected connection was removed. Select another connection.");
      if (needsReview) throw new Error("Review the updated connection before generating.");
      const connection = profile;
      if (!connection) throw new Error("Select a configured image connection.");
      // Only a connection with pixel sizes needs Image 1's dimensions to resolve "keep".
      const keepsSize = !!connection.capabilities.sizes && editing && aspectRatio === "keep";
      await prepareImageInputSubmission({ getInputs: () => images, pendingInspection: describing, inspect: describe, keepsSize });
      if (!alive) return;
      const offered = offeredOptions(connection);
      const size = connection.capabilities.sizes ? imageGenerationSize(resolution, aspectRatio, images[0]?.size) : "auto";
      const outputFilename = imageOutputFilename(images[0] ? basename(images[0].path) : null);
      const fields = inputRequestFields(images);
      const settings = { ...connectionFields(connection, modelOverride), size, quality, background,
        ...(offered.resolution || connection.capabilities.resolution?.length ? { resolution } : {}), ...(offered.aspectRatio || connection.capabilities.aspectRatio?.length ? { aspectRatio } : {}) };
      const problem = capabilityProblem(connection, settings, images.length);
      if (problem) throw new Error(problem);
      const batchId = count > 1 ? crypto.randomUUID() : null;
      for (let index = 0; index < count; index += 1) {
      if (!alive) break;
      const result = await startImageJob({ jobs },
        { label: count > 1 ? `${outputFilename} (${index + 1}/${count})` : outputFilename, detail: prompt.trim() },
        { ...fields, outputDir,
          ...(batchId ? {batch:{id:batchId,index,count}} : {}),
          prompt: prompt.trim(), outputFilename, ...settings });
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

  const plain = (values: readonly string[]): SelectOption[] => values.map((value) => ({ value, label: value }));
  const RESOLUTIONS: SelectOption[] = [{ value: "1k", label: "1K" }, { value: "2k", label: "2K" }, { value: "4k", label: "4K" }];
  const connectionOptions = $derived((availability?.description?.profiles ?? []).map((connection): SelectOption => ({ value: connection.id, label: connection.name })));
  const offered = $derived(offeredOptions(profile));
  const resolutionOptions = $derived(profile?.capabilities.resolution ? RESOLUTIONS.filter((o) => profile.capabilities.resolution!.includes(o.value)) : RESOLUTIONS);
  const aspectRatioOptions = $derived([
    ...(editing ? [{ value: "keep", label: "Auto" }] : []),
    ...plain(["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]),
  ].filter((o) => !profile?.capabilities.aspectRatio || profile.capabilities.aspectRatio.includes(o.value)));
  const qualityOptions = $derived(plain(profile?.capabilities.quality ?? ["auto"]));
  const backgroundOptions = $derived(plain(profile?.capabilities.background ?? ["auto"]));

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.target instanceof Node && formRef?.contains(event.target)) keydown(event); }} />

  {@render header?.(editing)}
  <form bind:this={formRef} onsubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Image generation">
    <div class="dialog-body">
      <div class="model-row">
        <label class="prompt-field model-field">Image connection
          <Select aria-label="Image connection" value={latestConnection?.id ?? ""} disabled={submitting || configuring || loadingConnections}
            options={connectionOptions} placeholder="Select a connection" onchange={chooseConnection} />
        </label>
        <button type="button" class="btn btn-secondary" aria-label="Configure image connections" title="Configure image connections" disabled={submitting || configuring || inspectingDrops} onclick={() => void configure()}>{configuring ? "Configuring…" : "Configure"}</button>
        <button type="button" class="btn btn-secondary icon-btn" aria-label="Reload connections" title="Reload connections" disabled={submitting || configuring || loadingConnections} onclick={() => void refreshConnections()}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class:spinning={loadingConnections}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </div>
      {#if availabilityError}<p class="error" role="status">{availabilityError}</p>{/if}
      {#if configurationError}<p class="error" role="alert">{configurationError}</p>{/if}
      {#if removedConnection}<p class="error" role="status">The selected connection was removed. Select another connection.</p>{/if}
      {#if needsReview}
        <p class="error" role="status">This connection changed. Review its updated model and options before generating.</p>
        <p class="hint">Updated connection: {latestConnection?.name} · {latestConnection && isApiConnection(latestConnection) ? `${transportLabel(latestConnection.transport)}, default model ${latestConnection.defaultModel}` : "Codex, which chooses its own model"}</p>
        <button type="button" class="btn btn-secondary" disabled={submitting || configuring || loadingConnections} onclick={reviewConnection}>Use updated connection</button>
      {/if}
      {#if profile && isApiConnection(profile)}
        <label class="prompt-field">Image model
          <input class="prompt-input" aria-label="Image model" bind:value={modelOverride} placeholder={profile.defaultModel} disabled={submitting || configuring} maxlength="256" />
          <span class="hint">Leave blank to use {profile.defaultModel}. Custom model IDs are supported.</span>
        </label>
      {/if}
        <section class="prompt-field inputs" class:drop-enabled={!!registerFileDropTarget && dropsAccepted} aria-labelledby="openai-image-inputs-label" aria-busy={inspectingDrops} use:registerInputs>
          <span id="openai-image-inputs-label">Inputs <span class="hint">{images.length} / 8</span></span>
          {#if !(registerFileDropTarget && dropsAccepted) && !images.length}
            <span class="hint">No input images</span>
          {/if}
          {#if images.length}
          <ol class="strip" aria-labelledby="openai-image-inputs-label" tabindex="-1" bind:this={stripRef}>
            {#each images as input, index (input.path)}
              <li class="input-card" class:invalid={!!input.error} data-input-path={input.path} aria-label="Image {index + 1}: {basename(input.path)}" title={input.path}>
                <span class="thumb"><TraceThumbnail path={input.path} present={!input.error} revision={0} label="" /></span>
                <span class="number" aria-hidden="true">{index + 1}</span>
                {#if input.error}<span class="input-error" title={input.error}>Can’t use: {input.error}</span>{/if}
                <span class="card-actions">
                  <button type="button" data-move="left" aria-label="Move Image {index + 1} earlier" title="Move earlier" disabled={submitting || index === 0} onclick={() => void move(index, index - 1, "left")}>‹</button>
                  <button type="button" data-move="right" aria-label="Move Image {index + 1} later" title="Move later" disabled={submitting || index === images.length - 1} onclick={() => void move(index, index + 1, "right")}>›</button>
                  <button type="button" data-remove aria-label="Remove Image {index + 1}" title={images.length > 1 ? "Remove" : "An edit needs at least one image"} disabled={submitting || images.length <= 1} onclick={() => void remove(index)}>×</button>
                </span>
              </li>
            {/each}
          </ol>
          {/if}
          {#if inspectingDrops}<span class="hint">Reading input images…</span>{/if}
          <div class="drop-feedback" role="status" aria-live="polite" aria-atomic="true">
            {#key dropResult}
              {#if dropStatus}<p>{dropStatus}</p>{/if}
              {#if visibleDropIssues.length}
                <ul>{#each visibleDropIssues as issue}<li><span title={issue.path ?? undefined}>{issue.path ? basename(issue.path) : "Invalid path"}</span>: {issue.message}</li>{/each}</ul>
              {/if}
              {#if remainingDropIssueText}<span class="announcement-overflow">{remainingDropIssueText}</span>{/if}
            {/key}
          </div>
          {#if dropIssues.length > feedbackLimit}
            <button type="button" class="btn btn-secondary" onclick={() => { feedbackLimit += 8; }}>Show more reasons ({dropIssues.length - feedbackLimit} remaining)</button>
          {/if}
        </section>
      <label class="prompt-field">{editing ? "Prompt" : "Image prompt"}
        <textarea class="prompt-input" rows="4" maxlength="16000" bind:value={prompt} bind:this={promptRef} disabled={submitting} required
          placeholder={images.length > 1 ? "Describe your edit. Refer to images by number, e.g. “the hat in Image 2”…" : editing ? "Describe your edit…" : "Describe your image…"}></textarea>
      </label>
      {#if locationProblem}<p class="error" role="status">{locationProblem}</p>{/if}
      <div class="options">
        {#if offered.resolution}
        <label class="prompt-field">Resolution
          <Select aria-label="Resolution" bind:value={resolution} disabled={submitting || configuring} options={resolutionOptions} />
        </label>
        {/if}
        {#if offered.aspectRatio}
        <label class="prompt-field">Aspect ratio
          <Select aria-label="Aspect ratio" bind:value={aspectRatio} disabled={submitting || configuring} options={aspectRatioOptions} />
        </label>
        {/if}
        <label class="prompt-field">Images
          <input class="prompt-input" type="number" min="1" max="8" step="1" bind:value={count} disabled={submitting} aria-label="Images" />
        </label>
        {#if offered.quality}
        <label class="prompt-field">Quality
          <Select aria-label="Quality" bind:value={quality} disabled={submitting || configuring || !profile} options={qualityOptions} />
        </label>
        {/if}
        {#if offered.background}
        <label class="prompt-field">Background
          <Select aria-label="Background" bind:value={background} disabled={submitting || configuring || !profile} options={backgroundOptions} />
        </label>
        {/if}
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      <button class="btn btn-primary" type="submit" disabled={!prompt.trim() || submitting || configuring || inspectingDrops || loadingConnections || !profile || !!availabilityError || removedConnection || needsReview || !!locationProblem} title="Ctrl+Enter">{submitting ? "Starting…" : "Generate"}</button>
    </footer>
  </form>

<style>
  form { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
  .dialog-body { overflow: auto; min-height: 0; }
  .model-row { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .model-field { flex: 1; min-width: 150px; margin: 0; }
  .model-row .btn { min-height: 34px; }
  .icon-btn { display: inline-grid; place-items: center; width: 34px; padding: 0; color: var(--text-secondary); }
  .icon-btn:hover:not(:disabled) { color: var(--text-primary); }
  .spinning { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
  footer { flex-shrink: 0; padding: 0 20px 16px; display: flex; align-items: end; justify-content: flex-end; gap: 8px; }
  /* One row of settings in the dialog; fewer columns where it is narrow (the image editor's tool panel). */
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(170px, 100%), 1fr)); gap: 10px 12px; }
  .options .prompt-input { width: 100%; box-sizing: border-box; min-width: 0; }
  .options .prompt-field { margin-bottom: 0; }
  label { font-size: 12px; color: var(--text-secondary); }
  textarea { display: block; width: 100%; min-width: 0; resize: vertical; min-height: 88px; box-sizing: border-box; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hint { color: var(--text-tertiary); }
  .inputs { min-width: 0; }
  .inputs.drop-enabled { padding: 8px; border: 1px dashed var(--control-stroke); border-radius: var(--radius-sm); }
  .inputs:global(.drop-target) { border-color: var(--accent); background: var(--subtle-fill-secondary); }
  .drop-feedback { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
  .drop-feedback p { margin: 0; }
  .drop-feedback ul { margin: 4px 0 0; padding-left: 16px; }
  .announcement-overflow { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* Cards are as wide as their thumbnail, whatever the file is called, and wrap within the section. */
  .strip { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 2px; list-style: none; }
  .strip:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .input-card { position: relative; flex: 0 0 var(--card-size); width: var(--card-size); min-width: 0; align-self: flex-start; overflow: hidden; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); --card-size: 88px; }
  .input-card.invalid { border-color: var(--system-critical); }
  .thumb { display: block; height: var(--card-size); }
  .thumb :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .number { position: absolute; top: 4px; left: 4px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; display: grid; place-items: center; font-size: 11px; font-weight: 600; line-height: 1; color: var(--text-on-accent); background: var(--accent); border-radius: var(--radius-pill); pointer-events: none; }
  .input-error { display: block; padding: 2px 4px; font-size: 11px; overflow-wrap: anywhere; color: var(--system-critical-text, var(--system-critical)); }
  /* Overlaid on the image, so hiding them frees no space and showing them moves nothing. */
  .card-actions { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 2px; padding: 3px; background: color-mix(in srgb, var(--background-solid) 80%, transparent); opacity: 0; transition: opacity var(--transition-fast); }
  .input-card:hover .card-actions, .input-card:focus-within .card-actions { opacity: 1; }
  /* Touch has no hover to reveal them. */
  @media (hover: none) { .card-actions { opacity: 1; } }
  .card-actions button { flex: 1; min-width: 0; height: 22px; padding: 0; font: inherit; font-size: 14px; line-height: 1; color: var(--text-primary); background: var(--subtle-fill); border: 1px solid var(--control-stroke); border-radius: 4px; cursor: pointer; }
  .card-actions button:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .card-actions button:disabled { opacity: 0.4; cursor: default; }
  .card-actions button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .error { color: var(--system-critical-text, var(--system-critical)); font-size: 12px; overflow-wrap: anywhere; margin: 12px 0 0; }
</style>
