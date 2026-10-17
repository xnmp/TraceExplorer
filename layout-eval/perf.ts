/** Dedicated warmed timings. Run after geometry evaluation, without browser/diagnostic jobs. */
delete process.env.OPENAI_API_KEY;
import { writeFile, mkdir } from 'node:fs/promises';
import { loadavg, cpus } from 'node:os';
import { layoutGraph } from './baseline/layout';
import { performanceWorkloads } from './perf-workloads';
import { layoutGraph as productionLayout, type LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { canLayoutInline } from '../src/lib/domain/trace-graph/layout-workload';
import { profileLayout } from '../src/lib/domain/trace-graph/layout-profile';
import { timeInlineFolders } from './perf-folder';
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * q) - 1)] ?? 0;
const rows = [];
const stages = process.argv.includes('--stages');
const workloads = performanceWorkloads();
// Machine load affects both engines equally (pairs alternate), but heavy load still widens
// tails; it is recorded with the results so a run can be judged.
const loadBefore = loadavg();
for (const workload of workloads) {
  for (let i = 0; i < 12; i++) { layoutGraph(workload.baseline); productionLayout(workload.proposed); }
  const baseline: number[] = [], proposed: number[] = [];
  // Alternating first engine controls drift; neither diagnostics nor file IO is timed.
  // At least 40 paired samples, and more for fast cases (up to 400, or ~1 s per engine),
  // so a tail percentile of a sub-millisecond case is not two samples' worth of scheduler noise.
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 400 && (i < 40 || total(baseline) + total(proposed) < 2000); i++) {
    const run = (engine: 'baseline' | 'proposed') => {
      const start = performance.now();
      if (engine === 'baseline') layoutGraph(workload.baseline); else productionLayout(workload.proposed);
      (engine === 'baseline' ? baseline : proposed).push(performance.now() - start);
    };
    if (i % 2) { run('proposed'); run('baseline'); } else { run('baseline'); run('proposed'); }
  }
  rows.push({ case: workload.case, samples: baseline.length, visible: workload.proposed.items.length, edges: workload.proposed.items.reduce((sum, n) => sum + n.parents.length, 0), mainThread: canLayoutInline(workload.proposed), width: 454, imagePx: 96,
    baseline: { p50: quantile(baseline, .5), p95: quantile(baseline, .95), max: Math.max(...baseline) },
    ...(stages ? { work: profileLayout(() => productionLayout(workload.proposed)).profile } : {}),
    proposed: { p50: quantile(proposed, .5), p95: quantile(proposed, .95), max: Math.max(...proposed) } });
}
await mkdir('layout-eval/out', { recursive: true });
const load = { cpus: cpus().length, before: loadBefore, after: loadavg() };
const folders = timeInlineFolders();
await writeFile('layout-eval/out/perf.json', JSON.stringify({ bun: Bun.version, iterations: '40-400 paired, ~2 s per case; folders: 100 samples', warmup: 12, load, rows, folders }, null, 2));
const fmt = (xs: number[]) => xs.map(x => x.toFixed(2)).join(' / ');
console.log(`Load average (1 / 5 / 15 min) on ${load.cpus} CPUs: before ${fmt(load.before)}, after ${fmt(load.after)}\n`);
console.log(['| Case | Visible | Baseline p50 / p95 ms | New p50 / p95 ms |', '|---|---:|---:|---:|', ...rows.map(r => `| ${r.case} | ${r.visible} | ${r.baseline.p50.toFixed(3)} / ${r.baseline.p95.toFixed(3)} | ${r.proposed.p50.toFixed(3)} / ${r.proposed.p95.toFixed(3)} |`)].join('\n'));
console.log(`\nFull folder engine, ${folders.length} inline workloads: maximum p95 ${Math.max(...folders.map(r=>r.p95)).toFixed(3)} ms.`);
