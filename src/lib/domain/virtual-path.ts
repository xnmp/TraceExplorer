/**
 * Virtual (plugin-provided) path helpers.
 * Pure functions — no framework or filesystem deps.
 *
 * A virtual path is a `<scheme>://<rest>` URL-like address served by a plugin
 * filesystem provider rather than the real OS filesystem (e.g. `demo://`,
 * `keep://`). The scheme is required to be at least two characters so it can
 * never collide with a Windows drive letter (`C:` is a single letter, so
 * `C://…` is never treated as virtual).
 */

// scheme: a letter followed by 1+ of [a-z0-9+.-] (so ≥2 chars total), then `://`.
const VIRTUAL_RE = /^([a-z][a-z0-9+.-]+):\/\/(.*)$/i;
const VIRTUAL_ROOT_RE = /^[a-z][a-z0-9+.-]+:\/\/$/i;

/** Parsed virtual path: its scheme (lowercased) and the remainder after `://`. */
export interface ParsedVirtualPath {
  scheme: string;
  rest: string;
}

/** Parse a virtual path, or return null when `path` is not virtual. */
export function parseVirtualPath(path: string): ParsedVirtualPath | null {
  const m = path.match(VIRTUAL_RE);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), rest: m[2] };
}

/** True when `path` is a `<scheme>://…` virtual path (scheme ≥ 2 chars). */
export function isVirtualPath(path: string): boolean {
  return VIRTUAL_RE.test(path);
}

/** True when `path` is exactly a virtual scheme root (`demo://`). */
export function isVirtualRoot(path: string): boolean {
  return VIRTUAL_ROOT_RE.test(path);
}

/** The scheme of a virtual path (lowercased), or null when not virtual. */
export function virtualScheme(path: string): string | null {
  const parsed = parseVirtualPath(path);
  return parsed ? parsed.scheme : null;
}

/**
 * Breadcrumb segments for a virtual path, following the UNC special-case
 * pattern in navigation.ts: the scheme root (`demo://`) is a single
 * breadcrumb, then one breadcrumb per remaining segment.
 *
 * `"demo://"`      → `[{ name: "demo://", path: "demo://" }]`
 * `"demo://a/b"`   → `[demo://, a → demo://a, b → demo://a/b]`
 *
 * Returns null when `path` is not a virtual path.
 */
export function virtualBreadcrumbs(
  path: string
): { name: string; path: string }[] | null {
  const parsed = parseVirtualPath(path);
  if (!parsed) return null;
  const root = `${parsed.scheme}://`;
  const result: { name: string; path: string }[] = [{ name: root, path: root }];
  let accumulated = root;
  for (const part of parsed.rest.split("/").filter(Boolean)) {
    accumulated = accumulated.endsWith("//")
      ? `${accumulated}${part}`
      : `${accumulated}/${part}`;
    result.push({ name: part, path: accumulated });
  }
  return result;
}
