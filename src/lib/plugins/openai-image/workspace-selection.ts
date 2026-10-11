import type { PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";

/** Optional extension kept outside the SDK until the host publishes it there.
 * Hosts without it retain their active-pane selection behavior.
 */
export type CombinedSelectionWorkspace = PluginContext["workspace"] & {
  getCombinedSelection?: () => FileEntry[];
};

export function combinedSelection(workspace: PluginContext["workspace"]): FileEntry[] {
  const extended: CombinedSelectionWorkspace = workspace;
  return typeof extended.getCombinedSelection === "function"
    ? extended.getCombinedSelection() : workspace.getSelection();
}
