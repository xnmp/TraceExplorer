/**
 * The Trace view's motion frame loop (docs/scene-transactions.md §6, "Motion driver (rAF)"): one
 * `requestAnimationFrame` callback per frame, run in explicit phases, as in Framer Motion's
 * frameloop or fastdom's batched writes and reads:
 *
 * 1. `update`: the motion drivers compute every pose and write it (no DOM read in between).
 * 2. `scroll`: listeners that scroll to follow the poses just written (scroll anchoring).
 * 3. `read`: listeners that read the layout that results (windowing, marquee hit-testing).
 *
 * Every phase runs in the same callback, in this order, so nothing depends on the order the
 * browser queued frame callbacks in. Only `requestFrame` asks for a frame (the drivers, while an
 * epoch runs); listeners follow the frames that run and never request their own. A pending
 * request is kept, never cancelled and re-queued, so an epoch restarted in the same turn keeps
 * the frame its predecessor had; a loop with nothing left to do lets its next frame pass.
 *
 * A listener that throws is reported and the others still run: one view's failure never stops
 * another's frames.
 */

export type FramePhase = "update" | "scroll" | "read";
export type FrameListener = (now: number) => void;

const PHASES: readonly FramePhase[] = ["update", "scroll", "read"];
const listeners: Record<FramePhase, Set<FrameListener>> = { update: new Set(), scroll: new Set(), read: new Set() };
let pending = 0;

/** Reports an error without unwinding the caller (the browser's `reportError`, else the console). */
export function reportFrameError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}

function runPhase(phase: FramePhase, now: number): void {
  for (const listener of [...listeners[phase]]) {
    // Unsubscribed by an earlier listener of this frame.
    if (!listeners[phase].has(listener)) continue;
    try { listener(now); } catch (error) { reportFrameError(error); }
  }
}

function run(now: number): void {
  pending = 0;
  for (const phase of PHASES) runPhase(phase, now);
}

/**
 * Runs `listener` in `phase` of every frame the loop runs (with the frame's time), until the
 * returned function is called. Subscribing requests no frame.
 */
export function onFrame(phase: FramePhase, listener: FrameListener): () => void {
  listeners[phase].add(listener);
  return () => { listeners[phase].delete(listener); };
}

/** Requests the next frame, unless one is already pending. */
export function requestFrame(): void {
  if (!pending) pending = requestAnimationFrame(run);
}

/**
 * Runs the phases after `update` now, for poses written outside a frame (a test seek, a finish):
 * what follows motion sees them before the next frame paints.
 */
export function afterWrite(now: number = performance.now()): void {
  runPhase("scroll", now);
  runPhase("read", now);
}
