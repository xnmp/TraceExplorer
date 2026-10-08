import { invoke, extractError, type ApiResult } from "./common";
import type { TraceRun } from "./trace";

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
  backend?: "codex" | "api_key";
  /** Optional absolute CLI path; empty/unset uses native desktop discovery. */
  codexPath?: string;
  sourcePath: string | null;
  /** Expected revision shown by the host editor; checked before contacting the provider. */
  expectedSourceDigest?: string;
  referencePaths?: string[];
  /** Expected revisions of `referencePaths`, in order; checked before contacting the provider. */
  expectedReferenceDigests?: string[];
  prompt: string;
  outputDir: string;
  outputFilename: string;
  model: "gpt-image-2" | "gpt-image-2.5-sunburst" | "gpt-image-2.5-flare";
  size: string;
  resolution?: "1k" | "2k" | "4k";
  aspectRatio?: string;
  quality: "auto" | "low" | "medium" | "high";
  background: "auto" | "opaque" | "transparent";
  /** The failed run this request retries, recorded as provenance. */
  retryOf?: number;
}

export async function startOpenAIImageJob(request: OpenAIImageRequest, apiKey: string): Promise<ApiResult<number>> {
  try {
    return { ok: true, data: await invoke<number>("jobs.start", {kind:"openai-image", request, apiKey }) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}

/** The current revision and size of each input image, in order; unusable images carry an error. */
export async function describeImageInputs(paths: readonly string[]): Promise<ApiResult<{ path: string; digest?: string; width?: number; height?: number; error?: string }[]>> {
  try { return { ok: true, data: await invoke("openai_image_inputs", { paths: [...paths] }) }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}
