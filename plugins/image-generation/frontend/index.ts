import type { Plugin } from '../../../integration/plugin-sdk';
import ImageConnectionsDialog from './ImageConnectionsDialog.svelte';
import { TestRegistry, type RevisionEvent } from './controller';
const DIALOG = 'image-generation.connections';
const imageGeneration: Plugin = {
  id: 'image-generation', name: 'Image Generation', description: 'Shared image generation and editing connections.', enabledByDefault: true,
  activate(context) {
    const ctx = context;
    if (!ctx.backend) throw new Error('Image Generation native backend is unavailable');
    const registry = new TestRegistry();
    const listeners = new Set<(event: RevisionEvent) => void>();
    ctx.events.listen<RevisionEvent>('image-generation:configuration-changed', event => { for (const fn of listeners) fn(event); });
    const props = { backend: ctx.backend, registry, subscribeRevision: (fn: (event: RevisionEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const run = async () => { if (ctx.presentation) await ctx.presentation.openDialog(DIALOG); else ctx.openDialog(DIALOG); };
    ctx.registerDialog({ id: DIALOG, component: ImageConnectionsDialog, props });
    const section = { id: 'image-generation', title: 'AI / Image Generation', rows: [], actions: [{ id: 'configure', label: 'Configure connections', description: 'Manage saved image connections, credentials, and explicit generation tests.', run }] };
    ctx.registerSettingsSection(section);
    ctx.registerCommand({ id: 'plugin.image-generation.connections', label: 'Image Generation: Configure connections', category: 'plugins', handler: run });
  },
};
export const plugins: Plugin[] = [imageGeneration];
