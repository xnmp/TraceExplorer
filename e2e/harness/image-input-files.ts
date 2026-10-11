/** Mock filesystem traversal: resolve each symlink before processing the next segment, including .. . */
export function canonicalFixtureImagePath(path: string, symlinks: ReadonlyMap<string, string>): string | null {
  if (!path.startsWith("/")) return null; // This fixture's filesystem is POSIX.
  const pending = path.split("/");
  const resolved: string[] = [];
  let followed = 0;
  while (pending.length) {
    const segment = pending.shift()!;
    if (!segment || segment === ".") continue;
    if (segment === "..") { resolved.pop(); continue; }
    resolved.push(segment);
    const target = symlinks.get(`/${resolved.join("/")}`);
    if (target === undefined) continue;
    if (++followed > 40) return null;
    resolved.pop();
    if (target.startsWith("/")) resolved.length = 0;
    pending.unshift(...target.split("/"));
  }
  return `/${resolved.join("/")}`;
}
