import type { RuntimeSDK } from "../integration/plugin-sdk";
export const SVELTE_ABI = "5.56.3";
export function host(): RuntimeSDK {
  const sdk = (globalThis as typeof globalThis & { __TAURI_EXPLORER_PLUGIN_SDK__?: RuntimeSDK }).__TAURI_EXPLORER_PLUGIN_SDK__;
  if (!sdk || sdk.sdkVersion !== 1 || (sdk.apiVersion ?? 1) < 2 || sdk.svelteVersion !== SVELTE_ABI) throw new Error("TraceExplorer needs a Tauri Explorer host with plugin SDK 2");
  return sdk;
}

/** Whether the host allows workers created from plugin-owned blob URLs. */
export function hostAllowsBlobWorkers(): boolean {
  try { return host().capabilities?.includes("blobWorkers") ?? false; } catch { return false; }
}
