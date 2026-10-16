import { expect, it } from 'vitest';
import { canonicalExpansion, canonicalPrefixes } from '../../../layout-eval/canonical-construction';
import { layoutGraph, type LayoutItem, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { geometrySignature } from '$lib/domain/trace-graph/layout-signature';
import { requestFor, screenshot } from '../../../layout-eval/corpus';

const node = (key: string, order: number, parents: readonly string[] = []): LayoutItem => ({ key, order, parents, width: 96, height: 120 });
const full = [node('root', 0), node('a', 1, ['root']), node('b', 2, ['root']),
  node('a1', 3, ['a']), node('b1', 4, ['b']), node('b2', 5, ['b1'])];
const request = (items: readonly LayoutItem[] = full): LayoutRequest => ({ items, band: { key: 'root', items: full }, maxWidth: 454, tileWidth: 96 });
const births = (r: LayoutRequest, order: Parameters<typeof canonicalPrefixes>[1]) => {
  const seen = new Set<string>();
  return canonicalPrefixes(r, order).map(items => items.filter(n => !seen.has(n.key)).map(n => { seen.add(n.key); return n.key; }));
};

it('orders by depth, then stable creation order', () => {
  expect(births(request(), 'depth')).toEqual([['root', 'a', 'b'], ['a1'], ['b1'], ['b2']]);
});
it('walks the complete folder frontier newest-first, including child branches before older peers', () => {
  expect(births(request(), 'full-frontier')).toEqual([['root', 'a', 'b'], ['b1'], ['b2'], ['a1']]);
});
it('filters the complete traversal by visible state without consulting click order or input enumeration', () => {
  const partial = full.filter(n => n.key !== 'b2');
  const a = request(partial), b = { ...request([...partial].reverse()), band: { key: 'root', items: [...full].reverse() } };
  expect(births(a, 'full-frontier')).toEqual([['root', 'a', 'b'], ['b1'], ['a1']]);
  expect(births(b, 'full-frontier')).toEqual(births(a, 'full-frontier'));
});
it('closes each insertion over visible co-parents and handles an empty folder', () => {
  const merged = [...full, node('merge', 6, ['a1', 'b2'])];
  const r = { ...request(merged), band: { key: 'root', items: merged } };
  for (const prefix of canonicalPrefixes(r, 'full-frontier')) {
    const keys = new Set(prefix.map(n => n.key));
    for (const item of prefix) for (const parent of item.parents) expect(keys.has(parent)).toBe(true);
  }
  expect(canonicalPrefixes({ ...request([]), band: { key: 'root', items: [] } })).toEqual([]);
});
it('returns the identical drawing after different state paths and a cold-cache replay', () => {
  const r = requestFor(screenshot, 'Saffron', 454, 96);
  const before = geometrySignature(canonicalExpansion(r, layoutGraph, 'full-frontier'));
  for (const focus of ['Ash', 'Cerulean', null, 'Ash']) canonicalExpansion(requestFor(screenshot, focus, 454, 96), layoutGraph, 'full-frontier');
  expect(geometrySignature(canonicalExpansion(r, layoutGraph, 'full-frontier'))).toEqual(before);
  // A fresh function identity owns a fresh prefix cache; memoization cannot supply history.
  expect(geometrySignature(canonicalExpansion(r, input => layoutGraph(input), 'full-frontier'))).toEqual(before);
});
