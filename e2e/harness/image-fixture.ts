import { imageAvailability } from "../../tests/fixtures/image-connections";
/**
 * In-memory backend for the AI image harness: a recorded failed Codex edit
 * (Codex replied in text instead of generating), a succeeded run, and a
 * recorder for `jobs.start` so specs can assert on what a job submits.
 */
import { configureBackend } from "$lib/api/common";
import type { OpenAIImageRunHistory } from "$lib/api/openai-image";
import { excerpt, retryable } from "$lib/domain/image-retry";

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
    unconfirmed(85, "2026-10-09T07:55:00Z", { outcome: "unknown", provider_execution: { state: "unknown", error: { code: "provider_restarted", message: "Interrupted" } } }),
    unconfirmed(84, null, { provider_execution: { state: "running" } }),
  ];
}
export const UNCONFIRMED_PROMPT = "A lighthouse in fog";
/** A linked Codex generation whose outcome was settled unknown, or (unfinished) is still being recovered. */
function unconfirmed(id: number, finishedAt: string | null, details: Record<string, unknown>): OpenAIImageRunHistory {
  const options = { size: "1024x1024", resolution: null, aspectRatio: null, quality: "auto", background: "auto" };
  return {
    outputPath: null, inputs: [],
    run: {
      id, operation: "openai.image.generate", createdAt: "2026-10-09T07:50:00Z", status: "uncertain", finishedAt, recovered: false, inputIds: [],
      error: finishedAt ? "The image generation outcome could not be confirmed: the provider reported it unknown. Retry starts a new, separately charged generation." : "image_recovery_pending",
      parameters: { prompt: UNCONFIRMED_PROMPT, model: null, size: "1024x1024", quality: "auto", background: "auto", resolution: null, aspect_ratio: null,
        connection_id: "saved-login", connection_revision: "old-revision", effective_recipe_digest: "a".repeat(64), operation_id: "e".repeat(31) + id % 10,
        effective_recipe: { schemaVersion: 1, formatterVersion: 1, connectionId: "saved-login", connectionRevision: "old-revision", adapter: "codex-cli",
          endpointIdentity: "codex-cli:auto-discovery", model: null, options, inputDigests: [], inputRoles: [], submittedPrompt: UNCONFIRMED_PROMPT, agentTask: "Recorded fixture task" },
        output_storage: "temporary", save_directory_hint: "/pictures" },
      details,
    },
  };
}

export const started: Array<Record<string, unknown>> = [];
let availability = imageAvailability();
export function removeRecordedConnection(): void {
  availability = imageAvailability();
  availability.description!.defaultConnectionId = "custom-http";
  availability.description!.profiles = availability.description!.profiles.filter((p) => p.id !== "saved-login");
}
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
      parameters: { provider: request.model === null ? "codex-cli" : "openai", prompt: request.prompt, model: request.model === null ? null : request.model,
        connection_id: request.connectionId, connection_revision: request.expectedConnectionRevision, effective_recipe_digest: "a".repeat(64),
        effective_recipe: { schemaVersion: 1, formatterVersion: 1, connectionId: request.connectionId, connectionRevision: request.expectedConnectionRevision,
          adapter: "codex-cli", endpointIdentity: "codex-cli:auto-discovery", model: null,
          options: { size: request.size, resolution: request.resolution ?? null, aspectRatio: request.aspectRatio ?? null, quality: request.quality, background: request.background },
          inputDigests: digests, inputRoles: paths.map((_, i) => `Image ${i + 1}`), submittedPrompt: request.prompt, agentTask: "Recorded fixture task" },
        size: request.size, resolution: request.resolution, aspect_ratio: request.aspectRatio, quality: request.quality, background: request.background,
        output_storage: "temporary", save_directory_hint: request.outputDir, ...(request.retryOf ? { retry_of: request.retryOf } : {}) },
      details: { stage: "no_image", codex_reply: { text: REPLY, truncated: false } },
    },
  };
}

configureBackend({
  async invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "image_service_describe") return availability as T;
    if (method === "recent_openai_image_runs") return runs() as T;
    if (method === "jobs.start") {
      // Like the native backend: only an explicitly failed image run is a Retry source.
      const retryOf = (params as any)?.request?.retryOf;
      if (retryOf !== undefined && retryOf !== null) {
        const source = [...runs(), ...[...jobRequests.keys()].map(runForJob)].find((history) => history?.run.id === retryOf);
        if (!source || !retryable(source)) throw new Error("Only an explicitly failed image run can be retried");
      }
      started.push(structuredClone(params ?? {}));
      const jobId = nextJob++;
      jobRequests.set(jobId, { runId: 200 + jobRequests.size, request: structuredClone((params as any).request) });
      return jobId as T;
    }
    if (method === "openai_image_run_for_job") return runForJob((params as any).jobId) as T;
    throw new Error(`Unexpected backend method ${method}`);
  },
});
