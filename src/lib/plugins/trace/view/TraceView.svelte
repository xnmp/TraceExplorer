<script lang="ts">
  /**
   * The Trace file view: replaces the pane's listing with one collapsible
   * section per connected component and an ordinary section for everything
   * without provenance. All view state (folder session, expansion, anchors)
   * belongs to this pane; selection and Preview go through the pane handle.
   */
  import { flushSync, onDestroy, untrack } from "svelte";
  import type { FileViewPane, PreviewTarget } from "../../../../../integration/plugin-sdk";
  import type { FileEntry } from "$lib/domain/file";
  import { parentDir, samePath } from "$lib/domain/path";
  import type { ComponentSummary, NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
  import type { Orientation } from "$lib/domain/trace-graph/layout";
  import { tileMetrics } from "$lib/domain/trace-graph/metrics";
  import { traceInvalidation } from "../invalidation.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import { createFolderSession, type ComponentData, type FolderSession } from "./folder-session.svelte";
  import { tracePanes, isTraceTargetData, type TracePaneView } from "./pane-registry.svelte";
  import { NO_PICKS, clickListed, dropPick, followPicks, picksFromHost, pickOnly, pickable, replacePick, resolvePicks, selectionKey, settlePicks, togglePick, type PickLocation, type Picks } from "./input-picks";
  import { nodeTarget } from "./node-target";
  import { holdAnchor, layoutHeight, MOTION_MS, prefersReducedMotion, resizeSection, scrollsByUser, sectionHeight, USER_SCROLL } from "./motion";
  import TraceGraph from "./TraceGraph.svelte";
  import OrdinarySection from "./OrdinarySection.svelte";

  interface Props { pane: FileViewPane; session?: FolderSession }
  let { pane, session: provided }: Props = $props();

  const session = untrack(() => provided) ?? createFolderSession();
  /** Sections expanded by default: the first few, plus whichever holds the focus. */
  const DEFAULT_EXPANDED = 3;
  /** Width is quantized so resizing does not relayout on every pixel. */
  const WIDTH_STEP = 16;
  /** Horizontal space around a graph: the view's 10px padding and the section's 1px borders. */
  const GRAPH_CHROME = 22;
  /** Sections this far outside the viewport keep only a sized placeholder. */
  const NEAR_MARGIN = "1200px 0px";
  const ANCHOR_WINDOW_MS = 1500;

  let scroller = $state<HTMLElement | null>(null);
  let clientWidth = $state(0);
  let overrides = $state.raw<ReadonlyMap<string, boolean>>(new Map());
  /** Collapsed sections whose content stays mounted until it has been hidden. */
  let closing = $state.raw<ReadonlySet<string>>(new Set());
  /** Each section's running expand or collapse. */
  const sectionMotions = new Map<string, Animation[]>();
  let near = $state.raw<ReadonlySet<string>>(new Set());
  let heights = new Map<string, number>();
  /** Orientation each component of this folder was last shown with, by component id: kept across collapse and remount for hysteresis. */
  const orientations = new Map<string, Orientation>();
  /** A save into this folder waiting for the listing to contain its file; see `callbacks.saved`. */
  let pendingSave = $state.raw<{ directory: string; path: string; key: NodeKey; picks: Picks } | null>(null);
  let anchor: { key: NodeKey; mode: "hold" | "reveal"; rect: DOMRect | null; until: number } | null = null;
  let releaseAnchor: (() => void) | null = null;
  const issuedTargets = new WeakMap<PreviewTarget, TraceNode>();

  const directory = $derived(pane.directory);
  const width = $derived(Math.max(0, Math.floor((clientWidth - GRAPH_CHROME - 2) / WIDTH_STEP) * WIDTH_STEP));
  const revision = $derived(traceInvalidation.revision);
  // Trace tiles follow the host's tile-size setting for this pane; older hosts
  // (without the "tileSize" capability) leave it undefined: the default tile.
  const imagePx = $derived(pane.tileSize?.imagePx);
  const tile = $derived(tileMetrics(imagePx));
  const entriesByPath = $derived(new Map(pane.entries.map((entry) => [entry.path, entry])));

  // Session follows the pane's folder and Trace's invalidation signal.
  $effect(() => { const dir = directory; untrack(() => { overrides = new Map(); orientations.clear(); session.setDirectory(dir); }); });
  let seenRevision = untrack(() => traceInvalidation.revision);
  $effect(() => {
    const current = traceInvalidation.revision;
    if (current === seenRevision) return;
    seenRevision = current;
    untrack(() => void session.refresh());
  });

  const summaries = $derived<readonly ComponentSummary[]>(session.index?.components ?? []);
  const ordinary = $derived(session.index ? pane.entries.filter((entry) => !session.index!.members.has(entry.path)) : []);

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
    const targetNode = targetData ? findNode(targetData.key)?.node : undefined;
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
  /** Whether a component's loaded data is current (loaded, and not skipped by a refresh). */
  const fresh = (id: string) => session.components.has(id) && !session.isStale(id);
  /**
   * Where an extra's node is now, from current data only: a copy in data a
   * refresh skipped may be out of date (discarded since, say), so it is
   * "unknown" until reloaded, as is a node in no loaded component while some
   * component is not loaded fresh.
   */
  function locateExtra(key: NodeKey): PickLocation {
    let unknown = false;
    for (const [componentId, data] of session.components) {
      const node = data.dag.nodes.get(key);
      if (!node) continue;
      if (!session.isStale(componentId)) return { node, componentId };
      unknown = true;
    }
    return unknown || !summaries.every((summary) => fresh(summary.id)) ? "unknown" : null;
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
      if (own && listed.has(own) && (!fresh(own) || session.components.get(own)!.dag.nodes.has(extra.key))) { ids.add(own); continue; }
      for (const summary of summaries) if (!fresh(summary.id)) ids.add(summary.id);
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
    overrides.get(summary.id) ?? (index < DEFAULT_EXPANDED || summary.id === focus?.componentId);

  // Load what is expanded and near the viewport, and every component holding an
  // extra pick (so a pick in a collapsed section is checked against fresh
  // data); release the rest.
  $effect(() => {
    const picked = pickComponents;
    const wanted = summaries.filter((summary, index) => (isExpanded(summary, index) && near.has(summary.id)) || picked.has(summary.id)).map((summary) => summary.id);
    untrack(() => {
      for (const summary of summaries) if (!wanted.includes(summary.id)) session.release(summary.id);
      for (const id of wanted) void session.ensure(id);
    });
  });

  function findNode(key: NodeKey): { node: TraceNode; componentId: string } | null {
    for (const [componentId, data] of session.components) {
      const node = data.dag.nodes.get(key);
      if (node) return { node, componentId };
    }
    return null;
  }

  const fileEntry = (node: TraceNode): FileEntry | null =>
    node.scope === "current" && node.path && !node.temporary && !node.earlierRevision ? entriesByPath.get(node.path) ?? null : null;

  // How the view keeps the chosen tile in sight through the relayout it
  // causes: a click holds the tile where it was on screen; keyboard and
  // programmatic navigation reveal it once motion settles.
  function captureAnchor(key: NodeKey, mode: "hold" | "reveal"): void {
    const element = scroller?.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(key)}"]`);
    anchor = element || mode === "reveal" ? { key, mode, rect: element?.getBoundingClientRect() ?? null, until: performance.now() + ANCHOR_WINDOW_MS } : null;
  }

  // The anchor belongs to the commit the selection caused: only the graph
  // that shows the chosen tile uses it, once. Other sections relaying out
  // (their focus changed too) must not move the scroll position.
  function keepAnchor(data: ComponentData, settled: Promise<void>): void {
    const current = anchor;
    if (!current || !scroller || performance.now() > current.until || !data.dag.nodes.has(current.key)) return;
    anchor = null;
    releaseAnchor?.();
    const find = () => scroller?.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(current.key)}"]`) ?? null;
    if (current.mode === "hold" && current.rect) {
      releaseAnchor = holdAnchor(scroller, find, current.rect, prefersReducedMotion() ? 0 : MOTION_MS + 40);
      return;
    }
    let live = true;
    releaseAnchor = () => { live = false; };
    void settled.then(() => { if (live) find()?.scrollIntoView({ block: "nearest", inline: "nearest" }); });
  }

  // Scrolling by the user cancels a pending anchor or reveal.
  $effect(() => {
    const element = scroller;
    if (!element) return;
    const cancel = (event: Event) => { if (scrollsByUser(event)) { anchor = null; releaseAnchor?.(); } };
    for (const type of USER_SCROLL) element.addEventListener(type, cancel, { passive: true, capture: true });
    return () => { for (const type of USER_SCROLL) element.removeEventListener(type, cancel, { capture: true }); };
  });

  // A save claims the selection only if the selection is unchanged since the
  // save began, so a slow save never overrides a newer choice.
  const selectionStamp = () => `${targetData?.key ?? ""}\n${pane.selection.map((entry) => entry.path).join("\n")}`;
  const captureSelection = () => {
    const stamp = selectionStamp(), before = picks;
    // A new pick (a Ctrl-click on an unsaved image, say) is a newer choice too.
    return () => stamp === selectionStamp() && before === picks;
  };
  const callbacks = {
    capture: captureSelection,
    /**
     * A save finished while the selection was unchanged. A save into this
     * folder selects its file once the listing has it; one elsewhere needs
     * nothing: its pick follows the node to the saved path (followPicks).
     */
    saved(path: string, key: NodeKey) { if (samePath(parentDir(path), directory)) pendingSave = { directory, path, key, picks }; },
    discarded(key: NodeKey) { commitPicks(dropPick(livePicks, key)); },
  };

  function preview(node: TraceNode, componentId: string): void {
    const next = nodeTarget(node, componentId, directory, callbacks);
    issuedTargets.set(next, node);
    pane.setPreviewTarget(next);
  }

  function focusNode(key: NodeKey, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}, keep: "hold" | "reveal" = "reveal"): void {
    const found = findNode(key);
    if (!found) return;
    keepFocusedOpen();
    captureAnchor(key, keep);
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

  function activate(key: NodeKey, event: MouseEvent): void {
    focusNode(key, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }, "hold");
  }

  function open(key: NodeKey): void {
    const found = findNode(key);
    const entry = found && fileEntry(found.node);
    if (entry) void pane.open(entry);
  }

  function menu(key: NodeKey, event: MouseEvent): void {
    const found = findNode(key);
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

  function background(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    keepFocusedOpen();
    pane.clearSelection();
    if (targetData) pane.setPreviewTarget(null);
    commitPicks(NO_PICKS);
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

  // Keep this pane's Preview target in step with refreshed node data.
  $effect(() => {
    const current = target, data = targetData;
    if (!current || !data) return;
    const fresh = session.components.get(data.componentId)?.dag.nodes.get(data.key);
    if (!fresh || issuedTargets.get(current) === fresh) return;
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
      preview(fresh, data.componentId);
      if (picks !== before) { void hostChoice; picks = settlePicks(before, hostSelected); }
    });
  });

  const view: TracePaneView = {
    get directory() { return directory; },
    node: (key) => findNode(key)?.node ?? null,
    nodeForPath: (path) => { const member = session.componentOf(path); return member ? findNode(member.key)?.node ?? null : null; },
    focus: (key) => {
      const found = findNode(key);
      if (found && !summaries.some((summary, index) => summary.id === found.componentId && isExpanded(summary, index))) setExpanded(found.componentId, true);
      else if (found) overrides = new Map(overrides).set(found.componentId, true);
      focusNode(key);
    },
    get active() { return pane.active; },
    inputs: () => inputs,
  };
  $effect(() => tracePanes.set(pane.paneId, view));

  // Titles for visible components are generated in the background, as before.
  // Re-runs when title generation becomes configured, not only on data changes.
  $effect(() => {
    if (!promptTitles.configured) return;
    for (const data of session.components.values()) for (const node of data.nodes) if (node.runId !== null) untrack(() => promptTitles.loadFor(node.runId, node.prompt));
  });

  const withClosing = (id: string, on: boolean): ReadonlySet<string> => {
    if (closing.has(id) === on) return closing;
    const next = new Set(closing);
    if (on) next.add(id); else next.delete(id);
    return next;
  };

  /**
   * Expands or collapses a section. The section's layout changes once; its
   * displayed height then follows by clip and transform (see resizeSection),
   * starting from what is displayed now, so a change interrupting another
   * reverses smoothly.
   */
  function setExpanded(id: string, opening: boolean): void {
    const section = scroller?.querySelector<HTMLElement>(`section[data-component="${CSS.escape(id)}"]`) ?? null;
    const body = () => section?.querySelector<HTMLElement>(":scope > .content") ?? null;
    const animate = !!section && !!scroller && !prefersReducedMotion();
    const shown = animate ? body() : null;
    const from = animate ? { height: sectionHeight(section!), opacity: shown ? Number(getComputedStyle(shown).opacity) : 0 } : null;
    for (const animation of sectionMotions.get(id) ?? []) animation.cancel();
    sectionMotions.delete(id);
    overrides = new Map(overrides).set(id, opening);
    closing = withClosing(id, !opening && animate);
    if (!from) return;
    // Mount (or keep) the content now, so the new layout can be measured.
    flushSync();
    const view = scroller!;
    const content = body();
    const layout = layoutHeight(section!);
    const removed = opening || !content ? 0 : layoutHeight(content);
    // Removing the content may leave the scroll position past the end; the view then scrolls back by the excess.
    const settle = opening ? 0 : Math.max(0, view.scrollTop - (view.scrollHeight - removed - view.clientHeight));
    const animations = resizeSection(section!, content, { from, to: layout - removed, opening, settle });
    sectionMotions.set(id, animations);
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (sectionMotions.get(id) !== animations) return;
      sectionMotions.delete(id);
      if (opening) return;
      // Drop the hidden content and the held final frame together, so nothing shifts.
      closing = withClosing(id, false);
      flushSync();
      for (const animation of animations) animation.cancel();
    }, () => {});
  }

  function toggle(summary: ComponentSummary, index: number): void {
    setExpanded(summary.id, !isExpanded(summary, index));
  }

  /**
   * A section open only because it holds the focus stays open when the focus
   * moves on: closing it under the pointer would move everything below it.
   */
  function keepFocusedOpen(): void {
    const id = focus?.componentId;
    if (id && !overrides.has(id) && summaries.some((summary, index) => summary.id === id && isExpanded(summary, index))) overrides = new Map(overrides).set(id, true);
  }

  /** Tracks which sections are near the viewport. */
  function nearby(element: HTMLElement, id: string) {
    let current = id;
    const observer = new IntersectionObserver((records) => {
      let next: Set<string> | null = null;
      for (const record of records) {
        const has = near.has(current);
        if (record.isIntersecting !== has) { next ??= new Set(near); if (record.isIntersecting) next.add(current); else next.delete(current); }
      }
      if (next) near = next;
    }, { root: scroller, rootMargin: NEAR_MARGIN });
    observer.observe(element);
    return {
      update(value: string) { current = value; },
      destroy() { observer.disconnect(); if (near.has(current)) { const next = new Set(near); next.delete(current); near = next; } },
    };
  }

  function measure(element: HTMLElement, id: string) {
    const observer = new ResizeObserver(() => { if (element.offsetHeight) heights.set(id, element.offsetHeight); });
    observer.observe(element);
    return { destroy() { observer.disconnect(); } };
  }

  onDestroy(() => {
    releaseAnchor?.();
    for (const animations of sectionMotions.values()) for (const animation of animations) animation.cancel();
    session.dispose();
    if (pane.previewTarget && isTraceTargetData(pane.previewTarget.data)) pane.setPreviewTarget(null);
  });

  const countLabel = (summary: ComponentSummary) => `${summary.imageCount} ${summary.imageCount === 1 ? "image" : "images"}`;
  const graphData = (id: string): ComponentData | undefined => session.components.get(id);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="trace-view" bind:this={scroller} bind:clientWidth onclick={background}
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
    {#each summaries as summary, index (summary.id)}
      {@const expanded = isExpanded(summary, index)}
      {@const data = graphData(summary.id)}
      <section class="component" class:dimmed={focus !== null && focus.componentId !== summary.id}
        data-component={summary.id} aria-label={summary.title} use:nearby={summary.id}>
        <button type="button" class="heading" aria-expanded={expanded} onclick={() => toggle(summary, index)}>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? "m5 9 7 7 7-7" : "m9 5 7 7-7 7"} /></svg>
          {#if summary.cover}<span class="cover"><TraceThumbnail path={summary.cover.path} present={summary.cover.present} {revision} label="" /></span>{/if}
          <span class="name">{summary.title}</span>
          <span class="count">{countLabel(summary)}</span>
          {#if summary.active}<span class="spinner" role="status" aria-label="Generating"></span>{/if}
          {#if summary.unsaved}<span class="unsaved" title="Contains unsaved images">Unsaved</span>{/if}
        </button>
        {#if expanded || closing.has(summary.id)}
          <div class="content" data-horizontal-scroll inert={!expanded}>
            {#if !near.has(summary.id)}
              <div class="placeholder" style:height="{heights.get(summary.id) ?? 160}px"></div>
            {:else if data}
              <div use:measure={summary.id}>
                <TraceGraph {data} focus={focus?.key ?? null} selected={selectedKeys} {width} {tile} {revision} {scroller}
                  onactivate={activate} onnavigate={(key) => focusNode(key)} onopen={open} onmenu={menu}
                  {captureSelection} componentId={summary.id} {orientations} onsaved={(key, path) => callbacks.saved(path, key)} ondiscarded={(key) => callbacks.discarded(key)} oncommit={(settled) => keepAnchor(data, settled)} />
              </div>
            {:else}
              <div class="placeholder loading" role="status" style:height="{heights.get(summary.id) ?? 160}px">Loading…</div>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
    {#if session.error && session.index}<p class="notice" role="alert">{session.error}</p>{/if}
    {#if ordinary.length}
      <section class="component ordinary" aria-label="Other files">
        <h3 class="heading static">Other files and folders <span class="count">{ordinary.length}</span></h3>
        <OrdinarySection entries={ordinary} selected={selectedPaths} {revision} size={pane.tileSize?.preset} {tile}
          onselect={(entry, event) => { keepFocusedOpen(); selectListed(entry, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }); }}
          onopen={(entry) => void pane.open(entry)}
          onmenu={(entry, event) => { if (!selectedPaths.has(entry.path)) { keepFocusedOpen(); selectListed(entry); } pane.contextMenu(event, entry); }} />
      </section>
    {:else if !summaries.length && session.index}
      <div class="message">This folder is empty.</div>
    {/if}
  {/if}
</div>

<style>
  .trace-view { flex: 1; min-height: 0; overflow: auto; padding: 10px 10px 24px; box-sizing: border-box; overflow-anchor: none; scrollbar-gutter: stable; }
  .component { margin-bottom: 10px; border: 1px solid var(--divider, var(--control-stroke)); border-radius: 5px; background: var(--background-card-secondary, transparent); overflow: hidden; }
  .heading { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 41px; margin: 0; padding: 9px 12px; box-sizing: border-box; font: inherit; font-size: 13px; text-align: left; color: var(--text-primary); background: none; border: 0; cursor: pointer; }
  .heading:hover:not(.static) { background: var(--subtle-fill-secondary); }
  .heading.static { cursor: default; font-weight: 400; }
  .heading:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .chevron { width: 14px; height: 14px; flex: none; fill: none; stroke: var(--text-secondary); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .cover { display: block; flex: none; width: 29px; height: 20px; overflow: hidden; border-radius: 2px; }
  .cover :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .cover :global(img) { object-fit: cover !important; }
  .cover :global(.placeholder) { font-size: 12px; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .count { color: var(--text-secondary); white-space: nowrap; }
  .unsaved { padding: 0 6px; font-size: 11px; line-height: 16px; color: var(--system-caution-text, var(--system-caution)); border: 1px solid currentColor; border-radius: 8px; }
  .dimmed .cover { filter: grayscale(.45); opacity: .78; }
  .content { border-top: 1px solid var(--divider, var(--control-stroke)); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  .placeholder { display: grid; place-items: center; color: var(--text-secondary); font-size: 12px; }
  .message { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 12px; color: var(--text-secondary); }
  .message button { padding: 4px 12px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .notice { margin: 0 0 10px; font-size: 12px; color: var(--system-critical-text, var(--system-critical)); }
  .spinner { width: 12px; height: 12px; flex: none; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
