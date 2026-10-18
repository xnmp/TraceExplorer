import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDefaultEngine, type FolderLayout, type FolderLayoutInput } from '$lib/domain/trace-graph/folder-layout';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { worldInput } from './folder-world-fixture';

const recorded = (): FolderLayoutInput => JSON.parse(readFileSync(new URL('./fixtures/world-placement-refresh.json', import.meta.url), 'utf8'),
  (_, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value);
const drawing = (layout: FolderLayout) => [layout.columns, layout.size, layout.bounds, layout.cells, layout.bands, layout.rowBands,
  [...layout.graphs].map(([id, graph]) => [id, graph.attached, graph.origin, graph.placement])];

describe('world-placed folder history', () => {
  it('keeps entry 17 in its certified folder frame when listing metadata changes', () => {
    // Minimized from s3-entry17.json: only forest remains open; unrelated data and ledgers removed.
    const input = recorded(), before = structuredClone(input);
    const result = createDefaultEngine()(input);
    expect(folderGeometryGate(result)).toBeNull();
    expect(result.columns).toBe(8);
    expect(result.size).toEqual({ width: 864, height: 852 });
    expect(result.cells.get('a:5')!.x).toBe(109);
    expect(result.graphs.get('a:5')!.attached.nodes.get('a:5')!.x).toBe(113.5);
    expect(drawing(result)).toEqual(drawing(input.previous!));
    expect(result.decision?.fallback).toBeUndefined();
    expect(input).toEqual(before);
  });

  it.each([200, 360, 864])('retains world coordinates through metadata changes and closing another band at width %s', width => {
    const engine = createDefaultEngine(), initial = engine(worldInput(false, undefined, '', width));
    const arrived = engine(worldInput(true, initial, '', width));
    expect([...arrived.graphs.values()].every(graph => graph.worldPlaced)).toBe(true);
    const refresh = engine(worldInput(true, arrived, 'saved listing', width));
    expect(drawing(refresh)).toEqual(drawing(arrived));
    const input = worldInput(true, refresh, 'saved listing again', width);
    const closed = engine({ ...input, open: new Map([...input.open].filter(([id]) => id === 's0:root')) });
    expect(folderGeometryGate(closed)).toBeNull();
    expect(closed.graphs.size).toBe(1);
    expect(closed.graphs.get('s0:root')!.attached.nodes).toEqual(arrived.graphs.get('s0:root')!.attached.nodes);
    expect(closed.size.width).toBe(width);
    expect(closed.decision?.fallback).toBeUndefined();
  }, 30_000); // A budget fallback spends the constrained search's finite allowance before legacy runs.

  it.each(['missing', 'stale', 'empty', 'malformed', 'negative-bounds'] as const)('does not trust %s canonical band metadata', kind => {
    const engine = createDefaultEngine(), initial = engine(worldInput(false));
    const arrived = engine(worldInput(true, initial));
    const previous = structuredClone(arrived), graph = previous.graphs.get('s0:root')!;
    const canonical = kind === 'missing' ? undefined : kind === 'stale'
      ? { ...graph.canonical!, request: { ...graph.canonical!.request, maxWidth: 1 } }
      : kind === 'empty' ? { ...graph.canonical!, layout: { ...graph.canonical!.layout, nodes: new Map() } }
      : kind === 'negative-bounds' ? { ...graph.canonical!, layout: { ...graph.canonical!.layout, bandBounds: { left: 0, width: -1, top: 0 } } }
      : { layout: graph.canonical!.layout } as typeof graph.canonical;
    (previous.graphs as Map<string, typeof graph>).set(graph.id, { ...graph, canonical });
    const input = worldInput(true, previous, 'metadata');
    const result = engine({ ...input, open: new Map([...input.open].filter(([id]) => id === 's0:root')) });
    expect(folderGeometryGate(result)).toBeNull();
    expect([...result.graphs.get('s0:root')!.attached.nodes.keys()]).toEqual(['s0:root', 's0:a', 's0:b', 's0:c']);
    expect(result.size.width).toBe(input.width);
  });

  it.each([null, undefined])('rebuilds malformed folder cell history (%s)', cells => {
    const engine = createDefaultEngine(), previous = engine(worldInput(false));
    const input = worldInput(false, { ...previous, displays: undefined, cells } as unknown as FolderLayout, 'changed');
    expect(folderGeometryGate(engine(input))).toBeNull();
  });

  it.each([
    { columns: NaN },
    { bounds: { x: 0, y: 0, width: -1, height: -1 } },
    { bands: [{ id: 'ghost', x: NaN, y: 0, width: 100, height: 100, row: 0 }] },
    { rowBands: [{ id: 'row:0', x: 0, y: 0, width: Infinity, height: 100, row: 0 }] },
  ])('rebuilds malformed world-frame metadata %j', patch => {
    const engine = createDefaultEngine(), initial = engine(worldInput(false));
    const arrived = engine(worldInput(true, initial));
    const result = engine(worldInput(true, { ...arrived, ...patch, displays: undefined }, 'metadata'));
    expect(Number.isSafeInteger(result.columns)).toBe(true);
    expect(result.bounds.width).toBeGreaterThanOrEqual(0);
    expect(result.bounds.height).toBeGreaterThanOrEqual(0);
    for (const band of [...result.bands, ...result.rowBands]) {
      expect([band.x, band.y, band.width, band.height].every(Number.isFinite)).toBe(true);
    }
    expect(folderGeometryGate(result)).toBeNull();
  });

  it('honors reordered host cells instead of pinning the earlier sort order', () => {
    const engine = createDefaultEngine(), initial = engine(worldInput(false, undefined, '', 200));
    const arrived = engine(worldInput(true, initial, '', 200));
    const input = worldInput(true, arrived, 'reordered', 200), items = [...input.items].reverse();
    const result = engine({ ...input, items });
    expect([...result.cells.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(cell => cell.id)).toEqual(items.map(item => item.id));
  });

  it('relayouts after a changed pane basis instead of retaining world coordinates', () => {
    const engine = createDefaultEngine(), initial = engine(worldInput(false));
    const arrived = engine(worldInput(true, initial));
    const resized = engine(worldInput(true, arrived, 'saved', 864));
    expect(resized.columns).toBe(7);
    expect(resized.geometryBasis).not.toBe(arrived.geometryBasis);
    expect(folderGeometryGate(resized)).toBeNull();
  });
});
