/** A bounded grid for a single fan-out: one source family, with stems in empty column gutters. */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute, RowBox } from './layout';
import { ARROW, STACK_STEM_ROOM } from './metrics';
import { inReach } from './band-incremental';

/** Null means this construction does not apply or fit, not that the graph is infeasible. */
export function safeFanGrid(request: LayoutRequest): GraphLayout | null {
  const byKey = new Map(request.items.map(item => [item.key, item]));
  const cover = byKey.get(request.band?.key ?? '');
  if (!cover || byKey.size !== request.items.length) return null;
  for (const item of request.items) {
    if (![item.width, item.height].every(n => inReach(n) && n > 0)) return null;
    const parents = [...new Set(item.parents)].filter(key => byKey.has(key));
    if (item.key === cover.key ? parents.length !== 0 : parents.length !== 1 || parents[0] !== cover.key) return null;
  }
  const children = request.items.filter(item => item.key !== cover.key).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const widest = children.reduce((value, item) => Math.max(value, item.width), 1);
  const tallest = children.reduce((value, item) => Math.max(value, item.height), 1);
  const gutter = 24, columnGap = 32, rowGap = 48;
  const columns = Math.max(1, Math.min(children.length, Math.ceil(Math.sqrt(children.length * (tallest + rowGap) / (widest + columnGap)))));
  const rowCount = Math.ceil(children.length / columns), firstY = cover.height + STACK_STEM_ROOM;
  const width = Math.max(request.maxWidth, cover.width + 2 * gutter,
    2 * gutter + columns * widest + (columns - 1) * columnGap);
  const height = children.length ? firstY + rowCount * tallest + (rowCount - 1) * rowGap + gutter : cover.height;
  const coverX = request.pinned?.x ?? width / 2;
  if (![width, height, coverX].every(inReach) || coverX < cover.width / 2 || coverX + cover.width / 2 > width) return null;
  const nodes = new Map<string, PlacedNode>([[cover.key, { key: cover.key, x: coverX - cover.width / 2, y: 0,
    width: cover.width, height: cover.height, row: 0, band: 0 }]]);
  const rows: RowBox[] = [{ index: 0, band: 0, top: 0, bottom: cover.height, keys: [cover.key] }];
  const routes: PlacedRoute[] = [];
  for (let row = 0; row < rowCount; row++) {
    const top = firstY + row * (tallest + rowGap), keys: string[] = [];
    for (let column = 0; column < columns && row * columns + column < children.length; column++) {
      const item = children[row * columns + column], x = gutter + column * (widest + columnGap);
      const y = top + (tallest - item.height) / 2, center = x + item.width / 2, lane = x - 12;
      nodes.set(item.key, { key: item.key, x, y, width: item.width, height: item.height, row: row + 1, band: 1 });
      keys.push(item.key);
      // Stay in the empty row channel until directly over the destination. Every route has
      // the same real source; shared root stems therefore never imply unrelated parentage.
      const points = [[coverX, cover.height], [coverX, cover.height + 12], [lane, cover.height + 12],
        [lane, top - 16], [center, top - 16], [center, y - ARROW.length]];
      routes.push({ id: JSON.stringify(['safe-fan-grid', cover.key, item.key]), from: { kind: 'node', id: cover.key }, to: { kind: 'node', id: item.key },
        consumers: [{ parent: cover.key, child: item.key }], terminal: true,
        path: points.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join(' ') });
    }
    rows.push({ index: row + 1, band: 1, top, bottom: top + tallest, keys });
  }
  return { orientation: 'down', width, height, nodes, routes, junctions: new Map(), rows,
    readingOrder: new Map([cover, ...children].map((item, i) => [item.key, i])),
    bandBounds: { left: 0, top: firstY, width }, preferredX: 0,
    decision: { candidate: 'safe-fan-grid', stability: false, fallback: 'geometry-fallback' } };
}
