import { afterEach, describe, expect, it } from "vitest";
import { hostCapturePane, hostFileTiles, hostRegisterFileDropTarget, hostSupportsSelectionAnchor, SVELTE_ABI } from "../../src/sdk";
import type { PluginContext } from "../../integration/plugin-sdk";

const g = globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: unknown };
const original = g.__TAURI_EXPLORER_PLUGIN_SDK__;
const Tiles = function FileTiles() {};
const sdk = (capabilities: string[] | undefined, modules: Record<string, Record<string, unknown>> = {}) =>
  ({ sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities, modules });

describe("optional dialog and drop APIs", () => {
  afterEach(() => { g.__TAURI_EXPLORER_PLUGIN_SDK__ = original; });
  const pane = { paneId: "owner" };
  const dispose = () => {};
  const workspace = {
    capturePane(this: unknown) { expect(this).toBe(workspace); return pane; },
    registerFileDropTarget(this: unknown) { expect(this).toBe(workspace); return dispose; },
  } as unknown as PluginContext["workspace"];
  it("returns bound methods only when the independent capabilities are announced", () => {
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["paneDialogs", "fileDropTargets"]);
    expect(hostCapturePane(workspace)?.()).toBe(pane);
    expect(hostRegisterFileDropTarget(workspace)?.({} as HTMLElement, () => {})).toBe(dispose);
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["paneDialogs"]);
    expect(hostCapturePane(workspace)?.()).toBe(pane);
    expect(hostRegisterFileDropTarget(workspace)).toBeNull();
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["fileDropTargets"]);
    expect(hostCapturePane(workspace)).toBeNull();
    expect(hostRegisterFileDropTarget(workspace)).toBeTypeOf("function");
  });
  it("defensively falls back for absent capabilities, methods and malformed runtimes", () => {
    for (const runtime of [undefined, null, {}, sdk(undefined), sdk([]), { ...sdk(["paneDialogs", "fileDropTargets"]), apiVersion: 1 }]) {
      g.__TAURI_EXPLORER_PLUGIN_SDK__ = runtime;
      expect(hostCapturePane(workspace)).toBeNull();
      expect(hostRegisterFileDropTarget(workspace)).toBeNull();
    }
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["paneDialogs", "fileDropTargets"]);
    for (const value of [undefined, null, "not callable", {}]) {
      const malformed = { capturePane: value, registerFileDropTarget: value } as unknown as PluginContext["workspace"];
      expect(hostCapturePane(malformed)).toBeNull();
      expect(hostRegisterFileDropTarget(malformed)).toBeNull();
    }
  });
});

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


describe("marquee anchor capability", () => {
  afterEach(() => { g.__TAURI_EXPLORER_PLUGIN_SDK__ = original; });
  it("requires selectionAnchor on a compatible host runtime", () => {
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = sdk(["selectionAnchor"]);
    expect(hostSupportsSelectionAnchor()).toBe(true);
    for (const runtime of [undefined, null, {}, sdk(undefined), sdk([]), sdk(["fileViews"]), { ...sdk(["selectionAnchor"]), apiVersion: 1 }]) {
      g.__TAURI_EXPLORER_PLUGIN_SDK__ = runtime;
      expect(hostSupportsSelectionAnchor()).toBe(false);
    }
  });
});
