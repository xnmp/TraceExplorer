/** Run with env -u OPENAI_API_KEY bun layout-eval/bench.ts [--quick]. */
delete process.env.OPENAI_API_KEY;
import { mkdir, writeFile } from 'node:fs/promises';
import { layoutGraph, type GraphLayout } from './baseline/layout';
import { corpus, requestFor, screenshot } from './corpus';
import { measure, CROSSING_HEIGHT_TILES, type Measures } from './geometry';
import { optimizedBand, type Optimized } from './engine';
import { svg, gallery } from './render';
import { attached } from './baseline/placement';
import { attachSingleBand } from '../src/lib/domain/trace-graph/band-geometry';
import { profileLayout, type LayoutProfile } from '../src/lib/domain/trace-graph/layout-profile';
import { geometryGate } from '../src/lib/domain/trace-graph/geometry-gate';
import { movementSummary } from './movement-summary';
import { DEFAULT_WEIGHTS } from '../src/lib/domain/trace-graph/layout-quality';
import { fallbackReason } from '../src/lib/domain/trace-graph/band-layout';
const quick = process.argv.includes('--quick'), stability = DEFAULT_WEIGHTS.stability;
const widths = quick ? [454, 900] : [360, 454, 640, 900, 1400], presets = quick ? [96] : [48, 64, 96, 128];
const outputDir = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? (quick ? 'layout-eval/out/quick' : 'layout-eval/out');
const cases = quick ? corpus().filter(c => !c.id.startsWith('random-') || c.id.includes('-40-')) : corpus();
interface Row {
    case: string;
    width: number;
    imagePx: number;
    step: number;
    focus: string | null;
    visible: number;
    total: number;
    tileWidth: number;
    engine: string;
    candidate: string;
    ms: number;
    metrics: Measures | null;
    error?: string;
    changed: boolean;
    independentFailure?: string | null;
    revisited?: boolean;
    work?: LayoutProfile;
    decision?: import("../src/lib/domain/trace-graph/layout").BandDecision;
    /** Why a proposed layout is an explicit fallback, from the layout itself (`fallbackReason`). */
    reason?: string | null;
}
const rows: Row[] = [], renders: {
    name: string;
    description: string;
}[] = [];
await mkdir(outputDir, { recursive: true });
// Warm both engines independently before measuring. Evaluation, attachment and IO are excluded from layout timings.
const warm = requestFor(screenshot, 'Saffron', 454, 96);
for (let i = 0; i < 12; i++) {
    layoutGraph(warm);
    optimizedBand(warm);
}
for (const c of cases)
    for (const imagePx of presets)
        for (const width of widths) {
            let prevBaseline: GraphLayout | undefined, prevPrototype: Optimized | undefined, prevAttachedB: GraphLayout | undefined, prevAttachedP: GraphLayout | undefined, oldVisible = '';
            for (const [step, focus] of c.focuses.entries()) {
                const request = requestFor(c, focus, width, imagePx, prevBaseline?.readingOrder), keys = request.items.map(i => i.key).sort().join(','), changed = step > 0 && keys !== oldVisible;
                oldVisible = keys;
                let base: GraphLayout | undefined, proposed: Optimized | undefined;
                for (const engine of ['baseline', 'proposed']) {
                    const start = performance.now();
                    let work: LayoutProfile | undefined;
                    let result: GraphLayout | undefined, candidate = engine, ms = 0, error: string | undefined;
                    try {
                        if (engine === 'baseline') {
                            base = layoutGraph(request);
                            result = base;
                        }
                        else {
                            const run = () => optimizedBand({ ...request, hint: prevPrototype?.layout.readingOrder }, { previous: prevPrototype, stability, anchorKey: focus ?? undefined });
                            if (process.argv.includes('--stages')) { const traced = profileLayout(run); proposed = traced.result; work = traced.profile; }
                            else proposed = run();
                            result = proposed.layout;
                            candidate = proposed.candidate;
                        }
                        ms = performance.now() - start;
                    }
                    catch (e) {
                        ms = performance.now() - start;
                        error = String(e);
                    }
                    const placed = result ? (engine === 'baseline' ? attached(result, request) : attachSingleBand(result, request)) : undefined;
                    const metrics = placed ? measure(placed, request.band!.key, width, request.items, changed ? (engine === 'baseline' ? prevAttachedB : prevAttachedP) : undefined, focus ?? undefined) : null;
                    rows.push({ revisited: engine === "proposed" ? proposed?.revisited : undefined, independentFailure: engine === "proposed" && placed ? geometryGate(placed, request.items, request.band!.key, width) : undefined, work, case: c.id, width, imagePx, step, focus, visible: request.items.length, total: request.band!.items.length, tileWidth: request.tileWidth ?? 92, engine, candidate, ms, metrics, error, changed, decision: engine === "proposed" ? proposed?.layout.decision : undefined, reason: engine === "proposed" && proposed ? fallbackReason(proposed.layout) : null });
                    if (rows.length % 500 === 0)
                        console.log(`Completed ${rows.length} engine runs (${c.id}, ${width}px, image ${imagePx})`);
                    if (placed) {
                        if (engine === 'baseline')
                            prevAttachedB = placed;
                        else
                            prevAttachedP = placed;
                    }
                    const chosen = (c.id === 'screenshot' && step === 1 && imagePx === 96 && [454, 900].includes(width)) || (['chain-20', 'mixed-depth', 'hidden-siblings', 'merges-3', 'fan-30'].includes(c.id) && step === (c.id === 'mixed-depth' ? 3 : c.id === 'chain-20' ? 3 : 1) && imagePx === 96 && width === 454);
                    if (chosen && placed) {
                        const name = `${c.id}-${width}-${imagePx}-${engine}.svg`, description = `${c.id}, ${width}px, image ${imagePx}, focus ${focus ?? 'none'}: ${candidate}`;
                        await writeFile(`${outputDir}/${name}`, svg(placed, request, description));
                        renders.push({ name, description });
                    }
                }
                if (base)
                    prevBaseline = base;
                if (proposed)
                    prevPrototype = proposed;
            }
        }
const average = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const percentile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;
const summary = Object.fromEntries(['baseline', 'proposed'].map(engine => { const rs = rows.filter(r => r.engine === engine), ok = rs.filter(r => r.metrics), m = ok.map(r => r.metrics!); return [engine, { layouts: rs.length, errors: rs.filter(r => r.error).length, invalid: ok.filter(r => r.metrics!.overlaps || r.metrics!.tileIntersections || r.metrics!.directionViolations || r.metrics!.missingEdges || r.metrics!.extraEdges || r.metrics!.missingNodes || r.metrics!.extraNodes || r.metrics!.invalidGeometry || r.metrics!.invalidPaths || r.metrics!.terminalViolations || r.metrics!.disconnectedEdges).length, mean: Object.fromEntries(Object.keys(m[0] ?? {}).map(k => [k, average(m.map(v => v[k as keyof Measures]))])), stability: { transitions: ok.filter(r => r.changed).length, mean: average(ok.filter(r => r.changed).map(r => r.metrics!.displacement)), p95Max: percentile(ok.filter(r => r.changed).map(r => r.metrics!.maxDisplacement), .95), movedFraction: average(ok.filter(r => r.changed).map(r => r.metrics!.movedFraction)) }, timing: { median: percentile(rs.map(r => r.ms), .5), p95: percentile(rs.map(r => r.ms), .95), max: Math.max(...rs.map(r => r.ms)) } }]; }));
const pairs = rows.filter(r => r.engine === 'baseline').map((b, i) => ({ b, p: rows[i * 2 + 1] })).filter(({ b, p }) => b.metrics && p.metrics);
const comparison = { pairs: pairs.length, heightWins: pairs.filter(({ b, p }) => p.metrics!.height < b.metrics!.height - .5).length, heightTies: pairs.filter(({ b, p }) => Math.abs(p.metrics!.height - b.metrics!.height) <= .5).length, heightRegressions: pairs.filter(({ b, p }) => p.metrics!.height > b.metrics!.height + .5).length, inkRegressions: pairs.filter(({ b, p }) => p.metrics!.length > b.metrics!.length + .5).length, crossingRegressions: pairs.filter(({ b, p }) => p.metrics!.crossings > b.metrics!.crossings).length };
// Readability: crossing regressions and shared lanes, worst first, with SVG pairs.
// A layout may cross more than the baseline only where each extra crossing buys at least
// CROSSING_HEIGHT_TILES tile widths of band height (the calibrated exchange rate the
// objective uses); every shared lane must be an explicit, listed fallback.
const crossingRegressions = pairs.filter(({ b, p }) => p.metrics!.crossings > b.metrics!.crossings).map(({ b, p }) => {
    const extra = p.metrics!.crossings - b.metrics!.crossings, saved = b.metrics!.height - p.metrics!.height, needed = extra * CROSSING_HEIGHT_TILES * p.tileWidth;
    return { case: p.case, width: p.width, imagePx: p.imagePx, step: p.step, candidate: p.candidate, stability: !!p.decision?.stability, baseline: b.metrics!.crossings, proposed: p.metrics!.crossings, extra, saved, needed, priced: saved >= needed };
}).sort((x, y) => Number(x.priced) - Number(y.priced) || y.extra - x.extra || x.saved - y.saved);
const sharedLanes = rows.filter(r => r.engine === 'proposed' && r.metrics && r.metrics.sharedLanePx > 0).map(r => ({ case: r.case, width: r.width, imagePx: r.imagePx, step: r.step, candidate: r.candidate, sharedLanePx: r.metrics!.sharedLanePx,
    reason: r.reason ?? null }))
    .sort((x, y) => y.sharedLanePx - x.sharedLanePx);
const baselineLanes = pairs.filter(({ b }) => b.metrics!.sharedLanePx > 0).sort((x, y) => y.b.metrics!.sharedLanePx - x.b.metrics!.sharedLanePx);
const readability = { crossingHeightTiles: CROSSING_HEIGHT_TILES, crossingRegressions: crossingRegressions.length, unpricedCrossingRegressions: crossingRegressions.filter(r => !r.priced).length,
    sharedLaneLayouts: sharedLanes.length, unexplainedSharedLanes: sharedLanes.filter(r => !r.reason).length, sharedLanes, worstCrossings: crossingRegressions.slice(0, 40) };
const worstN = 20, pictured = 6;
const pairKey = (r: { case: string; width: number; imagePx: number; step: number }) => `${r.case}|${r.width}|${r.imagePx}|${r.step}`;
/** Replays a bench sequence to one step, giving both engines' attached layouts and the request. */
const replay = (id: string, width: number, imagePx: number, at: number) => {
    const c = cases.find(c => c.id === id)!;
    let prevBaseline: GraphLayout | undefined, prevPrototype: Optimized | undefined;
    for (const [step, focus] of c.focuses.entries()) {
        const request = requestFor(c, focus, width, imagePx, prevBaseline?.readingOrder);
        const base = layoutGraph(request), proposed = optimizedBand({ ...request, hint: prevPrototype?.layout.readingOrder }, { previous: prevPrototype, stability, anchorKey: focus ?? undefined });
        if (step === at) return { request, baseline: attached(base, request), proposed: attachSingleBand(proposed.layout, request), candidate: proposed.candidate };
        prevBaseline = base; prevPrototype = proposed;
    }
    throw new Error(`no step ${at} in ${id}`);
};
const readabilityRenders: { name: string; description: string }[] = [];
const picture = async (kind: string, list: readonly { case: string; width: number; imagePx: number; step: number }[]) => {
    for (const r of list.slice(0, pictured)) {
        const { request, baseline, proposed, candidate } = replay(r.case, r.width, r.imagePx, r.step), stem = `${kind}-${r.case}-${r.width}-${r.imagePx}-${r.step}`;
        await writeFile(`${outputDir}/${stem}-baseline.svg`, svg(baseline, request, `${r.case}, ${r.width}px, image ${r.imagePx}, step ${r.step}: baseline`));
        await writeFile(`${outputDir}/${stem}-proposed.svg`, svg(proposed, request, `${r.case}, ${r.width}px, image ${r.imagePx}, step ${r.step}: ${candidate}`));
        readabilityRenders.push({ name: `${stem}-baseline.svg`, description: `${kind}: ${r.case} ${r.width}px/${r.imagePx} step ${r.step}, baseline` }, { name: `${stem}-proposed.svg`, description: `${kind}: ${r.case} ${r.width}px/${r.imagePx} step ${r.step}, ${candidate}` });
    }
};
// One picture per case, its worst: neighbouring widths, presets and steps usually repeat it.
const distinct = <T extends { case: string; width: number; imagePx: number; step: number }>(list: readonly T[]) => list.filter((r, i) => list.findIndex(o => o.case === r.case) === i);
await picture('crossings', distinct(crossingRegressions));
await picture('lanes', distinct(sharedLanes.length ? sharedLanes : baselineLanes.map(({ p }) => p)));
await writeFile(`${outputDir}/readability.html`, gallery(readabilityRenders));
const crossingTable = ['| Case | Width / image | Step | Candidate | Crossings baseline → new | Height saved px | Needed px | Priced |', '|---|---|---:|---|---:|---:|---:|---|',
    ...crossingRegressions.slice(0, worstN).map(r => `| ${r.case} | ${r.width} / ${r.imagePx} | ${r.step} | ${r.candidate}${r.stability ? ' (stability)' : ''} | ${r.baseline} → ${r.proposed} | ${r.saved.toFixed(0)} | ${r.needed.toFixed(0)} | ${r.priced ? 'yes' : '**no**'} |`)].join('\n');
const laneTable = sharedLanes.length
    ? ['| Case | Width / image | Step | Candidate | Shared lane px | Reason |', '|---|---|---:|---|---:|---|', ...sharedLanes.slice(0, worstN).map(r => `| ${r.case} | ${r.width} / ${r.imagePx} | ${r.step} | ${r.candidate} | ${r.sharedLanePx.toFixed(1)} | ${r.reason ?? '**none**'} |`)].join('\n')
    : ['No production layout shares a lane. Worst baseline layouts, for comparison:', '', '| Case | Width / image | Step | Baseline px | New px |', '|---|---|---:|---:|---:|', ...baselineLanes.slice(0, worstN).map(({ b, p }) => `| ${b.case} | ${b.width} / ${b.imagePx} | ${b.step} | ${b.metrics!.sharedLanePx.toFixed(1)} | ${p.metrics!.sharedLanePx.toFixed(1)} |`)].join('\n');
await writeFile(`${outputDir}/readability.md`, `## Crossing regressions (worst ${worstN} of ${crossingRegressions.length}; ${readability.unpricedCrossingRegressions} not paid for by ${CROSSING_HEIGHT_TILES} tile widths of height per extra crossing)\n\n${crossingTable}\n\n## Shared lanes (${sharedLanes.length} production layouts)\n\n${laneTable}\n\nSVG pairs: readability.html\n`);
const movement = Object.fromEntries(['baseline', 'proposed'].map(engine => [engine, movementSummary(rows.filter(r => r.engine === engine))]));
const output = { movement, meta: { seedFamily: 7000, widths, imagePx: presets, caseCount: cases.length, stability, bun: Bun.version, platform: process.platform, arch: process.arch, curveSubdivisions: 12, timing: 'one warmed execution per case; no IO/attachment/measurement in timings, production includes internal scoring and attachment' }, summary, comparison, readability, rows };
await writeFile(`${outputDir}/results.json`, JSON.stringify(output, null, 2));
const metricKeys = Object.keys(rows.find(r => r.metrics)!.metrics!) as (keyof Measures)[];
const csv = [['case', 'width', 'imagePx', 'step', 'focus', 'visible', 'total', 'engine', 'candidate', 'ms', 'changed', 'error', ...metricKeys].join(','), ...rows.map(r => [r.case, r.width, r.imagePx, r.step, r.focus ?? '', r.visible, r.total, r.engine, r.candidate, r.ms, r.changed, JSON.stringify(r.error ?? ''), ...metricKeys.map(k => r.metrics?.[k] ?? '')].join(','))].join('\n');
await writeFile(`${outputDir}/results.csv`, csv);
await writeFile(`${outputDir}/index.html`, gallery(renders));
const reportTable = ['| Metric (mean per layout) | Baseline | Proposed |', '|---|---:|---:|', ...(['height', 'area', 'whitespace', 'paneWhitespace', 'length', 'bends', 'crossings', 'sharedLanePx', 'tileIntersections', 'overlaps', 'directionViolations', 'mixedDirections', 'siblingInversions', 'unaligned', 'overflow', 'missingEdges', 'extraEdges'] as const).map(k => `| ${k} | ${summary.baseline.mean[k]?.toFixed(3)} | ${summary.proposed.mean[k]?.toFixed(3)} |`), `| selection displacement (changed sets only) | ${summary.baseline.stability.mean.toFixed(3)} | ${summary.proposed.stability.mean.toFixed(3)} |`, `| layout time p50 / p95 / max (ms) | ${Object.values(summary.baseline.timing).map(n => n.toFixed(3)).join(' / ')} | ${Object.values(summary.proposed.timing).map(n => n.toFixed(3)).join(' / ')} |`].join('\n');
await writeFile(`${outputDir}/summary.md`, `${reportTable}\n\n${JSON.stringify(comparison)}\n`);
console.log(JSON.stringify({ meta: output.meta, summary, comparison }, null, 2));
