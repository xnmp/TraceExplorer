import type { RuntimeSDK } from "../integration/plugin-sdk";
export const SVELTE_ABI = "5.56.3";
export function host(): RuntimeSDK {
  const sdk = (globalThis as typeof globalThis & { __TAURI_EXPLORER_PLUGIN_SDK__?: RuntimeSDK }).__TAURI_EXPLORER_PLUGIN_SDK__;
  if (!sdk || sdk.sdkVersion !== 1 || sdk.svelteVersion !== SVELTE_ABI) throw new Error("TraceExplorer needs a compatible Tauri Explorer plugin host");
  return sdk;
}
