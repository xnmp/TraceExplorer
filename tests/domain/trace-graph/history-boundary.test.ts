import { expect, it } from 'vitest';
import { node, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph, type GraphLayout } from '../../../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { validHistory } from '../../../src/lib/domain/trace-graph/history-boundary';

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
