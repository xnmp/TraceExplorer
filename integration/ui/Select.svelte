<!--
  A themed dropdown shared by both packages built from this repository: the
  WAI-ARIA APG select-only combobox. A native <select> draws its open list with
  the platform's own widget (GTK in WebKitGTK), which ignores theme tokens, so
  the list is drawn here. Focus stays on the trigger and the active option is
  announced through aria-activedescendant. Rules live in `select-model.ts`.

  The list uses the Popover API (top layer) so scrolling or overflow-hidden
  dialog ancestors cannot clip it, and falls back to `position: fixed`.
-->
<script module lang="ts">
  export type { SelectOption } from "./select-model";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { NONE, emptyTypeahead, indexOfValue, initialActive, keyAction, move, place, typeahead, typeaheadMatch, type Move, type SelectOption } from "./select-model";

  let {
    value = $bindable(), options, placeholder = "", disabled = false, id, onchange, class: className = "",
    "aria-label": ariaLabel, "aria-labelledby": ariaLabelledby,
  }: {
    value?: string; options: readonly SelectOption[]; placeholder?: string; disabled?: boolean; id?: string;
    "aria-label"?: string; "aria-labelledby"?: string; onchange?: (value: string) => void; class?: string;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  let open = $state(false);
  let active = $state(NONE);
  let buffer = emptyTypeahead;
  let trigger = $state<HTMLButtonElement>();
  let popup = $state<HTMLDivElement>();
  let root = $state<HTMLSpanElement>();
  let placement = $state<{ top: number; left: number; minWidth: number; maxHeight: number }>();

  const selected = $derived(indexOfValue(options, value));
  const label = $derived(selected >= 0 ? options[selected].label : placeholder);
  const expanded = $derived(open && !disabled);

  function reposition(): void {
    if (!trigger || !popup) return;
    // Measure the natural height with the cap lifted, then clamp to the room available.
    const rect = trigger.getBoundingClientRect();
    popup.style.maxHeight = "none";
    popup.style.minWidth = `${rect.width}px`;
    const next = place(rect, { width: innerWidth, height: innerHeight }, { width: popup.offsetWidth, height: popup.scrollHeight });
    placement = next;
    popup.style.maxHeight = `${next.maxHeight}px`;
  }

  function show(index: number): void {
    active = index;
    open = true;
  }
  function close(): void {
    open = false;
    placement = undefined;
  }
  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    const changed = option.value !== value;
    close();
    if (!changed) return;
    value = option.value;
    onchange?.(option.value);
  }
  function activate(index: number): void {
    if (index !== NONE) active = index;
  }

  /** Mounts the list: promotes it to the top layer and tracks the trigger while open. */
  function present(node: HTMLDivElement) {
    if (typeof node.showPopover === "function") node.showPopover();
    reposition();
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger?.contains(event.target) && !node.contains(event.target)) close();
    };
    const onScroll = (event: Event) => { if (event.target !== node) reposition(); };
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", reposition);
    addEventListener("blur", close);
    addEventListener("pointerdown", onOutside, true);
    return {
      destroy() {
        removeEventListener("scroll", onScroll, true);
        removeEventListener("resize", reposition);
        removeEventListener("blur", close);
        removeEventListener("pointerdown", onOutside, true);
      },
    };
  }

  // Keep the active option in view; runs after the DOM reflects `active`.
  $effect(() => {
    if (!expanded || active === NONE) return;
    void tick().then(() => popup?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" }));
  });
  // A disabled trigger cannot keep a list open.
  $effect(() => { if (disabled && open) close(); });

  function typed(char: string): void {
    buffer = typeahead(buffer, char, Date.now());
    const index = typeaheadMatch(options, expanded ? active : selected, buffer.text);
    if (index === NONE) return;
    if (expanded) activate(index); else show(index);
  }

  function keydown(event: KeyboardEvent): void {
    if (disabled || event.isComposing) return;
    const action = keyAction(expanded, event);
    if (!action) return;
    // Consumed here: keep it from reaching dialog-level handlers such as Escape-to-close.
    if (action.type !== "tab") { event.preventDefault(); event.stopPropagation(); }
    switch (action.type) {
      case "open": {
        const target = action.at === "first" ? move(options, NONE, "first") : action.at === "last" ? move(options, NONE, "last") : initialActive(options, value);
        show(target);
        break;
      }
      case "move": activate(move(options, active, action.how as Move)); break;
      case "select": case "selectActive": if (active === NONE) close(); else choose(active); break;
      case "close": close(); break;
      case "tab": if (active !== NONE) choose(active); else close(); break;
      case "type": typed(action.char); break;
    }
  }

  // A click on a label would make the browser re-click the trigger, which would toggle the list. A native
  // select only focuses on that, so cancel the label's activation and do the same. Labels are static here.
  $effect(() => {
    const labels = [...(trigger?.labels ?? [])];
    const onLabelClick = (event: MouseEvent) => {
      if (event.target instanceof Node && root?.contains(event.target)) return; // the trigger or its list
      event.preventDefault();
      trigger?.focus();
      close();
    };
    for (const label of labels) label.addEventListener("click", onLabelClick);
    return () => { for (const label of labels) label.removeEventListener("click", onLabelClick); };
  });

  function toggle(): void {
    if (disabled) return;
    if (expanded) close(); else show(initialActive(options, value));
  }
</script>

<span bind:this={root} class="select {className}">
  <button
    bind:this={trigger} {id} type="button" role="combobox" class="trigger" class:placeholder={selected < 0}
    {disabled} data-value={value ?? ""} aria-label={ariaLabel} aria-labelledby={ariaLabelledby}
    aria-haspopup="listbox" aria-expanded={expanded} aria-controls={listId}
    aria-activedescendant={expanded && active !== NONE ? optionId(active) : undefined}
    onclick={toggle} onkeydown={keydown} onkeyup={(event) => { if (event.key === " ") event.preventDefault(); }} onblur={close}
  ><span class="text">{label}</span></button>
  {#if expanded}
    <!-- Not focusable by design: the trigger keeps focus and handles every key (aria-activedescendant). -->
    <!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
    <div
      bind:this={popup} use:present popover="manual" id={listId} role="listbox" class="list" aria-label={ariaLabel} aria-labelledby={ariaLabelledby}
      style:top={placement ? `${placement.top}px` : undefined} style:left={placement ? `${placement.left}px` : undefined}
      style:visibility={placement ? undefined : "hidden"}
      onmousedown={(event) => event.preventDefault()}
      onclick={(event) => event.preventDefault()}
    >
      {#each options as option, index (option.value)}
        <!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
        <div
          id={optionId(index)} role="option" class="option" class:active={index === active} class:selected={index === selected}
          data-value={option.value} aria-selected={index === selected} aria-disabled={option.disabled ? true : undefined}
          onpointermove={() => { if (!option.disabled && index !== active) active = index; }}
          onclick={() => choose(index)}
        ><span class="check" aria-hidden="true"></span><span class="option-text">{option.label}</span></div>
      {/each}
    </div>
  {/if}
</span>

<style>
  .select { position: relative; display: grid; min-width: 0; }
  .select::after {
    content: ""; position: absolute; top: 50%; right: 10px; width: 12px; height: 12px; translate: 0 -50%; pointer-events: none;
    background: var(--text-secondary);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  .select:has(.trigger:disabled)::after { opacity: .5; }
  .trigger {
    appearance: none; -webkit-appearance: none; box-sizing: border-box; display: block; width: 100%; min-width: 0; min-height: 34px; margin: 0;
    padding: 6px 32px 6px 12px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm);
    background: var(--control-fill); color: var(--text-primary); font: inherit; font-size: var(--font-size-body); line-height: var(--line-height-normal);
    text-align: left; cursor: pointer; transition: background-color var(--transition-fast), border-color var(--transition-fast);
  }
  .text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger.placeholder .text { color: var(--text-secondary); }
  .trigger:hover:not(:disabled) { background: var(--control-fill-secondary); }
  .trigger:focus { outline: none; }
  .trigger:focus-visible, .trigger[aria-expanded="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .trigger:disabled { opacity: .6; cursor: default; }

  /* Overrides the UA popover box (centered, bordered, padded) with a plain anchored panel.
     The top-layer popover path is always viewport-relative. The `position: fixed` fallback (no Popover API)
     becomes relative to any ancestor with a transform or backdrop-filter, so it can be offset there. */
  .list {
    position: fixed; inset: auto; margin: 0; width: max-content; max-width: calc(100vw - 16px); box-sizing: border-box; overflow-y: auto; padding: 4px; z-index: var(--z-modal-popover);
    border: 1px solid var(--control-stroke); border-radius: var(--radius-md); background: var(--background-solid); color: var(--text-primary);
    box-shadow: var(--shadow-flyout); font-size: var(--font-size-body); line-height: var(--line-height-normal);
  }
  .option {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer; user-select: none;
  }
  .option.active { background: var(--control-fill-secondary); }
  .option[aria-disabled="true"] { opacity: .45; cursor: default; }
  .option-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check { flex: none; width: 12px; height: 12px; }
  .option.selected .check {
    background: var(--accent);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5.5' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5.5' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
  }
</style>
