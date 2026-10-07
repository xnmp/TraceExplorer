<script lang="ts">
  import type { SceneTile } from "$lib/domain/trace-graph/scene";
  import type { PlacedNode } from "$lib/domain/trace-graph/layout";
  import { TILE } from "$lib/domain/trace-graph/metrics";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import TraceImageActions from "../TraceImageActions.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { nodeStatus, nodeTitle } from "./node-target";
  import type { TraceArtifact } from "$lib/api/trace";

  interface Props {
    tile: SceneTile;
    placed: PlacedNode;
    selected: boolean;
    revision: number;
    onactivate: (event: MouseEvent) => void;
    onopen: () => void;
    onmenu: (event: MouseEvent) => void;
    onkey: (event: KeyboardEvent) => void;
    onsaved: (path: string) => void;
    ondiscarded: () => void;
    captureSelection?: () => () => boolean;
  }

  let { tile, placed, selected, revision, onactivate, onopen, onmenu, onkey, onsaved, ondiscarded, captureSelection }: Props = $props();
  const node = $derived(tile.node);
  const title = $derived(promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node));
  const status = $derived(nodeStatus(node));
  const present = $derived(node.state === "present" && !node.earlierRevision && !node.discarded && !!node.path);
  const unsaved = $derived(node.temporary && !node.discarded && node.artifactId !== null);
  const tooltip = $derived([node.prompt || nodeTitle(node), node.scope === "current" ? "" : node.location].filter(Boolean).join("\n"));
  // Hover actions reuse the established save/delete flow for unsaved outputs.
  const artifact = $derived<TraceArtifact | null>(unsaved && node.artifactId !== null && node.path ? {
    id: node.artifactId, path: node.path, digest: "", createdAt: "", generatingRun: node.runId,
    pathState: node.state === "present" ? "present" : node.state === "missing" ? "missing" : "unavailable", temporary: true, discarded: false,
  } : null);
  const hint = $derived(tile.expandable
    ? tile.large && tile.tone === "focus" ? `${tile.childCount} direct ${tile.childCount === 1 ? "child" : "children"} open`
      : tile.hiddenDescendants ? `${tile.hiddenDescendants} further ${tile.hiddenDescendants === 1 ? "edit" : "edits"}` : `${tile.childCount} ${tile.childCount === 1 ? "edit" : "edits"}`
    : "");
</script>

<div class="tile" class:large={tile.large} class:unrelated={tile.tone === "unrelated"} class:foreign={node.scope !== "current"}
  data-tile-key={node.key} data-scope={node.scope} data-size={tile.large ? "large" : "small"} data-tone={tile.tone}
  style:left="{placed.x}px" style:top="{placed.y}px" style:width="{placed.width}px" style:height="{placed.height}px"
  style:--image-height="{tile.size.imageHeight}px">
  <button type="button" class="card" class:selected class:focus={tile.tone === "focus"} class:discarded={node.discarded}
    data-node-key={node.key} aria-pressed={selected} title={tooltip}
    aria-label="{title}{status ? `, ${status}` : ""}{unsaved ? ", unsaved" : ""}{node.scope === "external" ? ", outside this folder" : node.scope === "subfolder" ? ", in a subfolder" : ""}"
    onclick={onactivate} ondblclick={onopen} oncontextmenu={onmenu} onkeydown={onkey}>
    <span class="image" data-tile-image style:height="{tile.size.imageHeight}px">
      {#if node.state === "running"}
        <span class="spinner" role="status" aria-label="Generating"></span>
      {:else if present}
        <TraceThumbnail path={node.path!} present={true} {revision} label="" prompt="" />
      {:else}
        <span class="placeholder" aria-hidden="true">▧</span>
      {/if}
    </span>
    <span class="label">
      <span class="text">{title}</span>
      {#if node.runId !== null && promptTitles.pending(node.runId)}<span class="title-spinner" role="status" aria-label="Generating title"></span>{/if}
      {#if unsaved}<span class="unsaved-dot" title="Unsaved" aria-hidden="true"></span>{/if}
      {#if tile.expandable}
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d={tile.tone === "focus" ? "m5 9 7 7 7-7" : "m9 5 7 7-7 7"} /></svg>
      {/if}
    </span>
    {#if node.scope !== "current"}
      <span class="scope {node.scope}">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if node.scope === "external"}<path d="M6 18 18 6M7 6h11v11" />{:else}<path d="M3 6h6l2 2h10v12H3z" />{/if}
        </svg>
        {node.scope === "external" ? "External" : "Subfolder"}{#if status}<span class="status"> · {status}</span>{/if}
      </span>
      <span class="scope-path">{node.location}</span>
    {:else if status}
      <span class="status-line">{status}</span>
    {/if}
  </button>
  {#if hint}<span class="hint" style:height="{TILE.hint}px">{hint}</span>{/if}
  {#if artifact}
    <div class="actions">
      <TraceImageActions {artifact} onSelectFile={async (path) => onsaved(path)} selectAfterSave={true} {captureSelection}
        onDiscard={() => ondiscarded()} />
    </div>
  {/if}
</div>

<style>
  .tile { position: absolute; box-sizing: border-box; }
  .card { display: flex; flex-direction: column; align-items: stretch; box-sizing: border-box; width: 100%; padding: 5px; overflow: hidden; text-align: left; font: inherit; color: var(--text-primary); background: var(--background-card-secondary, var(--control-fill)); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .card:hover { background: var(--subtle-fill-secondary); }
  .card.selected { border-color: var(--accent-text); background: color-mix(in srgb, var(--accent-text) 12%, var(--background-card-secondary, transparent)); }
  .card.focus { box-shadow: 0 0 0 1px var(--accent-text); }
  .card:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .card.discarded { border-style: dashed; }
  .image { display: grid; place-items: center; flex: none; overflow: hidden; border-radius: 2px; background: var(--subtle-fill-secondary, rgba(127,127,127,.08)); }
  .image :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .image :global(img) { object-fit: cover !important; }
  .placeholder { color: var(--text-secondary); font-size: 20px; }
  .label { display: flex; align-items: center; gap: 3px; min-width: 0; height: 14px; margin-top: 4px; }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 14px; }
  .large .text { font-size: 12px; }
  .chevron { width: 11px; height: 11px; flex: none; fill: none; stroke: var(--text-secondary); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .unsaved-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--system-caution-text, #a76d24); }
  .scope { display: flex; align-items: center; gap: 3px; height: 14px; margin-top: 3px; font-size: 10px; color: var(--accent-text); white-space: nowrap; overflow: hidden; }
  .scope.external { color: var(--system-caution-text, #865413); }
  .scope svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .scope-path, .status-line { height: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 11px; color: var(--text-secondary); }
  .status { color: var(--text-secondary); }
  .hint { display: block; box-sizing: border-box; padding-top: 3px; text-align: center; font-size: 10px; line-height: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unrelated .card { opacity: .78; }
  .unrelated .image { filter: grayscale(.45); }
  .actions { position: absolute; top: 8px; right: 8px; visibility: hidden; }
  .actions :global(p) { position: absolute; right: 0; top: 30px; width: max-content; max-width: 220px; padding: 2px 6px; background: var(--background-solid); border: 1px solid var(--control-stroke); border-radius: 3px; }
  .tile:hover .actions, .tile:focus-within .actions { visibility: visible; }
  @media (hover: none) { .actions { visibility: visible; } }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
  .title-spinner { width: 8px; height: 8px; flex: none; border: 1px solid var(--control-stroke); border-top-color: var(--accent-text); border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: no-preference) { .card { transition: background-color 100ms, border-color 100ms; } }
  @media (prefers-reduced-motion: reduce) { .spinner, .title-spinner { animation: none; } }
</style>
