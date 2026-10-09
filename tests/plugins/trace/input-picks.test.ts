import { describe, expect, it } from "vitest";
import { NO_PICKS, clickListed, dropPick, followPicks, picksFromHost, pickOnly, pickable, replacePick, resolvePicks, selectionKey, settlePicks, togglePick, type PickLocation, type Picks } from "$lib/plugins/trace/view/input-picks";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const listed = (path: string) => ({ path, key: path });
const extra = (path: string) => ({ path, key: `o:${path}`, componentId: "c1" });

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
  /** The view's lookup: nodes by key in component c1; keys missing from fully loaded data are gone. */
  const nodesOf = (nodes: TraceNode[], loaded = true, componentId = "c1") => (key: string): PickLocation => {
    const node = nodes.find((candidate) => candidate.key === key);
    return node ? { node, componentId } : loaded ? null : "unknown";
  };
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

  it("a pick follows its node into the component it merged into", () => {
    const merged = followPicks(both, nodesOf(graph(), true, "c0"));
    expect(merged.extras.map((pick) => pick.componentId)).toEqual(["c0", "c0"]);
    expect(resolvePicks(merged, [])).toEqual([unsaved.path, mist.path]);
  });

  it("keeps a pick whose component is not loaded, and the same picks when nothing changed", () => {
    expect(followPicks(both, nodesOf([], false))).toBe(both);
    expect(followPicks(both, nodesOf(graph()))).toBe(both);
  });

  it("Ctrl-clicking a saved file that is picked only as an extra unpicks it without the host", () => {
    // warm is host-selected; merge was saved after a newer pick, so the host does not hold it.
    const host = ["/f/warm.png"];
    const picks = followPicks(togglePick(togglePick(pickOnly(listed("/f/warm.png"), true), unsaved, false, false), mist, false, false),
      nodesOf(graph({ path: "/f/u.png" })));
    expect(resolvePicks(picks, host)).toEqual(["/f/warm.png", "/f/u.png", mist.path]);
    const click = clickListed(picks, "/f/u.png", host, { ctrlKey: true });
    expect(click.host).toBe(false);
    expect(resolvePicks(click.picks, host)).toEqual(["/f/warm.png", mist.path]);
    // Once the host holds it, the click goes to the host, which toggles it off too.
    const held = clickListed(picks, "/f/u.png", [...host, "/f/u.png"], { ctrlKey: true });
    expect(held.host).toBe(true);
    expect(resolvePicks(held.picks, host)).toEqual(["/f/warm.png", mist.path]);
  });

  it("listed clicks: a plain click picks one, Ctrl toggles, Shift adds", () => {
    const start = pickOnly(listed("/f/a.png"), true);
    expect(clickListed(start, "/f/b.png", ["/f/a.png"], {})).toEqual({ picks: pickOnly(listed("/f/b.png"), true), host: true });
    expect(clickListed(start, "/f/a.png", ["/f/a.png"], { ctrlKey: true }).picks.order).toEqual([]);
    expect(clickListed(start, "/f/b.png", ["/f/a.png"], { shiftKey: true }).picks.order).toEqual(["/f/a.png", "/f/b.png"]);
  });
});

describe("recording the view's picks", () => {
  it("drops what the host no longer holds, keeping extras, as a new object", () => {
    // A host Shift range replaced [village, warm] with [warm, daylight].
    const picks: Picks = { order: ["/f/village.png", "/f/warm.png", "/x/u.png", "/f/daylight.png"], extras: [extra("/x/u.png")] };
    const settled = settlePicks(picks, ["/f/daylight.png", "/f/warm.png"]);
    expect(settled.order).toEqual(["/f/warm.png", "/x/u.png", "/f/daylight.png"]);
    expect(settled.extras).toEqual(picks.extras);
    // The same picks again are still a new value, so recording them registers.
    expect(settlePicks(settled, ["/f/daylight.png", "/f/warm.png"])).not.toBe(settled);
    expect(settlePicks(settled, ["/f/daylight.png", "/f/warm.png"])).toEqual(settled);
  });
});

describe("what the picks start over on", () => {
  it("is the folder and the selected files as a set", () => {
    expect(selectionKey("/f", ["/f/a.png", "/f/b.png"])).toBe(selectionKey("/f", ["/f/b.png", "/f/a.png"]));
    expect(selectionKey("/f", ["/f/a.png"])).not.toBe(selectionKey("/f", ["/f/a.png", "/f/b.png"]));
    expect(selectionKey("/f", [])).not.toBe(selectionKey("/g", []));
    // Paths with separators or quotes cannot collide.
    expect(selectionKey("/f", ["/f/a\n/f/b"])).not.toBe(selectionKey("/f", ["/f/a", "/f/b"]));
  });
});
