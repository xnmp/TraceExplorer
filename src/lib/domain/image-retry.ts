/**
 * Retrying a failed AI image run, and reading why a Codex run made no image.
 *
 * A retry resubmits the recorded request as a new job: the same ordered
 * inputs (pinned to the revisions the failed run captured), prompt and
 * generation settings. Admission uses a current configured profile revision;
 * secret values and provider executable paths never enter the request.
 */
import type { OpenAIImageRequest, OpenAIImageRunHistory } from "$lib/api/openai-image";
import { basename, parentDir } from "./path";
import { imageOutputFilename } from "./image-output-filename";
import { capabilityProblem, connectionFields, type ImageConnection } from "$lib/plugins/openai-image/connections";

export interface ImageRetry { readonly request: OpenAIImageRequest; readonly label: string; readonly detail: string }
export type RetryPlan = { ok: true; retry: ImageRetry } | { ok: false; reason: string };

const OPERATIONS = new Set(["openai.image.edit", "openai.image.generate"]);
const RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const QUALITIES = new Set<OpenAIImageRequest["quality"]>(["auto", "low", "medium", "high"]);
const BACKGROUNDS = new Set<OpenAIImageRequest["background"]>(["auto", "opaque", "transparent"]);

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const pick = <T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T =>
  typeof value === "string" && allowed.has(value as T) ? value as T : fallback;

function providerExecution(history: OpenAIImageRunHistory): { present: boolean; state: unknown } {
  const details = history.run.details;
  if (!details || !("provider_execution" in details || "execution" in details)) return { present: false, state: null };
  const value = "provider_execution" in details ? details.provider_execution : details.execution;
  return { present: true, state: value && typeof value === "object" ? (value as { state?: unknown }).state : value };
}
/** Only an explicit failure can become a new paid operation. */
export function retryable(history: OpenAIImageRunHistory): boolean {
  const execution = providerExecution(history);
  return history.run.status === "failed" && OPERATIONS.has(history.run.operation)
    && (!execution.present || execution.state === "failed");
}

const NEW_REQUEST = "This run's connection cannot be reproduced safely. Choose a connection in a new generation request.";
const recipeText = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 100 * 1024 && new TextEncoder().encode(value).length <= 100 * 1024;
/** Compare normalized HTTP identity; authentication repairs do not change it. */
function endpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}
/** A Retry is not consent to change the transport, endpoint or image model. */
export function retryConnectionProblem(history: OpenAIImageRunHistory, connection: ImageConnection): string | null {
  const p = history.run.parameters;
  const recordedId = p.connection_id;
  if (recordedId === undefined) {
    // Only histories from the known old adapters may use a current default.
    if (["effective_recipe", "effective_recipe_digest", "provider_package"].some((key) => key in p)) return NEW_REQUEST;
    if (p.provider === "codex-cli" && connection.transport === "codex-cli" && p.model === null) return null;
    if (p.provider === "openai" && connection.transport === "openai-images"
      && endpoint(connection.baseUrl) === "https://api.openai.com/v1/images"
      && typeof p.model === "string" && p.model.trim()) return null;
    return NEW_REQUEST;
  }
  const r = p.effective_recipe as Record<string, any> | null;
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  const digest = (value: unknown) => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
  const options = r?.options;
  const inputs = history.inputs ?? [];
  if (!id(recordedId) || recordedId !== connection.id || !r || typeof r !== "object" || Array.isArray(r)
    || r.schemaVersion !== 1 || r.formatterVersion !== 1 || r.connectionId !== recordedId
    || !id(r.connectionRevision) || r.connectionRevision !== p.connection_revision
    || !digest(p.effective_recipe_digest) || !options || typeof options !== "object"
    || r.model !== p.model || options.size !== p.size || options.quality !== p.quality || options.background !== p.background
    || (options.resolution ?? null) !== (p.resolution ?? null) || (options.aspectRatio ?? null) !== (p.aspect_ratio ?? null)
    || !Array.isArray(r.inputDigests) || r.inputDigests.length !== inputs.length
    || r.inputDigests.some((d: unknown, i: number) => !digest(d) || d !== inputs[i].digest)
    || !Array.isArray(r.inputRoles) || r.inputRoles.length !== inputs.length || r.inputRoles.some((role: unknown) => typeof role !== "string" || !role || role.length > 128)
    || !recipeText(r.submittedPrompt)
    || typeof r.endpointIdentity !== "string" || !r.endpointIdentity || r.endpointIdentity.length > 4096) return NEW_REQUEST;
  try { if (new TextEncoder().encode(JSON.stringify(r)).length > 256 * 1024) return NEW_REQUEST; } catch { return NEW_REQUEST; }
  if (connection.transport === "codex-cli") return r.adapter === "codex-cli" && r.model === null
    && r.endpointIdentity.trim() === (connection.executablePath.trim() || "codex-cli:auto-discovery")
    && recipeText(r.agentTask) ? null : NEW_REQUEST;
  return r.adapter === "openai-images" && r.agentTask === null && typeof r.model === "string" && !!r.model.trim()
    && endpoint(r.endpointIdentity) !== null && endpoint(r.endpointIdentity) === endpoint(connection.baseUrl) ? null : NEW_REQUEST;
}

export function retryPlan(history: OpenAIImageRunHistory, connection: ImageConnection): RetryPlan {
  const { run } = history;
  if (!retryable(history)) return { ok: false, reason: "Only failed AI image runs can be retried" };
  const parameters = run.parameters;
  const prompt = text(parameters.prompt) ?? "";
  if (!prompt.trim()) return { ok: false, reason: "This run has no recorded prompt" };
  const inputs = history.inputs ?? [];
  const edit = run.operation === "openai.image.edit";
  if (edit !== inputs.length > 0) return { ok: false, reason: "This run's recorded inputs are incomplete" };
  const [first, ...rest] = inputs;
  const outputDir = text(parameters.save_directory_hint) ?? (first ? parentDir(first.path) : null);
  if (!outputDir) return { ok: false, reason: "This run has no recorded output folder" };
  const connectionProblem = retryConnectionProblem(history, connection);
  if (connectionProblem) return { ok: false, reason: connectionProblem };
  const size = text(parameters.size) ?? "auto";
  const resolution = text(parameters.resolution);
  const aspectRatio = text(parameters.aspect_ratio);
  const outputFilename = imageOutputFilename(first ? basename(first.path) : null);
  const request: OpenAIImageRequest = {
    sourcePath: first?.path ?? null,
    ...(first ? { expectedSourceDigest: first.digest } : {}),
    referencePaths: rest.map((input) => input.path),
    ...(rest.length ? { expectedReferenceDigests: rest.map((input) => input.digest) } : {}),
    prompt, outputDir, outputFilename, ...connectionFields(connection),
    model: connection.transport === "codex-cli" ? null : text(parameters.model),
    size,
    ...(resolution && RESOLUTIONS.has(resolution) ? { resolution: resolution as OpenAIImageRequest["resolution"] } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    quality: pick(parameters.quality, QUALITIES, "auto"),
    background: pick(parameters.background, BACKGROUNDS, "auto"),
    retryOf: run.id,
  };
  const problem = capabilityProblem(connection, request, inputs.length);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, retry: { request, label: outputFilename, detail: prompt } };
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
