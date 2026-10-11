<script lang="ts">
  import type { Component } from 'svelte';
  import type { PluginContext } from '../../../../integration/plugin-sdk';
  import { plugins } from '../index';
  import { connectionFixture } from './fixture';
  let dialog = $state.raw<{ component: Component<any>; props: Record<string, unknown> } | null>(null);
  let configure = $state<(() => void | Promise<void>) | null>(null);
  // Like the host, a dialog opens with the props it was registered with, overridden by any passed when opening.
  const dialogs = new Map<string, { component: Component<any>; props: Record<string, unknown> }>();
  const handlers: ((event: unknown) => void)[] = [];
  const fixture = connectionFixture(undefined, current => handlers.forEach(fn => fn({ documentRevision: current.documentRevision, affectedProfileIds: current.profiles.map(p => p.id) })));
  Object.assign(window, { imageConnectionFixture: { ...fixture, calls: () => fixture.calls().map(call => call.method) } });
  const backend = fixture.backend;
  plugins[0].activate({ backend, events: { listen: (_: string, fn: (event: unknown) => void) => handlers.push(fn) }, registerDialog: (entry: { id: string; component: Component<any>; props?: Record<string, unknown> }) => dialogs.set(entry.id, { component: entry.component, props: entry.props ?? {} }), registerCommand: () => {}, registerSettingsSection: (section: { actions: { run: () => void | Promise<void> }[] }) => configure = section.actions[0].run,
    openDialog: (id: string, props: Record<string, unknown> = {}) => { const entry = dialogs.get(id)!; dialog = { component: entry.component, props: { ...entry.props, ...props } }; } } as unknown as PluginContext);
</script>
<main><h1>Image Generation settings fixture</h1><button type="button" onclick={() => configure?.()}>Configure connections</button></main>
{#if dialog}{@const Dialog = dialog.component}<Dialog {...dialog.props} open={true} onClose={() => dialog = null} />{/if}
<style>main { padding: 1rem; } :global(body) { margin: 0; background: var(--background-solid); color: var(--text-primary); font-family: var(--font-family); }</style>
