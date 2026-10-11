import { describe, expect, it, vi } from "vitest";
import { createComponentRequests } from "$lib/plugins/trace/view/component-requests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("component request queue", () => {
  it("removes a cancelled queued read and rejects before capacity is available", async () => {
    const request = createComponentRequests(1);
    const gate = deferred<number>();
    const running = request(() => gate.promise);
    const controller = new AbortController();
    const cancelledRead = vi.fn(async () => 2);
    let outcome: unknown = "pending";
    const cancelled = request(cancelledRead, controller.signal).catch((error) => { outcome = error; });
    const nextRead = vi.fn(async () => 3);
    const next = request(nextRead);
    const reason = new DOMException("Reveal superseded", "AbortError");
    try {
      controller.abort(reason);
      await flush();
      expect(outcome).toBe(reason);
      expect(cancelledRead).not.toHaveBeenCalled();
      expect(nextRead).not.toHaveBeenCalled();
    } finally { gate.resolve(1); await Promise.all([running, cancelled, next]); }
    expect(await next).toBe(3);
    expect(cancelledRead).not.toHaveBeenCalled();
  });

  it("does not admit an already aborted request", async () => {
    const request = createComponentRequests(1);
    const read = vi.fn(async () => 1);
    const controller = new AbortController();
    controller.abort();
    await expect(request(read, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps an aborted in-flight RPC's slot occupied until the RPC finishes", async () => {
    const request = createComponentRequests(1);
    const gate = deferred<number>();
    const controller = new AbortController();
    const running = request(() => gate.promise, controller.signal).catch((error: Error) => error.name);
    const nextRead = vi.fn(async () => 2);
    const next = request(nextRead);
    try {
      controller.abort();
      await flush();
      expect(nextRead).not.toHaveBeenCalled();
    } finally { gate.resolve(1); await Promise.all([running, next]); }
    expect(await running).toBe("AbortError");
    expect(await next).toBe(2);
  });

  it("frees capacity after synchronous throws and asynchronous failures", async () => {
    const request = createComponentRequests(1);
    const failed = request(() => { throw new Error("sync"); });
    await expect(failed).rejects.toThrow("sync");
    await expect(request(async () => { throw new Error("async"); })).rejects.toThrow("async");
    expect(await request(async () => 3)).toBe(3);
  });
});
