/**
 * The plugin build maps `svelte` runtime imports onto the host's instance via
 * `globalThis.__TAURI_EXPLORER_PLUGIN_SDK__.modules`. Unit tests supply the
 * real Svelte runtime there. Import this module before anything that compiles
 * runes (`.svelte.ts`).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modules: Record<string, unknown> = {};
for (const name of ["svelte", "svelte/internal/client", "svelte/internal/server", "svelte/internal/flags/async", "svelte/internal/flags/legacy", "svelte/internal/flags/tracing"]) {
  try { modules[name] = require(name); } catch { /* not every entry exists in every Svelte version */ }
}
const g = globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: { modules?: Record<string, unknown> } };
g.__TAURI_EXPLORER_PLUGIN_SDK__ = { ...g.__TAURI_EXPLORER_PLUGIN_SDK__, modules: { ...g.__TAURI_EXPLORER_PLUGIN_SDK__?.modules, ...modules } };
