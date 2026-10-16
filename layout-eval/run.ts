/** Acceptance is executable; a failed target is never silently converted to a warning. */
delete process.env.OPENAI_API_KEY;
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { requestFor, screenshot } from './corpus';
import { optimizedBand } from './engine';
import { measure } from './geometry';
import { layoutGraph as baselineLayout } from './baseline/layout';
import { attached as baselineAttached } from './baseline/placement';
const out = 'layout-eval/out';
// `--engine=<name>` picks the registered folder layout engine the packing cases run through the seam.
const engineArgs = process.argv.slice(2).filter(a => a.startsWith('--engine='));
await mkdir(out, { recursive: true });
for (const name of ['bench', 'reveals', 'packing', 'perf']) {
  console.log(`Running ${name}...`);
  const file = Bun.file(`${out}/${name}.log`);
  const child = Bun.spawn([process.execPath, `layout-eval/${name}.ts`, ...(name === 'packing' ? engineArgs : [])], { stdout: file, stderr: 'inherit', env: process.env });
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
// The crossing cap may let an anchor move (`anchor-yield`): an explained, listed decision, not a failure.
const clicks = (rows: any[], engine: 'baseline' | 'proposed') => rows.filter((r: any) => r.focus && r.changed && r[engine].anchorDisplacement > .01);
const broadTours = tours.rows.filter((r: any) => !r.dense), denseTours = tours.rows.filter((r: any) => r.dense);
const anchorMoves = clicks(broadTours, 'proposed');
const yields = anchorMoves.filter((r: any) => r.decision?.fallback === 'anchor-yield');
const moved = anchorMoves.filter((r: any) => r.decision?.fallback !== 'anchor-yield');
// Dense tours (fan-in up to 4 and 10): anchor stability where merges crowd every lane.
const denseMoves = clicks(denseTours, 'proposed'), denseMoved = denseMoves.filter((r: any) => r.decision?.fallback !== 'anchor-yield');
const denseBreakdown = [4, 10].map(f => {
  const rows = denseTours.filter((r: any) => r.case.startsWith(`dense-f${f}-`)), count = (fallback: string) => rows.filter((r: any) => r.decision?.fallback === fallback).length;
  return { fanIn: f, steps: rows.length, clicks: rows.filter((r: any) => r.focus && r.changed).length, baselineMoved: clicks(rows, 'baseline').length, moved: clicks(rows, 'proposed').filter((r: any) => r.decision?.fallback !== 'anchor-yield').length,
    anchorInfeasible: count('anchor-infeasible'), anchorYield: count('anchor-yield'), laneInfeasible: count('lane-infeasible'), gateInfeasible: count('gate-infeasible') };
});
const packingSilentMoves = packing.filter((r: any) => r.engine === "proposed" && r.clickDisplacement > .01 && !r.decision?.fallback);
const silentAnchorMoves = moved.filter((r: any) => !r.decision?.fallback);
const perfRegressions = timing.rows.filter((r: any) => r.proposed.p95 > r.baseline.p95);
const smallSlow = timing.rows.filter((r: any) => r.mainThread && r.proposed.p95 > 5);
const maxSmall = (engine: string) => Math.max(...timing.rows.filter((r: any) => r.mainThread).map((r: any) => r[engine].p95));
const maxVisible = (engine: string) => Math.max(...timing.rows.filter((r: any) => r.visible <= 30).map((r: any) => r[engine].p95));
// Readability gates. A shared lane is allowed only as a flagged, listed fallback; a crossing
// regression only where each extra crossing saves the calibrated band height (bench.ts).
const tourLanes = tours.rows.filter((r: any) => r.proposed.sharedLanePx > 0).map((r: any) => ({ case: r.case, width: r.width, imagePx: 96, step: r.step, candidate: r.decision?.candidate, sharedLanePx: r.proposed.sharedLanePx, reason: r.reason ?? null, source: 'tour' }));
const laneCases = [...broad.readability.sharedLanes.map((r: any) => ({ ...r, source: 'bench' })), ...tourLanes];
const unexplainedLanes = laneCases.filter((r: any) => !r.reason);
const crossingMean = (engine: string) => broad.summary[engine].mean.crossings;
const acceptance = [
  { target: 'Reported band ≤350 px', baseline: pairs.find(({ b }: any) => b.case === 'screenshot' && b.width === 454 && b.imagePx === 96 && b.focus === 'Saffron')?.b.metrics.height, proposed: m.height, pass: m.height <= 350 },
  { target: 'Cover → first child =34 px', baseline: baselineGap, proposed: firstGap, pass: firstGap === 34 },
  { target: 'All legal click anchors stationary (including real packing)', baseline: clicks(broadTours, 'baseline').length, proposed: moved.length + packing.filter((r: any) => r.engine === "proposed" && r.clickDisplacement > .01 && r.decision?.fallback !== 'anchor-yield').length, pass: moved.length === 0 && packing.every((r: any) => r.engine !== "proposed" || !(r.clickDisplacement > .01) || r.decision?.fallback === 'anchor-yield') },
  { target: 'Legal click anchors stationary, dense tours (fan-in ≤4 and ≤10)', baseline: clicks(denseTours, 'baseline').length, proposed: denseMoved.length, pass: denseMoved.length === 0 },
  { target: 'Mean legal displacement ≤baseline px', baseline: tours.summary.baseline.displacement, proposed: tours.summary.proposed.displacement, pass: tours.summary.proposed.displacement <= tours.summary.baseline.displacement },
  { target: 'Mean legal height ≥15% lower px', baseline: tours.summary.baseline.height, proposed: tours.summary.proposed.height, pass: tours.summary.proposed.height <= tours.summary.baseline.height * .85 },
  { target: '>10% height regressions without stability reason', baseline: 0, proposed: unpricedHeight.length, pass: unpricedHeight.length === 0 },
  { target: 'Hard gate violations/errors (corpus + tours incl. dense + packing)', baseline: totalHard(broad.rows.filter((r: any) => r.engine === 'baseline')) + totalHard(tours.rows.map((r: any) => ({ proposed: r.baseline }))) + totalHard(packing.filter((r: any) => r.engine === 'baseline')), proposed: totalHard(newRows) + totalHard(tours.rows) + totalHard(packing.filter((r: any) => r.engine === 'proposed')) + newRows.filter((r: any) => r.error).length + packing.filter((r: any) => r.engine === 'proposed' && r.error).length, pass: false },
  { target: 'Shared lanes between sources, not a listed fallback (corpus + tours incl. dense)', baseline: broad.rows.filter((r: any) => r.engine === 'baseline' && r.metrics?.sharedLanePx > 0).length, proposed: unexplainedLanes.length, pass: unexplainedLanes.length === 0 },
  { target: 'Mean crossings ≤ baseline', baseline: crossingMean('baseline'), proposed: crossingMean('proposed'), pass: crossingMean('proposed') <= crossingMean('baseline') },
  { target: `Crossing regressions not paid for by ${broad.readability.crossingHeightTiles} tile widths of height per extra crossing`, baseline: 0, proposed: broad.readability.unpricedCrossingRegressions, pass: broad.readability.unpricedCrossingRegressions === 0 },
  { target: 'Cases with worse p95 than baseline', baseline: 0, proposed: perfRegressions.length, pass: perfRegressions.length === 0 },
  { target: 'Maximum p95 for main-thread requests (dispatch rule: ≤20 current+history tiles, ≤20 edges) ≤5ms', baseline: maxSmall('baseline'), proposed: maxSmall('proposed'), pass: smallSlow.length === 0 },
  { target: 'Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms', baseline: maxVisible('baseline'), proposed: maxVisible('proposed'), pass: maxVisible('proposed') <= 5 },
];
const gates = acceptance.find(r => r.target.startsWith('Hard gate'))!;
gates.pass = gates.proposed === 0;
const laneList = laneCases.length ? ['| Source | Case | Width / image | Step | Candidate | Shared lane px | Reason |', '|---|---|---|---:|---|---:|---|',
  ...laneCases.map((r: any) => `| ${r.source} | ${r.case} | ${r.width} / ${r.imagePx} | ${r.step} | ${r.candidate} | ${r.sharedLanePx.toFixed(1)} | ${r.reason ?? '**unexplained**'} |`)].join('\n') : 'None.';
const table = ['| Acceptance target | Baseline | New | Result |', '|---|---:|---:|---|', ...acceptance.map(r => `| ${r.target} | ${Number(r.baseline).toFixed(3)} | ${r.proposed.toFixed(3)} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
const metrics = ['| Metric (mean per layout) | Baseline | New |', '|---|---:|---:|', ...Object.keys(broad.summary.baseline.mean).map(k => `| ${k} | ${broad.summary.baseline.mean[k].toFixed(3)} | ${broad.summary.proposed.mean[k].toFixed(3)} |`)].join('\n');
const report = `${table}\n\n${metrics}\n\nExplicit anchor fallbacks (anchor-infeasible): ${moved.length}. Anchors yielded to the crossing cap (anchor-yield): ${yields.length}${yields.length ? ` (${yields.map((r: any) => `${r.case} ${r.width} step ${r.step}`).join('; ')})` : ''}. Height exceptions selected for stability: ${heightExceptions.length - unpricedHeight.length}.\n\n### Dense tours\n\n| Fan-in | Steps | Clicks | Anchors moved (baseline) | Anchors moved (new, not yielded) | anchor-infeasible | anchor-yield | lane-infeasible | gate-infeasible |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${denseBreakdown.map(d => `| ≤${d.fanIn} | ${d.steps} | ${d.clicks} | ${d.baselineMoved} | ${d.moved} | ${d.anchorInfeasible} | ${d.anchorYield} | ${d.laneInfeasible} | ${d.gateInfeasible} |`).join('\n')}\n\nDense tours, mean height ${tours.denseSummary.baseline.height.toFixed(1)} → ${tours.denseSummary.proposed.height.toFixed(1)} px, mean displacement ${tours.denseSummary.baseline.displacement.toFixed(2)} → ${tours.denseSummary.proposed.displacement.toFixed(2)} px.\n\n### Shared lanes shown (listed fallbacks)\n\n${laneList}\n\n${await readFile(`${out}/readability.md`, 'utf8')}\n${await readFile(`${out}/perf.log`, 'utf8')}`;
await writeFile(`${out}/acceptance.md`, report);
await writeFile(`${out}/acceptance.json`, JSON.stringify({ acceptance, moved, yields, denseMoved, denseBreakdown, heightExceptions, perfRegressions, smallSlow, laneCases }, null, 2));
console.log(report);
if (acceptance.some(r => !r.pass)) process.exitCode = 1;
