<script lang="ts">
  /**
   * AI image surfaces outside the Trace view: the run history dialog with a
   * stub host jobs service, and a copy of the host's "Image generation"
   * panel rows (tauri-explorer ProgressDialog) so its error text can be seen.
   */
  import OpenAIImageHistory from "$lib/plugins/openai-image/OpenAIImageHistory.svelte";
  import type { PluginJobs, PluginStorage } from "../../integration/plugin-sdk";
  import { OLD_PANEL_MESSAGE, PANEL_MESSAGE, PROMPT, started } from "./image-fixture";

  type Job = { id: number; label: string; detail: string; status: "running" | "error"; error?: string; retry?: () => Promise<{ ok: true; data: number } | { ok: false; error: string }>; retrying?: boolean };
  const query = new URLSearchParams(location.search);
  let jobs = $state.raw<Job[]>(query.has("panel") ? [
    { id: 1, label: "img-20260923-160059_edit_2_edit_2_edit.png", detail: PROMPT, status: "error", error: query.get("panel") === "old" ? OLD_PANEL_MESSAGE : PANEL_MESSAGE },
  ] : []);
  let historyOpen = $state(!query.has("panel"));
  const settings: Record<string, unknown> = { backend: "codex", codexPath: "/opt/codex/bin/codex", apiKey: "" };
  const storage: PluginStorage = { get: async () => ({ ...settings }), set: async () => {} };
  const service: PluginJobs = {
    async accept(registration, start) {
      const result = await start();
      if (result.ok) jobs = [...jobs, { id: result.data, label: registration.label, detail: registration.detail, status: "running", retry: registration.retry }];
      return result;
    },
  };

  /** The host's Retry (SDK `jobRetry`): disabled while starting; a started retry replaces the failed entry. */
  async function retry(job: Job): Promise<void> {
    if (!job.retry || job.retrying) return;
    jobs = jobs.map((other) => other === job ? { ...job, retrying: true } : other);
    try {
      const result = await job.retry();
      jobs = result.ok ? jobs.filter((other) => other.id !== job.id) : jobs.map((other) => other.id === job.id ? { ...other, retrying: false, error: result.error } : other);
    } catch (cause) {
      jobs = jobs.map((other) => other.id === job.id ? { ...other, retrying: false, error: String(cause) } : other);
    }
  }

  export const harness = {
    /** Reports a job's failure, as the backend's `openai-image-error` event does. */
    fail(id: number, error: string) { jobs = jobs.map((job) => job.id === id ? { ...job, status: "error" as const, error } : job); },
    started: () => structuredClone(started),
    jobs: () => jobs.map((job) => ({ ...job })),
  };
</script>

{#if jobs.length}
  <div class="panel" role="region" aria-label="Image generation">
    <h3>Image generation</h3>
    {#each jobs as job (job.id)}
      <div class="operation-item" data-job-id={job.id}>
        <div class="icon" aria-hidden="true">{job.status === "error" ? "!" : "…"}</div>
        <div class="details">
          <div class="name">{job.label}</div>
          <p class="job-prompt">{job.detail}</p>
          <div class="status-text" role="status">{job.status === "error" ? job.error : "Running"}</div>
          <div class="status-text">55s elapsed</div>
        </div>
        {#if job.status === "error" && job.retry}
          <button type="button" class="action-btn" aria-label={`Retry ${job.label}`} title="Retry" disabled={job.retrying} onclick={() => void retry(job)}>↻</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
<OpenAIImageHistory open={historyOpen} onClose={() => { historyOpen = false; }} jobs={service} {storage} />

<style>
  :global(body) { margin: 0; font-family: system-ui, sans-serif; background: var(--background-solid); color: var(--text-primary); }
  /* Mirrors the host's image job rows (ProgressDialog.svelte). */
  .panel { position: fixed; right: 16px; bottom: 16px; width: 420px; background: var(--background-solid); border: 1px solid var(--surface-stroke); border-radius: 8px; padding: 12px; z-index: 2; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  .operation-item { display: flex; gap: 12px; padding: 10px; border-radius: 6px; background: var(--subtle-fill); }
  .icon { width: 20px; color: var(--text-secondary); }
  .details { flex: 1; min-width: 0; }
  .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .job-prompt { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .status-text { font-size: 11px; color: var(--text-tertiary); }
  .action-btn { align-self: flex-start; width: 24px; height: 24px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--text-secondary); cursor: pointer; }
  .action-btn:hover:not(:disabled) { background: var(--subtle-fill-secondary); color: var(--text-primary); }
</style>
