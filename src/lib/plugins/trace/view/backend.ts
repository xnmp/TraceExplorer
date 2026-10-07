/** Folder-scoped Trace queries used by the view, behind a substitutable seam. */
import { traceComponentNodes, traceFolderComponents, traceFolderMembers, type ComponentNodesPage, type FolderComponentsPage, type FolderMembersPage } from "$lib/api/trace";
import type { ApiResult } from "$lib/api/common";

export interface TraceBackend {
  components(directory: string, offset: number): Promise<FolderComponentsPage>;
  members(directory: string, token: string, offset: number): Promise<FolderMembersPage>;
  nodes(directory: string, token: string, componentId: string, offset: number): Promise<ComponentNodesPage>;
}

const unwrap = async <T>(result: Promise<ApiResult<T>>): Promise<T> => {
  const value = await result;
  if (!value.ok) throw new Error(value.error);
  return value.data;
};

export const traceBackend: TraceBackend = {
  components: (directory, offset) => unwrap(traceFolderComponents(directory, offset)),
  members: (directory, token, offset) => unwrap(traceFolderMembers(directory, token, offset)),
  nodes: (directory, token, componentId, offset) => unwrap(traceComponentNodes(directory, token, componentId, offset)),
};
