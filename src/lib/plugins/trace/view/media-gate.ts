/**
 * Showing more of what a tile draws without a placeholder frame (docs/scene-transactions.md,
 * "Review fixes"): a change local to a component that makes it draw images (opening a tile's "+n"
 * reference badges) is applied only once those images are decoded, like a scene's media, so its
 * first frame draws them. Until then the component keeps its current look.
 *
 * The same contract as a scene's media wait (`scene-controller.svelte.ts`): images already drawable
 * add no wait, not even a microtask; otherwise at most `MEDIA_DEADLINE_MS`, after which an image
 * still loading draws its placeholder until it arrives. The images are pinned from the request
 * until the change rendered (its views subscribed), so the cache cannot evict them in between.
 */
import type { ThumbnailHold } from "$lib/domain/thumbnail-cache";

export interface MediaGateOptions {
  /** Prepares and pins images (`traceThumbnails.hold`). */
  readonly hold: (paths: Iterable<string>, revision: number) => ThumbnailHold;
  /** Settles once an applied change has rendered and its views subscribed (Svelte's `tick`). */
  readonly rendered: () => Promise<unknown>;
  /** How long a change waits for its images: the scene's `MEDIA_DEADLINE_MS`. */
  readonly deadline: number;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}

export interface MediaGate {
  /**
   * Runs `apply` once the images at `paths` are drawable or failed, or the deadline passed:
   * synchronously when they all already are. Replaces a pending request.
   */
  request(paths: Iterable<string>, revision: number, apply: () => void): void;
  /** Drops the pending request, if any, without applying it. Returns whether there was one. */
  cancel(): boolean;
}

const noop = () => undefined;
const defaultTimer = (run: () => void, ms: number) => { const handle = setTimeout(run, ms); return () => clearTimeout(handle); };

export function createMediaGate({ hold, rendered, setTimer = defaultTimer, deadline }: MediaGateOptions): MediaGate {
  let pending: { readonly hold: ThumbnailHold; readonly stop: () => void } | null = null;

  /** Applies a change and keeps its images pinned until it rendered. */
  function commit(held: ThumbnailHold, apply: () => void): void {
    try { apply(); }
    finally { const release = () => held.release(); void rendered().then(release, release); }
  }

  function cancel(): boolean {
    if (!pending) return false;
    const { hold: held, stop } = pending;
    pending = null;
    stop();
    held.release();
    return true;
  }

  function request(paths: Iterable<string>, revision: number, apply: () => void): void {
    cancel();
    const held = hold(paths, revision);
    if (!held.ready) { commit(held, apply); return; }
    let stopTimer: () => void = noop;
    const entry = { hold: held, stop: () => stopTimer() };
    const settle = () => {
      if (pending !== entry) return;
      pending = null;
      stopTimer();
      commit(held, apply);
    };
    pending = entry;
    stopTimer = setTimer(settle, deadline);
    held.ready.then(settle, settle);
  }

  return { request, cancel };
}
