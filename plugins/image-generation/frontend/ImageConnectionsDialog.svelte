<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { ConnectionsController, type Backend, type RevisionEvent, type TestRegistry } from './controller';
  import { newProfile, removeProfile, setDefault, transportLabel, validation, type ImageProfile } from './domain';
  import ProfileFields from './ProfileFields.svelte';
  import TestResults from './TestResults.svelte';
  let { open, onClose, backend, registry, subscribeRevision }: { open: boolean; onClose: () => void; backend: Backend; registry: TestRegistry; subscribeRevision: (fn: (event: RevisionEvent) => void) => () => void } = $props();
  const controller = untrack(() => new ConnectionsController(backend, registry));
  let view = $state(controller.snapshot());
  let selectedId = $state('');
  let confirmingClose = $state(false);
  let dirty = $derived(!!view.saved && !!view.draft && JSON.stringify(view.saved) !== JSON.stringify(view.draft));
  let profile = $derived(view.draft?.profiles.find(p => p.id === selectedId) ?? view.draft?.profiles[0]);
  let invalid = $derived(view.draft ? validation(view.draft) : null);
  let usable = $derived(!dirty && !view.busy && !view.conflict && !!profile && !!view.saved?.profiles.some(p => p.id === profile?.id));
  let full = $derived((view.draft?.profiles.length ?? 0) >= 32);
  onMount(() => { const stop = controller.subscribe(value => view = value); const events = subscribeRevision(event => controller.revision(event)); void controller.initialize(); return () => { events(); stop(); controller.close(); }; });
  function updateProfile(next: ImageProfile) { if (view.draft) controller.edit({ ...view.draft, profiles: view.draft.profiles.map(p => p.id === next.id ? next : p) }); }
  function add(transport: ImageProfile['transport']) {
    if (!view.draft) return;
    const next = newProfile(crypto.randomUUID(), transport);
    // The first connection becomes the default, so a new user needs no extra step to generate.
    const draft = { ...view.draft, profiles: [...view.draft.profiles, next] };
    controller.edit(draft.profiles.length === 1 ? setDefault(draft, next.id) : draft);
    selectedId = next.id;
  }
  function close() { if (view.busy) return; if (dirty) confirmingClose = true; else finishClose(); }
  function finishClose() { controller.close(); onClose(); }
  async function reload() { await controller.refresh(true); confirmingClose = false; }
</script>

{#snippet plus()}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>{/snippet}

<Modal {open} onClose={close} canClose={() => !view.busy} labelledby="image-connections-title">
  <div class="connections">
    <header>
      <div><h2 id="image-connections-title">Image connections</h2><p class="note">Shared by every image tool. Text models are set up separately.</p></div>
      <button type="button" class="icon" aria-label="Close image connections" disabled={view.busy} onclick={close}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button>
    </header>
    <div class="body" aria-busy={view.loading || view.busy}>
      {#if view.error}<p role="alert" class="banner critical">{view.error}</p>{/if}
      {#if view.message}<p role="status" class="banner">{view.message}</p>{/if}
      {#if view.conflict}<div class="banner caution" role="alert"><p>Settings changed in another window. Your edits are kept; reload the saved settings before saving or testing.</p><button type="button" disabled={view.busy} onclick={reload}>Reload saved settings</button></div>{/if}
      {#if view.loading}<p role="status" class="note">Loading connections…</p>
      {:else if !view.draft}<button type="button" onclick={() => controller.refresh()}>Retry loading</button>
      {:else}
        <div class="split">
          <nav aria-label="Connections">
            {#if view.draft.profiles.length}
              <ul>
                {#each view.draft.profiles as item (item.id)}
                  <li><button type="button" class="item" aria-current={item.id === profile?.id ? 'true' : undefined} disabled={view.busy} onclick={() => selectedId = item.id}>
                    <span class="item-name">{item.name || 'Unnamed connection'}</span>
                    <span class="item-meta">{transportLabel(item)}{#if item.id === view.draft.defaultConnectionId}<span class="badge">Default</span>{/if}</span>
                  </button></li>
                {/each}
              </ul>
            {/if}
            <div class="add">
              <button type="button" class="ghost" disabled={view.busy || full} onclick={() => add('codex-cli')}>{@render plus()}Add Codex</button>
              <button type="button" class="ghost" disabled={view.busy || full} onclick={() => add('openai-images')}>{@render plus()}Add Images API</button>
            </div>
          </nav>
          <section class="detail" aria-label="Connection details">
            {#if !view.draft.profiles.length}
              <div class="empty">
                <p class="empty-title">No image connections configured.</p>
                <p class="note">Add <strong>Codex</strong> to generate with your ChatGPT sign-in, or an <strong>Images API</strong> endpoint with its own key.</p>
              </div>
            {:else if profile}
              <div class="detail-head">
                <div><h3>{profile.name || 'Unnamed connection'}</h3><p class="note">{transportLabel(profile)}</p></div>
                {#if profile.id === view.draft.defaultConnectionId}<span class="badge">Default</span>
                {:else}<button type="button" disabled={view.busy} onclick={() => view.draft && controller.edit(setDefault(view.draft, profile!.id))}>Set as default</button>{/if}
              </div>
              {#if view.draft.defaultConnectionId === null}<p class="banner caution">Choose a default connection, then save, to enable image generation.</p>{/if}
              {#key profile.id}<ProfileFields {profile} disabled={view.busy} saved={usable} onchange={updateProfile} oncredential={key => controller.credential(profile!.id, key)} />{/key}
              <div class="verify">
                <div class="actions"><button type="button" disabled={!usable} onclick={() => controller.check(profile!.id)}>Check locally</button><button type="button" disabled={!usable} onclick={() => controller.test(profile!.id)}>Test generation (may be billed)</button></div>
                <p class="note">{dirty ? 'Save or discard your edits before checking, testing, or saving a key.' : 'Check locally confirms the executable or credentials are available. Test generation makes one real image.'}</p>
                {#if view.check && view.check.profileId === profile.id}<p role="status">{view.check.message}</p>{/if}
              </div>
              <div class="danger-zone"><button type="button" class="danger" disabled={view.busy} onclick={() => view.draft && controller.edit(removeProfile(view.draft, profile!.id))}>Remove connection</button></div>
            {/if}
          </section>
        </div>
        {#if invalid && dirty}<p class="banner critical">{invalid}</p>{/if}
        <TestResults tests={view.tests} revision={view.saved?.documentRevision ?? 0} oncancel={id => controller.cancel(id)} onrefresh={id => controller.poll(id)} ondiscard={id => controller.discard(id)} />
      {/if}
      {#if confirmingClose}<div class="banner caution" role="alert"><p>Discard unsaved connection edits and close? Saved connections and retained test images are kept.</p><div class="actions"><button type="button" onclick={() => confirmingClose = false}>Keep editing</button><button type="button" onclick={finishClose}>Discard edits and close</button></div></div>{/if}
    </div>
    <footer>
      <span class="note">{#if dirty}<span class="dot" aria-hidden="true"></span>Unsaved changes{/if}</span>
      <div class="actions"><button type="button" disabled={view.busy || !dirty} onclick={reload}>Discard edits</button><button type="button" class="primary" disabled={view.busy || !dirty || !!invalid || view.conflict} onclick={() => controller.save()}>{view.busy ? 'Saving…' : 'Save connections'}</button><button type="button" disabled={view.busy} onclick={close}>Close</button></div>
    </footer>
  </div>
</Modal>

<style>
  .connections { width: min(48rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; border: 1px solid var(--surface-stroke); border-radius: var(--radius-lg); background: var(--background-solid); color: var(--text-primary); box-shadow: var(--shadow-dialog); font-family: var(--font-family); font-size: var(--font-size-body); }
  header, footer { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-md); padding: var(--spacing-md) var(--spacing-lg); }
  header { align-items: flex-start; border-bottom: 1px solid var(--divider); } footer { border-top: 1px solid var(--divider); flex-wrap: wrap; }
  h2 { font-size: var(--font-size-subtitle); font-weight: var(--font-weight-semibold); margin: 0 0 var(--spacing-xxs); } h3 { font-size: var(--font-size-subtitle); font-weight: var(--font-weight-semibold); margin: 0; overflow-wrap: anywhere; }
  p { margin: 0; line-height: var(--line-height-normal); overflow-wrap: anywhere; }
  .body { padding: var(--spacing-lg); overflow-y: auto; display: grid; gap: var(--spacing-md); min-height: 0; }
  .note { color: var(--text-secondary); font-size: var(--font-size-caption); }
  .banner { display: grid; gap: var(--spacing-sm); justify-items: start; padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-md); background: var(--background-card-secondary); }
  .banner.caution { border-color: color-mix(in srgb, var(--system-caution) 45%, transparent); background: color-mix(in srgb, var(--system-caution) 10%, var(--background-solid)); }
  .banner.critical { color: var(--system-critical); border-color: color-mix(in srgb, var(--system-critical) 45%, transparent); background: color-mix(in srgb, var(--system-critical) 8%, var(--background-solid)); }
  .split { display: grid; grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr); border: 1px solid var(--control-stroke); border-radius: var(--radius-md); overflow: hidden; min-height: 18rem; }
  nav { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-sm); background: var(--background-card-secondary); border-right: 1px solid var(--divider); min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--spacing-xxs); }
  .item { display: grid; gap: 2px; width: 100%; text-align: left; padding: var(--spacing-sm) var(--spacing-md); border: 1px solid transparent; background: transparent; position: relative; }
  .item:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .item[aria-current="true"] { background: var(--control-fill); border-color: var(--control-stroke); }
  .item[aria-current="true"]::before { content: ""; position: absolute; left: 0; top: 25%; bottom: 25%; width: var(--selection-indicator-width); border-radius: var(--radius-pill); background: var(--accent); }
  .item-name { font-weight: var(--font-weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-meta { display: flex; align-items: center; gap: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-caption); }
  .badge { display: inline-flex; align-items: center; padding: 0 var(--spacing-sm); border-radius: var(--radius-pill); background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); line-height: 1.6; white-space: nowrap; }
  .add { display: grid; gap: var(--spacing-xxs); margin-top: auto; padding-top: var(--spacing-sm); border-top: 1px solid var(--divider); }
  .detail { display: grid; align-content: start; gap: var(--spacing-md); padding: var(--spacing-lg); min-width: 0; }
  .detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
  .verify { display: grid; gap: var(--spacing-sm); padding-top: var(--spacing-md); border-top: 1px solid var(--divider); }
  .danger-zone { padding-top: var(--spacing-md); border-top: 1px solid var(--divider); }
  .empty { display: grid; gap: var(--spacing-xs); align-content: center; justify-items: center; text-align: center; min-height: 12rem; padding: var(--spacing-lg); }
  .empty-title { font-weight: var(--font-weight-semibold); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
  .dot { display: inline-block; width: 6px; height: 6px; margin-right: var(--spacing-xs); border-radius: var(--radius-pill); background: var(--system-caution); vertical-align: middle; }
  button { min-height: 32px; padding: var(--spacing-xs) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; cursor: pointer; transition: background-color var(--transition-fast), border-color var(--transition-fast); }
  button:hover:not(:disabled) { background: var(--control-fill-secondary); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); } button.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); }
  button.ghost { display: inline-flex; align-items: center; gap: var(--spacing-xs); border-color: transparent; background: transparent; color: var(--text-secondary); text-align: left; }
  button.ghost:hover:not(:disabled) { background: var(--subtle-fill-secondary); color: var(--text-primary); }
  button.danger { border-color: transparent; background: transparent; color: var(--system-critical); padding-inline: var(--spacing-sm); }
  button.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--system-critical) 10%, transparent); }
  button.icon { display: inline-grid; place-items: center; width: 32px; padding: 0; border-color: transparent; background: transparent; color: var(--text-secondary); }
  button.icon:hover:not(:disabled) { background: var(--subtle-fill-secondary); color: var(--text-primary); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  @media (max-width: 560px) {
    .body, header, footer { padding: var(--spacing-md); }
    .split { grid-template-columns: minmax(0, 1fr); min-height: 0; } nav { border-right: 0; border-bottom: 1px solid var(--divider); } .detail { padding: var(--spacing-md); }
    footer .actions { width: 100%; } footer .actions button { flex: 1; }
  }
</style>
