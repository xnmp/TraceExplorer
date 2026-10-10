import { describe, expect, it } from "vitest";
import { configureBackend } from "$lib/api/common";
import type { OpenAIImageRequest } from "$lib/api/openai-image";
import type { PluginJobs } from "../../integration/plugin-sdk";
import { imageAvailability } from "../fixtures/image-connections";
import { retryRun, startImageJob } from "$lib/plugins/openai-image/image-jobs";

type Registration = Parameters<PluginJobs["accept"]>[0];

/**
 * A backend that records each accepted request the way the native one does
 * (inputs with their captured revisions, the submitted recipe), and reports
 * every job as failed.
 */
function backend(availability = imageAvailability()) {
  const started: OpenAIImageRequest[] = [];
  const runs = new Map<number, { request: OpenAIImageRequest; runId: number }>();
  configureBackend({
    async invoke<T>(method: string, params: Record<string, any> = {}): Promise<T> {
      if (method === "image_service_describe") return availability as T;
      if (method === "jobs.start") {
        expect(params).not.toHaveProperty("apiKey");
        const request = structuredClone(params.request) as OpenAIImageRequest;
        started.push(request);
        const jobId = 100 + started.length;
        runs.set(jobId, { request, runId: 40 + started.length });
        return jobId as T;
      }
      if (method === "openai_image_run_for_job") {
        const found = runs.get(params.jobId);
        if (!found) return null as T;
        const { request, runId } = found;
        const paths = [request.sourcePath!, ...(request.referencePaths ?? [])];
        const digests = [request.expectedSourceDigest!, ...(request.expectedReferenceDigests ?? [])];
        return {
          outputPath: null, inputs: paths.map((path, index) => ({ path, digest: digests[index] })),
          run: {
            id: runId, operation: "openai.image.edit", createdAt: "", status: "failed", finishedAt: "", error: "image_operation_failed", recovered: false, inputIds: [],
            parameters: { provider: "codex-cli", connection_id: request.connectionId, prompt: request.prompt, model: null, size: request.size,
              connection_revision: request.expectedConnectionRevision, quality: request.quality, background: request.background,
              effective_recipe_digest: "a".repeat(64), effective_recipe: { schemaVersion: 1, formatterVersion: 1, connectionId: request.connectionId, connectionRevision: request.expectedConnectionRevision,
                adapter: "codex-cli", endpointIdentity: "codex-cli:auto-discovery", model: null, options: { size: request.size, quality: request.quality, background: request.background, resolution: request.resolution ?? null, aspectRatio: request.aspectRatio ?? null },
                inputDigests: digests, inputRoles: paths.map((_, i) => `Image ${i + 1}`), submittedPrompt: request.prompt, agentTask: "Recorded CLI task" },
              resolution: request.resolution, aspect_ratio: request.aspectRatio, output_storage: "temporary", save_directory_hint: request.outputDir },
            details: { stage: "no_image", codex_reply: { text: "I can’t do that.", truncated: false } },
          },
        } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  return { started };
}

function host() {
  const registrations: Registration[] = [];
  const jobs: PluginJobs = { async accept(registration, start) { registrations.push(registration); return start(); } };
  return { jobs, registrations };
}

const request: OpenAIImageRequest = {
  sourcePath: "/pictures/village.png", expectedSourceDigest: "a".repeat(64),
  referencePaths: ["/managed/generation-1/merge_edit.png", "/pictures/refs/mist.png"], expectedReferenceDigests: ["b".repeat(64), "c".repeat(64)],
  prompt: "Put the hat in Image 3 on the man in Image 1", outputDir: "/pictures", outputFilename: "village_edit.png",
  connectionId: "saved-login", expectedConnectionRevision: "cli-revision", model: null, size: "2048x1232", resolution: "2k", aspectRatio: "keep",
  quality: "auto", background: "auto",
};

describe("AI image jobs and the host's Retry", () => {
  it("uses a default only for compatible genuine legacy history and preserves its recorded model", async () => {
    const available = imageAvailability();
    const http = available.description!.profiles.find((p) => p.transport === "openai-images")!;
    const history = { outputPath: null, inputs: [], run: { id: 41, operation: "openai.image.generate", status: "failed", createdAt: "", finishedAt: null,
      error: null, recovered: false, inputIds: [], parameters: { provider: "openai", model: "original-model", prompt: "Legacy prompt", size: "1024x1024", save_directory_hint: "/out" } } };
    const started: OpenAIImageRequest[] = [];
    configureBackend({ async invoke<T>(method: string, p: Record<string, any> = {}): Promise<T> {
      if (method === "image_service_describe") return available as T;
      if (method === "jobs.start") { started.push(p.request); return 7 as T; }
      throw new Error(method);
    } });
    const { jobs, registrations } = host();
    available.description = { ...available.description!, defaultConnectionId: http.id, profiles: [http] };
    expect((await retryRun({ jobs }, history)).ok).toBe(false);
    expect(started).toEqual([]);
    expect(registrations).toEqual([]);
    available.description = { ...available.description, profiles: [{ ...http, baseUrl: "https://api.openai.com/v1/images", defaultModel: "changed-default" }] };
    expect(await retryRun({ jobs }, history)).toEqual({ ok: true, data: 7 });
    expect(started[0]).toMatchObject({ connectionId: http.id, model: "original-model", retryOf: 41 });
  });
  it("refuses a missing recorded connection instead of switching to the current default", async () => {
    const available = imageAvailability();
    const http = available.description!.profiles[1];
    available.description = { ...available.description!, defaultConnectionId: http.id, profiles: [{ ...http, recipeRevision: "fresh-revision" }] };
    const { started } = backend(available);
    const { jobs, registrations } = host();
    await startImageJob({ jobs }, { label: "original", detail: request.prompt }, request);
    expect(await registrations[0].retry!()).toEqual({ ok: false, error: "The recorded image connection is unavailable. Choose a connection in a new generation request." });
    expect(started).toHaveLength(1);
    expect(registrations).toHaveLength(1);
  });
  it("refuses an unknown outcome still being recovered before reading connections or starting work", async () => {
    configureBackend({ async invoke() { throw new Error("Unexpected backend IO"); } });
    const { jobs, registrations } = host();
    const result = await retryRun({ jobs }, { outputPath: null, run: { id: 8, operation: "openai.image.generate", status: "uncertain", createdAt: "", finishedAt: null,
      error: null, recovered: true, inputIds: [], parameters: { prompt: "Do not repeat" }, details: { provider_execution: "unknown" } } });
    expect(result).toEqual({ ok: false, error: "Only failed or unconfirmed AI image runs can be retried" });
    expect(registrations).toEqual([]);
  });
  it("registers a retry that starts a new job with the same ordered, pinned inputs, prompt and settings", async () => {
    const { started } = backend();
    const { jobs, registrations } = host();
    expect(await startImageJob({ jobs }, { label: "village_edit.png", detail: request.prompt }, request)).toEqual({ ok: true, data: 101 });
    expect(registrations[0]).toMatchObject({ kind: "openai-image", presentation: "image", label: "village_edit.png", detail: request.prompt });
    expect(typeof registrations[0].retry).toBe("function");

    expect(await registrations[0].retry!()).toEqual({ ok: true, data: 102 });
    expect(started[1]).toEqual({ ...request, retryOf: 41 });
    expect(registrations[1]).toMatchObject({ kind: "openai-image", presentation: "image", label: "village_edit.png", detail: request.prompt });

    // The retried job is itself retryable, and records the run it retries.
    expect(await registrations[1].retry!()).toEqual({ ok: true, data: 103 });
    expect(started[2]).toEqual({ ...request, retryOf: 42 });
  });

  it("reports why a retry cannot start instead of starting something else", async () => {
    backend();
    const registrations: Registration[] = [];
    const failing: PluginJobs = { async accept(registration) { registrations.push(registration); return { ok: false, error: "queue full" }; } };
    expect(await startImageJob({ jobs: failing }, { label: "x", detail: "y" }, request)).toEqual({ ok: false, error: "queue full" });
    expect(await registrations[0].retry!()).toEqual({ ok: false, error: "This job never started" });
  });
});
