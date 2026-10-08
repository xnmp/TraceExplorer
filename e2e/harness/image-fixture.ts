/**
 * In-memory backend for the AI image harness: a recorded failed Codex edit
 * (Codex replied in text instead of generating), a succeeded run, and a
 * recorder for `jobs.start` so specs can assert on what a job submits.
 */
import { configureBackend } from "$lib/api/common";
import type { OpenAIImageRunHistory } from "$lib/api/openai-image";
import { excerpt } from "$lib/domain/image-retry";

export const REPLY = "I can’t make that edit: it depicts copyrighted characters (Charizard and Alakazam) in a new scene, and I can’t generate images of them. "
  + "I can make an original fire-type dragon unleashing a spiral of flame while a psychic fox-like creature teleports out of the way instead, keeping your composition, lighting and colours. "
  + "Would you like me to do that, or adjust the request in another way?";
/** The message the backend emits for that reply (see test_support/codex_turn.rs). */
export const PANEL_MESSAGE = `Codex replied without generating an image: “${excerpt(REPLY)}”`;
export const OLD_PANEL_MESSAGE = "Codex completed, but no generated image was found for its thread. See this edit's Raw details for the thread ID.";
export const INPUTS = [
  { path: "/pictures/img-20260923-160059_edit.png", digest: "a".repeat(64) },
  { path: "/pictures/refs/alakazam.png", digest: "b".repeat(64) },
  { path: "/elsewhere/firespin.webp", digest: "c".repeat(64) },
];
export const PROMPT = "Make Charizard use firespin while alakazam tries to dodge it";

export function runs(): OpenAIImageRunHistory[] {
  return [
    {
      outputPath: null, inputs: INPUTS,
      run: {
        id: 87, operation: "openai.image.edit", createdAt: "2026-10-09T08:12:40Z", status: "failed", finishedAt: "2026-10-09T08:13:35Z",
        error: "image_operation_failed", recovered: false, inputIds: [11, 12, 13],
        parameters: { provider: "codex-cli", codex_executable: "", prompt: PROMPT, model: null, size: "2048x1536", resolution: "2k", aspect_ratio: "keep",
          output_storage: "temporary", save_directory_hint: "/pictures", operation_id: "f".repeat(32) },
        details: { transport: "codex_exec", thread_id: "01a11dad-5c1e-7f3a-9b2d-4e6f8a0c2d41", usage: { input_tokens: 27593, output_tokens: 291 },
          stage: "no_image", codex_reply: { text: REPLY, truncated: false } },
      },
    },
    {
      outputPath: "/pictures/lantern.png", inputs: [],
      run: {
        id: 86, operation: "openai.image.generate", createdAt: "2026-10-09T08:00:00Z", status: "succeeded", finishedAt: "2026-10-09T08:01:00Z",
        error: null, recovered: false, inputIds: [],
        parameters: { provider: "codex-cli", prompt: "A paper lantern", size: "auto", save_directory_hint: "/pictures" },
        details: { stage: "image_validated" },
      },
    },
  ];
}

export const started: Array<Record<string, unknown>> = [];
let nextJob = 500;
/** Each started job's request, by job id: what the native backend records as its run. */
const jobRequests = new Map<number, { runId: number; request: Record<string, any> }>();

/** The failed run a started job recorded, shaped like the native backend's history entry. */
function runForJob(jobId: number): OpenAIImageRunHistory | null {
  const found = jobRequests.get(jobId);
  if (!found) return null;
  const { runId, request } = found;
  const paths: string[] = request.sourcePath ? [request.sourcePath, ...request.referencePaths] : [];
  const digests: string[] = request.sourcePath ? [request.expectedSourceDigest, ...(request.expectedReferenceDigests ?? [])] : [];
  return {
    outputPath: null, inputs: paths.map((path, index) => ({ path, digest: digests[index] })),
    run: {
      id: runId, operation: paths.length ? "openai.image.edit" : "openai.image.generate", createdAt: "2026-10-09T09:00:00Z", status: "failed",
      finishedAt: "2026-10-09T09:01:00Z", error: "image_operation_failed", recovered: false, inputIds: [],
      parameters: { provider: request.backend === "codex" ? "codex-cli" : "openai", prompt: request.prompt, model: request.backend === "codex" ? null : request.model,
        size: request.size, resolution: request.resolution, aspect_ratio: request.aspectRatio, quality: request.quality, background: request.background,
        output_storage: "temporary", save_directory_hint: request.outputDir, ...(request.retryOf ? { retry_of: request.retryOf } : {}) },
      details: { stage: "no_image", codex_reply: { text: REPLY, truncated: false } },
    },
  };
}

configureBackend({
  async invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "recent_openai_image_runs") return runs() as T;
    if (method === "jobs.start") {
      started.push(structuredClone(params ?? {}));
      const jobId = nextJob++;
      jobRequests.set(jobId, { runId: 200 + jobRequests.size, request: structuredClone((params as any).request) });
      return jobId as T;
    }
    if (method === "openai_image_run_for_job") return runForJob((params as any).jobId) as T;
    throw new Error(`Unexpected backend method ${method}`);
  },
});
