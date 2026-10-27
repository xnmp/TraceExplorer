/**
 * Maps the folder's Trace index onto the host's `EntryLineage`: for each file
 * in the folder, the files (or outside artifacts) it was made from.
 *
 * Pure: no IO, no Svelte. Inputs are the folder's members (path → node key) and
 * the nodes of their components (key → parents). Rules:
 * - a parent that has a file in the folder becomes an `entry` parent;
 * - a parent with no file there (deleted, moved, or a running-output
 *   placeholder) is replaced by its own parents, recursively, so the host only
 *   sees present ancestors;
 * - a parent in a subfolder or outside the folder becomes an `external` parent
 *   and is not looked through;
 * - input order is kept and duplicates are removed.
 * Malformed input (unknown keys, cycles, missing paths) is skipped, never thrown.
 */
import type { EntryLineage, LineageParent } from "../../../integration/plugin-sdk";
import { basename } from "./path";

export interface LineageMember {
  readonly path: string;
  readonly key: string;
}

export interface LineageNode {
  readonly key: string;
  readonly artifactId?: number | null;
  /** Keys of the nodes this one was made from, in input order. */
  readonly parents?: readonly string[];
  readonly path?: string | null;
  readonly scope?: "current" | "subfolder" | "external";
  readonly state?: string;
  /** Superseded by a later in-place edit at the same path; only the newest revision is a folder member. */
  readonly earlierRevision?: boolean;
  readonly referenceBadge?: { readonly path: string } | null;
}

const parentKeys = (node: LineageNode): readonly unknown[] => Array.isArray(node.parents) ? node.parents : [];

export function buildEntryLineage(memberList: readonly LineageMember[], nodeList: readonly LineageNode[]): EntryLineage {
  const members = Array.isArray(memberList) ? memberList : [];
  const nodes = Array.isArray(nodeList) ? nodeList : [];
  const nodeByKey = new Map<string, LineageNode>();
  for (const node of nodes) if (node && typeof node.key === "string" && !nodeByKey.has(node.key)) nodeByKey.set(node.key, node);
  const pathByKey = new Map<string, string>();
  const valid = members.filter((member) => member && typeof member.path === "string" && member.path !== "" && typeof member.key === "string");
  for (const member of valid) if (!pathByKey.has(member.key)) pathByKey.set(member.key, member.path);

  const memberPaths = new Set(pathByKey.values());
  // Present ancestors of a key. Iterative post-order walk: a chain of thousands of deleted
  // intermediates must not overflow the stack, and the memo keeps shared ancestry linear. A node met
  // again while it is still being resolved (a cycle) contributes nothing.
  const memo = new Map<string, readonly LineageParent[]>();
  const leaf = (key: string): readonly LineageParent[] | null => {
    const file = pathByKey.get(key);
    if (file !== undefined) return [{ kind: "entry", path: file }];
    const node = nodeByKey.get(key);
    if (!node) return [];
    // An earlier revision of a file edited in place is not a member; its path holds the newest revision.
    if (node.earlierRevision && typeof node.path === "string" && memberPaths.has(node.path)) return [{ kind: "entry", path: node.path }];
    if (node.scope !== undefined && node.scope !== "current") { const external = externalParent(node); return external ? [external] : []; }
    return null;
  };
  const resolve = (root: string): readonly LineageParent[] => {
    const direct = leaf(root);
    if (direct) return direct;
    const stack: Array<{ key: string; next: number }> = [{ key: root, next: 0 }];
    const active = new Set<string>([root]);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const keys = parentKeys(nodeByKey.get(frame.key)!);
      let descended = false;
      while (frame.next < keys.length) {
        const child = keys[frame.next++];
        if (typeof child !== "string" || memo.has(child) || active.has(child)) continue;
        const known = leaf(child);
        if (known) { memo.set(child, known); continue; }
        stack.push({ key: child, next: 0 }); active.add(child); descended = true; break;
      }
      if (descended) continue;
      memo.set(frame.key, distinct(keys.flatMap((child) => typeof child === "string" ? memo.get(child) ?? [] : [])));
      active.delete(frame.key);
      stack.pop();
    }
    return memo.get(root) ?? [];
  };

  const parents = new Map<string, readonly LineageParent[]>();
  for (const member of valid) {
    if (parents.has(member.path)) continue;
    const node = nodeByKey.get(member.key);
    if (!node) continue;
    const list = distinct(parentKeys(node).flatMap((parent) => typeof parent === "string" && parent !== member.key ? resolve(parent) : []))
      .filter((parent) => !(parent.kind === "entry" && parent.path === member.path));
    if (list.length) parents.set(member.path, list);
  }
  return { revision: revisionOf(parents), parents };
}

function externalParent(node: LineageNode): LineageParent | null {
  const path = node.referenceBadge?.path ?? node.path ?? null;
  const key = typeof node.artifactId === "number" ? `artifact:${node.artifactId}` : node.key;
  if (!path) return key ? { kind: "external", key, label: key } : null;
  const label = basename(path) || path;
  return node.state === undefined || node.state === "present"
    ? { kind: "external", key, label, thumbnailPath: path }
    : { kind: "external", key, label };
}

const identity = (parent: LineageParent) => parent.kind === "entry" ? `e\0${parent.path}` : `x\0${parent.key}`;

function distinct(list: readonly LineageParent[]): LineageParent[] {
  const seen = new Set<string>();
  return list.filter((parent) => { const id = identity(parent); return seen.has(id) ? false : (seen.add(id), true); });
}

/** Content hash of the lineage in a canonical order, so equal lineage has equal revision. */
function revisionOf(parents: ReadonlyMap<string, readonly LineageParent[]>): string {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 2654435761);
      b = Math.imul(b ^ code, 1597334677);
    }
  };
  for (const path of [...parents.keys()].sort()) {
    feed(`\u0001${path}`);
    for (const parent of parents.get(path)!) {
      feed(parent.kind === "entry" ? `\u0002${parent.path}` : `\u0003${parent.key}\u0004${parent.label}\u0004${parent.thumbnailPath ?? ""}`);
    }
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${parents.size}.${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
