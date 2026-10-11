/** Share the component-search budget across panes and reveals. Native admits
 * 32 ordinary RPCs; four node reads leave room for index, Preview and job work.
 */
export function createComponentRequests(limit = 4) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid component request limit");
  let active = 0;
  const waiting: Array<() => void> = [];
  return <T>(request: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      void (async () => {
        try { resolve(await request()); }
        catch (cause) { reject(cause); }
        finally { active -= 1; waiting.shift()?.(); }
      })();
    };
    if (active < limit) start(); else waiting.push(start);
  });
}

export const componentRequest = createComponentRequests();
