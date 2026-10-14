/**
 * Folder layout scheduling. Whole-folder engine runs go to a blob worker when the host permits it
 * (SDK 2 hosts announce "blobWorkers"; older CSPs reject blob workers), and otherwise run on the
 * main thread after yielding a frame. The worker gets one job at a time, so a request aborted
 * while it waits (its view moved on) is dropped instead of computed.
 */
import type { FolderLayout, FolderLayoutEngine, FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { hostAllowsBlobWorkers } from "../../../../sdk";
import { createLayoutWorker } from "./layout-worker-factory";

let worker: Worker | null | undefined;
let sequence = 0;
/** A whole-folder engine run: rejected as soon as it is aborted, even while the worker computes it (the reply is then dropped). */
interface FolderJob { readonly id: number; readonly input: FolderLayoutInput; readonly fallback: FolderLayoutEngine; readonly signal?: AbortSignal; resolve(layout: FolderLayout): void; reject(error: Error): void }
/** Jobs waiting for the worker, oldest first, and the one it is computing. */
let queue: FolderJob[] = [];
let running: FolderJob | null = null;
/** Layouts requested and not yet delivered (queued, computing or yielding); lets tests wait for the view to be quiescent. */
let outstanding = 0;
export const layoutsPending = (): number => outstanding;

const aborted = () => new DOMException("Trace layout was superseded", "AbortError");
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** Runs a job on the main thread after yielding a frame; one aborted by then is skipped. */
function runOnMainThread(job: FolderJob): void {
  requestAnimationFrame(() => {
    if (job.signal?.aborted) { job.reject(aborted()); return; }
    try { job.resolve(job.fallback(job.input)); } catch (error) { job.reject(asError(error)); }
  });
}

/** Starts the next job: aborted ones are dropped. */
function pump(): void {
  while (!running && worker) {
    const next = queue.shift();
    if (!next) return;
    if (next.signal?.aborted) { next.reject(aborted()); continue; }
    running = next;
    try {
      worker.postMessage({ id: next.id, folder: next.input });
    } catch (error) {
      running = null;
      next.reject(asError(error));
    }
  }
}

/** Ends the running job and moves on. An aborted job has already been rejected; settling it again is a no-op. */
function finish(outcome: { folder: FolderLayout } | { error: Error }): void {
  const job = running;
  running = null;
  if ("folder" in outcome) job?.resolve(outcome.folder); else job?.reject(outcome.error);
  pump();
}

function fallBack(): void {
  // A worker that fails to load (for example under an older host CSP) is
  // retired; queued requests complete on the main thread instead, one per frame.
  worker?.terminate();
  worker = null;
  const jobs = [...(running ? [running] : []), ...queue];
  running = null;
  queue = [];
  for (const job of jobs) runOnMainThread(job);
}

function workerInstance(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined" || !hostAllowsBlobWorkers()) return (worker = null);
  try {
    const created: Worker = createLayoutWorker();
    created.onmessage = (event: MessageEvent<{ id: number; folder?: FolderLayout; error?: string }>) => {
      if (running?.id !== event.data.id) return;
      finish(event.data.folder ? { folder: event.data.folder } : { error: new Error(event.data.error ?? "Layout failed") });
    };
    created.onmessageerror = () => finish({ error: new Error("Trace layout reply could not be read") });
    created.onerror = (event) => { event.preventDefault(); fallBack(); };
    worker = created;
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Runs a folder layout engine off the main thread (the worker runs the registered default
 * engine; `fallback` must be that engine, used on the main thread after yielding a frame when no
 * worker is available). Aborting `signal` rejects at once with an AbortError, whether the job is
 * waiting or already computing; a computation already running finishes and its reply is dropped.
 */
export function computeFolderLayout(input: FolderLayoutInput, fallback: FolderLayoutEngine, signal?: AbortSignal): Promise<FolderLayout> {
  if (signal?.aborted) return Promise.reject(aborted());
  outstanding++;
  const pending = new Promise<FolderLayout>((resolve, reject) => {
    const job: FolderJob = { id: ++sequence, input, fallback, signal, resolve, reject };
    if (!workerInstance()) { runOnMainThread(job); return; }
    signal?.addEventListener("abort", () => {
      queue = queue.filter((other) => other !== job);
      reject(aborted());
    }, { once: true });
    queue.push(job);
    pump();
  });
  const done = () => { outstanding--; };
  pending.then(done, done);
  return pending;
}

/**
 * Counts work the view is still preparing (data reads and layout for a scene) as pending layout,
 * so `layoutsPending` reports a view that will still publish. Returns the release function.
 */
export function holdLayoutWork(): () => void {
  outstanding++;
  let held = true;
  return () => { if (held) { held = false; outstanding--; } };
}

/** Releases the worker (plugin disable/removal). */
export function disposeLayouts(): void {
  worker?.terminate();
  worker = undefined;
  for (const job of [...(running ? [running] : []), ...queue]) job.reject(new Error("Trace layout was disposed"));
  running = null;
  queue = [];
}
