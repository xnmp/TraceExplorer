/** Dedicated warmed timings. Run after geometry evaluation, without browser/diagnostic jobs. */
delete process.env.OPENAI_API_KEY;
import { writeFile, mkdir } from 'node:fs/promises';
import { layoutGraph } from './baseline/layout';
import { corpus, requestFor } from './corpus';
import { layoutGraph as productionLayout, type LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../src/lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '../src/lib/domain/trace-graph/band-geometry';
import { canLayoutInline } from '../src/lib/domain/trace-graph/layout-workload';
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * q) - 1)] ?? 0;
const rows = [];
const workloads: { case: string; baseline: LayoutRequest; proposed: LayoutRequest }[] = [];
for (const original of corpus()) {
  const focus = original.id === 'screenshot' ? 'Saffron' : original.id === 'chain-200' ? 'n199' : original.focuses.findLast(f => f !== null) ?? null;
  const fixture = original.id.startsWith('random-') ? { ...original, full: true } : original;
  const request = requestFor(fixture, focus, 454, 96);
  workloads.push({ case: original.id, baseline: request, proposed: request });
  const legal = { ...original, full: false }, before = requestFor(legal, null, 454, 96);
  const click = before.items.filter(n => n.key !== before.band!.key && before.band!.items.some(child => child.parents.includes(n.key)))
    .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
  if (!click) continue;
  const previous = productionLayout(before), baselinePrevious = layoutGraph(before);
  const next = requestFor(legal, click.key, 454, 96);
  if (next.items.map(n => n.key).sort().join(',') === before.items.map(n => n.key).sort().join(',')) continue;
  workloads.push({ case: `${original.id} / committed reveal`, baseline: { ...next, hint: baselinePrevious.readingOrder },
    proposed: { ...next, hint: previous.readingOrder, anchorKey: click.key,
      history: { signature: bandHistorySignature(before), layout: previous, placed: attachSingleBand(previous, before) } } });
}
for (const workload of workloads) {
  for (let i = 0; i < 12; i++) { layoutGraph(workload.baseline); productionLayout(workload.proposed); }
  const baseline: number[] = [], proposed: number[] = [];
  // Alternating first engine controls drift; neither diagnostics nor file IO is timed.
  // At least 40 paired samples, and more for fast cases (up to 400, or ~0.4 s per engine),
  // so a tail percentile of a sub-millisecond case is not two samples' worth of scheduler noise.
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 400 && (i < 40 || total(baseline) + total(proposed) < 800); i++) {
    const run = (engine: 'baseline' | 'proposed') => {
      const start = performance.now();
      if (engine === 'baseline') layoutGraph(workload.baseline); else productionLayout(workload.proposed);
      (engine === 'baseline' ? baseline : proposed).push(performance.now() - start);
    };
    if (i % 2) { run('proposed'); run('baseline'); } else { run('baseline'); run('proposed'); }
  }
  rows.push({ case: workload.case, samples: baseline.length, visible: workload.proposed.items.length, edges: workload.proposed.items.reduce((sum, n) => sum + n.parents.length, 0), mainThread: canLayoutInline(workload.proposed), width: 454, imagePx: 96,
    baseline: { p50: quantile(baseline, .5), p95: quantile(baseline, .95), max: Math.max(...baseline) },
    proposed: { p50: quantile(proposed, .5), p95: quantile(proposed, .95), max: Math.max(...proposed) } });
}
await mkdir('layout-eval/out', { recursive: true });
await writeFile('layout-eval/out/perf.json', JSON.stringify({ bun: Bun.version, iterations: '40-400 paired, ~0.8 s per case', warmup: 12, rows }, null, 2));
console.log(['| Case | Visible | Baseline p50 / p95 ms | New p50 / p95 ms |', '|---|---:|---:|---:|', ...rows.map(r => `| ${r.case} | ${r.visible} | ${r.baseline.p50.toFixed(3)} / ${r.baseline.p95.toFixed(3)} | ${r.proposed.p50.toFixed(3)} / ${r.proposed.p95.toFixed(3)} |`)].join('\n'));
