/**
 * Starting AI image jobs, and retrying failed ones.
 *
 * Every job is registered with a `retry`, which hosts with the `jobRetry`
 * capability offer on its failed entry (older hosts ignore it; the run
 * history keeps its own Retry). A retry resubmits the failed run's recorded
 * request (the same ordered inputs pinned to the revisions it captured, the
 * same prompt and settings, `retry_of` set) as a new job, itself retryable.
 */
import type { ApiResult, PluginJobs } from "../api";
import { describeImageService, openAIImageRunForJob, startOpenAIImageJob, type OpenAIImageRequest, type OpenAIImageRunHistory } from "$lib/api/openai-image";
import { retryable, retryPlan } from "$lib/domain/image-retry";
import { availabilityProblem, connectionFor } from "./connections";

export interface ImageJobServices { readonly jobs: PluginJobs }

export function startImageJob(
  services: ImageJobServices, entry: { label: string; detail: string }, request: OpenAIImageRequest,
): Promise<ApiResult<number>> {
  let jobId: number | null = null;
  return services.jobs.accept(
    { kind: "openai-image", presentation: "image", ...entry, retry: () => jobId === null ? Promise.resolve({ ok: false, error: "This job never started" }) : retryJob(services, jobId) },
    async () => {
      const result = await startOpenAIImageJob(request);
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
  if (!retryable(history)) return { ok: false, error: "Only failed AI image runs can be retried" };
  const available = await describeImageService();
  if (!available.ok) return available;
  const problem = availabilityProblem(available.data);
  if (problem) return { ok: false, error: problem };
  const description = available.data.description;
  const original = history.run.parameters.connection_id;
  if (original !== undefined && (typeof original !== "string" || !description?.profiles.some((p) => p.id === original))) {
    return { ok: false, error: "The recorded image connection is unavailable. Choose a connection in a new generation request." };
  }
  const connection = connectionFor(description, typeof original === "string" ? original : null);
  if (!connection) return { ok: false, error: "Choose a default image connection in Configure connections before retrying." };
  const plan = retryPlan(history, connection);
  if (!plan.ok) return { ok: false, error: plan.reason };
  const { request, label, detail } = plan.retry;
  return startImageJob(services, { label, detail }, request);
}
