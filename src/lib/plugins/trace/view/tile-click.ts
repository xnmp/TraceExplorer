import type { PluginToast } from "../../../../../integration/plugin-sdk";

interface TileSelection {
  readonly focusedKey: string | undefined;
  readonly selectedKeys: ReadonlySet<string>;
  readonly selectedPaths: ReadonlySet<string>;
}

/** Click count does not affect re-clicks: each plain click toggles the sole focused selection. */
export function isTileReclick(key: string, selection: TileSelection, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
  return !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
    && selection.focusedKey === key && selection.selectedKeys.size === 1 && selection.selectedKeys.has(key) && selection.selectedPaths.size <= 1;
}

/** The caller supplies the same condition that offers its disclosure; keyboard Open stays separate. */
export function tileDoubleClick(togglable: boolean, open: () => void, toast?: PluginToast): void {
  if (togglable) toast?.show?.("Double-click isn't available in Trace view", "info");
  else open();
}
