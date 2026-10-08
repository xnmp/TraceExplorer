/**
 * Starting AI image jobs, and retrying failed ones.
 *
 * Every job is registered with a `retry`, which hosts with the `jobRetry`
 * capability offer on its failed entry (older hosts ignore it; the run
 * history keeps its own Retry). A retry resubmits the failed run's recorded
 * request (the same ordered inputs pinned to the revisions it captured, the
 * same prompt and settings, `retry_of` set) as a new job, itself retryable.
 */
import type { ApiResult, PluginJobs, PluginStorage } from "../api";
import { openAIImageRunForJob, startOpenAIImageJob, type OpenAIImageRequest, type OpenAIImageRunHistory } from "$lib/api/openai-image";
import { retryPlan } from "$lib/domain/image-retry";

export interface ImageJobServices { readonly jobs: PluginJobs; readonly storage: PluginStorage }

export function startImageJob(
  services: ImageJobServices, entry: { label: string; detail: string }, request: OpenAIImageRequest, apiKey: string,
): Promise<ApiResult<number>> {
  let jobId: number | null = null;
  return services.jobs.accept(
    { kind: "openai-image", presentation: "image", ...entry, retry: () => jobId === null ? Promise.resolve({ ok: false, error: "This job never started" }) : retryJob(services, jobId) },
    async () => {
      const result = await startOpenAIImageJob(request, apiKey);
      if (result.ok) jobId = result.data;
      return result;
    },
  );
}

/** Retries the run a failed host job recorded. */
export async function retryJob(services: ImageJobServices, jobId: number): Promise<ApiResult<number>> {
  const found = await openAIImageRunForJob(jobId);
  if (!found.ok) return found;
  if (!found.data) return { ok: false, error: "This job's request was not recorded, so it cannot be retried" };
  return retryRun(services, found.data);
}

/** Resubmits a failed run's recorded request as a new job, with the current connection settings. */
export async function retryRun(services: ImageJobServices, history: OpenAIImageRunHistory): Promise<ApiResult<number>> {
  const settings = await services.storage.get();
  const plan = retryPlan(history, {
    codexPath: typeof settings.codexPath === "string" ? settings.codexPath : "",
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
  });
  if (!plan.ok) return { ok: false, error: plan.reason };
  const { request, apiKey, label, detail } = plan.retry;
  return startImageJob(services, { label, detail }, request, apiKey);
}
