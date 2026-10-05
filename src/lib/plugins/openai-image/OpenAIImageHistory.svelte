<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import { recentOpenAIImageRuns, type OpenAIImageRunHistory } from "$lib/api/openai-image";
  import { traceOperationLabel } from "$lib/domain/trace-layout";
  import { traceInvalidation } from "../trace/invalidation.svelte";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();
  let runs = $state<OpenAIImageRunHistory[]>([]);
  let loading = $state(true);
  let error = $state("");
  $effect(() => {
    if (!open) return;
    void traceInvalidation.revision;
    let active = true;
    loading = true;
    void recentOpenAIImageRuns().then((result) => {
      if (!active) return;
      loading = false;
      if (result.ok) { runs = result.data; error = ""; }
      else error = result.error;
    });
    return () => { active = false; };
  });
</script>

<Modal {open} {onClose} overlayClass="dialog-overlay" labelledby="openai-history-title">
  <div class="dialog plugin-dialog">
    <header class="dialog-header"><h2 id="openai-history-title">OpenAI image history</h2><button class="close-btn" type="button" onclick={onClose} aria-label="Close">×</button></header>
    <div class="dialog-body">
      {#if loading}<p role="status">Loading image runs…</p>
      {:else if error}<p role="alert">{error}</p>
      {:else if !runs.length}<p>No OpenAI image runs recorded yet.</p>
      {:else}
        <p class="note">Most recent 64 runs. Failed generations remain here even when they produced no image.</p>
        <ol aria-label="OpenAI image runs">
          {#each runs as item (item.run.id)}
            <li>
              <details>
                <summary><span>{traceOperationLabel(item.run.operation)} · #{item.run.id}</span><span class="status">{item.run.status}</span></summary>
                <dl>
                  <dt>Started</dt><dd>{item.run.createdAt}</dd>
                  <dt>Model</dt><dd>{String(item.run.parameters.model ?? "Unknown")}</dd>
                  <dt>Prompt</dt><dd>{String(item.run.parameters.prompt ?? "")}</dd>
                  <dt>Output</dt><dd>{item.outputPath ?? (item.run.status === "uncertain" ? "Publication needs reconciliation" : "No recorded output")}</dd>
                  {#if item.preparedOutputPath}<dt>Prepared</dt><dd>{item.preparedOutputPath} — publication not yet verified</dd>{/if}
                  {#if item.run.error}<dt>Reason</dt><dd>{item.run.error}</dd>{/if}
                </dl>
                <pre>{JSON.stringify({ parameters: item.run.parameters, result: item.run.details ?? null }, null, 2)}</pre>
              </details>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .dialog { width: 600px; max-height: 90vh; overflow: auto; }
  .note { color: var(--text-secondary); font-size: 12px; margin: 0; }
  ol { list-style: none; padding: 0; margin: 0; }
  li { border-top: 1px solid var(--surface-stroke); padding: 12px 0; }
  summary { cursor: pointer; color: var(--text-primary); font-size: 13px; }
  .status { float: right; color: var(--text-secondary); }
  dl { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  dt { color: var(--text-secondary); } dd { margin: 0; overflow-wrap: anywhere; }
  pre { padding: 12px; font-size: 11px; background: var(--background-card-secondary); overflow: auto; max-height: 200px; }
</style>
