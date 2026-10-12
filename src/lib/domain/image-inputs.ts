/**
 * The input images of an AI edit. They are numbered Image 1…N in the order
 * shown, which is the order they are sent to the model and recorded as the
 * output's inputs; none is a "main" image. Image 1 only decides what an
 * aspect ratio of "Auto" (wire value "keep") keeps, and names the output file.
 */
import { isVirtualPath } from "./virtual-path";

export const MAX_IMAGE_INPUTS = 8;

export interface ImageInput {
  readonly path: string;
  /** Form-owned lifetime identity, retained through metadata updates; a re-add gets a new ID. */
  readonly id?: symbol;
  /** Filesystem identity returned by inspection; `path` retains the user's spelling. */
  readonly canonicalPath?: string;
  /** The revision to send; checked before the provider is contacted. */
  readonly digest?: string;
  readonly size?: { readonly width: number; readonly height: number };
  /** Why the image cannot be sent. */
  readonly error?: string;
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Lexical comparison only: preserve .. (symlinks can change its meaning), POSIX backslashes and display paths. */
export function normalizeImageInputPath(path: string): string {
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const unc = path.startsWith("\\\\");
  const windows = drive || unc;
  const parts = path.split(windows ? /[\\/]+/ : /\/+/);
  const root = drive ? `${parts[0].toUpperCase()}\\` : unc ? `\\\\${parts[1]}\\${parts[2]}\\` : "/";
  const segments: string[] = [];
  for (const part of parts.slice(drive ? 1 : unc ? 3 : 1)) {
    if (!part || part === ".") continue;
    segments.push(part);
  }
  return root + segments.join(windows ? "\\" : "/");
}

const inputPathIdentity = (input: ImageInput): string => normalizeImageInputPath(input.canonicalPath ?? input.path);

export type ImageInputIssueCode = "invalid-path" | "unsupported-format" | "duplicate" | "limit" | "unreadable";
export interface ImageInputIssue {
  readonly path: string | null;
  readonly code: ImageInputIssueCode;
  readonly message: string;
}
export interface ImageInputMergeResult {
  readonly inputs: readonly ImageInput[];
  readonly addedPaths: readonly string[];
  readonly issues: readonly ImageInputIssue[];
}

export const hasImageInputCapacity = (count: number): boolean => count < MAX_IMAGE_INPUTS;

/** Filesystem paths only; no URI conversion, relative resolution or guessed DOM file paths. */
export function imageInputPathIssue(value: unknown): ImageInputIssue | null {
  const path = typeof value === "string" ? value : null;
  const absolute = path !== null && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path));
  if (!path || path.includes("\0") || isVirtualPath(path) || !absolute) {
    return { path, code: "invalid-path", message: "Use an absolute local file path" };
  }
  return IMAGE.test(path) ? null : { path, code: "unsupported-format", message: "Unsupported format. Use PNG, JPEG or WebP" };
}

/** Synchronous preflight shared with intake. Repeated paths are duplicates even when the first cannot be read. */
export function preflightDroppedImageInputs(existing: readonly ImageInput[], values: readonly unknown[]): {
  readonly paths: readonly string[]; readonly issues: readonly ImageInputIssue[];
} {
  const seen = new Set(existing.flatMap((input) => [normalizeImageInputPath(input.path), inputPathIdentity(input)]));
  const paths: string[] = [], issues: ImageInputIssue[] = [];
  for (const value of values) {
    const problem = imageInputPathIssue(value);
    if (problem) { issues.push(problem); continue; }
    const path = value as string;
    const identity = normalizeImageInputPath(path);
    if (seen.has(identity)) { issues.push({ path, code: "duplicate", message: "Already an input" }); continue; }
    seen.add(identity);
    paths.push(path);
  }
  return { paths, issues };
}

/** Append inspected drops in delivered order, preserving existing objects and pinned revisions. */
export function mergeDroppedImageInputs(
  existing: readonly ImageInput[], paths: readonly unknown[], descriptions: ReadonlyMap<string, ImageInput>,
): ImageInputMergeResult {
  const preflight = preflightDroppedImageInputs(existing, paths);
  const inputs = [...existing], addedPaths: string[] = [], issues = [...preflight.issues];
  const seen = new Set(existing.map(inputPathIdentity));
  for (const path of preflight.paths) {
    const description = descriptions.get(path);
    if (description?.path === path && seen.has(inputPathIdentity(description))) {
      issues.push({ path, code: "duplicate", message: "Already an input" });
      continue;
    }
    if (!hasImageInputCapacity(inputs.length)) {
      issues.push({ path, code: "limit", message: `Up to ${MAX_IMAGE_INPUTS} inputs` });
      continue;
    }
    if (!description || description.path !== path || description.error || !description.digest) {
      issues.push({ path, code: "unreadable", message: `Cannot read image: ${description?.error || "inspection unavailable"}` });
      continue;
    }
    inputs.push({ ...description });
    seen.add(inputPathIdentity(description));
    addedPaths.push(path);
  }
  return { inputs, addedPaths, issues };
}

/** Paths usable as AI edit inputs, in order: one to eight distinct local PNG, JPEG or WebP images; otherwise none. */
export function imageInputPaths(paths: readonly string[]): string[] {
  const usable = paths.length > 0 && hasImageInputCapacity(paths.length - 1)
    && paths.every((path) => imageInputPathIssue(path) === null) && new Set(paths.map(normalizeImageInputPath)).size === paths.length;
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
    const identity = { path: input.path, ...(input.id ? { id: input.id } : {}),
      ...(found.canonicalPath ? { canonicalPath: found.canonicalPath } : {}) };
    if (found.error) return { ...identity, error: found.error };
    return { ...identity, digest: input.digest ?? found.digest, size: input.size ?? found.size, error: undefined };
  });
}

/** Metadata replacement preserves lifetime identity; IDs distinguish removed/re-added inputs. Untagged callers use paths. */
export function describeInputSnapshot(current: readonly ImageInput[], captured: readonly ImageInput[], described: readonly ImageInput[]): readonly ImageInput[] {
  const identity = (input: ImageInput): symbol | string => input.id ?? input.path;
  const surviving = new Set(captured.map(identity));
  const updated = new Map(describeInputs(current.filter((input) => surviving.has(identity(input))), described).map((input) => [identity(input), input]));
  return current.map((input) => updated.get(identity(input)) ?? input);
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
