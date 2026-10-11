import { hasImageInputCapacity, MAX_IMAGE_INPUTS, mergeDroppedImageInputs, preflightDroppedImageInputs,
  type ImageInput, type ImageInputIssue, type ImageInputMergeResult } from "$lib/domain/image-inputs";

export type ImageInputIntakeIssue = ImageInputIssue | {
  readonly path: string | null; readonly code: "busy"; readonly message: string;
};

interface IntakeOptions {
  readonly getInputs: () => readonly ImageInput[];
  /** Throws on an inspection failure; individual unreadable files carry `error`. */
  readonly inspect: (paths: readonly string[]) => Promise<readonly ImageInput[]>;
  readonly commit: (result: ImageInputMergeResult) => void;
  readonly blockedReason: () => string | null;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onFeedback: (addedPaths: readonly string[], issues: readonly ImageInputIntakeIssue[]) => void;
}
interface Batch {
  readonly paths: readonly string[];
  readonly issues: readonly ImageInputIssue[];
  readonly resolve: () => void;
}

/** Per-form FIFO intake. Every commit re-reads the arrangement after IO; disposal invalidates delivery. */
export function createImageInputIntake(options: IntakeOptions) {
  const queue: Batch[] = [];
  let disposed = false, running = false, pending = false;
  let current: Batch | null = null;
  const setPending = (value: boolean) => {
    if (pending === value) return;
    pending = value;
    options.onPendingChange(value);
  };
  const busyIssues = (paths: readonly unknown[], message: string): ImageInputIntakeIssue[] =>
    paths.map((path) => ({ path: typeof path === "string" ? path : null, code: "busy", message }));

  async function drain(): Promise<void> {
    running = true;
    try {
      while (!disposed && queue.length) {
        const batch = queue.shift()!;
        current = batch;
        const added: string[] = [], issues: ImageInputIntakeIssue[] = [...batch.issues];
        for (let offset = 0; !disposed && offset < batch.paths.length; offset += MAX_IMAGE_INPUTS) {
          const chunk = batch.paths.slice(offset, offset + MAX_IMAGE_INPUTS);
          const blocked = options.blockedReason();
          if (blocked) { for (const issue of busyIssues(batch.paths.slice(offset), blocked)) issues.push(issue); break; }
          const preflight = preflightDroppedImageInputs(options.getInputs(), chunk);
          issues.push(...preflight.issues);
          if (!preflight.paths.length) continue;
          let descriptions: readonly ImageInput[] = [];
          // Once full, no inspection is necessary to explain the remaining eligible files.
          if (hasImageInputCapacity(options.getInputs().length)) {
            try { descriptions = await options.inspect(preflight.paths); }
            catch (cause) {
              const error = cause instanceof Error ? cause.message : String(cause);
              descriptions = preflight.paths.map((path) => ({ path, error }));
            }
          }
          if (disposed) break;
          const blockedAfterRead = options.blockedReason();
          if (blockedAfterRead) { for (const issue of busyIssues(batch.paths.slice(offset), blockedAfterRead)) issues.push(issue); break; }
          const result = mergeDroppedImageInputs(options.getInputs(), preflight.paths,
            new Map(descriptions.map((input) => [input.path, input])));
          if (result.addedPaths.length) options.commit(result);
          added.push(...result.addedPaths);
          issues.push(...result.issues);
        }
        if (!disposed) options.onFeedback(added, issues);
        batch.resolve();
        current = null;
      }
    } finally {
      running = false;
      setPending(false);
    }
  }

  return {
    get pending(): boolean { return pending; },
    enqueue(paths: readonly unknown[]): Promise<void> {
      if (disposed) return Promise.resolve();
      const blocked = options.blockedReason();
      if (blocked) { options.onFeedback([], busyIssues(paths, blocked)); return Promise.resolve(); }
      const preflight = preflightDroppedImageInputs(options.getInputs(), paths);
      if (!preflight.paths.length && !running) { options.onFeedback([], preflight.issues); return Promise.resolve(); }
      const completion = new Promise<void>((resolve) => queue.push({ ...preflight, resolve }));
      setPending(true); // Synchronous: Ctrl+Enter cannot race the first inspection.
      if (!running) void drain();
      return completion;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      current?.resolve();
      for (const batch of queue.splice(0)) batch.resolve();
      setPending(false);
    },
  };
}
