/**
 * Path normalization helpers.
 * Pure functions — no framework or filesystem deps.
 *
 * Separator policy: these helpers accept either `/` or `\` on input (Windows
 * backends emit backslash-separated paths) and emit `/`-separated results.
 * Forward slashes round-trip correctly through the Windows APIs the backend
 * uses, so callers can stay separator-agnostic.
 */

import { isVirtualPath } from "./virtual-path";

const BARE_DRIVE_LETTER = /^([A-Za-z]):$/;
/** A Windows drive prefix capturing the letter and the remainder, e.g. `C:/Users`. */
const DRIVE_PREFIX = /^([A-Za-z]):(.*)$/;
/** A UNC share root like `//server/share` (after backslash normalization). */
const UNC_ROOT = /^\/\/[^/]+\/[^/]+/;

/** Normalize all backslash separators to forward slashes. */
export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * True for a UNC path (`\\server\share\…` or `\\wsl.localhost\Distro\…`),
 * tolerant of separator style. Windows has no Recycle Bin for these network/WSL
 * locations, so deletes there are permanent rather than recoverable.
 */
export function isUncPath(path: string): boolean {
  const normalized = toForwardSlashes(path);
  if (normalized.startsWith("//?/")) return /^\/\/\?\/UNC\/[^/]+\/[^/]+/.test(normalized);
  if (normalized.startsWith("//./")) return false;
  return /^\/\/[^/]+\/[^/]+/.test(normalized);
}

/** Normalize all forward-slash separators to backslashes. */
export function toBackslashes(path: string): string {
  return path.replace(/\//g, "\\");
}

/**
 * Coerce every separator in `path` to a single style. The caller supplies the
 * target separator (typically the platform's native one) so this stays pure and
 * platform-agnostic — a backslash is a legal character in a Unix filename, so
 * the conversion must be opt-in via `sep`, never inferred.
 */
export function toNativeSeparators(path: string, sep: "/" | "\\"): string {
  // Virtual (`scheme://…`) paths are plugin addresses, not OS paths — leave
  // their separators untouched so `demo://a/b` never becomes `demo:\a\b` on
  // Windows (which would break provider dispatch and breadcrumb parsing).
  if (isVirtualPath(path)) return path;
  return sep === "\\" ? toBackslashes(toForwardSlashes(path)) : toForwardSlashes(path);
}

/** Strip a single trailing separator, but never reduce a bare root (`/`) to empty. */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

/**
 * Normalize a path string entered by the user (typically in the address bar).
 *
 * - A bare Windows drive letter like `e:` or `E:` becomes `E:/` so that
 *   downstream path logic (up-one-level, joining) sees a proper root. Without
 *   this, typing `e:` leaves the caller with a malformed path where the drive
 *   has no separator and `..` lookups break.
 * - The case of the drive letter is preserved uppercase so paths normalize to
 *   a canonical form.
 * - All other inputs pass through unchanged; callers should continue to do
 *   tilde expansion, whitespace trimming, etc. separately. In particular,
 *   backslashes are left intact here (a backslash is a legal character in a
 *   Unix filename), so navigation input is taken literally.
 */
export function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(BARE_DRIVE_LETTER);
  if (match) {
    return `${match[1].toUpperCase()}:/`;
  }
  return trimmed;
}

/**
 * Returns true if the given path is the root of a Windows drive (e.g. `C:/`
 * or `C:\`). Used to suppress broken "up one level" attempts from a drive root.
 */
export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path);
}

/**
 * Return the parent directory of a path. Separator-agnostic; emits `/`.
 *
 * `"/home/user/file.txt"`  → `"/home/user"`
 * `"/file.txt"`            → `"/"`
 * `"file.txt"` (no slash)  → `"/"`
 * `"C:\\Users\\foo"`        → `"C:/Users"`
 * `"C:\\Users"`             → `"C:/"`   (top-level dir's parent is the drive root)
 * `"C:/"` / `"C:"`          → `"C:/"`   (a drive root is its own parent)
 * `"\\\\server\\share\\d"`     → `"//server/share"`
 * `"\\\\server\\share"`       → `"//server/share"` (a share root is its own parent)
 */
export function parentDir(path: string): string {
  const p = toForwardSlashes(path);

  // Windows drive paths (`C:` / `C:/` / `C:/Users/...`).
  const drive = p.match(DRIVE_PREFIX);
  if (drive) {
    const letter = drive[1];
    const root = `${letter}:/`;
    const rest = stripTrailingSlash(drive[2]); // "" | "/Users" | "/Users/foo"
    if (rest === "") return root;
    const idx = rest.lastIndexOf("/");
    // A single top-level segment ("/Users") has its parent at the drive root.
    return idx > 0 ? `${letter}:${rest.substring(0, idx)}` : root;
  }

  // UNC share root (`//server/share`) is its own parent.
  const unc = p.match(UNC_ROOT);
  if (unc && stripTrailingSlash(p) === unc[0]) return unc[0];

  // POSIX (and UNC subpaths, which fall through to here correctly).
  const cleaned = stripTrailingSlash(p);
  const idx = cleaned.lastIndexOf("/");
  return idx > 0 ? cleaned.substring(0, idx) : "/";
}

/**
 * Canonical key for a directory path, stable across the separator style (`\` vs
 * `/`), a trailing slash, and — for Windows-style paths (drive letter or UNC) —
 * drive-letter and casing differences (Windows file systems are
 * case-insensitive). Use this anywhere a path is a dedup key, Map/Set member, or
 * object key so the same directory never produces two entries. The result is a
 * comparison key only; it is not meant for display (keep the native-separator
 * path for that).
 */
export function directoryKey(path: string): string {
  const norm = stripTrailingSlash(toForwardSlashes(path));
  // The WSL host name is Windows syntax; its filesystem suffix is Linux and
  // may contain distinct paths differing only by case. Never fold that suffix.
  const wsl = norm.match(/^(\/\/(?:wsl\$|wsl\.localhost))(?=\/|$)/i);
  if (wsl) return wsl[1].toLowerCase() + norm.slice(wsl[1].length);
  const isWindowsPath = /^[A-Za-z]:/.test(norm) || norm.startsWith("//");
  return isWindowsPath ? norm.toLowerCase() : norm;
}

/** Native POSIX names may contain literal backslashes; comparison must retain
 * them while Windows paths still use the shared separator/case rules. */
export function nativeDirectoryKey(path: string): string {
  return path.startsWith("/") && !path.startsWith("//")
    ? stripTrailingSlash(path)
    : directoryKey(path);
}

/**
 * True when two paths refer to the same directory. Tolerant of separator style,
 * trailing slash, and Windows drive-letter/casing differences (see
 * `directoryKey`). This is what makes "paste into the same folder produces a
 * copy" work on Windows, where the clipboard source dir and the current dir can
 * differ only by separator or case and a raw `===` would wrongly see them as
 * different (triggering a conflict prompt instead of a silent " - Copy").
 */
export function sameDirectory(a: string, b: string): boolean {
  return directoryKey(a) === directoryKey(b);
}

/**
 * Join a directory path and a child name with a single separator. If `dir`
 * already ends in a separator, that one is reused. Otherwise the separator
 * matches the style `dir` already uses (backslash if it contains one and no
 * forward slash) so a Windows path stays all-backslash instead of going mixed;
 * forward slash is the default.
 *
 * `joinPath("/home/user", "file.txt")`  → `"/home/user/file.txt"`
 * `joinPath("/", "file.txt")`           → `"/file.txt"`
 * `joinPath("C:\\Users", "f.txt")`       → `"C:\\Users\\f.txt"`
 */
export function joinPath(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return dir + name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir + sep + name;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * `expandTilde("~", "/home/u")`      → `"/home/u"`
 * `expandTilde("~/docs", "/home/u")` → `"/home/u/docs"`
 * `expandTilde("/etc", "/home/u")`   → `"/etc"` (unchanged)
 * With a null/unknown homeDir the input passes through unchanged.
 */
export function expandTilde(path: string, homeDir: string | null): string {
  if (!homeDir) return path;
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return homeDir + path.slice(1);
  return path;
}

/**
 * Return the last path segment (file or directory name). Separator-agnostic.
 *
 * `"/home/user/file.txt"`  → `"file.txt"`
 * `"/home/user/"`         → `"user"` (trailing slash stripped)
 * `"C:\\Users\\foo"`        → `"foo"`
 * `"file.txt"`            → `"file.txt"`
 * `"/"`                   → `"/"`
 */
export function basename(path: string): string {
  const p = toForwardSlashes(path);
  // Strip a single trailing slash (but not the root `/` itself)
  const cleaned = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = cleaned.lastIndexOf("/");
  return idx < 0 ? cleaned : cleaned.substring(idx + 1) || "/";
}

/**
 * A path split for display in a width-constrained single-line row (#500).
 *
 * `dir` is the leading directory portion *including* its trailing separator and
 * `name` is the final segment. The pair is a partition, never a normalization:
 * `dir + name === path` holds for every input, so a caller that renders the two
 * halves as adjacent elements produces exactly the original path as text. That
 * invariant is what lets the two halves be given different truncation
 * behaviour (elide `dir`, keep `name`) without the rendered path changing.
 */
export interface PathDisplayParts {
  /** Directory prefix including its trailing separator; `""` when there is none. */
  dir: string;
  /** Final path segment — the part worth keeping when space runs out. */
  name: string;
}

/**
 * Split `path` into an elidable directory prefix and its final segment, for
 * rendering a long path on one line without losing the part that identifies it.
 *
 * Unlike `basename`/`parentDir` this does not normalize separators, strip
 * trailing slashes, or special-case drive/UNC roots — it is a pure partition at
 * the last separator, chosen so `dir + name` reconstructs the input exactly.
 *
 * `"src/lib/app.ts"` → `{ dir: "src/lib/", name: "app.ts" }`
 * `"app.ts"`         → `{ dir: "", name: "app.ts" }`
 * `"src/lib/"`       → `{ dir: "src/lib/", name: "" }`
 */
export function splitPathForDisplay(path: string): PathDisplayParts {
  // `lastIndexOf` + `slice` around the same index is what makes the round-trip
  // total: every character lands in exactly one half, whatever the input.
  // `-1` (no separator) slices to `("", path)`, which is the wanted result.
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

/**
 * True if `child` is the same path as, or nested inside, `parent`.
 * Separator-agnostic so it works for both Unix and Windows paths.
 *
 * `isInsideDir("/a/b/c", "/a/b")`           → true
 * `isInsideDir("C:\\a\\b", "C:\\a")`           → true
 * `isInsideDir("/a/bc", "/a/b")`            → false (not a path-segment prefix)
 */
export function isInsideDir(child: string, parent: string): boolean {
  const c = toForwardSlashes(child);
  const p = stripTrailingSlash(toForwardSlashes(parent));
  return c === p || c.startsWith(p + "/");
}

/**
 * Separator-agnostic path equality. Needed because `parentDir`/`basename`
 * emit forward slashes while backend-provided paths (and DOM `data-path`
 * attributes) use the OS separator — on Windows a naive `===` between the two
 * always fails. Compares the forward-slash normal form of both, ignoring a
 * single trailing separator.
 *
 * `samePath("C:/Users/x", "C:\\Users\\x")` → true
 * `samePath("/a/b/", "/a/b")`              → true
 */
export function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(toForwardSlashes(a)) === stripTrailingSlash(toForwardSlashes(b));
}

/**
 * Split a drop "path" that is actually a flattened multi-file uri-list.
 *
 * When an in-app HTML5 drag (which sets `text/uri-list` from JS) is dropped
 * back onto the webview, WebKitGTK strips the CRLF separators before handing
 * the list to GTK, so wry parses ONE giant string:
 * `/a/first.pngfile:///a/second.jpgfile:///a/third.png` — the leading
 * `file://` is stripped from the first entry only and the rest stay embedded
 * (#253). Recover the individual paths by splitting on the embedded scheme.
 * wry already percent-decoded the whole string, so segments are plain paths.
 *
 * Single paths and properly-separated externals contain no embedded scheme
 * and pass through unchanged.
 */
export function splitFlattenedUriList(path: string): string[] {
  if (!path.includes("file://")) return [path];
  return path
    .split("file://")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}
