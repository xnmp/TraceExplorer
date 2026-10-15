<script module lang="ts">
  /** A folder cover's explorer treatment (the ordinary thumbnail and name, with the stack's disclosure). */
  export interface CoverVisual {
    readonly name: string; readonly count: number; readonly unsaved: boolean; readonly active: boolean;
    /** Whether the published scene shows the stack open (never a pending request). */
    readonly expanded: boolean;
    readonly imagePx?: number; readonly small: boolean;
    /** A requested open still preparing, or one that failed (with its error); null otherwise. */
    readonly progress?: "loading" | "arranging" | "failed" | null;
    readonly error?: string | null;
  }
</script>

<script lang="ts">
  /**
   * A tile's card: thumbnail, title, scope and hint. Shared by live tiles (`TraceTile`, which adds
   * the tooltip, actions, badges and selection semantics through `card` and `press`) and retiring
   * tiles (`RetiringTile`), which draw it passively: no button, handler or disclosure.
   */
  import type { Snippet } from "svelte";
  import type { SceneTile } from "$lib/domain/trace-graph/scene";
  import type { Orientation } from "$lib/domain/trace-graph/layout";
  import { TILE } from "$lib/domain/trace-graph/metrics";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { nodeStatus, nodeTitle } from "./node-target";
  import { nodeThumbnail } from "./scene-media";

  interface Props {
    tile: SceneTile;
    selected: boolean;
    revision: number;
    /** Which way the tile's component runs; an open chevron points towards the children. */
    orientation?: Orientation;
    explorer?: CoverVisual;
    /** A live tile's card semantics (a button's attributes and handlers; an attachment key may carry its tooltip). Passive when absent. */
    card?: Record<string | symbol, unknown> | null;
    /** A live cover's press target, laid over its card. */
    press?: Snippet;
    focused?: boolean;
    onfocus?: () => void;
    onstacktoggle?: (event: MouseEvent) => void;
    /** A band tile's caret: toggles the node's expansion. Without it the caret is drawn passively. */
    oncaret?: () => void;
    onkey?: (event: KeyboardEvent) => void;
    onretry?: () => void;
  }

  let { tile, selected, revision, orientation = "down", explorer, card = null, press, focused = true, onfocus, onstacktoggle, oncaret, onkey, onretry }: Props = $props();
  const preparing = $derived(explorer?.progress === "loading" || explorer?.progress === "arranging");
  const node = $derived(tile.node);
  const title = $derived(promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node));
  const status = $derived(nodeStatus(node));
  const thumbnail = $derived(nodeThumbnail(node));
  const unsaved = $derived(node.temporary && !node.discarded && node.artifactId !== null);
  const hint = $derived(tile.expandable
    ? tile.expanded ? `${tile.childCount} ${tile.childCount === 1 ? "child" : "children"} open`
      : tile.hiddenDescendants ? `${tile.hiddenDescendants} further ${tile.hiddenDescendants === 1 ? "edit" : "edits"}` : `${tile.childCount} ${tile.childCount === 1 ? "edit" : "edits"}`
    : "");
  const tag = $derived(!explorer && card ? "button" : "div");
  // Offered only where it changes what is shown (`bandCarets`): a control never does nothing visible.
  const caret = $derived(tile.togglable && !explorer);
  // Collapsed, the caret points across the band's flow; expanded, along it, towards the children.
  const caretPath = $derived(tile.expanded !== (orientation === "right") ? "m5 9 7 7 7-7" : "m9 5 7 7-7 7");
</script>

{#snippet contents()}
  <span class="image" style:height="{explorer?.imagePx ?? tile.size.imageHeight}px" style:width={explorer?.imagePx === undefined ? undefined : `${explorer.imagePx}px`}>
    {#if explorer && explorer.count >= 2}
      <span class="stack-sheet" aria-hidden="true"></span>
      {#if explorer.count >= 3}<span class="stack-sheet second-sheet" aria-hidden="true"></span>{/if}
    {/if}
    {#if node.state === "running"}
      <span class="spinner" role="status" aria-label="Generating"></span>
    {:else if thumbnail}
      <TraceThumbnail path={thumbnail} present={true} {revision} label="" prompt="" />
    {:else}
      <span class="placeholder" aria-hidden="true">▧</span>
    {/if}
    {#if explorer}
      {#if explorer.active && node.state !== "running"}<span class="spinner cover-spinner" role="status" aria-label="Generating"></span>{/if}
      <span class="count-badge" aria-hidden="true">{explorer.count}</span>
      {#if explorer.unsaved}<span class="cover-unsaved-dot" aria-hidden="true"></span>{/if}
      <!-- Cold open progress sits over the committed thumbnail and never resizes the cover. -->
      {#if preparing}<span class="cover-progress" role="status" aria-label="Loading stack" data-cover-progress><span class="spinner"></span></span>
      {:else if explorer.progress === "failed"}
        <span class="cover-error" role="alert" data-cover-error title={explorer.error ?? undefined}>
          <span class="cover-error-text">Could not open</span>
          <button type="button" class="cover-retry" data-cover-retry onclick={(event) => { event.stopPropagation(); onretry?.(); }}>Retry</button>
        </span>
      {/if}
    {/if}
  </span>
  <span class="label">
    {#if explorer}
      <span class="stack-name">
        <span class="text">{explorer.name}</span>
        <button type="button" class="stack-disclosure" class:expanded={explorer.expanded} tabindex={focused ? 0 : -1} {onfocus}
          data-stack-toggle aria-expanded={explorer.expanded} aria-label={preparing ? "Cancel opening stack" : explorer.progress === "failed" ? "Dismiss stack error" : explorer.expanded ? "Collapse stack" : "Expand stack"}
          onclick={onstacktoggle} onkeydown={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) onkey?.(event);
          }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      </span>
    {:else}<span class="text">{title}</span>{/if}
    {#if node.runId !== null && promptTitles.pending(node.runId)}<span class="title-spinner" role="status" aria-label="Generating title"></span>{/if}
    {#if unsaved && !explorer}<span class="unsaved-dot" aria-hidden="true"></span>{/if}
    <!-- The caret is the card's sibling (a button cannot hold one); this keeps its room in the label. -->
    {#if caret}<span class="caret-room" aria-hidden="true"></span>{/if}
  </span>
  {#if node.scope !== "current" && !explorer}
    <span class="scope {node.scope}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {#if node.scope === "external"}<path d="M6 18 18 6M7 6h11v11" />{:else}<path d="M3 6h6l2 2h10v12H3z" />{/if}
      </svg>
      {node.scope === "external" ? "External" : "Subfolder"}{#if status}<span class="status"> · {status}</span>{/if}
    </span>
    <span class="scope-path">{node.location}</span>
  {:else if status && !explorer}
    <span class="status-line">{status}</span>
  {/if}
{/snippet}

<svelte:element this={tag} {...card} class="card" class:selected class:focus={tile.tone === "focus"} class:discarded={node.discarded} aria-busy={explorer ? preparing : undefined}>
  {@render press?.()}
  {@render contents()}
</svelte:element>
{#if caret}
  {#if oncaret}
    <button type="button" class="caret" style:top="{tile.size.imageHeight + 8}px" tabindex={focused ? 0 : -1} {onfocus}
      data-node-caret={node.key} aria-expanded={tile.expanded} aria-label={tile.expanded ? "Collapse" : "Expand"}
      onclick={(event) => { event.stopPropagation(); oncaret(); }} ondblclick={(event) => event.stopPropagation()}
      onkeydown={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) onkey?.(event); }}>
      <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d={caretPath} /></svg>
    </button>
  {:else}
    <span class="caret" style:top="{tile.size.imageHeight + 8}px" aria-hidden="true"><svg class="chevron" viewBox="0 0 24 24"><path d={caretPath} /></svg></span>
  {/if}
{/if}
{#if hint && !explorer}<span class="hint" style:height="{TILE.hint}px">{hint}</span>{/if}

<style>
  :global(.explorer-cover) .card { position: relative; align-items: center; overflow: visible; background: none; border-color: transparent; }
  :global(.explorer-cover) .card:hover { background: var(--subtle-fill-secondary); }
  :global(.explorer-cover) .card.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  :global(.explorer-cover) .image { position: relative; isolation: isolate; overflow: visible; width: 100%; background: none; }
  /* At most two static sheets. Filters or extra composited decoration stall cold
     opens in the host's software renderer; the thumbnail keeps its ordinary bounds. */
  /* Opaque paper and a structural edge stay legible over pane, hover and selection
     surfaces in both themes. Percentage insets scale the fan while reserving room
     inside the tile; the cover and caption retain the ordinary thumbnail bounds. */
  /* No box-shadow: under the host's software renderer it cost ~350 ms of a cold folder open (native A/B, #69). */
  .stack-sheet { position: absolute; inset: 0 3% 4%; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--text-secondary) 65%, var(--background-solid)); border-radius: calc(var(--radius-sm) / 2); background: color-mix(in srgb, var(--text-primary) 18%, var(--background-solid)); z-index: -2; transform-origin: 50% 100%; transform: rotate(-8deg); }
  :global(.host-cover) .stack-sheet { translate: 0 -3%; }
  :global(.explorer-cover:not(.host-cover)) .stack-sheet { inset-inline: 3.5%; }
  .second-sheet { z-index: -1; transform: rotate(7deg); }
  :global(.explorer-cover) .image :global(.thumbnail) { border-radius: var(--radius-sm); }
  :global(.explorer-cover) .image, :global(.explorer-cover) .label { pointer-events: none; }
  :global(.explorer-cover) .label { position: relative; width: 100%; height: auto; min-height: 20px; justify-content: center; font-size: 11px; line-height: 14px; }
  .stack-name { display: flex; align-items: flex-end; gap: 2px; width: max-content; max-width: 100%; min-width: 0; min-height: 20px; }
  /* Reserve the disclosure's own column before clamping. Ellipsis cannot clip the control. */
  :global(.explorer-cover) .text { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  /* Align the final text line with disclosure, including a short untruncated last line. */
  :global(.explorer-cover) .text { text-align: end; }
  :global(.host-cover) .card { padding: 12px 8px 10px; }
  :global(.host-cover.small-cover) .card { padding: 6px 4px; }
  :global(.host-cover) .label { height: 37px; align-items: flex-start; font-size: 13px; line-height: 1.4; }
  :global(.host-cover) .text { font-size: 13px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .cover-spinner { position: absolute; top: 3px; right: 3px; }
  /* Busy state is immediate (aria-busy); the spinner shows only when opening is slow, so a fast open never flashes it. */
  .cover-progress { position: absolute; inset: 0; display: grid; place-items: center; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--background-solid) 45%, transparent); transition: opacity 150ms ease-out 400ms; }
  @starting-style { .cover-progress { opacity: 0; } }
  .cover-progress .spinner { width: 18px; height: 18px; }
  .cover-error { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 4px; box-sizing: border-box; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--background-solid) 78%, transparent); color: var(--system-critical-text, var(--system-critical)); font-size: 11px; line-height: 13px; text-align: center; }
  .cover-retry { pointer-events: auto; padding: 2px 8px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .cover-retry:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .count-badge { position: absolute; bottom: -3px; right: -3px; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--radius-pill); background: var(--accent); color: var(--text-on-accent); font-size: 10px; line-height: 16px; text-align: center; }
  .cover-unsaved-dot { position: absolute; left: -2px; top: -2px; width: 6px; height: 6px; border: 2px solid var(--background-solid); border-radius: 50%; background: var(--system-caution-text, var(--system-caution)); }
  .stack-disclosure { flex: none; display: grid; place-items: center; width: 20px; height: 20px; margin-bottom: calc((1lh - 20px) / 2); padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-secondary); cursor: pointer; pointer-events: auto; font: inherit; }
  .stack-disclosure svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .stack-disclosure.expanded svg { transform: rotate(90deg); }
  .stack-disclosure:hover, .stack-disclosure:focus-visible { background: color-mix(in srgb, var(--accent) 32%, var(--background-solid)); color: var(--accent); }
  .stack-disclosure:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .card { display: flex; flex-direction: column; align-items: stretch; box-sizing: border-box; width: 100%; padding: 5px; overflow: hidden; text-align: left; font: inherit; color: var(--text-primary); background: var(--background-card-secondary, var(--control-fill)); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .card:hover { background: var(--subtle-fill-secondary); }
  /* Selection shows in styling, never size: an accent border, and for the focus a ring and halo. */
  .card.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--background-card-secondary)); }
  .card.focus { box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px color-mix(in srgb, var(--accent) 24%, transparent); }
  .card:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .card.discarded { border-style: dashed; }
  .image { display: grid; place-items: center; flex: none; overflow: hidden; border-radius: 2px; background: var(--subtle-fill-secondary, rgba(127,127,127,.08)); }
  .image :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .image :global(img) { object-fit: cover !important; }
  .placeholder { color: var(--text-secondary); font-size: 20px; }
  .label { display: flex; align-items: center; gap: 3px; min-width: 0; height: 14px; margin-top: 4px; }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 14px; }
  .chevron { width: 11px; height: 11px; flex: none; fill: none; stroke: var(--text-secondary); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .caret-room { width: 11px; height: 11px; flex: none; }
  /* Over the card's label row, where the room is kept: an 18 px target around the 11 px chevron. */
  .caret { position: absolute; right: 3px; z-index: 1; display: grid; place-items: center; width: 18px; height: 18px; box-sizing: border-box; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; font: inherit; }
  button.caret { cursor: pointer; }
  button.caret:hover, button.caret:focus-visible { background: color-mix(in srgb, var(--accent) 32%, var(--background-solid)); }
  button.caret:hover .chevron, button.caret:focus-visible .chevron { stroke: var(--accent); }
  button.caret:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .unsaved-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--system-caution-text, var(--system-caution)); }
  .scope { display: flex; align-items: center; gap: 3px; height: 14px; margin-top: 3px; font-size: 10px; color: var(--accent-text, var(--accent)); white-space: nowrap; overflow: hidden; }
  .scope.external { color: var(--system-caution-text, var(--system-caution)); }
  .scope svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .scope-path, .status-line { height: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 11px; color: var(--text-secondary); }
  .status { color: var(--text-secondary); }
  .hint { display: block; box-sizing: border-box; padding-top: 3px; text-align: center; font-size: 10px; line-height: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(.unrelated) > .card { opacity: .78; }
  /* Explorer covers dim through card opacity. Filtering their isolated thumbnail
   * and stacked sheets makes a cold open stall in the host's software renderer. */
  :global(.unrelated:not(.explorer-cover)) > .card .image { filter: grayscale(.45); }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  .title-spinner { width: 8px; height: 8px; flex: none; border: 1px solid var(--control-stroke); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Cards have no transitions: selection, focus and dimming are scene styling and change in the frame the
     scene commits (a transition paints the previous look first, and a main-thread stall holds it). Hover
     shares the card's background, so it is instant too. */
  @media (prefers-reduced-motion: no-preference) { .stack-disclosure { transition: background-color var(--transition-fast), color var(--transition-fast); } }
  @media (prefers-reduced-motion: reduce) { .spinner, .title-spinner { animation: none; } }
</style>
