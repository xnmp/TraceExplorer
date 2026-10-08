import { afterEach, describe, expect, it } from "vitest";
import { hostFileTiles, SVELTE_ABI } from "../../src/sdk";

const g = globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: unknown };
const original = g.__TAURI_EXPLORER_PLUGIN_SDK__;
const Tiles = function FileTiles() {};
const sdk = (capabilities: string[] | undefined, modules: Record<string, Record<string, unknown>> = {}) =>
  ({ sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities, modules });

describe("hostFileTiles", () => {
  afterEach(() => { g.__TAURI_EXPLORER_PLUGIN_SDK__ = original; });

  it("returns the host's Tiles view where the host announces fileTiles", () => {
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["fileViews", "fileTiles"], { "ui/file-tiles": { default: Tiles } });
    expect(hostFileTiles()).toBe(Tiles);
  });

  it("falls back on older SDK 2 hosts, even if a module of that name happens to exist", () => {
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["fileViews"], { "ui/file-tiles": { default: Tiles } });
    expect(hostFileTiles()).toBeNull();
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(undefined);
    expect(hostFileTiles()).toBeNull();
  });

  it("falls back when the announced module is missing or malformed", () => {
    for (const modules of [{}, { "ui/file-tiles": {} }, { "ui/file-tiles": { default: "Tiles" } }, { "ui/file-tiles": { default: null } }]) {
      g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["fileTiles"], modules);
      expect(hostFileTiles()).toBeNull();
    }
  });

  it("falls back without a usable host instead of throwing", () => {
    for (const value of [undefined, null, {}, { ...sdk(["fileTiles"], { "ui/file-tiles": { default: Tiles } }), apiVersion: 1 }]) {
      g.__TAURI_EXPLORER_PLUGIN_SDK__ = value;
      expect(hostFileTiles()).toBeNull();
    }
  });
});
