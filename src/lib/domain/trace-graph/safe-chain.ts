/** Compact chain fallback: rightward rows joined through their otherwise empty gaps. */
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedNode, PlacedRoute, RowBox } from './layout';
import { ARROW, STACK_STEM_ROOM } from './metrics';
import { inReach } from './band-incremental';

/** Null means this construction does not apply or fit; it is not a proof of infeasibility. */
export function safeChain(request: LayoutRequest): GraphLayout | null {
  const byKey = new Map(request.items.map(item => [item.key, item]));
  const cover = byKey.get(request.band?.key ?? '');
  if (!cover || byKey.size !== request.items.length) return null;
  const childOf = new Map<string, string>();
  for (const item of request.items) {
    if (![item.width, item.height].every(n => inReach(n) && n > 0)) return null;
    const parents = [...new Set(item.parents)].filter(parent => byKey.has(parent));
    if (item.key === cover.key ? parents.length !== 0 : parents.length !== 1) return null;
    if (!parents.length) continue;
    if (childOf.has(parents[0])) return null;
    childOf.set(parents[0], item.key);
  }
  const ordered: LayoutItem[] = [cover];
  const visited = new Set([cover.key]);
  while (childOf.has(ordered.at(-1)!.key)) {
    const next = childOf.get(ordered.at(-1)!.key)!;
    if (visited.has(next)) return null;
    visited.add(next); ordered.push(byKey.get(next)!);
  }
  if (ordered.length !== request.items.length) return null;

  const descendants = ordered.slice(1), gutter = 24, columnGap = 32, rowGap = 48;
  const widest = descendants.reduce((value, item) => Math.max(value, item.width), 1);
  const tallest = descendants.reduce((value, item) => Math.max(value, item.height), 1);
  const compactColumns = Math.max(1, Math.ceil(Math.sqrt(descendants.length * (tallest + rowGap) / (widest + columnGap))));
  const fittingColumns = Math.floor((request.maxWidth - 2 * gutter + columnGap) / (widest + columnGap));
  const columns = fittingColumns > 0 ? Math.min(compactColumns, fittingColumns) : compactColumns;
  const rowCount = Math.ceil(descendants.length / columns);
  const coverX = request.pinned?.x ?? Math.max(cover.width / 2, request.maxWidth / 2);
  if (!inReach(coverX) || coverX < cover.width / 2) return null;
  const width = Math.max(request.maxWidth, coverX + cover.width / 2 + gutter, descendants.length ? 2 * gutter + columns * widest + (columns - 1) * columnGap : 0);
  const firstY = cover.height + STACK_STEM_ROOM;
  const height = descendants.length ? firstY + rowCount * tallest + (rowCount - 1) * rowGap + gutter : cover.height;
  if (![width, height].every(inReach)) return null;

  const nodes = new Map<string, PlacedNode>([[cover.key, { key: cover.key, x: coverX - cover.width / 2, y: 0, width: cover.width, height: cover.height, row: 0, band: 0 }]]);
  const rows: RowBox[] = [{ index: 0, band: 0, top: 0, bottom: cover.height, keys: [cover.key] }];
  for (let row = 0; row < rowCount; row++) {
    const top = firstY + row * (tallest + rowGap), keys: string[] = [];
    for (let column = 0; column < columns && row * columns + column < descendants.length; column++) {
      const item = descendants[row * columns + column];
      nodes.set(item.key, { key: item.key, x: gutter + column * (widest + columnGap), y: top + (tallest - item.height) / 2,
        width: item.width, height: item.height, row: row + 1, band: row + 1 });
      keys.push(item.key);
    }
    rows.push({ index: row + 1, band: row + 1, top, bottom: top + tallest, keys });
  }
  const routes: PlacedRoute[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const source = nodes.get(ordered[i - 1].key)!, target = nodes.get(ordered[i].key)!;
    const targetX = target.x + target.width / 2, sourceX = source.x + source.width / 2;
    const points = source.row === target.row
      ? [[source.x + source.width, source.y + source.height / 2], [target.x - ARROW.length, target.y + target.height / 2]]
      : [[sourceX, source.y + source.height], [sourceX, source.row ? firstY + (source.row - 1) * (tallest + rowGap) + tallest + rowGap / 2 : cover.height + 12],
        [targetX, source.row ? firstY + (source.row - 1) * (tallest + rowGap) + tallest + rowGap / 2 : cover.height + 12], [targetX, target.y - ARROW.length]];
    routes.push({ id: JSON.stringify(['safe-chain', source.key, target.key]), from: { kind: 'node', id: source.key }, to: { kind: 'node', id: target.key },
      terminal: true, consumers: [{ parent: source.key, child: target.key }], path: points.map(([x, y], j) => `${j ? 'L' : 'M'}${x} ${y}`).join(' ') });
  }
  return { orientation: 'right', width, height, nodes, routes, junctions: new Map(), rows,
    readingOrder: new Map(ordered.map((item, i) => [item.key, i])),
    bandBounds: { left: 0, top: firstY, width }, preferredX: 0,
    decision: { candidate: 'safe-chain', stability: false, fallback: 'geometry-fallback' } };
}
