<script lang="ts">
  /**
   * Trace's Preview-info section, for real files and this plugin's Preview
   * targets: the prompt, then a collapsible "Trace details" disclosure with
   * the generation settings, input references (clicking one focuses it in the
   * owning pane) and the Raw record.
   *
   * Rows follow the host's Preview info (label left, value right, full-width
   * dividers) and its horizontal inset, `--preview-info-inset`.
   *
   * Switching subjects never clears the section to empty while backend data
   * loads: data is cached per revision (preview-data), and while the new
   * subject's data is pending the section keeps at least the height it had,
   * so the host never re-lays out the image for an intermediate frame.
   */
  import { untrack } from "svelte";
  import type { PreviewSubject } from "../../../../../integration/plugin-sdk";
  import { parentDir } from "$lib/domain/path";
  import { traceInvalidation } from "../invalidation.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import { subjectNode } from "./preview-subject";
  import { tracePanes } from "./pane-registry.svelte";
  import { nodeStatus } from "./node-target";
  import { modelFromGraph, modelFromView, runSettings, type PreviewInput } from "./preview-model";
  import { previewData } from "./preview-data.svelte";
  import { traceDetails } from "./trace-details.svelte";

  let { subject }: { subject: PreviewSubject } = $props();

  const view = $derived(tracePanes.get(subject.paneId));
  const node = $derived(subjectNode(subject));
  const revision = $derived(traceInvalidation.revision);

  // Built-in views have no Trace session; they use the per-image query.
  const imagePath = $derived(!node && subject.kind === "file" ? subject.entry.path : null);
  const graph = $derived(imagePath === null ? null : previewData.graphs.read(imagePath, revision));
  const model = $derived(node && view ? modelFromView(node, (key) => view.node(key))
    : imagePath && graph?.value ? modelFromGraph(graph.value, parentDir(imagePath)) : null);

  const runId = $derived(model?.runId ?? null);
  const run = $derived(runId === null ? null : previewData.runs.read(runId, revision));
  const statusId = $derived(model && subject.kind === "file" ? model.artifactId : null);
  const status = $derived(statusId === null ? null : previewData.revisionStatus.read(statusId, revision));

  $effect(() => { if (imagePath !== null) previewData.graphs.request(imagePath, revision); });
  $effect(() => { if (runId !== null) previewData.runs.request(runId, revision); });
  $effect(() => { if (statusId !== null) previewData.revisionStatus.request(statusId, revision); });

  const pending = $derived(!!(graph?.pending || run?.pending || status?.pending));
  const details = $derived(run?.value ?? null);
  const prompt = $derived(model?.prompt || (typeof details?.parameters.prompt === "string" ? details.parameters.prompt : ""));
  const settings = $derived(details ? runSettings(details) : []);
  const inputs = $derived(model?.inputs ?? []);
  const failure = $derived(run?.error || graph?.error || "");
  const notices = $derived([
    status?.value === "changed" ? "This file changed after it was recorded." : "",
    node && subject.kind === "file" ? nodeStatus(node) ?? "" : "",
  ].filter(Boolean));

  // The section's rendered height, kept current by the binding. When data
  // starts loading, the section holds the height it had at that moment until
  // everything has loaded: the reservation is re-derived only when `pending`
  // changes, so it captures the height shown just before.
  let height = $state(0);
  const reserved = $derived.by(() => pending ? untrack(() => height) : 0);

  const scopeLabel = (input: PreviewInput) => input.scope === "current" ? "This folder" : input.scope === "subfolder" ? "Subfolder" : "External";
  const inputTitle = (input: PreviewInput) => promptTitles.labelFor(input.runId, input.prompt) || input.title;
  const panelId = $props.id();
</script>

<div class="trace-preview" style:min-height={reserved ? `${reserved}px` : null} aria-busy={pending}
  bind:offsetHeight={height}>
  {#if model}
    <section class="trace-info" aria-label="Trace">
      {#if prompt}<p class="prompt" data-testid="trace-prompt">{prompt}</p>{/if}
      {#each notices as notice (notice)}<p class="note">{notice}</p>{/each}
      {#if details?.error}<p class="note error" role="status">{details.error}</p>{/if}
      {#if failure}<p class="note error" role="status">{failure}</p>{/if}

      <button type="button" class="disclosure" aria-expanded={traceDetails.open} aria-controls="{panelId}-details" onclick={() => traceDetails.toggle()}>
        <span>Trace details</span>
        <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div class="collapsible" class:open={traceDetails.open} id="{panelId}-details" data-testid="trace-details" inert={!traceDetails.open}>
        <div class="panel">
          {#if settings.length}
            <dl class="rows">
              {#each settings as setting (setting.label)}
                <div class="row"><dt>{setting.label}</dt><dd title={setting.value}>{setting.value}</dd></div>
              {/each}
            </dl>
          {/if}
          {#if inputs.length}
            <h4 class="group">Inputs</h4>
            <ul class="inputs">
              {#each inputs as input (input.key)}
                <li>
                  <button type="button" class="input" aria-label="Preview input {inputTitle(input)}" title={[input.prompt, input.location].filter(Boolean).join("\n")}
                    disabled={!model.focusable} onclick={() => view?.focus(input.key)}>
                    <span class="thumb">
                      {#if input.path && input.present}<TraceThumbnail path={input.path} present={true} {revision} label="" />{:else}<span aria-hidden="true">▧</span>{/if}
                    </span>
                    <span class="description">
                      <span class="title">{inputTitle(input)}</span>
                      <span class="location {input.scope}">{scopeLabel(input)} · {input.location}</span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#key model.artifactId ?? model.runId}
            <details class="raw">
              <summary>
                <span>Raw</span>
                <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </summary>
              <pre>{JSON.stringify({ ...(node ? { node } : {}), ...(details ? { run: details } : {}) }, null, 2)}</pre>
            </details>
          {/key}
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  /* The host sets --preview-info-inset to the inset of its own info rows (it
     differs between the side and the top/bottom docks); older hosts use 16px. */
  .trace-preview { --inset: var(--preview-info-inset, 16px); --open-ms: 180ms; color: var(--text-primary); font-size: var(--font-size-caption); }
  .trace-info { display: flex; flex-direction: column; }
  .trace-info > * + * { border-top: 1px solid var(--divider); }
  .prompt { margin: 0; padding: 10px var(--inset); font-size: 12px; line-height: var(--line-height-normal); white-space: pre-wrap; overflow-wrap: anywhere; }
  .note { margin: 0; padding: 8px var(--inset); color: var(--text-secondary); overflow-wrap: anywhere; }
  .trace-info > .note + .note, .prompt + .note { border-top: none; padding-top: 0; }
  .error { color: var(--system-critical-text, var(--system-critical)); }

  .disclosure, summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; box-sizing: border-box; margin: 0; padding: 8px var(--inset); font: inherit; color: var(--text-secondary); background: none; border: 0; text-align: left; cursor: pointer; list-style: none; }
  .trace-info > .disclosure:not(:first-child) { border-top: 1px solid var(--divider); }
  summary::-webkit-details-marker { display: none; }
  .disclosure:hover, summary:hover { background: var(--subtle-fill-secondary); color: var(--text-primary); }
  .disclosure:focus-visible, summary:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .chevron { flex: none; color: var(--text-tertiary); transition: transform var(--open-ms) cubic-bezier(0.2, 0, 0, 1); }
  .disclosure[aria-expanded="true"] .chevron, details[open] > summary .chevron { transform: rotate(90deg); }

  /* Animating the track from 0fr to 1fr opens and closes to the content's own
     height. Closed content is hidden from focus and assistive technology once
     the animation ends. */
  .collapsible { display: grid; grid-template-rows: 0fr; visibility: hidden; transition: grid-template-rows var(--open-ms) cubic-bezier(0.2, 0, 0, 1), visibility 0s linear var(--open-ms); }
  .collapsible.open { grid-template-rows: 1fr; visibility: visible; transition: grid-template-rows var(--open-ms) cubic-bezier(0.2, 0, 0, 1), visibility 0s; }
  /* The panel draws the divider above it as an inset shadow, which takes no
     space, so the closed (0fr) track is truly zero high. */
  .trace-info > .collapsible { border-top: none; }
  .panel { min-height: 0; overflow: hidden; box-shadow: inset 0 1px 0 var(--divider); }
  .panel > * + * { border-top: 1px solid var(--divider); }
  @media (prefers-reduced-motion: reduce) { .collapsible, .collapsible.open, .chevron { transition: none; } }

  /* One column in a side dock; a wide top or bottom dock fits several. */
  .rows, .inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); margin: 0; padding: 0; }
  /* Every row draws the divider above it; the panel clips the first line of
     rows (all of them in a multi-column dock) under its own divider. */
  .rows { margin-top: -1px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; padding: 8px var(--inset); border-top: 1px solid var(--divider); }
  dt { flex: none; color: var(--text-tertiary); }
  dd { min-width: 0; margin: 0; color: var(--text-secondary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .group { margin: 0; padding: 8px var(--inset) 2px; font-size: inherit; font-weight: inherit; color: var(--text-tertiary); }
  .panel > .group + .inputs { border-top: none; }
  .inputs { list-style: none; }
  .input { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 6px var(--inset); font: inherit; text-align: left; color: var(--text-primary); background: none; border: 0; cursor: pointer; }
  .input:disabled { cursor: default; color: var(--text-primary); }
  .input:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .input:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .thumb { display: grid; place-items: center; flex: none; width: 40px; height: 28px; overflow: hidden; border-radius: 2px; color: var(--text-secondary); }
  .thumb :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .thumb :global(img) { object-fit: cover !important; }
  .description { display: flex; flex-direction: column; min-width: 0; }
  .title, .location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .location { font-size: 10px; color: var(--text-secondary); }
  .location.subfolder { color: var(--accent-text, var(--accent)); }
  .location.external { color: var(--system-caution-text, var(--system-caution)); }

  pre { box-sizing: border-box; max-height: 260px; overflow: auto; margin: 0 var(--inset) 8px; padding: 8px; border-radius: var(--radius-sm); background: var(--background-card-secondary); color: var(--text-primary); font-size: 10px; line-height: 1.4; }
</style>
