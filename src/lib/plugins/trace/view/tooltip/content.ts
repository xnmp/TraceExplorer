/**
 * What a Trace tile's tooltip says: the full prompt (or the image name when
 * there is none), then short secondary lines with the image name, the run's
 * operation and model, the node's status, and where it lives when it is not
 * in the displayed folder.
 */
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { traceOperationLabel } from "$lib/domain/trace-operation";
import type { TraceRun } from "$lib/api/trace";
import { nodeStatus, nodeTitle } from "../node-target";

export interface TileTooltipContent {
  /** The prompt, or the image name when the node has no prompt. */
  readonly text: string;
  readonly isPrompt: boolean;
  /** Secondary lines, each short; may be empty. */
  readonly details: readonly string[];
}

/** Longer prompts are cut here; the tooltip clamps far earlier, and Preview shows the rest. */
export const PROMPT_LIMIT = 2000;

/** Trims, normalises line breaks, collapses runs of blank lines and caps the length. */
export function tooltipPrompt(prompt: string | null | undefined): string {
  const text = (prompt ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT).trimEnd()}…` : text;
}

const SCOPE_LABEL = { subfolder: "Subfolder", external: "Outside this folder" } as const;

export function tileTooltipContent(node: TraceNode, run?: TraceRun | null): TileTooltipContent {
  const prompt = tooltipPrompt(node.prompt);
  const name = nodeTitle(node);
  const model = run && typeof run.parameters.model === "string" ? run.parameters.model.trim() : "";
  const status = nodeStatus(node);
  const unsaved = node.temporary && !node.discarded && node.artifactId !== null;
  const summary = [
    prompt ? name : "",
    run ? traceOperationLabel(run.operation) : "",
    model,
    status,
    unsaved ? "Unsaved" : "",
  ].filter(Boolean).join(" · ");
  const location = node.scope === "current" ? "" : `${SCOPE_LABEL[node.scope]}: ${node.location}`;
  return { text: prompt || name, isPrompt: !!prompt, details: [summary, location].filter(Boolean) };
}
