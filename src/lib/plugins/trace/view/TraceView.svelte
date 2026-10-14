<script lang="ts">
  /**
   * The Trace file view: replaces the pane's listing with one collapsible
   * stack per connected component in the folder grid alongside entries
   * without provenance. All view state (folder session, expansion, anchors)
   * belongs to this pane; selection and Preview go through the pane handle.
   *
   * Drawing goes through the pane's scene controller: every interaction is one
   * action (`controller.action`), the pane's intent reaches it through one
   * intake effect, and the grid renders only the controller's publication.
   */
  import { flushSync, onDestroy, tick, untrack } from "svelte";
  import { hostFileTile, hostSupportsSelectionAnchor } from "../../../../sdk";
  import type { FileViewPane, PreviewTarget } from "../../../../../integration/plugin-sdk";
  import type { FileEntry } from "$lib/domain/file";
  import { parentDir, samePath } from "$lib/domain/path";
  import type { ComponentSummary, NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
  import { tileMetrics } from "$lib/domain/trace-graph/metrics";
  import { fallbackGridMetrics, type FolderCell } from "$lib/domain/trace-graph/folder-grid";
  import { traceInvalidation } from "../invalidation.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { createFolderSession, type FolderIndex, type FolderSession } from "./folder-session.svelte";
  import { tracePanes, isTraceTargetData, type TracePaneView } from "./pane-registry.svelte";
  import { NO_PICKS, clickListed, dropPick, followPicks, picksFromHost, pickOnly, pickable, replacePick, resolvePicks, selectionKey, settlePicks, togglePick, type PickLocation, type Picks } from "./input-picks";
  import { nodeTarget } from "./node-target";
  import { revealArtifactId } from "./reveal-target";
  import { findLoadedNode, locateTarget, unresolvedTargetComponents } from "./target-location";
  import { holdAnchor, scrollsByUser, USER_SCROLL, type AnchorHold } from "./motion";
  import { createSceneController, type ActionLease, type SceneCause } from "./scene-controller.svelte";
  import { computeFolderLayout, holdLayoutWork } from "./layout-client";
  import { folderLayoutRuntime } from "./folder-layout-runtime";
  import type { SceneIntent } from "./scene-inputs";

  import StackGrid from "./StackGrid.svelte";
  import { selectableSelector } from "./selectable";
  import { attachMarqueeSelection } from "./marquee-attachment";
  import { marqueeSelection, sameSelection, type MarqueeRect } from "./marquee-selection";
  import { pendingMarqueeComponents } from "./marquee-components";
  import { pendingListingPaths } from "./stack-grid";

  interface Props { pane: FileViewPane; session?: FolderSession }
  let { pane, session: provided }: Props = $props();

  const session = untrack(() => provided) ?? createFolderSession(undefined, undefined, untrack(() => pane.paneId));
  const layoutRuntime = folderLayoutRuntime();
  const controller = createSceneController({
    paneId: untrack(() => pane.paneId), data: session, engine: layoutRuntime.engine, inline: layoutRuntime.inline, remember: layoutRuntime.remember,
    runLayout: (input, signal) => computeFolderLayout(input, layoutRuntime.engine, signal), holdWork: holdLayoutWork,
  });
  const host = hostFileTile();
  /** Width is quantized so resizing does not relayout on every pixel. */
  const WIDTH_STEP = 16;
  /** Horizontal space reserved by the view's 10px pane padding. */
  const GRID_CHROME = 20;
  /** How long a first scene may take before "Loading Trace…" shows. */
  const LOADING_DELAY_MS = 400;

  let scroller = $state<HTMLElement | null>(null);
  let clientWidth = $state(0);
  let marquee = $state.raw<MarqueeRect | null>(null);
  let marqueeActive = $state(false);
  let marqueeLoading = $state.raw<ReadonlySet<string>>(new Set());
  let marqueeTurn = 0;
  let marqueeFocus: { key: NodeKey; componentId: string } | null = null;
  let marqueeAttachment: ReturnType<typeof attachMarqueeSelection> | null = null;
  let badgeHover = $state<string | null>(null);
  /** A save into this folder waiting for the listing to contain its file; see `callbacks.saved`. */
  /**
   * Files this view just saved, by path, with the index read they predate. The host lists a saved file
   * before Trace's index maps it into its stack; until a newer read lands it is part of that stack, not
   * an ordinary file (which would duplicate the cover and shift every cell).
   */
  let claimed = $state.raw<ReadonlyMap<string, FolderIndex | null>>(new Map());
  // Snapshot the listing when an index lands. Listing additions alone must not advance this
  // baseline: they may be saves from another pane that the current index cannot classify yet.
  const indexedListing = $derived.by(() => {
    const index = session.index;
    return { index, paths: untrack(() => new Set(pane.entries.map((entry) => entry.path))) };
  });
  const claimedPaths = $derived(new Set([
    ...[...claimed].filter(([, since]) => since === session.index).map(([path]) => path),
    ...pendingListingPaths(pane.entries, indexedListing.index, indexedListing.paths, !!session.indexError),
  ]));
  let pendingSave = $state.raw<{ directory: string; path: string; key: NodeKey; picks: Picks } | null>(null);
  /** A keyboard/programmatic reveal of a tile once its action is presented and settled; aborted by input. */
  let anchorReveal: AbortController | null = null;
  let heldAnchor: AnchorHold | null = null;

  /** Compensates a held anchor once the publication in flight has started its motion (one notification per publication). */
  const anchorLayoutChanged = () => controller.afterPresentation(() => heldAnchor?.update());
  controller.onPresented(() => { marqueeAttachment?.layoutChanged(); heldAnchor?.update(); });

  function releaseAnchors(): void {
    anchorReveal?.abort(new DOMException("Trace reveal was superseded", "AbortError"));
    anchorReveal = null;
    heldAnchor?.release();
    heldAnchor = null;
  }
  type RevealOwner = { controller: AbortController; ownsSelection: () => boolean };
  let activeReveal: RevealOwner | null = null;

  function supersedeReveal(): void {
    activeReveal?.controller.abort(new DOMException("Trace reveal was superseded", "AbortError"));
  }

  function checkReveal(owner: RevealOwner): void {
    owner.controller.signal.throwIfAborted();
    if (activeReveal !== owner || !owner.ownsSelection()) {
      owner.controller.abort(new DOMException("Trace reveal was superseded", "AbortError"));
      owner.controller.signal.throwIfAborted();
    }
  }

  const issuedTargets = new WeakMap<PreviewTarget, TraceNode>();

  const directory = $derived(pane.directory);
  const width = $derived(Math.max(0, Math.floor((clientWidth - GRID_CHROME) / WIDTH_STEP) * WIDTH_STEP));
  const revision = $derived(traceInvalidation.revision);
  // Trace tiles follow the host's tile-size setting for this pane; older hosts
  // (without the "tileSize" capability) leave it undefined: the default tile.
  const imagePx = $derived(pane.tileSize?.imagePx);
  const tile = $derived(tileMetrics(imagePx));
  const gridMetrics = $derived(host?.tileGridMetrics(pane.tileSize?.preset) ?? fallbackGridMetrics(tile));
  const coverChrome = $derived({ imagePx: host ? (pane.tileSize?.imagePx ?? 64) : null, small: pane.tileSize?.preset === "small" });
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
  /** Stacks by component id, from the index (cover keys are stack identities). */
  const coverOf = (id: string) => summaries.find((summary) => summary.id === id)?.coverKey ?? id;
  const openKeys = $derived(session.openStackKeys);
  $effect(() => {
    const choice = JSON.stringify([hostChoice, target?.id, pane.focusedPath]);
    const index = session.index;
    const dragging = marqueeActive;
    untrack(() => {
      if (!index || dragging) return;
      const ids = new Set(pane.selection.flatMap((entry) => { const member = session.componentOf(entry.path); return member ? [member.componentId] : []; }));
      if (focus) ids.add(focus.componentId);
      controller.derive(() => session.followSelection(choice, ids));
    });
  });

  // Focus: this pane's Trace preview target, otherwise the primary selected file.
  const target = $derived(pane.previewTarget);
  const targetData = $derived(target && isTraceTargetData(target.data) && samePath(target.data.directory, directory) ? target.data : null);
  const focus = $derived.by<{ key: NodeKey; componentId: string } | null>(() => {
    if (marqueeActive) return marqueeFocus;
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

  const isExpanded = (summary: ComponentSummary) => openKeys.has(summary.coverKey);

  // Load every component holding an extra pick (so a pick in a collapsed section is
  // checked against fresh data), marquee hits and open-stack identity searches;
  // release the rest. Open stacks are the scene controller's (its component leases).
  $effect(() => {
    const picked = pickComponents;
    const selecting = marqueeLoading;
    const wanted = summaries.filter((summary) => picked.has(summary.id) || selecting.has(summary.id) || session.openStackSearch.has(summary.id)).map((summary) => summary.id);
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
  // programmatic navigation reveal it once its action is presented and settled.
  function anchorTile(key: NodeKey, componentId: string | undefined = undefined): HTMLElement | null {
    const section = componentId ? scroller?.querySelector<HTMLElement>(`section[data-component="${CSS.escape(componentId)}"]`) : null;
    return section?.querySelector<HTMLElement>(selectableSelector(key)) ?? scroller?.querySelector<HTMLElement>(selectableSelector(key)) ?? null;
  }

  /** Scrolls `key` into view and focuses it once action `id` is presented and its motion has settled. */
  function revealWhenSettled(id: number, key: NodeKey, componentId: string): void {
    anchorReveal?.abort(new DOMException("Trace reveal was superseded", "AbortError"));
    const reveal = anchorReveal = new AbortController();
    const dir = directory, ownsSelection = captureSelection();
    void controller.whenPresented(id, key, reveal.signal).then(() => controller.whenSettled(id, reveal.signal)).then(() => {
      if (anchorReveal === reveal) anchorReveal = null;
      if (directory !== dir || !ownsSelection()) return;
      const tile = anchorTile(key, componentId);
      tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
      tile?.focus({ preventScroll: true });
    }, () => { if (anchorReveal === reveal) anchorReveal = null; });
  }

  // Input cancels pending reveals; an active hold applies its own scroll-input
  // rules so section content clicks can retain it while toggling a section.
  $effect(() => {
    const element = scroller;
    if (!element) return;
    const cancel = (event: Event) => { if (scrollsByUser(event)) { anchorReveal?.abort(new DOMException("Trace reveal was superseded", "AbortError")); anchorReveal = null; supersedeReveal(); } };
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

  /**
   * Focuses a node within action `lease`. "hold" keeps the clicked tile where it is on screen
   * through the relayout (captured before any host write); "reveal" scrolls it into view once the
   * action is presented and settled.
   */
  function focusNode(lease: ActionLease, key: NodeKey, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}, keep: "hold" | "reveal" = "reveal", componentId: string | undefined = undefined): void {
    supersedeReveal();
    releaseAnchors();
    const found = findNode(key, componentId);
    if (!found) return;
    if (keep === "hold") {
      const element = anchorTile(key, found.componentId);
      if (scroller && element) heldAnchor = holdAnchor(scroller, element, () => { heldAnchor = null; }, anchorLayoutChanged);
      applyFocusNode(key, modifiers, found.componentId);
      return;
    }
    applyFocusNode(key, modifiers, found.componentId);
    revealWhenSettled(lease.id, key, found.componentId);
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
   * in the new index by its stable revision key, including when it is no longer a cover or member.
   * Null when the folder changed, the selection moved on, or the node is gone.
   */
  async function reachNode(key: NodeKey, componentId: string, turn: number): Promise<string | null> {
    const dir = directory, owns = captureSelection();
    const current = () => dir === directory && owns() && turn === activations;
    const targetIndex = () => ({
      listed: session.index ? new Set(session.index.components.map((summary) => summary.id)) : null,
      components: session.components, isStale: (id: string) => session.isStale(id),
    });
    for (let round = 0; round < 4; round++) {
      await session.settled();
      if (!current()) return null;
      const hit = locateTarget(key, componentId, targetIndex());
      if (typeof hit !== "string") return hit.componentId;
      const index = session.index;
      const pending = unresolvedTargetComponents(key, componentId, targetIndex());
      if (!pending.length) return null;
      for (const id of pending) {
        await session.ensure(id);
        if (!current()) return null;
        if (session.index !== index) break;
        const found = locateTarget(key, componentId, targetIndex());
        if (typeof found !== "string") return found.componentId;
      }
    }
    const found = locateTarget(key, componentId, targetIndex());
    return current() && typeof found !== "string" ? found.componentId : null;
  }

  /** Bumped by every user activation and every explicit close: an activation still loading when it changes does nothing. */
  let activations = 0;
  const modifiersOf = (event: MouseEvent) => ({ ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey });

  /**
   * Focuses `key` within `lease`, loading its component first when needed. Synchronous when the
   * node is loaded; otherwise the completed activation is a derived write of the same action.
   */
  function reachAndFocus(lease: ActionLease, key: NodeKey, componentId: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean }, keep: "hold" | "reveal"): Promise<void> | void {
    const turn = ++activations;
    if (findNode(key, componentId)) { focusNode(lease, key, modifiers, keep, componentId); return; }
    return reachNode(key, componentId, turn).then((holder) => {
      if (holder && lease.isCurrent()) lease.derive(() => focusNode(lease, key, modifiers, keep, holder));
    });
  }

  const selection = (target: string | null, anchor: SceneCause["anchor"] = "none"): SceneCause => ({ kind: "selection", target, anchor });

  function navigateNode(key: NodeKey, componentId: string, modifiers: { shiftKey?: boolean } = {}): void {
    void controller.action(selection(key, "reveal"), (lease) => reachAndFocus(lease, key, componentId, modifiers, "reveal"));
  }

  function activate(key: NodeKey, event: MouseEvent, componentId: string): void {
    void controller.action(selection(key, "hold"), (lease) => reachAndFocus(lease, key, componentId, modifiersOf(event), "hold"));
  }

  /**
   * Pressing a stack's cover or disclosure is one action: select what its open cover selects (the
   * listed file, or its node once loaded), then open it. With `toggle` (the disclosure only), a
   * requested stack (open, still opening, or failed) closes instead: pressing a pending stack's
   * disclosure cancels its opening. Pressing the cover itself never closes or cancels it.
   */
  function activateStack(cell: FolderCell, event: MouseEvent, toggle: boolean): void {
    const summary = cell.summary;
    if (!summary) return;
    if (toggle && openKeys.has(cell.id)) {
      void controller.action({ kind: "collapse", target: cell.id, anchor: "hold" }, () => setExpanded(summary.id, false));
      return;
    }
    void controller.action({ kind: "expand", target: cell.id, anchor: "hold" }, (lease) => {
      let pending: Promise<void> | void = undefined;
      const index = controller.committedIndex;
      if (cell.entry && index?.members.get(cell.entry.path)?.key === cell.coverKey) {
        supersedeReveal(); releaseAnchors(); keepFocusedOpen(); selectListed(cell.entry, modifiersOf(event));
      } else pending = reachAndFocus(lease, cell.id, summary.id, modifiersOf(event), "hold");
      setExpanded(summary.id, true);
      return pending;
    });
  }

  /** Retries a failed open by its stable cover key, against the current index (components may have merged). */
  function retryStack(coverKey: string): void {
    void controller.action({ kind: "retry", target: coverKey, anchor: "hold" }, () => {
      const cover = controller.clearFailure(coverKey);
      const summary = cover ? summaries.find((candidate) => candidate.coverKey === cover) : undefined;
      if (summary) setExpanded(summary.id, true);
    });
  }

  /** Double-click or Enter on an image opens its file. An earlier revision has none of its own: the file at its path now holds the newest revision, which is what opens. */
  function open(key: NodeKey): void {
    const found = findNode(key);
    const node = found?.node;
    const entry = node && (fileEntry(node) ?? (node.earlierRevision && node.scope === "current" && node.path ? entriesByPath.get(node.path) : null));
    if (entry) void pane.open(entry);
  }

  function menu(key: NodeKey, event: MouseEvent, componentId: string | undefined = undefined): void {
    void controller.action(selection(key), (lease) => {
      supersedeReveal();
      releaseAnchors();
      const found = findNode(key, componentId);
      if (!found && componentId) {
        // A stack not loaded yet: resolve its image the way activation does, then act as for a loaded one.
        // Claim the event before any await: the host's folder handlers (empty-space menu, clearing the selection) must never see it.
        event.preventDefault();
        event.stopPropagation();
        return reachNode(key, componentId, ++activations).then((holder) => {
          const reached = holder ? findNode(key, holder) : null;
          if (reached && lease.isCurrent()) lease.derive(() => menuFor(reached, event));
        });
      }
      menuFor(found, event);
    });
  }

  function menuFor(found: { node: TraceNode; componentId: string } | null, event: MouseEvent): void {
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
    void controller.action(selection(null), () => {
      supersedeReveal();
      releaseAnchors();
      keepFocusedOpen();
      pane.clearSelection();
      if (targetData) pane.setPreviewTarget(null);
      commitPicks(NO_PICKS);
    });
  }

  /** Apply one marquee frame through the host, then record a fresh ordered-picks object. */
  function selectMarquee(keys: readonly string[], additive: boolean, load = true): void {
    void controller.action(selection(null), () => applyMarquee(keys, additive, load));
  }

  function applyMarquee(keys: readonly string[], additive: boolean, load: boolean): void {
    const turn = ++marqueeTurn;
    const missing = load ? missingMarqueeComponents(keys) : [];
    marqueeLoading = new Set(missing);
    const hits = keys.flatMap((key) => {
      const location = locateExtra(key);
      const found = location && typeof location !== "string" ? location : null;
      if (found) {
        // Like clicks: listed files can be selected independently of input eligibility.
        if (!fileEntry(found.node) && !pickable(found.node)) return [];
        return [{ path: found.node.path!, key, componentId: found.componentId }];
      }
      const summary = summaries.find((candidate) => candidate.coverKey === key);
      if (summary) {
        const path = summary.cover?.path;
        // An unloaded cover's path may now hold a newer revision. Only the index
        // can establish that this drawn cover is the listed file itself.
        return path && entriesByPath.has(path) && session.componentOf(path)?.key === key
          ? [{ path, key, componentId: summary.id }] : [];
      }
      return entriesByPath.has(key) ? [{ path: key, key }] : [];
    });
    const paths = marqueeSelection(inputs, hits.map((hit) => hit.path), { ctrlKey: additive });
    const selected = new Set(paths);
    const extras = [...new Map([...livePicks.extras.filter((hit) => additive && selected.has(hit.path)),
      ...hits.filter((hit) => !entriesByPath.has(hit.path))].map((hit) => [hit.path, hit])).values()];
    const listed = paths.filter((path) => entriesByPath.has(path));
    if (!sameSelection(hostSelected, listed)) {
      if (hostSupportsSelectionAnchor()) pane.setSelection(listed, null, { keepAnchor: true });
      else pane.setSelection(listed);
    }
    if (targetData && (!additive || listed.length)) pane.setPreviewTarget(null);
    commitPicks({ order: paths, extras });
    marqueeAttachment?.selectionApplied();
    if (missing.length) {
      // Index summaries cannot establish unlisted input eligibility. Resolve the
      // actual revision, retaining its component until the latest frame settles.
      const owns = captureSelection();
      void resolveMarquee(keys, additive, turn, owns);
    }
  }

  /** Recompute component IDs from stable revision keys against each latest index. */
  function missingMarqueeComponents(keys: readonly string[]): string[] {
    const index = {
      listed: session.index ? new Set(summaries.map((summary) => summary.id)) : null,
      components: session.components, isStale: (id: string) => session.isStale(id),
    };
    return pendingMarqueeComponents(keys, new Set(entriesByPath.keys()),
      new Map(summaries.map((summary) => [summary.coverKey, summary])), index);
  }

  async function resolveMarquee(keys: readonly string[], additive: boolean, turn: number, owns: () => boolean): Promise<void> {
    for (;;) {
      await session.settled();
      if (turn !== marqueeTurn) return;
      if (!owns()) { marqueeLoading = new Set(); return; }
      const index = session.index;
      const missing = missingMarqueeComponents(keys);
      marqueeLoading = new Set(missing);
      await Promise.all(missing.map((id) => session.ensure(id)));
      // A refresh aborts node reads before its replacement index lands.
      await session.settled();
      if (turn !== marqueeTurn) return;
      if (!owns()) { marqueeLoading = new Set(); return; }
      if (session.index !== index) continue;
      selectMarquee(keys, additive, false);
      return;
    }
  }

  function backgroundSelection(element: HTMLElement) {
    const attachment = attachMarqueeSelection(element, {
      background,
      captureSelection,
      start() {
        supersedeReveal(); releaseAnchors(); keepFocusedOpen(); activations++;
        marqueeTurn++; marqueeLoading = new Set();
        marqueeFocus = focus; marqueeActive = true;
      },
      end(commit) {
        marqueeActive = false;
        if (!commit) { marqueeTurn++; marqueeLoading = new Set(); }
      },
      select: selectMarquee,
      draw: (rect) => marquee = rect,
    });
    marqueeAttachment = attachment;
    return { destroy() { attachment.destroy(); marqueeAttachment = null; } };
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
      if (here && picks === save.picks) controller.derive(() => selectSaved(save.picks, save.key, save.path));
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
    if (located === "gone") { untrack(() => controller.derive(() => pane.setPreviewTarget(null))); return; }
    const { node: fresh, componentId } = located;
    if (issuedTargets.get(current) === fresh && componentId === data.componentId) return;
    untrack(() => controller.derive(() => {
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
    }));
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
      // One action: resolving the image, opening its stack and focusing it commit together.
      const shown = await controller.action({ kind: "reveal", target: null, anchor: "reveal" }, async (lease) => {
        session.setDirectory(dir);
        const found = await session.resolveArtifact(id, owner.controller.signal);
        checkReveal(owner);
        if (dir !== directory) throw new DOMException("Trace folder changed during reveal", "AbortError");
        // Expansion and Preview/picks are written together after loading succeeds.
        lease.derive(() => flushSync(() => {
          checkReveal(owner);
          session.setStackOpen(found.componentId, true);
          applyFocusNode(found.node.key, {}, found.componentId);
          owner.ownsSelection = captureSelection();
        }));
        return { id: lease.id, key: found.node.key, componentId: found.componentId };
      });
      await controller.whenPresented(shown.id, shown.key, owner.controller.signal);
      checkReveal(owner);
      await controller.whenSettled(shown.id, owner.controller.signal);
      checkReveal(owner);
      if (focus?.key !== shown.key) throw new DOMException("Trace reveal was superseded", "AbortError");
      const button = anchorTile(shown.key, shown.componentId);
      if (!button) throw new Error("Trace image could not be shown");
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
      button.focus({ preventScroll: true });
    } finally {
      signal.removeEventListener("abort", cancel);
      if (activeReveal === owner) activeReveal = null;
    }
  }

  const view: TracePaneView = {
    reveal,
    get directory() { return directory; },
    node: (key) => findNode(key, focus?.componentId)?.node ?? null,
    nodeForPath: (path) => { const member = session.componentOf(path); return member ? findNode(member.key, member.componentId)?.node ?? null : null; },
    focus: (key) => {
      void controller.action(selection(key, "reveal"), (lease) => {
        const found = findNode(key, focus?.componentId);
        if (found && !summaries.some((summary) => summary.id === found.componentId && isExpanded(summary))) setExpanded(found.componentId, true);
        else if (found) session.setStackOpen(found.componentId, true);
        focusNode(lease, key, {}, "reveal", found?.componentId);
      });
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

  /** Requests a stack open or closed (within an action). Its data is the scene controller's to load. */
  function setExpanded(id: string, opening: boolean): void {
    const element = scroller?.querySelector<HTMLElement>(`[data-grid-cell="${CSS.escape(coverOf(id))}"]`) ?? null;
    if (scroller && element && !heldAnchor) heldAnchor = holdAnchor(scroller, element, () => { heldAnchor = null; }, anchorLayoutChanged);
    if (!opening) { activations++; anchorReveal?.abort(new DOMException("Trace reveal was superseded", "AbortError")); }
    session.setStackOpen(id, opening);
    anchorLayoutChanged();
  }

  function keepFocusedOpen(): void {
    const id = focus?.componentId;
    if (id && openKeys.has(coverOf(id))) session.setStackOpen(id, true);
  }

  onDestroy(() => {
    marqueeTurn++;
    supersedeReveal();
    releaseAnchors();
    controller.dispose();
    session.dispose();
    if (pane.previewTarget && isTraceTargetData(pane.previewTarget.data)) pane.setPreviewTarget(null);
  });

  // The one intake: the pane's intent and data revision, compared by content in the controller.
  $effect(() => {
    const intent: SceneIntent = {
      directory, listing: pane.entries, claimed: claimedPaths, open: openKeys, focus, selectedKeys, selectedPaths, badgeHover,
      // Unmeasured (0) holds the first publication until the pane has a width.
      width: clientWidth > 0 ? Math.max(width, 1) : 0, tile, grid: gridMetrics, cover: coverChrome,
      hostChoice: JSON.stringify([hostChoice, target?.id ?? null, pane.focusedPath]),
    };
    const mark = { index: session.index, components: session.components };
    untrack(() => controller.offer(intent, mark));
  });

  const published = $derived(controller.published);
  /**
   * "Loading Trace…" appears only once a first scene has taken a while (its visual delay), so a
   * view mounted over cached data presents its first scene without a loading frame in between.
   */
  let loadingDue = $state(false);
  $effect(() => {
    if (published) { loadingDue = false; return; }
    const timer = setTimeout(() => loadingDue = true, LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  });
  /** Refresh and index failures: a view-level overlay that never changes scene or scroll geometry. */
  const overlayError = $derived(session.index ? session.indexError || controller.failure || "" : "");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="trace-view" bind:this={scroller} bind:clientWidth use:backgroundSelection
  oncontextmenu={(event) => { if (event.target === event.currentTarget) pane.contextMenu(event); }}
  data-testid="trace-view">
  <!-- Zero-height and sticky: failures overlay the top of the view without moving the grid or changing its scroll extent. -->
  <div class="overlay-anchor">
    {#if overlayError}
      <div class="overlay" role="alert">
        <span>{overlayError}</span>
        <button type="button" onclick={() => { controller.clearViewFailure(); void session.refresh(); }}>Retry</button>
      </div>
    {/if}
  </div>
  {#if published}
    <StackGrid {pane} {controller} publication={published} notices={controller.notices} gridPadding={gridMetrics.gridPadding} {focus} {revision} {scroller}
      onstack={activateStack} onactivate={activate} onnavigate={navigateNode} onopen={open} onmenu={menu}
      onselect={(entry, event) => void controller.action(selection(entry.path), () => { supersedeReveal(); releaseAnchors(); keepFocusedOpen(); selectListed(entry, modifiersOf(event)); })}
      onordinarymenu={(entry, event) => void controller.action(selection(entry.path), () => { supersedeReveal(); releaseAnchors(); if (!selectedPaths.has(entry.path)) { keepFocusedOpen(); selectListed(entry); } pane.contextMenu(event, entry); })}
      onbadgehover={(key) => badgeHover = key} onretry={retryStack}
      {captureSelection} onsaved={(key, path, select) => callbacks.saved(path, key, select)} ondiscarded={(key) => callbacks.discarded(key)} />
    {#if !published.scene.cells.length}<div class="message">This folder is empty.</div>{/if}
  {:else if session.status === "error" && !session.index}
    <div class="message" role="alert">
      <span>Trace could not be loaded: {session.error}</span>
      <button type="button" onclick={() => void session.refresh()}>Retry</button>
      <button type="button" onclick={() => pane.exitView()}>Show files</button>
    </div>
  {:else if loadingDue}
    <div class="message" role="status">Loading Trace…</div>
  {/if}
  {#if marquee}
    <div class="marquee-rect" aria-hidden="true" style:left="{marquee.left}px" style:top="{marquee.top}px" style:width="{marquee.width}px" style:height="{marquee.height}px"></div>
  {/if}
</div>

<style>
  .trace-view { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 10px 10px 24px; box-sizing: border-box; overflow-anchor: none; scrollbar-gutter: stable; }
  .marquee-rect { position: absolute; pointer-events: none; z-index: 10; box-sizing: border-box; border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 20%, transparent); }
  /* Progress text appears only when loading is slow, so a fast load never flashes it. A transition, not an
     animation: grid motion cancels band animations, and a cancelled transition shows the text at once. */
  .message { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 12px; color: var(--text-secondary); }
  .message button { padding: 4px 12px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  /* Over the content, out of flow: an error never moves the grid or changes its scroll extent. */
  .overlay-anchor { position: sticky; top: 0; height: 0; z-index: 11; }
  .overlay { position: absolute; top: -4px; right: 2px; z-index: 11; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px); box-sizing: border-box; padding: 4px 8px; font-size: 12px;
    color: var(--system-critical-text, var(--system-critical)); background: var(--background-solid); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); }
  .overlay span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .overlay button { flex: none; padding: 2px 8px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
</style>
