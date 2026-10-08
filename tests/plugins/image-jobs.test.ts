import { describe, expect, it } from "vitest";
import { configureBackend } from "$lib/api/common";
import type { OpenAIImageRequest } from "$lib/api/openai-image";
import type { PluginJobs } from "../../integration/plugin-sdk";
import { startImageJob } from "$lib/plugins/openai-image/image-jobs";

type Registration = Parameters<PluginJobs["accept"]>[0];

/**
 * A backend that records each accepted request the way the native one does
 * (inputs with their captured revisions, the submitted recipe), and reports
 * every job as failed.
 */
function backend() {
  const started: OpenAIImageRequest[] = [];
  const runs = new Map<number, { request: OpenAIImageRequest; runId: number }>();
  configureBackend({
    async invoke<T>(method: string, params: Record<string, any> = {}): Promise<T> {
      if (method === "jobs.start") {
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
            parameters: { provider: "codex-cli", codex_executable: request.codexPath, prompt: request.prompt, model: null, size: request.size,
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
  backend: "codex", codexPath: "/opt/codex", model: "gpt-image-2", size: "2048x1232", resolution: "2k", aspectRatio: "keep",
  quality: "auto", background: "auto",
};

describe("AI image jobs and the host's Retry", () => {
  it("registers a retry that starts a new job with the same ordered, pinned inputs, prompt and settings", async () => {
    const { started } = backend();
    const { jobs, registrations } = host();
    const storage = { get: async () => ({ codexPath: "/opt/codex" }), set: async () => {} };
    expect(await startImageJob({ jobs, storage }, { label: "village_edit.png", detail: request.prompt }, request, "")).toEqual({ ok: true, data: 101 });
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
    const storage = { get: async () => ({}), set: async () => {} };
    const failing: PluginJobs = { async accept(registration) { registrations.push(registration); return { ok: false, error: "queue full" }; } };
    expect(await startImageJob({ jobs: failing, storage }, { label: "x", detail: "y" }, request, "")).toEqual({ ok: false, error: "queue full" });
    expect(await registrations[0].retry!()).toEqual({ ok: false, error: "This job never started" });
  });
});
