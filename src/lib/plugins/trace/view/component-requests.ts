/** Share the component-search budget across panes and reveals. Native admits
 * 32 ordinary RPCs; four node reads leave room for index, Preview and job work.
 */
export function createComponentRequests(limit = 4) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid component request limit");
  let active = 0;
  const waiting: Array<() => void> = [];
  return <T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cancel = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      signal?.removeEventListener("abort", cancel);
      reject(signal?.reason);
    };
    const start = () => {
      active += 1;
      void (async () => {
        try { resolve(await request()); }
        catch (cause) { reject(cause); }
        finally {
          signal?.removeEventListener("abort", cancel);
          // Cancellation settles the caller, but a running native RPC still
          // occupies its slot until it actually finishes.
          active -= 1;
          waiting.shift()?.();
        }
      })();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (active < limit) start(); else waiting.push(start);
  });
}

export const componentRequest = createComponentRequests();
