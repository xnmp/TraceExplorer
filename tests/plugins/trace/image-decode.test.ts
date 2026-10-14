import { describe, expect, it } from "vitest";
import { boundedDecode, DECODE_BOUND_MS, type DecodableImage } from "$lib/plugins/trace/image-decode";

/** An image whose decode, load state and events the test drives, with a manual timer. */
function fakeImage({ complete = false } = {}) {
  let decoded!: () => void, broken!: (error: Error) => void;
  const listeners = new Map<string, Set<() => void>>();
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const image: DecodableImage & { complete: boolean } = {
    complete,
    decode: () => new Promise<void>((resolve, reject) => { decoded = resolve; broken = reject; }),
    addEventListener: (type, listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
  };
  const setTimer = (run: () => void, ms: number) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
  return {
    image, setTimer, timers,
    decoded: () => decoded(), broken: (error: Error) => broken(error),
    emit: (type: "load" | "error") => { for (const listener of [...(listeners.get(type) ?? [])]) listener(); },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    expire: () => { for (const timer of timers.filter((candidate) => !candidate.cancelled)) { timer.cancelled = true; timer.run(); } },
  };
}
const outcome = async (promise: Promise<unknown>) => {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return state;
};

describe("a bounded image decode", () => {
  it("settles with the decode, and stops its bound", async () => {
    const f = fakeImage();
    const decoding = boundedDecode(f.image, f.setTimer);
    expect(f.timers.map((timer) => timer.ms)).toEqual([DECODE_BOUND_MS]);
    f.decoded();
    expect(await decoding).toBe(f.image);
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("rejects with a failed decode (the cache then publishes the URL anyway)", async () => {
    const f = fakeImage();
    const decoding = boundedDecode(f.image, f.setTimer);
    f.broken(new Error("EncodingError"));
    await expect(decoding).rejects.toThrow("EncodingError");
  });

  it("a decode that never settles counts as done once the bound passes, if the image has loaded", async () => {
    const f = fakeImage({ complete: true });
    const decoding = boundedDecode(f.image, f.setTimer);
    expect(await outcome(decoding)).toBe("pending");
    f.expire();
    expect(await outcome(decoding)).toBe("resolved");
    // A late decode changes nothing.
    f.decoded();
    expect(await decoding).toBe(f.image);
  });

  it("after the bound, an image still loading settles on its load or error event, and stops listening", async () => {
    const f = fakeImage();
    const loading = boundedDecode(f.image, f.setTimer);
    f.expire();
    expect(await outcome(loading)).toBe("pending");
    f.emit("load");
    expect(await outcome(loading)).toBe("resolved");
    expect(f.listening()).toBe(0);

    const g = fakeImage();
    const failing = boundedDecode(g.image, g.setTimer);
    g.expire();
    g.emit("error");
    expect(await outcome(failing)).toBe("rejected");
    expect(g.listening()).toBe(0);
  });

  it("within the bound, loading is not enough: it waits for the decode", async () => {
    const f = fakeImage();
    const decoding = boundedDecode(f.image, f.setTimer);
    f.image.complete = true;
    f.emit("load");
    expect(await outcome(decoding)).toBe("pending");
    f.decoded();
    expect(await outcome(decoding)).toBe("resolved");
  });
});
