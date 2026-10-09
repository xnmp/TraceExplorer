/** SDK v2 (a superset of v1). Runtime capabilities come from the host, not host source imports. */
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
  accept(
    registration: {
      kind: string; label: string; detail: string; presentation?: "image";
      /**
       * Hosts with the "jobRetry" capability show a Retry action on this job's
       * entry in Background Operations (e.g. the Image generation panel) when
       * the job fails. Calling it should start a fresh job (the plugin calls
       * `accept` again); the host then removes the failed entry. Rejections
       * or a returned `{ ok: false }` are shown as the entry's error and keep
       * it.
       */
      retry?: () => Promise<ApiResult<number>>;
    },
    start: () => Promise<ApiResult<number>>,
  ): Promise<ApiResult<number>>;
}
export interface PluginToast { show(message: string, variant?: "info" | "success" | "error" | "warning"): void; error(message: string): void }
export interface ImageEditorSource {
  path: string; name: string; digest: string; format: string;
  size?: { width: number; height: number };
  referencePaths: readonly string[];
}
/** The host's tile-size presets (THUMBNAIL_SIZE_CONFIG). */
export type TileSizePreset = "small" | "medium" | "large" | "xlarge";
/**
 * A pane's tile size, resolved the way the host's Tiles view resolves it:
 * the per-folder override for the pane's directory, then the global setting.
 * Reactive: reading it inside a Svelte derivation tracks changes.
 */
export interface PaneTileSize {
  readonly preset: TileSizePreset;
  /** Thumbnail image edge in CSS px for that preset (e.g. 48 / 64 / 96 / 128). */
  readonly imagePx: number;
}
/** SDK 2: the pane a file view renders in. Getters are reactive; actions target this pane only. */
export interface FileViewPane {
  readonly paneId: string;
  readonly directory: string;
  readonly entries: readonly FileEntry[];
  readonly selection: readonly FileEntry[];
  readonly focusedPath: string | null;
  readonly active: boolean;
  readonly previewTarget: PreviewTarget | null;
  /** Present on hosts with the "tileSize" capability. */
  readonly tileSize?: PaneTileSize;
  select(entry: FileEntry, modifiers?: { ctrlKey?: boolean; shiftKey?: boolean }): void;
  setSelection(paths: readonly string[], focus?: string | null): void;
  clearSelection(): void;
  open(entry: FileEntry): Promise<void>;
  contextMenu(event: MouseEvent, entry?: FileEntry): void;
  navigate(path: string): Promise<void>;
  setPreviewTarget(target: PreviewTarget | null): void;
  exitView(): void;
}
export interface PreviewTargetAction { id: string; label: string; title?: string; icon?: "save" | "delete" | "save-as"; disabled?: boolean; run(): void | Promise<void> }
export interface PreviewTarget {
  readonly id: string; readonly title: string; readonly typeLabel?: string; readonly imagePath?: string; readonly badge?: string;
  readonly details?: readonly { label: string; value: string }[];
  readonly actions?: readonly PreviewTargetAction[];
  readonly data?: unknown;
}
export type PreviewSubject =
  | { readonly kind: "file"; readonly entry: FileEntry; readonly paneId: string | null }
  | { readonly kind: "target"; readonly target: PreviewTarget; readonly pluginId: string; readonly paneId: string | null };
export interface FileViewContribution { id: string; title: string; component: Component<any>; props?: Record<string, unknown>; available?(directory: string): boolean }
/**
 * A Preview-info section. It spans the pane's width below the host's own info
 * rows. Hosts that set `--preview-info-inset` (the inset of their rows in the
 * current dock) let a section pad by it to line up with them; use a fallback,
 * since older hosts do not define it.
 */
export interface PreviewInfoContribution { id: string; component: Component<any>; props?: Record<string, unknown>; when(subject: PreviewSubject): boolean }

export interface PluginContext {
  registerCommand(command: {id: string; label: string; category: string; shortcut?: string; when?: () => boolean; handler: () => void | Promise<void>}): void;
  registerContextMenuItem(item: {id: string; label: string; group: string; when: (entries: FileEntry[]) => boolean; handler: (entries: FileEntry[]) => void | Promise<void>}): void;
  registerSettingsSection(section: {id: string; title: string; rows: {id: string; label: string; type: "select" | "text" | "password" | "toggle"; default?: string | boolean; description?: string; options?: {value: string; label: string}[]}[]}): void;
  registerInspector(contribution: {id: string; title: string; component: Component<any>; props?: Record<string, unknown>; when: (entries: FileEntry[]) => boolean}): void;
  registerImageEditorTool(tool: {id: string; title: string; component: Component<any>; props?: Record<string, unknown>; when: (source: ImageEditorSource) => boolean}): void;
  registerDialog(dialog: {id: string; component: Component<any>}): void;
  /** SDK 2. */
  registerFileView?(view: FileViewContribution): void;
  /** SDK 2. */
  registerPreviewInfo?(section: PreviewInfoContribution): void;
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
    /** SDK 2. */
    getFileView?(): string | null;
    /** SDK 2. */
    toggleFileView?(viewId: string): void;
  };
}
export interface Plugin {id: string; name: string; description: string; enabledByDefault?: boolean; activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void}
/**
 * Props of the host's `ui/file-tiles` module (capability `"fileTiles"`): the
 * Explorer's Tiles view for a list of entries. Each tile carries
 * `data-entry-path`; the host renders icons, thumbnails, selection and
 * keyboard behaviour exactly as in its Tiles view.
 */
export interface FileTilesProps {
  entries: readonly FileEntry[];
  /** Selected entry paths. */
  selected: ReadonlySet<string>;
  onselect(entry: FileEntry, event: MouseEvent): void;
  onopen(entry: FileEntry): void;
  onmenu(entry: FileEntry, event: MouseEvent): void;
  /** Accessible name of the tile list. */
  label?: string;
  /** Tile size preset (hosts with the "tileSize" capability); omitted, the host's global setting applies. Pass `pane.tileSize?.preset`. */
  size?: TileSizePreset;
}
export interface RuntimeSDK {
  /** Frozen at 1 so SDK 1 packages keep loading; see apiVersion. */
  sdkVersion: 1;
  /** Present from SDK 2 hosts on. */
  apiVersion?: number;
  /** For example `fileViews`, `previewInfo`, `previewTargets`, `blobWorkers`, `fileTiles`, `tileSize`, `jobRetry`. */
  capabilities?: readonly string[];
  svelteVersion: string;
  /** Shared host modules: `svelte`, `ui/modal`, `ui/image-editor`, and `ui/file-tiles` where `fileTiles` is announced. */
  modules: Record<string, Record<string, unknown>>;
  thumbnailData(path: string, size?: number): Promise<ApiResult<string>>;
  pickSaveFile(options: {directory: string; filename: string; title: string}): Promise<string | null>;
}
