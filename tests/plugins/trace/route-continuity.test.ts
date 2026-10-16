import { expect, it } from 'vitest';
import { engines } from '$lib/domain/trace-graph/folder-layout';
import { buildFolderScene, diffScenes, entityId, type FolderScene, type SceneRecord, type RouteRecord, type TileRecord } from '$lib/domain/trace-graph/folder-scene';
import { samplePathString, translatePath } from '$lib/domain/trace-graph/path-sampling';
import { MOTION_MS, posePath, retargetPresentation, samplePresentation, staticPresentation } from '$lib/plugins/trace/view/presentation';
import { folderInput, handCase, makeFolder, sourcesOf } from '../../domain/trace-graph/folder-layout-fixtures';

const folder = makeFolder({ stacks: [handCase('chain-8'), handCase('chain-8')] });
const ids = [...folder.stacks.keys()], input = folderInput(folder, { open: ids, width: 2400 });
const base = buildFolderScene({ scope: { paneId: 'routes', directory: '/f', generation: 1 }, layoutInput: input,
  layout: engines.default(input), sources: sourcesOf(folder), styling: { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null } });
const head = base.tiles.get(entityId('tile', ids[0], ids[0]))!;
const tail = [...base.tiles.values()].find(t => t.graphId === ids[0] && !t.cover)!;
const obstacle = [...base.tiles.values()].find(t => t.graphId === ids[1] && !t.cover)!;
const template = [...base.routes.values()].find(r => r.graphId === ids[0])!;
const rid = entityId('route', ids[0], 'review');
const route = (path: string): RouteRecord => ({ ...template, id: rid, rect: { x: 0, y: 0, width: 1200, height: 250 },
  route: { ...template.route, id: 'review', from: { kind: 'node', id: head.tile.key }, to: { kind: 'node', id: tail.tile.key }, path } });
const tile = (record: TileRecord, x: number, y: number, width = 20, height = 20): TileRecord => ({ ...record, rect: { x, y, width, height } });
function scene(records: readonly SceneRecord[]): FolderScene {
  return { ...base, records: new Map(records.map(r => [r.id, r])), tiles: new Map(records.flatMap(r => r.kind === 'tile' ? [[r.id, r] as const] : [])),
    routes: new Map(records.flatMap(r => r.kind === 'route' ? [[r.id, r] as const] : [])) };
}
function motion(a: FolderScene, b: FolderScene) {
  return retargetPresentation(samplePresentation(staticPresentation(a), Infinity), b, diffScenes(a, b), { epoch: 2, transaction: 2 });
}

// Review certificate.ts: two clear settled layouts, with an arriving tile crossing a
// retained connector's corridor. Transient clearance must not introduce a snap.
it('a tile entering the swept corridor does not snap or fade a retained route', () => {
  const a = scene([tile(head, 0, 0), tile(tail, 0, 200), route('M10 20 L10 192')]);
  const b = scene([tile(head, 1000, 0), tile(tail, 1000, 200), tile(obstacle, 970, 80, 30, 60), route('M1010 20 L1010 192')]);
  const p = motion(a, b);
  expect(p.duration).toBe(MOTION_MS);
  for (const at of [0, 8, 16, 33, 80, 100, 159, 160]) {
    const poses = samplePresentation(p, at).poses, pose = poses.get(rid)!;
    expect(pose.opacity).toBe(1);
    const path = posePath(pose, pose.rect) ?? translatePath(b.routes.get(rid)!.route.path, { x: pose.rect.x, y: pose.rect.y })!;
    const points = samplePathString(path, 100)!;
    expect(points[0].x).toBeCloseTo(poses.get(head.id)!.rect.x + 10, 5);
    expect(points.at(-1)!.x).toBeCloseTo(poses.get(tail.id)!.rect.x + 10, 5);
  }
});

// Review endpoint-certificate.ts: a port may pass behind its opaque source while
// moving between cardinal sides; both endpoint scenes remain exact and clear.
it('a change of source port deforms continuously without a clearance fallback', () => {
  const a = scene([tile(head, 0, 0), tile(tail, 100, 100), route('M10 20 L10 50 L110 92')]);
  const b = scene([tile(head, 0, 0), tile(tail, 100, 100), route('M20 10 L50 10 L110 92')]);
  const p = motion(a, b);
  expect(p.duration).toBe(MOTION_MS);
  for (const at of [0, 8, 16, 33, 80, 159, 160]) expect(samplePresentation(p, at).poses.get(rid)!.opacity).toBe(1);
  const points = (at: number) => { const pose = samplePresentation(p, at).poses.get(rid)!; return samplePathString(posePath(pose, pose.rect)!, 100)!; };
  expect(points(0)[0]).toEqual({ x: 10, y: 20 });
  const between = points(16)[0];
  expect(between.x).toBeGreaterThan(10); expect(between.x).toBeLessThan(20);
  expect(between.y).toBeGreaterThan(10); expect(between.y).toBeLessThan(20);
  expect(points(160)[0]).toEqual({ x: 20, y: 10 });
});
