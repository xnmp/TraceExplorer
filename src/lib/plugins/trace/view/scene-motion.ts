/**
 * The native motion driver (docs/scene-transactions.md §6): compiles one publication's
 * presentation into Web Animations on one clock.
 *
 * - Every effect of an epoch is created synchronously in `start`, with the epoch's common
 *   duration (shorter tracks hold their final values), so they share one start time. The first
 *   created animation is the epoch clock; a sample reads its `currentTime` once. No start time is
 *   ever assigned: the browser resolves readiness, and until then each element shows its first
 *   pose inline (written under an ownership token, cleared on ready, finish or cancel).
 * - Effects apply to registered render handles (`render-handles.ts`). Band records move inside
 *   their stack's section, which follows the cover's vertical motion, so they compile relative to
 *   it; a record moving exactly with its section gets no effect.
 * - The driver cancels only what it owns, never CSS transitions on cards.
 * - DOM reads: the grid's screen origin and zoom (camera compensation, when scrolling was clamped
 *   by the new layout; the viewport in folder coordinates, which selects motion participants) and, at an interruption, one modelled moving HTML element as a
 *   compositor-progress probe (WebKit can display more progress than the main-thread clock
 *   reports after a stall). Nothing else is measured.
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { Point } from "$lib/domain/trace-graph/path-sampling";
import { EASE, easeAt, sameEase, samplePresentation, sampleTrack, samePose, sliceEase, trackEnd, type DisplayedPresentation, type Ease, type Pose, type Presentation, type Track } from "./presentation";
import { presentationView, ridesSection, sectionFrame, type SectionFrame } from "./presentation-view";
import { prefersReducedMotion, zoomOf } from "./motion";
import { GRID, layerKey, sectionKey, type RenderHandles } from "./render-handles";
import type { SceneMotion } from "./scene-controller.svelte";

// ─── Compilation (pure) ─────────────────────────────────────────────────────

export interface CompiledFrame {
  /** Epoch time. */
  readonly at: number;
  /** Displacement from the element's laid-out box, less its frame's. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  /** Clip in the element's own box coordinates, or null. */
  readonly clip: GridRect | null;
  /** Interpolation to the next frame. */
  readonly easing: Ease;
}

/** A frame the element moves in: `track` displaces it from `base`; `x` false when it follows only the frame's vertical motion. */
export interface MotionFrame { readonly track: Track | null; readonly base: GridRect; readonly x: boolean }

/** Where a record and its frame ease differently, linear sub-steps keep within this of both (CSS px, opacity). */
const TOLERANCE = { px: .1, opacity: .002 };
const MAX_DEPTH = 7;
const EPS = 1e-6;

/** The easing of `track` over [a, b], or null where it holds still there. */
function easingOver(track: Track, a: number, b: number): Ease | null {
  const { frames } = track;
  if (a >= trackEnd(track) - EPS || b <= frames[0].at + EPS) return null;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].at <= a + EPS) i++;
  const from = frames[i], to = frames[i + 1], length = to.at - from.at;
  if (samePose(from.pose, to.pose) || !(length > 0)) return null;
  return sliceEase(from.easing, (a - from.at) / length, (b - from.at) / length);
}

/**
 * `track` (positioning an element laid out at `base`) as keyframe poses on the epoch clock,
 * relative to `frame`, ending at `duration`. Exact where the record and its frame share easing
 * (or one holds still); elsewhere linear sub-steps follow both.
 */
export function compileTrack(track: Track, base: GridRect, frame: MotionFrame | null, duration: number): CompiledFrame[] {
  const moving = frame?.track ?? null;
  const at = (time: number, easing: Ease = "linear"): CompiledFrame => {
    const pose = sampleTrack(track, time);
    const shift = frame ? displacement(moving ? sampleTrack(moving, time) : null, frame.base) : { x: 0, y: 0 };
    const clip = pose.clip ? { x: pose.clip.x - pose.rect.x, y: pose.clip.y - pose.rect.y, width: pose.clip.width, height: pose.clip.height } : null;
    return { at: time, dx: pose.rect.x - base.x - (frame?.x ? shift.x : 0), dy: pose.rect.y - base.y - shift.y,
      width: pose.rect.width, height: pose.rect.height, opacity: pose.opacity, clip, easing };
  };
  /** Times inside (a, b) where linear interpolation between compiled frames would stray from the motion. */
  const refine = (a: CompiledFrame, b: CompiledFrame, depth: number): CompiledFrame[] => {
    if (depth >= MAX_DEPTH) return [];
    const strays = [.25, .5, .75].some((k) => {
      const exact = at(a.at + (b.at - a.at) * k), mix = (key: "dx" | "dy" | "width" | "height" | "opacity") => a[key] + (b[key] - a[key]) * k;
      return Math.abs(exact.dx - mix("dx")) > TOLERANCE.px || Math.abs(exact.dy - mix("dy")) > TOLERANCE.px
        || Math.abs(exact.width - mix("width")) > TOLERANCE.px || Math.abs(exact.height - mix("height")) > TOLERANCE.px
        || Math.abs(exact.opacity - mix("opacity")) > TOLERANCE.opacity;
    });
    if (!strays) return [];
    const middle = at((a.at + b.at) / 2);
    return [...refine(a, middle, depth + 1), middle, ...refine(middle, b, depth + 1)];
  };
  const times = [...new Set([...track.frames.map((f) => f.at), ...(moving ? moving.frames.map((f) => f.at) : [])])]
    .filter((t) => t >= 0 && t <= duration + EPS).sort((a, b) => a - b);
  if (!times.length || times[0] > EPS) times.unshift(0);
  const frames: CompiledFrame[] = [];
  for (let i = 0; i < times.length; i++) {
    const a = times[i], b = times[i + 1];
    if (b === undefined) { frames.push(at(a)); break; }
    if (b - a <= EPS) continue;
    const own = easingOver(track, a, b), other = moving ? easingOver(moving, a, b) : null;
    if (!own || !other || sameEase(own, other)) { frames.push(at(a, own ?? other ?? "linear")); continue; }
    const start = at(a);
    frames.push(start, ...refine(start, at(b), 0));
  }
  if (frames[frames.length - 1].at < duration - EPS) {
    frames[frames.length - 1] = { ...frames[frames.length - 1], easing: "linear" };
    frames.push(at(duration));
  }
  return frames;
}
const displacement = (pose: Pose | null, base: GridRect): Point => pose ? { x: pose.rect.x - base.x, y: pose.rect.y - base.y } : { x: 0, y: 0 };

const num = (value: number) => +(Math.round(value * 1e6) / 1e6) || 0;
const px = (value: number) => `${num(value)}px`;
export const cssEasing = (easing: Ease): string => easing === "linear" ? "linear" : `cubic-bezier(${easing.map(num).join(", ")})`;
const polygon = (clip: GridRect) => {
  const left = px(clip.x), top = px(clip.y), right = px(clip.x + clip.width), bottom = px(clip.y + clip.height);
  return `polygon(${left} ${top}, ${right} ${top}, ${right} ${bottom}, ${left} ${bottom})`;
};

/**
 * Keyframes for compiled frames: `move` translates only (cells, covers, sections), `box` also
 * fades, clips and resizes (tiles), `layer` fades and clips (motion layers, exit groups), `row`
 * translates and scales vertically from its top (row backgrounds). Null when nothing changes.
 */
export function keyframesOf(frames: readonly CompiledFrame[], base: GridRect, kind: "move" | "box" | "layer" | "row", duration: number): Keyframe[] | null {
  const moves = frames.some((f) => Math.abs(f.dx) > 1e-3 || Math.abs(f.dy) > 1e-3);
  const sized = kind === "box" && frames.some((f) => Math.abs(f.width - base.width) > 1e-3 || Math.abs(f.height - base.height) > 1e-3);
  const fades = kind !== "move" && kind !== "row" && frames.some((f) => Math.abs(f.opacity - 1) > 1e-4);
  const clips = (kind === "box" || kind === "layer") && frames.some((f) => f.clip !== null);
  const scales = kind === "row" && frames.some((f) => Math.abs(f.height - base.height) > 1e-3);
  if (!moves && !sized && !fades && !clips && !scales) return null;
  return frames.map((f) => {
    const frame: Keyframe = { offset: duration > 0 ? Math.min(1, Math.max(0, f.at / duration)) : 0, easing: cssEasing(f.easing) };
    if (kind === "row") frame.transform = `translateY(${px(f.dy)}) scaleY(${num(base.height > 0 ? f.height / base.height : 1)})`;
    else if (moves) frame.transform = `translate(${px(f.dx)}, ${px(f.dy)})`;
    if (sized) { frame.width = px(f.width); frame.height = px(f.height); }
    if (fades) frame.opacity = num(f.opacity);
    if (clips) frame.clipPath = polygon(f.clip ?? { x: 0, y: 0, width: f.width, height: f.height });
    return frame;
  });
}

// ─── Native effects ─────────────────────────────────────────────────────────

type Styled = (HTMLElement | SVGElement) & ElementCSSInlineStyle;
const INLINE = ["transform", "opacity", "clipPath", "width", "height"] as const;
const inversions = new WeakMap<Element, Map<string, object>>();

/**
 * Animates `element` from inline first-pose values: the first keyframe is written inline under
 * an ownership token until the effect is ready (a pending effect shows it), and cleared on ready,
 * finish or cancel, unless a later effect owns the property. Width and height are restored from
 * the element's current record (`size`), since Svelte may have committed new dimensions meanwhile.
 */
function animateInverted(element: Styled, frames: Keyframe[], timing: KeyframeAnimationOptions, size?: () => { width: number; height: number } | null): Animation {
  const owned = inversions.get(element) ?? new Map<string, object>();
  inversions.set(element, owned);
  const token = {};
  const values = INLINE.flatMap((property) => {
    const value = frames[0][property];
    if (value === undefined) return [];
    const previous = element.style[property];
    owned.set(property, token);
    element.style[property] = String(value);
    return [{ property, previous, applied: element.style[property] }];
  });
  const clear = () => {
    for (const { property, previous, applied } of values) if (owned.get(property) === token) {
      owned.delete(property);
      if (element.style[property] !== applied) continue; // Svelte committed a new value meanwhile.
      const dimensions = property === "width" || property === "height" ? size?.() : null;
      element.style[property] = dimensions ? px(dimensions[property as "width" | "height"]) : previous;
    }
  };
  let animation: Animation;
  try { animation = element.animate(frames, timing); }
  catch (error) { clear(); throw error; }
  const cancel = animation.cancel.bind(animation);
  animation.cancel = () => { clear(); cancel(); };
  animation.ready.then(clear, clear);
  animation.finished.then(clear, clear);
  return animation;
}

interface Probe {
  readonly element: HTMLElement;
  readonly track: Track;
  /** The element's laid-out position on the probed axis (grid coordinates): the track's base. */
  readonly axis: "x" | "y";
}

interface Epoch {
  readonly presentation: Presentation;
  readonly animations: readonly Animation[];
  readonly clock: Animation | null;
  readonly probe: Probe | null;
  /** The camera's starting displacement of the grid (CSS px), easing to none over the epoch; null without a camera. */
  readonly camera: Point | null;
}

/** The camera's displacement at epoch time `at`: `shift` eased away over `duration` (the effect's own keyframes). */
export const cameraAt = (shift: Point, at: number, duration: number): Point => {
  const left = 1 - easeAt(EASE, duration > 0 ? at / duration : 1);
  return { x: shift.x * left, y: shift.y * left };
};

export interface SceneMotionOptions {
  readonly handles: RenderHandles;
  /** The view's scroller, whose client area is the viewport (`viewport`). */
  readonly scroller?: () => Element | null;
  /** Reduced motion (default: the user's preference). */
  readonly reduced?: () => boolean;
}

/** Folder coordinates of `element`'s top-left in `grid`, from their rects (both include running transforms). */
function offsetIn(grid: Element, element: Element): Point {
  const origin = grid.getBoundingClientRect(), box = element.getBoundingClientRect(), zoom = zoomOf(grid as HTMLElement, origin);
  return { x: (box.left - origin.left) / zoom, y: (box.top - origin.top) / zoom };
}

/** The epoch time at which `track` places its record at `value` on `axis` (bisection; the track is one monotone segment). */
function timeAt(track: Track, axis: "x" | "y", value: number): number {
  const end = trackEnd(track), at = (t: number) => sampleTrack(track, t).rect[axis];
  const ascending = at(end) >= at(0);
  let low = 0, high = end;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if ((at(mid) < value) === ascending) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

/** The driver, which also reports the epoch time it displays (windowing samples the presentation there). */
export interface SceneMotionDriver extends SceneMotion {
  viewport(): GridRect | null;
  /** The epoch time `presentation` is displayed at now (calibrated; Infinity once settled, 0 before its epoch started). */
  displayedAt(presentation: Presentation): number;
}

export function createSceneMotion({ handles, scroller = () => null, reduced = prefersReducedMotion }: SceneMotionOptions): SceneMotionDriver {
  let epoch: Epoch | null = null;
  /** The newest epoch started (an unstarted newer presentation still displays its first poses). */
  let started = -Infinity;
  /** The grid's screen origin when the displayed presentation was sampled, and the zoom then. */
  let origin: { left: number; top: number; zoom: number } | null = null;

  const owned = (animation: Animation) => animation.playState !== "finished" && animation.playState !== "idle";
  function stop(): void {
    for (const animation of epoch?.animations ?? []) if (owned(animation)) animation.cancel();
  }

  /**
   * Epoch time displayed now for `presentation` (`at`), and the clock's own time (`clock`): what
   * the main thread applies, which the grid's measured rect reflects.
   */
  function displayedTime(presentation: Presentation): { readonly at: number; readonly clock: number } {
    const settled = { at: Infinity, clock: Infinity };
    if (presentation.duration <= 0) return settled;
    if (!epoch || epoch.presentation.epoch !== presentation.epoch) return presentation.epoch > started ? { at: 0, clock: 0 } : settled;
    const { clock, probe } = epoch;
    if (!clock || !owned(clock)) return settled;
    const total = Number(clock.effect?.getTiming().duration) || presentation.duration;
    const time = Math.min(presentation.duration, Math.max(0, (Number(clock.currentTime) || 0) / total * presentation.duration));
    let at = time;
    const grid = handles.get(GRID);
    if (probe && grid && probe.element.isConnected) {
      // The compositor may show more progress than the clock reports (a stalled main thread in WebKit).
      const shown = offsetIn(grid, probe.element)[probe.axis];
      if (Math.abs(shown - sampleTrack(probe.track, at).rect[probe.axis]) > .5) at = timeAt(probe.track, probe.axis, shown);
    }
    return { at, clock: time };
  }

  return {
    reduced,

    displayedAt: (presentation) => displayedTime(presentation).at,

    viewport(): GridRect | null {
      const grid = handles.get(GRID), view = scroller();
      if (!grid || !view) return null;
      const origin = grid.getBoundingClientRect(), box = view.getBoundingClientRect(), zoom = zoomOf(grid as HTMLElement, origin);
      return { x: (box.left - origin.left) / zoom, y: (box.top - origin.top) / zoom, width: box.width / zoom, height: box.height / zoom };
    },

    sample(presentation: Presentation): DisplayedPresentation {
      const grid = handles.get(GRID);
      const { at, clock } = displayedTime(presentation);
      if (grid) {
        const rect = grid.getBoundingClientRect(), zoom = zoomOf(grid as HTMLElement, rect);
        // The grid's rect includes the running camera as the clock applies it; the interruption continues from where
        // it is displayed (the calibrated time), so the next camera starts from the displayed origin.
        const camera = epoch?.camera && epoch.presentation.epoch === presentation.epoch && Number.isFinite(clock) ? epoch.camera : null;
        const applied = camera ? cameraAt(camera, clock, presentation.duration) : { x: 0, y: 0 };
        const shown = camera ? cameraAt(camera, at, presentation.duration) : applied;
        origin = { left: rect.left + (shown.x - applied.x) * zoom, top: rect.top + (shown.y - applied.y) * zoom, zoom };
      }
      return samplePresentation(presentation, at);
    },

    start(presentation: Presentation) {
      stop();
      started = Math.max(started, presentation.epoch);
      const sampled = origin;
      origin = null;
      const animations: Animation[] = [];
      let probe: Probe | null = null;
      const { duration } = presentation;
      if (reduced() || !(duration > 0)) {
        epoch = { presentation, animations, clock: null, probe, camera: null };
        return { started: false, settled: Promise.resolve(true) };
      }
      // Camera: where the grid's screen origin moved since the sample (the new layout clamped
      // scrolling, or a running camera was interrupted); it eases from where it was displayed.
      // Measured before any first pose is written: exit groups never hold the scroll extent
      // (RetiringBand), so scrolling has already clamped to the settled scene.
      const grid = handles.get(GRID) as Styled | undefined;
      const rect = grid && sampled ? grid.getBoundingClientRect() : null;
      const shift = rect && sampled ? { x: (sampled.left - rect.left) / sampled.zoom, y: (sampled.top - rect.top) / sampled.zoom } : { x: 0, y: 0 };
      const timing = (fill: FillMode): KeyframeAnimationOptions => ({ duration, easing: "linear", fill });
      const sizeOf = (key: string) => () => {
        const record = (epoch?.presentation ?? presentation).live.get(key)?.record;
        return record ? { width: record.rect.width, height: record.rect.height } : null;
      };
      const play = (key: string, track: Track, base: GridRect, frame: MotionFrame | null, kind: "move" | "box" | "layer" | "row", fill: FillMode, map?: (f: CompiledFrame) => CompiledFrame) => {
        const element = handles.get(key) as Styled | undefined;
        if (!element) return null;
        const compiled = compileTrack(track, base, frame, duration);
        const frames = keyframesOf(map ? compiled.map(map) : compiled, base, kind, duration);
        if (!frames) return null;
        animations.push(animateInverted(element, frames, timing(fill), kind === "box" ? sizeOf(key) : undefined));
        return element;
      };
      const inSection = (frame: SectionFrame | null): MotionFrame | null => frame ? { track: frame.track, base: frame.base, x: false } : null;
      const drawn = presentationView(presentation);
      for (const { record, track } of presentation.live.values()) {
        if (!track) continue;
        switch (record.kind) {
          case "row": play(record.id, track, record.rect, null, "row", "none"); break;
          case "entry": {
            const element = play(record.id, track, record.rect, null, "move", "none");
            if (element instanceof HTMLElement) probe = better(probe, { element, track, axis: axisOf(track, record.rect) });
            break;
          }
          case "tile":
            if (record.cover) {
              // The section follows the cover's row; the cover's cell moves sideways within it.
              play(record.id, track, record.rect, { track, base: record.rect, x: false }, "move", "none");
              const section = play(sectionKey(record.graphId!), track, record.rect, null, "move", "none", (f) => ({ ...f, dx: 0 }));
              if (section instanceof HTMLElement && axisOf(track, record.rect) === "y") probe = better(probe, { element: section, track, axis: "y" });
            } else if (!ridesSection(presentation, record, track)) play(record.id, track, record.rect, inSection(sectionFrame(presentation, record)), "box", "none");
            break;
          case "route": case "junction":
            if (record.graphId !== null && drawn.graphs.get(record.graphId)?.layered.has(record.id)) {
              play(layerKey(record.id), track, record.rect, inSection(sectionFrame(presentation, record)), "layer", "forwards");
            }
            break;
          default: break;
        }
      }
      for (const retiree of presentation.retiring.values()) {
        if (!retiree.track || retiree.group !== null) continue;
        const { record } = retiree;
        if (record.kind === "band") play(retiree.renderId, retiree.track, record.rect, null, "layer", "forwards");
        else {
          // A retiree whose band closed is drawn by the grid, in folder coordinates.
          const frame = drawn.orphaned.has(retiree.renderId) ? null : inSection(sectionFrame(presentation, record));
          play(retiree.renderId, retiree.track, record.rect, frame, record.kind === "tile" ? "box" : "layer", "forwards");
        }
      }
      const camera = grid && animations.length && Math.hypot(shift.x, shift.y) >= .5 ? shift : null;
      if (grid && camera) {
        animations.push(animateInverted(grid, [
          { offset: 0, easing: cssEasing(EASE), transform: `translate(${px(shift.x)}, ${px(shift.y)})` },
          { offset: 1, transform: "translate(0px, 0px)" },
        ], timing("none")));
      }
      epoch = { presentation, animations, clock: animations[0] ?? null, probe: probe && animations.length ? probe : null, camera };
      if (!animations.length) return { started: false, settled: Promise.resolve(true) };
      return { started: true, settled: Promise.all(animations.map((animation) => animation.finished)).then(() => true, () => false) };
    },

    snap(): void {
      stop();
      epoch = null;
      origin = null;
    },
  };
}

/** The axis a single-segment track travels furthest on, for a probe. */
function axisOf(track: Track, base: GridRect): "x" | "y" {
  const first = track.frames[0].pose.rect;
  return Math.abs(first.y - base.y) >= Math.abs(first.x - base.x) ? "y" : "x";
}

/** The better progress probe: one monotone segment travelling furthest (at least a pixel). */
function better(current: Probe | null, candidate: Probe): Probe | null {
  const travel = (probe: Probe) => {
    const { frames } = probe.track;
    return frames.length === 2 ? Math.abs(frames[1].pose.rect[probe.axis] - frames[0].pose.rect[probe.axis]) : 0;
  };
  if (travel(candidate) < 1) return current;
  return !current || travel(candidate) > travel(current) ? candidate : current;
}
