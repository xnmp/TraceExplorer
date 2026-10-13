/** Run with env -u OPENAI_API_KEY bun layout-eval/bench.ts [--quick]. */
delete process.env.OPENAI_API_KEY;
import { mkdir, writeFile } from 'node:fs/promises';
import { layoutGraph, type GraphLayout } from './baseline/layout';
import { corpus, requestFor, screenshot } from './corpus';
import { measure, type Measures } from './geometry';
import { optimizedBand, type Optimized } from './engine';
import { svg, gallery } from './render';
import { attached } from './baseline/placement';
import { attachSingleBand } from '../src/lib/domain/trace-graph/band-geometry';
const quick = process.argv.includes('--quick'), stability = 1.5;
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
    engine: string;
    candidate: string;
    ms: number;
    metrics: Measures | null;
    error?: string;
    changed: boolean;
    decision?: import("../src/lib/domain/trace-graph/layout").BandDecision;
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
                    let result: GraphLayout | undefined, candidate = engine, ms = 0, error: string | undefined;
                    try {
                        if (engine === 'baseline') {
                            base = layoutGraph(request);
                            result = base;
                        }
                        else {
                            proposed = optimizedBand({ ...request, hint: prevPrototype?.layout.readingOrder }, { previous: prevPrototype, stability, anchorKey: focus ?? undefined });
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
                    rows.push({ case: c.id, width, imagePx, step, focus, visible: request.items.length, total: request.band!.items.length, engine, candidate, ms, metrics, error, changed, decision: engine === "proposed" ? proposed?.layout.decision : undefined });
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
const output = { meta: { seedFamily: 7000, widths, imagePx: presets, caseCount: cases.length, stability, bun: Bun.version, platform: process.platform, arch: process.arch, curveSubdivisions: 12, timing: 'one warmed execution per case; no IO/attachment/measurement in timings, production includes internal scoring and attachment' }, summary, comparison, rows };
await writeFile(`${outputDir}/results.json`, JSON.stringify(output, null, 2));
const metricKeys = Object.keys(rows.find(r => r.metrics)!.metrics!) as (keyof Measures)[];
const csv = [['case', 'width', 'imagePx', 'step', 'focus', 'visible', 'total', 'engine', 'candidate', 'ms', 'changed', 'error', ...metricKeys].join(','), ...rows.map(r => [r.case, r.width, r.imagePx, r.step, r.focus ?? '', r.visible, r.total, r.engine, r.candidate, r.ms, r.changed, JSON.stringify(r.error ?? ''), ...metricKeys.map(k => r.metrics?.[k] ?? '')].join(','))].join('\n');
await writeFile(`${outputDir}/results.csv`, csv);
await writeFile(`${outputDir}/index.html`, gallery(renders));
const reportTable = ['| Metric (mean per layout) | Baseline | Proposed |', '|---|---:|---:|', ...(['height', 'area', 'whitespace', 'paneWhitespace', 'length', 'bends', 'crossings', 'sharedLanePx', 'tileIntersections', 'overlaps', 'directionViolations', 'mixedDirections', 'siblingInversions', 'unaligned', 'overflow', 'missingEdges', 'extraEdges'] as const).map(k => `| ${k} | ${summary.baseline.mean[k]?.toFixed(3)} | ${summary.proposed.mean[k]?.toFixed(3)} |`), `| selection displacement (changed sets only) | ${summary.baseline.stability.mean.toFixed(3)} | ${summary.proposed.stability.mean.toFixed(3)} |`, `| layout time p50 / p95 / max (ms) | ${Object.values(summary.baseline.timing).map(n => n.toFixed(3)).join(' / ')} | ${Object.values(summary.proposed.timing).map(n => n.toFixed(3)).join(' / ')} |`].join('\n');
await writeFile(`${outputDir}/summary.md`, `${reportTable}\n\n${JSON.stringify(comparison)}\n`);
console.log(JSON.stringify({ meta: output.meta, summary, comparison }, null, 2));
