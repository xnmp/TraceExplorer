/** Folders for the folder layout contract, parity and scene tests: a host listing, an index and complete components. */
import type { FileEntry } from "$lib/domain/file";
import type { ComponentSummary, NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
import type { FolderIndex, Member } from "$lib/domain/trace-graph/folder-data";
import { projectDag, projectReferenceBadges, type BadgeProjection } from "$lib/domain/trace-graph/projection";
import { folderCells, type FolderCell } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics, type TileMetrics } from "$lib/domain/trace-graph/metrics";
import type { FolderGridMetrics, FolderLayout, FolderLayoutInput, OpenStack } from "$lib/domain/trace-graph/folder-layout";
import { corpus, focusExpansion, handCases, rng, node as corpusNode } from "../../../layout-eval/corpus";
import { expandedKeys, expansionAnchor, type Expansion } from "$lib/domain/trace-graph/expansion";

export interface FolderStack {
  readonly componentId: string;
  readonly cover: NodeKey;
  readonly nodes: readonly TraceNode[];
  readonly graph: BadgeProjection;
}
export interface Folder {
  readonly entries: readonly FileEntry[];
  readonly index: FolderIndex;
  readonly stacks: ReadonlyMap<NodeKey, FolderStack>;
}

export const entry = (path: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, size: 1, modified: "2026-10-14T00:00:00Z" });

const prefixed = (nodes: readonly TraceNode[], prefix: string): TraceNode[] =>
  nodes.map((n) => ({ ...n, key: `${prefix}${n.key}`, parents: n.parents.map((p) => `${prefix}${p}`), path: n.path ? `/f/${prefix}${n.path}` : null }));

/**
 * A folder of stacks (each given as its nodes, keys made unique per stack), ordinary files and
 * folders, listed in an order shuffled by `seed` (unshuffled without one). `unsaved` stacks have
 * no listed cover, so they follow the listing.
 */
export function makeFolder(spec: { readonly stacks: readonly (readonly TraceNode[])[]; readonly files?: number; readonly directories?: number; readonly seed?: number; readonly unsaved?: readonly number[] }): Folder {
  const stacks = new Map<NodeKey, FolderStack>();
  const summaries: ComponentSummary[] = [], members = new Map<string, Member>(), listed: FileEntry[] = [];
  spec.stacks.forEach((source, i) => {
    const nodes = prefixed(source, `s${i}:`), graph = projectReferenceBadges(projectDag(nodes));
    const cover = graph.dag.order[0];
    if (cover === undefined) return;
    const componentId = `c:${cover}`, path = `/f/s${i}-cover.png`, unsaved = spec.unsaved?.includes(i) ?? false;
    stacks.set(cover, { componentId, cover, nodes, graph });
    summaries.push({ id: componentId, title: `Stack ${i}`, cover: unsaved ? null : { path, present: true }, coverKey: cover, imageCount: nodes.length, nodeCount: nodes.length, active: false, unsaved });
    if (!unsaved) { members.set(path, { componentId, key: cover }); listed.push(entry(path)); }
  });
  for (let j = 0; j < (spec.files ?? 0); j++) listed.push(entry(`/f/file-${j}.png`));
  for (let j = 0; j < (spec.directories ?? 0); j++) listed.push(entry(`/f/dir-${j}`, "directory"));
  if (spec.seed !== undefined) {
    const random = rng(spec.seed);
    for (let i = listed.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [listed[i], listed[j]] = [listed[j], listed[i]]; }
  }
  return { entries: listed, index: { directory: "/f", token: "t1", components: summaries, members }, stacks };
}

export const cellsOf = (folder: Folder): FolderCell[] => folderCells(folder.entries, folder.index);

/** Whether `focus` belongs to the stack, as a member or a reference badge's key. */
export const belongs = (stack: FolderStack, focus: NodeKey | null): boolean =>
  focus !== null && (stack.graph.dag.nodes.has(focus) || stack.graph.badges.has(focus));

export interface InputOptions {
  readonly open?: Iterable<string>;
  readonly focus?: NodeKey | null;
  /** The pane's expansion; by default the focus's (`focusExpansion`). */
  readonly expansion?: Expansion;
  readonly width?: number;
  readonly tile?: TileMetrics;
  readonly grid?: FolderGridMetrics;
  readonly previous?: FolderLayout | null;
  readonly items?: readonly FolderCell[];
}

export function folderInput(folder: Folder, options: InputOptions = {}): FolderLayoutInput {
  const tile = options.tile ?? tileMetrics();
  const open = new Map<string, OpenStack>();
  for (const id of options.open ?? []) {
    const stack = folder.stacks.get(id);
    if (!stack) continue;
    const focus = options.focus ?? null, mine = belongs(stack, focus) ? focus : null;
    // A focus stands for a user who revealed and expanded it (`focusExpansion`), unless expansion is given.
    const expansion = options.expansion ?? focusExpansion(mine);
    const scope = { graph: stack.graph, members: stack.graph.dag.order, cover: id };
    open.set(id, { id, graph: stack.graph, members: stack.graph.dag.order, anchor: expansionAnchor(expansion, scope), expanded: expandedKeys(expansion, scope) });
  }
  return { items: options.items ?? cellsOf(folder), open, width: options.width ?? 900, tile,
    grid: options.grid ?? { cellWidth: tile.width, cellHeight: 0, gap: 8 }, previous: options.previous ?? null };
}

/** Moderate corpus cases (the largest ones only slow the suite down). */
export const smallCorpus = (): readonly (readonly TraceNode[])[] =>
  corpus().filter((c) => c.nodes.length > 0 && c.nodes.length <= 40).map((c) => c.nodes);

export const handCase = (id: string): readonly TraceNode[] => handCases.find((c) => c.id === id)!.nodes;

/** A seeded random folder from the corpus: 1-5 stacks, files and folders, some stacks open, maybe a focus. */
export function randomFolder(seed: number): { folder: Folder; options: InputOptions } {
  const random = rng(seed), pool = smallCorpus();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const stacks = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(pool));
  const folder = makeFolder({ stacks, files: Math.floor(random() * 10), directories: Math.floor(random() * 3), seed, unsaved: random() < .3 ? [0] : [] });
  const ids = [...folder.stacks.keys()];
  const open = ids.filter(() => random() < .7);
  const focusStack = open.length && random() < .7 ? folder.stacks.get(pick(open))! : null;
  const focus = focusStack ? pick(focusStack.graph.dag.order) : null;
  const imagePx = pick([48, 64, 96, 128]);
  const tile = tileMetrics(imagePx);
  const grid = random() < .5 ? { cellWidth: tile.width + 12, cellHeight: tile.width + 40, gap: 12 } : { cellWidth: tile.width, cellHeight: 0, gap: 8 };
  return { folder, options: { open, focus, width: pick([360, 454, 640, 900, 1400]), tile, grid } };
}

export { corpusNode };

/** Data provenance per stack: one revision, the stack's projection standing for its DAG's identity. */
export const sourcesOf = (folder: Folder) => new Map([...folder.stacks].map(([id, stack]) => [id, { componentId: stack.componentId, revision: 1, data: stack.graph }]));
