import { describe, expect, it } from 'vitest';
import { captureTranslatedRouting, rebaseRetainedRoutingFrame, restoreRetainedRoutingFrame, translatedRoutingDrawing } from '../../../src/lib/domain/trace-graph/routing-frame';
import { mapPathNumbers } from '../../../src/lib/domain/trace-graph/path-data';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { routingCoordinate } from '../../../src/lib/domain/trace-graph/routing-problem';

const fixture = () => {
  const request = requestFor(corpus().find(c => c.id === 'merges-3')!, null, 454, 96);
  return optimizedBand(request).placed;
};
const transform = { nodes: { x: [{ operation: 'add' as const, operand: 123 }, { operation: 'add' as const, operand: 8 }], y: [{ operation: 'add' as const, operand: 573 }] },
  paths: { x: [{ operation: 'add' as const, operand: 131 }], y: [{ operation: 'add' as const, operand: 573 }] } };
describe('ordered world routing frames', () => {
  it('captures every tile, dot and native control with ordered arithmetic', () => {
    const drawing = fixture(), before = structuredClone(drawing);
    const result = captureTranslatedRouting(drawing, transform);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pins = new Map(result.problem.metric.variables.map(v => [v.id, v.pin!.value]));
    for (const frame of result.problem.frames) {
      let value = pins.get(frame.input)!;
      for (const step of frame.steps) {
        value = step.operation === 'add' ? value + step.operand : value - step.operand;
        expect(Object.is(value, step.result)).toBe(true);
      }
      expect(Object.is(value, pins.get(frame.output))).toBe(true);
    }
    for (const [key, n] of drawing.nodes) expect(pins.get(routingCoordinate('world', 'tile', key, 'y'))).toBe(n.y + 573);
    expect(drawing).toEqual(before);
  });
  it('preserves every native route under the exact reverse recipe', () => {
    const drawing = fixture();
    const shifted = translatedRoutingDrawing(drawing, transform);
    const back = translatedRoutingDrawing(shifted, { nodes: { x: [{ operation: 'subtract', operand: 8 }, { operation: 'subtract', operand: 123 }], y: [{ operation: 'subtract', operand: 573 }] },
      paths: { x: [{ operation: 'subtract', operand: 131 }], y: [{ operation: 'subtract', operand: 573 }] } });
    for (const [key, n] of drawing.nodes) expect(back.nodes.get(key)).toEqual(n);
    expect(back.routes.map(r => r.path)).not.toEqual(drawing.routes.map(r => r.path));
    const captured = captureTranslatedRouting(drawing, transform);
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const restored = restoreRetainedRoutingFrame(captured.problem, shifted, back);
    expect(restored.ok).toBe(true);
    if (!restored.ok || !('drawing' in restored)) return;
    expect(restored.drawing.routes.map(r => r.path)).toEqual(drawing.routes.map(r => r.path));
    const bad = { ...shifted, nodes: new Map([...shifted.nodes].map(([key, n], i) => [key, i ? n : { ...n, x: n.x + 1 }])) };
    expect(restoreRetainedRoutingFrame(captured.problem, bad, back).ok).toBe(false);
    expect(restoreRetainedRoutingFrame(captured.problem, shifted, { ...back, routes: back.routes.slice(1) }).ok).toBe(false);
    expect(restoreRetainedRoutingFrame(captured.problem, shifted, { ...back, nodes: new Map([...back.nodes].slice(1)) }).ok).toBe(false);
  });

  it('restores native bytes at the same folder origin after lossy router translation', () => {
    const drawing = fixture(), before = structuredClone(drawing);
    const captured = captureTranslatedRouting(drawing, transform);
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const world = translatedRoutingDrawing(drawing, transform);
    const lossy = { ...drawing, routes: world.routes.map(r => ({ ...r,
      path: mapPathNumbers(r.path, (v, i) => v - (i % 2 ? 573 : 131)) })) };
    expect(lossy.routes.map(r => r.path)).not.toEqual(drawing.routes.map(r => r.path));
    const result = rebaseRetainedRoutingFrame(captured.problem, world, lossy,
      { source: { x: 123, y: 573 }, target: { x: 123, y: 573 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.drawing).toEqual(drawing);
    expect(drawing).toEqual(before);
    expect(rebaseRetainedRoutingFrame(captured.problem, world, { ...lossy, routes: [] },
      { source: { x: 123, y: 573 }, target: { x: 123, y: 573 } }).ok).toBe(false);
    expect(rebaseRetainedRoutingFrame(captured.problem, world, lossy,
      { source: { x: 123, y: 573 }, target: { x: NaN, y: 573 } }).ok).toBe(false);
  });
});

it('declines malformed native scenes and recipes while preserving ledger exceptions', () => {
  const original = fixture();
  for (const path of ['M0 0', 'M0 0 LNaN 1', 'M0 0 L1 1']) {
    const drawing = { ...original, routes: original.routes.map((route, index) => index ? route : { ...route, path }) };
    expect(captureTranslatedRouting(drawing, transform).ok).toBe(false);
  }
  expect(captureTranslatedRouting(original, { ...transform, paths: { x: [null], y: [] } } as any).ok).toBe(false);
  const exhausted = new Error('frame ledger');
  expect(() => captureTranslatedRouting(original, transform, () => { throw exhausted; })).toThrow(exhausted);
});

it('checks the actual target recipe including its grouped native margin', () => {
  const original = fixture();
  const local = { ...original, routes: original.routes.map(route => ({ ...route,
    path: mapPathNumbers(route.path, (value, index) => index % 2 === 0 && value === 376 ? 376.00000000000017 : value) })) };
  const recipe = (origin: number) => ({ nodes: { x: [{ operation: 'add' as const, operand: origin }, { operation: 'add' as const, operand: 8 }], y: [] },
    paths: { x: [{ operation: 'add' as const, operand: origin + 8 }], y: [] } });
  const captured = captureTranslatedRouting(local, recipe(128));
  if (!captured.ok) throw new Error(JSON.stringify(captured));
  const world = translatedRoutingDrawing(local, recipe(128));
  const origins = { source: { x: 128, y: 0 }, target: { x: .1, y: 0 } };
  expect(rebaseRetainedRoutingFrame(captured.problem, world, local, origins).ok).toBe(false);
  const result = rebaseRetainedRoutingFrame(captured.problem, world, local, { ...origins, targetTransform: recipe(.1) });
  if (result.ok) expect(translatedRoutingDrawing(result.drawing, recipe(.1)).routes.map(route => route.path)).toEqual(world.routes.map(route => route.path));
  else expect(result.conflict.kind).toBe('equality');
});
