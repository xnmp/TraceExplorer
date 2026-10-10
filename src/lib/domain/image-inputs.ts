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

/**
 * Overlays what the caller knows now on the inputs as arranged here (order,
 * removals, what the backend reported): the image editor, for one, reports
 * Image 1's size once its preview has loaded. The caller's revision and size
 * win; an input that cannot be used stays as it is.
 */
export function withLiveInputs(arranged: readonly ImageInput[], live: readonly ImageInput[]): readonly ImageInput[] {
  const byPath = new Map(live.map((input) => [input.path, input]));
  return arranged.map((input) => {
    const known = byPath.get(input.path);
    if (!known || input.error) return input;
    const digest = known.digest ?? input.digest, size = known.size ?? input.size;
    return digest === input.digest && size === input.size ? input : { ...input, digest, size };
  });
}

/**
 * The request fields for these inputs, in order. Image 1's revision is pinned
 * whenever it is known; the other images' revisions are pinned together, when
 * every one is known (the request carries them as one list).
 */
export function inputRequestFields(inputs: readonly ImageInput[]): {
  sourcePath: string | null; expectedSourceDigest?: string; referencePaths: string[]; expectedReferenceDigests?: string[];
} {
  const [first, ...rest] = inputs;
  return {
    sourcePath: first?.path ?? null,
    ...(first?.digest ? { expectedSourceDigest: first.digest } : {}),
    referencePaths: rest.map((input) => input.path),
    ...(rest.length && rest.every((input) => !!input.digest) ? { expectedReferenceDigests: rest.map((input) => input.digest!) } : {}),
  };
}

/**
 * The path of the one local PNG, JPEG or WebP file the host image editor can open; otherwise null.
 * `picks` are a Trace view's ordered picks, which can include images the host cannot select: when
 * there are any, the editor follows them and proceeds only if they are exactly that one image.
 */
export function singleImagePath(
  entries: readonly { readonly path: string; readonly kind: "file" | "directory" }[],
  picks: readonly string[] = [],
): string | null {
  const [entry] = entries;
  const path = entries.length === 1 && entry.kind === "file" ? imageInputPaths([entry.path])[0] ?? null : null;
  if (picks.length === 0) return path;
  return path !== null && picks.length === 1 && picks[0] === path ? path : null;
}
