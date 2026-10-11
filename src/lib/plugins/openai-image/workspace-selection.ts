import type { PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";

/** Selection across the active tab's panes on hosts that offer it; the active
 * pane's selection on hosts that don't. */
export function combinedSelection(workspace: PluginContext["workspace"]): FileEntry[] {
  return typeof workspace.getCombinedSelection === "function"
    ? workspace.getCombinedSelection() : workspace.getSelection();
}
