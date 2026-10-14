/**
 * A gate on backend read replies. Replies are computed when the request is made
 * (so a held read answers with the data of its own moment, as a native backend
 * does) and only their delivery waits. Holding may be selective: only requests
 * the predicate accepts are held; the rest pass through.
 */
export interface ReadInfo {
  method: string;
  directory: string | null;
  componentId: string | null;
  offset: number | null;
  token: string | null;
}
export type ReadPredicate = (read: ReadInfo) => boolean;

interface Held { info: ReadInfo; settle: (outcome: { error: Error } | null) => void }

export const readInfo = (method: string, params: Record<string, any>): ReadInfo => ({
  method,
  directory: typeof params.directory === "string" ? params.directory : null,
  componentId: params.componentId === undefined || params.componentId === null ? null : String(params.componentId),
  offset: typeof params.offset === "number" ? params.offset : null,
  token: params.token === undefined || params.token === null ? null : String(params.token),
});

export function createReadGate() {
  let predicate: ReadPredicate | null = null;
  let held: Held[] = [];
  const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
  return {
    /** Holds replies to matching requests (all, without a predicate) until released. */
    hold(match: ReadPredicate = () => true) { predicate = match; },
    /** Whether a request made now would be held. */
    holds: (info: ReadInfo): boolean => predicate !== null && predicate(info),
    /** Delivers `value` once released, or rejects it when rejected. */
    delay<T>(info: ReadInfo, value: T): Promise<T> {
      return new Promise<T>((resolve, reject) => held.push({ info, settle: (outcome) => outcome ? reject(outcome.error) : resolve(value) }));
    },
    held: (): ReadInfo[] => held.map((entry) => ({ ...entry.info })),
    releaseNext(): boolean { const next = held.shift(); next?.settle(null); return !!next; },
    rejectNext(error: unknown = "Trace read rejected"): boolean { const next = held.shift(); next?.settle({ error: asError(error) }); return !!next; },
    /** Stops holding and delivers everything held, oldest first. */
    releaseAll() { predicate = null; const pending = held; held = []; pending.forEach((entry) => entry.settle(null)); },
    /** Between tests: stop holding and drop held reads (their callers are gone with the page state). */
    reset() { predicate = null; held = []; },
  };
}
