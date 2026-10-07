import type { FileEntry } from "./file";
import { isImageFile, isSvgFile } from "./file-types";
import { isVirtualPath } from "./virtual-path";

/** Only a single local image can replace the currently viewed trace. */
export function selectedTraceImage(entries: readonly FileEntry[]): FileEntry | null {
  if (entries.length !== 1) return null;
  const entry = entries[0];
  return !isVirtualPath(entry.path) && (isImageFile(entry) || isSvgFile(entry)) ? entry : null;
}
