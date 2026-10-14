# Production layout evaluation

Run `bun run layout:eval` from the repository root. No network or API calls are made;
`OPENAI_API_KEY` is removed. Generated artifacts go to the git-ignored `out/`. The script
exits non-zero when any acceptance target fails.

`baseline/` freezes the domain layout, metrics, attachment, path helpers and skyline
packing from `34ed9a2de1d8ab3c4190b590e0054be3ac32c394`, the engine before plan phase 2.
Production comparisons call the public `layoutGraph` entry point; the complete topology
determines captions and history validity, while only visible items determine placement.

The corpus includes Cerulean/Saffron, fans, chains, merges, hidden descendants, malformed
backend graphs after projection and seeded trees/DAGs. The broad run contains 6,060 paired
states at widths 360/454/640/900/1400 and thumbnail presets 48/64/96/128. The legal tour
chooses only already-visible expandable tiles. Packing exercises the real domain grid
pipeline, including history on a later packed line.

Timings (`perf.ts`) run every corpus case at 454 px / preset 96, plus its first legal
committed reveal where one exists, after twelve warm-up calls per engine. The engines
alternate which runs first in each pair; at least 40 pairs are taken, and fast cases take
more (up to 400 pairs, about 2 s per case) so a tail percentile is not decided by one or
two scheduler interruptions. Prior layouts and attachment are prepared before timing; the
public layout call includes history validation and candidate evaluation. Run timings
without other benchmark or browser jobs on the machine: p95 comparisons of sub-millisecond
cases are sensitive to load. The report records the load average before and after the run.

`fingerprint.ts` hashes every production layout the evaluation produces, per case. Run it
with `--out=before.json` before a performance-only change and `--compare=before.json`
after: any differing case means the change altered geometry or decisions.

The 5 ms target is reported twice. "Main-thread" requests follow the view's dispatch rule
(`canLayoutInline`: at most 30 current plus committed-history tiles, and 40 current input
edges plus history routes); larger requests run in the worker. The table also checks every
case with at most 30 visible tiles, whichever thread runs it.

Metrics: child/routing height, width, area, rectangle/pane whitespace, sampled ink,
quarter-turn bends, unrelated-source crossings, shared-lane pixels, direction, sibling
order, alignment and attached displacement. Geometry gates check every visible node/size,
canvas bounds, tile overlap, exact directed consumers, path syntax, source connectivity
and one correctly approached terminal arrow per output. Cubics use twelve subdivisions;
segment/tile intersections include arrow tips. Stroke/junction clearance beyond these
checks is not implied by zero counters.

The solver is constructive, with bounded work. An `anchor-infeasible` decision means its
candidate family found no safe embedding; it is not a proof that no drawing exists.
Acceptance lists every fallback and rejects independently demonstrated feasible failures.
Do not interpret a reported fallback alone as satisfying the plan's feasibility target.

Entry points:

- `run.ts`: sequential evaluation, acceptance table and exit status.
- `bench.ts --quick`: small diagnostic sweep; full run without flags.
- `reveals.ts`: legal click tours with anchor diagnostics.
- `packing.ts`: static and history-sensitive actual grid composition.
- `perf.ts`: isolated per-case timings.
- `regressions.ts`: reproduce the worst height regressions from saved sequences.
- `png.ts`: optional local headless Chromium rasterisation of SVG outputs.
- `summarize.ts`: concise report from generated artifacts.
