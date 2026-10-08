import { describe, expect, it } from "vitest";
import { NO_PICKS, pickOnly, pickable, resolvePicks, togglePick, type Picks } from "$lib/plugins/trace/view/input-picks";
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
