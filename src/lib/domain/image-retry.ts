/**
 * Retrying a failed AI image run, and reading why a Codex run made no image.
 *
 * A retry resubmits the recorded request as a new job: the same ordered
 * inputs (pinned to the revisions the failed run captured), prompt and
 * generation settings. Connection settings (Codex path, API key) are the
 * current ones, since a broken connection is a common reason to retry.
 */
import type { OpenAIImageRequest, OpenAIImageRunHistory } from "$lib/api/openai-image";
import { basename, parentDir } from "./path";
import { imageOutputFilename } from "./image-output-filename";

export interface ImageConnection { readonly codexPath: string; readonly apiKey: string }
export interface ImageRetry { readonly request: OpenAIImageRequest; readonly apiKey: string; readonly label: string; readonly detail: string }
export type RetryPlan = { ok: true; retry: ImageRetry } | { ok: false; reason: string };

const OPERATIONS = new Set(["openai.image.edit", "openai.image.generate"]);
const MODELS = new Set<OpenAIImageRequest["model"]>(["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
const RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const QUALITIES = new Set<OpenAIImageRequest["quality"]>(["auto", "low", "medium", "high"]);
const BACKGROUNDS = new Set<OpenAIImageRequest["background"]>(["auto", "opaque", "transparent"]);

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const pick = <T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T =>
  typeof value === "string" && allowed.has(value as T) ? value as T : fallback;

/** Whether a run can be retried at all; `retryPlan` gives the reason when not. */
export const retryable = (history: OpenAIImageRunHistory): boolean =>
  history.run.status === "failed" && OPERATIONS.has(history.run.operation);

export function retryPlan(history: OpenAIImageRunHistory, connection: ImageConnection): RetryPlan {
  const { run } = history;
  if (!retryable(history)) return { ok: false, reason: "Only failed AI image runs can be retried" };
  const parameters = run.parameters;
  const prompt = text(parameters.prompt)?.trim() ?? "";
  if (!prompt) return { ok: false, reason: "This run has no recorded prompt" };
  const backend = parameters.provider === "codex-cli" ? "codex" : parameters.provider === "openai" ? "api_key" : null;
  if (!backend) return { ok: false, reason: "This run's image connection is unknown" };
  const inputs = history.inputs ?? [];
  const edit = run.operation === "openai.image.edit";
  if (edit !== inputs.length > 0) return { ok: false, reason: "This run's recorded inputs are incomplete" };
  const [first, ...rest] = inputs;
  const outputDir = text(parameters.save_directory_hint) ?? (first ? parentDir(first.path) : null);
  if (!outputDir) return { ok: false, reason: "This run has no recorded output folder" };
  const size = text(parameters.size) ?? "auto";
  const resolution = text(parameters.resolution);
  const aspectRatio = text(parameters.aspect_ratio);
  const outputFilename = imageOutputFilename(first ? basename(first.path) : null);
  const request: OpenAIImageRequest = {
    sourcePath: first?.path ?? null,
    ...(first ? { expectedSourceDigest: first.digest } : {}),
    referencePaths: rest.map((input) => input.path),
    ...(rest.length ? { expectedReferenceDigests: rest.map((input) => input.digest) } : {}),
    prompt, outputDir, outputFilename, backend,
    ...(backend === "codex" ? { codexPath: connection.codexPath } : {}),
    model: backend === "codex" ? "gpt-image-2" : pick(parameters.model, MODELS, "gpt-image-2"),
    size,
    ...(resolution && RESOLUTIONS.has(resolution) ? { resolution: resolution as OpenAIImageRequest["resolution"] } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    quality: backend === "codex" ? "auto" : pick(parameters.quality, QUALITIES, "auto"),
    background: backend === "codex" ? "auto" : pick(parameters.background, BACKGROUNDS, "auto"),
    retryOf: run.id,
  };
  return { ok: true, retry: { request, apiKey: backend === "api_key" ? connection.apiKey : "", label: outputFilename, detail: prompt } };
}

/** What Codex said when a run produced no image (recorded in the run's details). */
export interface CodexExplanation { readonly label: string; readonly text: string; readonly truncated: boolean }

export function codexExplanation(details: Record<string, unknown> | null | undefined): CodexExplanation | null {
  for (const [key, label] of [["codex_reply", "Codex reply"], ["codex_error", "Codex error"]] as const) {
    const value = details?.[key];
    if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
      const recorded = value as { text: string; truncated?: unknown };
      if (recorded.text.trim()) return { label, text: recorded.text, truncated: recorded.truncated === true };
    }
  }
  return null;
}

/** One line of at most `limit` characters (code points), with an ellipsis when cut. */
export function excerpt(value: string, limit = 300): string {
  const line = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : line;
}
