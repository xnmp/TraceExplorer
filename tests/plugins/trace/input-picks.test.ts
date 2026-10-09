import { describe, expect, it } from "vitest";
import { NO_PICKS, dropPick, followHost, followPicks, picksFromHost, pickOnly, pickable, replacePick, resolvePicks, togglePick, type Picks } from "$lib/plugins/trace/view/input-picks";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const listed = (path: string) => ({ path, key: path });
const extra = (path: string) => ({ path, key: `o:${path}` });

/** Applies clicks like the Trace view: the host selection follows only listed images. */
function click(state: { picks: Picks; host: string[] }, path: string, isListed: boolean, ctrl = false) {
  const pick = isListed ? listed(path) : extra(path);
  const selected = resolvePicks(state.picks, state.host).includes(path);
  const picks = ctrl ? togglePick(state.picks, pick, isListed, selected) : pickOnly(pick, isListed);
  const host = !isListed ? (ctrl ? state.host : []) : ctrl ? (selected ? state.host.filter((p) => p !== path) : [...state.host, path].sort()) : [path];
  return { picks, host };
}

describe("Trace view picks", () => {
  it("keeps every Ctrl-clicked image, listed or not, in click order", () => {
    let state = { picks: NO_PICKS, host: [] as string[] };
    state = click(state, "/f/village.png", true);
    state = click(state, "/f/refs/mist.png", false, true);
    state = click(state, "/f/palette.png", true, true);
    state = click(state, "/managed/unsaved.png", false, true);
    // The host lists its selection alphabetically; picks keep the click order.
    expect(state.host).toEqual(["/f/palette.png", "/f/village.png"]);
    expect(resolvePicks(state.picks, state.host)).toEqual(["/f/village.png", "/f/refs/mist.png", "/f/palette.png", "/managed/unsaved.png"]);
  });

  it("Ctrl-clicking a picked image again removes it, and a plain click starts over", () => {
    let state = { picks: NO_PICKS, host: [] as string[] };
    state = click(state, "/f/a.png", true);
    state = click(state, "/x/b.png", false, true);
    state = click(state, "/f/c.png", true, true);
    state = click(state, "/x/b.png", false, true);
    state = click(state, "/f/a.png", true, true);
    expect(resolvePicks(state.picks, state.host)).toEqual(["/f/c.png"]);
    state = click(state, "/x/d.png", false);
    expect(resolvePicks(state.picks, state.host)).toEqual(["/x/d.png"]);
  });

  it("follows host selection changes it did not see, after the images it ordered", () => {
    const picks = togglePick(pickOnly(listed("/f/b.png"), true), listed("/f/a.png"), true, false);
    expect(resolvePicks(picks, ["/f/a.png", "/f/b.png", "/f/c.png"])).toEqual(["/f/b.png", "/f/a.png", "/f/c.png"]);
    expect(resolvePicks(picks, ["/f/a.png"])).toEqual(["/f/a.png"]);
    expect(resolvePicks(NO_PICKS, [])).toEqual([]);
  });

  it("a Shift range only adds listed images", () => {
    const picks = togglePick(pickOnly(listed("/f/a.png"), true), listed("/f/a.png"), true, true, true);
    expect(picks.order).toEqual(["/f/a.png"]);
  });

  it("only present, current images can be picked", () => {
    const node = { path: "/f/a.png", state: "present", earlierRevision: false, discarded: false } as TraceNode;
    expect(pickable(node)).toBe(true);
    for (const change of [{ path: null }, { state: "missing" }, { state: "running" }, { earlierRevision: true }, { discarded: true }]) {
      expect(pickable({ ...node, ...change } as TraceNode)).toBe(false);
    }
  });
});

describe("picks against the live graph and host selection", () => {
  const present = (path: string, change: Partial<TraceNode> = {}) =>
    ({ key: `o:${path}`, path, state: "present", earlierRevision: false, discarded: false, ...change }) as TraceNode;
  /** The view's lookup: nodes by key; keys missing from a loaded graph are gone. */
  const nodesOf = (nodes: TraceNode[], loaded = true) => (key: string) => nodes.find((node) => node.key === key) ?? (loaded ? null : undefined);
  const unsaved = extra("/cfg/generated/u.png");
  const mist = extra("/f/refs/mist.png");
  const both = togglePick(pickOnly(unsaved, false), mist, false, false);
  const graph = (u: Partial<TraceNode> = {}) => [present(unsaved.path, { key: unsaved.key, ...u }), present(mist.path, { key: mist.key })];

  it("a host selection change starts the picks over from the host selection", () => {
    expect(picksFromHost(["/f/b.png", "/f/a.png"])).toEqual({ order: ["/f/b.png", "/f/a.png"], extras: [] });
    expect(picksFromHost([])).toBe(NO_PICKS);
  });

  it("saving a picked unsaved image puts the saved file in its place", () => {
    const saved = { path: "/f/u.png", key: "/f/u.png" };
    const next = replacePick(both, unsaved.key, saved, true)!;
    expect(next.extras).toEqual([mist]);
    // The host selects the saved file; mist stays an extra, in its place after it.
    expect(resolvePicks(next, ["/f/u.png"])).toEqual(["/f/u.png", mist.path]);
    expect(replacePick(both, "o:not-picked", saved, true)).toBeNull();
    // Saved outside the folder: still an extra, at its new path.
    const outside = replacePick(both, unsaved.key, { path: "/x/u.png", key: unsaved.key }, false)!;
    expect(resolvePicks(outside, [])).toEqual(["/x/u.png", mist.path]);
  });

  it("an extra follows its node to the saved path, once, without the stale temporary path", () => {
    const moved = followPicks(both, nodesOf(graph({ path: "/f/u.png", temporary: false })));
    expect(resolvePicks(moved, [])).toEqual(["/f/u.png", mist.path]);
    // The host selecting the saved file too does not list it twice.
    expect(resolvePicks(moved, ["/f/u.png"])).toEqual(["/f/u.png", mist.path]);
  });

  it("drops a discarded, missing, earlier-revision or vanished pick and keeps the rest in order", () => {
    for (const change of [{ discarded: true }, { state: "missing" as const }, { earlierRevision: true }]) {
      expect(resolvePicks(followPicks(both, nodesOf(graph(change))), [])).toEqual([mist.path]);
    }
    expect(resolvePicks(followPicks(both, nodesOf([present(mist.path, { key: mist.key })])), [])).toEqual([mist.path]);
    // The Delete action drops it at once, before the graph refreshes.
    expect(resolvePicks(dropPick(both, unsaved.key), [])).toEqual([mist.path]);
    expect(dropPick(both, "o:unknown")).toBe(both);
  });

  it("keeps a pick whose component is not loaded, and the same picks when nothing changed", () => {
    expect(followPicks(both, nodesOf([], false))).toBe(both);
    expect(followPicks(both, nodesOf(graph()))).toBe(both);
  });

  it("Ctrl-clicking a saved file that is still an extra unpicks it", () => {
    const moved = followPicks(both, nodesOf(graph({ path: "/f/u.png" })));
    const off = togglePick(moved, listed("/f/u.png"), true, true);
    expect(resolvePicks(off, [])).toEqual([mist.path]);
    expect(off.extras).toEqual([mist]);
  });
});

describe("following the host selection", () => {
  const entries = [{}, {}];
  const at = (paths: string[], list: unknown = entries[0], directory = "/f") => ({ directory, entries: list, paths });

  it("a listing refresh with the same selection keeps the same paths", () => {
    const first = followHost(null, at(["/f/a.png"]));
    const refreshed = followHost(first, at(["/f/a.png"], entries[1]));
    expect(refreshed.paths).toBe(first.paths);
    // A later selection change against the refreshed listing is still seen.
    expect(followHost(refreshed, at(["/f/a.png"], entries[1])).paths).not.toBe(first.paths);
  });

  it("any other recomputation is a change, even to the same files", () => {
    const first = followHost(null, at(["/f/a.png", "/f/b.png"]));
    expect(followHost(first, at(["/f/a.png", "/f/b.png"])).paths).not.toBe(first.paths);
    expect(followHost(first, at(["/f/b.png"], entries[1])).paths).toEqual(["/f/b.png"]);
    expect(followHost(first, at(["/f/a.png", "/f/b.png"], entries[1], "/g")).paths).not.toBe(first.paths);
  });
});
