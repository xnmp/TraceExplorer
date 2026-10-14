/**
 * The motion frame loop's contract: one browser frame callback runs every phase in order (update,
 * scroll, read), whatever order listeners subscribed in; only `requestFrame` asks for a frame, and a
 * pending request is kept; a throwing listener is reported and never stops the others or the loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterWrite, onFrame, requestFrame } from "$lib/plugins/trace/view/frame-loop";

let callbacks: FrameRequestCallback[] = [];
let requests = 0;
let subscriptions: (() => void)[] = [];
const subscribe = (...args: Parameters<typeof onFrame>) => { const stop = onFrame(...args); subscriptions.push(stop); return stop; };
/** Runs the browser's pending frame callbacks at `now`. */
function frame(now: number): void {
  const pending = callbacks;
  callbacks = [];
  for (const callback of pending) callback(now);
}

beforeEach(() => {
  callbacks = []; requests = 0; subscriptions = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { requests++; callbacks.push(callback); return requests; });
  vi.stubGlobal("cancelAnimationFrame", () => { throw new Error("the frame loop never cancels a request"); });
});
afterEach(() => {
  for (const stop of subscriptions) stop();
  frame(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the motion frame loop", () => {
  it("runs update, then scroll, then read, in one frame callback, whatever order they subscribed in", () => {
    const order: string[] = [];
    subscribe("read", (now) => order.push(`read ${now}`));
    subscribe("scroll", (now) => order.push(`scroll ${now}`));
    subscribe("update", (now) => order.push(`update ${now}`));
    requestFrame();
    expect(callbacks).toHaveLength(1);
    frame(16);
    expect(order).toEqual(["update 16", "scroll 16", "read 16"]);
  });

  it("does not depend on the order the browser queued callbacks in: a foreign callback queued first sees no partial frame", () => {
    const written: number[] = [];
    let seenByForeign: number[] | null = null;
    // A callback queued before the loop's request runs first, before any phase.
    requestAnimationFrame(() => { seenByForeign = [...written]; });
    subscribe("update", (now) => written.push(now));
    const reads: number[][] = [];
    subscribe("read", () => reads.push([...written]));
    requestFrame();
    frame(16);
    expect(seenByForeign).toEqual([]);
    expect(reads).toEqual([[16]]);
  });

  it("requests a frame only when asked, and keeps a pending request instead of queueing another", () => {
    const update = vi.fn();
    subscribe("update", update);
    subscribe("read", () => {});
    expect(requests).toBe(0);
    requestFrame(); requestFrame(); requestFrame();
    expect(requests).toBe(1);
    frame(16);
    expect(update).toHaveBeenCalledOnce();
    // Nothing asked again: no frame follows.
    expect(callbacks).toHaveLength(0);
    frame(32);
    expect(update).toHaveBeenCalledOnce();
  });

  it("a listener asking for the next frame from inside a frame gets exactly one", () => {
    let frames = 0;
    subscribe("update", () => { if (++frames < 3) { requestFrame(); requestFrame(); } });
    requestFrame();
    frame(16); frame(32); frame(48); frame(64);
    expect(frames).toBe(3);
    expect(requests).toBe(3);
  });

  it("a throwing listener is reported; the other listeners and later frames still run", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const seen: string[] = [];
    subscribe("update", () => { throw new Error("one view failed"); });
    subscribe("update", () => { seen.push("other update"); requestFrame(); });
    subscribe("scroll", () => seen.push("scroll"));
    requestFrame();
    frame(16);
    frame(32);
    expect(seen).toEqual(["other update", "scroll", "other update", "scroll"]);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("a listener unsubscribed by an earlier one in the same phase does not run", () => {
    const later = vi.fn();
    let stopLater = () => {};
    subscribe("read", () => stopLater());
    stopLater = subscribe("read", later);
    requestFrame();
    frame(16);
    expect(later).not.toHaveBeenCalled();
  });

  it("afterWrite runs the phases after update now, without a frame", () => {
    const order: string[] = [];
    subscribe("update", () => order.push("update"));
    subscribe("scroll", () => order.push("scroll"));
    subscribe("read", () => order.push("read"));
    afterWrite(5);
    expect(order).toEqual(["scroll", "read"]);
    expect(requests).toBe(0);
  });
});
