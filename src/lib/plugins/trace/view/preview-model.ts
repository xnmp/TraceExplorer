/**
 * What Trace's Preview section shows for one image, derived either from a
 * mounted Trace view (inputs can be focused there) or, in built-in views, from
 * the per-image trace query (inputs are informational).
 */
import type { TraceGraph, TraceRun } from "$lib/api/trace";
import type { NodeScope, TraceNode } from "$lib/domain/trace-graph/model";
import { basename, isInsideDir, parentDir, samePath, toForwardSlashes } from "$lib/domain/path";
import { traceOperationLabel } from "$lib/domain/trace-operation";

export interface PreviewInput {
  readonly key: string;
  readonly path: string | null;
  readonly present: boolean;
  readonly scope: NodeScope;
  readonly location: string;
  readonly runId: number | null;
  readonly prompt: string;
  readonly title: string;
}

export interface PreviewModel {
  readonly artifactId: number | null;
  readonly runId: number | null;
  readonly prompt: string;
  readonly inputs: readonly PreviewInput[];
  readonly focusable: boolean;
}

const fromNode = (node: TraceNode): PreviewInput => ({
  key: node.key, path: node.path, present: node.state === "present" && !node.discarded && !node.earlierRevision,
  scope: node.scope, location: node.location, runId: node.runId, prompt: node.prompt,
  title: node.path ? basename(node.path) : "Image",
});

export function modelFromView(node: TraceNode, lookup: (key: string) => TraceNode | null): PreviewModel {
  return {
    artifactId: node.artifactId, runId: node.runId, prompt: node.prompt, focusable: true,
    inputs: node.parents.map(lookup).filter((item): item is TraceNode => item !== null).map(fromNode),
  };
}

export function classify(path: string, directory: string): { scope: NodeScope; location: string } {
  if (samePath(parentDir(path), directory)) return { scope: "current", location: `./${basename(path)}` };
  if (isInsideDir(path, directory)) {
    const base = toForwardSlashes(directory).replace(/\/+$/, "");
    return { scope: "subfolder", location: toForwardSlashes(path).slice(base.length + 1) };
  }
  return { scope: "external", location: path };
}

const promptOf = (parameters: Record<string, unknown> | undefined) => typeof parameters?.prompt === "string" ? parameters.prompt : "";

export function modelFromGraph(graph: TraceGraph, directory: string): PreviewModel | null {
  const current = graph.artifacts.find((artifact) => artifact.id === graph.currentArtifactId);
  if (!current) return null;
  const runs = new Map(graph.runs.map((run) => [run.id, run]));
  const artifacts = new Map(graph.artifacts.map((artifact) => [artifact.id, artifact]));
  const run = current.generatingRun === null ? undefined : runs.get(current.generatingRun);
  const inputs = [...new Set(run?.inputIds ?? [])].flatMap((id): PreviewInput[] => {
    const artifact = artifacts.get(id);
    if (!artifact) return [];
    const producer = artifact.generatingRun === null ? undefined : runs.get(artifact.generatingRun);
    const place = artifact.temporary ? { scope: "external" as const, location: "Unsaved" } : classify(artifact.path, directory);
    return [{
      key: `a:${artifact.id}`, path: artifact.path, present: artifact.pathState === "present" && !artifact.discarded,
      ...place, runId: producer?.id ?? null, prompt: promptOf(producer?.parameters), title: basename(artifact.path),
    }];
  });
  return { artifactId: current.id, runId: run?.id ?? null, prompt: promptOf(run?.parameters), inputs, focusable: false };
}

export interface PreviewSetting {
  readonly label: string;
  readonly value: string;
}

const text = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() && value !== "auto" ? value : null;
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? String(value) : null;
};

function actualSize(details: TraceRun["details"]): string | null {
  const value = details?.actual_size;
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && (width as number) > 0 && (height as number) > 0 ? `${width} × ${height} px` : null;
}

/**
 * The labelled generation settings of a run, in display order. Missing,
 * empty, `auto` and non-scalar values are left out.
 */
export function runSettings(run: TraceRun): PreviewSetting[] {
  const { resolution, aspect_ratio: aspect, quality, seed } = run.parameters;
  const rows: Array<[string, string | null]> = [
    ["Operation", text(traceOperationLabel(run.operation))],
    ["Resolution", typeof resolution === "string" ? text(resolution.toLowerCase())?.toUpperCase() ?? null : text(resolution)],
    ["Aspect ratio", aspect === "keep" ? "Keep" : text(aspect)],
    ["Quality", text(quality)],
    ["Seed", text(seed)],
    ["Actual size", actualSize(run.details)],
  ];
  return rows.flatMap(([label, value]) => value === null ? [] : [{ label, value }]);
}
