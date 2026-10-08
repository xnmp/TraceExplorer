import type { Component } from "svelte";
import type { FileTilesProps, RuntimeSDK } from "../integration/plugin-sdk";
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

/**
 * The host's Tiles view component (`ui/file-tiles`), where the host announces
 * `fileTiles`; null on older SDK 2 hosts. Looked up at run time rather than
 * bound at load, because older hosts do not have the module.
 */
export function hostFileTiles(): Component<FileTilesProps> | null {
  try {
    const sdk = host();
    if (!sdk.capabilities?.includes("fileTiles")) return null;
    const component = sdk.modules["ui/file-tiles"]?.default;
    return typeof component === "function" ? component as Component<FileTilesProps> : null;
  } catch { return null; }
}
