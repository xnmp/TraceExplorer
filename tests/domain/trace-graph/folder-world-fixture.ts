import { folderInput, makeFolder, corpusNode as node, type Folder } from './folder-layout-fixtures';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout';

/** A small pinned-arrival sequence with the same world/raw frame transition as the save trace. */
export function worldFolder(grown = true): Folder {
  return makeFolder({ stacks: [
    [node('root'), node('a', ['root'], 1), node('b', ['root'], 2), ...(grown ? [node('c', ['a', 'b'], 3)] : [])],
    [node('root'), node('child', ['root'], 1)],
  ], files: 1 });
}

export function worldInput(grown = true, previous?: FolderLayout, contents = '', width = 360) {
  const folder = worldFolder(grown);
  const input = folderInput(folder, { open: folder.stacks.keys(), width, tile: tileMetrics(64), previous });
  return { ...input, contents, open: new Map([...input.open].map(([id, stack]) =>
    [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
}
