<script lang="ts">
  import type { Component } from 'svelte';
  import type { PluginContext } from '../../../../integration/plugin-sdk';
  import type { ImageConfiguration, ImageOperationStatus } from '../../../../integration/services/image-generation-v1';
  import { plugins } from '../index';
  let dialog = $state.raw<{ component: Component<any>; props: Record<string, unknown> } | null>(null);
  let configure = $state<(() => void | Promise<void>) | null>(null);
  const dialogs = new Map<string, Component<any>>();
  const handlers: ((event: unknown) => void)[] = [];
  let current: ImageConfiguration = { schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: [] };
  const results = new Map<string, ImageOperationStatus>();
  const calls: string[] = [];
  const emit = () => handlers.forEach(fn => fn({ documentRevision: current.documentRevision, affectedProfileIds: current.profiles.map(p => p.id) }));
  const fixture = {
    snapshot: () => structuredClone(current), calls: () => [...calls],
    remoteName: (name: string) => { current = { ...current, documentRevision: current.documentRevision + 1, profiles: current.profiles.map(p => ({ ...p, name })) }; emit(); },
  };
  Object.assign(window, { imageConnectionFixture: fixture });
  const backend = { async invoke(method: string, params: Record<string, unknown> = {}) {
    calls.push(method);
    if (method === 'settings.read') return structuredClone(current);
    if (method === 'settings.save') {
      if (params.expectedRevision !== current.documentRevision) throw Error('Image connections changed; reload before saving');
      current = { ...structuredClone(params.configuration as ImageConfiguration), documentRevision: current.documentRevision + 1 }; emit(); return structuredClone(current);
    }
    if (method === 'settings.credential.set' || method === 'settings.credential.clear') {
      if (params.expectedRevision !== current.documentRevision) throw Error('Settings changed');
      current = { ...current, documentRevision: current.documentRevision + 1, profiles: current.profiles.map(p => p.id === params.profileId && p.transport === 'openai-images' ? { ...p, credential: method.endsWith('.clear') ? { kind: 'none' } : { kind: 'secret', id: 'owned-secret-reference' } } : p) }; emit(); return structuredClone(current);
    }
    if (method === 'settings.check') return { available: true };
    const requestId = String(params.requestId);
    if (method === 'settings.test') {
      if (params.expectedConfigurationRevision !== current.documentRevision) throw Error('Settings changed');
      const receipt: ImageOperationStatus = { version: 1, operationId: requestId, requestFingerprint: 'b'.repeat(64), provider: { packageId: 'xnmp.image-generation', serviceId: 'image-generation', major: 1 }, revision: 1, execution: { state: 'accepted' }, delivery: { state: 'none' } }; results.set(requestId, receipt); return structuredClone(receipt);
    }
    const receipt = results.get(requestId); if (!receipt) throw Error('Unknown test');
    if (method === 'settings.test.status') {
      const completed: ImageOperationStatus = { ...receipt, revision: 2, execution: { state: 'succeeded', metadata: { adapter: 'openai-images', endpointIdentity: 'https://example.test/images', requestedModel: 'custom-image', actualModel: null, externalRequestId: null, threadId: null, options: { size: '1024x1024', quality: 'low', background: 'auto' }, remoteChargeUncertain: false } }, delivery: { state: 'available', output: { handle: 'opaque-fixture-handle', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png' } } }; results.set(requestId, completed); return structuredClone(completed);
    }
    if (method === 'settings.cancelTest') { const cancelled = { ...receipt, revision: 3, execution: { state: 'cancelled' } as const }; results.set(requestId, cancelled); return structuredClone(cancelled); }
    if (method === 'settings.test.discard') { const discarded = { ...receipt, revision: 4, delivery: { state: 'discarded' } as const }; results.set(requestId, discarded); return structuredClone(discarded); }
    throw Error('Unknown fixture RPC');
  } };
  plugins[0].activate({ backend, events: { listen: (_: string, fn: (event: unknown) => void) => handlers.push(fn) }, registerDialog: (entry: { id: string; component: Component<any> }) => dialogs.set(entry.id, entry.component), registerCommand: () => {}, registerSettingsSection: (section: { actions: { run: () => void | Promise<void> }[] }) => configure = section.actions[0].run,
    openDialog: (id: string, props: Record<string, unknown>) => dialog = { component: dialogs.get(id)!, props } } as unknown as PluginContext);
</script>
<main><h1>Image Generation settings fixture</h1><button type="button" onclick={() => configure?.()}>Configure connections</button></main>
{#if dialog}{@const Dialog = dialog.component}<Dialog {...dialog.props} open={true} onClose={() => dialog = null} />{/if}
<style>main { padding: 1rem; } :global(body) { margin: 0; background: var(--background-solid); color: var(--text-primary); font-family: var(--font-family); }</style>
