import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { GraphLayout, PlacedNode, PlacedRoute } from '../../../src/lib/domain/trace-graph/layout';
import { materializeSourcePrefixes } from '../../../src/lib/domain/trace-graph/native-source-prefix';
const node: PlacedNode = { key: 'a', x: 0, y: 0, width: 20, height: 20, row: 0, band: 0 };
const route = (id: string, path: string): PlacedRoute => ({ id, path, from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'z' }, terminal: true, consumers: [{ parent: 'a', child: id }] });
const graph = (routes: readonly PlacedRoute[]): GraphLayout => ({ orientation: 'down', width: 200, height: 200, nodes: new Map([['a', node]]), routes, junctions: new Map(), rows: [], readingOrder: new Map() });
const run = it;
const copy = (value: unknown) => JSON.stringify(value, (_k, v) => v instanceof Map ? [...v] : v);
const raw1 = 'M10 20 L10 30 C 10 35,15 40,20 40 L30 40';
const raw2 = 'M20 40 L20 50 C20 55,25 60,30 60 L40 60';
run('exact native prefix copied from a real source port', () => {
  const g = graph([route('old', raw1), route('new', 'M20 40 L20 90')]);
  const before = copy(g);
  let work = 0;
  const r = materializeSourcePrefixes(g, new Set(['old']), n => { work += n; });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.drawing.routes[1].path, 'M10 20 L10 30 C 10 35,15 40,20 40 L20 90');
    assert.equal(r.drawing.routes[0], g.routes[0]);
  }
  assert.equal(copy(g), before);
  assert.ok(work > raw1.length);
});
run('recursively resolves authored carrier endpoints', () => {
  const g = graph([route('old1', raw1), route('old2', raw2), route('new', 'M30 60 L30 80 L60 80')]);
  const r = materializeSourcePrefixes(g, new Set(['old1', 'old2']), () => { });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.drawing.routes[2].path, 'M10 20 L10 30 C 10 35,15 40,20 40 L20 50 C20 55,25 60,30 60 L30 80 L60 80');
    assert.equal(r.drawing.routes[1].path, raw2);
  }
});
run('accepts a direct new route without rewriting any path', () => {
  const g = graph([route('new', 'M10 20 L10 100')]);
  const r = materializeSourcePrefixes(g, new Set(), () => { });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.equal(r.drawing, g);
});
run('retained authored branches stay byte-identical', () => {
  const g = graph([route('old1', raw1), route('old2', raw2)]);
  const r = materializeSourcePrefixes(g, new Set(['old1', 'old2']), () => { });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.equal(r.drawing, g);
});
run('unrooted carrier cycles return a conflict', () => {
  const g = graph([route('old1', 'M30 30 L40 40'), route('old2', 'M40 40 L30 30'), route('new', 'M40 40 L40 90')]);
  const before = copy(g), r = materializeSourcePrefixes(g, new Set(['old1', 'old2']), () => { });
  assert.equal(r.ok, false);
  if (!r.ok)
    assert.equal(r.conflict.reason, 'unsupported-input');
  assert.equal(copy(g), before);
});
run('axis L interiors copy a partial native line while preserving the old path', () => {
  const g = graph([route('old', 'M10 20 L10 90'), route('new', 'M10 50 L90 50')]);
  const before = copy(g), r = materializeSourcePrefixes(g, new Set(['old']), () => { });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.drawing.routes[1].path, 'M10 20 L10 50L90 50');
    assert.equal(r.drawing.routes[0], g.routes[0]);
  }
  assert.equal(copy(g), before);
});
run('missing sources are explicit malformed-input conflicts', () => {
  const g = { ...graph([route('new', 'M10 20 L10 90')]), nodes: new Map<string, PlacedNode>() };
  assert.equal(materializeSourcePrefixes(g, new Set(), () => { }).ok, false);
});
run('malformed native commands return explicit conflicts', () => {
  const g = graph([route('old', 'M10 20 Q10 30 20 30')]);
  assert.equal(materializeSourcePrefixes(g, new Set(['old']), () => { }).ok, false);
});
run('junction-source paths are outside tile-prefix materialization', () => {
  const r = { ...route('join', 'M10 20 L10 90'), from: { kind: 'junction' as const, id: 'join' } };
  const g = graph([r]);
  const actual = materializeSourcePrefixes(g, new Set(), () => { });
  assert.equal(actual.ok, true);
  if (actual.ok)
    assert.equal(actual.drawing, g);
});
run('ledger exceptions propagate unchanged without mutation', () => {
  const g = graph([route('old', raw1), route('new', 'M20 40 L20 90')]), before = copy(g), error = { budget: true };
  let admitted = 0;
  assert.throws(() => materializeSourcePrefixes(g, new Set(['old']), n => { if (admitted + n > 32)
    throw error; admitted += n; }), e => e === error);
  assert.equal(copy(g), before);
});

run('strict L interior after C keeps authored controls exact', () => {
  const g = graph([route('old', raw1), route('new', 'M25 40 L25 90')]);
  const r = materializeSourcePrefixes(g, new Set(['old']), () => {});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.drawing.routes[1].path, 'M10 20 L10 30 C 10 35,15 40,20 40 L25 40L25 90');
});
run('retained carrier can start strictly inside another L', () => {
  const g = graph([route('old1', 'M10 20 L10 90'), route('old2', 'M10 50 L60 50'), route('new', 'M30 50 L30 100')]);
  const r = materializeSourcePrefixes(g, new Set(['old1', 'old2']), () => {});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.drawing.routes[2].path, 'M10 20 L10 50L30 50L30 100');
});
run('strict cubic interiors stay unsupported', () => {
  const g = graph([route('old', raw1), route('new', 'M13.125 36.875 L80 36.875')]);
  assert.equal(materializeSourcePrefixes(g, new Set(['old']), () => {}).ok, false);
});
run('strict diagonal L interiors stay unsupported', () => {
  const g = graph([route('old', 'M10 20 L40 40'), route('new', 'M25 30 L80 30')]);
  assert.equal(materializeSourcePrefixes(g, new Set(['old']), () => {}).ok, false);
});
