import { describe, expect, it } from "vitest";
import { routeShape, samplePathString } from "$lib/domain/trace-graph/path-sampling";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, entityId, type FolderScene, type SceneRecord, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import {
  EASE, posePath, trackWithEndpoint, MOTION_MS, PAINTED, RETIREE_LIMIT, easeAt, easeTimeAt, effectiveClip, retargetPresentation, retargetTrack, ridesWithSection, samePose,
  samplePresentation, sampleTrack, settledPresentation, sliceEase, sliceTrack, staticPresentation, restylePresentation, type Ease, type Pose,
  type Presentation, type Track,
} from "$lib/plugins/trace/view/presentation";
import { folderInput, handCase, makeFolder, sourcesOf, type Folder } from "../../domain/trace-graph/folder-layout-fixtures";
import { presentationView } from "$lib/plugins/trace/view/presentation-view";
import { motionParticipants } from "$lib/plugins/trace/view/participants";
import { toggleNode, type Expansion } from "$lib/domain/trace-graph/expansion";
import { focusExpansion } from "../../../layout-eval/corpus";

// ─── Easing ─────────────────────────────────────────────────────────────────

/** E(u) evaluated independently: dense sampling of the Bézier and linear interpolation in x. */
function numericEase(ease: Ease, u: number): number {
  if (ease === "linear") return u;
  const [x1, y1, x2, y2] = ease, n = 20000;
  const at = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s * s + s ** 3;
  let previous = { x: 0, y: 0 };
  for (let i = 1; i <= n; i++) {
    const s = i / n, point = { x: at(x1, x2, s), y: at(y1, y2, s) };
    if (point.x >= u) return previous.y + (point.y - previous.y) * (point.x === previous.x ? 1 : (u - previous.x) / (point.x - previous.x));
    previous = point;
  }
  return 1;
}

describe("easing", () => {
  it("evaluates cubic-bezier(.2,.8,.2,1) against an independent numeric evaluation", () => {
    for (const u of [0, .001, .05, .1, .25, .5, .75, .9, .999, 1]) expect(easeAt(EASE, u)).toBeCloseTo(numericEase(EASE, u), 4);
  });

  it("clamps outside [0, 1] and reads NaN as the start", () => {
    expect(easeAt(EASE, -1)).toBe(0);
    expect(easeAt(EASE, 2)).toBe(1);
    expect(easeAt(EASE, NaN)).toBe(0);
    expect(easeAt("linear", .3)).toBe(.3);
  });

  it("inverts eased progress", () => {
    for (const p of [.01, .2, .5, .85, .95, .99]) expect(easeAt(EASE, easeTimeAt(EASE, p))).toBeCloseTo(p, 6);
    expect(easeTimeAt(EASE, 0)).toBe(0);
    expect(easeTimeAt(EASE, 1)).toBe(1);
  });

  it("residual easing matches g(v) = (E(u + (1-u)v) - E(u)) / (1 - E(u)) numerically", () => {
    for (const u of [0, .05, .2, .37, .5, .8, .95]) {
      const residual = sliceEase(EASE, u, 1), base = numericEase(EASE, u);
      for (const v of [0, .1, .25, .5, .75, .9, 1]) {
        const expected = (numericEase(EASE, u + (1 - u) * v) - base) / (1 - base);
        expect(easeAt(residual, v), `u=${u} v=${v}`).toBeCloseTo(expected, 3);
      }
    }
  });

  it("slices interior parts exactly and keeps the control points valid", () => {
    for (const [from, to] of [[.1, .4], [.3, .31], [0, .5], [.6, .9]]) {
      const part = sliceEase(EASE, from, to);
      expect(part).not.toBe("linear");
      const [x1, , x2] = part as readonly number[];
      expect(x1).toBeGreaterThanOrEqual(0); expect(x1).toBeLessThanOrEqual(1);
      expect(x2).toBeGreaterThanOrEqual(0); expect(x2).toBeLessThanOrEqual(1);
      const a = numericEase(EASE, from), b = numericEase(EASE, to);
      for (const v of [.2, .5, .8]) expect(easeAt(part, v)).toBeCloseTo((numericEase(EASE, from + (to - from) * v) - a) / (b - a), 3);
    }
  });

  it("returns linear for linear input, empty and reversed intervals", () => {
    expect(sliceEase("linear", .2, .6)).toBe("linear");
    expect(sliceEase(EASE, .5, .5)).toBe("linear");
    expect(sliceEase(EASE, .7, .2)).toBe("linear");
    expect(sliceEase(EASE, 0, 1)).toBe(EASE);
  });
});

// ─── Tracks ─────────────────────────────────────────────────────────────────

const pose = (x: number, y: number, opacity = 1, clip: Pose["clip"] = null): Pose => ({ rect: { x, y, width: 50, height: 40 }, opacity, clip });
const close = (a: Pose, b: Pose, px = .5, alpha = .01) =>
  Math.abs(a.rect.x - b.rect.x) <= px && Math.abs(a.rect.y - b.rect.y) <= px && Math.abs(a.rect.width - b.rect.width) <= px
  && Math.abs(a.rect.height - b.rect.height) <= px && Math.abs(a.opacity - b.opacity) <= alpha;

describe("tracks", () => {
  const track = retargetTrack(pose(0, 0, .2), pose(100, -60, 1))!;

  it("samples its ends, holds before and after, and follows the easing between", () => {
    expect(sampleTrack(track, 0)).toEqual(pose(0, 0, .2));
    expect(sampleTrack(track, -5)).toEqual(pose(0, 0, .2));
    expect(sampleTrack(track, MOTION_MS)).toEqual(pose(100, -60, 1));
    expect(sampleTrack(track, 10 * MOTION_MS)).toEqual(pose(100, -60, 1));
    expect(sampleTrack(track, NaN)).toEqual(pose(0, 0, .2));
    const mid = sampleTrack(track, 40), k = numericEase(EASE, 40 / MOTION_MS);
    expect(mid.rect.x).toBeCloseTo(100 * k, 2);
    expect(mid.rect.y).toBeCloseTo(-60 * k, 2);
    expect(mid.opacity).toBeCloseTo(.2 + .8 * k, 3);
  });

  it("is null when nothing moves or there is no time to move in", () => {
    expect(retargetTrack(pose(1, 2), pose(1, 2))).toBeNull();
    expect(retargetTrack(pose(1, 2), pose(1.004, 2))).toBeNull();
    expect(retargetTrack(pose(0, 0), pose(5, 0), 0)).toBeNull();
    expect(retargetTrack(pose(0, 0), pose(5, 0), -3)).toBeNull();
    expect(retargetTrack(pose(0, 0), pose(5, 0), NaN)).toBeNull();
  });

  it("slices exactly: the remaining trajectory is the original one", () => {
    const multi: Track = { frames: [
      { at: 0, pose: pose(0, 0, 0), easing: sliceEase(EASE, 0, .4) },
      { at: 64, pose: pose(30, 10, .5), easing: sliceEase(EASE, .4, 1) },
      { at: 160, pose: pose(90, 40, 1), easing: "linear" },
    ] };
    for (const original of [track, multi]) for (const at of [0, 1, 33.3, 64, 100, 159]) {
      const rest = sliceTrack(original, at)!;
      expect(rest.frames[0].at).toBe(0);
      for (const t of [0, 5, 20, 50, 96, 159 - at, 300]) {
        const a = sampleTrack(rest, t), b = sampleTrack(original, at + t);
        expect(close(a, b, .05, .001), `at ${at} + ${t}: ${JSON.stringify([a, b])}`).toBe(true);
      }
    }
  });

  it("slices to null once finished or at no time", () => {
    expect(sliceTrack(track, MOTION_MS)).toBeNull();
    expect(sliceTrack(track, Infinity)).toBeNull();
    expect(sliceTrack(track, NaN)).toBeNull();
    expect(sliceTrack(track, 0)).toBe(track);
  });

  it("keeps clips on both ends so a clip opens smoothly", () => {
    const opening = retargetTrack(pose(0, 0, 1, { x: 0, y: 0, width: 50, height: 10 }), pose(0, 0))!;
    expect(opening.frames.every((frame) => frame.pose.clip !== null)).toBe(true);
    expect(effectiveClip(sampleTrack(opening, MOTION_MS))).toBeNull();
    expect(sampleTrack(opening, 80).clip!.height).toBeGreaterThan(10);
  });
});

// ─── Scenes ─────────────────────────────────────────────────────────────────

const scope: SceneScope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
const folder: Folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 12 });
const [A, B] = [...folder.stacks.keys()];

function sceneFor(open: string[], options: { focus?: string | null; expansion?: Expansion; previous?: FolderLayout | null; width?: number; styling?: Partial<SceneStyling>; at?: SceneScope; of?: Folder } = {}): FolderScene {
  const of = options.of ?? folder;
  const input = folderInput(of, { open, focus: options.focus ?? null, expansion: options.expansion, width: options.width ?? 640, tile, grid, previous: options.previous ?? null });
  return buildFolderScene({ scope: options.at ?? scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(of), styling: { ...plain, focus: options.focus ?? null, ...options.styling } });
}
let epochs = 0;
const participants = (reduced = false) => ({ transaction: ++epochs, epoch: epochs, reduced });
/** Publishes `next` after `previous` (presented as `shown`), displayed at `at` within `shown`'s epoch. */
function step(shown: Presentation, previous: FolderScene, next: FolderScene, at: number) {
  const displayed = samplePresentation(shown, at);
  return { displayed, presentation: retargetPresentation(displayed, next, diffScenes(previous, next), participants()) };
}
const bandTiles = (scene: FolderScene, graph: string) => [...scene.records.values()].filter((r) => r.kind === "tile" && !r.cover && r.graphId === graph);
const routesOf = (scene: FolderScene, graph: string) => [...scene.records.values()].filter((r) => r.kind === "route" && r.graphId === graph);
const opacityAt = (p: Presentation, id: string, at: number) => samplePresentation(p, at).poses.get(id)!.opacity;

/** The first replacement pose of every displayed record equals what was displayed. */
function expectContinuous(displayed: ReturnType<typeof samplePresentation>, next: Presentation) {
  const first = samplePresentation(next, 0).poses;
  let checked = 0;
  for (const [id, was] of displayed.poses) {
    if (was.opacity <= PAINTED || (displayed.presentation.live.get(id) ?? displayed.presentation.retiring.get(id))?.record.kind === "band") continue;
    // An identity continues as a live record or as its retiree; one of them shows it as it was.
    const identity = displayed.presentation.live.get(id)?.record.id ?? displayed.presentation.retiring.get(id)?.record.id;
    const candidates = [first.get(id), ...[...next.retiring.values()].filter((r) => r.record.id === identity && r.reason === "exit").map((r) => first.get(r.renderId))]
      .filter((p): p is Pose => !!p);
    if (!candidates.length) continue; // Snapped away (an entry or cover leaving the listing).
    expect(candidates.some((p) => close(p, was)), `${id}: ${JSON.stringify({ was, candidates })}`).toBe(true);
    checked++;
  }
  return checked;
}

describe("retargetPresentation", () => {
  it("presents target poses only on a first publication, a scope change or reduced motion", () => {
    const a = sceneFor([]), b = sceneFor([A]);
    expect(retargetPresentation(null, b, diffScenes(null, b), participants())).toEqual(staticPresentation(b, epochs));
    const shown = samplePresentation(staticPresentation(a), Infinity);
    const reduced = retargetPresentation(shown, b, diffScenes(a, b), participants(true));
    expect(reduced.duration).toBe(0);
    expect(reduced.retiring.size).toBe(0);
    expect([...reduced.live.values()].every((r) => r.track === null && samePose(r.initial, { rect: r.record.rect, opacity: 1, clip: null }))).toBe(true);
    const other = sceneFor([A], { at: { ...scope, generation: 2 } });
    expect(retargetPresentation(shown, other, diffScenes(a, other), participants()).duration).toBe(0);
  });

  it("handles empty scenes", () => {
    const empty = sceneFor([], { of: makeFolder({ stacks: [] }) });
    const p = retargetPresentation(samplePresentation(staticPresentation(empty), Infinity), empty, diffScenes(empty, empty), participants());
    expect([p.live.size, p.retiring.size, p.duration]).toEqual([0, 0, 0]);
  });

  it("opens a band: rows move, tiles and their connectors arrive together at the end", () => {
    const closed = sceneFor([]), open = sceneFor([A], { previous: closed.layout });
    const { presentation: p } = step(staticPresentation(closed), closed, open, Infinity);
    expect(p.duration).toBe(MOTION_MS);
    const tiles = bandTiles(open, A);
    expect(tiles.length).toBeGreaterThan(1);
    for (const record of tiles) {
      expect(opacityAt(p, record.id, 0)).toBe(0);
      expect(opacityAt(p, record.id, MOTION_MS * .5)).toBe(0);
      expect(opacityAt(p, record.id, MOTION_MS)).toBe(1);
      const start = samplePresentation(p, 0).poses.get(record.id)!;
      expect(start.rect.y - record.rect.y).toBeCloseTo(-10, 6); // slides in from its parents' side
    }
    // Connectors share their tiles' opacity at every instant.
    for (const route of routesOf(open, A)) for (const t of [0, 100, 140, 150, 155, 159, 160]) {
      const child = route.kind === "route" && route.route.to.kind === "node" ? entityId("tile", A, route.route.to.id) : null;
      if (child && open.records.has(child) && child !== entityId("tile", A, A)) expect(opacityAt(p, route.id, t)).toBeCloseTo(opacityAt(p, child, t), 6);
    }
    // Something below the band moves down, from where it was.
    const moved = [...p.live.values()].filter((r) => r.track && (r.record.kind === "entry" || (r.record.kind === "tile" && r.record.cover)));
    expect(moved.length).toBeGreaterThan(0);
    for (const r of moved) expect(r.initial.rect).toEqual(closed.records.get(r.renderId)!.rect);
  });

  for (const at of [0, 40, 100]) it(`interrupting an opening with its closing continues from the displayed poses (${at} ms)`, () => {
    const closed = sceneFor([]), open = sceneFor([A], { previous: closed.layout });
    const opening = step(staticPresentation(closed), closed, open, Infinity).presentation;
    const reclosed = sceneFor([], { previous: open.layout });
    const { displayed, presentation: closing } = step(opening, open, reclosed, at);
    expect(expectContinuous(displayed, closing)).toBeGreaterThan(0);
    // Tiles still hidden in their arrival window retire without painting anything.
    if (at < 100) expect([...closing.retiring.values()].filter((r) => r.record.kind === "tile")).toEqual([]);
  });

  it("closing a band collapses it like an accordion: it slides up under its cover, visibly, over the whole motion", () => {
    const open = sceneFor([A]), closed = sceneFor([], { previous: open.layout });
    const { presentation: p } = step(staticPresentation(open), open, closed, Infinity);
    const groups = [...p.retiring.values()].filter((r) => r.record.kind === "band");
    expect(groups).toHaveLength(1);
    const [group] = groups, members = [...p.retiring.values()].filter((r) => r.group === group.renderId);
    expect(members.length).toBe(bandTiles(open, A).length + routesOf(open, A).length + [...open.records.values()].filter((r) => r.kind === "junction" && r.graphId === A).length);
    expect(members.every((m) => m.track === null)).toBe(true);
    const windowTop = group.initial.clip!.y;
    const tiles = members.filter((m) => m.record.kind === "tile"), others = members.filter((m) => m.record.kind !== "tile");
    /** How much of a member is shown at `t`: its painted height (0 when faded out or clipped away). */
    const shownHeight = (m: (typeof members)[number], t: number) => {
      const pose = samplePresentation(p, t).poses.get(m.renderId)!, clip = effectiveClip(pose);
      if (pose.opacity <= PAINTED) return 0;
      const top = Math.max(pose.rect.y, clip ? clip.y : -Infinity), bottom = Math.min(pose.rect.y + pose.rect.height, clip ? clip.y + clip.height : Infinity);
      return Math.max(0, bottom - top);
    };
    // Nothing is cut or faded on the first frame (connectors' bounds are padded: they leave the
    // cover's bottom edge, where the band's window begins); nothing is left at the end.
    const cover = open.records.get(entityId("tile", A, A))!.rect;
    expect(windowTop).toBeCloseTo(cover.y + cover.height, 6);
    for (const m of tiles) expect(shownHeight(m, 0), m.renderId).toBeCloseTo(m.record.rect.height, 6);
    for (const m of members) expect(shownHeight(m, MOTION_MS), m.renderId).toBe(0);
    let previous = Infinity, cut = 0;
    for (let t = 0; t <= MOTION_MS; t += 2) {
      const poses = samplePresentation(p, t).poses, shown = poses.get(group.renderId)!;
      const bottom = shown.clip!.y + shown.clip!.height;
      expect(bottom, `${t} ms: the band's bottom only rises`).toBeLessThanOrEqual(previous + 1e-9);
      previous = bottom;
      for (const m of members) {
        const pose = poses.get(m.renderId)!;
        expect(pose.opacity).toBeCloseTo(shown.opacity, 9);
        // It slides under its cover: nothing shows above where the band began.
        if (shownHeight(m, t) > 0) expect(Math.max(pose.rect.y, effectiveClip(pose)?.y ?? -Infinity), `${t} ms ${m.renderId}`).toBeGreaterThanOrEqual(windowTop - 1e-6);
      }
      // Never a connector or junction without a tile.
      if (others.some((m) => shownHeight(m, t) > 0)) expect(tiles.some((m) => shownHeight(m, t) > 0), `${t} ms: a connector without its tiles`).toBe(true);
      if (tiles.some((m) => shownHeight(m, t) > 0 && shownHeight(m, t) < m.record.rect.height - 1e-6)) cut++;
    }
    expect(cut, "frames (2 ms apart) showing a tile partly collapsed").toBeGreaterThanOrEqual(20);
    // Still painted half-way through the motion (the old fade ended ~2 ms in), the tiles first faded in its second half.
    for (const t of [8, 16, 33, MOTION_MS / 2]) expect(tiles.some((m) => shownHeight(m, t) > 0), `${t} ms: a tile shown`).toBe(true);
    expect(samplePresentation(p, 16).poses.get(group.renderId)!.opacity).toBe(1);
    // A settled epoch shows no retirees.
    expect(settledPresentation(p).retiring.size).toBe(0);
  });

  it("collapsing a node inside a band that holds still: its children stay shown, then fade, above the rows rising below", () => {
    const saffron = `${A.split(":")[0]}:Saffron`;
    const stack = folder.stacks.get(A)!, scope = { graph: stack.graph, members: stack.graph.dag.order, cover: A };
    const expanded = focusExpansion(saffron), collapsed = toggleNode(expanded, scope, saffron);
    const open = sceneFor([A], { expansion: expanded }), shut = sceneFor([A], { expansion: collapsed, previous: open.layout });
    const leaving = bandTiles(open, A).filter((record) => !shut.records.has(record.id));
    expect(leaving.length, "Saffron's children leave").toBeGreaterThan(0);
    // Its section holds still (the cover's row); the tiles that stay may reflow beside it.
    expect(shut.records.get(entityId("tile", A, A))!.rect).toEqual(open.records.get(entityId("tile", A, A))!.rect);
    const { presentation: p } = step(staticPresentation(open), open, shut, Infinity);
    const retirees = [...p.retiring.values()].filter((r) => r.group === null && r.record.kind === "tile" && leaving.some((l) => l.id === r.record.id));
    expect(retirees).toHaveLength(leaving.length);
    // The nearest row below rises into the band's space; nothing that leaves shows over it.
    const below = [...p.live.values()].filter((r) => r.record.graphId === null && r.track && r.initial.rect.y >= Math.max(...leaving.map((l) => l.rect.y + l.rect.height)) - .5)
      .sort((a, b) => a.initial.rect.y - b.initial.rect.y)[0];
    expect(below, "a row below rises").toBeDefined();
    const shownOf = (renderId: string, t: number) => {
      const pose = samplePresentation(p, t).poses.get(renderId)!, clip = effectiveClip(pose);
      return { opacity: pose.opacity, bottom: Math.min(pose.rect.y + pose.rect.height, clip ? clip.y + clip.height : Infinity), top: pose.rect.y };
    };
    for (const r of retirees) {
      expect(shownOf(r.renderId, 0).opacity, "whole on the first frame").toBe(1);
      expect(shownOf(r.renderId, 16).opacity, "still whole a frame in").toBe(1);
      expect(shownOf(r.renderId, 40).opacity, "fading").toBeGreaterThan(PAINTED);
      expect(shownOf(r.renderId, MOTION_MS).opacity).toBe(0);
      for (let t = 0; t <= MOTION_MS; t += 4) {
        const rowTop = samplePresentation(p, t).poses.get(below.renderId)!.rect.y, shown = shownOf(r.renderId, t);
        if (shown.opacity > PAINTED && shown.bottom > shown.top) expect(shown.bottom, `${t} ms`).toBeLessThanOrEqual(rowTop + 1e-6);
      }
    }
    expect(settledPresentation(p).retiring.size).toBe(0);
  });

  /** The last instant a closing group still paints. */
  const fadeEnd = (closing: Presentation) => {
    const group = [...closing.retiring.values()].find((r) => r.record.kind === "band")!;
    let t = 0;
    while (t < MOTION_MS && samplePresentation(closing, t + .5).poses.get(group.renderId)!.opacity > PAINTED) t += .5;
    return t;
  };

  for (const part of [0, .5, .9]) it(`reopening takes over the displayed retirees (${part * 100}% through their fade)`, () => {
    const open = sceneFor([A]), closed = sceneFor([], { previous: open.layout }), reopened = sceneFor([A], { previous: closed.layout });
    const closing = step(staticPresentation(open), open, closed, Infinity).presentation;
    const at = part ? fadeEnd(closing) * part : .01;
    const { displayed, presentation: p } = step(closing, closed, reopened, at);
    const members = [...closing.retiring.values()].filter((r) => r.group !== null && displayed.poses.get(r.renderId)!.opacity > PAINTED);
    expect(members.length).toBeGreaterThan(0);
    let takenOver = 0;
    for (const member of members) {
      const live = p.live.get(member.record.id)!, was = displayed.poses.get(member.renderId)!;
      if (live.record.kind === "tile") expect(samePose(live.track ? sampleTrack(live.track, MOTION_MS) : live.initial, { rect: live.record.rect, opacity: 1, clip: null })).toBe(true);
      if (close(live.initial, was)) { takenOver++; continue; }
      // A connector that cannot travel with its endpoints (its cover tile is fully shown) crossfades
      // from exactly what was displayed instead.
      expect(live.record.kind, member.record.id).toBe("route");
      const old = [...p.retiring.values()].find((r) => r.reason === "old-route" && r.record.id === member.record.id);
      expect(old && close(old.initial, was), member.record.id).toBe(true);
    }
    expect(takenOver).toBeGreaterThan(0);
    // Their retirees are gone: nothing is displayed twice.
    expect([...p.retiring.values()].filter((r) => r.group !== null || r.record.kind === "band")).toEqual([]);
    expect(expectContinuous(displayed, p)).toBeGreaterThan(0);
  });

  it("reopening a band sliding under its cover uncovers its tiles and connectors at one still edge, the cover's bottom", () => {
    const open = sceneFor([A]), closed = sceneFor([], { previous: open.layout }), reopened = sceneFor([A], { previous: closed.layout });
    const closing = step(staticPresentation(open), open, closed, Infinity).presentation;
    const { displayed, presentation: p } = step(closing, closed, reopened, fadeEnd(closing) / 2);
    const cover = reopened.records.get(entityId("tile", A, A))!;
    const edge = cover.rect.y + cover.rect.height;
    // The band's tiles and connectors that take over what the closing group displayed.
    const shown = new Set([...closing.retiring.values()].filter((r) => r.group !== null && displayed.poses.get(r.renderId)!.opacity > PAINTED).map((r) => r.record.id));
    const takers = [...p.live.values()].filter((live) => shown.has(live.record.id) && live.record.id !== cover.id);
    expect(new Set(takers.map((live) => live.record.kind))).toEqual(new Set(["tile", "route"]));
    expect(expectContinuous(displayed, p)).toBeGreaterThan(0);
    for (let t = 0; t <= MOTION_MS; t += 8) for (const live of takers) {
      const pose = samplePresentation(p, t).poses.get(live.renderId)!, clip = effectiveClip(pose);
      if (pose.opacity <= PAINTED) continue;
      const { rect } = pose, label = `${live.record.id} at ${t} ms`;
      // Shown exactly below the cover's bottom, the same edge for every record; nothing else is cut.
      expect(Math.max(rect.y, clip ? clip.y : -Infinity), label).toBeCloseTo(Math.max(rect.y, edge), 6);
      if (!clip) continue;
      expect(clip.y + clip.height, label).toBeGreaterThanOrEqual(rect.y + rect.height - 1e-6);
      expect(clip.x, label).toBeLessThanOrEqual(rect.x + 1e-6);
      expect(clip.x + clip.width, label).toBeGreaterThanOrEqual(rect.x + rect.width - 1e-6);
    }
    for (const live of takers) if (live.record.kind === "tile") expect(effectiveClip(sampleTrack(live.track!, MOTION_MS)), "whole at the end").toBeNull();
  });

  it("closing again during a reopening starts its clip from the displayed extent", () => {
    const open = sceneFor([A]), closed = sceneFor([], { previous: open.layout }), reopened = sceneFor([A], { previous: closed.layout });
    const closing = step(staticPresentation(open), open, closed, Infinity).presentation;
    const reopening = step(closing, closed, reopened, fadeEnd(closing) / 2).presentation;
    const reclosed = sceneFor([], { previous: reopened.layout });
    const { displayed, presentation: p } = step(reopening, reopened, reclosed, 20);
    const group = [...p.retiring.values()].find((r) => r.record.kind === "band")!;
    const members = [...p.retiring.values()].filter((r) => r.group === group.renderId);
    expect(members.length).toBeGreaterThan(0);
    // The new clip starts below everything the reopening showed: nothing is cut further on the first frame.
    for (const m of members) {
      const was = displayed.poses.get(m.record.id)!, clip = effectiveClip(was);
      const shownBottom = Math.min(was.rect.y + was.rect.height, clip ? clip.y + clip.height : Infinity);
      const shownTop = Math.max(was.rect.y, clip ? clip.y : -Infinity);
      if (was.opacity <= PAINTED || shownBottom <= shownTop) continue;
      expect(group.initial.clip!.y + group.initial.clip!.height, m.record.id).toBeGreaterThanOrEqual(shownBottom - 1e-6);
      expect(group.initial.clip!.y, m.record.id).toBeLessThanOrEqual(shownTop + 1e-6);
    }
    expect(expectContinuous(displayed, p)).toBeGreaterThan(0);
  });

  it("an unchanged destination continues its running motion exactly", () => {
    const closed = sceneFor([]), open = sceneFor([A], { previous: closed.layout });
    const opening = step(staticPresentation(closed), closed, open, Infinity).presentation;
    // A restyle elsewhere would not publish geometry; open the second stack, which A's band does not depend on.
    const both = sceneFor([A, B], { previous: open.layout });
    const { presentation: p } = step(opening, open, both, 50);
    let continued = 0;
    for (const record of bandTiles(both, A)) {
      const was = opening.live.get(record.id)!, now = p.live.get(record.id)!;
      if (!samePose(sampleTrack(was.track!, MOTION_MS), { rect: record.rect, opacity: 1, clip: null })) continue;
      for (const t of [0, 10, 60, 109, 200]) expect(close(sampleTrack(now.track!, t), sampleTrack(was.track!, 50 + t), .01, .0001)).toBe(true);
      continued++;
    }
    expect(continued).toBeGreaterThan(0);
  });

  it("an expansion reflows: its band's tiles travel and enter", () => {
    const base = sceneFor([A]), expanded = sceneFor([A], { focus: "s0:Saffron", previous: base.layout });
    const diff = diffScenes(base, expanded);
    expect(diff.policy.graphs.get(A)).toBe("reflow");
    const p = retargetPresentation(samplePresentation(staticPresentation(base), Infinity), expanded, diff, participants());
    const entering = bandTiles(expanded, A).filter((record) => !base.records.has(record.id));
    expect(entering.length).toBeGreaterThan(0);
    for (const record of entering) expect(p.live.get(record.id)!.track, record.id).not.toBeNull();
  });

  it("a reveal (an anchor that moved a band showing the same tiles) snaps its own records and drops its graph's retirees", () => {
    // Expansion reflows; a reveal is only an anchor change without one, so its policy is forced here.
    const asReveal = (diff: ReturnType<typeof diffScenes>) => ({ ...diff, policy: { ...diff.policy, graphs: new Map(diff.policy.graphs).set(A, "reveal" as const),
      records: new Map([...diff.policy.records].map(([id, policy]) => [id, (diff.enter.get(id) ?? diff.exit.get(id) ?? diff.update.get(id)?.after)?.graphId === A ? "snap" as const : policy])) } });
    const base = sceneFor([A]), focused = sceneFor([A], { focus: "s0:Saffron", previous: base.layout });
    const diff = asReveal(diffScenes(base, focused));
    const p = retargetPresentation(samplePresentation(staticPresentation(base), Infinity), focused, diff, participants());
    for (const [id, policy] of diff.policy.records) if (policy === "snap") expect(p.live.get(id)!.track).toBeNull();
    expect(p.retiring.size).toBe(0);
    // Collapsing descendants leaves in-band retirees; a reveal right after
    // snaps the revealed graph and drops its retirees at once.
    const narrow = sceneFor([A, B], { width: 900, focus: "s0:Saffron" }), wide = sceneFor([A, B], { width: 900, previous: narrow.layout });
    const resizing = step(staticPresentation(narrow), narrow, wide, Infinity).presentation;
    expect([...resizing.retiring.values()].filter((r) => r.record.graphId === A).length).toBeGreaterThan(0);
    const revealed = sceneFor([A, B], { width: 900, focus: "s0:Saffron", previous: wide.layout });
    const revealDiff = asReveal(diffScenes(wide, revealed));
    const q = retargetPresentation(samplePresentation(resizing, 1), revealed, revealDiff, participants());
    expect([...q.retiring.values()].filter((r) => r.record.graphId === A)).toEqual([]);
    for (const [id, policy] of revealDiff.policy.records) if (policy === "snap") expect(q.live.get(id)!.track).toBeNull();
  });

  it("retained connectors deform between their displayed and new paths without retiring or fading", () => {
    const a = sceneFor([A, B], { width: 640 }), b = sceneFor([A, B], { width: 900, previous: a.layout });
    const p = step(staticPresentation(a), a, b, Infinity).presentation;
    const paths = [...p.live.values()].filter(r => r.record.kind === "route" && a.records.has(r.renderId));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some(r => r.track?.frames[0].pose.stem || r.track?.frames[0].pose.shape)).toBe(true);
    expect([...p.retiring.values()].filter(r => r.reason === "old-route")).toEqual([]);
    for (const route of paths) for (let t = 0; t <= MOTION_MS; t += 4) expect(opacityAt(p, route.renderId, t)).toBe(1);
  });

  it("more than RETIREE_LIMIT paintable departures snap", () => {
    const big = makeFolder({ stacks: [handCase("fan-200"), handCase("fan-80")] });
    const [F, G] = [...big.stacks.keys()];
    expect(G).toBeDefined();
    const open = sceneFor([F, G], { of: big, width: 1400 }), closed = sceneFor([], { of: big, width: 1400, previous: open.layout });
    const departing = [...open.records.values()].filter((r) => r.graphId !== null && r.kind !== "band" && r.kind !== "row" && !(r.kind === "tile" && r.cover)).length;
    expect(departing).toBeGreaterThan(RETIREE_LIMIT);
    const { presentation: p } = step(staticPresentation(open), open, closed, Infinity);
    expect(p.retiring.size).toBe(0);
    // Within the limit, they retire.
    const medium = makeFolder({ stacks: [handCase("fan-30")] }), [M] = [...medium.stacks.keys()];
    const small = sceneFor([M], { of: medium, width: 1400 }), smallClosed = sceneFor([], { of: medium, width: 1400, previous: small.layout });
    expect(step(staticPresentation(small), small, smallClosed, Infinity).presentation.retiring.size).toBeGreaterThan(0);
  });

  it("restyles keep the epoch and settlement drops every track", () => {
    const closed = sceneFor([]), open = sceneFor([A], { previous: closed.layout });
    const p = step(staticPresentation(closed), closed, open, Infinity).presentation;
    const restyled = sceneFor([A], { previous: closed.layout, styling: { selectedPaths: new Set(["/f/file-0.png"]) } });
    const q = restylePresentation(p, restyled);
    expect(q.epoch).toBe(p.epoch);
    expect(q.duration).toBe(p.duration);
    for (const [id, presented] of q.live) {
      expect(presented.record).toBe(restyled.records.get(id));
      expect(presented.track).toBe(p.live.get(id)!.track);
    }
    const s = settledPresentation(q);
    expect([...s.live.values()].every((r) => r.track === null)).toBe(true);
    expect([s.retiring.size, s.duration]).toEqual([0, 0]);
  });

  it("connectors whose endpoints move rigidly ride with their section", () => {
    // Stack A starts row 0 and stack B row 1: opening A moves B's row, and B's band moves with its cover.
    const cells = folderInput(folder).items, files = cells.filter((cell) => cell.id.startsWith("/"));
    const columns = 4, items = [cells.find((c) => c.id === A)!, ...files.slice(0, columns - 1), cells.find((c) => c.id === B)!, ...files.slice(columns - 1)];
    const at = (open: string[], previous: FolderLayout | null = null) => {
      const input = { ...folderInput(folder, { open, width: 4 * (tile.width + 8), tile, grid, previous }), items };
      return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: plain });
    };
    const onlyB = at([B]), both = at([A, B], onlyB.layout);
    expect(both.columns).toBe(columns);
    const { presentation: p } = step(staticPresentation(onlyB), onlyB, both, Infinity);
    const cover = p.live.get(entityId("tile", B, B))!;
    expect(cover.track).not.toBeNull();
    for (const route of routesOf(both, B)) {
      const live = p.live.get(route.id)!;
      expect(ridesWithSection(live.track, route.rect, cover.track, cover.record.rect), route.id).toBe(true);
    }
  });
});

describe("retargetPresentation: review fixes (099e72f)", () => {
  const fadeEnd = (closing: Presentation) => [...closing.retiring.values()].find((r) => r.record.kind === "band")!.track!.frames[1].at;
  /** Connectors displayed before `p` whose live track starts hidden with no old path fading out in their place: they would blink. */
  function blinking(displayed: ReturnType<typeof samplePresentation>, p: Presentation): string[] {
    const ids: string[] = [];
    for (const [id, live] of p.live) {
      if (live.record.kind !== "route" || !live.track) continue;
      const was = displayed.poses.get(id);
      if (!was || was.opacity <= PAINTED) continue;
      const old = [...p.retiring.values()].some((r) => r.reason === "old-route" && r.record.id === id);
      if (sampleTrack(live.track, 0).opacity <= PAINTED && !old) ids.push(id);
    }
    return ids;
  }

  it("retained connectors stay opaque when the retiree limit drops a large band's departures", () => {
    const big = makeFolder({ stacks: [handCase("fan-200"), handCase("screenshot"), handCase("merges-3")], files: 12 });
    const [F, S, M] = [...big.stacks.keys()];
    let checked = 0;
    for (const [w1, w2] of [[1400, 900], [1400, 640], [900, 640], [640, 1400]]) {
      const open = sceneFor([F, S, M], { of: big, width: w1 });
      const next = sceneFor([S, M], { of: big, width: w2, previous: open.layout });
      const { displayed, presentation: p } = step(staticPresentation(open), open, next, Infinity);
      expect(blinking(displayed, p), `${w1} → ${w2}`).toEqual([]);
      expect(p.retiring.size).toBe(0);
      for (const live of p.live.values()) if (live.record.kind === "route" && open.records.has(live.record.id)) {
        for (let t = 0; t <= MOTION_MS; t += 8) expect(opacityAt(p, live.renderId, t)).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("in-band retirees of a band that closes keep their own fade, drawn by the grid", () => {
    const narrow = sceneFor([A, B], { width: 900, focus: "s0:Saffron" }), wide = sceneFor([A, B], { width: 900, previous: narrow.layout });
    const resizing = step(staticPresentation(narrow), narrow, wide, Infinity).presentation;
    const inBand = [...resizing.retiring.values()].filter((r) => r.group === null && r.record.graphId === A && r.record.kind !== "band");
    expect(inBand.length).toBeGreaterThan(0);
    const closed = sceneFor([B], { width: 900, previous: wide.layout });
    const at = 1, { displayed, presentation: p } = step(resizing, wide, closed, at);
    const shown = inBand.filter((r) => displayed.poses.get(r.renderId)!.opacity > PAINTED);
    expect(shown.length).toBeGreaterThan(0);
    const view = presentationView(p);
    for (const retiree of shown) {
      // No band draws A any more: the grid does, and the retiree continues exactly as it would have.
      expect(view.orphaned.has(retiree.renderId), retiree.renderId).toBe(true);
      expect(view.graphs.get(A)?.retiring ?? []).not.toContain(p.retiring.get(retiree.renderId));
      for (let t = 0; t <= MOTION_MS; t += 4) {
        expect(close(samplePresentation(p, t).poses.get(retiree.renderId)!, samplePresentation(resizing, at + t).poses.get(retiree.renderId)!), `${retiree.renderId} at ${t}`).toBe(true);
      }
    }
    // Reopened, the band draws them again: nothing is orphaned or duplicated in an exit group.
    const reopened = sceneFor([A, B], { width: 900, previous: closed.layout });
    const again = step(p, closed, reopened, 1).presentation, againView = presentationView(again);
    for (const retiree of shown) if (again.retiring.has(retiree.renderId)) {
      expect(againView.orphaned.has(retiree.renderId)).toBe(false);
      expect(againView.graphs.get(A)!.retiring.map((r) => r.renderId)).toContain(retiree.renderId);
    }
  });

  // A record coming back while its retiree is shown always takes part (`motionParticipants`),
  // wherever the viewport is, so it takes over the retiree: a tile is never drawn twice. (A
  // non-participant return, which would leave both copies, is unreachable.)
  it("a record returning while its retiree is shown takes part wherever the viewport is, and takes over the retiree", () => {
    const open = sceneFor([A]), closed = sceneFor([], { previous: open.layout }), reopened = sceneFor([A], { previous: closed.layout });
    const closing = step(staticPresentation(open), open, closed, Infinity).presentation;
    const displayed = samplePresentation(closing, fadeEnd(closing) / 2);
    const members = [...closing.retiring.values()].filter((r) => r.group !== null && r.record.kind !== "band" && displayed.poses.get(r.renderId)!.opacity > PAINTED);
    expect(members.some((member) => member.record.kind === "tile")).toBe(true);
    const records = motionParticipants({ next: reopened, displayed, viewport: { x: 1e6, y: 1e6, width: 10, height: 10 } })!;
    for (const member of members) expect(records.has(member.record.id), member.record.id).toBe(true);
    const p = retargetPresentation(displayed, reopened, diffScenes(closed, reopened), { ...participants(), records });
    const first = samplePresentation(p, 0).poses;
    for (const member of members) {
      // A rerouted connector's old path may crossfade ("old-route"); the departing copy itself is gone.
      const copies = [...p.retiring.values()].filter((retiree) => retiree.reason === "exit" && retiree.record.id === member.record.id && first.get(retiree.renderId)!.opacity > PAINTED);
      expect(copies, `${member.record.id}: a retiring copy still shown`).toEqual([]);
      if (member.record.kind === "tile") expect(close(first.get(p.live.get(member.record.id)!.renderId)!, displayed.poses.get(member.renderId)!), member.record.id).toBe(true);
    }
  });
});


describe("moving attachment stems", () => {
  it("follows an endpoint's residual motion instead of restarting its clock", () => {
    const whole = retargetTrack(pose(0, 100), pose(0, 200))!;
    const endpoint = sliceTrack(whole, 40)!;
    const from: Pose = { ...pose(0, 0), stem: { points: [{ x: 0, y: 0 }, { x: 0, y: sampleTrack(whole, 40).rect.y }], tail: [[0, sampleTrack(whole, 40).rect.y]], bridge: false } };
    const to: Pose = { ...pose(0, 0), stem: { points: [{ x: 0, y: 0 }, { x: 0, y: 200 }], tail: [[0, 200]], bridge: false } };
    const route = trackWithEndpoint(from, to, endpoint, pose(0, 200).rect)!;
    for (const dt of [0, 10, 20, 60, 120, 160]) {
      const end = sampleTrack(route, dt).stem!.points.at(-1)!;
      expect(end.y).toBeCloseTo(sampleTrack(whole, 40 + dt).rect.y, 6);
      expect(sampleTrack(route, dt).opacity).toBe(1);
    }
  });

  it("keeps the displayed stem when a moving attachment is interrupted or its destination stays unchanged", () => {
    const a = sceneFor([A, B], { width: 640 }), b = sceneFor([A, B], { width: 900, previous: a.layout });
    const moving = step(staticPresentation(a), a, b, Infinity).presentation;
    const stems = [...moving.live.values()].filter(r => r.record.kind === "route" && r.track?.frames[0].pose.stem);
    expect(stems.length).toBeGreaterThan(0);
    for (const at of [0, 40, 100, 159]) {
      const interrupted = step(moving, b, a, at).presentation;
      const continued = step(moving, b, b, at).presentation;
      for (const live of stems) {
        const shown = samplePresentation(moving, at).poses.get(live.renderId)!;
        const first = samplePresentation(interrupted, 0).poses.get(live.renderId)!;
        const closePath = (a: string, b: string) => {
          const first = samplePathString(a, 48)!, last = samplePathString(b, 48)!;
          for (let i = 0; i < first.length; i++) expect(Math.hypot(first[i].x - last[i].x, first[i].y - last[i].y)).toBeLessThan(.001);
        };
        closePath(posePath(first, first.rect)!, posePath(shown, shown.rect)!);
        for (const dt of [0, 20, 100, 160]) {
          const next = samplePresentation(continued, dt).poses.get(live.renderId)!;
          const original = samplePresentation(moving, at + dt).poses.get(live.renderId)!;
          closePath(posePath(next, next.rect)!, posePath(original, original.rect)!);
          expect(next.opacity).toBe(1);
        }
      }
    }
  });
});


describe("interrupted connector geometry", () => {
  it("keeps both ports attached when endpoints share residual timing but move different distances", () => {
    const base = sceneFor([A]), cover = base.tiles.get(entityId("tile", A, A))!;
    const child = bandTiles(base, A)[0] as Extract<SceneRecord, { kind: "tile" }>;
    const route = routesOf(base, A)[0] as Extract<SceneRecord, { kind: "route" }>;
    const id = entityId("route", A, "timing");
    const at = (head: number, tail: number, bend = 0): FolderScene => {
      const h = { ...cover, rect: { x: 0, y: head, width: 50, height: 40 } };
      const t = { ...child, rect: { x: 0, y: tail, width: 50, height: 40 } };
      const r = { ...route, id, rect: { x: 0, y: head, width: 100, height: tail - head + 10 }, route: { ...route.route,
        id: "timing", from: { kind: "node" as const, id: A }, to: { kind: "node" as const, id: child.tile.key },
        path: `M25 ${head + 40} C${25 + bend} ${head + 45} ${25 + bend} ${tail - 5} 25 ${tail}` } };
      return { ...base, records: new Map([[h.id, h], [t.id, t], [id, r]]), routes: new Map([[id, r]]), tiles: new Map([[h.id, h], [t.id, t]]) };
    };
    const a = at(50, 100), b = at(100, 200), c = at(100, 200, 25);
    const moving = step(staticPresentation(a), a, b, Infinity).presentation;
    const interrupted = step(moving, b, c, 40).presentation;
    for (const dt of [0, 20, 60, 100, 160]) {
      const poses = samplePresentation(interrupted, dt).poses;
      const routePose = poses.get(id)!, points = samplePathString(posePath(routePose, routePose.rect)!, 24)!;
      expect(points[0].y).toBeCloseTo(poses.get(cover.id)!.rect.y + 40, 6);
      expect(points.at(-1)!.y).toBeCloseTo(poses.get(child.id)!.rect.y, 6);
    }
  });

  it("preserves a displayed curve instead of substituting its cached target attachment", () => {
    const a = sceneFor([A, B]), b = sceneFor([A, B], { width: 900, previous: a.layout });
    const original = staticPresentation(a), source = [...original.live.values()].find(r => r.attachment)!;
    if (source.record.kind !== "route") throw new Error("expected route");
    const shape = routeShape(source.record.route.path, source.record.rect)!;
    const bent = shape.map((segment, i) => i === 1 ? segment.map((n, j) => j === 0 ? n + 12 : n) : segment);
    const track = retargetTrack({ ...source.initial, shape: bent }, { ...source.initial, shape })!;
    const moving = { ...original, duration: MOTION_MS, live: new Map(original.live).set(source.renderId, { ...source, track }) };
    const shown = samplePresentation(moving, 40).poses.get(source.renderId)!;
    const next = step(moving, a, b, 40).presentation;
    const first = samplePresentation(next, 0).poses.get(source.renderId)!;
    const from = samplePathString(posePath(shown, shown.rect)!, 48)!, to = samplePathString(posePath(first, first.rect)!, 48)!;
    for (let i = 0; i < from.length; i++) expect(Math.hypot(from[i].x - to[i].x, from[i].y - to[i].y)).toBeLessThan(.001);
  });
});

it('closing a shared-row band keeps retiring tiles out of the retained cover-attachment header', () => {
  const open = sceneFor([A, B]), closed = sceneFor([B], { previous: open.layout });
  const p = step(staticPresentation(open), open, closed, Infinity).presentation;
  const retirees = [...p.retiring.values()].filter(r => r.record.kind === 'tile' && r.record.graphId === A);
  const firstRow = Math.min(...bandTiles(open, A).map(r => r.rect.y));
  expect(retirees.length).toBeGreaterThan(0);
  for (const retiree of retirees) {
    const initial = samplePresentation(p, 0).poses.get(retiree.renderId)!;
    expect(effectiveClip(initial)).toBeNull();
    for (let at = 0; at < MOTION_MS; at += 4) {
      const pose = samplePresentation(p, at).poses.get(retiree.renderId)!;
      if (pose.opacity <= PAINTED) continue;
      const clip = effectiveClip(pose);
      expect(Math.max(pose.rect.y, clip?.y ?? -Infinity)).toBeGreaterThanOrEqual(firstRow - .001);
    }
  }
});
