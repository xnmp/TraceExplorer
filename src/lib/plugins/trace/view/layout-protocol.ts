/**
 * The layout worker's message format: what the client sends and what the worker keeps.
 *
 * A job's input usually has, as `previous`, the layout the worker computed for an earlier job:
 * the client holds its copy of that reply and would otherwise clone it back whole with every
 * job. The worker keeps its own last `RETAINED_REPLIES` replies (`createReplyStore`), so the
 * client's ledger (`createReplyLedger`) sends such a `previous` by reference (`previous: <job
 * id>`) and the rest of the input as is.
 *
 * Both sides count the same replies: the worker computes its jobs in order, one at a time, and
 * keeps every reply it sends (an aborted job's too, since it still completes), and the client
 * records every reply of the current worker in arrival order, a reply it could not read
 * included. A worker that is replaced (wedged or failed) starts empty, and so does the client's
 * ledger. Should a reference still miss, the worker answers `missing` and the client sends the
 * job again in full.
 */
import type { FolderLayout, FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";

/** Replies the worker keeps for later jobs to refer to. */
export const RETAINED_REPLIES = 2;

export interface LayoutJobMessage {
  readonly id: number;
  /** The input; its `previous` is null when `previous` below names it. */
  readonly folder: FolderLayoutInput;
  /** A retained reply's job id, standing for `folder.previous`. */
  readonly previous?: number;
}

export type LayoutReplyMessage =
  | { readonly id: number; readonly folder: FolderLayout }
  | { readonly id: number; readonly error: string }
  /** The job referred to a reply the worker no longer holds. */
  | { readonly id: number; readonly missing: true };

/** The client's side: which of its replies' copies the worker still holds. */
export interface ReplyLedger {
  /** The worker replied to `id` with a layout; `folder` is the client's copy of it (null when it could not be read). */
  replied(id: number, folder: FolderLayout | null): void;
  /** The message for a job: `input.previous` by reference when the worker still holds it. */
  message(id: number, input: FolderLayoutInput): LayoutJobMessage;
  /** The worker holds nothing (it is new, or a reference missed). */
  reset(): void;
}

export function createReplyLedger(retained = RETAINED_REPLIES): ReplyLedger {
  let copies = new WeakMap<FolderLayout, number>();
  let held: number[] = [];
  return {
    replied(id, folder) {
      held.push(id);
      if (held.length > retained) held.shift();
      if (folder && typeof folder === "object") copies.set(folder, id);
    },
    message(id, input) {
      const previous = input.previous && typeof input.previous === "object" ? copies.get(input.previous) : undefined;
      return previous !== undefined && held.includes(previous) ? { id, folder: { ...input, previous: null }, previous } : { id, folder: input };
    },
    reset() { copies = new WeakMap(); held = []; },
  };
}

/** The worker's side: its last replies, to resolve references to them. */
export interface ReplyStore {
  /** The input a message stands for; null when it refers to a reply this store no longer holds. */
  input(message: LayoutJobMessage): FolderLayoutInput | null;
  /** The worker sent `folder` as its reply to `id`. */
  sent(id: number, folder: FolderLayout): void;
}

export function createReplyStore(retained = RETAINED_REPLIES): ReplyStore {
  const recent: { readonly id: number; readonly folder: FolderLayout }[] = [];
  return {
    input({ folder, previous }) {
      if (previous === undefined) return folder;
      const kept = recent.find((reply) => reply.id === previous);
      return kept ? { ...folder, previous: kept.folder } : null;
    },
    sent(id, folder) {
      recent.push({ id, folder });
      if (recent.length > retained) recent.shift();
    },
  };
}
