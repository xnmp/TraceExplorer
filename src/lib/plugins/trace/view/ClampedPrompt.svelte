<script lang="ts">
  /**
   * The prompt, clamped to `lines` lines with a Show more / Show less toggle
   * that exists only when the text actually overflows. The full text stays in
   * the DOM, so selecting and copying work while clamped. The parent re-mounts
   * this (`{#key}`) per previewed file, which collapses it again.
   */
  let { text, lines = 4 }: { text: string; lines?: number } = $props();

  let expanded = $state(false);
  let overflowing = $state(false);
  let paragraph = $state<HTMLParagraphElement>();
  const id = $props.id();

  // Measured while clamped (expanded text always "fits"), and again when the
  // width changes and re-wraps it. Once expanded, the last answer stands.
  $effect(() => {
    void text;
    if (!paragraph || expanded) return;
    const element = paragraph;
    const measure = () => { overflowing = element.scrollHeight > element.clientHeight + 1; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div class="clamped" style:--lines={lines}>
  <p class="prompt" class:clamp={!expanded} id="{id}-text" data-testid="trace-prompt" bind:this={paragraph}>{text}</p>
  {#if overflowing || expanded}
    <button type="button" class="more" aria-expanded={expanded} aria-controls="{id}-text" onclick={() => (expanded = !expanded)}>
      {expanded ? "Show less" : "Show more"}
    </button>
  {/if}
</div>

<style>
  .clamped { display: flex; flex-direction: column; align-items: flex-start; padding: 10px var(--inset, 16px); gap: 2px; }
  .prompt { margin: 0; align-self: stretch; font-size: 12px; line-height: var(--line-height-normal); white-space: pre-wrap; overflow-wrap: anywhere; }
  .prompt.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--lines); line-clamp: var(--lines); overflow: hidden; }
  .more { margin: 0 -4px; padding: 2px 4px; min-height: 24px; font: inherit; font-size: var(--font-size-caption); color: var(--accent-text, var(--accent)); background: none; border: 0; border-radius: var(--radius-sm); cursor: pointer; }
  .more:hover { background: var(--subtle-fill-secondary); }
  .more:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
</style>
