/** SDK v1. Runtime capabilities come from the host, not host source imports. */
import type { Component } from "svelte";
import type { FileEntry } from "../../src/lib/domain/file";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export interface PluginBackend { invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> }
export interface PluginStorage {
  get(): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  setChecked?(value: Record<string, unknown>): Promise<void>;
  subscribe?(listener: (value: Record<string,unknown>)=>void): ()=>void;
}
export interface PluginJobs {
  accept(registration: {kind: string; label: string; detail: string; presentation?: "image"}, start: () => Promise<ApiResult<number>>): Promise<ApiResult<number>>;
}
export interface PluginToast { show(message: string, variant?: "info" | "success" | "error" | "warning"): void; error(message: string): void }
export interface ImageEditorSource {
  path: string; name: string; digest: string; format: string;
  size?: { width: number; height: number };
  referencePaths: readonly string[];
}
export interface PluginContext {
  registerCommand(command: {id: string; label: string; category: string; shortcut?: string; when?: () => boolean; handler: () => void | Promise<void>}): void;
  registerContextMenuItem(item: {id: string; label: string; group: string; when: (entries: FileEntry[]) => boolean; handler: (entries: FileEntry[]) => void | Promise<void>}): void;
  registerSettingsSection(section: {id: string; title: string; rows: {id: string; label: string; type: "select" | "text" | "password" | "toggle"; default?: string | boolean; description?: string; options?: {value: string; label: string}[]}[]}): void;
  registerInspector(contribution: {id: string; title: string; component: Component<any>; props?: Record<string, unknown>; when: (entries: FileEntry[]) => boolean}): void;
  registerImageEditorTool(tool: {id: string; title: string; component: Component<any>; props?: Record<string, unknown>; when: (source: ImageEditorSource) => boolean}): void;
  registerDialog(dialog: {id: string; component: Component<any>}): void;
  openDialog(id: string, props?: Record<string, unknown>): void;
  closeDialog(id: string): void;
  backend?: PluginBackend;
  jobs: PluginJobs;
  toast: PluginToast;
  storage: PluginStorage;
  saveSettings(patch: Record<string, unknown>): Promise<void>;
  events: {listen<T>(name: string, handler: (payload: T) => void | Promise<void>): void};
  workspace: {
    getCurrentDirectory?(): string | null;
    onDirectoryChanged?(handler: (path:string|null)=>void): void;
    getSelection(): FileEntry[];
    captureSelection(): () => boolean;
    selectFile(path: string): Promise<void>;
    onFilesChanged(handler: (directories: readonly string[]) => void | Promise<void>): void;
  };
}
export interface Plugin {id: string; name: string; description: string; enabledByDefault?: boolean; activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void}
export interface RuntimeSDK {
  sdkVersion: 1;
  svelteVersion: string;
  modules: Record<string, Record<string, unknown>>;
  thumbnailData(path: string, size?: number): Promise<ApiResult<string>>;
  pickSaveFile(options: {directory: string; filename: string; title: string}): Promise<string | null>;
}
