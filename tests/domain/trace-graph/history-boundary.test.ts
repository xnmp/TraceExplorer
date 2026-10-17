import { expect, it } from 'vitest';
import { node, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph, type GraphLayout } from '../../../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { attachPackedBand, attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { validHistory } from '../../../src/lib/domain/trace-graph/history-boundary';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';

const before = requestFor({ id: 'history-boundary', nodes: [node('root'), node('a', ['root'], 1), node('b', ['root'], 2)], focuses: [null] }, null, 640, 96);
const raw = layoutGraph(before), placed = attachSingleBand(raw, before);
const overlap = (layout: GraphLayout): GraphLayout => ({ ...layout, nodes: new Map([...layout.nodes].map(([key, value]) =>
  [key, key === 'b' ? { ...value, x: layout.nodes.get('a')!.x, y: layout.nodes.get('a')!.y } : value])) });

it.each([
  ['row beyond index reach', { ...raw, rows: [{ index: 1e12, band: 1e12, top: 0, bottom: 100, keys: ['root'] }] }],
  ['missing rows', { ...raw, rows: null }],
  ['malformed row', { ...raw, rows: [null] }],
  ['missing reading order', { ...raw, readingOrder: null }],
  ['overlapping tiles', overlap(raw)],
  ['disconnected route', { ...raw, routes: raw.routes.map(r => ({ ...r, path: 'M0 0 L10 0' })) }],
] as const)('ignores %s in committed history and reports why', (_name, broken) => {
  const result = layoutGraph({ ...before, history: { signature: bandHistorySignature(before), layout: broken as GraphLayout, placed: _name === 'overlapping tiles' ? overlap(placed) : placed } });
  expect(result.nodes).toEqual(raw.nodes);
  expect(result.routes).toEqual(raw.routes);
  expect(result.decision?.fallback).toBe('invalid-history');
});

it('ignores an attachment without a placement', () => {
  const result = layoutGraph({ ...before, history: { signature: bandHistorySignature(before), layout: raw, placed, attachment: {} as never } });
  expect(result.nodes).toEqual(raw.nodes);
  expect(result.decision?.fallback).toBe('invalid-history');
});

it('rejects malformed entries outside a shared consumer range before serialization', () => {
  const broken = { ...raw, routes: raw.routes.map(r => ({ ...r, consumers: { entries: [{ parent: 'root', child: 'a' }, 1n], start: 0, end: 1 } })) };
  const result = layoutGraph({ ...before, history: { signature: bandHistorySignature(before), layout: broken as never, placed } });
  expect(result.decision?.fallback).toBe('invalid-history');
});

it.each([
  ['overlapping retained tiles', (h: any) => Object.assign(h.layout.nodes.get('b'), { x: h.layout.nodes.get('a').x, y: h.layout.nodes.get('a').y })],
  ['replaced rows', (h: any) => { h.layout.rows = null; }],
  ['missing row', (h: any) => { delete h.layout.rows[0]; }],
  ['disconnected path', (h: any) => { h.layout.routes[0].path = 'M0 0 L1 1'; }],
  ['missing endpoint', (h: any) => { h.layout.routes[0].from = null; }],
  ['invalid reading order', (h: any) => { h.layout.readingOrder.set('a', NaN); }],
  ['changed consumer', (h: any) => { h.layout.routes[0].consumers[0].parent = 'wrong'; }],
  ['missing row key', (h: any) => { delete h.layout.rows[0].keys[0]; }],
  ['incomplete attachment', (h: any) => { h.attachment = {}; }],
  ['malformed decision partition', (h: any) => { h.layout.decision = {...h.layout.decision,partition:[NaN]}; }],
] as const)('revalidates warm history after %s', (_name, mutate) => {
  const history = structuredClone({ signature: bandHistorySignature(before), layout: raw, placed });
  expect(validHistory(history, 'root')).toBe(true);
  expect(validHistory(history, 'root')).toBe(true);
  mutate(history);
  expect(validHistory(history, 'root')).toBe(false);
  const result = layoutGraph({ ...before, history });
  expect(result.decision?.fallback).toBe('invalid-history');
  expect(result.nodes).toEqual(raw.nodes);
  expect(result.routes).toEqual(raw.routes);
});

const placement = { x: 8, coverX: 300, coverHeight: 150, width: 640, left: 0, right: 640, track: 12, stemRoom: 40 };
const attachment = { bandTop: 170, placement };
const attachedHistory = () => ({ signature: bandHistorySignature(before), layout: raw,
  placed: attachPackedBand(raw, 'root', attachment.bandTop, placement), attachment: structuredClone(attachment) });

it.each([
  ['negative cover height', { placement: { ...placement, coverHeight: -100 } }],
  ['negative canvas width', { placement: { ...placement, width: -10 } }],
  ['wrong band top', { bandTop: 999999 }],
  ['wrong horizontal translation', { placement: { ...placement, x: 12345 } }],
  ['wrong cover port', { placement: { ...placement, coverX: 76543 } }],
  ['wrong positive canvas width', { placement: { ...placement, width: 641 } }],
  ['wrong stem geometry', { placement: { ...placement, track: 24 } }],
] as const)('rejects an attachment claiming %s, including after validation was cached', (_name, change) => {
  const history = attachedHistory();
  expect(validHistory(history, 'root')).toBe(true);
  Object.assign(history.attachment, change);
  expect(validHistory(history, 'root')).toBe(false);
  const result = layoutGraph({ ...before, history });
  expect(result.decision?.fallback).toBe('invalid-history');
  expect(result.nodes).toEqual(raw.nodes);
});

it('does not accept unrelated safe drawings as a raw/placed history pair', () => {
  const history = attachedHistory();
  expect(validHistory(history, 'root')).toBe(true);
  const shifted = attachPackedBand(raw, 'root', attachment.bandTop + 50, placement);
  expect(validHistory({ ...history, placed: shifted }, 'root')).toBe(false);
  expect(validHistory({ signature: history.signature, layout: raw, placed: shifted }, 'root')).toBe(false);
});

it('accepts exact standalone and identity histories without inventing a packing transform', () => {
  expect(validHistory({ signature: bandHistorySignature(before), layout: raw, placed }, 'root')).toBe(true);
  expect(validHistory({ signature: bandHistorySignature(before), layout: placed, placed }, 'root')).toBe(true);
});

it('certifies the displayed attachment after provisional cover stems are replaced', () => {
  const facts = [['root', 0, 0, []], ['a', 300, 150, ['root']], ['b', 150, 150, []], ['c', 400, 350, ['b']]] as const;
  const items = facts.map(([key, _x, _y, parents], order) => ({ key, width: 100, height: 100, order, parents }));
  const layout: GraphLayout = {
    nodes: new Map(facts.map(([key, x, y], row) => [key, { key, x, y, width: 100, height: 100, row, band: 0 }])),
    junctions: new Map(), readingOrder: new Map(items.map(n => [n.key, n.order])),
    rows: facts.map(([key, _x, y], index) => ({ index, band: 0, top: y, bottom: y + 100, keys: [key] })),
    routes: [['root', 'a', 'M50 100 L50 130 L350 130 L350 142'],
      ['b', 'c', 'M250 200 L270 200 L270 130 L450 130 L450 342']].map(([parent, child, path]) => ({
      id: JSON.stringify([parent, child]), from: { kind: 'node', id: parent }, to: { kind: 'node', id: child },
      path, terminal: true, consumers: [{ parent, child }],
    })),
    width: 600, height: 480, orientation: 'down', bandBounds: { left: 0, width: 600, top: 150 },
  };
  const attachment = { bandTop: 100, placement: { x: 0, coverX: 50, coverHeight: 100, width: 600, left: 0, right: 600, track: 6, stemRoom: 60 } };
  const placed = attachPackedBand(layout, 'root', attachment.bandTop, attachment.placement);
  const history = { signature: bandHistorySignature({ items, maxWidth: 600 }), layout, placed, attachment };
  expect(geometryGate(layout, items, 'root', 600)).toBe('shared-lane');
  expect(geometryGate(placed, items, 'root', 600)).toBeNull();
  expect(validHistory(history, 'root')).toBe(true);
  const changed = structuredClone(history);
  changed.layout.routes[1] = { ...changed.layout.routes[1], path: 'M250 200 L280 200 L280 130 L450 130 L450 342' };
  expect(validHistory(changed, 'root')).toBe(false);
});

it('accepts a finite pending-output creation order beyond the spatial index range',()=>{
  const facts=JSON.parse(bandHistorySignature(before));
  facts[3].find((n:unknown[])=>n[0]==='b')[3]=1_000_000_000_012;
  expect(validHistory({signature:JSON.stringify(facts),layout:raw,placed},'root')).toBe(true);
});
it.each([null,NaN,Infinity,-Infinity])('rejects malformed logical order %s',order=>{
  const signature=JSON.parse(bandHistorySignature(before)); signature[3][0][3]=order;
  expect(validHistory({signature:JSON.stringify(signature),layout:raw,placed},'root')).toBe(false);
});
