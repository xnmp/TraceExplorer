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
  /** A terminated worker never delivers what it had in flight. */
  forget(owner: object) { held = held.filter((entry) => entry.owner !== owner); },
};
