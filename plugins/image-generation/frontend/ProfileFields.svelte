<script lang="ts">
  import type { ImageProfile } from './domain';
  let { profile, disabled, saved, onchange, oncredential }: { profile: ImageProfile; disabled: boolean; saved: boolean; onchange: (profile: ImageProfile) => void; oncredential: (key: string | null) => Promise<void> } = $props();
  let key = $state('');
  let keyVisible = $state(false);
  async function credential(value: string | null) { const submitted = value; key = ''; keyVisible = false; await oncredential(submitted); }
</script>

<fieldset {disabled}>
  <legend class="sr-only">Connection details</legend>
  <label>Name<input value={profile.name} maxlength="256" oninput={e => onchange({ ...profile, name: e.currentTarget.value })} /></label>
  {#if profile.transport === 'codex-cli'}
    <p class="note">Codex uses its saved ChatGPT sign-in. The image model is managed by the adapter; the global text model does not change it.</p>
    <label>Codex executable path<input value={profile.executablePath} maxlength="8192" placeholder="Leave empty to discover Codex" oninput={e => onchange({ ...profile, executablePath: e.currentTarget.value })} /></label>
  {:else}
    <label>Images resource URL<input value={profile.baseUrl} maxlength="2048" inputmode="url" placeholder="https://api.openai.com/v1/images" oninput={e => onchange({ ...profile, baseUrl: e.currentTarget.value })} /></label>
    <p class="note">Include the Images resource, usually /images. The adapter appends /generations or /edits.</p>
    <label>Image model ID<input value={profile.defaultModel} maxlength="256" placeholder="Model supported by this API" oninput={e => onchange({ ...profile, defaultModel: e.currentTarget.value })} /></label>
    <label class="checkbox"><input type="checkbox" checked={profile.allowInsecureHttp} onchange={e => onchange({ ...profile, allowInsecureHttp: e.currentTarget.checked })} />Allow insecure HTTP for this connection</label>
    <label>Credential source<select value={profile.credential.kind} onchange={e => { const kind = e.currentTarget.value; if (kind === 'none') onchange({ ...profile, credential: { kind: 'none' } }); else if (kind === 'environment') onchange({ ...profile, credential: { kind: 'environment', name: 'OPENAI_API_KEY' } }); }}>
      <option value="none">No credential</option><option value="environment">Environment variable</option><option value="secret" disabled>Saved OS credential</option>
    </select></label>
    {#if profile.credential.kind === 'environment'}
      <label>Environment variable name<input value={profile.credential.name} maxlength="128" placeholder="OPENAI_API_KEY" oninput={e => onchange({ ...profile, credential: { kind: 'environment', name: e.currentTarget.value } })} /></label>
      <p class="note">Read by the native provider from the app environment.</p>
    {/if}
    <div class="key-section">
      <p>{profile.credential.kind === 'secret' ? 'A key is saved in the OS credential store.' : 'Save a key in the OS credential store, or use the source above.'}</p>
      <label>New API key<input type={keyVisible ? 'text' : 'password'} bind:value={key} maxlength="4096" autocomplete="off" spellcheck="false" /></label>
      <div class="actions"><button type="button" onclick={() => keyVisible = !keyVisible} aria-pressed={keyVisible}>{keyVisible ? 'Hide key' : 'Show key'}</button><button type="button" disabled={!saved || !key.trim()} onclick={() => credential(key)}>Save key securely</button>{#if profile.credential.kind === 'secret'}<button type="button" disabled={!saved} onclick={() => credential(null)}>Clear saved key</button>{/if}</div>
      {#if !saved}<p class="note">Save connection edits before changing its saved key.</p>{/if}
    </div>
  {/if}
</fieldset>

<style>
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: var(--spacing-md); min-width: 0; }
  label { display: grid; gap: var(--spacing-xs); color: var(--text-primary); }
  input, select { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .checkbox { display: flex; align-items: center; gap: var(--spacing-sm); }.checkbox input { width: auto; }
  .note { margin: 0; color: var(--text-secondary); font-size: var(--font-size-caption); line-height: var(--line-height-normal); }
  .key-section { padding-top: var(--spacing-md); border-top: 1px solid var(--divider); display: grid; gap: var(--spacing-sm); }.key-section p { margin: 0; }
  .actions { display: flex; gap: var(--spacing-sm); flex-wrap: wrap; }
  button { padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill-secondary); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:disabled, fieldset:disabled { opacity: .6; } button:disabled { cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
