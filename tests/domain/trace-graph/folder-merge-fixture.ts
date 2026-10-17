/** The two-chains browser flow, using the harness's native-index mirror and
 * the view's real input adapter. No DOM, RPC or component-id retention. */
import fixtures from '../../fixtures/folder-grouping.json';
import { folderComponents, isDirectFolderSeed, type FolderNode } from '../../../e2e/harness/folder-snapshot';
import { projectDag } from '../../../src/lib/domain/trace-graph/projection';
import { NO_EXPANSION, openStack, expandNode, type Expansion } from '../../../src/lib/domain/trace-graph/expansion';
import { fallbackGridMetrics } from '../../../src/lib/domain/trace-graph/folder-grid';
import { tileMetrics } from '../../../src/lib/domain/trace-graph/metrics';
import { openStackOf, prepareLayoutInput, type SceneData, type SceneIntent } from '../../../src/lib/plugins/trace/view/scene-inputs';
import type { FolderLayout } from '../../../src/lib/domain/trace-graph/folder-layout';
import { entry } from './folder-layout-fixtures';

export function twoChainsMerge(withArrivalAndRevisits = false) {
  const nodes = fixtures.find(f => f.name === 'two-chains')!.nodes as FolderNode[];
  // view-fixture.ts::joinGeneration advances the maximum artifact/run id (11).
  const joined: FolderNode = { key: 'o:12:0', artifactId: null, runId: 12, parents: ['o:10:0', 'o:11:0'],
    path: null, scope: 'current', location: 'Generating', state: 'running', temporary: true,
    contextDirectory: '/pictures', discarded: false, earlierRevision: false, order: 1_000_000_000_012, prompt: 'joined prompt' };
  const arrived: FolderNode = {...joined,key:'o:13:0',runId:13,parents:['o:11:0'],order:1_000_000_000_013,prompt:'arrival prompt'};
  const snapshot = (merged: boolean, arrival = false): SceneData => {
    const components = folderComponents(merged ? [...nodes, joined,...(arrival?[arrived]:[])] : nodes);
    const token = arrival ? 'arrival' : merged ? 'after' : 'before';
    return { index: { directory: '/pictures', token, components: components.map(c => c.summary),
      members: new Map(components.flatMap(c => c.nodes.filter(isDirectFolderSeed).map(n =>
        [n.path!, { componentId: c.id, key: n.key }] as const))) },
      components: new Map(components.map(c => [c.id, { directory: '/pictures', token, version: merged ? 2 : 1,
        nodes: c.nodes, dag: projectDag(c.nodes), members: c.members }])) };
  };
  const before = snapshot(false), after = snapshot(true), afterArrival = snapshot(true,true), tile = tileMetrics();
  const listing = [...nodes.filter(isDirectFolderSeed).map(n => entry(n.path!)),
    entry('/pictures/notes.txt'), entry('/pictures/plain.png'), entry('/pictures/refs', 'directory')]
    .map(e => ({ ...e, size: 32, modified: '2026-10-05T00:00:00Z' }));
  const intent = (expansion: Expansion, open: readonly string[]): SceneIntent => ({
    directory: '/pictures', listing, claimed: new Set(),
    open: new Set(open), focus: null, expansion, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null,
    // A 900px harness pane: border/scrollbar, 20px chrome, then 16px quantization.
    width: 864, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: '',
  });
  const prepare = (data: SceneData, expansion: Expansion, open: readonly string[], previous: FolderLayout | null) => {
    const covers = new Map(data.index.components.filter(c => open.includes(c.coverKey)).map(c => [c.coverKey, c.id]));
    return prepareLayoutInput(intent(expansion, open), data, covers, null, previous);
  };
  const openedA = openStack(NO_EXPANSION, 'a:2'), openedBoth = openStack(openedA, 'a:4');
  const stack = openStackOf('a:4', before.components.get('c:a:4')!, openedBoth);
  const clicked = expandNode(openedBoth, { graph: stack.graph, members: stack.members, cover: stack.id }, 'o:11:0');
  return {
    joined: joined.key, arrived: arrived.key,
    steps: [
      (previous: FolderLayout | null) => prepare(before, NO_EXPANSION, [], previous),
      (previous: FolderLayout | null) => prepare(before, openedA, ['a:2'], previous),
      (previous: FolderLayout | null) => prepare(before, openedBoth, ['a:2', 'a:4'], previous),
      (previous: FolderLayout | null) => prepare(before, clicked, ['a:2', 'a:4'], previous),
      (previous: FolderLayout | null) => prepare(after, clicked, ['a:2'], previous),
      ...(withArrivalAndRevisits ? [
        (previous: FolderLayout | null) => prepare(after, clicked, [], previous),
        (previous: FolderLayout | null) => prepare(after, clicked, ['a:2'], previous),
        (previous: FolderLayout | null) => prepare(afterArrival, clicked, ['a:2'], previous),
        (previous: FolderLayout | null) => prepare(afterArrival, clicked, [], previous),
        (previous: FolderLayout | null) => prepare(afterArrival, clicked, ['a:2'], previous),
      ] : []),
    ],
  };
}
