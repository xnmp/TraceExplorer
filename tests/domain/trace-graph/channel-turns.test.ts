import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { attachSingleBand, withBandBounds } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('keeps normal channel turns clear of adjacent passing lanes', () => {
  const fixture = corpus().find(c => c.id === 'random-tree-40-7401')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 454, 48);
  const raw = withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key);
  const placed = attachSingleBand(raw, request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('keeps junction inputs separate before their final convergence', () => {
  const fixture = corpus().find(c => c.id === 'overlapping-merges')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 360, 48);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('reserves the full port berth when a horizontal turn ends beside a foreign port', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-40-7502')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 900, 48);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it.each([
  ['random-tree-100-8001', 640, 96],
  ['random-chainy-100-8301', 1400, 128],
] as const)('reserves clearance through narrow swaps and doglegs: %s', (id, width, image) => {
  const fixture = corpus().find(c => c.id === id)!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, width, image);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it.each([
  ['random-dag-40-7503', 900, 64],
  ['random-dag-100-8103', 454, 48],
  ['random-dag-100-8102', 1400, 96],
  ['random-dag-200-9103', 900, 128],
] as const)('reserves every fan approach and rejects near-lane zone choices: %s', (id, width, image) => {
  const fixture = corpus().find(c => c.id === id)!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, width, image);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('finds a free swap detour beyond the local lane cluster within the pane', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-200-9102')!;
  const request = requestFor(fixture, null, 1400, 128);
  const placed = attachSingleBand(withBandBounds(layoutLayered({...request,band:undefined}),request.band!.key),request);
  expect(geometryGate(placed,request.items,request.band!.key,request.maxWidth)).toBeNull();
});

import { channelInk, channelCornerRadius, roundChannelPath } from '$lib/domain/trace-graph/channel-corners';
import { segments } from '$lib/domain/trace-graph/layout-quality';
import { distanceToTile } from '$lib/domain/trace-graph/route-contacts';

it('draws ordinary band turns as bounded quarter fillets accepted by the independent gate', () => {
  const items = ['root', 'a', 'b'].map((key, order) => ({ key, order, parents: order ? ['root'] : [], width: 92, height: 100 }));
  const placed = layoutLayered({ items, maxWidth: 454 });
  const curves = placed.routes.flatMap(route => channelInk(route.path)).filter(ink => ink.length === 4);
  expect(curves.length).toBeGreaterThan(0);
  for (const curve of curves) {
    const width = Math.abs(curve.at(-1)!.x - curve[0].x), height = Math.abs(curve.at(-1)!.y - curve[0].y);
    expect(width).toBe(height);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(6);
    for (const point of curve) {
      expect(point.x).toBeGreaterThanOrEqual(Math.min(curve[0].x, curve.at(-1)!.x));
      expect(point.x).toBeLessThanOrEqual(Math.max(curve[0].x, curve.at(-1)!.x));
      expect(point.y).toBeGreaterThanOrEqual(Math.min(curve[0].y, curve.at(-1)!.y));
      expect(point.y).toBeLessThanOrEqual(Math.max(curve[0].y, curve.at(-1)!.y));
    }
  }
  expect(geometryGate(placed, items, 'root', 454)).toBeNull();
});

it('fits each fillet inside its track and lane, capped at the cover attachment radius', () => {
  const a = { x: 0, y: 0 }, corner = { x: 0, y: 20 }, b = { x: 20, y: 20 };
  expect(channelCornerRadius(a, corner, b, [], 20)).toBe(6);
  expect(channelCornerRadius(a, corner, b, [], 2)).toBe(2);
  expect(channelCornerRadius(a, corner, b, [], 0)).toBe(0);
  const path = roundChannelPath('M0 0 L0 20 L20 20 L20 40', [], () => 2);
  expect(path.match(/C/g)).toHaveLength(2);
  for (const [p, q] of segments(path)) for (const point of [p, q]) {
    expect(point.x >= 0 && point.x <= 20 && point.y >= 0 && point.y <= 40).toBe(true);
    // A curve can only occupy the two reserved 2px corner squares.
    if (point.x !== 0 && point.x !== 20 && point.y !== 20)
      expect((point.x <= 2 && point.y >= 18 && point.y <= 20) || (point.x >= 18 && point.y >= 20 && point.y <= 22)).toBe(true);
  }
});

it('preserves foreign ink clearance and keeps a turn sharp when its lane has no spare room', () => {
  const before = { x: 0, y: 0 }, corner = { x: 0, y: 20 }, after = { x: 20, y: 20 };
  const limited = [[{ x: 3, y: 0 }, { x: 3, y: 17 }]] as const;
  expect(channelCornerRadius(before, corner, after, limited, 6)).toBeCloseTo(3, 5);
  const foreign = [[{ x: 3, y: 0 }, { x: 3, y: 20 }]] as const;
  expect(channelCornerRadius(before, corner, after, foreign, 6)).toBe(0);
  const path = roundChannelPath('M0 0 L0 20 L20 20', foreign, () => 6);
  expect(path).not.toContain('C');
  expect(segments(path)).toEqual(segments('M0 0 L0 20 L20 20'));
  const curved = roundChannelPath('M0 0 L0 20 L20 20', limited, () => 6);
  for (const [p, q] of segments(curved)) for (const point of [p, q])
    expect(distanceToTile(limited[0], { ...point, width: 0, height: 0 })).toBeGreaterThanOrEqual(3 - 1e-6);
});

it('certifies a constrained fillet against the actual foreign cubic', () => {
  const foreign = channelInk('M4 0 C4 6 3 11 3 17');
  expect(foreign).toEqual([[{ x: 4, y: 0 }, { x: 4, y: 6 }, { x: 3, y: 11 }, { x: 3, y: 17 }]]);
  expect(channelCornerRadius({ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 20, y: 20 }, foreign, 6)).toBeCloseTo(3, 5);
  expect(roundChannelPath('M0 0 L0 20 L20 20', foreign, () => 6)).toContain('C');
});

import { mixRouteShape, pathTranslation, routeShape, routeShapePath, translatePath } from '$lib/domain/trace-graph/path-sampling';
it('keeps fillets as ordinary cubic shapes throughout a hint-height glide', () => {
  const path = roundChannelPath('M0 0 L0 20 L20 20 L20 40', [], () => 6);
  const start = routeShape(path, { x: 0, y: 0 })!;
  const end = routeShape(translatePath(path, { x: 0, y: 16 })!, { x: 0, y: 0 })!;
  expect(start).not.toBeNull();
  const before = routeShapePath(start, { x: 0, y: 0 });
  for (const progress of [0, .25, .5, .75, 1]) {
    const moving = routeShapePath(mixRouteShape(start, end, progress), { x: 0, y: 0 });
    expect(pathTranslation(before, moving)).toEqual({ x: 0, y: 16 * progress });
  }
});
