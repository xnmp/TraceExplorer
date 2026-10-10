import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
const repository = resolve(import.meta.dirname, '../../../..');
const host = process.env.HOST_CHECKOUT;
export default defineConfig({ root: import.meta.dirname, plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })], resolve: { dedupe: ['svelte'], alias: [
  { find: /^\$lib\/components\/Modal\.svelte$/, replacement: host ? resolve(host, 'src/lib/components/Modal.svelte') : resolve(repository, 'e2e/harness/StubModal.svelte') },
  { find: '$lib', replacement: host ? resolve(host, 'src/lib') : resolve(repository, 'src/lib') },
] }, server: { fs: { allow: [repository, ...(host ? [resolve(host)] : [])] } } });
