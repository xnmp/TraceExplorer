/**
 * The input images of an AI edit. They are numbered Image 1…N in the order
 * shown, which is the order they are sent to the model and recorded as the
 * output's inputs; none is a "main" image. Image 1 only decides what an
 * aspect ratio of "Keep" keeps, and names the output file.
 */
import { isVirtualPath } from "./virtual-path";

export const MAX_IMAGE_INPUTS = 8;

export interface ImageInput {
  readonly path: string;
  /** The revision to send; checked before the provider is contacted. */
  readonly digest?: string;
  readonly size?: { readonly width: number; readonly height: number };
  /** Why the image cannot be sent. */
  readonly error?: string;
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Paths usable as AI edit inputs, in order: one to eight distinct local PNG, JPEG or WebP images; otherwise none. */
export function imageInputPaths(paths: readonly string[]): string[] {
  const usable = paths.length > 0 && paths.length <= MAX_IMAGE_INPUTS && new Set(paths).size === paths.length
    && paths.every((path) => !isVirtualPath(path) && IMAGE.test(path));
  return usable ? [...paths] : [];
}

/** Removes input `index`; the last remaining input is never removed. */
export function removeInput(inputs: readonly ImageInput[], index: number): readonly ImageInput[] {
  if (inputs.length <= 1 || index < 0 || index >= inputs.length) return inputs;
  return inputs.filter((_, position) => position !== index);
}

/** Moves input `from` to position `to` (clamped), shifting the others. */
export function moveInput(inputs: readonly ImageInput[], from: number, to: number): readonly ImageInput[] {
  if (from < 0 || from >= inputs.length) return inputs;
  const target = Math.max(0, Math.min(inputs.length - 1, to));
  if (target === from) return inputs;
  const next = [...inputs];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Adds what the backend reported about each path, keeping revisions a caller already pinned. */
export function describeInputs(inputs: readonly ImageInput[], described: readonly ImageInput[]): readonly ImageInput[] {
  const byPath = new Map(described.map((input) => [input.path, input]));
  return inputs.map((input) => {
    const found = byPath.get(input.path);
    if (!found) return input;
    if (found.error) return { path: input.path, error: found.error };
    return { path: input.path, digest: input.digest ?? found.digest, size: input.size ?? found.size, error: undefined };
  });
}

/** The request fields for these inputs, in order. Revisions are pinned only when every image has one. */
export function inputRequestFields(inputs: readonly ImageInput[]): {
  sourcePath: string | null; expectedSourceDigest?: string; referencePaths: string[]; expectedReferenceDigests?: string[];
} {
  const [first, ...rest] = inputs;
  const pinned = inputs.length > 0 && inputs.every((input) => !!input.digest);
  return {
    sourcePath: first?.path ?? null,
    ...(pinned ? { expectedSourceDigest: first.digest } : {}),
    referencePaths: rest.map((input) => input.path),
    ...(pinned && rest.length ? { expectedReferenceDigests: rest.map((input) => input.digest!) } : {}),
  };
}
