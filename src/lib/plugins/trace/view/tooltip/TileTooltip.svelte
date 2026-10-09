<script lang="ts">
  /**
   * The Trace tooltip bubble, mounted once in `document.body` by the
   * controller. It never takes pointer events. Styling mirrors the host's
   * tooltip-like surfaces (toasts): solid background, `--shadow-tooltip`,
   * caption-sized text, theme tokens only.
   */
  import { tooltipView, TOOLTIP_ID } from "./controller.svelte";
  import { intersect, placeTooltip, PLACEMENT, type Rect } from "./placement";
  import { zoomOf } from "../motion";

  /** Widest the bubble gets, in CSS pixels (narrower when the window is). */
  const MAX_WIDTH = 380;

  const current = $derived(tooltipView.current);
  const content = $derived(current ? current.target.content() : null);

  const rectOf = (box: DOMRect): Rect => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });

  /** The part of `element` its clipping ancestors (scrollers, collapsed sections) leave visible. */
  function visibleRect(element: HTMLElement): Rect | null {
    let rect: Rect | null = rectOf(element.getBoundingClientRect());
    for (let parent = element.parentElement; parent && rect; parent = parent.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(parent);
      if (overflowX !== "visible" || overflowY !== "visible") rect = intersect(rect, rectOf(parent.getBoundingClientRect()));
    }
    return rect;
  }

  /**
   * Positions the bubble beside `anchor`. Rects are in the engine's viewport
   * pixels; inline lengths are CSS pixels, which a host zoom (CSS `zoom` on
   * the root) scales, so placements are divided by the measured zoom.
   */
  function place(anchor: HTMLElement, _content: unknown) {
    return (node: HTMLElement) => {
      let live = true;
      const position = () => {
        if (!live || !anchor.isConnected) return;
        const zoom = zoomOf(document.body) || 1;
        node.style.maxWidth = `${Math.max(0, Math.min(MAX_WIDTH, (innerWidth - 2 * PLACEMENT.margin) / zoom))}px`;
        const area = visibleRect(anchor);
        if (!area) { node.style.visibility = "hidden"; return; }
        // offset sizes ignore the entrance animation's scale.
        const size = { width: node.offsetWidth * zoom, height: node.offsetHeight * zoom };
        const spot = placeTooltip(area, size, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
        node.style.left = `${spot.left / zoom}px`;
        node.style.top = `${spot.top / zoom}px`;
        node.dataset.side = spot.side;
        node.style.visibility = "";
      };
      // A tile still moving (graph motion) is placed where it comes to rest.
      const tile = anchor.closest<HTMLElement>("[data-tile-key]") ?? anchor;
      const moving = tile.getAnimations().filter((animation) => animation.playState === "running");
      if (moving.length) {
        node.style.visibility = "hidden";
        void Promise.allSettled(moving.map((animation) => animation.finished)).then(position);
      } else position();
      return () => { live = false; };
    };
  }
</script>

{#if current && content}
  <div id={TOOLTIP_ID} class="trace-tooltip" role="tooltip" data-instant={current.instant ? "" : undefined}
    {@attach place(current.target.element, content)}>
    <p class="text" class:prompt={content.isPrompt}>{content.text}</p>
    {#each content.details as line, index (index)}<p class="detail">{line}</p>{/each}
  </div>
{/if}

<style>
  .trace-tooltip {
    position: fixed; left: 0; top: 0; z-index: var(--z-menu);
    box-sizing: border-box; width: max-content; max-width: 380px; padding: 7px 10px 8px;
    color: var(--text-primary); background: var(--background-solid);
    border: 1px solid var(--control-stroke-secondary); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-tooltip);
    font-family: var(--font-family); font-size: calc(var(--font-size-caption) + 1px); line-height: 1.45; text-align: left;
    overflow-wrap: anywhere; pointer-events: none; user-select: none; -webkit-user-select: none;
  }
  /* The entrance grows from the anchor's side; the placement sets data-side. */
  .trace-tooltip { transform-origin: 50% 100%; }
  .trace-tooltip:global([data-side="below"]) { transform-origin: 50% 0; }
  p { margin: 0; }
  /* Long prompts wrap and stop after a dozen lines; Preview's Trace details show the rest. */
  .text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 12; line-clamp: 12; overflow: hidden; white-space: pre-line; }
  /* An image name heading its details; a bare label (an action's name) stays regular. */
  .text:not(.prompt):not(:only-child) { font-weight: var(--font-weight-semibold); }
  .detail { font-size: var(--font-size-caption); line-height: 1.35; color: var(--text-secondary); }
  .text + .detail { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--divider); }
  .detail + .detail { margin-top: 2px; }
  @media (prefers-reduced-motion: no-preference) {
    .trace-tooltip:not([data-instant]) { animation: trace-tooltip-in 120ms cubic-bezier(0, 0, 0, 1); }
  }
  @keyframes trace-tooltip-in { from { opacity: 0; transform: scale(.96); } }
</style>
