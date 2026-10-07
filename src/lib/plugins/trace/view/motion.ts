/**
 * Coordinated graph motion (≈180 ms). Geometry is captured from what is
 * currently displayed — including a transition still in progress — so an
 * interrupting selection animates from where things are, not where they were
 * headed. Connectors and junctions move with their endpoints; new connectors
 * travel with their endpoints while fading in.
 *
 * Playback measures the new geometry completely before starting any
 * animation: the canvas size animation re-centres the canvas, so measuring
 * after it starts would offset every tile.
 */
import { displace, polyline, samplePathString, type Point } from "./path-sampling";

export const MOTION_MS = 180;
const EASING = "cubic-bezier(.2,.8,.2,1)";
const SAMPLES = 24;
/** Above this many connectors they snap instead of morphing; animating every `d` would cost more than a frame. */
const MORPH_LIMIT = 300;

/** `fading` is the displayed opacity of an element caught mid fade-in; null when no fade is running. */
interface Box { x: number; y: number; width: number; height: number; imageHeight: number; fading: number | null }
export interface GraphSnapshot {
  readonly width: number;
  readonly height: number;
  readonly tiles: ReadonlyMap<string, Box>;
  readonly junctions: ReadonlyMap<string, Point & { readonly fading: number | null }>;
  /** Every connector displayed (so unchanged ones are never treated as new), with its fade-in state. */
  readonly routeIds: ReadonlyMap<string, number | null>;
  /** Each displayed connector's source endpoint and displayed opacity. */
  readonly routeSources: ReadonlyMap<string, { readonly from: string; readonly opacity: number }>;
  /** Displayed connector shapes, when this engine can animate `d`. */
  readonly routes: ReadonlyMap<string, readonly Point[]>;
}

export const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/**
 * The displayed opacity of an element whose fade-in is running, else null.
 * Opacity set by a class (lineage dimming) is not a fade and is not carried over.
 */
function fadingOpacity(element: Element): number | null {
  const fading = element.getAnimations().some((animation) => animation.playState === "running"
    && (animation.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => "opacity" in frame));
  return fading ? Number(getComputedStyle(element).opacity) : null;
}

const supportsPathMorph = () => typeof CSS !== "undefined" && !!CSS.supports?.("d", 'path("M0 0 L1 1")');

function measureTiles(canvas: HTMLElement, origin: DOMRect): Map<string, { element: HTMLElement; image: HTMLElement | null; box: Box }> {
  const tiles = new Map<string, { element: HTMLElement; image: HTMLElement | null; box: Box }>();
  for (const element of canvas.querySelectorAll<HTMLElement>("[data-tile-key]")) {
    const rect = element.getBoundingClientRect();
    const image = element.querySelector<HTMLElement>("[data-tile-image]");
    tiles.set(element.dataset.tileKey!, {
      element, image,
      box: { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height, imageHeight: image?.getBoundingClientRect().height ?? 0, fading: fadingOpacity(element) },
    });
  }
  return tiles;
}

/** The connector as displayed right now (mid-morph included), resampled. */
function displayedRoute(path: SVGPathElement, animated: boolean): Point[] | null {
  const live = animated ? getComputedStyle(path).getPropertyValue("d") : "";
  return (live && live !== "none" ? samplePathString(live, SAMPLES) : null) ?? samplePathString(path.getAttribute("d") ?? "", SAMPLES);
}

/** Snapshot of a graph's displayed geometry, relative to its canvas. */
export function captureGraph(canvas: HTMLElement): GraphSnapshot {
  const origin = canvas.getBoundingClientRect();
  const tiles = new Map([...measureTiles(canvas, origin)].map(([key, { box }]) => [key, box]));
  const junctions = new Map<string, Point & { fading: number | null }>();
  for (const dot of canvas.querySelectorAll<SVGCircleElement>("[data-junction]")) {
    const box = dot.getBoundingClientRect();
    junctions.set(dot.dataset.junction!, { x: box.left + box.width / 2 - origin.left, y: box.top + box.height / 2 - origin.top, fading: fadingOpacity(dot) });
  }
  const paths = [...canvas.querySelectorAll<SVGPathElement>("path[data-route]")];
  const routeIds = new Map(paths.map((path) => [path.dataset.route!, fadingOpacity(path)]));
  const routeSources = new Map(paths.map((path) => [path.dataset.route!, { from: path.dataset.from ?? "", opacity: Number(getComputedStyle(path).opacity) }]));
  const routes = new Map<string, readonly Point[]>();
  if (supportsPathMorph() && paths.length <= MORPH_LIMIT) for (const path of paths) {
    const points = displayedRoute(path, true);
    if (points) routes.set(path.dataset.route!, points);
  }
  return { width: origin.width, height: origin.height, tiles, junctions, routeIds, routeSources, routes };
}

/** Animates a freshly rendered graph from a snapshot. Returns the animations started. */
export function playGraph(canvas: HTMLElement, before: GraphSnapshot): Animation[] {
  if (prefersReducedMotion()) return [];
  const timing: KeyframeAnimationOptions = { duration: MOTION_MS, easing: EASING };

  // 1. Measure everything in the new layout.
  const origin = canvas.getBoundingClientRect();
  const tiles = measureTiles(canvas, origin);
  const current = new Map([...tiles].map(([key, { box }]) => [key, box]));
  const dots = [...canvas.querySelectorAll<SVGCircleElement>("[data-junction]")].map((dot) => ({
    dot, at: { x: Number(dot.getAttribute("cx")), y: Number(dot.getAttribute("cy")) }, opacity: getComputedStyle(dot).opacity,
  }));
  const paths = [...canvas.querySelectorAll<SVGPathElement>("path[data-route]")];
  // Shapes morph only when both graphs could capture them (neither exceeded the limit).
  const morph = supportsPathMorph() && paths.length <= MORPH_LIMIT && before.routeIds.size <= MORPH_LIMIT;
  const connectors = paths.map((path) => ({
    path, id: path.dataset.route!, opacity: getComputedStyle(path).opacity,
    target: morph ? displayedRoute(path, false) : null,
  }));

  // 2. Animate from the snapshot.
  const animations: Animation[] = [];
  animations.push(canvas.animate([{ width: `${before.width}px`, height: `${before.height}px` }, { width: `${origin.width}px`, height: `${origin.height}px` }], timing));
  for (const [key, { element, image, box: now }] of tiles) {
    const old = before.tiles.get(key);
    if (old) {
      // A tile still fading in when interrupted continues from its opacity.
      const fade: Keyframe[] = old.fading !== null ? [{ opacity: old.fading }, { opacity: getComputedStyle(element).opacity }] : [{}, {}];
      animations.push(element.animate([
        { transform: `translate(${old.x - now.x}px, ${old.y - now.y}px)`, width: `${old.width}px`, ...fade[0] },
        { transform: "translate(0, 0)", width: `${now.width}px`, ...fade[1] },
      ], timing));
      if (image && old.imageHeight && Math.abs(old.imageHeight - now.imageHeight) > 0.5) {
        animations.push(image.animate([{ height: `${old.imageHeight}px` }, { height: `${now.imageHeight}px` }], timing));
      }
    } else {
      animations.push(element.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "translateY(0)" }], timing));
    }
  }
  // Junctions move only where their connectors morph; otherwise a dot would
  // slide while its connectors had already snapped (engines without `d`).
  for (const { dot, at, opacity } of dots) {
    const old = before.junctions.get(dot.dataset.junction!);
    if (!old) { animations.push(dot.animate([{ opacity: 0 }, { opacity }], timing)); continue; }
    const fading = old.fading !== null;
    const fade: Keyframe[] = fading ? [{ opacity: old.fading! }, { opacity }] : [{}, {}];
    if (morph) animations.push(dot.animate([{ cx: `${old.x}px`, cy: `${old.y}px`, ...fade[0] }, { cx: `${at.x}px`, cy: `${at.y}px`, ...fade[1] }], timing));
    else if (fading) animations.push(dot.animate(fade, timing));
  }
  // A connector that is new here takes over one that vanished from the same
  // source (a trunk regrouped by a relayout, say): it morphs from that shape,
  // or simply stays put where shapes do not morph, rather than fading in.
  const successors = inherit(connectors, before);
  // Keyframes never set an existing connector's opacity, so its lineage
  // dimming (a class) holds throughout; new connectors fade in to it.
  for (const { path, id, opacity, target } of connectors) {
    const heir = successors.get(id);
    const shown = heir ? before.routeIds.get(heir) : before.routeIds.get(id);
    // New connectors fade in; one still fading in when interrupted continues from where it was.
    const fadeFrom = shown === undefined ? 0 : shown;
    // A regrouped connector fades from its predecessor's opacity to its own
    // (their lineage dimming may differ), rather than snapping.
    const inherited = heir ? before.routeSources.get(heir)!.opacity : null;
    const blend = fadeFrom ?? (inherited !== null && Math.abs(inherited - Number(opacity)) > 0.01 ? inherited : null);
    const from: Keyframe = blend === null ? {} : { opacity: blend }, to: Keyframe = blend === null ? {} : { opacity };
    // A connector shown without a captured shape (the previous graph was over
    // the morph limit) snaps rather than starting from a guessed shape.
    const start = target ? before.routes.get(heir ?? id) ?? (shown === undefined ? displacedRoute(target, path, before, current) : null) : null;
    // An unchanged connector keeps its exact curve rather than morphing as a polyline.
    if (start && target && !sameShape(start, target)) { from.d = `path("${polyline(start)}")`; to.d = `path("${polyline(target)}")`; }
    if (Object.keys(from).length) animations.push(path.animate([from, to], timing));
  }
  return animations;
}

/**
 * Pairs connectors new in this graph with connectors from the same source
 * that vanished, each used once, nearest shape first (greedy matching).
 */
function inherit(connectors: readonly { path: SVGPathElement; id: string; target: readonly Point[] | null }[], before: GraphSnapshot): Map<string, string> {
  const vanished = new Map<string, string[]>();
  const present = new Set(connectors.map(({ id }) => id));
  for (const [id, { from: source }] of before.routeSources) if (!present.has(id)) (vanished.get(source) ?? vanished.set(source, []).get(source)!).push(id);
  const result = new Map<string, string>();
  const fresh = connectors.filter(({ id }) => !before.routeIds.has(id));
  // Without shapes (too many connectors, or no `d` animation) any heir will
  // do, and pairing in order keeps this linear.
  if (fresh.some(({ target }) => !target) || before.routes.size === 0) {
    for (const { path, id } of fresh) {
      const old = vanished.get(path.dataset.from ?? "")?.shift();
      if (old) result.set(id, old);
    }
    return result;
  }
  const pairs: { from: string; to: string; distance: number }[] = [];
  for (const { path, id, target } of fresh) {
    for (const old of vanished.get(path.dataset.from ?? "") ?? []) {
      const shape = before.routes.get(old);
      pairs.push({ from: old, to: id, distance: shape ? distanceBetween(shape, target!) : Number.MAX_VALUE });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
  const used = new Set<string>();
  for (const { from, to } of pairs) if (!result.has(to) && !used.has(from)) { result.set(to, from); used.add(from); }
  return result;
}

const distanceBetween = (a: readonly Point[], b: readonly Point[]) =>
  a.length === b.length ? a.reduce((sum, point, index) => sum + Math.hypot(point.x - b[index].x, point.y - b[index].y), 0) : Number.MAX_VALUE;

const sameShape = (a: readonly Point[], b: readonly Point[]) =>
  a.length === b.length && a.every((point, index) => Math.abs(point.x - b[index].x) < 0.25 && Math.abs(point.y - b[index].y) < 0.25);

/** A new connector starts where its endpoints were, then moves with them. */
function displacedRoute(target: readonly Point[], path: SVGPathElement, before: GraphSnapshot, current: ReadonlyMap<string, Box>): Point[] {
  const shift = (endpoint: string | undefined, source: boolean, at: Point): Point => {
    if (!endpoint) return { x: 0, y: -10 };
    if (endpoint.startsWith("junction:")) {
      const old = before.junctions.get(endpoint.slice(9));
      return old ? { x: old.x - at.x, y: old.y - at.y } : { x: 0, y: 0 };
    }
    const key = endpoint.slice(5);
    const old = before.tiles.get(key), now = current.get(key);
    if (!old || !now) return { x: 0, y: -10 };
    return { x: old.x + old.width / 2 - (now.x + now.width / 2), y: source ? old.y + old.height - (now.y + now.height) : old.y - now.y };
  };
  return displace(target, shift(path.dataset.from, true, target[0]), shift(path.dataset.to, false, target.at(-1)!));
}

/**
 * Keeps an element at its captured screen position while layout settles.
 * Any scrolling input from the user ends the hold at once.
 */
export function holdAnchor(scroller: HTMLElement, find: () => HTMLElement | null, before: DOMRect, duration: number): () => void {
  let frame = 0;
  let held = true;
  const started = performance.now();
  const release = () => {
    if (!held) return;
    held = false;
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLL) scroller.removeEventListener(type, onInput);
  };
  const onInput = (event: Event) => { if (scrollsByUser(event)) release(); };
  for (const type of USER_SCROLL) scroller.addEventListener(type, onInput, { passive: true });
  const adjust = () => {
    const element = find();
    if (!element) return;
    const box = element.getBoundingClientRect();
    scroller.scrollTop += box.top - before.top;
    const horizontal = element.closest<HTMLElement>("[data-horizontal-scroll]");
    if (horizontal) horizontal.scrollLeft += box.left - before.left;
  };
  const step = () => {
    if (!held) return;
    adjust();
    if (performance.now() - started < duration) frame = requestAnimationFrame(step);
    else release();
  };
  step();
  return release;
}

/** Input that may mean the user is scrolling (or about to) themselves; see `scrollsByUser`. */
export const USER_SCROLL = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
/** A held modifier (auto-repeating during a Ctrl- or Shift-click) is not scrolling. */
export const scrollsByUser = (event: Event) => !(event instanceof KeyboardEvent && MODIFIERS.has(event.key));
