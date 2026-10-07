#!/usr/bin/env bash
# Native smoke test of this package in a real Tauri Explorer host (Linux).
#
# Installs the built .teplugin through the host's startup queue into an
# ISOLATED profile (XDG dirs under a temporary directory, never your own),
# then runs the host's `installed-plugin-file-view` WebDriver spec under a
# private X server so no window appears on your desktop.
#
# Usage: scripts/host-smoke.sh HOST_CHECKOUT [PACKAGE.teplugin]
#   HOST_CHECKOUT  a tauri-explorer checkout whose debug binary was built with
#                  `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks`
#   PACKAGE        defaults to the newest package/TraceExplorer-*-<arch>-unknown-linux-gnu.teplugin
# Requires: tauri-driver, WebKitWebDriver, xvfb-run, dbus-run-session, openbox.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then echo "host-smoke.sh supports Linux only" >&2; exit 2; fi
host=${1:?usage: $0 HOST_CHECKOUT [PACKAGE.teplugin]}
here=$(cd "$(dirname "$0")/.." && pwd)
package=${2:-$(find "$here/package" -maxdepth 1 -name "TraceExplorer-*-$(uname -m)-unknown-linux-gnu.teplugin" -print | sort -V | tail -n 1)}
[[ -f "$package" ]] || { echo "No package found; run python3 scripts/package-plugin.py first" >&2; exit 2; }
for tool in tauri-driver WebKitWebDriver xvfb-run dbus-run-session openbox; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 2; }
done

profile=$(mktemp -d "${TMPDIR:-/tmp}/trace-host-smoke.XXXXXX")
trap 'rm -rf -- "$profile"' EXIT
export XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache" XDG_STATE_HOME="$profile/state"
mkdir -p "$XDG_CONFIG_HOME/tauri-explorer/pending-plugins" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
digest=$(sha256sum "$package" | cut -d' ' -f1)
cp -- "$package" "$XDG_CONFIG_HOME/tauri-explorer/pending-plugins/$digest.teplugin"

echo "Smoke-testing $(basename "$package") in an isolated profile at $profile"
cd "$host"
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 TRACE_EXPLORER_PLUGIN_SMOKE=1 \
  xvfb-run -a --server-args="-screen 0 1440x1000x24" \
  dbus-run-session -- bash e2e-tauri/with-window-manager.sh \
  bunx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/installed-plugin-file-view.spec.ts
