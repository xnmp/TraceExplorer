<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { ConnectionsController, type Backend, type RevisionEvent, type TestRegistry } from './controller';
  import { newProfile, removeProfile, validation, type ImageProfile } from './domain';
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
  onMount(() => { const stop = controller.subscribe(value => view = value); const events = subscribeRevision(event => controller.revision(event)); void controller.initialize(); return () => { events(); stop(); controller.close(); }; });
  function updateProfile(next: ImageProfile) { if (view.draft) controller.edit({ ...view.draft, profiles: view.draft.profiles.map(p => p.id === next.id ? next : p) }); }
  function add(transport: ImageProfile['transport']) { if (!view.draft) return; const next = newProfile(crypto.randomUUID(), transport); controller.edit({ ...view.draft, profiles: [...view.draft.profiles, next] }); selectedId = next.id; }
  function close() { if (view.busy) return; if (dirty) confirmingClose = true; else finishClose(); }
  function finishClose() { controller.close(); onClose(); }
  async function reload() { await controller.refresh(true); confirmingClose = false; }
</script>

<Modal {open} onClose={close} canClose={() => !view.busy} labelledby="image-connections-title">
  <div class="connections">
    <header><h2 id="image-connections-title">Image connections</h2><button type="button" aria-label="Close image connections" disabled={view.busy} onclick={close}>×</button></header>
    <div class="body" aria-busy={view.loading || view.busy}>
      <p class="note">Connections are shared by image tools. Text model settings are independent.</p>
      {#if view.error}<p role="alert" class="error">{view.error}</p>{/if}
      {#if view.message}<p role="status">{view.message}</p>{/if}
      {#if view.loading}<p role="status">Loading connections…</p>
      {:else if !view.draft}<button type="button" onclick={() => controller.refresh()}>Retry loading</button>
      {:else}
        {#if view.conflict}<div class="notice" role="alert">Settings changed in another window. Your edits are preserved. Reload saved settings before saving or testing.<button type="button" disabled={view.busy} onclick={reload}>Reload saved settings</button></div>{/if}
        <label>Default image connection<select disabled={view.busy} value={view.draft.defaultConnectionId ?? ''} onchange={e => view.draft && controller.edit({ ...view.draft, defaultConnectionId: e.currentTarget.value || null })}><option value="">No default selected</option>{#each view.draft.profiles as item (item.id)}<option value={item.id}>{item.name || 'Unnamed connection'}</option>{/each}</select></label>
        {#if view.draft.defaultConnectionId === null && view.draft.profiles.length}<p class="note">Select and save a default connection to enable image generation.</p>{/if}
        <div class="actions"><button type="button" disabled={view.busy || view.draft.profiles.length >= 32} onclick={() => add('codex-cli')}>Add Codex</button><button type="button" disabled={view.busy || view.draft.profiles.length >= 32} onclick={() => add('openai-images')}>Add Images API</button></div>
        {#if !view.draft.profiles.length}<p class="empty">No image connections configured. Add a connection, save it, and select a default to enable image generation.</p>
        {:else if profile}
          <label>Edit connection<select disabled={view.busy} value={profile.id} onchange={e => selectedId = e.currentTarget.value}>{#each view.draft.profiles as item (item.id)}<option value={item.id}>{item.name || 'Unnamed connection'} · {item.transport === 'codex-cli' ? 'Codex' : 'Images API'}</option>{/each}</select></label>
          {#key profile.id}<ProfileFields {profile} disabled={view.busy} saved={usable} onchange={updateProfile} oncredential={key => controller.credential(profile!.id, key)} />{/key}
          <div class="actions"><button type="button" disabled={view.busy} onclick={() => view.draft && controller.edit(removeProfile(view.draft, profile!.id))}>Remove connection</button><button type="button" disabled={!usable} onclick={() => controller.check(profile!.id)}>Check locally</button><button type="button" disabled={!usable} onclick={() => controller.test(profile!.id)}>Test generation (may be billed)</button></div>
          <p class="note">Check locally verifies executable or authentication availability. Test generation creates one real test image using the saved connection.</p>
          {#if dirty}<p class="note">Save or discard your edits before checking, testing, or saving a key.</p>{/if}
          {#if view.check && view.check.profileId === profile.id}<p role="status">{view.check.message}</p>{/if}
        {/if}
        {#if invalid && dirty}<p class="error">{invalid}</p>{/if}
        <TestResults tests={view.tests} revision={view.saved?.documentRevision ?? 0} oncancel={id => controller.cancel(id)} onrefresh={id => controller.poll(id)} ondiscard={id => controller.discard(id)} />
      {/if}
      {#if confirmingClose}<div class="notice" role="alert"><p>Discard unsaved connection edits and close? Saved connections and retained test images are kept.</p><div class="actions"><button type="button" onclick={() => confirmingClose = false}>Keep editing</button><button type="button" onclick={finishClose}>Discard edits and close</button></div></div>{/if}
    </div>
    <footer><span class="note">{view.saved ? `Settings revision ${view.saved.documentRevision}` : ''}</span><div class="actions"><button type="button" disabled={view.busy || !dirty} onclick={reload}>Discard edits</button><button type="button" class="primary" disabled={view.busy || !dirty || !!invalid || view.conflict} onclick={() => controller.save()}>{view.busy ? 'Saving…' : 'Save connections'}</button><button type="button" disabled={view.busy} onclick={close}>Close</button></div></footer>
  </div>
</Modal>

<style>
  .connections { width: min(44rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; border: 1px solid var(--surface-stroke); border-radius: var(--radius-lg); background: var(--background-solid); color: var(--text-primary); box-shadow: var(--shadow-dialog); font-family: var(--font-family); font-size: var(--font-size-body); }
  header, footer { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-md); padding: var(--spacing-md) var(--spacing-lg); } header { border-bottom: 1px solid var(--divider); } footer { border-top: 1px solid var(--divider); flex-wrap: wrap; }
  h2 { font-size: var(--font-size-subtitle); margin: 0; }.body { padding: var(--spacing-lg); overflow-y: auto; display: grid; gap: var(--spacing-md); min-height: 0; } p { margin: 0; line-height: var(--line-height-normal); overflow-wrap: anywhere; }
  .note { color: var(--text-secondary); font-size: var(--font-size-caption); }.error { color: var(--system-critical); }.empty, .notice { padding: var(--spacing-md); background: var(--background-card-secondary); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); }.notice { display: grid; gap: var(--spacing-sm); }
  label { display: grid; gap: var(--spacing-xs); } select { min-width: 0; width: 100%; padding: var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); } button { padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill-secondary); color: var(--text-primary); font: inherit; cursor: pointer; }button:hover:not(:disabled) { background: var(--subtle-fill-secondary); }button.primary { background: var(--accent); color: var(--text-on-accent); }button:disabled { opacity: .6; cursor: default; }button:focus-visible, select:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  @media(max-width: 480px) { .body, header, footer { padding: var(--spacing-md); }footer .actions { width: 100%; }footer .actions button { flex: 1; } }
</style>
