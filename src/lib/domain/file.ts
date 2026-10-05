/** Structural workspace entry, stable in plugin SDK v1. */
export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modified: string;
}
