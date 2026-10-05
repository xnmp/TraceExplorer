import { invoke, extractError, virtualPathGuard, type ApiResult } from "./common";

export interface TraceArtifact {
  readonly id: number;
  readonly path: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly generatingRun: number | null;
  readonly pathState: "present" | "missing" | "unavailable";
}

export interface TraceRun {
  readonly id: number;
  readonly operation: string;
  readonly parameters: Record<string, unknown> & { rect?: { left: number; top: number; right: number; bottom: number }; viewport?: { width: number; height: number } };
  readonly createdAt: string;
  readonly status: "running" | "succeeded" | "failed" | "interrupted" | "uncertain" | "untraced" | "cancelled";
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly recovered: boolean;
  readonly details?: Record<string, unknown> | null;
  readonly inputIds: number[];
}

export interface TraceGraph {
  readonly currentArtifactId: number;
  readonly selectedRevisionStatus: "matched" | "changed" | "unverified";
  readonly artifacts: TraceArtifact[];
  readonly runs: TraceRun[];
}

export async function traceForImage(path: string): Promise<ApiResult<TraceGraph | null>> {
  const refused = virtualPathGuard(path);
  if (refused) return refused;
  try {
    return { ok: true, data: await invoke<TraceGraph | null>("trace_for_image", { path }) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}
