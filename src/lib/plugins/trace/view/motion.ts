/**
 * Coordinated graph motion (≈160 ms). Geometry is captured from what is
 * currently displayed — including a transition still in progress — so an
 * interrupting selection animates from where things are, not where they were
 * headed. Tiles only move (their size never depends on the selection).
 * Connectors and junctions move with their endpoints; new connectors travel
 * with their endpoints while fading in. Tiles, connectors and junctions that
 * leave the graph fade out where they were displayed, as inert copies in the
 * canvas's ghost layers (`[data-motion-ghosts]`), so nothing vanishes abruptly.
 *
 * Every position is measured in the canvas's own CSS pixels, the space that
 * keyframes, inline positions and scroll offsets use. Hosts may zoom the whole
 * document (CSS `zoom` on the root), and most engines then report
 * `getBoundingClientRect` in zoomed pixels: mixing the two spaces started
 * every animation from a scaled position and snapped back when it ended.
 * Tiles are therefore measured from their computed styles (no layout read);
 * the few rect reads left are divided by the measured zoom (`zoomOf`).
 */
import { displace, polyline, samplePathString, interpolatePath, moveOrthogonalRoute, prepareOrthogonalRoute, orthogonalRouteTravel, type Point } from "./path-sampling";
import type { Orientation } from "$lib/domain/trace-graph/layout";
import { departureVisibility, planBandTravel, remainingTravel, travelFrames } from "./band-motion";
import { anchorDelta, releasesAnchor } from "$lib/domain/scroll-anchor";

export const MOTION_MS = 160;

const EASING = "cubic-bezier(.2,.8,.2,1)";
const SAMPLES = 24;
/** Above this many connectors they snap instead of morphing; animating every `d` would cost more than a frame. */
const MORPH_LIMIT = 300;

/** `fading` is the displayed opacity of an element caught mid fade-in; null when no fade is running. */
interface Box { x: number; y: number; width: number; height: number; fading: number | null }
export interface GraphSnapshot {
  readonly width: number;
  readonly height: number;
  readonly clipPath: string;
  readonly tiles: ReadonlyMap<string, Box>;
  readonly junctions: ReadonlyMap<string, Point & { readonly fading: number | null }>;
  /** Every connector displayed (so unchanged ones are never treated as new), with its fade-in state. */
  readonly routeIds: ReadonlyMap<string, number | null>;
  /** Each displayed connector's source endpoint and displayed opacity. */
  readonly routeSources: ReadonlyMap<string, { readonly from: string; readonly opacity: number }>;
  /** Displayed connector shapes, when this engine can animate `d`. */
  readonly routes: ReadonlyMap<string, readonly Point[]>;
  /** Exact displayed paths, including bend vertices and cubic corners. */
  readonly routePaths: ReadonlyMap<string, string>;
  /** The displayed elements, so those that leave can fade out as copies. */
  readonly elements: { readonly tiles: ReadonlyMap<string, HTMLElement>; readonly paths: ReadonlyMap<string, SVGPathElement>; readonly dots: ReadonlyMap<string, SVGCircleElement> };
  /** Copies still fading out from an earlier commit, with their displayed opacity. */
  readonly ghosts: readonly { readonly element: Element; readonly opacity: number; readonly identity: Identity | undefined }[];
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

/**
 * Visual pixels per CSS pixel of `element`: the document zoom a host applies,
 * or 1. Measured rather than assumed, so it holds whichever space an engine
 * reports rects in. `element` must not be transformed itself.
 */
export function zoomOf(element: Element, rect: DOMRect = element.getBoundingClientRect()): number {
  const style = getComputedStyle(element);
  const edges = style.boxSizing === "border-box" ? 0
    : parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const width = parseFloat(style.width) + edges;
  return width > 0 && rect.width > 0 ? rect.width / width : 1;
}

/** A tile's displayed box in canvas pixels: its laid-out place plus any running transform. */
function displayedBox(element: HTMLElement): Box {
  const style = getComputedStyle(element);
  const shift = style.transform && style.transform !== "none" ? new DOMMatrixReadOnly(style.transform) : null;
  return {
    x: parseFloat(style.left) + (shift?.m41 ?? 0), y: parseFloat(style.top) + (shift?.m42 ?? 0),
    width: parseFloat(style.width), height: parseFloat(style.height), fading: fadingOpacity(element),
  };
}

function measureTiles(canvas: HTMLElement): Map<string, { element: HTMLElement; box: Box }> {
  const tiles = new Map<string, { element: HTMLElement; box: Box }>();
  for (const element of canvas.querySelectorAll<HTMLElement>("[data-tile-key], [data-ghost-tile-key]")) tiles.set((element.dataset.tileKey ?? element.dataset.ghostTileKey)!, { element, box: displayedBox(element) });
  return tiles;
}

/** The canvas's displayed size (mid-animation included), in its own pixels. */
function canvasSize(canvas: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(canvas);
  return { width: parseFloat(style.width), height: parseFloat(style.height) };
}

/** The connector as displayed right now (mid-morph included), resampled. */
function displayedRoute(path: SVGPathElement, animated: boolean): Point[] | null {
  const live = animated ? getComputedStyle(path).getPropertyValue("d") : "";
  return (live && live !== "none" ? samplePathString(live, SAMPLES) : null) ?? samplePathString(path.getAttribute("d") ?? "", SAMPLES);
}

/** Snapshot of a graph's displayed geometry, relative to its canvas. */
export function captureGraph(canvas: HTMLElement): GraphSnapshot {
  const measured = measureTiles(canvas);
  const tiles = new Map([...measured].map(([key, { box }]) => [key, box]));
  const junctions = new Map<string, Point & { fading: number | null }>();
  const dotElements = new Map<string, SVGCircleElement>();
  // A moving dot is read from its rect (engines disagree on a zoomed `cx`); one at rest from its attributes.
  let frame: { origin: DOMRect; zoom: number } | null = null;
  for (const dot of canvas.querySelectorAll<SVGCircleElement>("[data-junction]")) {
    dotElements.set(dot.dataset.junction!, dot);
    let at: Point = { x: Number(dot.getAttribute("cx")), y: Number(dot.getAttribute("cy")) };
    if (dot.getAnimations().length) {
      if (!frame) { const origin = canvas.getBoundingClientRect(); frame = { origin, zoom: zoomOf(canvas, origin) }; }
      const box = dot.getBoundingClientRect();
      at = { x: (box.left + box.width / 2 - frame.origin.left) / frame.zoom, y: (box.top + box.height / 2 - frame.origin.top) / frame.zoom };
    }
    junctions.set(dot.dataset.junction!, { ...at, fading: fadingOpacity(dot) });
  }
  const paths = [...canvas.querySelectorAll<SVGPathElement>("path[data-route]")];
  const routeIds = new Map(paths.map((path) => [path.dataset.route!, fadingOpacity(path)]));
  const routeSources = new Map(paths.map((path) => [path.dataset.route!, { from: path.dataset.from ?? "", opacity: Number(getComputedStyle(path).opacity) }]));
  const routePaths = new Map(paths.map(path => [path.dataset.route!, exactRoute(path)]));
  const routes = new Map<string, readonly Point[]>();
  if (paths.length <= MORPH_LIMIT) for (const path of paths) {
    const points = displayedRoute(path, true);
    if (points) routes.set(path.dataset.route!, points);
  }
  const elements = { tiles: new Map([...measured].map(([key, { element }]) => [key, element])), paths: new Map(paths.map((path) => [path.dataset.route!, path])), dots: dotElements };
  const ghosts = [...canvas.querySelectorAll(`[${GHOST}]`)].map((element) => ({ element, opacity: Number(getComputedStyle(element).opacity), identity: identities.get(element) }));
  // Something still fading out is displayed there: should it return, it
  // continues from the copy's place and opacity instead of appearing twice.
  for (const { element, opacity, identity } of ghosts) {
    if (identity?.kind === "tile" && !tiles.has(identity.id)) {
      tiles.set(identity.id, { ...displayedBox(element as HTMLElement), fading: opacity });
    } else if (identity?.kind === "route" && !routeIds.has(identity.id)) {
      routeIds.set(identity.id, opacity);
      routeSources.set(identity.id, { from: identity.from, opacity });
      routePaths.set(identity.id, exactRoute(element as SVGPathElement));
      const shape = samplePathString(element.getAttribute("d") ?? "", SAMPLES);
      if (shape) routes.set(identity.id, shape);
    } else if (identity?.kind === "junction" && !junctions.has(identity.id)) {
      junctions.set(identity.id, { x: Number(element.getAttribute("cx")), y: Number(element.getAttribute("cy")), fading: opacity });
    }
  }
  return { ...canvasSize(canvas), clipPath: getComputedStyle(canvas).clipPath, tiles, junctions, routeIds, routeSources, routes, routePaths, elements, ghosts };
}

/** Animates a freshly rendered graph from a snapshot. Returns the animations started. */
/** How far a new tile or connector slides in from: back along the flow, toward its parents. */
export const enterOffset = (orientation: Orientation): Point => orientation === "right" ? { x: -10, y: 0 } : { x: 0, y: -10 };

export function playGraph(canvas: HTMLElement, before: GraphSnapshot, orientation: Orientation = "down", origin?: { key: string; box: Box }, bandRoutes = false): Animation[] {
  if (prefersReducedMotion()) return [];
  const timing: KeyframeAnimationOptions = { duration: MOTION_MS, easing: EASING };

  const started = document.timeline.currentTime;
  const nativeMorph = supportsPathMorph();
  // 1. Measure everything in the new layout, from computed styles in canvas pixels.
  const size = canvasSize(canvas);
  const tiles = measureTiles(canvas);
  const current = new Map([...tiles].map(([key, { box }]) => [key, box]));
  const dots = [...canvas.querySelectorAll<SVGCircleElement>("[data-junction]")].map((dot) => ({
    dot, at: { x: Number(dot.getAttribute("cx")), y: Number(dot.getAttribute("cy")) }, opacity: getComputedStyle(dot).opacity,
  }));
  const paths = [...canvas.querySelectorAll<SVGPathElement>("path[data-route]")];
  const travel = origin ? planBandTravel(paths.map((path) => ({ from: path.dataset.from ?? "", to: path.dataset.to ?? "", path: path.getAttribute("d") ?? "" })), origin.key) : null;
  // Shapes morph only when both graphs could capture them (neither exceeded the limit).
  const morph = paths.length <= MORPH_LIMIT && before.routeIds.size <= MORPH_LIMIT;
  const childTop = { before: Math.min(...[...before.tiles.values()].map(box => box.y)), after: Math.min(...[...current.values()].map(box => box.y)) };
  const connectors = paths.map((path) => ({
    path, id: path.dataset.route!, opacity: getComputedStyle(path).opacity,
    target: morph ? displayedRoute(path, false) : null,
  }));

  const progressCandidates = nativeMorph && !bandRoutes ? [] : [...tiles].map(([key, tile]) => {
    const old = before.tiles.get(key);
    const delta = old ? { x: old.x - tile.box.x, y: old.y - tile.box.y } : enterOffset(orientation);
    return { key, tile, delta };
  }).filter(({ delta }) => Math.max(Math.abs(delta.x), Math.abs(delta.y)) >= .5);

  // All routes share one native sample per graph/frame, including trunks and
  // junction branches. Repeated rect reads can observe different compositor
  // instants in WebKit and would separate otherwise identical sibling stems.
  const clockTile = progressCandidates.reduce<(typeof progressCandidates)[number] | undefined>((best, candidate) =>
    !best || Math.max(Math.abs(candidate.delta.x), Math.abs(candidate.delta.y)) > Math.max(Math.abs(best.delta.x), Math.abs(best.delta.y)) ? candidate : best, undefined);
  let progressFrame: number | null | undefined, progressValue = 0;
  const displayedProgress = clockTile ? () => {
    const now = Number(document.timeline.currentTime);
    if (now !== progressFrame) {
      progressFrame = now;
      const frame = canvas.getBoundingClientRect(), box = clockTile.tile.element.getBoundingClientRect();
      const zoom = zoomOf(canvas, frame), { delta, tile } = clockTile;
      const shift = { x: (box.left - frame.left) / zoom - tile.box.x, y: (box.top - frame.top) / zoom - tile.box.y };
      progressValue = 1 - (Math.abs(delta.y) >= Math.abs(delta.x) ? shift.y / delta.y : shift.x / delta.x);
    }
    return progressValue;
  } : undefined;

  // 2. Animate from the snapshot.
  const animations: Animation[] = [];
  if (Math.abs(before.width - size.width) >= 0.5 || Math.abs(before.height - size.height) >= 0.5) {
    animations.push(canvas.animate([{ width: `${before.width}px`, height: `${before.height}px` }, { width: `${size.width}px`, height: `${size.height}px` }], timing));
  }
  // Tile sizes never depend on the selection, so tiles mostly only move (and
  // fade); they grow or shrink only when the host's tile size changes.
  for (const [key, { element, box: now }] of tiles) {
    const old = before.tiles.get(key);
    if (origin && (!old || old.fading !== null)) {
      const points = travel!(key, origin.box, now);
      const from = old?.fading ?? 0, to = Number(getComputedStyle(element).opacity);
      const frames = travelFrames(old ? remainingTravel(points, old) : points, now).map((frame) => ({ ...frame, opacity: from + (to - from) * Number(frame.opacity) }));
      animations.push(element.animate(frames, timing));
      continue;
    }
    if (old) {
      // A tile still fading in when interrupted continues from its opacity.
      const fading = old.fading !== null;
      const dx = old.x - now.x, dy = old.y - now.y;
      const resized = Math.abs(old.width - now.width) >= 0.5 || Math.abs(old.height - now.height) >= 0.5;
      if (!fading && !resized && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const fade: Keyframe[] = fading ? [{ opacity: old.fading! }, { opacity: getComputedStyle(element).opacity }] : [{}, {}];
      const size: Keyframe[] = resized ? [{ width: `${old.width}px`, height: `${old.height}px` }, { width: `${now.width}px`, height: `${now.height}px` }] : [{}, {}];
      animations.push(element.animate([
        { transform: `translate(${dx}px, ${dy}px)`, ...size[0], ...fade[0] },
        { transform: "translate(0, 0)", ...size[1], ...fade[1] },
      ], timing));
    } else {
      const enter = enterOffset(orientation);
      animations.push(element.animate([{ opacity: 0, transform: `translate(${enter.x}px, ${enter.y}px)` }, { opacity: 1, transform: "translate(0, 0)" }], timing));
    }
  }
  // Junctions move only where their connectors morph; otherwise a dot would
  // slide while its connectors had already snapped (engines without `d`).
  for (const { dot, at, opacity } of dots) {
    const old = before.junctions.get(dot.dataset.junction!);
    if (!old) { animations.push(dot.animate([{ opacity: 0 }, { opacity }], timing)); continue; }
    const fading = old.fading !== null;
    const moved = Math.abs(old.x - at.x) >= 0.5 || Math.abs(old.y - at.y) >= 0.5;
    if (!fading && !moved) continue;
    const fade: Keyframe[] = fading ? [{ opacity: old.fading! }, { opacity }] : [{}, {}];
    if (morph && moved) animations.push(dot.animate([{ cx: `${old.x}px`, cy: `${old.y}px`, ...fade[0] }, { cx: `${at.x}px`, cy: `${at.y}px`, ...fade[1] }], timing));
    else if (fading) animations.push(dot.animate(fade, timing));
  }
  // A connector that is new here takes over one that vanished from the same
  // source (a trunk regrouped by a relayout, say): it morphs from that shape,
  // or simply stays put where shapes do not morph, rather than fading in.
  const successors = bandRoutes ? new Map<string, string>() : inherit(connectors, before);
  // Keyframes never set an existing connector's opacity, so its lineage
  // dimming (a class) holds throughout; new connectors fade in to it.
  for (const { path, id, opacity, target } of connectors) {
    if (bandRoutes) {
      const targetPath = path.getAttribute("d") ?? "";
      const oldPath = before.routePaths.get(id);
      // Keep one exact topology and move its child side rigidly, stretching
      // orthogonal channels only. Both engines use the same held tile clock;
      // CSS d interpolation is deliberately bypassed for grid-owned bands.
      const fixedCover = path.dataset.from?.startsWith("node:") && !current.has(path.dataset.from.slice(5));
      const endpointShift = (endpoint: string | undefined): Point => {
        if (endpoint?.startsWith("junction:")) {
          const old = before.junctions.get(endpoint.slice(9)), now = dots.find(({ dot }) => dot.dataset.junction === endpoint.slice(9))?.at;
          return old && now ? { x: old.x - now.x, y: old.y - now.y } : enterOffset(orientation);
        }
        const key = endpoint?.slice(5) ?? "", old = before.tiles.get(key), now = current.get(key);
        return old && now ? { x: old.x - now.x, y: old.y - now.y } : now ? enterOffset(orientation) : { x: 0, y: 0 };
      };
      const enteringPath = oldPath ? null : moveOrthogonalRoute(targetPath, endpointShift(path.dataset.from),
        path.dataset.from === path.dataset.to ? enterOffset(orientation) : endpointShift(path.dataset.to));
      const route = orthogonalRouteTravel(oldPath ?? enteringPath ?? "", targetPath, fixedCover ? childTop : undefined);
      const shown = before.routeIds.get(id);
      // A route without a safe stretch channel stays hidden until its tiles
      // settle; snapping it while the tiles move can put it through a tile.
      const frames = !route ? [{ opacity: 0 }, { opacity: 0 }]
        : shown !== null ? [{ opacity: shown ?? 0 }, { opacity }] : [{}, {}];
      if (oldPath !== targetPath || shown !== null && shown !== undefined) {
        const animation = path.animate(frames, timing);
        let written = "";
        driveGeometry(animation, progress => { written = route?.(progress) ?? targetPath; path.setAttribute("d", written); }, () => {
          if (path.getAttribute("d") === written) path.setAttribute("d", targetPath);
        }, displayedProgress);
        animations.push(animation);
      }
      continue;
    }
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
    const start = target ? before.routes.get(heir ?? id) ?? (shown === undefined ? displacedRoute(target, path, before, current, enterOffset(orientation)) : null) : null;
    // An unchanged connector keeps its exact curve rather than morphing as a polyline.
    if (start && target && !sameShape(start, target)) { from.d = `path("${polyline(start)}")`; to.d = `path("${polyline(target)}")`; }
    if (start && target && !sameShape(start, target) && !nativeMorph) {
      delete from.d; delete to.d;
      animations.push(morphRoute(path, start, target, [from, to], timing, displayedProgress));
    } else if (Object.keys(from).length) animations.push(path.animate([from, to], timing));
  }

  // 3. What left the graph fades out where it was displayed.
  const inherited = new Set(successors.values());
  const present = new Set(connectors.map(({ id }) => id));
  const presentDots = new Set(dots.map(({ dot }) => dot.dataset.junction!));
  const sharedTiles = [...current].flatMap(([key, box]) => {
    const old = before.tiles.get(key);
    return old ? [{ box, old, dx: box.x - old.x, dy: box.y - old.y }] : [];
  });
  const shift = sharedTiles[0] ? { x: sharedTiles[0].dx, y: sharedTiles[0].dy } : { x: 0, y: 0 };
  const departureTravel = bandRoutes ? { shift, progress: displayedProgress, childTop: childTop.before, beforeSize: before, afterSize: size,
    rigid: sharedTiles.every(({ box, old, dx, dy }) => Math.abs(dx - shift.x) < .5 && Math.abs(dy - shift.y) < .5 && box.width <= old.width + .5 && box.height <= old.height + .5),
    fixed: new Set([...before.routeSources.values()].filter(({ from }) => from.startsWith("node:") && !before.tiles.has(from.slice(5))).map(({ from }) => from)),
  } : undefined;
  animations.push(...departures(canvas, before, { tiles: new Set(current.keys()), routes: present, dots: presentDots }, {
    tiles: [...before.elements.tiles].filter(([key]) => !current.has(key)),
    // A connector that handed its shape to a successor morphs instead.
    paths: morph ? [...before.elements.paths].filter(([id]) => !present.has(id) && !inherited.has(id)) : [],
    dots: morph ? [...before.elements.dots].filter(([id]) => !presentDots.has(id)) : [],
  }, timing, departureTravel));
  for (const animation of animations) animation.startTime = started;
  return animations;
}

/** SVG attribute fallback shares WAAPI's easing, interruption and lifetime. */
function driveGeometry(animation: Animation, write: (progress: number) => void, restore: () => void, displayedProgress?: () => number): void {
  let frame = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    restore();
  };
  const sample = () => {
    if (finished) return;
    const progress = displayedProgress?.() ?? animation.effect?.getComputedTiming().progress;
    if (progress !== null && progress !== undefined) write(progress);
    if (animation.playState !== "finished" && animation.playState !== "idle") frame = requestAnimationFrame(sample);
    else finish();
  };
  write(0);
  frame = requestAnimationFrame(sample);
  const cancel = animation.cancel.bind(animation);
  animation.cancel = () => { finish(); cancel(); };
  animation.finished.then(finish, finish);
}

/** SVG d is not a CSS property in WebKit; morph its attribute alongside the tiles. */
function morphRoute(path: SVGPathElement, from: readonly Point[], to: readonly Point[], frames: Keyframe[], timing: KeyframeAnimationOptions, displayedProgress?: () => number): Animation {
  const target = path.getAttribute("d") ?? "";
  const animation = path.animate(frames, timing);
  let written = "";
  driveGeometry(animation, progress => {
    written = polyline(interpolatePath(from, to, progress)); path.setAttribute("d", written);
  }, () => {
    // A subsequent Svelte commit may already have replaced the attribute.
    if (path.getAttribute("d") === written) path.setAttribute("d", target);
  }, displayedProgress);
  return animation;
}

/** Marks an inert copy of a departed element; specs and snapshots never see it as content. */
const GHOST = "data-motion-ghost";
/** Beyond this many departures at once, they vanish instead (the copies would cost more than a frame). */
const GHOST_LIMIT = 200;
const IDENTITY = ["data-tile-key", "data-node-key", "data-route", "data-from", "data-to", "data-junction", "id"];
/** The animation currently fading each copy; only that one may remove it. */
const fades = new WeakMap<Element, Animation>();
let departureClipSerial = 0;
/** What each copy stands for, so content that returns can take over from it. */
type Identity = { kind: "tile" | "junction"; id: string } | { kind: "route"; id: string; from: string; to: string };
const identities = new WeakMap<Element, Identity>();

function ghostOf<T extends Element>(element: T, identity: Identity): T {
  const ghost = element.cloneNode(true) as T;
  identities.set(ghost, identity);
  for (const node of [ghost, ...ghost.querySelectorAll("*")]) for (const name of IDENTITY) node.removeAttribute(name);
  ghost.setAttribute(GHOST, "");
  // Junction dots take pointer events themselves; a copy never does.
  (ghost as unknown as ElementCSSInlineStyle).style.pointerEvents = "none";
  return ghost;
}

function fadeOut(element: Element & ElementCSSInlineStyle, layer: Element, opacity: number, timing: KeyframeAnimationOptions, shift?: Point, until = 1): Animation {
  layer.append(element);
  const animation = element.animate(shift ? [
    { opacity, transform: "translate(0, 0)" }, { opacity: 0, transform: `translate(${shift.x}px, ${shift.y}px)` },
  ] : until <= 0 ? [{ opacity: 0 }, { opacity: 0 }]
    : [{ opacity, offset: 0 }, { opacity: 0, offset: until }, { opacity: 0, offset: 1 }], timing);
  // Once the fade ends the copy stays transparent until it is removed.
  element.style.opacity = "0";
  fades.set(element, animation);
  const remove = () => { if (fades.get(element) === animation) { fades.delete(element); element.remove(); } };
  animation.finished.then(remove, remove);
  return animation;
}

/** Fades out copies of departed tiles, connectors and junctions, and continues fades an interruption caught. */
function departures(canvas: HTMLElement, before: GraphSnapshot, present: { tiles: ReadonlySet<string>; routes: ReadonlySet<string>; dots: ReadonlySet<string> }, gone: {
  tiles: readonly [string, HTMLElement][]; paths: readonly [string, SVGPathElement][]; dots: readonly [string, SVGCircleElement][];
}, timing: KeyframeAnimationOptions, travel?: {
  readonly shift: Point; readonly childTop: number; readonly rigid: boolean;
  readonly beforeSize: { width: number; height: number }; readonly afterSize: { width: number; height: number };
  readonly fixed: ReadonlySet<string>; readonly progress: (() => number) | undefined;
}): Animation[] {
  // Svelte renders both layers empty and never touches their children.
  const tileLayer = canvas.querySelector<HTMLElement>(":scope > [data-motion-ghosts]");
  const edgeLayer = canvas.querySelector<SVGGElement>("svg [data-motion-ghosts]");
  if (!tileLayer || !edgeLayer) return [];
  const animations: Animation[] = [];
  const firstDeparting = Math.min(...gone.tiles.flatMap(([key]) => {
    const box = before.tiles.get(key)!; return box.fading === null || box.fading > .01 ? [box.y] : [];
  }), ...before.ghosts.flatMap(({ identity, opacity }) => identity?.kind === "tile" && opacity > .01 && !present.tiles.has(identity.id) ? [before.tiles.get(identity.id)!.y] : []));
  const until = travel && Number.isFinite(firstDeparting)
    ? departureVisibility(travel.beforeSize.height, travel.afterSize.height, firstDeparting, travel.shift.y) : 1;
  if (travel && gone.tiles.length + gone.paths.length + gone.dots.length + before.ghosts.length) {
    // Only copies are clipped to the shrinking canvas; retained content stays
    // whole. This is the same reclaimed space that moves the ordinary rows.
    tileLayer.style.overflow = "hidden";
    const clip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
    clip.id = `trace-departure-${++departureClipSerial}`;
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    clip.append(rect); edgeLayer.ownerSVGElement!.append(clip);
    edgeLayer.style.clipPath = `url(#${clip.id})`;
    const animation = edgeLayer.animate([{}, {}], timing);
    driveGeometry(animation, progress => {
      rect.setAttribute("width", String(travel.beforeSize.width + (travel.afterSize.width - travel.beforeSize.width) * progress));
      rect.setAttribute("height", String(travel.beforeSize.height + (travel.afterSize.height - travel.beforeSize.height) * progress));
    }, () => { if (edgeLayer.style.clipPath.includes(clip.id)) edgeLayer.style.clipPath = ""; clip.remove(); }, travel.progress);
    animations.push(animation);
  }
  const routeUntil = (identity: Identity | undefined): number => {
    if (!travel || identity?.kind !== "route") return until;
    const children = [identity.from, identity.to].flatMap(endpoint => {
      const key = endpoint.startsWith("node:") ? endpoint.slice(5) : "", box = before.tiles.get(key);
      return box && !present.tiles.has(key) ? [box.y] : [];
    });
    return children.length ? Math.min(...children.map(top => departureVisibility(travel.beforeSize.height, travel.afterSize.height, top, travel.shift.y))) : until;
  };
  const followDot = (dot: SVGCircleElement, identity: Identity | undefined, animation: Animation) => {
    if (!travel || identity?.kind !== "junction") return;
    const at = before.junctions.get(identity.id)!;
    driveGeometry(animation, progress => {
      dot.setAttribute("cx", String(at.x + travel.shift.x * progress));
      dot.setAttribute("cy", String(at.y + travel.shift.y * progress));
    }, () => {}, travel.progress);
  };
  // Retiring routes follow the same rigid child scene as retiring tiles.
  // Fixed-cover stems stretch only above the child row. An incompatible
  // relayout has no safe old scene to draw, so those routes remain hidden.
  const followRoute = (path: SVGPathElement, identity: Identity | undefined, animation: Animation) => {
    if (!travel || identity?.kind !== "route") return;
    const move = prepareOrthogonalRoute(path.getAttribute("d") ?? "", travel.fixed.has(identity.from) ? travel.childTop : Infinity);
    const from = travel.fixed.has(identity.from) ? { x: 0, y: 0 } : travel.shift;
    if (!travel.rigid || !move || move(from, travel.shift) === null) {
      (animation.effect as KeyframeEffect).setKeyframes([{ opacity: 0 }, { opacity: 0 }]);
      return;
    }
    driveGeometry(animation, progress => {
      path.setAttribute("d", move({ x: from.x * progress, y: from.y * progress }, { x: travel.shift.x * progress, y: travel.shift.y * progress })!);
    }, () => {}, travel.progress);
  };
  const returned = (identity: Identity | undefined) => !!identity
    && (identity.kind === "tile" ? present.tiles : identity.kind === "route" ? present.routes : present.dots).has(identity.id);
  for (const { element, opacity, identity } of before.ghosts) {
    // A copy whose original came back has handed over to it (see captureGraph).
    if (opacity <= 0.01 || returned(identity)) { fades.delete(element); element.remove(); continue; }
    if (identity?.kind === "tile") {
      const box = before.tiles.get(identity.id)!;
      Object.assign((element as HTMLElement).style, { left: `${box.x}px`, top: `${box.y}px`, transform: "none" });
    } else if (identity?.kind === "route") element.setAttribute("d", before.routePaths.get(identity.id) ?? element.getAttribute("d") ?? "");
    const animation = fadeOut(element as Element & ElementCSSInlineStyle, element instanceof SVGElement ? edgeLayer : tileLayer, opacity, timing, identity?.kind === "tile" ? travel?.shift : undefined, element instanceof SVGPathElement ? routeUntil(identity) : element instanceof SVGElement ? until : 1);
    if (element instanceof SVGPathElement) followRoute(element, identity, animation);
    if (element instanceof SVGCircleElement) followDot(element, identity, animation);
    animations.push(animation);
  }
  if (gone.tiles.length + gone.paths.length + gone.dots.length > GHOST_LIMIT) return animations;
  for (const [key, element] of gone.tiles) {
    const box = before.tiles.get(key)!;
    const ghost = ghostOf(element, { kind: "tile", id: key });
    Object.assign(ghost.style, { left: `${box.x}px`, top: `${box.y}px`, transform: "none" });
    animations.push(fadeOut(ghost, tileLayer, box.fading ?? 1, timing, travel?.shift));
  }
  for (const [id, path] of gone.paths) {
    const ghost = ghostOf(path, { kind: "route", id, from: path.dataset.from ?? "", to: path.dataset.to ?? "" });
    const shape = before.routePaths.get(id);
    if (shape) ghost.setAttribute("d", shape);
    ghost.setAttribute("data-motion-route", id);
    const animation = fadeOut(ghost, edgeLayer, before.routeSources.get(id)?.opacity ?? 1, timing, undefined, routeUntil(identities.get(ghost)));
    followRoute(ghost, identities.get(ghost), animation);
    animations.push(animation);
  }
  for (const [id, dot] of gone.dots) {
    const at = before.junctions.get(id)!;
    const ghost = ghostOf(dot, { kind: "junction", id });
    ghost.setAttribute("cx", String(at.x));
    ghost.setAttribute("cy", String(at.y));
    const animation = fadeOut(ghost, edgeLayer, at.fading ?? 1, timing, undefined, until);
    followDot(ghost, identities.get(ghost), animation);
    animations.push(animation);
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

const exactRoute = (path: SVGPathElement): string => {
  const live = getComputedStyle(path).getPropertyValue("d");
  return live && live !== "none" ? live.replace(/^path\(["']|["']\)$/g, "") : path.getAttribute("d") ?? "";
};
const sameShape = (a: readonly Point[], b: readonly Point[]) =>
  a.length === b.length && a.every((point, index) => Math.abs(point.x - b[index].x) < 0.25 && Math.abs(point.y - b[index].y) < 0.25);

/** A new connector starts where its endpoints were, then moves with them. */
function displacedRoute(target: readonly Point[], path: SVGPathElement, before: GraphSnapshot, current: ReadonlyMap<string, Box>, enter: Point): Point[] {
  const shift = (endpoint: string | undefined, source: boolean, at: Point): Point => {
    if (!endpoint) return enter;
    if (endpoint.startsWith("junction:")) {
      const old = before.junctions.get(endpoint.slice(9));
      return old ? { x: old.x - at.x, y: old.y - at.y } : { x: 0, y: 0 };
    }
    const key = endpoint.slice(5);
    const old = before.tiles.get(key), now = current.get(key);
    if (!old || !now) return enter;
    return { x: old.x + old.width / 2 - (now.x + now.width / 2), y: source ? old.y + old.height - (now.y + now.height) : old.y - now.y };
  };
  return displace(target, shift(path.dataset.from, true, target[0]), shift(path.dataset.to, false, target.at(-1)!));
}

/** Infinite spinners never keep geometry sampling or navigation waiting. */
export const viewMoving = (scroller: HTMLElement): boolean => scroller.getAnimations({ subtree: true }).some((animation) =>
  (animation.pending || animation.playState === "running") && animation.effect?.getTiming().iterations !== Infinity);

const anchorOffsets = new WeakMap<Element, { top: number; left: number }>();

/**
 * Whether a scroll event only reports an offset the anchor hold set itself, as
 * opposed to a user scroll, so other listeners (the tooltip) can ignore it.
 */
export function isAnchorScroll(target: EventTarget | null): boolean {
  const set = target instanceof Element ? anchorOffsets.get(target) : undefined;
  return !!target && !!set && !releasesAnchor({ type: "scroll", actual: (target as Element).scrollTop, expected: set.top })
    && !releasesAnchor({ type: "scroll", actual: (target as Element).scrollLeft, expected: set.left });
}

export interface AnchorHold { update(): void; release(): void }

/**
 * Capture before changing selection. One frame loop samples all finite view
 * motion (WAAPI drives the animations); commits/toggles wake it via update.
 * Idle motion leaves the anchor valid without a frame or a pending promise.
 */
export function holdAnchor(scroller: HTMLElement, element: HTMLElement, onRelease: () => void = () => {}, onLayoutChange?: () => void): AnchorHold {
  const before = element.getBoundingClientRect();
  const horizontal = element.closest<HTMLElement>("[data-horizontal-scroll]");
  let expectedTop = scroller.scrollTop, expectedLeft = horizontal?.scrollLeft ?? 0;
  let frame = 0;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    anchorOffsets.delete(scroller);
    if (horizontal) anchorOffsets.delete(horizontal);
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLL) scroller.removeEventListener(type, onInput, true);
    scroller.removeEventListener("scroll", onScroll, true);
    observer.disconnect();
    resize.disconnect();
    onRelease();
  };
  const onInput = (event: Event) => {
    if (event.type === "keydown") {
      if (releasesAnchor({ type: "keydown", key: (event as KeyboardEvent).key })) release();
    } else if (event.type === "pointerdown") {
      // Content clicks can toggle sections while retaining the anchor. A
      // classic scrollbar is outside the target scroller's client area.
      const target = event.target;
      if (target !== scroller && target !== horizontal) return;
      const container = target as HTMLElement, box = container.getBoundingClientRect(), zoom = zoomOf(container, box);
      const { clientX: x, clientY: y } = event as PointerEvent;
      const left = box.left + container.clientLeft * zoom, top = box.top + container.clientTop * zoom;
      if (releasesAnchor({ type: "pointerdown", scrollbar: x < left || x >= left + container.clientWidth * zoom || y < top || y >= top + container.clientHeight * zoom })) release();
    } else release();
  };
  const movedByOther = () => {
    // Removing content can clamp scrolling as part of layout, before we can
    // adjust. Use that actual offset to compute the remaining displacement;
    // the anchor may already be satisfied, or still be reachable from there.
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (expectedTop > maxTop && !releasesAnchor({ type: "scroll", actual: scroller.scrollTop, expected: maxTop })) expectedTop = scroller.scrollTop;
    if (horizontal) {
      const maxLeft = Math.max(0, horizontal.scrollWidth - horizontal.clientWidth);
      if (expectedLeft > maxLeft && !releasesAnchor({ type: "scroll", actual: horizontal.scrollLeft, expected: maxLeft })) expectedLeft = horizontal.scrollLeft;
    }
    return releasesAnchor({ type: "scroll", actual: scroller.scrollTop, expected: expectedTop })
      || (!!horizontal && releasesAnchor({ type: "scroll", actual: horizontal.scrollLeft, expected: expectedLeft }));
  };
  const onScroll = (event: Event) => { if ((event.target === scroller || event.target === horizontal) && movedByOther()) release(); };
  const changed = () => {
    if (!held) return;
    if (!scroller.contains(element)) { release(); return; }
    if (onLayoutChange) onLayoutChange(); else update();
  };
  // An idle anchor must also survive index/placeholder/header changes, without
  // waiting for the next worker commit. Observe only current section roots;
  // rebuilding on structural changes drops removed section references.
  const resize = new ResizeObserver(changed);
  const observeSizes = () => {
    resize.disconnect();
    resize.observe(scroller);
    for (const child of scroller.children) resize.observe(child);
  };
  const observer = new MutationObserver((records) => {
    if (!held) return;
    if (records.some((record) => record.type === "childList" && record.target === scroller)) observeSizes();
    changed();
  });
  observer.observe(scroller, { childList: true, subtree: true, attributes: true, characterData: true });
  observeSizes();
  for (const type of USER_SCROLL) scroller.addEventListener(type, onInput, { passive: true, capture: true });
  scroller.addEventListener("scroll", onScroll, { passive: true, capture: true });
  const adjust = () => {
    if (!held) return;
    if (!scroller.contains(element) || movedByOther()) { release(); return; }
    // Rects may be in zoomed pixels; scroll offsets are in the scroller's own.
    const box = element.getBoundingClientRect();
    const zoom = zoomOf(scroller);
    const dy = anchorDelta(before.top, box.top, zoom), dx = anchorDelta(before.left, box.left, zoom);
    const requestedTop = expectedTop + dy;
    if (dy) scroller.scrollTop = requestedTop;
    expectedTop = scroller.scrollTop;
    const requestedLeft = expectedLeft + dx;
    if (horizontal && dx) horizontal.scrollLeft = requestedLeft;
    expectedLeft = horizontal?.scrollLeft ?? 0;
    if (dy) anchorOffsets.set(scroller, { top: scroller.scrollTop, left: scroller.scrollLeft });
    if (horizontal && dx) anchorOffsets.set(horizontal, { top: horizontal.scrollTop, left: horizontal.scrollLeft });
    // Horizontal preservation is best effort: a graph can move sideways even
    // when its section has no horizontal overflow. That must not end the hold
    // on the view's vertical scroll axis.
    if (releasesAnchor({ type: "adjustment", actual: expectedTop, requested: requestedTop })) release();
  };
  const schedule = () => { if (held && !frame && viewMoving(scroller)) frame = requestAnimationFrame(step); };
  const step = () => {
    frame = 0;
    adjust();
    schedule();
  };
  const update = () => { adjust(); schedule(); };
  update();
  return { update, release };
}

/** Input that may mean the user is scrolling (or about to) themselves; see `scrollsByUser`. */
export const USER_SCROLL = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
/** A held modifier (auto-repeating during a Ctrl- or Shift-click) is not scrolling. */
export const scrollsByUser = (event: Event) => !(event instanceof KeyboardEvent && MODIFIERS.has(event.key));

/** Expanding and collapsing a section (≈160 ms, ease-out). */
export const SECTION_MS = 160;
const SECTION_EASING = "cubic-bezier(.2,.8,.2,1)";

/** The bottom inset of a computed `inset()` clip path (1–4 lengths, optional `round`), or 0. */
export function insetBottom(clip: string): number {
  const match = /^inset\(([^)]*)\)$/.exec(clip.trim());
  if (!match) return 0;
  const lengths = match[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map(parseFloat);
  if (lengths.some((value) => !Number.isFinite(value))) return 0;
  // CSS box shorthand: top [right [bottom [left]]]; bottom defaults to top.
  return lengths.length >= 3 ? lengths[2] : lengths[0] ?? 0;
}

/** An element's layout height in its own CSS pixels, unrounded (unlike `offsetHeight`). */
export function layoutHeight(element: HTMLElement): number {
  return element.getBoundingClientRect().height / zoomOf(element);
}

/** A section's displayed height, in its own pixels: its layout height less a running reveal clip. */
export function sectionHeight(section: HTMLElement): number {
  return layoutHeight(section) - insetBottom(getComputedStyle(section).clipPath);
}

export interface SectionResize {
  /** Displayed height and content opacity now. */
  readonly from: { readonly height: number; readonly opacity: number };
  /** Displayed height at the end. */
  readonly to: number;
  readonly opening: boolean;
  /**
   * How far the view will scroll back when the collapsed content is removed
   * (the scroll position no longer fits). Everything slides down by it while
   * collapsing, so the clamp at the end moves nothing.
   */
  readonly settle: number;
}

/**
 * Resizes a section's displayed height without animating layout: the section
 * keeps its current layout height (the larger one) and is revealed or hidden
 * by a clip, its content fades, and the elements around it slide — clip,
 * opacity and transform only, so no frame relayouts. Heights never exceed the
 * layout height. Collapsing holds the final frame (`fill: forwards`) until
 * the caller removes the content and cancels.
 */
export function resizeSection(section: HTMLElement, content: HTMLElement | null, { from, to, opening, settle }: SectionResize): Animation[] {
  const layout = layoutHeight(section);
  const radius = parseFloat(getComputedStyle(section).borderBottomLeftRadius) || 0;
  const timing: KeyframeAnimationOptions = { duration: SECTION_MS, easing: SECTION_EASING, fill: opening ? "none" : "forwards" };
  const clip = (height: number) => `inset(0px 0px ${Math.max(0, layout - height)}px 0px round ${radius}px)`;
  const animations = [section.animate([{ clipPath: clip(from.height) }, { clipPath: clip(to) }], timing)];
  if (content) animations.push(content.animate([{ opacity: from.opacity }, { opacity: opening ? 1 : 0 }], timing));
  // Offsets add up, so sections resizing at the same time each move what is around them.
  const slide: KeyframeAnimationOptions = { ...timing, composite: "add" };
  const move = (element: Element, start: number, end: number) => {
    if (element instanceof HTMLElement && (Math.abs(start) >= 0.01 || Math.abs(end) >= 0.01)) {
      animations.push(element.animate([{ transform: `translateY(${start}px)` }, { transform: `translateY(${end}px)` }], slide));
    }
  };
  if (settle > 0) for (let previous: Element | null = section; previous; previous = previous.previousElementSibling) move(previous, 0, settle);
  for (let next = section.nextElementSibling; next; next = next.nextElementSibling) move(next, from.height - layout, to - layout + settle);
  return animations;
}

/** Grid FLIP captures the displayed geometry before any animation is cancelled. */
export interface GridSnapshot {
  readonly top: number;
  readonly left: number;
  readonly cells: ReadonlyMap<string, { y: number; x: number; destination: string }>;
  readonly rowBands: ReadonlyMap<string, { y: number; height: number; destination: string }>;
  readonly bands: ReadonlyMap<string, { y: number; element: HTMLElement; height: number; graph: GraphSnapshot | null; stamp: string | undefined; attachment: string | undefined; opacity: number }>;
}
const gridDestination = (element: HTMLElement) => JSON.stringify([element.style.left, element.style.top, element.style.width, element.style.height]);

export function captureGrid(grid: HTMLElement): GridSnapshot {
  const origin = grid.getBoundingClientRect(), zoom = zoomOf(grid, origin);
  return {
    top: origin.top, left: origin.left,
    cells: new Map([...grid.querySelectorAll<HTMLElement>("[data-grid-motion]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return [element.dataset.gridMotion!, { x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, destination: gridDestination(element) }];
    })),
    rowBands: new Map([...grid.querySelectorAll<HTMLElement>("[data-grid-row-band]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return [element.dataset.gridRowBand!, { y: (rect.top - origin.top) / zoom, height: rect.height / zoom, destination: gridDestination(element) }];
    })),
    bands: new Map([...grid.querySelectorAll<HTMLElement>("[data-grid-band], [data-grid-exit]")].map((element) => {
      const graph = element.querySelector<HTMLElement>(".graph");
      const opacity = Number(getComputedStyle(element).opacity);
      const captured = graph ? captureGraph(graph) : null;
      const scene = captured && element.dataset.gridExit ? {
        ...captured,
        tiles: new Map([...captured.tiles].map(([key, box]) => [key, { ...box, fading: Number(getComputedStyle(captured.elements.tiles.get(key)!).opacity) * opacity }])),
        routeIds: new Map([...captured.routeSources].map(([key, value]) => [key, value.opacity * opacity])),
        routeSources: new Map([...captured.routeSources].map(([key, value]) => [key, { ...value, opacity: value.opacity * opacity }])),
        junctions: new Map([...captured.junctions].map(([key, at]) => [key, { ...at, fading: (at.fading ?? 1) * opacity }])),
      } : captured;
      return [element.dataset.gridBand ?? element.dataset.gridExit!, {
        y: (element.getBoundingClientRect().top - origin.top) / zoom, element, height: layoutHeight(element), opacity,
        graph: scene, stamp: graph?.dataset.layoutStamp, attachment: graph?.dataset.attachment,
      }];
    })),
  };
}
export function playGrid(grid: HTMLElement, before: GridSnapshot, running: readonly Animation[] = []): Animation[] {
  const reduced = prefersReducedMotion();
  const started = document.timeline.currentTime;
  const origin = grid.getBoundingClientRect(), zoom = zoomOf(grid, origin);
  const scrollShift = { x: (before.left - origin.left) / zoom, y: (before.top - origin.top) / zoom };
  const unchangedRows = new Set([...grid.querySelectorAll<HTMLElement>("[data-grid-motion], [data-grid-row-band]")].filter(element => {
    const old = element.dataset.gridMotion ? before.cells.get(element.dataset.gridMotion) : before.rowBands.get(element.dataset.gridRowBand!);
    return Math.abs(scrollShift.x) < .5 && Math.abs(scrollShift.y) < .5 && old?.destination === gridDestination(element);
  }));
  // A change elsewhere in the grid must not stop an attachment still travelling
  // to the same destination. Changed attachments capture their displayed state
  // above, then replace their animations; unchanged ones retain their owner.
  const unchanged = new Set([...grid.querySelectorAll<HTMLElement>("[data-grid-band] .graph")].filter((graph) => {
    const band = graph.closest<HTMLElement>("[data-grid-band]")!, old = before.bands.get(band.dataset.gridBand!);
    return old?.stamp === graph.dataset.layoutStamp && old?.attachment === graph.dataset.attachment;
  }));
  const carried: Animation[] = [];
  for (const animation of running) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    // Finished exits have removed their DOM; carrying them retains detached graphs.
    if (animation.playState === "finished" || animation.playState === "idle" || !target?.isConnected) continue;
    const exit = target instanceof Element ? target.closest<HTMLElement>("[data-grid-exit]") : null;
    if (!reduced && target instanceof Element && (unchangedRows.has(target as HTMLElement) || unchanged.has(target.closest<HTMLElement>(".graph")!) || (!!exit?.dataset.gridExit && !grid.querySelector(`[data-grid-band="${CSS.escape(exit.dataset.gridExit)}"]`)))) carried.push(animation);
    else animation.cancel();
  }
  for (const exit of grid.querySelectorAll<HTMLElement>("[data-grid-exit]")) if (reduced || grid.querySelector(`[data-grid-band="${CSS.escape(exit.dataset.gridExit!)}"]`)) exit.remove();
  if (reduced) return [];
  const timing = { duration: MOTION_MS, easing: EASING };
  // Removing a bottom band can clamp scrolling during layout. Include that
  // displacement so the displayed first frame still matches the snapshot.
  // Measure the new geometry before installing any animation.
  const cells = [...grid.querySelectorAll<HTMLElement>("[data-grid-motion]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, y: (rect.top - origin.top) / zoom, x: (rect.left - origin.left) / zoom };
  });
  const bands = [...grid.querySelectorAll<HTMLElement>("[data-grid-band]")];
  const animations: Animation[] = [...carried];
  for (const { element, y, x } of cells) {
    if (unchangedRows.has(element)) continue;
    const old = before.cells.get(element.dataset.gridMotion!);
    if (!old) continue;
    const dx = old.x - x + scrollShift.x, dy = old.y - y + scrollShift.y;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    // Sections, covers and ordinary rows share the band content’s timing.
    animations.push(element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], timing));
  }
  for (const element of grid.querySelectorAll<HTMLElement>("[data-grid-row-band]")) {
    if (unchangedRows.has(element)) continue;
    const old = before.rowBands.get(element.dataset.gridRowBand!);
    const height = layoutHeight(element), top = parseFloat(element.style.top);
    const from = old?.height ?? 0, y = old?.y ?? top;
    if (Math.abs(from - height) >= .5 || Math.abs(y - top) >= .5) animations.push(element.animate([
      { top: `${y + scrollShift.y}px`, height: `${from}px` }, { top: `${top}px`, height: `${height}px` },
    ], timing));
  }
  for (const element of bands) {
    const old = before.bands.get(element.dataset.gridBand!);
    const graph = element.querySelector<HTMLElement>(".graph");
    if (!graph || unchanged.has(graph)) continue;
    // The grid owns both layout and attachment changes of pinned graphs. Cancel
    // only after capturing the displayed scene, before measuring final targets.
    for (const animation of graph.getAnimations({ subtree: true })) if (animation.effect?.getTiming().iterations !== Infinity) animation.cancel();
    const snapshot = old?.graph ?? captureGraph(graph);
    const from = old?.graph ?? { ...snapshot, tiles: new Map(), routeIds: new Map(), routeSources: new Map(), routes: new Map(), routePaths: new Map(), junctions: new Map(),
      elements: { tiles: new Map(), paths: new Map(), dots: new Map() }, ghosts: [] };
    // New tiles emerge from their parents' side: above in a downward band, left in a sideways one.
    animations.push(...playGraph(graph, from, graph.dataset.orientation === "right" ? "right" : "down", undefined, true));
    if (!old?.graph || old.element.dataset.gridExit) {
      // Reveal only a newly opened group, within the space the rows are making.
      // Retained groups are never clipped, even when their packing line changes.
      const row = grid.querySelector<HTMLElement>(`[data-grid-row-band="${element.dataset.gridBandRow}"]`);
      const cover = element.closest<HTMLElement>("[data-grid-motion]")!;
      // Existing row space belongs to the retained groups travelling out of
      // this slot. Reveal a new group only as its own space becomes available;
      // otherwise its tiles appear across a retained group's moving stems.
      const available = row ? parseFloat(row.style.top) - parseFloat(cover.style.top) : 0;
      const height = layoutHeight(graph);
      if (height > available + .5) animations.push(graph.animate([
        { clipPath: `inset(0 0 ${height - available}px 0)` }, { clipPath: "inset(0)" },
      ], timing));
    }
  }
  // Only closing groups leave copies. Their clip shrinks with reclaimed space;
  // persistent groups never inherit a section reveal clip.
  for (const [id, old] of before.bands) {
    if (old.element.dataset.gridExit || bands.some((element) => element.dataset.gridBand === id)) continue;
    const exit = old.element.cloneNode(true) as HTMLElement;
    if (old.graph) {
      const graph = exit.querySelector<HTMLElement>(".graph");
      if (graph) Object.assign(graph.style, { width: `${old.graph.width}px`, height: `${old.graph.height}px`, clipPath: old.graph.clipPath });
      for (const element of exit.querySelectorAll<HTMLElement>("[data-tile-key]")) {
        const box = old.graph.tiles.get(element.dataset.tileKey!);
        if (box) Object.assign(element.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, transform: "none", opacity: String(box.fading ?? getComputedStyle(element).opacity) });
      }
      for (const path of exit.querySelectorAll<SVGPathElement>("[data-route]")) {
        const shape = old.graph.routePaths.get(path.dataset.route!);
        if (shape) path.setAttribute("d", shape);
        path.style.opacity = String(old.graph.routeSources.get(path.dataset.route!)?.opacity ?? 1);
      }
      for (const dot of exit.querySelectorAll<SVGCircleElement>("[data-junction]")) {
        const at = old.graph.junctions.get(dot.dataset.junction!);
        if (at) { dot.setAttribute("cx", String(at.x)); dot.setAttribute("cy", String(at.y)); dot.style.opacity = String(at.fading ?? 1); }
      }
    }
    // Keep SVG marker references local to this inert copy.
    const ids = new Map([...exit.querySelectorAll<HTMLElement>("[id]")].map(element => [element.id, `${element.id}-exit-${id.replace(/[^a-z0-9]/gi, "-")}`]));
    for (const element of exit.querySelectorAll("*")) for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name)!;
      if (name === "id") element.id = ids.get(value)!;
      else if (value.includes("url(#")) element.setAttribute(name, value.replace(/url\(#([^)]+)\)/g, (_, key: string) => `url(#${ids.get(key) ?? key})`));
    }
    for (const node of [exit, ...exit.querySelectorAll("*")]) for (const name of [...node.getAttributeNames()]) {
      if (name === "data-tile-key") { node.setAttribute("data-ghost-tile-key", node.getAttribute(name)!); node.removeAttribute(name); }
      else if (name.startsWith("data-") && !["data-route", "data-from", "data-to", "data-junction", "data-motion-ghosts"].includes(name)) node.removeAttribute(name);
    }
    exit.dataset.gridExit = id;
    exit.inert = true;
    exit.setAttribute("aria-hidden", "true");
    Object.assign(exit.style, { top: `${old.y + scrollShift.y}px`, pointerEvents: "none" });
    grid.append(exit);
    const animation = exit.animate([{ opacity: old.opacity, clipPath: "inset(0)" }, { opacity: 0, clipPath: `inset(0 0 ${old.height}px 0)` }], timing);
    // Children are clipped before their stems. Keep the parent fade for
    // interruption/reopening, but end edge visibility with the last child.
    const firstChild = old.graph ? Math.min(...[...old.graph.elements.tiles.keys()].flatMap(key => {
      const box = old.graph!.tiles.get(key)!; return box.fading === null || box.fading > .01 ? [box.y] : [];
    })) : 0;
    const gone = departureVisibility(old.height, 0, firstChild);
    for (const edge of exit.querySelectorAll<SVGElement>("svg.edges path, svg.edges circle")) {
      const opacity = Number(edge.style.opacity || 1);
      const target = edge.dataset.to?.startsWith("node:") ? old.graph?.tiles.get(edge.dataset.to.slice(5)) : undefined;
      const visible = target && (target.fading === null || target.fading > .01) ? departureVisibility(old.height, 0, target.y) : gone;
      animations.push(edge.animate(visible <= 0 ? [{ opacity: 0 }, { opacity: 0 }] : [{ opacity, offset: 0 }, { opacity: 0, offset: visible }, { opacity: 0, offset: 1 }], timing));
      edge.style.opacity = "0";
    }
    exit.style.opacity = "0";
    animation.finished.then(() => exit.remove(), () => exit.remove());
    animations.push(animation);
  }
  for (const animation of animations) if (!carried.includes(animation)) animation.startTime = started;
  return animations;
}
