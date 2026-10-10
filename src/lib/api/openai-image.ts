import { invoke, extractError, type ApiResult } from "./common";
import type { TraceRun } from "./trace";
import type { ImageDescription, ServiceError } from "../../../integration/services/image-generation-v1";

export interface ImageServiceAvailability {
  version: 1;
  available: boolean;
  reason?: ServiceError;
  providerDigest?: string;
  description?: ImageDescription;
}
/** Refuse malformed capability envelopes before they can enable a paid action. */
export function validImageAvailability(value: unknown): value is ImageServiceAvailability {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, any>;
  if (data.version !== 1 || typeof data.available !== "boolean") return false;
  if (data.reason && (typeof data.reason.code !== "string" || typeof data.reason.message !== "string" || data.reason.message.length > 2048)) return false;
  if (!data.available && data.description === undefined) return true;
  const d = data.description;
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v);
  const bounded = (v: unknown) => typeof v === "string" && v.trim().length > 0 && Array.from(v).length <= 256 && !/\p{Cc}/u.test(v);
  if (!d || d.version !== 1 || !Number.isSafeInteger(d.configurationRevision) || d.configurationRevision < 0 || !Array.isArray(d.profiles) || d.profiles.length > 32) return false;
  const seen = new Set<string>();
  for (const p of d.profiles) {
    if (!p || !id(p.id) || seen.has(p.id) || !id(p.recipeRevision) || !bounded(p.name)) return false;
    seen.add(p.id);
    if (p.transport === "openai-images" ? !bounded(p.defaultModel) : p.transport !== "codex-cli") return false;
    const c = p.capabilities, s = c?.sizes;
    if (!c || typeof c.generation !== "boolean" || typeof c.edit !== "boolean" || !Number.isInteger(c.maxInputs) || c.maxInputs < 0 || c.maxInputs > 8 || !s || typeof s.auto !== "boolean") return false;
    if (typeof c.modelSelection !== "boolean" || c.modelSelection !== (p.transport === "openai-images")) return false;
    if (![[c.maxInputBytes, 20 * 1024 * 1024], [c.maxTotalInputBytes, 64 * 1024 * 1024], [c.maxOutputBytes, 50 * 1024 * 1024]].every(([n, max]) => Number.isSafeInteger(n) && n > 0 && n <= max)) return false;
    if (![c.inputFormats, c.outputFormats].every((a) => Array.isArray(a) && a.length > 0 && a.length <= 3 && a.every((v: unknown) => typeof v === "string" && ["image/png", "image/jpeg", "image/webp"].includes(v)))) return false;
    if (![s.maxEdge, s.multipleOf, s.minPixels, s.maxPixels].every((n) => Number.isSafeInteger(n) && n > 0) || s.minPixels > s.maxPixels) return false;
    if (![c.quality, c.background].every((a) => Array.isArray(a) && a.length > 0 && a.length <= 4)) return false;
    if (!c.quality.every((v: unknown) => typeof v === "string" && ["auto", "low", "medium", "high"].includes(v)) || !c.background.every((v: unknown) => typeof v === "string" && ["auto", "opaque", "transparent"].includes(v))) return false;
  }
  return d.defaultConnectionId === null || (id(d.defaultConnectionId) && seen.has(d.defaultConnectionId));
}
export async function describeImageService(): Promise<ApiResult<ImageServiceAvailability>> {
  try {
    const data = await invoke<unknown>("image_service_describe");
    return validImageAvailability(data) ? { ok: true, data } : { ok: false, error: "The image provider returned invalid connection capabilities. Reload connections." };
  }
  catch (error) {
    const message = extractError(error);
    return { ok: false, error: /unknown method|method.not.found|unsupported.*image|has not been activated/i.test(message)
      ? "Shared image generation requires an updated host and Trace backend. Update them, then enable the Image Generation package in Plugins."
      : message };
  }
}

export interface OpenAIImageRunHistory {
  readonly run: TraceRun;
  readonly outputPath: string | null;
  readonly preparedOutputPath?: string | null;
  /** Inputs in submission order, as captured. Absent from older backends. */
  readonly inputs?: readonly { readonly path: string; readonly digest: string }[];
}

export async function recentOpenAIImageRuns(): Promise<ApiResult<OpenAIImageRunHistory[]>> {
  try { return { ok: true, data: await invoke<OpenAIImageRunHistory[]>("recent_openai_image_runs") }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

/** The recorded run of a host image job, or null when the job never reached acceptance. */
export async function openAIImageRunForJob(jobId: number): Promise<ApiResult<OpenAIImageRunHistory | null>> {
  try { return { ok: true, data: await invoke<OpenAIImageRunHistory | null>("openai_image_run_for_job", { jobId }) }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

export interface OpenAIImageRequest {
  batch?: {id: string; index: number; count: number};
  connectionId: string;
  expectedConnectionRevision: string;
  sourcePath: string | null;
  /** Expected revision shown by the host editor; checked before contacting the provider. */
  expectedSourceDigest?: string;
  referencePaths?: string[];
  /** Expected revisions of `referencePaths`, in order; checked before contacting the provider. */
  expectedReferenceDigests?: string[];
  prompt: string;
  outputDir: string;
  outputFilename: string;
  model: string | null;
  size: string;
  resolution?: "1k" | "2k" | "4k";
  aspectRatio?: string;
  quality: "auto" | "low" | "medium" | "high";
  background: "auto" | "opaque" | "transparent";
  /** The failed run this request retries, recorded as provenance. */
  retryOf?: number;
}

export async function startOpenAIImageJob(request: OpenAIImageRequest): Promise<ApiResult<number>> {
  try {
    return { ok: true, data: await invoke<number>("jobs.start", {kind:"openai-image", request }) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}

/** The current revision and size of each input image, in order; unusable images carry an error. */
export async function describeImageInputs(paths: readonly string[]): Promise<ApiResult<{ path: string; digest?: string; width?: number; height?: number; error?: string }[]>> {
  try { return { ok: true, data: await invoke("openai_image_inputs", { paths: [...paths] }) }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}
