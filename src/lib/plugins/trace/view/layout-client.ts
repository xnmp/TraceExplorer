/**
 * Layout scheduling. Layouts run in a blob worker when the host permits it
 * (SDK 2 hosts announce "blobWorkers"; older CSPs reject blob workers), and
 * otherwise on the main thread after yielding a frame. Results are cached by
 * their exact request, so metadata-only updates never relayout a component.
 * The worker gets one job at a time, so a request aborted while it waits (its
 * view moved on) is dropped instead of computed.
 */
import { layoutGraph, type GraphLayout, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import type { FolderLayout, FolderLayoutEngine, FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { layoutSignature } from "$lib/domain/trace-graph/layout-signature";
import { hostAllowsBlobWorkers } from "../../../../sdk";
import { createLayoutWorker } from "./layout-worker-factory";
export { canLayoutInline } from "$lib/domain/trace-graph/layout-workload";

const CACHE_LIMIT = 48;
const cache = new Map<string, GraphLayout>();
let worker: Worker | null | undefined;
let sequence = 0;
interface GraphJob { readonly kind: "graph"; readonly id: number; readonly signature: string; readonly request: LayoutRequest; readonly signal?: AbortSignal; resolve(layout: GraphLayout): void; reject(error: Error): void }
/** A whole-folder engine run: rejected as soon as it is aborted, even while the worker computes it (the reply is then dropped). */
interface FolderJob { readonly kind: "folder"; readonly id: number; readonly input: FolderLayoutInput; readonly fallback: FolderLayoutEngine; readonly signal?: AbortSignal; resolve(layout: FolderLayout): void; reject(error: Error): void }
type Job = GraphJob | FolderJob;
/** Jobs waiting for the worker, oldest first, and the one it is computing. */
let queue: Job[] = [];
let running: Job | null = null;
/** Bumped by `disposeLayouts`, so results arriving afterwards are not cached. */
let generation = 0;
/** Layouts requested and not yet delivered (queued, computing or yielding); lets tests wait for the view to be quiescent. */
let outstanding = 0;
export const layoutsPending = (): number => outstanding;

const aborted = () => new DOMException("Trace layout was superseded", "AbortError");
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** Starts the next job: aborted ones are dropped, ones cached meanwhile resolve at once. */
function pump(): void {
  while (!running && worker) {
    const next = queue.shift();
    if (!next) return;
    if (next.signal?.aborted) { next.reject(aborted()); continue; }
    const known = next.kind === "graph" ? cache.get(next.signature) : undefined;
    if (known && next.kind === "graph") { next.resolve(known); continue; }
    running = next;
    try {
      worker.postMessage(next.kind === "graph" ? { id: next.id, request: next.request } : { id: next.id, folder: next.input });
    } catch (error) {
      running = null;
      next.reject(asError(error));
    }
  }
}

/** Ends the running job and moves on. */
function finish(outcome: { layout: GraphLayout } | { folder: FolderLayout } | { error: Error }): void {
  const job = running;
  running = null;
  if (job?.kind === "graph") {
    // Cached before the next job starts, so a queued duplicate is answered from it.
    if ("layout" in outcome) job.resolve(remember(job.signature, outcome.layout));
    else job.reject("error" in outcome ? outcome.error : new Error("Trace layout reply did not match its request"));
  } else if (job?.kind === "folder") {
    // An aborted job has already been rejected; settling it again is a no-op.
    if ("folder" in outcome) job.resolve(outcome.folder);
    else job.reject("error" in outcome ? outcome.error : new Error("Trace layout reply did not match its request"));
  }
  pump();
}

export { layoutSignature };

function remember(signature: string, layout: GraphLayout): GraphLayout {
  cache.delete(signature);
  cache.set(signature, layout);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return layout;
}

function fallBack(): void {
  // A worker that fails to load (for example under an older host CSP) is
  // retired; queued requests complete on the main thread instead.
  worker?.terminate();
  worker = null;
  const jobs = [...(running ? [running] : []), ...queue];
  running = null;
  queue = [];
  for (const job of jobs) {
    if (job.signal?.aborted) { job.reject(aborted()); continue; }
    try {
      if (job.kind === "graph") job.resolve(layoutGraph(job.request)); else job.resolve(job.fallback(job.input));
    } catch (error) { job.reject(asError(error)); }
  }
}

function workerInstance(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined" || !hostAllowsBlobWorkers()) return (worker = null);
  try {
    const created: Worker = createLayoutWorker();
    created.onmessage = (event: MessageEvent<{ id: number; layout?: GraphLayout; folder?: FolderLayout; error?: string }>) => {
      if (running?.id !== event.data.id) return;
      finish(event.data.layout ? { layout: event.data.layout } : event.data.folder ? { folder: event.data.folder } : { error: new Error(event.data.error ?? "Layout failed") });
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
 * Computes (or reuses) a layout. Aborting `signal` drops the request if it is
 * still waiting (the promise rejects with an AbortError); one already being
 * computed finishes and is cached.
 */
export function computeLayout(request: LayoutRequest, signal?: AbortSignal): Promise<GraphLayout> {
  const pending = computeLayoutNow(request, signal);
  outstanding++;
  const done = () => { outstanding--; };
  pending.then(done, done);
  return pending;
}

function computeLayoutNow(request: LayoutRequest, signal?: AbortSignal): Promise<GraphLayout> {
  const signature = layoutSignature(request);
  const cached = cache.get(signature);
  if (cached) return Promise.resolve(remember(signature, cached));
  if (signal?.aborted) return Promise.reject(aborted());
  const born = generation;
  const keep = (layout: GraphLayout) => born === generation ? remember(signature, layout) : layout;
  const target = workerInstance();
  if (!target) {
    // On the main thread, after yielding a frame; a request aborted by then is skipped.
    return new Promise<GraphLayout>((resolve, reject) => requestAnimationFrame(() => {
      if (signal?.aborted) { reject(aborted()); return; }
      try { resolve(layoutGraph(request)); } catch (error) { reject(asError(error)); }
    })).then(keep);
  }
  const id = ++sequence;
  return new Promise<GraphLayout>((resolve, reject) => {
    const job: Job = { kind: "graph", id, signature, request, signal, resolve, reject };
    // A waiting job settles as soon as it is aborted, not when its turn comes.
    signal?.addEventListener("abort", () => {
      if (!queue.includes(job)) return;
      queue = queue.filter((other) => other !== job);
      reject(aborted());
    }, { once: true });
    queue.push(job);
    pump();
  }).then(keep);
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
    const target = workerInstance();
    if (!target) {
      requestAnimationFrame(() => {
        if (signal?.aborted) { reject(aborted()); return; }
        try { resolve(fallback(input)); } catch (error) { reject(asError(error)); }
      });
      return;
    }
    const job: FolderJob = { kind: "folder", id: ++sequence, input, fallback, signal, resolve, reject };
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

/** Computes small layouts synchronously (and caches them) so they never flash. */
export function layoutNow(request: LayoutRequest): GraphLayout {
  const signature = layoutSignature(request);
  return remember(signature, cache.get(signature) ?? layoutGraph(request));
}

/** Synchronous cache lookup, so remounts can render settled geometry at once. */
export function cachedLayout(request: LayoutRequest): GraphLayout | null {
  return cache.get(layoutSignature(request)) ?? null;
}

/** Releases the worker and cached geometry (plugin disable/removal). */
export function disposeLayouts(): void {
  worker?.terminate();
  worker = undefined;
  for (const job of [...(running ? [running] : []), ...queue]) job.reject(new Error("Trace layout was disposed"));
  running = null;
  queue = [];
  generation++;
  cache.clear();
}
