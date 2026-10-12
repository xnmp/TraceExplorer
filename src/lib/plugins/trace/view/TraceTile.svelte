<script lang="ts">
  import type { SceneTile } from "$lib/domain/trace-graph/scene";
  import type { Orientation, PlacedNode } from "$lib/domain/trace-graph/layout";
  import { TILE } from "$lib/domain/trace-graph/metrics";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import TraceImageActions from "../TraceImageActions.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { nodeStatus, nodeTitle } from "./node-target";
  import type { TraceArtifact } from "$lib/api/trace";
  import { tileTooltipContent } from "./tooltip/content";
  import { tooltipTrigger } from "./tooltip/controller.svelte";
  import { previewData } from "./preview-data.svelte";

  import type { ReferenceBadge } from "$lib/domain/trace-graph/projection";
  import ReferenceBadges from "./ReferenceBadges.svelte";

  interface Props {
    /** Folder covers use the ordinary explorer thumbnail/name treatment, retaining graph actions. */
    explorer?: { readonly name: string; readonly count: number; readonly unsaved: boolean; readonly active: boolean; readonly imagePx?: number; readonly small: boolean };
    badgeNodes?: ReadonlyMap<string, import("$lib/domain/trace-graph/model").TraceNode>;
    badges?: readonly ReferenceBadge[];
    badgeSelection?: ReadonlySet<string>;
    onbadge?: (key: string, event: MouseEvent) => void;
    onbadgehover?: (key: string | null) => void;
    onclose?: () => void;
    focused?: boolean;
    onfocus?: () => void;
    tile: SceneTile;
    placed: PlacedNode;
    /** Which way the tile's component runs; an open chevron points towards the children. */
    orientation?: Orientation;
    selected: boolean;
    revision: number;
    onactivate: (event: MouseEvent) => void;
    onopen: () => void;
    onmenu: (event: MouseEvent) => void;
    onkey: (event: KeyboardEvent) => void;
    onsaved: (path: string, select: boolean) => void;
    ondiscarded: () => void;
    captureSelection?: () => () => boolean;
  }

  let { tile, placed, orientation = "down", selected, revision, onactivate, onopen, onmenu, onkey, onsaved, ondiscarded, captureSelection, badges = [], badgeNodes, badgeSelection = new Set(), onbadge, onbadgehover, onclose, focused = true, onfocus, explorer }: Props = $props();
  const node = $derived(tile.node);
  const title = $derived(promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node));
  const status = $derived(nodeStatus(node));
  const present = $derived(node.state === "present" && !node.earlierRevision && !node.discarded && !!node.path);
  const unsaved = $derived(node.temporary && !node.discarded && node.artifactId !== null);
  // The tooltip reads these while it shows; its run details load only once it opens.
  const tooltip = tooltipTrigger({
    content: () => tileTooltipContent(node, node.runId === null ? null : previewData.runs.read(node.runId, revision).value),
    onshow: () => { if (node.runId !== null) previewData.runs.request(node.runId, revision); },
  });
  // Hover actions reuse the established save/delete flow for unsaved outputs.
  const artifact = $derived<TraceArtifact | null>(unsaved && node.artifactId !== null && node.path ? {
    id: node.artifactId, path: node.path, digest: "", createdAt: "", generatingRun: node.runId,
    pathState: node.state === "present" ? "present" : node.state === "missing" ? "missing" : "unavailable", temporary: true, discarded: false,
  } : null);
  const hint = $derived(tile.expandable
    ? tile.tone === "focus" ? `${tile.childCount} ${tile.childCount === 1 ? "child" : "children"} open`
      : tile.hiddenDescendants ? `${tile.hiddenDescendants} further ${tile.hiddenDescendants === 1 ? "edit" : "edits"}` : `${tile.childCount} ${tile.childCount === 1 ? "edit" : "edits"}`
    : "");
</script>

<div class="tile" class:explorer-cover={!!explorer} class:host-cover={explorer?.imagePx !== undefined} class:small-cover={explorer?.small} class:unrelated={tile.tone === "unrelated"} class:foreign={node.scope !== "current"}
  role="gridcell" aria-selected={selected} data-tile-key={node.key} data-scope={node.scope} data-tone={tile.tone}
  style:left="{placed.x}px" style:top="{placed.y}px" style:width="{placed.width}px" style:height="{placed.height}px">
  <button type="button" class="card" class:selected class:focus={tile.tone === "focus"} class:discarded={node.discarded}
    tabindex={focused ? 0 : -1} {onfocus} data-node-key={node.key} aria-pressed={selected} {@attach explorer && !onclose ? null : tooltip}
    data-stack-toggle={explorer && !onclose ? "" : undefined} aria-expanded={explorer && !onclose ? false : undefined}
    aria-label="{explorer?.name ?? title}{explorer ? `, ${explorer.count} images` : ""}{status ? `, ${status}` : ""}{unsaved || explorer?.unsaved ? ", unsaved" : ""}{node.scope === "external" ? ", outside this folder" : node.scope === "subfolder" ? ", in a subfolder" : ""}"
    onclick={onactivate} ondblclick={onopen} oncontextmenu={onmenu} onkeydown={onkey}>
    <span class="image" style:height="{explorer?.imagePx ?? tile.size.imageHeight}px" style:width={explorer?.imagePx === undefined ? undefined : `${explorer.imagePx}px`}>
      {#if node.state === "running"}
        <span class="spinner" role="status" aria-label="Generating"></span>
      {:else if present}
        <TraceThumbnail path={node.path!} present={true} {revision} label="" prompt="" />
      {:else}
        <span class="placeholder" aria-hidden="true">▧</span>
      {/if}
      {#if explorer}
        {#if explorer.active && node.state !== "running"}<span class="spinner cover-spinner" role="status" aria-label="Generating"></span>{/if}
        <span class="count-badge" aria-hidden="true">{explorer.count}</span>
        {#if explorer.unsaved}<span class="cover-unsaved-dot" aria-hidden="true"></span>{/if}
      {/if}
    </span>
    <span class="label">
      <span class="text">{explorer?.name ?? title}</span>
      {#if node.runId !== null && promptTitles.pending(node.runId)}<span class="title-spinner" role="status" aria-label="Generating title"></span>{/if}
      {#if unsaved && !explorer}<span class="unsaved-dot" aria-hidden="true"></span>{/if}
      {#if tile.expandable && !onclose && !explorer}
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d={tile.tone === "focus" && orientation === "down" ? "m5 9 7 7 7-7" : "m9 5 7 7-7 7"} /></svg>
      {/if}
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
  </button>
  {#if onclose}<button type="button" class="close-stack" data-stack-toggle aria-expanded="true" aria-label="Close stack" onclick={onclose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>{/if}
  {#if badges.length && onbadge}<ReferenceBadges {badges} nodes={badgeNodes} {revision} selected={badgeSelection} onactivate={onbadge} onhover={onbadgehover} />{/if}
  {#if hint && !explorer}<span class="hint" style:height="{TILE.hint}px">{hint}</span>{/if}
  {#if artifact}
    <div class="actions">
      <TraceImageActions {artifact} onSelectFile={async (path, select) => onsaved(path, select)} selectAfterSave={true} {captureSelection}
        onDiscard={() => ondiscarded()} />
    </div>
  {/if}
</div>

<style>
  .explorer-cover .card { align-items: center; overflow: visible; background: none; border-color: transparent; }
  .explorer-cover .card:hover { background: var(--subtle-fill-secondary); }
  .explorer-cover .card.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .explorer-cover .image { position: relative; isolation: isolate; overflow: visible; width: 100%; background: none; }
  .explorer-cover .image::before, .explorer-cover .image::after { content: ""; position: absolute; inset: -4px -3px 4px 3px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--background-card-secondary); z-index: -1; }
  .explorer-cover .image::after { inset: -2px -1px 2px 1px; }
  .explorer-cover .image :global(.thumbnail) { border-radius: var(--radius-sm); }
  .explorer-cover .label { width: 100%; }
  .explorer-cover .text { text-align: center; }
  .host-cover .card { padding: 12px 8px 10px; }
  .host-cover.small-cover .card { padding: 6px 4px; }
  .host-cover .label { height: 37px; align-items: flex-start; }
  .host-cover .text { font-size: 13px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .cover-spinner { position: absolute; top: 3px; right: 3px; }
  .count-badge { position: absolute; bottom: -3px; right: -3px; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--radius-pill); background: var(--accent); color: var(--text-on-accent); font-size: 10px; line-height: 16px; text-align: center; }
  .cover-unsaved-dot { position: absolute; left: -2px; top: -2px; width: 6px; height: 6px; border: 2px solid var(--background-solid); border-radius: 50%; background: var(--system-caution-text, var(--system-caution)); }
  .close-stack { position: absolute; right: 5px; bottom: -24px; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-secondary); cursor: pointer; }
  .close-stack svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .close-stack:hover, .close-stack:focus-visible { background: color-mix(in srgb, var(--accent) 32%, var(--background-solid)); color: var(--accent); }
  .close-stack:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .tile { position: absolute; box-sizing: border-box; }
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
  .card:hover .chevron, .card:focus-visible .chevron { stroke: var(--text-primary); }
  .unsaved-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--system-caution-text, var(--system-caution)); }
  .scope { display: flex; align-items: center; gap: 3px; height: 14px; margin-top: 3px; font-size: 10px; color: var(--accent-text, var(--accent)); white-space: nowrap; overflow: hidden; }
  .scope.external { color: var(--system-caution-text, var(--system-caution)); }
  .scope svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .scope-path, .status-line { height: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 11px; color: var(--text-secondary); }
  .status { color: var(--text-secondary); }
  .hint { display: block; box-sizing: border-box; padding-top: 3px; text-align: center; font-size: 10px; line-height: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unrelated .card { opacity: .78; }
  .unrelated .image { filter: grayscale(.45); }
  /* The action chip sits in the image's top-right corner; status messages hang below it. */
  .actions { position: absolute; top: 9px; right: 9px; display: flex; flex-direction: column; align-items: flex-end; visibility: hidden; }
  .actions :global(p) { position: absolute; right: 0; top: 100%; }
  .tile:hover .actions, .tile:focus-within .actions { visibility: visible; }
  @media (hover: none) { .actions { visibility: visible; } }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  .title-spinner { width: 8px; height: 8px; flex: none; border: 1px solid var(--control-stroke); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: no-preference) { .close-stack { transition: background-color var(--transition-fast), color var(--transition-fast); } .card { transition: background-color 120ms, border-color 120ms, box-shadow 120ms, opacity 160ms, filter 160ms; } .image { transition: filter 160ms; } }
  @media (prefers-reduced-motion: reduce) { .spinner, .title-spinner { animation: none; } }
</style>
