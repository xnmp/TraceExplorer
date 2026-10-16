/** Timed requests mirror clicks without history and arrivals with committed history. */
import { corpus, requestFor, type Case } from './corpus';
import { layoutGraph as baselineLayout } from './baseline/layout';
import type { LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { optimizedBand } from './engine';

const unanchored = (request: LayoutRequest): LayoutRequest => ({ ...request, anchorKey: undefined, hint: undefined, history: undefined });
export function performanceWorkloads(cases: readonly Case[] = corpus()): { case: string; baseline: LayoutRequest; proposed: LayoutRequest }[] {
  const workloads = [];
  for (const original of cases) {
    const focus = original.id === 'screenshot' ? 'Saffron' : original.id === 'chain-200' ? 'n199' : original.focuses.findLast(f => f !== null) ?? null;
    const fixture = original.id.startsWith('random-') ? { ...original, full: true } : original;
    const request = requestFor(fixture, focus, 454, 96);
    workloads.push({ case: original.id, baseline: request, proposed: unanchored(request) });
    const legal = { ...original, full: false }, before = requestFor(legal, null, 454, 96);
    const click = before.items.filter(n => n.key !== before.band!.key && before.band!.items.some(child => child.parents.includes(n.key)))
      .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
    if (click) {
      const next = requestFor(legal, click.key, 454, 96);
      if (next.items.map(n => n.key).sort().join(',') !== before.items.map(n => n.key).sort().join(','))
        workloads.push({ case: `${original.id} / reveal`, baseline: { ...next, hint: baselineLayout(before).readingOrder }, proposed: unanchored(next) });
    }
    // Remove a real leaf, then restore it. Both requests know their actual full
    // membership, so this is an output arrival rather than expansion of a cache.
    const leaf = original.nodes.findLast(n => n.key !== 'root' && !original.nodes.some(child => child.parents.includes(n.key)));
    if (!leaf) continue;
    const prior = requestFor({ ...original, nodes: original.nodes.filter(n => n.key !== leaf.key), full: true }, null, 454, 96);
    const next = requestFor({ ...original, full: true }, null, 454, 96);
    const previous = optimizedBand(prior, { historyPolicy: 'arrival-only' });
    workloads.push({ case: `${original.id} / arrival`, baseline: { ...next, hint: baselineLayout(prior).readingOrder },
      proposed: { ...unanchored(next), history: { signature: previous.signature, layout: previous.layout, placed: previous.placed } } });
  }
  return workloads;
}
