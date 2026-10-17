/** Acceptance is executable; a failed target is never silently converted to a warning. */
delete process.env.OPENAI_API_KEY;
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { requestFor, screenshot } from './corpus';
import { optimizedBand } from './engine';
import { measure } from './geometry';
import { layoutGraph as baselineLayout } from './baseline/layout';
import { attached as baselineAttached } from './baseline/placement';
import main from './main-reference.json';
import mainMovement from './main-movement-reference.json';
const out = 'layout-eval/out';
// `--engine=<name>` picks the registered folder layout engine the packing cases run through the seam.
const engineArgs = process.argv.slice(2).filter(a => a.startsWith('--engine='));
await mkdir(out, { recursive: true });
for (const name of ['bench', 'reveals', 'packing', 'perf']) {
  console.log(`Running ${name}...`);
  const file = Bun.file(`${out}/${name}.log`);
  await writeFile(`${out}/${name}.log`, '');
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
const moved = anchorMoves.filter((r: any) => !r.revisited && r.decision?.fallback !== 'anchor-yield');
// Dense tours (fan-in up to 4 and 10): anchor stability where merges crowd every lane.
const denseMoves = clicks(denseTours, 'proposed'), denseMoved = denseMoves.filter((r: any) => !r.revisited && r.decision?.fallback !== 'anchor-yield');
const denseBreakdown = [4, 10].map(f => {
  const rows = denseTours.filter((r: any) => r.case.startsWith(`dense-f${f}-`)), count = (fallback: string) => rows.filter((r: any) => r.decision?.fallback === fallback).length;
  return { fanIn: f, steps: rows.length, clicks: rows.filter((r: any) => r.focus && r.changed).length, baselineMoved: clicks(rows, 'baseline').length, moved: clicks(rows, 'proposed').filter((r: any) => !r.revisited && r.decision?.fallback !== 'anchor-yield').length,
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
  { target: 'All legal click anchors stationary (including real packing)', baseline: clicks(broadTours, 'baseline').length, proposed: moved.length + packing.filter((r: any) => r.engine === "proposed" && r.clickDisplacement > .01 && !r.revisited && r.decision?.fallback !== 'anchor-yield').length, pass: moved.length === 0 && packing.every((r: any) => r.engine !== "proposed" || !(r.clickDisplacement > .01) || r.revisited || r.decision?.fallback === 'anchor-yield') },
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
// The older frozen engine remains diagnostic. These are the current product gates
// against the re-measured origin/main revision, independent of that older baseline.
const screen = (rows: any[], height: number) => rows.filter(r => r.changed && r.focus && r.screen[height].anchor > .01).length;
const geometryFallback = (r: any) => ['geometry-fallback', 'isolated-rows', 'safe-rows', 'pin-search-exhausted'].includes(r.decision?.fallback);
const fallbackRows = { corpus: newRows, tours: tours.rows, packing: packing.filter((r: any) => r.engine === 'proposed') };
const fallbacks = Object.fromEntries(Object.entries(fallbackRows).map(([name, rows]) => [name, {
  states: rows.length, count: rows.filter(geometryFallback).length,
  outsidePane: rows.filter((r: any) => geometryFallback(r) && (r.metrics?.overflow ?? r.proposed?.overflow ?? r.overflow ?? 0) > .01).length,
}]));
const movement = {
  corpus: { main: mainMovement.corpus, proposed: broad.movement.proposed },
  broad: { main: mainMovement.broad, proposed: tours.movement.proposed.broad },
  dense: { main: mainMovement.dense, proposed: tours.movement.proposed.dense },
};
// Preserve both existing corpus denominators; the broad-tour contract uses
// changed transitions. Dense movement and broad anchor splits remain diagnostics.
const movementTargets = [
  ...(['mean', 'changed'] as const).flatMap(population =>
    (['movedFraction', 'anchorDisplacement'] as const).map(metric => ({ source: 'corpus' as const, population, metric }))),
  { source: 'broad' as const, population: 'changed' as const, metric: 'movedFraction' as const },
].map(({ source, population, metric }) => ({
  target: `${source} new-state ${population === 'mean' ? 'per-layout' : 'transition'} ${metric}`,
  main: movement[source].main.newStates[population]![metric],
  proposed: movement[source].proposed.newStates[population]?.[metric] ?? Infinity,
  limit: movement[source].main.newStates[population]![metric] * 1.1,
}));
const movementTable = ['| Population | Kind | Layouts | Transitions | Per-layout moved fraction | Transition moved fraction | Per-layout anchor px | Transition anchor px |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(movement).flatMap(([source, pair]) => Object.entries(pair).flatMap(([engine, split]) =>
    Object.entries(split).map(([kind, value]: [string, any]) => `| ${source} ${engine} | ${kind} | ${value.layouts} | ${value.transitions} | ${value.mean?.movedFraction.toFixed(6) ?? '—'} | ${value.changed?.movedFraction.toFixed(6) ?? '—'} | ${value.mean?.anchorDisplacement.toFixed(6) ?? '—'} | ${value.changed?.anchorDisplacement.toFixed(6) ?? '—'} |`))),
].join('\n');
const taskAcceptance = [
  ...movementTargets,
  { target: 'Click anchor moves, including packing', main: main.acceptance[2].proposed, proposed: acceptance[2].proposed, limit: 32 },
  { target: 'Dense-tour anchor moves', main: main.acceptance[3].proposed, proposed: denseMoved.length, limit: 101 },
  { target: 'Mean legal displacement, px', main: main.summary.displacement, proposed: tours.summary.proposed.displacement, limit: 17.53 },
  { target: 'Unexplained height regressions', main: 0, proposed: unpricedHeight.length, limit: 0 },
  ...[false, true].map(dense => ({ target: `Held-screen moves at 480 px (${dense ? 'dense' : 'broad'})`, main: main.screen['480'][dense ? 'dense' : 'broad'],
    proposed: screen(dense ? denseTours : broadTours, 480), limit: main.screen['480'][dense ? 'dense' : 'broad'] })),
  { target: 'Hard violations/errors', main: 0, proposed: gates.proposed, limit: 0 },
  { target: 'Independent geometry gate failures', main: 0, proposed: [...newRows, ...tours.rows, ...packing.filter((r: any) => r.engine === 'proposed')].filter(r => r.independentFailure).length, limit: 0 },
  { target: 'Unexplained shared connector lanes', main: 0, proposed: unexplainedLanes.length, limit: 0 },
  { target: 'Main-thread maximum p95, ms', main: main.acceptance[12].proposed, proposed: maxSmall('proposed'), limit: 8 },
  { target: '≤30 visible tiles maximum p95, ms', main: main.acceptance[13].proposed, proposed: maxVisible('proposed'), limit: 100 },
  { target: 'Full folder engine maximum inline p95, ms (no saved main measurement)', main: NaN, proposed: Math.max(...timing.folders.map((r: any)=>r.p95)), limit: 5 },
  ...Object.keys(main.mean).filter(metric => !['movedFraction', 'anchorDisplacement'].includes(metric)).map(metric => ({
    target: `Mean ${metric}`, main: (main.mean as Record<string, number>)[metric], proposed: broad.summary.proposed.mean[metric],
    limit: (main.mean as Record<string, number>)[metric] * (['height','overflow'].includes(metric) ? 1 : 1.1),
  })),
  ...Object.entries(fallbacks).flatMap(([name, f]) => [
    { target: `${name} geometry fallback rate, %`, main: main.fallbacks[name as keyof typeof main.fallbacks].count / main.fallbacks[name as keyof typeof main.fallbacks].states * 100,
      proposed: f.count / f.states * 100, limit: name === 'packing' ? 0 : .5 },
    { target: `${name} geometry fallbacks outside pane`, main: 0, proposed: f.outsidePane, limit: 0 },
  ]),
].map(row => ({ ...row, pass: row.proposed <= row.limit + 1e-9 }));
const taskTable = ['| Current target | Main 75e46b0 | This pass | Limit | Result |', '|---|---:|---:|---:|---|',
  ...taskAcceptance.map(r => `| ${r.target} | ${r.main.toFixed(3)} | ${r.proposed.toFixed(3)} | ${r.limit.toFixed(3)} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
const laneList = laneCases.length ? ['| Source | Case | Width / image | Step | Candidate | Shared lane px | Reason |', '|---|---|---|---:|---|---:|---|',
  ...laneCases.map((r: any) => `| ${r.source} | ${r.case} | ${r.width} / ${r.imagePx} | ${r.step} | ${r.candidate} | ${r.sharedLanePx.toFixed(1)} | ${r.reason ?? '**unexplained**'} |`)].join('\n') : 'None.';
const table = ['| Acceptance target | Baseline | New | Result |', '|---|---:|---:|---|', ...acceptance.map(r => `| ${r.target} | ${Number(r.baseline).toFixed(3)} | ${r.proposed.toFixed(3)} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
const metrics = ['| Metric (mean per layout) | Baseline | New |', '|---|---:|---:|', ...Object.keys(broad.summary.baseline.mean).map(k => `| ${k} | ${broad.summary.baseline.mean[k].toFixed(3)} | ${broad.summary.proposed.mean[k].toFixed(3)} |`)].join('\n');
const report = `${table}\n\n${metrics}\n\nExplicit anchor fallbacks (anchor-infeasible): ${moved.length}. Anchors yielded to the crossing cap (anchor-yield): ${yields.length}${yields.length ? ` (${yields.map((r: any) => `${r.case} ${r.width} step ${r.step}`).join('; ')})` : ''}. Height exceptions selected for stability: ${heightExceptions.length - unpricedHeight.length}.\n\n### Dense tours\n\n| Fan-in | Steps | Clicks | Anchors moved (baseline) | Anchors moved (new, not yielded) | anchor-infeasible | anchor-yield | lane-infeasible | gate-infeasible |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${denseBreakdown.map(d => `| ≤${d.fanIn} | ${d.steps} | ${d.clicks} | ${d.baselineMoved} | ${d.moved} | ${d.anchorInfeasible} | ${d.anchorYield} | ${d.laneInfeasible} | ${d.gateInfeasible} |`).join('\n')}\n\nDense tours, mean height ${tours.denseSummary.baseline.height.toFixed(1)} → ${tours.denseSummary.proposed.height.toFixed(1)} px, mean displacement ${tours.denseSummary.baseline.displacement.toFixed(2)} → ${tours.denseSummary.proposed.displacement.toFixed(2)} px.\n\n### Shared lanes shown (listed fallbacks)\n\n${laneList}\n\n${await readFile(`${out}/readability.md`, 'utf8')}\n${await readFile(`${out}/perf.log`, 'utf8')}`;
await writeFile(`${out}/acceptance.md`, `${taskTable}\n\n${movementTable}\n\nHistorical frozen-baseline diagnostics (retain their original thresholds):\n\n${report}`);
await writeFile(`${out}/acceptance.json`, JSON.stringify({ movement, taskAcceptance, fallbacks, acceptance, moved, yields, denseMoved, denseBreakdown, heightExceptions, perfRegressions, smallSlow, laneCases }, null, 2));
console.log(taskTable + '\n\n' + movementTable + '\n\n' + report);
// Historical frozen-baseline rows remain diagnostic; the user's current main-relative
// targets (including verified revisit exclusions) decide this command's result.
if (taskAcceptance.some(r => !r.pass)) process.exitCode = 1;
