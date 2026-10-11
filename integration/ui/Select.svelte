<!--
  A themed dropdown shared by both packages built from this repository. The
  closed control is drawn with theme tokens; the option list stays the
  platform's own, so keyboard, screen-reader and touch behaviour are native.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";

  let { value = $bindable(), children, class: className = "", ...rest }: HTMLSelectAttributes & { children?: Snippet } = $props();
</script>

<span class="select {className}"><select bind:value {...rest}>{@render children?.()}</select></span>

<style>
  .select { position: relative; display: grid; min-width: 0; }
  .select::after {
    content: ""; position: absolute; top: 50%; right: 10px; width: 12px; height: 12px; translate: 0 -50%; pointer-events: none;
    background: var(--text-secondary);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  .select:has(select:disabled)::after { opacity: .5; }
  select {
    appearance: none; -webkit-appearance: none; box-sizing: border-box; width: 100%; min-width: 0; min-height: 34px; margin: 0;
    padding: 6px 32px 6px 12px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm);
    background: var(--control-fill); color: var(--text-primary); font: inherit; font-size: var(--font-size-body); line-height: var(--line-height-normal);
    text-overflow: ellipsis; cursor: pointer; transition: background-color var(--transition-fast), border-color var(--transition-fast);
  }
  select:hover:not(:disabled) { background: var(--control-fill-secondary); }
  select:focus { outline: none; }
  select:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  select:disabled { opacity: .6; cursor: default; }
  select :global(option) { background: var(--background-solid); color: var(--text-primary); }
</style>
