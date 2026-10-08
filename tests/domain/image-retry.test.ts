import { describe, expect, it } from "vitest";
import { codexExplanation, excerpt, retryable, retryPlan } from "$lib/domain/image-retry";
import type { OpenAIImageRunHistory } from "$lib/api/openai-image";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const connection = { codexPath: "/opt/codex", apiKey: "sk-current" };

function history(overrides: Partial<OpenAIImageRunHistory["run"]> = {}, inputs: OpenAIImageRunHistory["inputs"] = [
  { path: "/pictures/charizard.png", digest: A }, { path: "/pictures/refs/alakazam.png", digest: B }, { path: "/elsewhere/fire.webp", digest: C },
]): OpenAIImageRunHistory {
  return {
    outputPath: null, inputs,
    run: {
      id: 41, operation: "openai.image.edit", createdAt: "2026-10-09T00:00:00Z", status: "failed", finishedAt: null,
      error: "image_operation_failed", recovered: false, inputIds: [1, 2, 3],
      parameters: {
        provider: "codex-cli", codex_executable: "/old/codex", prompt: "  Make Charizard use firespin  ", model: null,
        size: "2048x1536", resolution: "2k", aspect_ratio: "keep", output_storage: "temporary", save_directory_hint: "/pictures",
      },
      details: { stage: "no_image", codex_reply: { text: "I can’t make that edit.", truncated: false } },
      ...overrides,
    },
  };
}

describe("retrying a failed image run", () => {
  it("resubmits the same ordered inputs, pinned to their recorded revisions, with the same prompt and settings", () => {
    const plan = retryPlan(history(), connection);
    expect(plan).toEqual({ ok: true, retry: {
      label: "charizard_edit.png", detail: "Make Charizard use firespin", apiKey: "",
      request: {
        sourcePath: "/pictures/charizard.png", expectedSourceDigest: A,
        referencePaths: ["/pictures/refs/alakazam.png", "/elsewhere/fire.webp"], expectedReferenceDigests: [B, C],
        prompt: "Make Charizard use firespin", outputDir: "/pictures", outputFilename: "charizard_edit.png",
        backend: "codex", codexPath: "/opt/codex", model: "gpt-image-2", size: "2048x1536", resolution: "2k", aspectRatio: "keep",
        quality: "auto", background: "auto", retryOf: 41,
      },
    } });
  });

  it("keeps API settings and uses the current API key for an API-key run", () => {
    const plan = retryPlan(history({ operation: "openai.image.generate", parameters: {
      provider: "openai", model: "gpt-image-2.5-flare", prompt: "A lantern", size: "1024x1024", quality: "high", background: "transparent",
      resolution: null, aspect_ratio: null, save_directory_hint: "/out",
    } }, []), connection);
    expect(plan.ok && plan.retry).toEqual({ label: "generated.png", detail: "A lantern", apiKey: "sk-current", request: {
      sourcePath: null, referencePaths: [], prompt: "A lantern", outputDir: "/out", outputFilename: "generated.png", backend: "api_key",
      model: "gpt-image-2.5-flare", size: "1024x1024", quality: "high", background: "transparent", retryOf: 41,
    } });
  });

  it("falls back to the first input's folder for runs recorded before temporary storage", () => {
    const run = history();
    const plan = retryPlan({ ...run, run: { ...run.run, parameters: { ...run.run.parameters, save_directory_hint: undefined } } }, connection);
    expect(plan.ok && plan.retry.request.outputDir).toBe("/pictures");
  });

  it("refuses runs it cannot reproduce faithfully", () => {
    const reasons = [
      history({ status: "succeeded" }),
      history({ status: "running" }),
      history({ operation: "image.crop" }),
      history({ parameters: { provider: "codex-cli", prompt: "   " } }),
      history({ parameters: { provider: "elsewhere", prompt: "x", save_directory_hint: "/p" } }),
      history({}, []),
      { ...history(), inputs: undefined },
      history({ operation: "openai.image.generate", parameters: { provider: "openai", prompt: "x" } }, []),
    ].map((run) => retryPlan(run, connection));
    for (const plan of reasons) expect(plan.ok).toBe(false);
    expect(reasons.map((plan) => !plan.ok && plan.reason)).toEqual([
      "Only failed AI image runs can be retried", "Only failed AI image runs can be retried", "Only failed AI image runs can be retried",
      "This run has no recorded prompt", "This run's image connection is unknown",
      "This run's recorded inputs are incomplete", "This run's recorded inputs are incomplete", "This run has no recorded output folder",
    ]);
    expect(retryable(history({ status: "failed" }))).toBe(true);
  });

  it("ignores malformed recorded settings rather than sending them", () => {
    const run = history({ operation: "openai.image.generate", parameters: {
      provider: "openai", prompt: "x", model: "dall-e-1", quality: 7, background: null, resolution: "8k", size: 5, save_directory_hint: "/o",
    } }, []);
    const plan = retryPlan(run, connection);
    expect(plan.ok && plan.retry.request).toMatchObject({ model: "gpt-image-2", quality: "auto", background: "auto", size: "auto" });
    expect(plan.ok && "resolution" in plan.retry.request).toBe(false);
  });
});

describe("Codex's explanation of a run without an image", () => {
  it("prefers the reply, then the error, and ignores missing or blank text", () => {
    expect(codexExplanation({ codex_reply: { text: "No.", truncated: true }, codex_error: { text: "E" } })).toEqual({ label: "Codex reply", text: "No.", truncated: true });
    expect(codexExplanation({ codex_error: { text: "Usage limit" } })).toEqual({ label: "Codex error", text: "Usage limit", truncated: false });
    for (const details of [null, undefined, {}, { codex_reply: "flat" }, { codex_reply: { text: "  " } }, { codex_reply: { text: 3 } }]) {
      expect(codexExplanation(details as Record<string, unknown> | null)).toBeNull();
    }
  });

  it("excerpts to one bounded line without splitting characters", () => {
    expect(excerpt("a\n\n b\tc ")).toBe("a b c");
    expect(excerpt("x".repeat(301))).toBe(`${"x".repeat(300)}…`);
    expect(excerpt("🐉".repeat(400), 3)).toBe("🐉🐉🐉…");
    expect(excerpt("")).toBe("");
    expect(excerpt("y".repeat(300))).toBe("y".repeat(300));
  });
});
