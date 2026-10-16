import { expect, it } from 'vitest';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { requestFor, screenshot } from '../../../layout-eval/corpus';
import { geometrySignature } from '$lib/domain/trace-graph/layout-signature';

it('evaluates repeated expansion states using arrival-only history', () => {
  let previous: Optimized | undefined;
  const states = new Map<string | null, ReturnType<typeof geometrySignature>>();
  for (const focus of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null]) {
    const request = requestFor(screenshot, focus, 454, 96);
    const next = optimizedBand(request, { previous, anchorKey: focus ?? undefined, historyPolicy: 'arrival-only' });
    const signature = geometrySignature(next.placed);
    if (states.has(focus)) expect(signature).toEqual(states.get(focus));
    states.set(focus, signature); previous = next;
  }
});

it('captures actual arrivals once and preserves that snapshot through later clicks', () => {
  const request = (count: number) => {
    const items = Array.from({length:count}, (_, i) => ({ key:String(i), order:i, width:92, height:97, parents:i ? ['0'] : [] }));
    return { items, band:{key:'0',items}, maxWidth:454, tileWidth:92 };
  };
  const before = optimizedBand(request(2), { historyPolicy:'arrival-only' });
  const after = optimizedBand(request(3), { previous:before, historyPolicy:'arrival-only' });
  expect(after.arrivalHistory?.placed).toBe(before.placed);
  for (const [key,n] of before.placed.nodes) expect(after.placed.nodes.get(key)).toMatchObject({x:n.x,y:n.y,width:n.width,height:n.height});
  const repeat = optimizedBand({...request(3), hint:new Map([['2',0]])}, {previous:after,anchorKey:'2',historyPolicy:'arrival-only'});
  expect(repeat.arrivalHistory).toBe(after.arrivalHistory);
  expect(geometrySignature(repeat.placed)).toEqual(geometrySignature(after.placed));
});

it('does not capture history on pane, tile or pinned-column changes', () => {
  const first = requestFor(screenshot, null, 454, 96);
  const before = optimizedBand(first, {historyPolicy:'arrival-only'});
  for (const request of [requestFor(screenshot,null,640,96),requestFor(screenshot,null,454,128),
    {...first,pinned:{...first.pinned!,x:200}}]) {
    const changed = optimizedBand(request, {previous:before,historyPolicy:'arrival-only'});
    expect(changed.arrivalHistory).toBeUndefined();
  }
});

it('times actual retained arrivals as well as history-free reveals', async () => {
  const { performanceWorkloads } = await import('../../../layout-eval/perf-workloads');
  const { canLayoutInline } = await import('$lib/domain/trace-graph/layout-workload');
  const workloads = performanceWorkloads([screenshot]);
  const arrivals = workloads.filter(w => w.case.endsWith('/ arrival'));
  expect(arrivals.some(w => canLayoutInline(w.proposed))).toBe(true);
  for (const { proposed } of workloads) {
    expect(proposed.anchorKey).toBeUndefined();
    expect(proposed.hint).toBeUndefined();
  }
  for (const { proposed } of arrivals) {
    expect(proposed.history).toBeDefined();
    expect(proposed.items.some(n => !proposed.history!.layout.nodes.has(n.key))).toBe(true);
  }
  expect(workloads.filter(w => w.case.endsWith('/ reveal')).every(w => !w.proposed.history)).toBe(true);
});
