<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginStorage } from "../api";
  import { recentOpenAIImageRuns, startOpenAIImageJob, type OpenAIImageRunHistory } from "$lib/api/openai-image";
  import { traceOperationLabel } from "$lib/domain/trace-operation";
  import { codexExplanation, excerpt, retryable, retryPlan } from "$lib/domain/image-retry";
  import { traceInvalidation } from "../trace/invalidation.svelte";

  let { open, onClose, jobs, storage }: { open: boolean; onClose: () => void; jobs?: PluginJobs; storage?: PluginStorage } = $props();
  let runs = $state<OpenAIImageRunHistory[]>([]);
  let loading = $state(true);
  let error = $state("");
  /** Runs whose full Codex explanation is shown. */
  let expanded = $state<ReadonlySet<number>>(new Set());
  /** Per-run retry progress and outcome. */
  let retries = $state<Readonly<Record<number, { busy: boolean; message: string; failed: boolean }>>>({});
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

  function toggle(id: number): void {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    expanded = next;
  }

  async function retry(item: OpenAIImageRunHistory): Promise<void> {
    const id = item.run.id;
    if (!jobs || !storage || retries[id]?.busy) return;
    const report = (message: string, failed: boolean, busy = false) => { retries = { ...retries, [id]: { busy, message, failed } }; };
    report("Starting…", false, true);
    try {
      const settings = await storage.get();
      const plan = retryPlan(item, {
        codexPath: typeof settings.codexPath === "string" ? settings.codexPath : "",
        apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
      });
      if (!plan.ok) return report(plan.reason, true);
      const { request, apiKey, label, detail } = plan.retry;
      const result = await jobs.accept({ kind: "openai-image", presentation: "image", label, detail }, () => startOpenAIImageJob(request, apiKey));
      report(result.ok ? "Retry started as a new job" : result.error, !result.ok);
    } catch (cause) {
      report(cause instanceof Error ? cause.message : String(cause), true);
    }
  }
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
            {@const explanation = item.run.status === "failed" ? codexExplanation(item.run.details) : null}
            {@const attempt = retries[item.run.id]}
            <li data-run-id={item.run.id}>
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
              {#if explanation || (jobs && storage && retryable(item))}
                <div class="failure">
                  {#if explanation}
                    {@const full = expanded.has(item.run.id)}
                    {@const short = excerpt(explanation.text)}
                    <p class="explanation" data-testid="codex-explanation">
                      <span class="label">{explanation.label}:</span>
                      {#if full}<span class="full">{explanation.text}</span>{#if explanation.truncated}<span class="cut"> (cut at 2 KB)</span>{/if}{:else}{short}{/if}
                    </p>
                    {#if short !== explanation.text.trim() || explanation.truncated}
                      <button type="button" class="link-btn more" aria-expanded={full} onclick={() => toggle(item.run.id)}>{full ? "Show less" : `Show full ${explanation.label === "Codex reply" ? "reply" : "error"}`}</button>
                    {/if}
                  {/if}
                  {#if jobs && storage && retryable(item)}
                    <div class="retry-row">
                      <button type="button" class="btn btn-secondary retry" disabled={attempt?.busy} onclick={() => void retry(item)} aria-label={`Retry run #${item.run.id}`}>Retry</button>
                      {#if attempt}<span class="retry-status" class:failed={attempt.failed} role="status">{attempt.message}</span>{/if}
                    </div>
                  {/if}
                </div>
              {/if}
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
  .failure { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px; font-size: 12px; }
  .explanation { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; line-height: 1.45; }
  .explanation .label { color: var(--text-secondary); }
  .full { white-space: pre-wrap; }
  .cut { color: var(--text-tertiary); }
  .more { font-size: 12px; }
  .more:focus-visible, .retry:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .retry-row { display: flex; align-items: center; gap: 8px; }
  .retry { min-width: 0; padding: 4px 12px; font-size: 12px; }
  .retry-status { color: var(--text-secondary); }
  .retry-status.failed { color: var(--system-critical-text, var(--system-critical)); }
</style>
