import { expect, it } from 'vitest';
import { routeClearanceViolation } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';

function drawing(curve: string): GraphLayout {
  const route = (id: string, path: string): PlacedRoute => ({ id, path, from: { kind: 'node', id }, to: { kind: 'node', id: `${id}-child` }, consumers: [{ parent: id, child: `${id}-child` }], terminal: false });
  return { orientation: 'down', width: 100, height: 100, nodes: new Map(), junctions: new Map(), rows: [], readingOrder: new Map(),
    routes: [route('straight', 'M0 0 L30 0'), route('curve', curve)] };
}

it('accepts exact clearance when a cubic control hull proves the curve stays on the safe side', () => {
  expect(routeClearanceViolation(drawing('M0 3 L10 3 C16 3 16 9 16 9 L16 20'))).toBeNull();
});

it('rejects a curve whose interior enters the clearance despite safe endpoints', () => {
  expect(routeClearanceViolation(drawing('M0 3 L10 3 C14 2.95 16 4 16 9 L16 20'))).toBe('route-contact');
});

it('rejects shallow segment crossings whose endpoints are far apart', () => {
  const routes=['M0 100 L200 100','M0 90 L200 110'].map((path,i)=>({id:String(i),path,from:{kind:'node' as const,id:String(i)},to:{kind:'node' as const,id:String(i)},consumers:[],terminal:false}));
  expect(routeClearanceViolation({nodes:new Map(),junctions:new Map(),routes} as never)).toBe('route-contact');
});
