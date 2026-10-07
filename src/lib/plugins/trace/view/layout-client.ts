/**
 * Layout scheduling. Layouts run in a blob worker when the host permits it
 * (SDK 2 hosts announce "blobWorkers"; older CSPs reject blob workers), and
 * otherwise on the main thread after yielding a frame. Results are cached by
 * their exact request, so metadata-only updates never relayout a component.
 * The worker gets one job at a time, so a request aborted while it waits (its
 * view moved on) is dropped instead of computed.
 */
import { layoutGraph, type GraphLayout, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { hostAllowsBlobWorkers } from "../../../../sdk";
import LayoutWorker from "./layout.worker.ts?worker&inline";

const CACHE_LIMIT = 48;
const cache = new Map<string, GraphLayout>();
let worker: Worker | null | undefined;
let sequence = 0;
interface Job { readonly id: number; readonly signature: string; readonly request: LayoutRequest; readonly signal?: AbortSignal; resolve(layout: GraphLayout): void; reject(error: Error): void }
/** Jobs waiting for the worker, oldest first, and the one it is computing. */
let queue: Job[] = [];
let running: Job | null = null;
/** Bumped by `disposeLayouts`, so results arriving afterwards are not cached. */
let generation = 0;

const aborted = () => new DOMException("Trace layout was superseded", "AbortError");
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** Starts the next job: aborted ones are dropped, ones cached meanwhile resolve at once. */
function pump(): void {
  while (!running && worker) {
    const next = queue.shift();
    if (!next) return;
    if (next.signal?.aborted) { next.reject(aborted()); continue; }
    const known = cache.get(next.signature);
    if (known) { next.resolve(known); continue; }
    running = next;
    try {
      worker.postMessage({ id: next.id, request: next.request });
    } catch (error) {
      running = null;
      next.reject(asError(error));
    }
  }
}

/** Ends the running job and moves on. */
function finish(outcome: { layout: GraphLayout } | { error: Error }): void {
  const job = running;
  running = null;
  // Cached before the next job starts, so a queued duplicate is answered from it.
  if (job) { if ("layout" in outcome) job.resolve(remember(job.signature, outcome.layout)); else job.reject(outcome.error); }
  pump();
}

export function layoutSignature(request: LayoutRequest): string {
  // Width is normalised exactly as the engine does, so equal keys mean equal layouts.
  const width = Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : null;
  return JSON.stringify([width, request.items.map((item) => [item.key, item.width, item.height, item.order, item.parents]), request.hint ? [...request.hint] : null]);
}

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
    try { job.resolve(layoutGraph(job.request)); } catch (error) { job.reject(asError(error)); }
  }
}

function workerInstance(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined" || !hostAllowsBlobWorkers()) return (worker = null);
  try {
    const created: Worker = new LayoutWorker();
    created.onmessage = (event: MessageEvent<{ id: number; layout?: GraphLayout; error?: string }>) => {
      if (running?.id !== event.data.id) return;
      finish(event.data.layout ? { layout: event.data.layout } : { error: new Error(event.data.error ?? "Layout failed") });
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
    const job: Job = { id, signature, request, signal, resolve, reject };
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
