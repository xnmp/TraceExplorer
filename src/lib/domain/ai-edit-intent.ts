import type { FileEntry } from "./file";
import { imageInputPaths, MAX_IMAGE_INPUTS } from "./image-inputs";
import { isLocalAbsolutePath } from "./target-location";

export const INVALID_AI_EDIT_SELECTION = "Select one to eight PNG, JPEG, or WebP images first";

export type AIEditIntent =
  | { readonly kind: "generate" }
  | { readonly kind: "edit"; readonly inputs: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

export type AIEditEntry = Pick<FileEntry, "path" | "name" | "kind">;

/** Selection is path-based: the same image selected in two panes is one input.
 * Validate every entry before deduplicating, so unsupported entries never disappear.
 */
export function aiEditIntent(selection: readonly AIEditEntry[], hasUnusableTarget = false): AIEditIntent {
  const invalid: AIEditIntent = { kind: "invalid", reason: INVALID_AI_EDIT_SELECTION };
  if (!Array.isArray(selection) || hasUnusableTarget) return invalid;
  if (selection.length === 0) return { kind: "generate" };
  if (selection.some((entry) => !entry || entry.kind !== "file"
    || typeof entry.path !== "string" || typeof entry.name !== "string"
    || !isLocalAbsolutePath(entry.path)
    || !/\.(png|jpe?g|webp)$/i.test(entry.name))) return invalid;
  const paths = [...new Set(selection.map((entry) => entry.path))];
  if (paths.length > MAX_IMAGE_INPUTS) return invalid;
  const inputs = imageInputPaths(paths);
  return inputs.length ? { kind: "edit", inputs } : invalid;
}
