import { describe, expect, it } from "vitest";
import { codexExplanation, excerpt, retryable, retryPlan, unconfirmedOutcome } from "$lib/domain/image-retry";
import type { OpenAIImageRunHistory } from "$lib/api/openai-image";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
import { imageAvailability } from "../fixtures/image-connections";
const connection = imageAvailability().description!.profiles[0];
const http = { ...imageAvailability().description!.profiles.find((p) => p.transport === "openai-images")!, baseUrl: "https://api.openai.com/v1/images" };

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
  it("never retries provider success or unknown outcomes mislabeled as a local failure", () => {
    for (const state of ["succeeded", "unknown", "running", "accepted", "cancelled", "unexpected"]) {
      for (const execution of [state, { state }]) {
        expect(retryable(history({ details: { provider_execution: execution } }))).toBe(false);
      }
    }
    for (const execution of [null, {}, { message: "malformed" }]) expect(retryable(history({ details: { provider_execution: execution } }))).toBe(false);
    expect(retryable(history({ details: { provider_execution: { state: "failed" } } }))).toBe(true);
    expect(retryable(history({ status: "uncertain" }))).toBe(false);
  });
  it("retries a settled unconfirmed outcome as a new request, but never a run still being recovered", () => {
    const unknown = (overrides: Partial<OpenAIImageRunHistory["run"]> = {}, details: Record<string, unknown> = { outcome: "unknown", provider_execution: { state: "unknown" } }) =>
      history({ status: "uncertain", finishedAt: "2026-10-09T00:01:00Z", error: "The image generation outcome could not be confirmed", details, ...overrides });
    expect(unconfirmedOutcome(unknown())).toBe(true);
    expect(retryable(unknown())).toBe(true);
    // Automatic recovery stopped while the provider last reported it running, or before any receipt.
    for (const details of [{ outcome: "unknown", provider_execution: { state: "running" } }, { outcome: "unknown", provider_execution: "accepted" }, { outcome: "unknown" }]) {
      expect(retryable(unknown({}, details))).toBe(true);
    }
    const plan = retryPlan(unknown(), connection);
    expect(plan.ok && plan.retry.request.retryOf).toBe(41);
    // Still recovering: unfinished, or without the settlement marker.
    expect(retryable(unknown({ finishedAt: null }))).toBe(false);
    expect(retryable(unknown({}, { provider_execution: { state: "unknown" } }))).toBe(false);
    expect(retryable(unknown({ details: null }))).toBe(false);
    // A marker never overrides proven provider success or cancellation.
    for (const state of ["succeeded", "cancelled", "failed", "unexpected"]) {
      expect(retryable(unknown({}, { outcome: "unknown", provider_execution: { state } }))).toBe(false);
    }
    expect(retryable(unknown({}, { outcome: "failed" }))).toBe(false);
    expect(retryable(unknown({ operation: "image.crop" }))).toBe(false);
    for (const status of ["running", "succeeded", "cancelled", "discarded", "interrupted"] as const) expect(retryable(unknown({ status }))).toBe(false);
  });

  it("resubmits the same ordered inputs, pinned to their recorded revisions, with the same prompt and settings", () => {
    const plan = retryPlan(history(), connection);
    expect(plan).toEqual({ ok: true, retry: {
      label: "charizard_edit.png", detail: "  Make Charizard use firespin  ",
      request: {
        sourcePath: "/pictures/charizard.png", expectedSourceDigest: A,
        referencePaths: ["/pictures/refs/alakazam.png", "/elsewhere/fire.webp"], expectedReferenceDigests: [B, C],
        prompt: "  Make Charizard use firespin  ", outputDir: "/pictures", outputFilename: "charizard_edit.png",
        connectionId: "saved-login", expectedConnectionRevision: "cli-revision", model: null, size: "2048x1536", resolution: "2k", aspectRatio: "keep",
        quality: "auto", background: "auto", retryOf: 41,
      },
    } });
  });

  it("keeps arbitrary HTTP model IDs and uses the current recipe revision", () => {
    const plan = retryPlan(history({ operation: "openai.image.generate", parameters: {
      provider: "openai", model: "gpt-image-2.5-flare", prompt: "A lantern", size: "1024x1024", quality: "high", background: "transparent",
      resolution: null, aspect_ratio: null, save_directory_hint: "/out",
    } }, []), http);
    expect(plan.ok && plan.retry).toEqual({ label: "generated.png", detail: "A lantern", request: {
      sourcePath: null, referencePaths: [], prompt: "A lantern", outputDir: "/out", outputFilename: "generated.png", connectionId: "custom-http", expectedConnectionRevision: "http-revision",
      model: "gpt-image-2.5-flare", size: "1024x1024", quality: "high", background: "transparent", retryOf: 41,
    } });
  });

  it("requires compatible legacy adapter semantics rather than substituting a default vendor or model", () => {
    const old = history({ operation: "openai.image.generate", parameters: { provider: "openai", model: "original-model", prompt: "x", size: "1024x1024", save_directory_hint: "/out" } }, []);
    expect(retryPlan(old, { ...http, baseUrl: "https://another.test/images" }).ok).toBe(false);
    expect(retryPlan(old, connection).ok).toBe(false);
    expect(retryPlan(history(), http).ok).toBe(false);
    const compatible = retryPlan(old, { ...http, defaultModel: "changed-default" });
    expect(compatible.ok && compatible.retry.request.model).toBe("original-model");
    expect(retryPlan({ ...old, run: { ...old.run, parameters: { ...old.run.parameters, model: null } } }, http).ok).toBe(false);
  });

  it("pins new linked retries to their recorded adapter and normalized endpoint while allowing key/model-default repairs", () => {
    const parameters = { connection_id: http.id, connection_revision: "old-revision", model: "original-model", prompt: "x", size: "1024x1024", quality: "auto", background: "auto", save_directory_hint: "/out",
      effective_recipe_digest: "a".repeat(64), effective_recipe: { schemaVersion: 1, formatterVersion: 1, connectionId: http.id, connectionRevision: "old-revision", adapter: "openai-images", endpointIdentity: "https://API.OPENAI.COM:443/v1/images/", model: "original-model", options: { size: "1024x1024", quality: "auto", background: "auto", resolution: null, aspectRatio: null }, inputDigests: [], inputRoles: [], submittedPrompt: "x", agentTask: null } };
    const linked = history({ operation: "openai.image.generate", parameters }, []);
    const repaired = retryPlan(linked, { ...http, recipeRevision: "new-revision", defaultModel: "new-default" });
    expect(repaired.ok && repaired.retry.request).toMatchObject({ model: "original-model", expectedConnectionRevision: "new-revision" });
    for (const changed of [{ ...http, id: "different" }, { ...http, baseUrl: "https://other.test/images" }, { ...connection, id: http.id }]) expect(retryPlan(linked, changed).ok).toBe(false);
    for (const recipe of [undefined, null, {}, { ...parameters.effective_recipe, inputDigests: ["a".repeat(64)] }, { ...parameters.effective_recipe, model: "different" }]) {
      expect(retryPlan(history({ operation: "openai.image.generate", parameters: { ...parameters, effective_recipe: recipe } }, []), http).ok).toBe(false);
    }
  });
  it("keeps a linked Codex retry on its exact executable or auto-discovery identity", () => {
    const cli = imageAvailability().description!.profiles.find((p) => p.transport === "codex-cli")!;
    const parameters = { connection_id: cli.id, connection_revision: "old-revision", model: null, prompt: "x", size: "1024x1024", quality: "auto", background: "auto", save_directory_hint: "/out", effective_recipe_digest: "a".repeat(64),
      effective_recipe: { schemaVersion: 1, formatterVersion: 1, connectionId: cli.id, connectionRevision: "old-revision", adapter: "codex-cli", endpointIdentity: "/old/codex", model: null, options: { size: "1024x1024", quality: "auto", background: "auto", resolution: null, aspectRatio: null }, inputDigests: [], inputRoles: [], submittedPrompt: "x", agentTask: "Recorded task" } };
    const linked = history({ operation: "openai.image.generate", parameters }, []);
    expect(retryPlan(linked, { ...cli, executablePath: " /old/codex ", recipeRevision: "repaired-revision" }).ok).toBe(true);
    expect(retryPlan(linked, { ...cli, executablePath: "/new/codex" }).ok).toBe(false);
    expect(retryPlan(linked, { ...cli, executablePath: "" }).ok).toBe(false);
    const automatic = history({ operation: "openai.image.generate", parameters: { ...parameters, effective_recipe: { ...parameters.effective_recipe, endpointIdentity: "codex-cli:auto-discovery" } } }, []);
    expect(retryPlan(automatic, cli).ok).toBe(true);
    expect(retryPlan(automatic, { ...cli, executablePath: "/new/codex" }).ok).toBe(false);
    const prompt = "A" + "\u0001".repeat(15999);
    const task = `Use the built-in image generation tool exactly once. User's visual request: ${JSON.stringify({ prompt })}`;
    const expanded = history({ operation: "openai.image.generate", parameters: { ...parameters, prompt, effective_recipe: { ...parameters.effective_recipe, submittedPrompt: prompt, agentTask: task, endpointIdentity: "codex-cli:auto-discovery" } } }, []);
    const plan = retryPlan(expanded, cli);
    expect(plan.ok && plan.retry.request.prompt).toBe(prompt);
    expect(retryPlan(history({ operation: "openai.image.generate", parameters: { ...expanded.run.parameters, effective_recipe: { ...expanded.run.parameters.effective_recipe as object, agentTask: "猫".repeat(35000) } } }, []), cli).ok).toBe(false);
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
      history({}, []),
      { ...history(), inputs: undefined },
      history({ operation: "openai.image.generate", parameters: { provider: "openai", prompt: "x" } }, []),
    ].map((run) => retryPlan(run, connection));
    for (const plan of reasons) expect(plan.ok).toBe(false);
    expect(reasons.map((plan) => !plan.ok && plan.reason)).toEqual([
      "Only failed or unconfirmed AI image runs can be retried", "Only failed or unconfirmed AI image runs can be retried", "Only failed or unconfirmed AI image runs can be retried",
      "This run has no recorded prompt",
      "This run's recorded inputs are incomplete", "This run's recorded inputs are incomplete", "This run has no recorded output folder",
    ]);
    expect(retryable(history({ status: "failed" }))).toBe(true);
  });

  it("ignores malformed recorded settings rather than sending them", () => {
    const run = history({ operation: "openai.image.generate", parameters: {
      provider: "openai", prompt: "x", model: "dall-e-1", quality: 7, background: null, resolution: "8k", size: 5, save_directory_hint: "/o",
    } }, []);
    const plan = retryPlan(run, http);
    expect(plan.ok && plan.retry.request).toMatchObject({ model: "dall-e-1", quality: "auto", background: "auto", size: "auto" });
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
