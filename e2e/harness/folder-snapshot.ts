import type { ComponentSummary, TraceNode } from "$lib/domain/trace-graph/model";
import { basename, nativeDirectoryKey, parentDir } from "$lib/domain/path";

/** A run's output-folder context is independent of its managed storage path.
 * Native only seeds unsaved outputs belonging to the queried folder.
 */
export interface FolderNode extends TraceNode { readonly contextDirectory?: string }
const belongsToFolder = (node: FolderNode, directory: string): boolean =>
  node.contextDirectory !== undefined ? node.contextDirectory === directory : node.scope === "current";
const storedScope = (path: string, directory: string): TraceNode["scope"] => {
  const folder = nativeDirectoryKey(directory);
  if (nativeDirectoryKey(parentDir(path)) === folder) return "current";
  return nativeDirectoryKey(path).startsWith(folder.endsWith("/") ? folder : `${folder}/`) ? "subfolder" : "external";
};

const isPresentRevision = (node: TraceNode): boolean => node.artifactId !== null
  && node.state === "present" && !node.discarded && !node.earlierRevision;

/** Only direct seeds are folder members; historical parents stay unlisted. */
export const isDirectFolderSeed = (node: TraceNode): boolean => isPresentRevision(node)
  && node.scope === "current" && !node.temporary && !!node.path;

/** Mirrors native load_snapshot/resolve_facts: current files and unsaved
 * outputs seed the graph only while present, newest and non-discarded.
 * Active placeholders also seed it. Other artifacts appear only as direct
 * parents of a seed, including unavailable and superseded revisions.
 */
export function displayedNodes(nodes: readonly FolderNode[], dismissedRuns: ReadonlySet<number>, directory = "/pictures"): FolderNode[] {
  const seeds = nodes.filter((node) => node.artifactId === null
    ? belongsToFolder(node, directory) && (node.state === "running" || (node.state === "uncertain" && !dismissedRuns.has(node.runId!)))
    : (isDirectFolderSeed(node) || (node.temporary && belongsToFolder(node, directory))) && isPresentRevision(node));
  const displayed = new Set(seeds.flatMap((node) => [node.key, ...node.parents]));
  return nodes.filter((node) => displayed.has(node.key));
}

/** Mirrors folder_graph.rs::has_relationship, including lone generated images. */
const hasRelationship = (nodes: readonly TraceNode[]): boolean => {
  if (nodes.length !== 1) return true;
  const [node] = nodes;
  return !(node.scope === "current" && node.artifactId !== null && node.runId === null && !node.temporary
    && node.state !== "running" && node.state !== "uncertain" && node.parents.length === 0);
};
/** Rust String::cmp orders valid Unicode paths by UTF-8 bytes, which is scalar
 * order, rather than locale collation (or UTF-16 surrogate order). */
export function nativeStringOrder(a: string, b: string): number {
  for (let left = 0, right = 0; left < a.length && right < b.length;) {
    const x = a.codePointAt(left)!, y = b.codePointAt(right)!;
    if (x !== y) return x - y;
    left += x > 0xffff ? 2 : 1; right += y > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
const byOrder = (a: TraceNode, b: TraceNode): number => a.order - b.order || nativeStringOrder(a.key, b.key);
// Native NodeIdentity sorts numerically, with sources before outputs; creation
// order alone (or lexicographic keys such as o:10 vs o:9) is not component identity.
const identity = (node: TraceNode): readonly number[] => node.runId === null
  ? [0, node.artifactId!, 0] : [1, node.runId, Number(node.key.split(":")[2])];
const byIdentity = (a: TraceNode, b: TraceNode): number => {
  const left = identity(a), right = identity(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

export interface MockComponent {
  readonly id: string;
  readonly members: readonly string[];
  readonly nodes: readonly TraceNode[];
  readonly summary: ComponentSummary;
}

/** Pure mirror of native build_index, shared by the RPC fixture and the Rust
 * golden parity test. Use displayed parents before any DAG cycle sanitizing:
 * an outside image is a badge only when no parent exists in this folder graph.
 */
export function folderComponents(input: readonly FolderNode[], dismissedRuns: ReadonlySet<number> = new Set(), directory = "/pictures"): MockComponent[] {
  const displayed = displayedNodes(input, dismissedRuns, directory);
  const known = new Set(displayed.map((node) => node.key));
  const nodes = displayed.map((node): TraceNode => {
    const { referenceBadge: _badge, contextDirectory: _context, ...rest } = node;
    const scope = node.temporary && node.path
      ? belongsToFolder(node, directory) && isPresentRevision(node) ? "current" : storedScope(node.path, directory)
      : node.scope;
    return { ...rest, scope,
      parents: [...new Set(node.parents.filter((key) => known.has(key)))] };
  });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const badges = new Set(nodes.filter((node) => node.scope !== "current" && node.parents.length === 0).map((node) => node.key));
  const roots = new Map(nodes.map((node) => [node.key, node.key]));
  const find = (key: string): string => {
    while (roots.get(key) !== key) { roots.set(key, roots.get(roots.get(key)!)!); key = roots.get(key)!; }
    return key;
  };
  for (const node of nodes) for (const parent of node.parents) if (!badges.has(parent)) roots.set(find(node.key), find(parent));
  const groups = new Map<string, TraceNode[]>();
  for (const node of nodes) if (!badges.has(node.key)) {
    const root = find(node.key), group = groups.get(root);
    if (group) group.push(node); else groups.set(root, [node]);
  }
  const references = new Map<string, Map<string, string[]>>();
  for (const node of nodes) for (const parent of node.parents) if (badges.has(parent)) {
    const root = find(node.key);
    let attached = references.get(root);
    if (!attached) { attached = new Map(); references.set(root, attached); }
    const consumers = attached.get(parent);
    if (consumers) consumers.push(node.key); else attached.set(parent, [node.key]);
  }
  /** The cover as a tile is a drawn root (never a reference badge): the title's rule over drawn members. */
  const drawnCover = (members: readonly TraceNode[]) => {
    const sorted = [...members].sort(byOrder);
    return sorted.find((node) => node.path && node.scope === "current" && !node.parents.some((key) => byKey.get(key)!.scope === "current"))
      ?? sorted.find((node) => node.path) ?? sorted[0];
  };
  return [...groups].map(([root, members]) => {
    const oldest = [...members].sort(byIdentity)[0];
    const id = `c:${oldest.key}`;
    const newest = members.reduce((order, node) => Math.max(order, node.order), -Infinity);
    const attached = [...(references.get(root) ?? [])].map(([key, consumers]): TraceNode => {
      const node = byKey.get(key)!;
      return { ...node, referenceBadge: { key, path: node.path!, scope: node.scope as "subfolder" | "external", artifactId: node.artifactId!,
        consumers: consumers.sort((a, b) => byOrder(byKey.get(a)!, byKey.get(b)!)) } };
    });
    const all = [...members, ...attached].sort(byOrder);
    const cover = all.find((node) => node.path && node.scope === "current" && !node.parents.some((key) => byKey.get(key)!.scope === "current"))
      ?? all.find((node) => node.path);
    const filename = cover?.path ? basename(cover.path) : "Generating";
    const extension = filename.lastIndexOf(".");
    return { id, members: all.map((node) => node.key), nodes: all, newest, summary: {
      id, title: extension > 0 ? filename.slice(0, extension) : filename,
      cover: cover?.path ? { path: cover.path, present: cover.state === "present" } : null,
      coverKey: drawnCover(members).key,
      imageCount: all.filter((node) => node.scope === "current" && node.state === "present" && !node.earlierRevision).length,
      nodeCount: all.length, active: all.some((node) => node.state === "running" || node.state === "uncertain"),
      unsaved: all.some((node) => node.temporary),
    } };
  }).filter((component) => hasRelationship(component.nodes))
    .sort((a, b) => b.newest - a.newest || nativeStringOrder(a.id, b.id));
}

/** Native page limits and byte budget. A reference copy counts once in its
 * component's node pages, and never appears in direct-folder member pages. */
export function folderPage<T>(items: readonly T[], offset: number, limit: number): T[] {
  const result: T[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    bytes += new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (result.length && bytes > 512 * 1024) break;
    result.push(item);
  }
  return result;
}
