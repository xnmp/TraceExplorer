<script lang="ts">
  import Select, { type SelectOption } from '../../../integration/ui/Select.svelte';
  import { backendFor, formatCommand, isCodex, type ImageProfile } from './domain';
  let { profile, disabled, saved, commandText, oncommand, onchange, oncredential }: { profile: ImageProfile; disabled: boolean; saved: boolean; commandText?: string; oncommand: (text: string) => void; onchange: (profile: ImageProfile) => void; oncredential: (key: string | null) => Promise<void> } = $props();
  const CREDENTIAL_SOURCES: SelectOption[] = [{ value: 'none', label: 'No credential' }, { value: 'environment', label: 'Environment variable' }, { value: 'command', label: 'Command' }, { value: 'secret', label: 'Saved OS credential', disabled: true }];
  const backend = $derived(isCodex(profile) ? undefined : backendFor(profile.transport));
  let key = $state('');
  let keyVisible = $state(false);
  async function credential(value: string | null) { const submitted = value; key = ''; keyVisible = false; await oncredential(submitted); }
</script>

<fieldset {disabled}>
  <legend class="sr-only">Connection details</legend>
  <label>Name<input value={profile.name} maxlength="256" oninput={e => onchange({ ...profile, name: e.currentTarget.value })} /></label>
  {#if isCodex(profile)}
    <p class="note">Codex uses its saved ChatGPT sign-in and chooses the image model itself.</p>
    <label>Codex executable path<input value={profile.executablePath} maxlength="8192" placeholder="Leave empty to discover Codex" oninput={e => onchange({ ...profile, executablePath: e.currentTarget.value })} /></label>
  {:else}
    <label>{backend?.baseUrlLabel ?? 'API URL'}<input value={profile.baseUrl} maxlength="2048" inputmode="url" placeholder={backend?.defaultBaseUrl ?? ''} oninput={e => onchange({ ...profile, baseUrl: e.currentTarget.value })} /></label>
    {#if backend?.baseUrlNote}<p class="note">{backend.baseUrlNote}</p>{/if}
    <label>Image model ID<input value={profile.defaultModel} maxlength="256" placeholder={backend?.modelPlaceholder ?? 'Model supported by this API'} oninput={e => onchange({ ...profile, defaultModel: e.currentTarget.value })} /></label>
    <label class="checkbox"><input type="checkbox" checked={profile.allowInsecureHttp} onchange={e => onchange({ ...profile, allowInsecureHttp: e.currentTarget.checked })} />Allow insecure HTTP for this connection</label>
    <label>Credential source<Select aria-label="Credential source" value={profile.credential.kind} options={CREDENTIAL_SOURCES} onchange={kind => { if (kind === 'none') onchange({ ...profile, credential: { kind: 'none' } }); else if (kind === 'environment') onchange({ ...profile, credential: { kind: 'environment', name: backend?.credentialEnv ?? '' } }); else if (kind === 'command') onchange({ ...profile, credential: { kind: 'command', argv: [] } }); }} /></label>
    {#if profile.credential.kind === 'environment'}
      <label>Environment variable name<input value={profile.credential.name} maxlength="128" placeholder={backend?.credentialEnv ?? ''} oninput={e => onchange({ ...profile, credential: { kind: 'environment', name: e.currentTarget.value } })} /></label>
      <p class="note">Read by the native provider from the app environment.</p>
    {/if}
    {#if profile.credential.kind === 'command'}
      <label>Credential command<input value={commandText ?? formatCommand(profile.credential.argv)} spellcheck="false" oninput={e => oncommand(e.currentTarget.value)} /></label>
      <p class="note">Runs without a shell; its output is used as the key. Example: secret-tool lookup service gemini</p>
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
  label { display: grid; gap: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); }
  input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 34px; padding: 6px 12px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; font-size: var(--font-size-body); font-weight: var(--font-weight-normal); transition: border-color var(--transition-fast); }
  input::placeholder { color: var(--text-tertiary); }
  input:focus { outline: none; } input:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .checkbox { display: flex; align-items: center; gap: var(--spacing-sm); color: var(--text-primary); font-size: var(--font-size-body); font-weight: var(--font-weight-normal); }.checkbox input { width: auto; min-height: 0; accent-color: var(--accent); }
  .note { margin: 0; color: var(--text-secondary); font-size: var(--font-size-caption); line-height: var(--line-height-normal); }
  .key-section { padding-top: var(--spacing-md); border-top: 1px solid var(--divider); display: grid; gap: var(--spacing-sm); }.key-section p { margin: 0; }
  .actions { display: flex; gap: var(--spacing-sm); flex-wrap: wrap; }
  button { min-height: 32px; padding: var(--spacing-xs) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:disabled, fieldset:disabled { opacity: .6; } button:disabled { cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
