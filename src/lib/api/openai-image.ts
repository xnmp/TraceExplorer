import { invoke, extractError, type ApiResult } from "./common";
import type { TraceRun } from "./trace";

export interface OpenAIImageRunHistory {
  readonly run: TraceRun;
  readonly outputPath: string | null;
  readonly preparedOutputPath?: string | null;
}

export async function recentOpenAIImageRuns(): Promise<ApiResult<OpenAIImageRunHistory[]>> {
  try { return { ok: true, data: await invoke<OpenAIImageRunHistory[]>("recent_openai_image_runs") }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

export interface OpenAIImageRequest {
  backend?: "codex" | "api_key";
  /** Optional absolute CLI path; empty/unset uses native desktop discovery. */
  codexPath?: string;
  sourcePath: string | null;
  /** Expected revision shown by the host editor; checked before contacting the provider. */
  expectedSourceDigest?: string;
  referencePaths?: string[];
  prompt: string;
  outputDir: string;
  outputFilename: string;
  model: "gpt-image-2" | "gpt-image-2.5-sunburst" | "gpt-image-2.5-flare";
  size: string;
  resolution?: "1k" | "2k" | "4k";
  aspectRatio?: string;
  quality: "auto" | "low" | "medium" | "high";
  background: "auto" | "opaque" | "transparent";
}

export async function startOpenAIImageJob(request: OpenAIImageRequest, apiKey: string): Promise<ApiResult<number>> {
  try {
    return { ok: true, data: await invoke<number>("start_openai_image_job", { request, apiKey }) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}
