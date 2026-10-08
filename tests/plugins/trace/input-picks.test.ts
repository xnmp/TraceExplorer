import { describe, expect, it } from "vitest";
import { NO_PICKS, dropPick, extraIsLive, pickOnly, pickable, reconcilePicks, resolvePicks, togglePick, type Pick, type Picks } from "$lib/plugins/trace/view/input-picks";
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

describe("reconciling picks with the live state", () => {
  const present = (path: string, change: Partial<TraceNode> = {}) =>
    ({ key: `o:${path}`, path, state: "present", earlierRevision: false, discarded: false, ...change }) as TraceNode;
  /** The view's check: the graph's nodes by key, and the folder's listed paths. */
  const liveIn = (nodes: TraceNode[], listedPaths: string[] = [], loaded = true) => (pick: Pick) =>
    extraIsLive(pick, nodes.find((node) => node.key === pick.key) ?? (loaded ? null : undefined), listedPaths.includes(pick.path));
  const inputs = (picks: Picks, basis: string[], host: string[], live: (pick: Pick) => boolean) =>
    resolvePicks(reconcilePicks(picks, basis, host, live), host);

  const unsaved = extra("/cfg/generated/u.png");

  it("an unsaved pick that is then saved counts once, as the saved file", () => {
    // A plain click on unsaved U showed it as the Preview target: no host selection.
    const picks = pickOnly(unsaved, false);
    expect(inputs(picks, [], [], liveIn([present(unsaved.path, { key: unsaved.key })]))).toEqual([unsaved.path]);
    // Saving moves U's node to the saved path and selects that file.
    const saved = present("/home/x/u.png", { key: unsaved.key });
    expect(inputs(picks, [], ["/home/x/u.png"], liveIn([saved], ["/home/x/u.png"]))).toEqual(["/home/x/u.png"]);
    // Even before the host selection follows, the stale temporary path is gone.
    expect(inputs(picks, [], [], liveIn([saved], ["/home/x/u.png"]))).toEqual([]);
  });

  it("then deleting the saved file leaves nothing to edit", () => {
    const picks = pickOnly(unsaved, false);
    expect(inputs(picks, [], [], liveIn([present("/home/x/u.png", { key: unsaved.key, state: "missing" })]))).toEqual([]);
    expect(inputs(picks, [], [], liveIn([]))).toEqual([]);
  });

  it("drops a discarded pick, and keeps the others in order", () => {
    const other = extra("/x/b.png");
    const picks = togglePick(pickOnly(unsaved, false), other, false, false);
    const nodes = [present(unsaved.path, { key: unsaved.key, discarded: true }), present(other.path, { key: other.key })];
    expect(inputs(picks, [], [], liveIn(nodes))).toEqual(["/x/b.png"]);
    // The Delete action also drops it at once, before the graph refreshes.
    expect(resolvePicks(dropPick(picks, unsaved.key), [])).toEqual(["/x/b.png"]);
    expect(dropPick(picks, "o:unknown")).toBe(picks);
  });

  it("drops a pick that became an earlier revision or now has a different path", () => {
    const picks = pickOnly(extra("/x/b.png"), false);
    expect(inputs(picks, [], [], liveIn([present("/x/b.png", { key: "o:/x/b.png", earlierRevision: true })]))).toEqual([]);
    expect(inputs(picks, [], [], liveIn([present("/x/c.png", { key: "o:/x/b.png" })]))).toEqual([]);
  });

  it("an extra that is now a listed file belongs to the host selection", () => {
    const picks = pickOnly(extra("/f/b.png"), false);
    const nodes = [present("/f/b.png")];
    expect(inputs(picks, [], [], liveIn(nodes, ["/f/b.png"]))).toEqual([]);
    expect(inputs(picks, [], ["/f/b.png"], liveIn(nodes, ["/f/b.png"]))).toEqual(["/f/b.png"]);
  });

  it("keeps an extra whose component is not loaded yet", () => {
    const picks = pickOnly(unsaved, false);
    expect(inputs(picks, [], [], liveIn([], [], false))).toEqual([unsaved.path]);
  });

  it("a host selection change the view did not make replaces the extras", () => {
    // A listed pick, then a Ctrl-picked unsaved image, made against host selection [a].
    const picks = togglePick(pickOnly(listed("/f/a.png"), true), unsaved, false, false);
    const live = liveIn([present(unsaved.path, { key: unsaved.key })]);
    expect(inputs(picks, ["/f/a.png"], ["/f/a.png"], live)).toEqual(["/f/a.png", unsaved.path]);
    // Escape in the host clears it all.
    expect(inputs(picks, ["/f/a.png"], [], live)).toEqual([]);
    // Select all: the still-selected pick keeps its place, the rest follow.
    expect(inputs(picks, ["/f/a.png"], ["/f/0.png", "/f/a.png", "/f/b.png"], live)).toEqual(["/f/a.png", "/f/0.png", "/f/b.png"]);
    // A new pick starts from the reconciled picks, not the stale extras.
    const after = reconcilePicks(picks, ["/f/a.png"], ["/f/b.png"], live);
    expect(resolvePicks(togglePick(after, extra("/x/c.png"), false, false), ["/f/b.png"])).toEqual(["/f/b.png", "/x/c.png"]);
  });

  it("returns the same picks when nothing changed", () => {
    const picks = pickOnly(unsaved, false);
    expect(reconcilePicks(picks, [], [], () => true)).toBe(picks);
    expect(reconcilePicks(NO_PICKS, [], [], () => true)).toBe(NO_PICKS);
  });
});
