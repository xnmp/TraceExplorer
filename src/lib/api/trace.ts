import { invoke, extractError, virtualPathGuard, type ApiResult } from "./common";

export interface TraceArtifact {
  readonly id: number;
  readonly path: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly generatingRun: number | null;
  readonly pathState: "present" | "missing" | "unavailable";
  readonly temporary?: boolean;
  readonly discarded?: boolean;
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
  readonly jobId?: number;
  readonly currentArtifactId: number;
  readonly selectedPath?: string;
  readonly selectedRevisionStatus: "matched" | "changed" | "unverified";
  readonly artifacts: TraceArtifact[];
  readonly runs: TraceRun[];
}

export async function traceForJob(jobId: number): Promise<ApiResult<TraceGraph | null>> {
  try { return {ok:true,data:await invoke<TraceGraph | null>("trace_for_job",{jobId})}; }
  catch(error) { return {ok:false,error:extractError(error)}; }
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

export async function imageSaveSuggestion(artifactId: number): Promise<{directory: string; filename: string}> {
  return invoke("image_save_suggestion", {artifactId});
}

export async function saveGeneratedImage(artifactId: number, target?: string): Promise<{path: string}> {
  return invoke("save_generated_image", {artifactId, ...(target ? {target} : {})});
}

export async function discardGeneratedImage(artifactId: number): Promise<{viewPath:string|null}> {
  return invoke("discard_generated_image", {artifactId});
}

// Folder-wide Trace index. Lists are paged explicitly: a page may hold fewer
// than the maximum (pages also stop at a byte budget), so continue from
// `offset + items.length` until `total` is reached. A `stale` page means the
// folder's index changed; restart from `traceFolderComponents`.

export type TraceNodeScope = "current" | "subfolder" | "external";
export type TraceNodeState = "present" | "missing" | "unavailable" | "running" | "uncertain";
export type TraceRevisionStatus = "matched" | "changed" | "unverified" | "missing";

export interface TraceNodeRecord {
  /** Stable across save, move, rename, and completion of a running output. */
  readonly key: string;
  readonly artifactId: number | null;
  readonly runId: number | null;
  /** Keys of displayed parents, in input order. */
  readonly parents: string[];
  readonly path: string | null;
  readonly scope: TraceNodeScope;
  readonly location: string;
  readonly state: TraceNodeState;
  readonly temporary: boolean;
  readonly discarded: boolean;
  readonly earlierRevision: boolean;
  readonly order: number;
  readonly prompt: string;
}

export interface ComponentSummaryRecord {
  /** Opaque and stable across refreshes, saves and new descendants; changes only when components merge or split. */
  readonly id: string;
  readonly title: string;
  readonly cover: { readonly path: string; readonly present: boolean } | null;
  readonly imageCount: number;
  readonly nodeCount: number;
  readonly active: boolean;
  readonly unsaved: boolean;
}

export interface FolderMemberRecord {
  readonly path: string;
  readonly componentId: string;
  readonly key: string;
}

export interface FolderComponentsPage {
  readonly token: string;
  readonly total: number;
  readonly offset: number;
  readonly components: ComponentSummaryRecord[];
}

export interface FolderMembersPage {
  readonly stale: boolean;
  readonly total: number;
  readonly offset: number;
  readonly members: FolderMemberRecord[];
}

export interface ComponentNodesPage {
  readonly stale: boolean;
  readonly total: number;
  readonly offset: number;
  readonly nodes: TraceNodeRecord[];
}

/** Server-side limit of `traceRunDetails`. */
export const MAX_TRACE_RUN_DETAILS = 64;

async function query<T>(method: string, params: Record<string, unknown>): Promise<ApiResult<T>> {
  try { return { ok: true, data: await invoke<T>(method, params) }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

export async function traceFolderComponents(directory: string, offset = 0): Promise<ApiResult<FolderComponentsPage>> {
  return virtualPathGuard(directory) ?? query("trace_folder_components", { directory, offset });
}

export async function traceFolderMembers(directory: string, token: string, offset = 0): Promise<ApiResult<FolderMembersPage>> {
  return virtualPathGuard(directory) ?? query("trace_folder_members", { directory, token, offset });
}

export async function traceComponentNodes(directory: string, token: string, componentId: string, offset = 0): Promise<ApiResult<ComponentNodesPage>> {
  return virtualPathGuard(directory) ?? query("trace_component_nodes", { directory, token, componentId, offset });
}

export async function traceRunDetails(runIds: readonly number[]): Promise<ApiResult<TraceRun[]>> {
  if (runIds.length > MAX_TRACE_RUN_DETAILS) return { ok: false, error: `At most ${MAX_TRACE_RUN_DETAILS} runs per request` };
  return query("trace_run_details", { runIds: [...runIds] });
}

export async function traceRevisionStatus(artifactId: number): Promise<ApiResult<TraceRevisionStatus>> {
  return query("trace_revision_status", { artifactId });
}
