import "./svelte-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tracePlugin } from "$lib/plugins/trace";
import { SVELTE_ABI } from "../../../src/sdk";
import { configureBackend } from "$lib/api/common";

const g = globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: Record<string, unknown> };
const original = g.__TAURI_EXPLORER_PLUGIN_SDK__;
afterEach(() => { tracePlugin.deactivate?.(); g.__TAURI_EXPLORER_PLUGIN_SDK__ = original; });

function activate(capabilities: string[], withMethod: boolean) {
  g.__TAURI_EXPLORER_PLUGIN_SDK__ = { ...original, sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities, modules: original?.modules ?? {} };
  configureBackend({ invoke: async () => [] } as never);
  const commands: string[] = [];
  // Mirrors the host's id rule (tauri-explorer api.ts): `<plugin id>.<name>`.
  const entryLineage = vi.fn((c: { id: string }) => {
    const name = c.id.startsWith(`${tracePlugin.id}.`) ? c.id.slice(tracePlugin.id.length + 1) : null;
    if (!name || name.includes(".")) throw new Error(`Entry lineage ${c.id} must be named ${tracePlugin.id}.<name>`);
  });
  const listeners: Array<(directories: readonly string[]) => void> = [];
  const ctx = {
    registerSettingsSection: vi.fn(), registerCommand: (c: { id: string }) => commands.push(c.id), registerFileView: vi.fn(), registerPreviewInfo: vi.fn(),
    ...(withMethod ? { registerEntryLineage: entryLineage } : {}),
    events: { listen: vi.fn() }, workspace: { onFilesChanged: (h: never) => listeners.push(h), toggleFileView: vi.fn() },
  };
  return { ctx, commands, entryLineage };
}

describe("Trace plugin activation and lineage", () => {
  it("registers the lineage provider and Show Traces beside Toggle Trace View on a capable host", async () => {
    const { ctx, commands, entryLineage } = activate(["fileViews", "entryLineage"], true);
    await tracePlugin.activate(ctx as never);
    expect(entryLineage).toHaveBeenCalledOnce();
    expect(entryLineage.mock.calls[0][0]).toMatchObject({ id: "trace.lineage", title: "Traces" });
    expect(commands).toEqual(expect.arrayContaining(["plugin.trace.toggle", "plugin.trace.show-traces"]));
  });

  it("is unchanged on an older host", async () => {
    for (const [caps, method] of [[["fileViews"], false], [["fileViews"], true], [["entryLineage"], false]] as const) {
      const { ctx, commands, entryLineage } = activate([...caps], method);
      await tracePlugin.activate(ctx as never);
      expect(entryLineage).not.toHaveBeenCalled();
      expect(commands).toContain("plugin.trace.toggle");
      expect(commands).not.toContain("plugin.trace.show-traces");
      tracePlugin.deactivate?.();
    }
  });
});
