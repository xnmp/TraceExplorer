import { describe, expect, it } from "vitest";
import { createReplyLedger, createReplyStore, type LayoutJobMessage } from "$lib/plugins/trace/view/layout-protocol";
import { engines, type FolderLayout, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { rng } from "../../../layout-eval/corpus";
import { folderInput, handCase, makeFolder } from "../../domain/trace-graph/folder-layout-fixtures";

/** A stand-in input: only `previous` matters to the protocol. */
const input = (width: number, previous: FolderLayout | null): FolderLayoutInput =>
  ({ items: [], open: new Map(), width, tile: { width: 120 } as never, grid: { cellWidth: 120, cellHeight: 150, gap: 8 }, previous });
const layout = (width: number) => ({ width }) as unknown as FolderLayout;

describe("layout worker protocol", () => {
  it("sends a previous layout the worker still holds by reference, and others whole", () => {
    const ledger = createReplyLedger(2);
    const a = layout(1), b = layout(2), c = layout(3), foreign = layout(4);
    ledger.replied(1, a);
    ledger.replied(2, b);
    expect(ledger.message(3, input(10, a))).toEqual({ id: 3, folder: input(10, null), previous: 1 });
    ledger.replied(3, c);
    // `a` was the third reply back: the worker no longer holds it.
    expect(ledger.message(4, input(10, a))).toEqual({ id: 4, folder: input(10, a) });
    expect(ledger.message(4, input(10, c)).previous).toBe(3);
    // A layout the worker never sent (computed on the main thread) and no previous at all go whole.
    expect(ledger.message(5, input(10, foreign))).toEqual({ id: 5, folder: input(10, foreign) });
    expect(ledger.message(5, input(10, null))).toEqual({ id: 5, folder: input(10, null) });
  });

  it("counts a reply the client could not read, so an older one is no longer referred to", () => {
    const ledger = createReplyLedger(2);
    const a = layout(1);
    ledger.replied(1, a);
    ledger.replied(2, null);
    expect(ledger.message(3, input(10, a)).previous).toBe(1);
    ledger.replied(3, null);
    expect(ledger.message(4, input(10, a)).previous).toBeUndefined();
  });

  it("refers to nothing after a reset (a new worker)", () => {
    const ledger = createReplyLedger(2);
    const a = layout(1);
    ledger.replied(1, a);
    ledger.reset();
    expect(ledger.message(2, input(10, a))).toEqual({ id: 2, folder: input(10, a) });
  });

  it("resolves a reference to a reply the store holds, and reports one it dropped", () => {
    const store = createReplyStore(2);
    const a = layout(1), b = layout(2), c = layout(3);
    store.sent(1, a); store.sent(2, b);
    expect(store.input({ id: 3, folder: input(10, null), previous: 1 })!.previous).toBe(a);
    store.sent(3, c);
    expect(store.input({ id: 4, folder: input(10, null), previous: 1 })).toBeNull();
    expect(store.input({ id: 4, folder: input(10, b) })!.previous).toBe(b);
  });

  it("over any run of jobs, replies, unreadable replies and replaced workers, the worker resolves every message to the client's input", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed);
      const ledger = createReplyLedger();
      let store = createReplyStore();
      /** The client's copies of every reply it read, oldest first. */
      const copies: FolderLayout[] = [];
      let id = 0, referred = 0;
      for (let step = 0; step < 60; step++) {
        const roll = random();
        if (roll < 0.05) { store = createReplyStore(); ledger.reset(); continue; }
        const previous = roll < 0.15 || !copies.length ? (roll < 0.1 ? null : layout(-step)) : copies[Math.floor(random() * copies.length)];
        const sent = input(step, previous);
        const message: LayoutJobMessage = structuredClone(ledger.message(++id, sent));
        const received = store.input(message);
        expect(received, `seed ${seed} step ${step}`).not.toBeNull();
        expect(received).toEqual(sent);
        if (message.previous !== undefined) referred++;
        // The worker lays out and replies; the client reads the reply, or fails to.
        const reply = layout(1000 + id);
        store.sent(id, reply);
        const copy = random() > 0.1 ? structuredClone(reply) : null;
        ledger.replied(id, copy);
        if (copy) copies.push(copy);
      }
      expect(referred, `seed ${seed}: some jobs went by reference`).toBeGreaterThan(0);
    }
  });

  it("lays out alike from the worker's own reply and from the client's copy of it", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("fan-80")], files: 2 });
    const first = engines.default(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Saffron" }));
    const next = { open: ["s0:root", "s1:root"], focus: "s0:Ash" } as const;
    expect(engines.default(folderInput(folder, { ...next, previous: structuredClone(first) })))
      .toEqual(engines.default(folderInput(folder, { ...next, previous: first })));
  });
});
