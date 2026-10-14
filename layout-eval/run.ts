/** Acceptance is executable; a failed target is never silently converted to a warning. */
delete process.env.OPENAI_API_KEY;
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { requestFor, screenshot } from './corpus';
import { optimizedBand } from './engine';
import { measure } from './geometry';
import { layoutGraph as baselineLayout } from './baseline/layout';
import { attached as baselineAttached } from './baseline/placement';
const out = 'layout-eval/out';
await mkdir(out, { recursive: true });
for (const name of ['bench', 'reveals', 'packing', 'perf']) {
  console.log(`Running ${name}...`);
  const file = Bun.file(`${out}/${name}.log`);
  const child = Bun.spawn([process.execPath, `layout-eval/${name}.ts`], { stdout: file, stderr: 'inherit', env: process.env });
  const status = await child.exited;
  if (status) { console.error(`${name} failed with exit ${status}; see ${out}/${name}.log`); process.exit(status); }
}
const json = async (name: string) => JSON.parse(await readFile(`${out}/${name}.json`, 'utf8'));
const [broad, tours, packing, timing] = await Promise.all(['results', 'reveals', 'packing', 'perf'].map(json));
const request = requestFor(screenshot, 'Saffron', 454, 96), result = optimizedBand(request), m = measure(result.placed, 'root', 454, request.items);
const firstGap = Math.min(...[...result.placed.nodes.values()].filter(n => n.key !== 'root').map(n => n.y)) - result.placed.nodes.get('root')!.height;
const baselineBand = baselineAttached(baselineLayout(request), request);
const baselineGap = Math.min(...[...baselineBand.nodes.values()].filter(n => n.key !== 'root').map(n => n.y)) - baselineBand.nodes.get('root')!.height;
const hard = ['tileIntersections', 'overlaps', 'directionViolations', 'missingEdges', 'extraEdges', 'missingNodes', 'extraNodes', 'invalidGeometry', 'invalidPaths', 'terminalViolations', 'disconnectedEdges'];
const totalHard = (rows: any[]) => rows.reduce((sum, r) => sum + hard.reduce((n, key) => n + (r.metrics?.[key] ?? r.proposed?.[key] ?? r[key] ?? 0), 0), 0);
const newRows = broad.rows.filter((r: any) => r.engine === 'proposed');
const pairs = broad.rows.filter((r: any) => r.engine === 'baseline').map((b: any, i: number) => ({ b, p: broad.rows[i * 2 + 1] }));
const heightExceptions = pairs.filter(({ b, p }: any) => b.metrics && p.metrics && p.metrics.height > b.metrics.height * 1.1 + .01);
const unpricedHeight = heightExceptions.filter(({ p }: any) => !p.decision?.stability);
const moved = tours.rows.filter((r: any) => r.focus && r.changed && r.proposed.anchorDisplacement > .01);
const packingSilentMoves = packing.filter((r: any) => r.engine === "proposed" && r.clickDisplacement > .01 && !r.decision?.fallback);
const silentAnchorMoves = moved.filter((r: any) => !r.decision?.fallback);
const perfRegressions = timing.rows.filter((r: any) => r.proposed.p95 > r.baseline.p95);
const smallSlow = timing.rows.filter((r: any) => r.mainThread && r.proposed.p95 > 5);
const maxSmall = (engine: string) => Math.max(...timing.rows.filter((r: any) => r.mainThread).map((r: any) => r[engine].p95));
const maxVisible = (engine: string) => Math.max(...timing.rows.filter((r: any) => r.visible <= 30).map((r: any) => r[engine].p95));
// Readability gates. A shared lane is allowed only as a flagged, listed fallback; a crossing
// regression only where each extra crossing saves the calibrated band height (bench.ts).
const laneReason = (fallback: string | undefined) => fallback === 'lane-infeasible' ? 'lane-infeasible: no candidate keeps every source in its own lane'
  : fallback === 'gate-infeasible' ? 'gate-infeasible: malformed input (the cover has a visible parent); the downward layout is shown as is' : null;
const tourLanes = tours.rows.filter((r: any) => r.proposed.sharedLanePx > 0).map((r: any) => ({ case: r.case, width: r.width, imagePx: 96, step: r.step, candidate: r.decision?.candidate, sharedLanePx: r.proposed.sharedLanePx, reason: laneReason(r.decision?.fallback), source: 'tour' }));
const laneCases = [...broad.readability.sharedLanes.map((r: any) => ({ ...r, source: 'bench' })), ...tourLanes];
const unexplainedLanes = laneCases.filter((r: any) => !r.reason);
const crossingMean = (engine: string) => broad.summary[engine].mean.crossings;
const acceptance = [
  { target: 'Reported band ≤350 px', baseline: pairs.find(({ b }: any) => b.case === 'screenshot' && b.width === 454 && b.imagePx === 96 && b.focus === 'Saffron')?.b.metrics.height, proposed: m.height, pass: m.height <= 350 },
  { target: 'Cover → first child =34 px', baseline: baselineGap, proposed: firstGap, pass: firstGap === 34 },
  { target: 'All legal click anchors stationary (including real packing)', baseline: tours.rows.filter((r: any) => r.focus && r.changed && r.baseline.anchorDisplacement > .01).length, proposed: moved.length + packing.filter((r: any) => r.engine === "proposed" && r.clickDisplacement > .01).length, pass: moved.length === 0 && packing.every((r: any) => r.engine !== "proposed" || !(r.clickDisplacement > .01)) },
  { target: 'Mean legal displacement ≤baseline px', baseline: tours.summary.baseline.displacement, proposed: tours.summary.proposed.displacement, pass: tours.summary.proposed.displacement <= tours.summary.baseline.displacement },
  { target: 'Mean legal height ≥15% lower px', baseline: tours.summary.baseline.height, proposed: tours.summary.proposed.height, pass: tours.summary.proposed.height <= tours.summary.baseline.height * .85 },
  { target: '>10% height regressions without stability reason', baseline: 0, proposed: unpricedHeight.length, pass: unpricedHeight.length === 0 },
  { target: 'Hard gate violations/errors (corpus + tours + packing)', baseline: totalHard(broad.rows.filter((r: any) => r.engine === 'baseline')) + totalHard(tours.rows.map((r: any) => ({ proposed: r.baseline }))) + totalHard(packing.filter((r: any) => r.engine === 'baseline')), proposed: totalHard(newRows) + totalHard(tours.rows) + totalHard(packing.filter((r: any) => r.engine === 'proposed')) + newRows.filter((r: any) => r.error).length + packing.filter((r: any) => r.engine === 'proposed' && r.error).length, pass: false },
  { target: 'Shared lanes between sources, not a listed fallback (corpus + tours)', baseline: broad.rows.filter((r: any) => r.engine === 'baseline' && r.metrics?.sharedLanePx > 0).length, proposed: unexplainedLanes.length, pass: unexplainedLanes.length === 0 },
  { target: 'Mean crossings ≤ baseline', baseline: crossingMean('baseline'), proposed: crossingMean('proposed'), pass: crossingMean('proposed') <= crossingMean('baseline') },
  { target: `Crossing regressions not paid for by ${broad.readability.crossingHeightTiles} tile widths of height per extra crossing`, baseline: 0, proposed: broad.readability.unpricedCrossingRegressions, pass: broad.readability.unpricedCrossingRegressions === 0 },
  { target: 'Cases with worse p95 than baseline', baseline: 0, proposed: perfRegressions.length, pass: perfRegressions.length === 0 },
  { target: 'Maximum p95 for main-thread requests (dispatch rule: ≤30 current+history tiles) ≤5ms', baseline: maxSmall('baseline'), proposed: maxSmall('proposed'), pass: smallSlow.length === 0 },
  { target: 'Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms', baseline: maxVisible('baseline'), proposed: maxVisible('proposed'), pass: maxVisible('proposed') <= 5 },
];
acceptance[6].pass = acceptance[6].proposed === 0;
const laneList = laneCases.length ? ['| Source | Case | Width / image | Step | Candidate | Shared lane px | Reason |', '|---|---|---|---:|---|---:|---|',
  ...laneCases.map((r: any) => `| ${r.source} | ${r.case} | ${r.width} / ${r.imagePx} | ${r.step} | ${r.candidate} | ${r.sharedLanePx.toFixed(1)} | ${r.reason ?? '**unexplained**'} |`)].join('\n') : 'None.';
const table = ['| Acceptance target | Baseline | New | Result |', '|---|---:|---:|---|', ...acceptance.map(r => `| ${r.target} | ${Number(r.baseline).toFixed(3)} | ${r.proposed.toFixed(3)} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
const metrics = ['| Metric (mean per layout) | Baseline | New |', '|---|---:|---:|', ...Object.keys(broad.summary.baseline.mean).map(k => `| ${k} | ${broad.summary.baseline.mean[k].toFixed(3)} | ${broad.summary.proposed.mean[k].toFixed(3)} |`)].join('\n');
const report = `${table}\n\n${metrics}\n\nExplicit anchor fallbacks: ${moved.length}. Height exceptions selected for stability: ${heightExceptions.length - unpricedHeight.length}.\n\n### Shared lanes shown (listed fallbacks)\n\n${laneList}\n\n${await readFile(`${out}/readability.md`, 'utf8')}\n${await readFile(`${out}/perf.log`, 'utf8')}`;
await writeFile(`${out}/acceptance.md`, report);
await writeFile(`${out}/acceptance.json`, JSON.stringify({ acceptance, moved, heightExceptions, perfRegressions, smallSlow, laneCases }, null, 2));
console.log(report);
if (acceptance.some(r => !r.pass)) process.exitCode = 1;
