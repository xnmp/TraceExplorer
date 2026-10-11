import type { PluginDialogOptions } from "../../integration/plugin-sdk";

export interface HarnessDialog {
  readonly id: string;
  readonly instanceId: number;
  readonly props: Record<string, unknown>;
  readonly options?: PluginDialogOptions;
}

/** Mirrors the host registry's one mounted component per dialog ID. */
export function openHarnessDialog(
  current: readonly HarnessDialog[], id: string, props: Record<string, unknown>,
  options: PluginDialogOptions | undefined, instanceId: number,
): readonly HarnessDialog[] {
  const existing = current.find((dialog) => dialog.id === id);
  if (existing?.options?.scope === "pane") return current;
  if (existing) return [...current.filter((dialog) => dialog.id !== id), { ...existing, props }];
  return [...current.filter((dialog) => dialog.id !== id), { id, props, options, instanceId }];
}
