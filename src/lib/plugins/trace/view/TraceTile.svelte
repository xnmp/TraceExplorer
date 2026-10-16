<script lang="ts">
  import type { SceneTile } from "$lib/domain/trace-graph/scene";
  import type { Orientation, PlacedNode } from "$lib/domain/trace-graph/layout";
  import { createAttachmentKey, type Attachment } from "svelte/attachments";
  import TraceImageActions from "../TraceImageActions.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import { nodeStatus, nodeTitle } from "./node-target";
  import type { TraceArtifact } from "$lib/api/trace";
  import { tileTooltipContent } from "./tooltip/content";
  import { tooltipTrigger } from "./tooltip/controller.svelte";
  import { previewData } from "./preview-data.svelte";

  import type { ReferenceBadge } from "$lib/domain/trace-graph/projection";
  import ReferenceBadges from "./ReferenceBadges.svelte";
  import TileVisual, { type CoverVisual } from "./TileVisual.svelte";

  import type { PluginToast } from "../../../../../integration/plugin-sdk";
  import { tileDoubleClick } from "./tile-click";

  interface Props {
    toast?: PluginToast;
    /** Folder covers use the ordinary explorer thumbnail/name treatment, retaining graph actions. */
    explorer?: CoverVisual;
    /** Retries a failed open (the cover's in-cover error control). */
    onretry?: () => void;
    badgeNodes?: ReadonlyMap<string, import("$lib/domain/trace-graph/model").TraceNode>;
    badges?: readonly ReferenceBadge[];
    badgeSelection?: ReadonlySet<string>;
    onbadge?: (key: string, event: MouseEvent) => void;
    onbadgehover?: (key: string | null) => void;
    onstacktoggle?: (event: MouseEvent) => void;
    /** A band tile's caret: expands or collapses it without selecting. */
    oncaret?: () => void;
    focused?: boolean;
    onfocus?: () => void;
    tile: SceneTile;
    placed: PlacedNode;
    /** Which way the tile's component runs; an open chevron points towards the children. */
    orientation?: Orientation;
    selected: boolean;
    revision: number;
    /** Registers the tile's element for native motion (render handles). */
    handle?: Attachment<HTMLElement>;
    onactivate: (event: MouseEvent) => void;
    onopen: () => void;
    onmenu: (event: MouseEvent) => void;
    onkey: (event: KeyboardEvent) => void;
    onsaved: (path: string, select: boolean) => void;
    ondiscarded: () => void;
    captureSelection?: () => () => boolean;
  }

  let { tile, toast, placed, orientation = "down", selected, revision, handle, onactivate, onopen, onmenu, onkey, onsaved, ondiscarded, captureSelection, badges = [], badgeNodes, badgeSelection = new Set(), onbadge, onbadgehover, onstacktoggle, oncaret, focused = true, onfocus, explorer, onretry }: Props = $props();
  // Stack covers always offer their disclosure; band tiles use TileVisual's caret predicate.
  const doubleClick = () => tileDoubleClick(!!explorer || tile.togglable, onopen, toast);
  const node = $derived(tile.node);
  const title = $derived(promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node));
  const status = $derived(nodeStatus(node));
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
  const tooltipKey = createAttachmentKey();
  // A band tile's card is its button: selection semantics, handlers and the tooltip.
  const card = $derived(explorer ? null : {
    type: "button", tabindex: focused ? 0 : -1, onfocus, "data-node-key": node.key, "aria-pressed": selected, [tooltipKey]: tooltip,
    "aria-label": `${title}${status ? `, ${status}` : ""}${unsaved ? ", unsaved" : ""}${node.scope === "external" ? ", outside this folder" : node.scope === "subfolder" ? ", in a subfolder" : ""}`,
    onclick: onactivate, ondblclick: doubleClick, oncontextmenu: onmenu, onkeydown: onkey,
  });
</script>

<div class="tile" class:explorer-cover={!!explorer} class:host-cover={explorer?.imagePx !== undefined} class:small-cover={explorer?.small} class:unrelated={tile.tone === "unrelated"} class:foreign={node.scope !== "current"}
  role="gridcell" aria-selected={selected} data-tile-key={node.key} data-scope={node.scope} data-tone={tile.tone} {@attach handle}
  style:left="{placed.x}px" style:top="{placed.y}px" style:width="{placed.width}px" style:height="{placed.height}px">
  <!-- A cover's card is not a button: the tile body remains the grid's tab stop through the press target laid over it, and the
       disclosure (a sibling control in its label) owns only toggling. While this tile is the stop, Tab reaches its disclosure next
       (it follows the cover in DOM order), so keyboard users can collapse. A real button also excludes its pointer presses from marquee selection. -->
  {#snippet press()}
    {#if explorer}
      <button type="button" class="cover-press" tabindex={focused ? 0 : -1} {onfocus} data-node-key={node.key}
        aria-pressed={selected} aria-label="{explorer.name}, {explorer.count} images{status ? `, ${status}` : ''}{unsaved || explorer.unsaved ? ', unsaved' : ''}"
        {@attach explorer.expanded ? tooltip : null} onclick={onactivate} ondblclick={doubleClick} oncontextmenu={onmenu} onkeydown={onkey}></button>
    {/if}
  {/snippet}
  <TileVisual {tile} {selected} {revision} {orientation} {explorer} {card} press={explorer ? press : undefined} {focused} {onfocus} {onstacktoggle} {oncaret} {onkey} {onretry} />
  {#if badges.length && onbadge}<ReferenceBadges {badges} nodes={badgeNodes} {revision} selected={badgeSelection} onactivate={onbadge} onhover={onbadgehover} />{/if}
  {#if artifact}
    <div class="actions">
      <TraceImageActions {artifact} onSelectFile={async (path, select) => onsaved(path, select)} selectAfterSave={true} {captureSelection}
        onDiscard={() => ondiscarded()} />
    </div>
  {/if}
</div>

<style>
  .tile { position: absolute; box-sizing: border-box; }
  .cover-press { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; border-radius: inherit; background: none; cursor: pointer; }
  .cover-press:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  /* The action chip sits in the image's top-right corner; status messages hang below it. */
  .actions { position: absolute; top: 9px; right: 9px; display: flex; flex-direction: column; align-items: flex-end; visibility: hidden; }
  .actions :global(p) { position: absolute; right: 0; top: 100%; }
  .tile:hover .actions, .tile:focus-within .actions { visibility: visible; }
  @media (hover: none) { .actions { visibility: visible; } }
</style>
