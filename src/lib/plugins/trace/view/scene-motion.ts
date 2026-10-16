/**
 * The motion driver (docs/scene-transactions.md §6, "Motion driver (rAF)"): shows one
 * publication's presentation by writing inline styles from one main-thread frame loop.
 *
 * - `start` compiles every moving record's track (`compileTrack`) on the epoch's clock and writes
 *   their first poses synchronously. The clock starts at the first frame after it (`t0`, that
 *   frame's callback time, as a native animation's start time resolves when it is first
 *   rendered), so the first frame painted shows the first poses. Each frame then computes every
 *   value at epoch time `min(duration, now - t0)` (`frameAt`) and writes them all, with no DOM
 *   read in between.
 * - What is displayed is what was last written: an interruption samples the presentation at that
 *   time (`sample`), so it continues from exactly the pose on screen. No compositor clock runs
 *   ahead of it (WebKitGTK 2.54.1 also snaps a compositor animation back to its start pose as it
 *   ends, WebKit bug 321993; the native Web Animations driver this replaces suffered both).
 * - Fill: when the epoch completes, `none` effects (live records, the camera) give their inline
 *   values back to the renderer in that same frame, and `settled` resolves there, so the settled
 *   scene commits before it paints; `forwards` effects (connector layers, retirees) keep their
 *   final values until the next epoch, a snap, or their element's removal.
 * - Effects apply to registered render handles (`render-handles.ts`). Band records move inside
 *   their stack's section, which follows the cover's vertical motion, so they compile relative to
 *   it; a record moving exactly with its section gets no effect.
 * - The driver writes and restores only properties it owns, never CSS transitions on cards. One
 *   frame loop (`frame-loop.ts`) drives every view's running epoch in its `update` phase, and
 *   what follows motion (scroll anchoring, windowing) runs in its later phases of the same frame,
 *   after every pose is written. A view whose epoch throws snaps; the others run on.
 * - The clock: an epoch's first interval is lag-smoothed (`FIRST_INTERVAL`); hidden documents show
 *   final states (an epoch never starts while hidden, and completes when the document hides).
 * - DOM reads: the grid's screen origin and zoom (camera compensation, when scrolling was clamped
 *   by the new layout; the viewport in folder coordinates, which selects motion participants).
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { Point } from "$lib/domain/trace-graph/path-sampling";
import { EASE, exitBodyClip, posePath, easeAt, sameEase, samplePresentation, sampleTrack, samePose, sliceEase, trackEnd, type DisplayedPresentation, type Ease, type Pose, type Presentation, type Track } from "./presentation";
import { presentationView, ridesSection, sectionFrame, type SectionFrame } from "./presentation-view";
import { prefersReducedMotion, zoomOf } from "./motion";
import { GRID, exitBodyKey, layerKey, sectionKey, type RenderHandles } from "./render-handles";
import { afterWrite, onFrame, reportFrameError, requestFrame } from "./frame-loop";
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


// ─── Sampling compiled frames (pure) ────────────────────────────────────────

/** What a compiled track displays at one epoch time. */
export interface FrameValues {
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  /** Clip in the element's own box coordinates, or null. */
  readonly clip: GridRect | null;
}

const values = ({ dx, dy, width, height, opacity, clip }: CompiledFrame): FrameValues => ({ dx, dy, width, height, opacity, clip });
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
/** A frame's clip, or its whole box: an unclipped frame next to a clipped one interpolates from its full extent. */
const clipOf = (f: CompiledFrame): GridRect => f.clip ?? { x: 0, y: 0, width: f.width, height: f.height };

/**
 * The values compiled `frames` display at epoch time `t`: the segment holding `t`, eased by its
 * starting frame's easing, every value interpolated linearly by that progress. Before the first
 * frame (or for a time that is not a number) the first frame's values; from the last frame on, its
 * values. These are exactly the values a native effect would interpolate from the same keyframes.
 */
export function frameAt(frames: readonly CompiledFrame[], t: number): FrameValues {
  if (!frames.length) throw new RangeError("frameAt: no compiled frames");
  const first = frames[0], last = frames[frames.length - 1];
  if (!(t > first.at)) return values(first);
  if (t >= last.at) return values(last);
  // The last frame at or before `t`; the next one is after it.
  let low = 0, high = frames.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].at <= t) low = middle; else high = middle;
  }
  const a = frames[low], b = frames[high];
  const k = easeAt(a.easing, (t - a.at) / (b.at - a.at));
  const clip = a.clip || b.clip ? (() => {
    const from = clipOf(a), to = clipOf(b);
    return { x: mix(from.x, to.x, k), y: mix(from.y, to.y, k), width: mix(from.width, to.width, k), height: mix(from.height, to.height, k) };
  })() : null;
  return { dx: mix(a.dx, b.dx, k), dy: mix(a.dy, b.dy, k), width: mix(a.width, b.width, k), height: mix(a.height, b.height, k), opacity: mix(a.opacity, b.opacity, k), clip };
}

/** The inline properties the driver writes. */
export type MotionProperty = "transform" | "opacity" | "clipPath" | "width" | "height" | "d";
/**
 * How an element shows its frames: `move` translates only (cells, covers, sections), `box` also
 * fades, clips and resizes (tiles), `layer` fades and clips (motion layers, exit groups), `row`
 * translates and scales vertically from its top (row backgrounds).
 */
export type MotionKind = "move" | "box" | "layer" | "row";

/** The properties compiled `frames` change for an element of `kind` laid out at `base`: none when it holds still. */
export function animatedProperties(frames: readonly CompiledFrame[], base: GridRect, kind: MotionKind): readonly MotionProperty[] {
  const moves = frames.some((f) => Math.abs(f.dx) > 1e-3 || Math.abs(f.dy) > 1e-3);
  const sized = kind === "box" && frames.some((f) => Math.abs(f.width - base.width) > 1e-3 || Math.abs(f.height - base.height) > 1e-3);
  const fades = kind !== "move" && kind !== "row" && frames.some((f) => Math.abs(f.opacity - 1) > 1e-4);
  const clips = (kind === "box" || kind === "layer") && frames.some((f) => f.clip !== null);
  const scales = kind === "row" && frames.some((f) => Math.abs(f.height - base.height) > 1e-3);
  const properties: MotionProperty[] = [];
  if (kind === "row" ? moves || scales : moves) properties.push("transform");
  if (sized) properties.push("width", "height");
  if (fades) properties.push("opacity");
  if (clips) properties.push("clipPath");
  return properties;
}

const num = (value: number) => +(Math.round(value * 1e6) / 1e6) || 0;
const px = (value: number) => `${num(value)}px`;
const polygon = (clip: GridRect) => {
  const left = px(clip.x), top = px(clip.y), right = px(clip.x + clip.width), bottom = px(clip.y + clip.height);
  return `polygon(${left} ${top}, ${right} ${top}, ${right} ${bottom}, ${left} ${bottom})`;
};

/** The inline values of `properties` that show `shown` on an element of `kind` laid out at `base`. */
export function styleOf(shown: FrameValues, base: GridRect, kind: MotionKind, properties: readonly MotionProperty[]): Partial<Record<MotionProperty, string>> {
  const style: Partial<Record<MotionProperty, string>> = {};
  for (const property of properties) {
    switch (property) {
      case "transform":
        style.transform = kind === "row" ? `translateY(${px(shown.dy)}) scaleY(${num(base.height > 0 ? shown.height / base.height : 1)})` : `translate(${px(shown.dx)}, ${px(shown.dy)})`;
        break;
      case "width": style.width = px(shown.width); break;
      case "height": style.height = px(shown.height); break;
      case "opacity": style.opacity = String(num(shown.opacity)); break;
      case "clipPath": style.clipPath = polygon(shown.clip ?? { x: 0, y: 0, width: shown.width, height: shown.height }); break;
    }
  }
  return style;
}

/** The camera's displacement at epoch time `at`: `shift` eased away over `duration`. */
export const cameraAt = (shift: Point, at: number, duration: number): Point => {
  const left = 1 - easeAt(EASE, duration > 0 ? at / duration : 1);
  return { x: shift.x * left, y: shift.y * left };
};

// ─── The frame loop ─────────────────────────────────────────────────────────

/** One element's motion in an epoch. */
interface Effect {
  readonly element: Styled;
  readonly style: (at: number) => Partial<Record<MotionProperty, string>>;
  /** `none`: the renderer's values return when the epoch completes; `forwards`: the final values stay until the next epoch, a snap or the element's removal. */
  readonly fill: "none" | "forwards";
}

/** An epoch the loop drives. */
interface Running {
  readonly epoch: number;
  readonly duration: number;
  /** Advances to frame time `now` (complete once the epoch's duration has elapsed). */
  tick(now: number): void;
  /** Test hook: shows epoch time `at` now. */
  seek(at: number): void;
  /** Completes now (final values, settled). */
  finish(): void;
  /** Ends now without completing (settled false). */
  cancel(): void;
  /** Ends after a failure: shows its view's renderer values (the target scene) and settles, so the view commits it. */
  fail(): void;
  /** Epoch time last written. */
  at: number;
  held: boolean;
  /** Test hook: where the clock is pinned while held. */
  pinned: number;
  /** Frame time the epoch's clock started at (NaN until its next frame sets it). */
  t0: number;
  /** Epoch time the next frame shows when it sets `t0` (0 for a new epoch; the pinned time after a release). */
  resumeAt: number;
  /** Whether the first interval is still to come (see `FIRST_INTERVAL`). */
  firstInterval: boolean;
  /** Frame time of the last frame that advanced the clock. */
  lastNow: number;
}

/**
 * Lag smoothing for an epoch's first interval only (GSAP's `lagSmoothing`, applied once): the first
 * frame after `start` renders the new publication, which may take far longer than a frame on a
 * large scene (WebView2 and Chromium time it inside the interval). A native animation's clock
 * starts once its first frame is presented; this one starts at that frame's callback, so a first
 * interval longer than `threshold` counts as `assumed`, one nominal frame. Later intervals are the
 * epoch's own: stalled time is never dropped (`band-motion` "the connector clock survives main-thread stalls").
 */
export const FIRST_INTERVAL = { threshold: 25, assumed: 1000 / 60 } as const;

/** Every running epoch of every view, driven by the frame loop's `update` phase while one runs. */
const active = new Set<Running>();
/** Test hooks: whether new epochs start held, and the clock's rate. */
let holding = false;
let rate = 1;
let startedEpochs = 0;
/** Elements whose inline values a driver owns now (test hook `owns`). */
const writing = new WeakSet<Element>();
const runs = () => [...active].some((running) => !running.held);
/** Requests the next frame while an epoch runs (a pending request is kept: `frame-loop.ts`). */
function schedule(): void {
  if (runs()) requestFrame();
}
/** Runs `step` on `running`; if it throws, that epoch fails (its view snaps) and the error is reported. */
function guarded(running: Running, step: (running: Running) => void): void {
  try { step(running); } catch (error) { running.fail(); reportFrameError(error); }
}
/** The `update` phase: each view's epochs advance and write their poses; one that throws snaps its view only. */
function update(now: number): void {
  for (const running of [...active]) if (!running.held) guarded(running, (epoch) => epoch.tick(now));
  schedule();
}
onFrame("update", update);

/** Whether the document is hidden (nothing is seen, and frames are suspended). */
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
/** Hidden mid-epoch: every epoch completes at once (its final state), instead of waiting for frames that do not come. */
function visibilityChanged(): void {
  if (!hidden() || !active.size) return;
  for (const running of [...active]) guarded(running, (epoch) => epoch.finish());
  afterWrite();
}
let watched: Document | null = null;
/** Follows the visibility of the current document. */
function watchVisibility(): void {
  const current = typeof document !== "undefined" ? document : null;
  if (current === watched) return;
  watched?.removeEventListener("visibilitychange", visibilityChanged);
  current?.addEventListener("visibilitychange", visibilityChanged);
  watched = current;
}

/**
 * Test-only control of the motion clock (the browser harness exposes it). It never acts unless
 * called: production motion runs on frame time. Clocks are only ever frame times: a resumed or
 * re-rated epoch continues from the time it displays, at its next frame.
 */
export const sceneMotionTesting = {
  /** Holds every running epoch where it is, and starts every later one held at its first pose. */
  hold(): void {
    holding = true;
    for (const running of active) { running.held = true; running.pinned = running.at; }
  },
  /** Shows epoch time `at` (clamped to each epoch) in every held epoch, synchronously. A held epoch does not complete. */
  seek(at: number): void {
    let wrote = false;
    for (const running of [...active]) if (running.held) { running.seek(at); wrote = true; }
    if (wrote) afterWrite();
  },
  /** Runs every held epoch on from where it is held, from its next frame; later epochs start running. */
  release(): void {
    holding = false;
    for (const running of active) if (running.held) { running.held = false; running.t0 = NaN; running.resumeAt = running.pinned; running.firstInterval = false; }
    schedule();
  },
  /** Completes every running epoch now: final values, settled. */
  finish(): void {
    if (!active.size) return;
    for (const running of [...active]) running.finish();
    afterWrite();
  },
  /** Epoch time advances `value` times as fast as frame time (1 normally), from the time each epoch displays now. */
  setRate(value: number): void {
    for (const running of active) if (!running.held && Number.isFinite(running.t0)) running.t0 = running.lastNow - running.at / value;
    rate = value;
  },
  /** Whether a driver shows `element` with values it wrote (it has an effect of its own, or kept a final value). */
  owns: (element: Element): boolean => writing.has(element),
  /** What runs: each running epoch's number, displayed time and duration, and how many epochs started motion so far. */
  state(): { readonly running: readonly { epoch: number; at: number; duration: number; held: boolean }[]; readonly started: number } {
    return { running: [...active].map(({ epoch, at, duration, held }) => ({ epoch, at, duration, held })), started: startedEpochs };
  },
};

// ─── The driver ─────────────────────────────────────────────────────────────

type Styled = (HTMLElement | SVGElement) & ElementCSSInlineStyle;

export interface SceneMotionOptions {
  readonly handles: RenderHandles;
  /** The view's scroller, whose client area is the viewport (`viewport`). */
  readonly scroller?: () => Element | null;
  /** Reduced motion (default: the user's preference). */
  readonly reduced?: () => boolean;
}

/** The driver, which also reports the epoch time it displays (windowing samples the presentation there). */
export interface SceneMotionDriver extends SceneMotion {
  viewport(): GridRect | null;
  /** The epoch time `presentation` is displayed at now (Infinity once settled, 0 before its epoch started). */
  displayedAt(presentation: Presentation): number;
}

/** The renderer's inline values under the ones the driver wrote, per element and property. */
interface Owned {
  readonly previous: Map<MotionProperty, string>;
  readonly written: Map<MotionProperty, string>;
}

export function createSceneMotion({ handles, scroller = () => null, reduced = prefersReducedMotion }: SceneMotionOptions): SceneMotionDriver {
  /** The newest epoch started, and its loop entry while it runs. */
  let current: { readonly presentation: Presentation; running: Running | null; camera: boolean } | null = null;
  /** The newest epoch started (an unstarted newer presentation still displays its first poses). */
  let started = -Infinity;
  /** The grid's screen origin when the displayed presentation was sampled, and the zoom then. */
  let origin: { left: number; top: number; zoom: number } | null = null;
  /** What the driver wrote into each element it owns, and the renderer's values under it. */
  const owned = new WeakMap<Styled, Owned>();
  /** The elements the running epoch writes (held strongly while it runs). */
  const moving = new Set<Styled>();
  /**
   * Elements that kept their final values after their epoch completed (fill `forwards`), held
   * weakly: a retiree unmounts once the settled scene commits, and nothing keeps it alive.
   */
  let kept = new Set<WeakRef<Styled>>();

  function write(element: Styled, style: Partial<Record<MotionProperty, string>>): void {
    let own = owned.get(element);
    if (!own) { owned.set(element, own = { previous: new Map(), written: new Map() }); writing.add(element); }
    moving.add(element);
    for (const property in style) {
      const key = property as MotionProperty, value = style[key]!, shown = key === "d" ? element.getAttribute("d") ?? "" : element.style[key];
      const mine = own.written.get(key);
      // The renderer's value: before the first write, or whatever it committed since the last.
      if (mine === undefined || shown !== mine) own.previous.set(key, shown);
      if (shown === value && mine !== undefined) continue;
      if (key === "d") element.setAttribute("d", value); else element.style[key] = value;
      own.written.set(key, key === "d" ? element.getAttribute("d") ?? "" : element.style[key]);
    }
  }
  /** Gives `element`'s properties back to the renderer (keeping any value it committed meanwhile). */
  function restore(element: Styled): void {
    const own = owned.get(element);
    if (!own) return;
    owned.delete(element);
    writing.delete(element);
    moving.delete(element);
    for (const [property, previous] of own.previous) {
      if (property === "d") { if (element.getAttribute("d") === own.written.get(property)) element.setAttribute("d", previous); }
      else if (element.style[property] === own.written.get(property)) element.style[property] = previous;
    }
  }

  /** Gives every owned property back: the running epoch's and the kept final values of elements still alive. */
  function restoreAll(): void {
    for (const element of [...moving]) restore(element);
    for (const ref of kept) { const element = ref.deref(); if (element) restore(element); }
    kept = new Set();
  }
  /** Ends the running epoch (settled false unless it completed) and gives every owned property back. */
  function stop(): void {
    current?.running?.cancel();
    restoreAll();
  }

  function displayedTime(presentation: Presentation): number {
    if (presentation.duration <= 0) return Infinity;
    if (!current || current.presentation.epoch !== presentation.epoch) return presentation.epoch > started ? 0 : Infinity;
    return current.running ? current.running.at : Infinity;
  }

  return {
    reduced,

    displayedAt: displayedTime,

    viewport(): GridRect | null {
      const grid = handles.get(GRID), view = scroller();
      if (!grid || !view) return null;
      const origin = grid.getBoundingClientRect(), box = view.getBoundingClientRect(), zoom = zoomOf(grid as HTMLElement, origin);
      return { x: (box.left - origin.left) / zoom, y: (box.top - origin.top) / zoom, width: box.width / zoom, height: box.height / zoom };
    },

    sample(presentation: Presentation): DisplayedPresentation {
      const grid = handles.get(GRID);
      if (grid) {
        // The grid's rect includes the camera as last written: what is displayed.
        const rect = grid.getBoundingClientRect();
        origin = { left: rect.left, top: rect.top, zoom: zoomOf(grid as HTMLElement, rect) };
      }
      return samplePresentation(presentation, displayedTime(presentation));
    },

    start(presentation: Presentation) {
      stop();
      started = Math.max(started, presentation.epoch);
      const sampled = origin;
      origin = null;
      current = { presentation, running: null, camera: false };
      const { duration } = presentation;
      watchVisibility();
      // Nothing is seen while the document is hidden (and frames are suspended): it shows the final state at once.
      if (reduced() || !(duration > 0) || hidden()) return { started: false, settled: Promise.resolve(true) };
      // Camera: where the grid's screen origin moved since the sample (the new layout clamped
      // scrolling, or a running camera was interrupted); it eases from where it was displayed.
      // Measured with every owned property given back and before any first pose is written: exit
      // groups never hold the scroll extent (RetiringBand), so scrolling has already clamped to the settled scene.
      const grid = handles.get(GRID) as Styled | undefined;
      const rect = grid && sampled ? grid.getBoundingClientRect() : null;
      const shift = rect && sampled ? { x: (sampled.left - rect.left) / sampled.zoom, y: (sampled.top - rect.top) / sampled.zoom } : { x: 0, y: 0 };
      const effects: Effect[] = [];
      const play = (key: string, track: Track, base: GridRect, frame: MotionFrame | null, kind: MotionKind, fill: Effect["fill"], map?: (f: CompiledFrame) => CompiledFrame) => {
        const elements = handles.all?.(key) ?? [handles.get(key)].filter((e): e is HTMLElement | SVGElement => !!e);
        if (!elements.length) return;
        const compiled = compileTrack(track, base, frame, duration), frames = map ? compiled.map(map) : compiled;
        const properties = animatedProperties(frames, base, kind);
        if (properties.length) for (const element of elements as Styled[]) effects.push({ element, fill, style: (at) => styleOf(frameAt(frames, at), base, kind, properties) });
      };
      const inSection = (frame: SectionFrame | null): MotionFrame | null => frame ? { track: frame.track, base: frame.base, x: false } : null;
      const drawn = presentationView(presentation);
      for (const { record, track } of presentation.live.values()) {
        if (!track) continue;
        switch (record.kind) {
          case "row": play(record.id, track, record.rect, null, "row", "none"); break;
          case "entry": play(record.id, track, record.rect, null, "move", "none"); break;
          case "tile":
            if (record.cover) {
              // The section follows the cover's row; the cover's cell moves sideways within it.
              play(record.id, track, record.rect, { track, base: record.rect, x: false }, "move", "none");
              play(sectionKey(record.graphId!), track, record.rect, null, "move", "none", (f) => ({ ...f, dx: 0 }));
            } else if (!ridesSection(presentation, record, track)) play(record.id, track, record.rect, inSection(sectionFrame(presentation, record)), "box", "none");
            break;
          case "route": case "junction":
            if (record.graphId !== null && drawn.graphs.get(record.graphId)?.layered.has(record.id)) {
              play(layerKey(record.id), track, record.rect, inSection(sectionFrame(presentation, record)), "layer", "forwards");
              if (record.kind === "route" && (track.frames[0].pose.stem || track.frames[0].pose.shape)) {
                const path = handles.get(layerKey(record.id))?.querySelector("path") as Styled | null;
                if (path) effects.push({ element: path, fill: "forwards", style: at => ({ d: posePath(sampleTrack(track, at), record.rect)! }) });
              }
            }
            break;
          default: break;
        }
      }
      for (const retiree of presentation.retiring.values()) {
        if (!retiree.track || retiree.group !== null) continue;
        const { record } = retiree;
        if (record.kind === "band") {
          play(retiree.renderId, retiree.track, record.rect, null, "layer", "forwards");
          const bodies = handles.all?.(exitBodyKey(retiree.renderId)) ?? [handles.get(exitBodyKey(retiree.renderId))].filter((e): e is HTMLElement | SVGElement => !!e);
          for (const body of bodies as Styled[]) if (retiree.bodyFloor !== undefined) effects.push({ element: body, fill: "forwards", style: at => {
            const pose = sampleTrack(retiree.track!, at), clip = exitBodyClip(pose, retiree.bodyFloor!);
            return { clipPath: polygon({ ...clip, x: clip.x - pose.rect.x, y: clip.y - pose.rect.y }) };
          } });
        } else {
          // A retiree whose band closed is drawn by the grid, in folder coordinates.
          const frame = drawn.orphaned.has(retiree.renderId) ? null : inSection(sectionFrame(presentation, record));
          play(retiree.renderId, retiree.track, record.rect, frame, record.kind === "tile" ? "box" : "layer", "forwards");
        }
      }
      if (grid && effects.length && Math.hypot(shift.x, shift.y) >= .5) {
        effects.push({ element: grid, fill: "none", style: (at) => { const { x, y } = cameraAt(shift, at, duration); return { transform: `translate(${px(x)}, ${px(y)})` }; } });
        current.camera = true;
      }
      if (!effects.length) return { started: false, settled: Promise.resolve(true) };

      let settle!: (finished: boolean) => void;
      const settled = new Promise<boolean>((resolve) => { settle = resolve; });
      const epoch = current;
      /** Writes every effect's values at `at`: all computed first, then written, with no read between. */
      const render = (at: number) => {
        const styles = effects.map((effect) => effect.style(at));
        effects.forEach((effect, i) => write(effect.element, styles[i]));
        running.at = at;
      };
      /**
       * Ends the epoch: complete (final values; the `none` ones given back, the `forwards` ones
       * kept, held weakly), cancelled, or failed (everything given back: the renderer's values are
       * the target scene, which settling commits).
       */
      let ended = false;
      const end = (outcome: "complete" | "cancel" | "fail") => {
        if (ended) return;
        active.delete(running);
        // Writing the final values may throw: the epoch then fails (`update`), which still settles it.
        if (outcome === "complete") {
          render(duration);
          for (const effect of effects) {
            if (effect.fill === "none") restore(effect.element);
            else if (moving.delete(effect.element)) kept.add(new WeakRef(effect.element));
          }
        } else if (outcome === "fail") restoreAll();
        ended = true;
        if (epoch.running === running) epoch.running = null;
        settle(outcome !== "cancel");
      };
      const running: Running = {
        epoch: presentation.epoch, duration, at: 0, held: holding, pinned: 0, t0: NaN, resumeAt: 0, firstInterval: true, lastNow: NaN,
        tick(now) {
          if (!Number.isFinite(running.t0)) {
            // Its first frame (or the first after a release) shows the time it starts from.
            running.t0 = now - running.resumeAt / rate;
          } else if (running.firstInterval) {
            running.firstInterval = false;
            if (now - running.t0 > FIRST_INTERVAL.threshold) running.t0 = now - FIRST_INTERVAL.assumed;
          }
          running.lastNow = now;
          const at = Math.min(duration, Math.max(0, (now - running.t0) * rate));
          if (at >= duration) end("complete"); else render(at);
        },
        seek(at) { running.pinned = Math.min(duration, Math.max(0, Number(at) || 0)); render(running.pinned); },
        finish: () => end("complete"),
        cancel: () => end("cancel"),
        fail: () => end("fail"),
      };
      epoch.running = running;
      // The first pose is written now, synchronously, so the first frame painted shows it.
      render(0);
      active.add(running);
      startedEpochs++;
      schedule();
      return { started: true, settled };
    },

    snap(): void {
      stop();
      current = null;
      origin = null;
    },
  };
}
