/**
 * A gate on the layout worker's replies. The real worker runs; only delivery of
 * its `message` events to the client waits. Reply ids and errors pass through
 * untouched, so held replies behave exactly like slow ones.
 */
export interface LayoutReplyInfo {
  /** The client's job id, echoed by the worker. */
  id: number;
  /** A whole-folder engine run (the scene controller's); the worker's only message kind. */
  kind: "folder";
  /** Keys of the run's grid items, then of its open stacks' members, taken when posted. */
  itemKeys: string[];
  /** The run's open stacks (cover keys). */
  openKeys: string[];
  /** The worker's error message when the layout failed. */
  error: string | null;
}
export type LayoutReplyPredicate = (reply: LayoutReplyInfo) => boolean;

interface Held { info: LayoutReplyInfo; owner: object; deliver: () => void }

let predicate: LayoutReplyPredicate | null = null;
let held: Held[] = [];
let sent = 0;
/** Each worker the client created: when, and how many requests had been sent to any worker by then. */
let workers: { created: number; sentBefore: number; firstSent: number | null }[] = [];

export const layoutGate = {
  hold(match: LayoutReplyPredicate = () => true) { predicate = match; },
  heldReplies: (): LayoutReplyInfo[] => held.map((entry) => ({ ...entry.info, itemKeys: [...entry.info.itemKeys], openKeys: [...entry.info.openKeys] })),
  releaseNext(): boolean { const next = held.shift(); next?.deliver(); return !!next; },
  /** Stops holding and delivers everything held, oldest first. */
  releaseAll() { predicate = null; const pending = held; held = []; pending.forEach((entry) => entry.deliver()); },
  reset() { predicate = null; held = []; },
  /** Delivers now, or later when the gate holds this reply. */
  route(info: LayoutReplyInfo, owner: object, deliver: () => void) {
    if (predicate && predicate(info)) held.push({ info, owner, deliver }); else deliver();
  },
  /** Records a worker the client created (the factory calls this); returns its record's index. */
  created(): number { return workers.push({ created: performance.now(), sentBefore: sent, firstSent: null }) - 1; },
  /** Counts a request posted to worker `index` (the factory calls this as it posts). */
  sent(index: number) { sent++; workers[index].firstSent ??= performance.now(); },
  /** The workers created since the page loaded, oldest first (`performance.now()` times). */
  workers: () => workers.map((worker) => ({ ...worker })),
  /**
   * How many requests were posted to a worker since the page loaded. Unlike held replies, this does
   * not depend on how long the worker takes: a cold worker (its first job starts it) or a loaded
   * machine can reply after any fixed wait.
   */
  sentCount: (): number => sent,
  /** A terminated worker never delivers what it had in flight. */
  forget(owner: object) { held = held.filter((entry) => entry.owner !== owner); },
};
