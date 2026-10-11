<script lang="ts">
  /**
   * The Trace file view: replaces the pane's listing with one collapsible
   * stack per connected component in the folder grid alongside entries
   * without provenance. All view state (folder session, expansion, anchors)
   * belongs to this pane; selection and Preview go through the pane handle.
   */
  import { flushSync, onDestroy, tick, untrack } from "svelte";
  import type { FileViewPane, PreviewTarget } from "../../../../../integration/plugin-sdk";
  import type { FileEntry } from "$lib/domain/file";
  import { deselectGesture, inClientArea, scaledClientArea, type PointerPosition, type DeselectEvent, type DeselectGesture, type DeselectPointer } from "$lib/domain/deselect-click";
  import { parentDir, samePath } from "$lib/domain/path";
  import type { ComponentSummary, NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
  import { tileMetrics } from "$lib/domain/trace-graph/metrics";
  import { traceInvalidation } from "../invalidation.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { createFolderSession, type ComponentData, type FolderIndex, type FolderSession } from "./folder-session.svelte";
  import { tracePanes, isTraceTargetData, type TracePaneView } from "./pane-registry.svelte";
  import { NO_PICKS, clickListed, dropPick, followPicks, picksFromHost, pickOnly, pickable, replacePick, resolvePicks, selectionKey, settlePicks, togglePick, type PickLocation, type Picks } from "./input-picks";
  import { nodeTarget } from "./node-target";
  import { revealArtifactId } from "./reveal-target";
  import type { GraphScene } from "./graph-commit";
  import { findLoadedNode, locateTarget, unresolvedTargetComponents } from "./target-location";
  import { holdAnchor, zoomOf, scrollsByUser, USER_SCROLL, type AnchorHold, viewMoving } from "./motion";

  import StackGrid from "./StackGrid.svelte";
  import { selectableSelector } from "./selectable";
  import { folderCells } from "./stack-grid";

  interface Props { pane: FileViewPane; session?: FolderSession }
  let { pane, session: provided }: Props = $props();

  const session = untrack(() => provided) ?? createFolderSession(undefined, undefined, untrack(() => pane.paneId));
  /** Width is quantized so resizing does not relayout on every pixel. */
  const WIDTH_STEP = 16;
  /** Horizontal space reserved by the view's 10px pane padding. */
  const GRID_CHROME = 20;

  let scroller = $state<HTMLElement | null>(null);
  let clientWidth = $state(0);
  let near = $state.raw<ReadonlySet<string>>(new Set());
  /** A save into this folder waiting for the listing to contain its file; see `callbacks.saved`. */
  /**
   * Files this view just saved, by path, with the index read they predate. The host lists a saved file
   * before Trace's index maps it into its stack; until a newer read lands it is part of that stack, not
   * an ordinary file (which would duplicate the cover and shift every cell).
   */
  let claimed = $state.raw<ReadonlyMap<string, FolderIndex | null>>(new Map());
  const claimedPaths = $derived(new Set([...claimed].filter(([, since]) => since === session.index).map(([path]) => path)));
  let pendingSave = $state.raw<{ directory: string; path: string; key: NodeKey; picks: Picks } | null>(null);
  type ScrollAnchor = { key: NodeKey; componentId: string; ownsSelection: () => boolean };
  let anchor: ScrollAnchor | null = null;
  let releaseAnchor: (() => void) | null = null;
  let heldAnchor: AnchorHold | null = null;
  /** Bounded by mounted sections, with no promises or settlement waiters. */
  const pendingLayouts = new Set<string>();
  let anchorUpdateQueued = false;

  function updateHeldAnchor(): void {
    if (anchorUpdateQueued) return;
    anchorUpdateQueued = true;
    // All graphs in this render install their FLIP animations before measuring
    // the anchor. Measuring between their commit callbacks can see final DOM
    // geometry that the following callback is about to animate back.
    void tick().then(() => queueMicrotask(() => { anchorUpdateQueued = false; heldAnchor?.update(); }));
  }

  function releaseAnchors(): void {
    anchor = null;
    releaseAnchor?.();
    releaseAnchor = null;
    heldAnchor?.release();
    heldAnchor = null;
  }
  /** A repeat click can reuse a displayed scene's motion without waiting for a new focus/plan. */
  const committedScenes = new WeakMap<ComponentData, GraphScene>();
  type RevealOwner = { controller: AbortController; ownsSelection: () => boolean };
  let activeReveal: RevealOwner | null = null;
  let revealScene = $state.raw<RevealOwner | null>(null);
  let pendingReveal: { owner: RevealOwner; key: NodeKey; signal: AbortSignal; finish(error?: unknown): void } | null = null;

  function supersedeReveal(): void {
    activeReveal?.controller.abort(new DOMException("Trace reveal was superseded", "AbortError"));
    pendingReveal?.finish(new DOMException("Trace reveal was superseded", "AbortError"));
  }

  function checkReveal(owner: RevealOwner): void {
    owner.controller.signal.throwIfAborted();
    if (activeReveal !== owner || !owner.ownsSelection()) {
      owner.controller.abort(new DOMException("Trace reveal was superseded", "AbortError"));
      owner.controller.signal.throwIfAborted();
    }
  }

  /** A reveal finishes only once its focused tile has settled into the visible layout. */
  function awaitReveal(owner: RevealOwner, key: NodeKey): Promise<void> {
    const signal = owner.controller.signal;
    return new Promise((resolve, reject) => {
      const request = {
        owner, key, signal,
        finish: (error: unknown = undefined) => {
          if (pendingReveal === request) {
            pendingReveal = null;
            releaseAnchor?.();
            releaseAnchor = null;
          }
          signal.removeEventListener("abort", cancel);
          if (error !== undefined) reject(error); else resolve();
        },
      };
      const cancel = () => { releaseAnchors(); request.finish(signal.reason ?? new DOMException("Reveal aborted", "AbortError")); };
      pendingReveal = request;
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  const issuedTargets = new WeakMap<PreviewTarget, TraceNode>();

  const directory = $derived(pane.directory);
  const width = $derived(Math.max(0, Math.floor((clientWidth - GRID_CHROME) / WIDTH_STEP) * WIDTH_STEP));
  const revision = $derived(traceInvalidation.revision);
  // Trace tiles follow the host's tile-size setting for this pane; older hosts
  // (without the "tileSize" capability) leave it undefined: the default tile.
  const imagePx = $derived(pane.tileSize?.imagePx);
  const tile = $derived(tileMetrics(imagePx));
  const entriesByPath = $derived(new Map(pane.entries.map((entry) => [entry.path, entry])));

  // Session follows the pane's folder and Trace's invalidation signal.
  $effect(() => { const dir = directory; untrack(() => { supersedeReveal(); releaseAnchors(); session.setDirectory(dir); claimed = new Map(); }); });
  let seenRevision = untrack(() => traceInvalidation.revision);
  $effect(() => {
    const current = traceInvalidation.revision;
    if (current === seenRevision) return;
    seenRevision = current;
    untrack(() => void session.refresh());
  });

  const summaries = $derived<readonly ComponentSummary[]>(session.index?.components ?? []);
  const gridCells = $derived(session.index ? folderCells(pane.entries, session.index) : []);
  const stackKey = (id: string) => gridCells.find((cell) => cell.summary?.id === id)?.id ?? id;
  const openKeys = $derived(session.openStackKeys);
  $effect(() => {
    const choice = JSON.stringify([hostChoice, target?.id, pane.focusedPath]);
    const index = session.index;
    untrack(() => {
      if (!index) return;
      const ids = new Set(pane.selection.flatMap((entry) => { const member = session.componentOf(entry.path); return member ? [member.componentId] : []; }));
      if (focus) ids.add(focus.componentId);
      session.followSelection(choice, ids);
    });
  });

  // Focus: this pane's Trace preview target, otherwise the primary selected file.
  const target = $derived(pane.previewTarget);
  const targetData = $derived(target && isTraceTargetData(target.data) && samePath(target.data.directory, directory) ? target.data : null);
  const focus = $derived.by<{ key: NodeKey; componentId: string } | null>(() => {
    if (targetData) return { key: targetData.key, componentId: targetData.componentId };
    const path = pane.focusedPath;
    const member = path ? session.componentOf(path) : null;
    return member ? { key: member.key, componentId: member.componentId } : null;
  });
  const selectedKeys = $derived.by(() => {
    const keys = new Set<NodeKey>();
    for (const entry of pane.selection) { const member = session.componentOf(entry.path); if (member) keys.add(member.key); }
    const included = new Set(inputs);
    // The target is highlighted while it is an input (a Ctrl-click unpicks it), or when it cannot be one.
    const targetNode = targetData ? findNode(targetData.key, targetData.componentId)?.node : undefined;
    if (targetData && (!targetNode || !pickable(targetNode) || included.has(targetNode.path!))) keys.add(targetData.key);
    for (const extra of livePicks.extras) if (included.has(extra.path)) keys.add(extra.key);
    return keys;
  });
  const selectedPaths = $derived(new Set(pane.selection.map((entry) => entry.path)));

  /** The host selection's paths, in listing order. */
  const hostSelected = $derived(pane.selection.map((entry) => entry.path));
  /** The folder and the selected files as a set: a re-sort or listing refresh keeps it (see selectionKey). */
  const hostChoice = $derived(selectionKey(directory, hostSelected));
  /**
   * The ordered image selection, including images the host cannot select (see
   * input-picks). A change of the host's selected files starts it over from
   * the host selection; the view's own clicks assign it (see `commitPicks`).
   */
  let picks = $derived.by(() => { void hostChoice; return picksFromHost(untrack(() => hostSelected)); });
  /**
   * Where an extra's node is now, from current data only: a copy in data a
   * refresh skipped may be out of date (discarded since, say), so it is
   * "unknown" until reloaded, as is a node in no loaded component while some
   * component is not loaded fresh.
   */
  function locateExtra(key: NodeKey, preferred: string | undefined = undefined): PickLocation {
    const located = locateTarget(key, preferred ?? "", {
      listed: session.index ? new Set(summaries.map((summary) => summary.id)) : null,
      components: session.components, isStale: (id) => session.isStale(id),
    });
    return located === "gone" ? null : located;
  }
  /** The picks with their extras following their nodes (saved, discarded, gone, merged into another component). */
  const livePicks = $derived(followPicks(picks, locateExtra));
  /**
   * The components to keep loaded for the extras: each one's own component.
   * When that is gone (merged into another) or does not hold the node, every
   * component not loaded fresh, until the node is found and its pick follows.
   */
  const pickComponents = $derived.by(() => {
    const ids = new Set<string>();
    const listed = new Set(summaries.map((summary) => summary.id));
    for (const extra of livePicks.extras) {
      const own = extra.componentId;
      if (own && listed.has(own)) ids.add(own);
      for (const id of unresolvedTargetComponents(extra.key, own ?? "", {
        listed, components: session.components, isStale: (id) => session.isStale(id),
      })) ids.add(id);
    }
    // A Preview target may be unpickable (missing reference or placeholder),
    // so extras alone cannot resolve it after components merge or split.
    if (targetData) {
      const unresolved = unresolvedTargetComponents(targetData.key, targetData.componentId, {
        listed, components: session.components, isStale: (id) => session.isStale(id),
      });
      for (const id of unresolved) ids.add(id);
    }
    return ids;
  });
  /** The selected images in the order they were picked: Image 1…N of an AI edit. */
  const inputs = $derived(resolvePicks(livePicks, hostSelected));

  /**
   * Records the picks of one of the view's own interactions. Call it after the
   * host calls of that interaction, with picks computed from those before
   * them: reading `hostChoice` takes in the host's change first, so this
   * assignment is what `picks` holds until the host's selected files change
   * again. This relies on the host applying selection changes synchronously,
   * as the host's explorer state and the e2e harness do. The recorded picks
   * are always a new object (see settlePicks), and a save still waiting to
   * select its file yields to this newer choice.
   */
  function commitPicks(next: Picks): void {
    void hostChoice;
    picks = settlePicks(next, hostSelected);
    pendingSave = null;
  }

  /** Selects a listed file through the host and records it in the picks. */
  function selectListed(entry: FileEntry, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
    const click = clickListed(livePicks, entry.path, hostSelected, modifiers);
    if (click.host) pane.select(entry, modifiers);
    commitPicks(click.picks);
  }

  const isExpanded = (summary: ComponentSummary, index: number) =>
    openKeys.has(summary.coverKey);

  // Load what is expanded and near the viewport, and every component holding an
  // extra pick (so a pick in a collapsed section is checked against fresh
  // data); release the rest.
  $effect(() => {
    const picked = pickComponents;
    const wanted = summaries.filter((summary, index) => (isExpanded(summary, index) && near.has(summary.id)) || picked.has(summary.id) || session.openStackSearch.has(summary.id)).map((summary) => summary.id);
    untrack(() => {
      for (const summary of summaries) if (!wanted.includes(summary.id)) session.release(summary.id);
      for (const id of wanted) void session.ensure(id);
    });
  });

  function findNode(key: NodeKey, preferred: string | undefined = undefined): { node: TraceNode; componentId: string } | null {
    return findLoadedNode(key, session.components, preferred);
  }

  const fileEntry = (node: TraceNode): FileEntry | null =>
    node.scope === "current" && node.path && !node.temporary && !node.earlierRevision ? entriesByPath.get(node.path) ?? null : null;

  // How the view keeps the chosen tile in sight through the relayout it
  // causes: a click holds the tile where it was on screen; keyboard and
  // programmatic navigation reveal it once motion settles.
  function anchorTile(key: NodeKey, componentId: string | undefined = undefined): HTMLElement | null {
    const section = componentId ? scroller?.querySelector<HTMLElement>(`section[data-component="${CSS.escape(componentId)}"]`) : scroller;
    return section?.querySelector<HTMLElement>(selectableSelector(key)) ?? null;
  }
  // Holds compensate every section commit, including while the clicked graph
  // is still computing. Reveals alone wait for their committed motion.
  /** One cancellable reveal loop; readiness includes workers in sibling sections. */
  function whenReady(show: () => void): void {
    releaseAnchor?.();
    let frame = 0, live = true;
    const cancel = () => { live = false; cancelAnimationFrame(frame); };
    releaseAnchor = cancel;
    const step = () => {
      frame = 0;
      if (!live) return;
      if (!scroller) { cancel(); return; }
      if (pendingLayouts.size || viewMoving(scroller)) { frame = requestAnimationFrame(step); return; }
      cancel();
      if (releaseAnchor === cancel) releaseAnchor = null;
      show();
    };
    frame = requestAnimationFrame(step);
  }

  function keepAnchor(scene: GraphScene): void {
    updateHeldAnchor();
    if (!scene.isCurrent()) return;
    committedScenes.set(scene.data, scene);
    const data = scene.data;
    const request = pendingReveal;
    if (request && scene.reveal === request.owner && scene.focus === request.key && data.dag.nodes.has(request.key)
      && data === session.components.get(focus?.componentId ?? "")) {
      releaseAnchors();
      whenReady(() => {
        if (pendingReveal !== request || request.signal.aborted) return;
        try { checkReveal(request.owner); } catch (error) { request.finish(error); return; }
        if (focus?.key !== request.key) { supersedeReveal(); return; }
        const button = anchorTile(request.key, focus?.componentId);
        if (!button) { request.finish(new Error("Trace image could not be shown")); return; }
        button.scrollIntoView({ block: "nearest", inline: "nearest" });
        button.focus({ preventScroll: true });
        request.finish();
      });
      return;
    }
    const current = anchor;
    if (!current || !scroller || !current.ownsSelection() || !data.dag.nodes.has(current.key)
      || data !== session.components.get(current.componentId)) return;
    anchor = null;
    whenReady(() => {
      if (current.ownsSelection()) {
        const tile = anchorTile(current.key, current.componentId);
        tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
        tile?.focus({ preventScroll: true });
      }
    });
  }

  // Input cancels pending reveals; an active hold applies its own scroll-input
  // rules so section content clicks can retain it while toggling a section.
  $effect(() => {
    const element = scroller;
    if (!element) return;
    const cancel = (event: Event) => { if (scrollsByUser(event)) { anchor = null; releaseAnchor?.(); releaseAnchor = null; supersedeReveal(); } };
    for (const type of USER_SCROLL) element.addEventListener(type, cancel, { passive: true, capture: true });
    return () => { for (const type of USER_SCROLL) element.removeEventListener(type, cancel, { capture: true }); };
  });

  // A save claims the selection only if the selection is unchanged since the
  // save began, so a slow save never overrides a newer choice.
  const selectionStamp = () => JSON.stringify([target?.id ?? null, pane.focusedPath, hostChoice]);
  const captureSelection = () => {
    const stamp = selectionStamp(), before = picks;
    // A new pick (a Ctrl-click on an unsaved image, say) is a newer choice too.
    return () => stamp === selectionStamp() && before === picks;
  };
  // Cancel IO as soon as an external host choice changes. The lease is also
  // checked synchronously after awaits, before expansion or selection writes.
  $effect(() => {
    void hostChoice; void target?.id; void pane.focusedPath; void picks;
    untrack(() => { if (activeReveal && !activeReveal.ownsSelection()) supersedeReveal(); });
  });
  const callbacks = {
    capture: captureSelection,
    /**
     * A save finished while the selection was unchanged. A save into this
     * folder selects its file once the listing has it; one elsewhere needs
     * nothing: its pick follows the node to the saved path (followPicks).
     */
    saved(path: string, key: NodeKey, select: boolean) {
      if (!samePath(parentDir(path), directory)) return;
      claimed = new Map(claimed).set(path, session.index);
      if (select) pendingSave = { directory, path, key, picks };
    },
    discarded(key: NodeKey) { commitPicks(dropPick(livePicks, key)); },
  };

  function preview(node: TraceNode, componentId: string): void {
    const next = nodeTarget(node, componentId, directory, callbacks);
    issuedTargets.set(next, node);
    pane.setPreviewTarget(next);
  }

  function focusNode(key: NodeKey, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}, keep: "hold" | "reveal" = "reveal", componentId: string | undefined = undefined): void {
    supersedeReveal();
    releaseAnchors();
    const found = findNode(key, componentId);
    if (!found) return;
    if (keep === "hold") {
      const element = anchorTile(key, found.componentId);
      if (scroller && element) heldAnchor = holdAnchor(scroller, element, () => { heldAnchor = null; }, updateHeldAnchor);
      applyFocusNode(key, modifiers, found.componentId);
      return;
    }
    applyFocusNode(key, modifiers, found.componentId);
    const dir = directory, ownsSelection = captureSelection();
    const current = anchor = { key, componentId: found.componentId, ownsSelection: () => directory === dir && ownsSelection() };
    void tick().then(() => {
      if (anchor !== current || !current.ownsSelection()) return;
      // Props have now reached the graph: an unchanged focus has no new commit,
      // but can still have running motion. A superseded scene waits for its replacement.
      const data = graphData(current.componentId);
      const committed = data && committedScenes.get(data);
      if (committed) keepAnchor(committed);
    });
  }

  function applyFocusNode(key: NodeKey, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}, componentId: string | undefined = undefined): void {
    const found = findNode(key, componentId);
    if (!found) return;
    keepFocusedOpen();
    setExpanded(found.componentId, true);
    const entry = fileEntry(found.node);
    if (entry) { selectListed(entry, modifiers); return; }
    if (modifiers.ctrlKey || modifiers.shiftKey) {
      // Showing a Preview target replaces the host selection, so a Ctrl or
      // Shift click adds an unlisted image to the picks without one: Ctrl
      // toggles it, Shift only adds.
      if (pickable(found.node)) {
        const pick = { path: found.node.path!, key, componentId: found.componentId };
        const picked = livePicks.extras.some((extra) => extra.key === key);
        if (!(picked && modifiers.shiftKey)) commitPicks(togglePick(livePicks, pick, false, false));
        return;
      }
      // An image that cannot be an input never changes the selection; it is
      // only shown when that costs no host selection (a target clears it).
      if (!hostSelected.length) { const before = livePicks; preview(found.node, found.componentId); commitPicks(before); }
      return;
    }
    show(found.node, found.componentId);
  }

  /** Shows an unlisted node as this pane's Preview target; it becomes the only pick. */
  function show(node: TraceNode, componentId: string): void {
    preview(node, componentId);
    commitPicks(pickable(node) ? pickOnly({ path: node.path!, key: node.key, componentId }, false) : NO_PICKS);
  }

  /**
   * Loads the component holding `key` and returns the id of the component that has it. A refresh that
   * lands meanwhile (a merge renaming components) cancels the load: wait for it, then look the node up
   * in the new index by what identifies it (its component if that survives, else the stack it covers).
   * Null when the folder changed, the selection moved on, or the node is gone.
   */
  async function reachNode(key: NodeKey, componentId: string, turn: number): Promise<string | null> {
    const dir = directory, owns = captureSelection();
    const current = () => dir === directory && owns() && turn === activations;
    for (let round = 0; round < 4; round++) {
      const hit = findNode(key, componentId);
      if (hit) return hit.componentId;
      await session.settled();
      if (!current()) return null;
      const index = session.index;
      const holder = index?.components.find((summary) => summary.id === componentId)
        ?? index?.components.find((summary) => summary.coverKey === key)
        ?? index?.components.find((summary) => summary.id === [...index.members.values()].find((member) => member.key === key)?.componentId);
      if (!holder) return null;
      componentId = holder.id;
      await session.ensure(holder.id);
      if (!current()) return null;
    }
    return current() ? findNode(key)?.componentId ?? null : null;
  }

  /** Bumped by every user activation and every explicit close: an activation still loading when it changes does nothing. */
  let activations = 0;

  async function navigateNode(key: NodeKey, componentId: string, modifiers: { shiftKey?: boolean } = {}): Promise<void> {
    const turn = ++activations;
    const holder = findNode(key, componentId) ? componentId : await reachNode(key, componentId, turn);
    if (holder) focusNode(key, modifiers, "reveal", holder);
  }

  async function activate(key: NodeKey, event: MouseEvent, componentId: string): Promise<void> {
    const turn = ++activations;
    const holder = findNode(key, componentId) ? componentId : await reachNode(key, componentId, turn);
    if (holder) focusNode(key, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }, "hold", holder);
  }

  function open(key: NodeKey): void {
    const found = findNode(key);
    const entry = found && fileEntry(found.node);
    if (entry) void pane.open(entry);
  }

  async function menu(key: NodeKey, event: MouseEvent, componentId: string | undefined = undefined): Promise<void> {
    supersedeReveal();
    releaseAnchors();
    let found = findNode(key, componentId);
    if (!found && componentId) {
      // A stack not loaded yet: resolve its image the way activation does, then act as for a loaded one.
      event.preventDefault();
      const holder = await reachNode(key, componentId, ++activations);
      found = holder ? findNode(key, holder) : null;
      if (!found) return;
    }
    const entry = found && fileEntry(found.node);
    if (entry) {
      if (!selectedPaths.has(entry.path)) { keepFocusedOpen(); selectListed(entry); }
      pane.contextMenu(event, entry);
    } else {
      event.preventDefault();
      keepFocusedOpen();
      if (found) show(found.node, found.componentId);
    }
  }

  function background(): void {
    supersedeReveal();
    releaseAnchors();
    keepFocusedOpen();
    pane.clearSelection();
    if (targetData) pane.setPreviewTarget(null);
    commitPicks(NO_PICKS);
  }

  /** Observe gestures without capturing the pointer or changing the host's pan/control handlers. */
  function backgroundSelection(element: HTMLElement) {
    const controls = 'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [tabindex], [contenteditable]:not([contenteditable="false"]), [data-tile-key], [data-entry-path]';
    const at = (event: MouseEvent): PointerPosition => ({ x: event.clientX, y: event.clientY });
    const empty = (target: EventTarget | null, position: PointerPosition) => {
      if (!(target instanceof Element) || !element.contains(target)) return false;
      const box = element.getBoundingClientRect();
      const content = scaledClientArea({ x: box.left, y: box.top }, { left: element.clientLeft, top: element.clientTop, width: element.clientWidth, height: element.clientHeight }, zoomOf(element, box));
      if (!inClientArea(position, content)) return false;
      const control = target.closest(controls);
      return !control || !element.contains(control);
    };
    const pointer = (event: PointerEvent): DeselectPointer => ({ x: event.clientX, y: event.clientY, id: event.pointerId, button: event.button, primary: event.isPrimary });
    let gesture: DeselectGesture | null = null;
    const handle = (event: DeselectEvent) => {
      const next = deselectGesture(gesture, event);
      gesture = next.gesture;
      if (next.deselect) background();
    };
    const down = (event: PointerEvent) => handle({ type: "down", pointer: pointer(event), emptyTarget: empty(event.target, at(event)) });
    const move = (event: PointerEvent) => handle({ type: "move", pointer: pointer(event) });
    const up = (event: PointerEvent) => handle({ type: "up", pointer: pointer(event), emptyTarget: empty(event.target, at(event)) });
    const click = (event: MouseEvent) => handle({ type: "click", position: { x: event.clientX, y: event.clientY }, button: event.button, emptyTarget: empty(event.target, at(event)) });
    // Match the host's empty-space menu selection change, including Trace-only
    // picks. Let the event bubble so FileList still opens the directory menu.
    const contextMenu = (event: MouseEvent) => { if (empty(event.target, at(event))) background(); };
    const cancel = () => handle({ type: "cancel" });
    const wheel = () => handle({ type: "wheel" });
    const scroll = () => handle({ type: "scroll" });
    const blur = () => handle({ type: "blur" });
    element.addEventListener("pointerdown", down, true);
    element.addEventListener("click", click, true);
    element.addEventListener("contextmenu", contextMenu);
    element.addEventListener("wheel", wheel, { capture: true, passive: true });
    element.addEventListener("scroll", scroll, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", blur);
    return { destroy() {
      element.removeEventListener("pointerdown", down, true);
      element.removeEventListener("click", click, true);
      element.removeEventListener("contextmenu", contextMenu);
      element.removeEventListener("wheel", wheel, true);
      element.removeEventListener("scroll", scroll, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", blur);
    } };
  }

  // A just-saved image becomes selected once the listing contains it, in its
  // place among the picks: [unsaved U, mist] becomes [saved U, mist].
  $effect(() => {
    const save = pendingSave;
    if (!save) return;
    // A save for a folder this pane has left is dropped.
    const here = samePath(save.directory, directory);
    if (here && !entriesByPath.has(save.path)) return;
    untrack(() => {
      pendingSave = null;
      // Picks changed since the save finished: that newer choice stands.
      if (here && picks === save.picks) selectSaved(save.picks, save.key, save.path);
    });
  });

  /**
   * Selects a saved image's file, the user's newest action. Picked, it takes
   * its place among `before` and the host keeps the rest of its selection
   * (nothing it dropped comes back); not picked, it is selected alone, as a
   * plain click would, so the next AI edit gains no input unseen.
   */
  function selectSaved(before: Picks, key: NodeKey, path: string): void {
    const saved = { path, key: path };
    const next = replacePick(before, key, saved, true);
    pane.setSelection(next ? [...hostSelected, path] : [path], path);
    commitPicks(next ?? pickOnly(saved, true));
  }

  // Keep this pane's Preview target in step with refreshed node data. A
  // target whose node is gone (its generation failed, say) is cleared: left
  // in place, its component would stay the focus and dim every section.
  $effect(() => {
    const current = target, data = targetData;
    if (!current || !data) return;
    const located = locateTarget(data.key, data.componentId, {
      listed: session.index ? new Set(summaries.map((summary) => summary.id)) : null,
      components: session.components,
      isStale: (id) => session.isStale(id),
    });
    if (located === "unknown") return;
    if (located === "gone") { untrack(() => pane.setPreviewTarget(null)); return; }
    const { node: fresh, componentId } = located;
    if (issuedTargets.get(current) === fresh && componentId === data.componentId) return;
    untrack(() => {
      const entry = fileEntry(fresh);
      // The target is a listed file now (saved by a save that did not select
      // it, or elsewhere). While it is picked, its file takes its place among
      // the picks; otherwise the selection stays and the target shows the file.
      const stillPicked = livePicks.extras.some((extra) => extra.key === data.key);
      if (entry && stillPicked && pendingSave?.path !== entry.path) { selectSaved(livePicks, data.key, entry.path); return; }
      // Re-issuing the target clears the host selection, which a target keeps
      // empty: the picks stay (restored only if a host notified anyway).
      const before = picks;
      preview(fresh, componentId);
      if (picks !== before) { void hostChoice; picks = settlePicks(before, hostSelected); }
    });
  });

  async function reveal(targetId: string, signal: AbortSignal): Promise<void> {
    const id = revealArtifactId(targetId);
    signal.throwIfAborted();
    supersedeReveal();
    releaseAnchors();
    const owner: RevealOwner = { controller: new AbortController(), ownsSelection: captureSelection() };
    activeReveal = owner;
    const cancel = () => owner.controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const dir = directory;
    try {
      session.setDirectory(dir);
      const found = await session.resolveArtifact(id, owner.controller.signal);
      checkReveal(owner);
      if (dir !== directory) throw new DOMException("Trace folder changed during reveal", "AbortError");
      // Expansion and Preview/picks are committed together after loading succeeds.
      let visible!: Promise<void>;
      flushSync(() => {
        checkReveal(owner);
        session.setStackOpen(found.componentId, true);
        near = new Set(near).add(found.componentId);
        applyFocusNode(found.node.key, {}, found.componentId);
        owner.ownsSelection = captureSelection();
        revealScene = owner;
        visible = awaitReveal(owner, found.node.key);
      });
      await visible;
      checkReveal(owner);
    } finally {
      signal.removeEventListener("abort", cancel);
      if (activeReveal === owner) activeReveal = null;
      if (revealScene === owner) revealScene = null;
    }
  }

  const view: TracePaneView = {
    reveal,
    get directory() { return directory; },
    node: (key) => findNode(key, focus?.componentId)?.node ?? null,
    nodeForPath: (path) => { const member = session.componentOf(path); return member ? findNode(member.key, member.componentId)?.node ?? null : null; },
    focus: (key) => {
      const found = findNode(key, focus?.componentId);
      if (found && !summaries.some((summary, index) => summary.id === found.componentId && isExpanded(summary, index))) setExpanded(found.componentId, true);
      else if (found) session.setStackOpen(found.componentId, true);
      focusNode(key, {}, "reveal", found?.componentId);
    },
    get active() { return pane.active; },
    inputs: () => inputs,
    hasUnusableTarget: () => {
      if (!targetData) return false;
      const node = findNode(targetData.key, targetData.componentId)?.node;
      return !node || !pickable(node);
    },
  };
  $effect(() => tracePanes.set(pane.paneId, view));

  // Titles for visible components are generated in the background, as before.
  // Re-runs when title generation becomes configured, not only on data changes.
  $effect(() => {
    if (!promptTitles.configured) return;
    for (const data of session.components.values()) for (const node of data.nodes) if (node.runId !== null) untrack(() => promptTitles.loadFor(node.runId, node.prompt));
  });

  function setExpanded(id: string, opening: boolean): void {
    const element = scroller?.querySelector<HTMLElement>(`[data-grid-cell="${CSS.escape(stackKey(id))}"]`) ?? null;
    if (scroller && element && !heldAnchor) heldAnchor = holdAnchor(scroller, element, () => { heldAnchor = null; }, updateHeldAnchor);
    if (!opening && pendingReveal && session.components.get(id)?.dag.nodes.has(pendingReveal.key)) supersedeReveal();
    if (!opening) activations++;
    session.setStackOpen(id, opening);
    if (opening) void session.ensure(id);
    updateHeldAnchor();
  }

  function keepFocusedOpen(): void {
    const id = focus?.componentId;
    if (id && openKeys.has(stackKey(id))) session.setStackOpen(id, true);
  }

  onDestroy(() => {
    supersedeReveal();
    releaseAnchors();
    session.dispose();
    if (pane.previewTarget && isTraceTargetData(pane.previewTarget.data)) pane.setPreviewTarget(null);
  });

  const graphData = (id: string): ComponentData | undefined => session.components.get(id);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="trace-view" bind:this={scroller} bind:clientWidth use:backgroundSelection
  oncontextmenu={(event) => { if (event.target === event.currentTarget) pane.contextMenu(event); }}
  data-testid="trace-view">
  {#if session.status === "loading" && !session.index}
    <div class="message" role="status">Loading Trace…</div>
  {:else if session.status === "error" && !session.index}
    <div class="message" role="alert">
      <span>Trace could not be loaded: {session.error}</span>
      <button type="button" onclick={() => void session.refresh()}>Retry</button>
      <button type="button" onclick={() => pane.exitView()}>Show files</button>
    </div>
  {:else}
    <StackGrid {pane} {session} {focus} selected={selectedKeys} {tile} {revision} {scroller} {width} {openKeys} {claimedPaths}
      onexpand={setExpanded} onnear={(ids) => near = ids} onactivate={activate}
      onnavigate={navigateNode} onopen={open} onmenu={menu}
      onselect={(entry, event) => { supersedeReveal(); releaseAnchors(); keepFocusedOpen(); selectListed(entry, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }); }}
      onordinarymenu={(entry, event) => { supersedeReveal(); releaseAnchors(); if (!selectedPaths.has(entry.path)) { keepFocusedOpen(); selectListed(entry); } pane.contextMenu(event, entry); }}
      {captureSelection} onsaved={(key, path, select) => callbacks.saved(path, key, select)} ondiscarded={(key) => callbacks.discarded(key)} oncommit={keepAnchor}
      onlayout={(id, pending) => { if (pending) pendingLayouts.add(id); else pendingLayouts.delete(id); }} reveal={revealScene}
      onfailure={(scene, error) => { if (pendingReveal && scene.isCurrent() && scene.reveal === pendingReveal.owner && scene.focus === pendingReveal.key && scene.data.dag.nodes.has(pendingReveal.key)) pendingReveal.finish(error); }} />
    {#if session.error && session.index}<p class="notice" role="alert">{session.error}</p>{/if}
    {#if !gridCells.length && session.index}<div class="message">This folder is empty.</div>{/if}
  {/if}
</div>

<style>
  .trace-view { flex: 1; min-height: 0; overflow: auto; padding: 10px 10px 24px; box-sizing: border-box; overflow-anchor: none; scrollbar-gutter: stable; }
  .message { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 12px; color: var(--text-secondary); }
  .message button { padding: 4px 12px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .notice { margin: 0 0 10px; font-size: 12px; color: var(--system-critical-text, var(--system-critical)); }
</style>
