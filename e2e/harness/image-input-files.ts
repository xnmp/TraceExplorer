type EntryKind = "file" | "directory";

/** Known entries imply their parent directories, but never a symlink's target. */
export function fixtureImageEntries(known: Iterable<readonly [string, EntryKind]>): ReadonlyMap<string, EntryKind> {
  const entries = new Map(known);
  entries.set("/", "directory");
  for (const path of [...entries.keys()]) {
    for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
      const parent = path.slice(0, end);
      if (!entries.has(parent)) entries.set(parent, "directory");
    }
  }
  return entries;
}

/** POSIX traversal and Linux AppError text, matching the harness's native backend. */
export function canonicalFixtureImagePath(path: string, symlinks: ReadonlyMap<string, string>, entries: ReadonlyMap<string, EntryKind>): string {
  if (!path.startsWith("/")) throw new Error("Input image path must be absolute");
  const pending = path.split("/");
  const resolved: string[] = [];
  let followed = 0;
  while (pending.length) {
    // Even . / .. / a trailing slash require the preceding entry to be a directory.
    if (resolved.length && entries.get(`/${resolved.join("/")}`) !== "directory") {
      throw new Error("IO error: Not a directory (os error 20)");
    }
    const segment = pending.shift()!;
    if (!segment || segment === ".") continue;
    if (segment === "..") { resolved.pop(); continue; }
    resolved.push(segment);
    const target = symlinks.get(`/${resolved.join("/")}`);
    if (target === undefined) {
      if (!entries.has(`/${resolved.join("/")}`)) throw new Error("Path not found: No such file or directory (os error 2)");
      continue;
    }
    if (++followed > 40) throw new Error("IO error: Too many levels of symbolic links (os error 40)");
    resolved.pop();
    if (target.startsWith("/")) resolved.length = 0;
    pending.unshift(...target.split("/"));
  }
  return `/${resolved.join("/")}`;
}
