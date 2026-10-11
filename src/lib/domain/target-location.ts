import { isVirtualPath } from "$lib/domain/virtual-path";
import { parentDir } from "./path";

/** Matches the native absolute path shapes the host can save to. Existence
 * and write permissions are checked by the native save operation.
 */
export function isLocalAbsolutePath(path: string): boolean {
  return !!path && path.length <= 4096 && !path.includes("\0") && !isVirtualPath(path)
    && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}

/** The pane folder becomes the unsaved generation's suggested save location. */
export function outputLocationProblem(directory: string): string | null {
  if (!directory) return "The current output folder is unavailable. Select a local folder and choose Generate image with AI… from its context menu, or update the host to generate in the current pane.";
  return isLocalAbsolutePath(directory) ? null
    : "Open a local output folder in Explorer, then press Ctrl+E again. Generated images need a local folder for saving.";
}

/** Virtual/search listings may contain local images, but cannot receive saves.
 * Edits fall back to Image 1's folder; generation retains the location so the
 * caller can explain why a local folder is required.
 */
export function aiOutputDirectory(directory: string | null | undefined, inputs: readonly string[]): string {
  if (directory && isLocalAbsolutePath(directory)) return directory;
  const first = inputs[0];
  return first && isLocalAbsolutePath(first) ? parentDir(first) : directory ?? "";
}
