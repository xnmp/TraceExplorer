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

configureBackend({
  async invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "recent_openai_image_runs") return runs() as T;
    if (method === "jobs.start") { started.push(structuredClone(params ?? {})); return (nextJob++) as T; }
    throw new Error(`Unexpected backend method ${method}`);
  },
});
