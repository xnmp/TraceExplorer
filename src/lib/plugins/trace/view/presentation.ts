/**
 * The presentation model (docs/scene-transactions.md §2 "Presentation", §6): how a published
 * scene's records are displayed over one motion epoch. Pure and immutable: no DOM, timers or
 * Svelte. `scene-motion.ts` compiles a presentation into native effects; the renderers draw its
 * retiring records; the controller samples the displayed presentation and retargets it at every
 * spatial publication.
 *
 * Poses are in folder coordinates. A track is a list of pose frames on the epoch's clock, each
 * with the easing that interpolates to the next frame, so a track compiles to keyframes exactly
 * (per-keyframe easing, linear timing). Interrupting a track slices it: the sampled pose at time
 * zero, later frames shifted, and the current segment's remaining easing (Bézier subdivision),
 * so the continuation follows the original trajectory exactly.
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { Orientation } from "$lib/domain/trace-graph/layout";
import { endpointKey } from "$lib/domain/trace-graph/junctions";
import { pathTranslation, translatePath, type Point } from "$lib/domain/trace-graph/path-sampling";
import { entityId, type EntityId, type FolderScene, type GraphId, type SceneDiff, type SceneRecord } from "$lib/domain/trace-graph/folder-scene";
import { departureVisibility } from "./band-motion";

export type TransactionId = number;
export type RenderId = string;
export type Ease = "linear" | readonly [number, number, number, number];
export interface Pose {
  readonly rect: GridRect;
  /** Motion multiplier; settled = 1. */
  readonly opacity: number;
  /** Absolute folder-coordinate clip; null when unclipped. */
  readonly clip: GridRect | null;
}
export interface PoseFrame {
  /** Milliseconds within the common epoch. */
  readonly at: number;
  readonly pose: Pose;
  /** Interpolation to the next frame. */
  readonly easing: Ease;
}
export interface Track { readonly frames: readonly PoseFrame[] }
export interface PresentedRecord {
  readonly renderId: RenderId;
  /**
   * Live records: the scene record. Retirees: the record where it was displayed when it retired
   * (a moved connector's path moved with it), so a retiree is drawn at `record.rect` like any record.
   */
  readonly record: SceneRecord;
  readonly initial: Pose;
  readonly track: Track | null;
}
export interface RetiringRecord extends PresentedRecord {
  readonly sourceTransaction: TransactionId;
  /** The exit group whose fade and clip this record shares (it has no track of its own), or null. */
  readonly group: RenderId | null;
  readonly reason: "exit" | "old-route";
  /** Whether its graph showed a focus when it retired: a connector keeps the tone it was drawn with. */
  readonly branch: boolean;
}
export interface Presentation {
  readonly epoch: number;
  /** The common duration of the epoch's effects: its longest track. */
  readonly duration: number;
  readonly live: ReadonlyMap<RenderId, PresentedRecord>;
  readonly retiring: ReadonlyMap<RenderId, RetiringRecord>;
  /** Records with motion this epoch, and retirees. */
  readonly pinned: ReadonlySet<RenderId>;
}
/** The controller's only drawable state: one complete scene and how it is presented. */
export interface Publication {
  readonly transactionId: TransactionId;
  /** Increases only when a commit changes geometry; restyle commits and settlement keep it. */
  readonly geometryVersion: number;
  readonly scene: FolderScene;
  readonly presentation: Presentation;
}

export const MOTION_MS = 160;
export const EASE: Ease = [.2, .8, .2, 1];
/** Above this many paintable retiring records, a publication's departures snap. */
export const RETIREE_LIMIT = 200;
/** Opacity at or below which a record paints nothing. */
export const PAINTED = .01;
const NEAR = .01;

/**
 * The opacity window, in eased progress, in which arrivals appear (at the end of a motion) and
 * departures vanish (at its start): a connector is hidden while its endpoints are more than half
 * a CSS pixel from their places.
 */
export const routeFadeWindow = (distance: number): number => Math.min(.15, .5 / Math.max(1, Number.isFinite(distance) ? distance : 1));
/** How far a new tile slides in from: back along the flow, toward its parents. */
export const enterOffset = (orientation: Orientation): Point => orientation === "right" ? { x: -10, y: 0 } : { x: 0, y: -10 };

// ─── Easing ─────────────────────────────────────────────────────────────────

/** One coordinate of a unit cubic Bézier (end points 0 and 1) with control values `a`, `b`. */
const bezier = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
/** The curve parameter at which the (monotone) coordinate with control values `a`, `b` is `value`. */
function solve(a: number, b: number, value: number): number {
  let s = value;
  for (let i = 0; i < 8; i++) {
    const error = bezier(a, b, s) - value;
    if (Math.abs(error) < 1e-12) return s;
    const slope = 3 * a * (1 - s) * (1 - 3 * s) + 3 * b * s * (2 - 3 * s) + 3 * s * s;
    if (Math.abs(slope) < 1e-6) break;
    s -= error / slope;
    if (!(s >= 0 && s <= 1)) break;
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 64; i++) {
    s = (lo + hi) / 2;
    if (bezier(a, b, s) < value) lo = s; else hi = s;
  }
  return (lo + hi) / 2;
}

/** Eased progress at normalized time `v` (clamped to [0, 1]; NaN reads as 0). */
export function easeAt(ease: Ease, v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  if (ease === "linear") return v;
  return bezier(ease[1], ease[3], solve(ease[0], ease[2], v));
}

/** The normalized time at which eased progress reaches `progress` (the easing's progress must be monotone). */
export function easeTimeAt(ease: Ease, progress: number): number {
  if (!(progress > 0)) return 0;
  if (progress >= 1) return 1;
  if (ease === "linear") return progress;
  return bezier(ease[0], ease[2], solve(ease[1], ease[3], progress));
}

/**
 * The easing of the part of `ease` between normalized times `from` and `to`, normalized to its own
 * interval: `g(v) = (E(from + (to - from) v) - E(from)) / (E(to) - E(from))`. Computed by Bézier
 * subdivision, so it is exact. A part over which progress does not change is linear.
 */
export function sliceEase(ease: Ease, from: number, to: number): Ease {
  const a = Math.max(0, Math.min(1, from)), b = Math.max(0, Math.min(1, to));
  if (ease === "linear" || !(b > a)) return "linear";
  if (a === 0 && b === 1) return ease;
  const [x1, y1, x2, y2] = ease;
  const s0 = solve(x1, x2, a), s1 = solve(x1, x2, b);
  type Polygon = readonly [number, number, number, number];
  // De Casteljau at `t`: the left and right control polygons.
  const split = (p: Polygon, t: number): { left: Polygon; right: Polygon } => {
    const ab = p[0] + (p[1] - p[0]) * t, bc = p[1] + (p[2] - p[1]) * t, cd = p[2] + (p[3] - p[2]) * t;
    const abc = ab + (bc - ab) * t, bcd = bc + (cd - bc) * t, abcd = abc + (bcd - abc) * t;
    return { left: [p[0], ab, abc, abcd], right: [abcd, bcd, cd, p[3]] };
  };
  // [0, s1], then its part from s0 / s1: the curve between s0 and s1.
  const part = (p: Polygon): Polygon => split(split(p, s1).left, s0 / s1).right;
  const xs = part([0, x1, x2, 1]), ys = part([0, y1, y2, 1]);
  const dx = xs[3] - xs[0], dy = ys[3] - ys[0];
  if (!(Math.abs(dx) > 1e-12) || !(Math.abs(dy) > 1e-12)) return "linear";
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return [clamp((xs[1] - xs[0]) / dx), (ys[1] - ys[0]) / dy, clamp((xs[2] - xs[0]) / dx), (ys[2] - ys[0]) / dy];
}

export const sameEase = (a: Ease, b: Ease): boolean =>
  a === b || (a !== "linear" && b !== "linear" && a.every((value, i) => Math.abs(value - b[i]) < 1e-6));

// ─── Poses and tracks ───────────────────────────────────────────────────────

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mixRect = (a: GridRect, b: GridRect, k: number): GridRect =>
  ({ x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), width: mix(a.width, b.width, k), height: mix(a.height, b.height, k) });
const sameRect = (a: GridRect, b: GridRect, near = NEAR) =>
  Math.abs(a.x - b.x) <= near && Math.abs(a.y - b.y) <= near && Math.abs(a.width - b.width) <= near && Math.abs(a.height - b.height) <= near;
const contains = (outer: GridRect, inner: GridRect) =>
  outer.x <= inner.x + NEAR && outer.y <= inner.y + NEAR && outer.x + outer.width >= inner.x + inner.width - NEAR && outer.y + outer.height >= inner.y + inner.height - NEAR;
const translate = (rect: GridRect, by: Point): GridRect => ({ ...rect, x: rect.x + by.x, y: rect.y + by.y });
function intersect(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a || !b) return a ?? b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
const displacement = (pose: Pose, base: GridRect): Point => ({ x: pose.rect.x - base.x, y: pose.rect.y - base.y });

/** A clip that leaves the whole rect visible is no clip. */
export const effectiveClip = (pose: Pose): GridRect | null => pose.clip && !contains(pose.clip, pose.rect) ? pose.clip : null;

export function mixPose(a: Pose, b: Pose, k: number): Pose {
  const clip = a.clip && b.clip ? mixRect(a.clip, b.clip, k) : k >= 1 ? b.clip : a.clip;
  return { rect: mixRect(a.rect, b.rect, k), opacity: mix(a.opacity, b.opacity, k), clip };
}

export function samePose(a: Pose, b: Pose): boolean {
  const ca = effectiveClip(a), cb = effectiveClip(b);
  return sameRect(a.rect, b.rect) && Math.abs(a.opacity - b.opacity) <= .001 && (ca === null ? cb === null : cb !== null && sameRect(ca, cb));
}

export const settledPose = (record: SceneRecord): Pose => ({ rect: record.rect, opacity: 1, clip: null });
export const trackEnd = (track: Track): number => track.frames[track.frames.length - 1].at;
export const finalPose = (track: Track): Pose => track.frames[track.frames.length - 1].pose;

/** A track's pose at epoch time `at` (before it, its first pose; after it, its last). */
export function sampleTrack(track: Track, at: number): Pose {
  const { frames } = track;
  if (!(at > frames[0].at)) return frames[0].pose;
  const last = frames[frames.length - 1];
  if (at >= last.at) return last.pose;
  let i = 0;
  while (frames[i + 1].at <= at) i++;
  const a = frames[i], b = frames[i + 1];
  return mixPose(a.pose, b.pose, easeAt(a.easing, (at - a.at) / (b.at - a.at)));
}

/**
 * What remains of `track` from epoch time `at`, on a clock restarted there: the sampled pose at
 * zero with the current segment's remaining easing, later frames shifted by `at`. Null once the
 * track has finished (or `at` is not a time).
 */
export function sliceTrack(track: Track, at: number): Track | null {
  if (Number.isNaN(at) || at >= trackEnd(track)) return null;
  const { frames } = track;
  if (at <= frames[0].at) return at === 0 ? track : { frames: frames.map((frame) => ({ ...frame, at: frame.at - at })) };
  let i = 0;
  while (frames[i + 1].at <= at) i++;
  const a = frames[i], b = frames[i + 1], u = (at - a.at) / (b.at - a.at);
  const first: PoseFrame = { at: 0, pose: sampleTrack(track, at), easing: sliceEase(a.easing, u, 1) };
  return { frames: [first, ...frames.slice(i + 1).map((frame) => ({ ...frame, at: frame.at - at }))] };
}

/** Clips on every pose or none, so interpolation never switches between clipped and unclipped. */
function withClips(poses: readonly Pose[]): Pose[] {
  if (poses.every((pose) => effectiveClip(pose) === null)) return poses.map((pose) => pose.clip ? { ...pose, clip: null } : pose);
  return poses.map((pose) => pose.clip ? pose : { ...pose, clip: pose.rect });
}

/** From `from` to `to` over `duration` with `easing`; null when there is nothing to move or no time to move in. */
export function retargetTrack(from: Pose, to: Pose, duration = MOTION_MS, easing: Ease = EASE): Track | null {
  if (!(duration > 0) || samePose(from, to)) return null;
  const [a, b] = withClips([from, to]);
  return { frames: [{ at: 0, pose: a, easing }, { at: duration, pose: b, easing: "linear" }] };
}

/**
 * Frames at eased-progress stops of one `EASE` motion over `duration`: `[progress, pose]` pairs
 * in order from 0 to 1. Each segment's easing is the part of `EASE` it spans, so poses that are
 * linear in eased progress between stops (as keyframe offsets under a timing easing would be)
 * are exact.
 */
function easedFrames(stops: readonly (readonly [number, Pose])[], duration: number): Track | null {
  if (!(duration > 0) || stops.length < 2) return null;
  const poses = withClips(stops.map(([, pose]) => pose));
  const times = stops.map(([progress]) => easeTimeAt(EASE, progress));
  const frames: PoseFrame[] = [];
  for (let i = 0; i < stops.length; i++) {
    const last = i === stops.length - 1;
    if (!last && i > 0 && times[i] <= times[i - 1] + 1e-9) continue;
    if (last && frames.length && times[i] <= frames[frames.length - 1].at / duration + 1e-9) frames.pop();
    const from = times[i];
    frames.push({ at: from * duration, pose: poses[i], easing: "linear" });
  }
  for (let i = 0; i < frames.length - 1; i++) frames[i] = { ...frames[i], easing: sliceEase(EASE, frames[i].at / duration, frames[i + 1].at / duration) };
  if (frames.length < 2 || frames.every((frame) => samePose(frame.pose, frames[0].pose))) return null;
  return { frames };
}

/** Appears in the arrival window `w` at the end of a motion from `from` to `to`. */
const arrival = (from: Pose, to: Pose, w: number, duration = MOTION_MS): Track | null => {
  const start = { ...from, opacity: 0 };
  return easedFrames([[0, start], [1 - w, { ...mixPose(start, to, 1 - w), opacity: 0 }], [1, to]], duration);
};
/** Vanishes in place in the departure window `w` at the start of a motion. */
const departure = (from: Pose, w: number, duration = MOTION_MS): Track | null =>
  easedFrames([[0, from], [w, { ...from, opacity: 0 }], [1, { ...from, opacity: 0 }]], duration);

// ─── Presentations ──────────────────────────────────────────────────────────

const settled = (record: SceneRecord): PresentedRecord => ({ renderId: record.id, record, initial: settledPose(record), track: null });

function presentation(epoch: number, live: ReadonlyMap<RenderId, PresentedRecord>, retiring: ReadonlyMap<RenderId, RetiringRecord> = new Map()): Presentation {
  let duration = 0;
  const pinned = new Set<RenderId>();
  for (const record of live.values()) if (record.track) { duration = Math.max(duration, trackEnd(record.track)); pinned.add(record.renderId); }
  for (const record of retiring.values()) {
    if (record.track) duration = Math.max(duration, trackEnd(record.track));
    pinned.add(record.renderId);
  }
  return { epoch, duration, live, retiring, pinned };
}

/** Every record at its target pose, nothing retiring: a snapped presentation. */
export function staticPresentation(scene: FolderScene, epoch = 0): Presentation {
  const live = new Map<RenderId, PresentedRecord>();
  for (const [id, record] of scene.records) live.set(id, settled(record));
  return presentation(epoch, live);
}

/** The same epoch once its motion has finished: every live record at its target, no retirees. */
export function settledPresentation(current: Presentation): Presentation {
  const live = new Map<RenderId, PresentedRecord>();
  for (const [id, presented] of current.live) live.set(id, presented.track ? settled(presented.record) : presented);
  return presentation(current.epoch, live);
}

/** A restyle: `scene`'s records (same geometry) with the running epoch's tracks and retirees kept. */
export function restylePresentation(current: Presentation, scene: FolderScene): Presentation {
  const live = new Map<RenderId, PresentedRecord>();
  for (const [id, record] of scene.records) {
    const was = current.live.get(id);
    live.set(id, was ? { ...was, record } : settled(record));
  }
  return { ...presentation(current.epoch, live, current.retiring), duration: current.duration };
}

/** Whether a presentation moves anything (it has an epoch to run). */
export const hasMotion = (current: Presentation): boolean => current.duration > 0;

export interface DisplayedPresentation {
  readonly presentation: Presentation;
  /** The epoch time sampled; Infinity once the epoch has settled. */
  readonly at: number;
  /** Every live and retiring record's displayed pose, an exit group's fade and clip composed into its members. */
  readonly poses: ReadonlyMap<RenderId, Pose>;
}

const poseAt = (presented: PresentedRecord, at: number): Pose => presented.track ? sampleTrack(presented.track, at) : presented.initial;

/** What `presentation` displays at epoch time `at`. */
export function samplePresentation(current: Presentation, at: number): DisplayedPresentation {
  const poses = new Map<RenderId, Pose>();
  for (const [id, presented] of current.live) poses.set(id, poseAt(presented, at));
  for (const [id, retiree] of current.retiring) if (retiree.group === null) poses.set(id, poseAt(retiree, at));
  for (const [id, retiree] of current.retiring) {
    if (retiree.group === null) continue;
    const own = poseAt(retiree, at), group = poses.get(retiree.group);
    poses.set(id, group ? { rect: own.rect, opacity: own.opacity * group.opacity, clip: intersect(own.clip, group.clip) } : { ...own, opacity: 0 });
  }
  return { presentation: current, at, poses };
}

/** The cover record that frames a band record: its graph's section moves with the cover's row. */
export const coverOf = (record: SceneRecord): EntityId | null =>
  record.graphId !== null && record.kind !== "row" && !(record.kind === "tile" && record.cover) ? entityId("tile", record.graphId, record.graphId) : null;

/**
 * Whether `track` (positioning a band record at `base`) moves exactly with its section, which
 * follows its cover's vertical motion (`frame`, positioning the cover at `frameBase`), so it needs
 * no motion of its own: in its section it stays still and fully shown.
 */
export function ridesWithSection(track: Track | null, base: GridRect, frame: Track | null, frameBase: GridRect): boolean {
  const unchanged = (pose: Pose, at: GridRect) => Math.abs(pose.opacity - 1) <= .001 && effectiveClip(pose) === null
    && Math.abs(pose.rect.width - at.width) <= NEAR && Math.abs(pose.rect.height - at.height) <= NEAR;
  const still = (t: Track | null, at: GridRect, axes: "y" | "xy") => !t || t.frames.every((f) => {
    const d = displacement(f.pose, at);
    return Math.abs(d.y) <= NEAR && (axes === "y" || Math.abs(d.x) <= NEAR) && (axes === "y" || unchanged(f.pose, at));
  });
  if (!frame || still(frame, frameBase, "y")) return still(track, base, "xy");
  if (!track || track.frames.length !== frame.frames.length) return false;
  return track.frames.every((f, i) => {
    const g = frame.frames[i], d = displacement(f.pose, base);
    return Math.abs(f.at - g.at) <= 1e-6 && sameEase(f.easing, g.easing) && Math.abs(d.x) <= NEAR
      && Math.abs(d.y - (g.pose.rect.y - frameBase.y)) <= NEAR && unchanged(f.pose, base);
  });
}

/** Whether two tracks displace their records identically at every instant (a missing track stays still). */
function parallel(a: Track | null, aBase: GridRect, b: Track | null, bBase: GridRect): boolean {
  if (!a || !b) {
    const [moving, base] = a ? [a, aBase] : [b, bBase];
    return !moving || moving.frames.every((f) => { const d = displacement(f.pose, base); return Math.hypot(d.x, d.y) <= NEAR; });
  }
  if (a.frames.length !== b.frames.length) return false;
  return a.frames.every((f, i) => {
    const g = b.frames[i], da = displacement(f.pose, aBase), db = displacement(g.pose, bBase);
    return Math.abs(f.at - g.at) <= 1e-6 && sameEase(f.easing, g.easing) && Math.hypot(da.x - db.x, da.y - db.y) <= NEAR;
  });
}

/** The same motion carried by another record: `track`'s displacement of `from` applied to `to`. */
function carry(track: Track, from: GridRect, to: GridRect): Track {
  return { frames: track.frames.map((frame) => {
    const rect = translate(to, displacement(frame.pose, from));
    // An explicit clip equal to the carrier's box means unclipped; any other clip is an absolute region.
    const clip = frame.pose.clip ? (sameRect(frame.pose.clip, frame.pose.rect) ? rect : frame.pose.clip) : null;
    return { ...frame, pose: { rect, opacity: frame.pose.opacity, clip } };
  }) };
}

/** `track`'s opacity over time for a record that stays at `rect`: it appears or vanishes exactly with the track's record. */
function withOpacityOf(track: Track, rect: GridRect): Track | null {
  const frames = track.frames.map((frame) => ({ ...frame, pose: { rect, opacity: frame.pose.opacity, clip: null } }));
  return frames.every((frame) => samePose(frame.pose, frames[0].pose)) ? null : { frames };
}

/** A retired record as displayed: moved to where its pose shows it (a connector's path and a junction with it). */
function displaced(record: SceneRecord, pose: Pose): SceneRecord {
  const shift = displacement(pose, record.rect);
  if (Math.hypot(shift.x, shift.y) <= 1e-9) return record;
  const rect = translate(record.rect, shift);
  switch (record.kind) {
    case "route": return { ...record, rect, route: { ...record.route, path: translatePath(record.route.path, shift) ?? record.route.path } };
    case "junction": return { ...record, rect, junction: { ...record.junction, x: record.junction.x + shift.x, y: record.junction.y + shift.y } };
    default: return { ...record, rect };
  }
}

export interface Participants {
  readonly transaction: TransactionId;
  readonly epoch: number;
  /** Records that may move (null or absent: every record). The others take their target pose. */
  readonly records?: ReadonlySet<EntityId> | null;
  /** Reduced motion: target poses only. */
  readonly reduced?: boolean;
}

const retireId = (transaction: TransactionId, variant: string, id: EntityId): RenderId => JSON.stringify(["retire", transaction, variant, id]);
const isBandRecord = (record: SceneRecord) => record.kind === "route" || record.kind === "junction" || (record.kind === "tile" && !record.cover);

/**
 * The presentation of `next` continuing from what is displayed (`displayed`, sampled before
 * `next` renders), following `diff`'s policy:
 *
 * - Changed destinations move from their displayed pose over `MOTION_MS`. Unchanged destinations
 *   with motion still running keep it exactly (their tracks are sliced at the sample time).
 * - Snapped records (a reveal and what it alone displaces) and non-participants take their target.
 * - Entering band tiles slide in and, with their connectors, appear in their band's arrival window
 *   at the end of the motion; a record that reappears while it is still retiring takes over the
 *   retiree's displayed pose instead (reopening), and the retiree is dropped.
 * - Connectors whose endpoints move rigidly with them travel along; rerouted ones crossfade
 *   between their exact displayed and new paths (a path is never interpolated).
 * - A closed stack's displayed tiles and connectors retire as one exit group: they fade together
 *   while a clip reclaims the band from its displayed extent, the fade ending before the clip
 *   reaches any displayed tile or port. Departures inside an open band vanish in its departure
 *   window. Above `RETIREE_LIMIT` paintable retirees, this publication's departures snap. A
 *   reveal drops its graphs' retirees.
 * - No previous presentation, scope changes and reduced motion present target poses only.
 */
export function retargetPresentation(displayed: DisplayedPresentation | null, next: FolderScene, diff: SceneDiff, participants: Participants): Presentation {
  const { epoch, transaction } = participants;
  if (!displayed || diff.policy.reset || participants.reduced) return staticPresentation(next, epoch);
  const at = displayed.at, before = displayed.presentation, shown = displayed.poses;
  const D = MOTION_MS;
  const moves = (id: EntityId) => !participants.records || participants.records.has(id);
  const reveal = new Set([...diff.policy.graphs].filter(([, change]) => change === "reveal").map(([id]) => id));
  const policyOf = (id: EntityId) => diff.policy.records.get(id) ?? "carry";
  // A reveal snaps its graphs whole: their running motion ends and their records take their targets.
  const revealed = (id: EntityId) => { const graphId = next.records.get(id)?.graphId; return graphId !== undefined && graphId !== null && reveal.has(graphId); };
  const still = (id: EntityId) => policyOf(id) === "snap" || !moves(id) || revealed(id);
  const shownOpacity = (id: RenderId) => shown.get(id)?.opacity ?? 0;
  // Graphs that were drawn with a focus (their connectors' branch tone).
  const focused = new Set<GraphId>();
  for (const { record } of before.live.values()) if (record.kind === "tile" && record.graphId !== null && record.tile.tone !== "neutral") focused.add(record.graphId);
  const branch = (graphId: GraphId | null) => graphId !== null && focused.has(graphId);

  // Reopening: an entering record takes over the displayed retiree of its identity (exits only).
  const takeovers = new Map<EntityId, RetiringRecord>();
  for (const retiree of before.retiring.values()) {
    if (retiree.reason !== "exit" || retiree.record.kind === "band") continue;
    if (shownOpacity(retiree.renderId) > PAINTED) takeovers.set(retiree.record.id, retiree);
  }
  const consumed = new Set<RenderId>();
  for (const id of next.records.keys()) {
    const retiree = before.live.has(id) ? undefined : takeovers.get(id);
    if (retiree) consumed.add(retiree.renderId);
  }

  // 1. Where every record starts: its displayed pose (retained), a retiree's (reopened), or its entrance.
  const start = new Map<EntityId, Pose>();
  const orientationOf = (graphId: GraphId | null) => graphId !== null ? next.graphs.get(graphId)?.layout.orientation ?? "down" : "down";
  for (const [id, record] of next.records) {
    const target = settledPose(record);
    if (still(id)) { start.set(id, target); continue; }
    if (before.live.has(id)) { start.set(id, shown.get(id) ?? target); continue; }
    const retiree = takeovers.get(id);
    if (retiree) start.set(id, shown.get(retiree.renderId)!);
    else if (record.kind === "tile" && !record.cover) start.set(id, { ...target, rect: translate(record.rect, enterOffset(orientationOf(record.graphId))), opacity: 0 });
    else if (record.kind === "row") start.set(id, { ...target, rect: { ...record.rect, height: 0 } });
    else if (record.kind === "route" || record.kind === "junction") start.set(id, { ...target, opacity: 0 });
    else start.set(id, target);
  }
  // Band positions are compared within each band's section, which moves with its cover's row.
  const sectionShift = (record: SceneRecord): Point => {
    const cover = coverOf(record), base = cover ? next.records.get(cover) : undefined;
    return base ? { x: 0, y: start.get(base.id)!.rect.y - base.rect.y } : { x: 0, y: 0 };
  };
  const relative = (record: SceneRecord, pose: Pose): Point => {
    const d = displacement(pose, record.rect), section = sectionShift(record);
    return { x: d.x - section.x, y: d.y - section.y };
  };

  // 2. Each band's opacity window, from how far its tiles travel within it.
  const windows = new Map<GraphId, number>();
  for (const [id, graph] of next.graphs) {
    let distance = 0;
    for (const key of graph.plan.tiles.keys()) {
      const record = next.records.get(entityId("tile", id, key));
      if (!record || record.kind !== "tile" || record.cover) continue;
      const d = relative(record, start.get(record.id)!);
      distance = Math.max(distance, Math.hypot(d.x, d.y));
    }
    windows.set(id, routeFadeWindow(distance));
  }
  const windowOf = (graphId: GraphId | null) => (graphId !== null ? windows.get(graphId) : undefined) ?? routeFadeWindow(0);

  // 3. Tracks for everything but connectors.
  const tracks = new Map<EntityId, Track | null>();
  /** The running track, sliced, when it still heads for `target`; undefined otherwise. */
  const continued = (id: EntityId, target: Pose): Track | null | undefined => {
    const was = before.live.get(id);
    if (!was?.track || !samePose(finalPose(was.track), target)) return undefined;
    return sliceTrack(was.track, at);
  };
  const move = (record: SceneRecord, from: Pose, target: Pose): Track | null => {
    if (record.kind === "band" || samePose(from, target)) return null;
    // Cells, covers and rows only move (entering ones appear at once; rows grow from their top).
    if (record.kind === "row" || record.kind === "entry" || (record.kind === "tile" && record.cover)) return retargetTrack({ rect: from.rect, opacity: 1, clip: null }, target, D);
    if (from.opacity <= PAINTED) return arrival(from, target, windowOf(record.graphId), D);
    return retargetTrack(from, target, D);
  };
  for (const [id, record] of next.records) {
    if (record.kind === "route") continue;
    if (still(id)) { tracks.set(id, null); continue; }
    const target = settledPose(record), kept = continued(id, target);
    tracks.set(id, kept !== undefined ? kept : move(record, start.get(id)!, target));
  }

  // 4. Connectors: travel with endpoints that move rigidly with them, else crossfade exact paths.
  const fresh: RetiringRecord[] = [];
  const endpoint = (graphId: GraphId, end: string): SceneRecord | undefined => {
    const colon = end.indexOf(":"), kind = end.slice(0, colon), local = end.slice(colon + 1);
    return next.records.get(kind === "junction" ? entityId("junction", graphId, local) : entityId("tile", graphId, local));
  };
  for (const [id, record] of next.records) {
    if (record.kind !== "route") continue;
    if (still(id)) { tracks.set(id, null); continue; }
    const target = settledPose(record);
    // A connector to or from a tile that is still arriving appears exactly with it (one opacity interval).
    const arriving = [endpoint(record.graphId!, endpointKey(record.route.to)), endpoint(record.graphId!, endpointKey(record.route.from))]
      .find((tile) => tile?.kind === "tile" && !tile.cover && start.get(tile.id)!.opacity <= PAINTED && tracks.get(tile.id));
    if (arriving) { tracks.set(id, withOpacityOf(tracks.get(arriving.id)!, record.rect)); continue; }
    const kept = continued(id, target);
    if (kept !== undefined) { tracks.set(id, kept); continue; }
    const was = before.live.get(id), source = was ?? takeovers.get(id);
    const pose = source ? shown.get(source.renderId) : undefined;
    const w = windowOf(record.graphId);
    if (!source || !pose || pose.opacity <= PAINTED) { tracks.set(id, arrival({ ...target, opacity: 0 }, target, w, D)); continue; }
    const from = displaced(source.record, pose);
    const shift = from.kind === "route" ? pathTranslation(record.route.path, from.route.path) : null;
    const graphId = record.graphId!;
    const fromKey = endpointKey(record.route.from), toKey = endpointKey(record.route.to);
    const head = endpoint(graphId, fromKey), tail = endpoint(graphId, toKey);
    const headTrack = head ? tracks.get(head.id) ?? null : null;
    const headStart = head ? start.get(head.id) : undefined;
    const headShift = head && headStart ? displacement(headStart, head.rect) : null;
    let compatible = !!shift && !!head && !!tail && !!headShift && !!headStart
      && parallel(tracks.get(tail.id) ?? null, tail.rect, headTrack, head.rect)
      && Math.hypot(headShift.x - shift.x, headShift.y - shift.y) <= NEAR
      && Math.abs(headStart.opacity - pose.opacity) <= NEAR;
    // A trunk (one source's shared stem) moves rigidly only when its whole band does.
    if (compatible && fromKey === toKey) for (const key of next.graphs.get(graphId)?.plan.tiles.keys() ?? []) {
      const tile = next.records.get(entityId("tile", graphId, key));
      if (tile && !parallel(tracks.get(tile.id) ?? null, tile.rect, headTrack, head!.rect)) { compatible = false; break; }
    }
    if (compatible) {
      tracks.set(id, headTrack ? carry(headTrack, head!.rect, record.rect) : retargetTrack(pose, target, D));
      continue;
    }
    // The displayed path fades out at the start of the motion; the new one arrives at its end.
    const old = departure({ ...pose, rect: from.rect }, w, D);
    if (old) fresh.push({ renderId: retireId(transaction, "old-route", id), record: from, initial: old.frames[0].pose, track: old,
      sourceTransaction: transaction, group: null, reason: "old-route", branch: branch(record.graphId) });
    tracks.set(id, arrival({ ...target, opacity: 0 }, target, w, D));
  }

  const live = new Map<RenderId, PresentedRecord>();
  for (const [id, record] of next.records) {
    const track = tracks.get(id) ?? null;
    live.set(id, { renderId: id, record, initial: track ? track.frames[0].pose : settledPose(record), track });
  }

  // 5. Retirees. Running ones continue while they still paint; a reveal drops its graphs'.
  const retiring = new Map<RenderId, RetiringRecord>();
  const dropped = (retiree: RetiringRecord) => consumed.has(retiree.renderId) || shownOpacity(retiree.renderId) <= PAINTED
    || (retiree.record.graphId !== null && reveal.has(retiree.record.graphId));
  for (const retiree of before.retiring.values()) {
    if (retiree.group !== null || dropped(retiree)) continue;
    const track = retiree.track ? sliceTrack(retiree.track, at) : null;
    if (track) retiring.set(retiree.renderId, { ...retiree, initial: track.frames[0].pose, track });
  }
  for (const retiree of before.retiring.values()) if (retiree.group !== null && retiring.has(retiree.group) && !dropped(retiree)) retiring.set(retiree.renderId, retiree);
  for (const [id, retiree] of retiring) if (retiree.record.kind === "band" && ![...retiring.values()].some((member) => member.group === id)) retiring.delete(id);
  let carried = 0;
  for (const retiree of retiring.values()) if (retiree.record.kind !== "band") carried++;

  // This publication's exits, by graph.
  const exits = new Map<GraphId, SceneRecord[]>();
  for (const [id, record] of diff.exit) {
    if (still(id) || record.graphId === null || reveal.has(record.graphId) || !(isBandRecord(record) || record.kind === "band") || !before.live.has(id)) continue;
    exits.set(record.graphId, [...exits.get(record.graphId) ?? [], record]);
  }
  for (const [graphId, records] of exits) {
    const w = windowOf(graphId);
    if (next.graphs.has(graphId)) {
      // Inside an open band: vanish in place in the departure window, when the band around them
      // moves rigidly (a band that reflows around them drops them at once).
      const tiles = [...next.graphs.get(graphId)!.plan.tiles.keys()].flatMap((key) => {
        const tile = next.records.get(entityId("tile", graphId, key));
        return tile && tile.kind === "tile" && !tile.cover && before.live.has(tile.id) ? [tile] : [];
      });
      const [first] = tiles;
      if (!tiles.every((tile) => parallel(tracks.get(tile.id) ?? null, tile.rect, tracks.get(first.id) ?? null, first.rect))) continue;
      for (const record of records) {
        const pose = shown.get(record.id);
        if (record.kind === "band" || !pose || pose.opacity <= PAINTED) continue;
        const track = departure(pose, w, D);
        if (track) fresh.push({ renderId: retireId(transaction, "exit", record.id), record: displaced(record, pose), initial: track.frames[0].pose, track,
          sourceTransaction: transaction, group: null, reason: "exit", branch: branch(graphId) });
      }
      continue;
    }
    // A closed stack: its displayed band retires as one group spanning its section.
    const members = records.flatMap((record) => {
      const pose = shown.get(record.id);
      return record.kind !== "band" && pose && pose.opacity > PAINTED ? [{ record, pose }] : [];
    });
    if (!members.length) continue;
    const coverId = entityId("tile", graphId, graphId), cover = before.live.get(coverId);
    const band = records.find((record) => record.kind === "band");
    const top = cover ? (shown.get(coverId)?.rect.y ?? cover.record.rect.y) : Math.min(...members.map(({ pose }) => pose.rect.y));
    // The band as displayed: its tiles may still be travelling apart from their cover (a shared band row reflowing).
    const tileShifts = members.flatMap(({ record, pose }) => record.kind === "tile" ? [pose.rect.y - record.rect.y] : []);
    const bandShift = tileShifts.length ? Math.max(...tileShifts) - (top - (cover?.record.rect.y ?? top)) : 0;
    const bandBottom = band && cover ? top + band.rect.y + band.rect.height - cover.record.rect.y + bandShift : -Infinity;
    const bottom = Math.max(bandBottom, ...members.map(({ pose }) => pose.rect.y + pose.rect.height));
    const left = Math.min(0, ...members.map(({ pose }) => pose.rect.x));
    const right = Math.max(next.bounds.width, ...members.map(({ pose }) => pose.rect.x + pose.rect.width));
    const container: GridRect = { x: left, y: top, width: right - left, height: Math.max(0, bottom - top) };
    // A group still clipped (an interrupted reopening) closes from its displayed extent.
    const clips = members.map(({ pose }) => effectiveClip(pose));
    const extent = Math.min(container.height, clips.every((clip) => clip !== null) ? Math.max(...clips.map((clip) => clip!.y + clip!.height)) - top : container.height);
    const lastPort = Math.max(...members.map(({ pose }) => {
      const clip = effectiveClip(pose);
      return Math.min(pose.rect.y + pose.rect.height, clip ? clip.y + clip.height : Infinity);
    })) - top;
    const gone = departureVisibility(extent, 0, lastPort);
    if (!(gone > 0) || !(extent > 0)) continue;
    const clipTo = (height: number): GridRect => ({ ...container, height: Math.max(0, height) });
    const groupTrack = easedFrames([
      [0, { rect: container, opacity: 1, clip: clipTo(extent) }],
      [gone, { rect: container, opacity: 0, clip: clipTo(extent * (1 - gone)) }],
      [1, { rect: container, opacity: 0, clip: clipTo(0) }],
    ], D);
    if (!groupTrack) continue;
    const bandId = band?.id ?? entityId("band", graphId, graphId);
    const groupId = retireId(transaction, "exit", bandId);
    const groupRecord: SceneRecord = band ? { ...band, rect: container }
      : { kind: "band", id: bandId, graphId, rect: container, band: { id: graphId, row: 0, ...container } };
    fresh.push({ renderId: groupId, record: groupRecord, initial: groupTrack.frames[0].pose, track: groupTrack, sourceTransaction: transaction, group: null, reason: "exit", branch: branch(graphId) });
    for (const { record, pose } of members) {
      const member = displaced(record, pose);
      fresh.push({ renderId: retireId(transaction, "exit", record.id), record: member, initial: { rect: member.rect, opacity: pose.opacity, clip: null }, track: null,
        sourceTransaction: transaction, group: groupId, reason: "exit", branch: branch(graphId) });
    }
  }
  if (carried + fresh.filter((retiree) => retiree.record.kind !== "band").length <= RETIREE_LIMIT) for (const retiree of fresh) retiring.set(retiree.renderId, retiree);
  return presentation(epoch, live, retiring);
}
