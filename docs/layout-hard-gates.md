# Layout hard gates: fallback diagnosis and second-pass verification

Branch `layout-hard-gates`; merge-base with `origin/main` confirmed as `25d7392887d013e2c13b881c378deb8f74ed9f86` before edits and again before final verification. No push, browser, Playwright, recursive removal, or `/home/chong/Repos/*` access was used.

## What rejected the normal drawings

Diagnosis was captured **before changing production logic**, for every previous fallback state. Counts below describe the selected normal candidate's first recorded rejecting witness, so every state appears once. “Junction contact” outside the local meeting berth is a real defect; different routes merely sharing a legitimate source trunk are not.

| Source | Rejecting check | Real | False positive | Total |
|---|---|---:|---:|---:|
| Corpus | Junction approach/corner contact | 144 | 1 | 145 |
| Corpus | Unrelated route corner contact | 113 | 0 | 113 |
| Corpus | Junction parallel clearance | 0 | 17 | 17 |
| Corpus | Shared lane | 1 | 0 | 1 |
| Reveals | Junction approach/corner contact | 47 | 0 | 47 |
| Reveals | Unrelated route corner contact | 75 | 0 | 75 |
| Reveals | Junction parallel clearance | 0 | 5 | 5 |
| Packing | Numerically degenerate shared lane | 0 | 102 | 102 |
| **Total** | | **380** | **125** | **505** |

Every better-candidate attempt is also recorded, including repeated attempts within one state:

| Source | Check | Real attempts | False-positive attempts |
|---|---|---:|---:|
| Corpus | Junction approach/corner | 519 | 5 |
| Corpus | Unrelated route corner | 435 | 3 |
| Corpus | Junction parallel clearance | 40 | 72 |
| Corpus | Shared lane | 14 | 0 |
| Reveals | Junction approach/corner | 232 | 3 |
| Reveals | Unrelated route corner | 227 | 2 |
| Reveals | Junction parallel clearance | 9 | 18 |
| Reveals | Shared lane | 8 | 0 |
| Packing | Shared lane | 0 | 102 |

Refining the original local cubic primitives proved 27 additional rejection witnesses false (13 point/curve and 14 parallel curve-pair checks). Their true clearances are at least 3 px; conservative flattened chords alone had indicated contact. One is a selected-normal witness: `random-dag-12-7221`, pane 640, image 64. That candidate still has a proven contact between the same probe and another primitive of the same route. Thus the table classifies exact recorded witnesses (380 real/125 false); 381 selected candidates have a proven real defect; the remaining 124 have false first witnesses and no additional defect established by this audit. Five corrected local witnesses retain this separate real-contact evidence. A false recorded witness does not imply that the complete candidate would pass.

There were also 17 passing corpus alternatives and 9 passing reveal alternatives that the previous selector did not choose. The old complete counts are 276/6,060 corpus states (267 safe-columns, 9 wide-channels), 127/3,150 reveal states (124 safe-columns, 3 wide-channels), and 102/140 packing states, all within its 120-state interaction tour.

[Compressed per-state evidence and inspected SVGs](layout-hard-gates-evidence/README.md) contain candidate names, exact paths, contact coordinates, measured distances, clearance radii/error bounds, overlap lengths, and classifications. The packing false shared-lane sums were 2.274e−13–6.821e−13 px. Corpus contact chord distances span 0.396–3.043 px against a 3 px clearance plus recorded curve-approximation bounds; these numbers are not claimed to be exact curve distances. Six before SVG categories and two after fallback examples were rendered with `layout-eval/render.ts` and visually inspected as raster images.

**Production packing coordinates were correct.** Cover-relative bands were attached to their folder origins before certification, including cover stems. The earlier evaluator-only frame error did not recur in production. The packing failures came from an asymmetric collinear-overlap test accepting almost-zero cubic fragments as shared lanes across unrelated bands.

## Root causes and construction changes

- [`layout-quality.ts:47`](../src/lib/domain/trace-graph/layout-quality.ts#L47): reject degenerate fragments on both sides; intersect collinear segments in a dominant world coordinate before scaling the overlap length. This removes false positives without a blanket epsilon that would conceal real short overlaps. Regressions include reversed/transformed endpoints and a genuine 0.001 px overlap.
- [`geometry-gate.ts:127`](../src/lib/domain/trace-graph/geometry-gate.ts#L127): certify the intended 6 px axis-aligned junction meeting berth. The old circular test rejected legal fan endpoints such as (3,−6) relative to the junction. Remote parallel stems, foreign corners, forged source identities, tile penetration and invalid terminals remain rejected.
- [`geometry-gate.ts:92`](../src/lib/domain/trace-graph/geometry-gate.ts#L92): refine uncertain cubic contacts using independently parsed local primitives. Control-hull and chord-error lower bounds must prove the complete pieces separated; exhausted subdivision still rejects. Exact 3 px and 3.01 px clearances pass, 2.99 px contacts reject, and two-curve interior contact regressions prevent an endpoint-only escape.
- [`layout.ts:781`](../src/lib/domain/trace-graph/layout.ts#L781) and [`bounded-junctions.ts`](../src/lib/domain/trace-graph/bounded-junctions.ts): factor wide meetings, reserve their actual fan extent before lane assignment, keep ordinary bends on their reserved orthogonal tracks, and separate nearby swaps with available full-width doglegs. Place pinned-band joins after their actual parents; use measured orthogonal channel demand instead of scaled curved-channel floors. Interval allocation sorts variable-radius reservations and orders reusable margin tracks by lifetime. A sort precondition defect was found in review; no distinct final fail→pass fixture is claimed for that defensive correction alone.
- [`band-incremental.ts`](../src/lib/domain/trace-graph/band-incremental.ts), [`folder-layout/pinned-placement.ts`](../src/lib/domain/trace-graph/folder-layout/pinned-placement.ts), and [`folder-layout/cell-footprints.ts`](../src/lib/domain/trace-graph/folder-layout/cell-footprints.ts): distinguish raw world insertion extents from child-band allocation padding, try certified bounded placement before widening, and route around physical file-tile footprints supplied by the built-in grid. When a new source port is blocked, move retained internal connector runs, including node-to-junction inputs, while retaining every tile rectangle and route endpoint. Twenty seeded arrival sequences cover 240 states and exact folder-cell retention.
- [`layout.ts:1131`](../src/lib/domain/trace-graph/layout.ts#L1131) and [`band-geometry.ts:127`](../src/lib/domain/trace-graph/band-geometry.ts#L127): reuse margin lanes whose abstract lifetimes only touch across a physical tile row; start minimum-spacing lanes at the actual clearance edge. Keep 8 px allocation padding where it fits, reducing it under pane pressure only to the largest painted half-width (3.5 px). A sparse actual-main audit exposed 32 per-state width regressions hidden by the improved mean; all became permanent regressions. Applying 3.5 px everywhere initially broke 16 history/packing tests; adaptive padding fixed the shared cause without changing assertions. The orthogonal width lower bound uses the same minimum painted allowance.
- [`orthogonal-route.ts:159`](../src/lib/domain/trace-graph/orthogonal-route.ts#L159), [`folder-layout/route-bounds.ts:27`](../src/lib/domain/trace-graph/folder-layout/route-bounds.ts#L27), and [`folder-layout/pinned-placement.ts:177`](../src/lib/domain/trace-graph/folder-layout/pinned-placement.ts#L177): allow legal world-pane boundary lanes, clip only cosmetic horizontal route padding, and remove the synthetic 8 px world origin from renderer-visible canvas widths. An initially suspected full-width-file barrier was **disproved** by independent review: a boundary route passes the exact geometry contract and keeps every retained rectangle. That counterexample is now a passing production regression, including actual attached canvas width.
- [`safe-layout.ts`](../src/lib/domain/trace-graph/safe-layout.ts), [`fallback-order.ts`](../src/lib/domain/trace-graph/fallback-order.ts), [`safe-chain.ts`](../src/lib/domain/trace-graph/safe-chain.ts), and [`safe-grid.ts`](../src/lib/domain/trace-graph/safe-grid.ts): wrap compact grids to fitting columns; fit fan gutters to narrow panes (including a tile exactly as wide as the pane); remove unused cover padding; schedule binary junctions early; reuse source lanes after their last consumer; share trunk ink and suffix consumer tables. Priority queues avoid quadratic ready-set scans. The generic fallback reports exhausted lane capacity rather than returning an unbounded width. The former `safeColumns` entry point delegates to the bounded construction. Explicit full-pane fallback bounds prevent attachment from adding a second cosmetic margin.
- [`layout-eval/engine.ts`](../layout-eval/engine.ts) and [`perf-workloads.ts`](../layout-eval/perf-workloads.ts): evaluate the production arrival-only history policy. Expansion, resize and tile-size changes do not create history; a changed full component does. Timed arrival workloads now contain actual retained history and use the same dispatch eligibility as production. Main's saved reference still reflects its historical policy; its numbers are preserved exactly, not regenerated to make this pass look better.

The routing approach follows the established separation of layering, ordering, placement and orthogonal edge routing described by [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html), with explicit node/edge and edge/edge spacing from its [option reference](https://eclipse.dev/elk/reference/options.html). No ELK dependency was added.

Fail-first regressions precede each behavioral root fix. Coverage includes degenerate overlaps, legal versus remote junction contact, real foreign corner contacts, bounded arrival frames, retained internal-port repair, narrow fallback grids, a 100-parent early merge, and corpus-sample fallback-rate/pane-width assertions. Independent reviewers rechecked the old forged-source, cubic/tile, arrow-base, retained-history, complexity and actual worker-parity protections.

## Three-way acceptance comparison

Main is the saved **New** column of `acceptance-main.md`; it is not the evaluator’s older frozen Baseline column. The saved main report predates the rebase; separate width audits replay actual `25d7392` for per-state allowances. Historical acceptance targets and dispatch labels are preserved as evidence; the main timing row used its older dispatch rule.

| Acceptance row | Main | Previous pass | This pass | This pass status |
|---|---:|---:|---:|---|
| Reported band ≤350 px | 347.000 | 347.000 | 326.000 | PASS |
| Cover → first child =34 px | 34.000 | 34.000 | 34.000 | PASS |
| All legal click anchors stationary (including real packing) | 32.000 | 18.000 | 925.000 | FAIL |
| Legal click anchors stationary, dense tours (fan-in ≤4 and ≤10) | 101.000 | 7.000 | 429.000 | FAIL |
| Mean legal displacement ≤baseline px | 17.529 | 9.761 | 77.830 | FAIL |
| Mean legal height ≥15% lower px | 1507.322 | 1041.648 | 1476.451 | PASS |
| >10% height regressions without stability reason | 0.000 | 83.000 | 5.000 | FAIL |
| Hard gate violations/errors (corpus + tours incl. dense + packing) | 0.000 | 0.000 | 0.000 | PASS |
| Shared lanes between sources, not a listed fallback (corpus + tours incl. dense) | 0.000 | 0.000 | 0.000 | PASS |
| Mean crossings ≤ baseline | 331.236 | 348.684 | 324.312 | PASS |
| Crossing regressions not paid for by 0.00625 tile widths of height per extra crossing | 257.000 | 553.000 | 29.000 | FAIL |
| Cases with worse p95 than baseline | 14.000 | 43.000 | 31.000 | FAIL |
| Maximum p95 for main-thread requests (dispatch rule: ≤20 current+history tiles, ≤20 edges) ≤5ms | 3.705 | 4.406 | 4.568 | PASS |
| Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms | 130.334 | 48.726 | 10.174 | FAIL |

Every summary metric, mean per layout:

| Metric | Main | Previous pass | This pass | Change vs main |
|---|---:|---:|---:|---:|
| height | 2372.651 | 2035.714 | 2356.768 | -0.67% |
| width | 548.184 | 3483.902 | 514.910 | -6.07% |
| area | 1288189.671 | 4439559.991 | 1186010.636 | -7.93% |
| tileArea | 557459.630 | 592248.594 | 592248.594 | +6.24% |
| whitespace | 0.504 | 0.644 | 0.461 | -8.46% |
| paneWhitespace | 0.636 | 0.711 | 0.625 | -1.78% |
| length | 42304.604 | 104945.070 | 37990.398 | -10.20% |
| bends | 142.912 | 78.935 | 154.228 | +7.92% |
| crossings | 331.236 | 348.684 | 324.312 | -2.09% |
| sharedLanePx | 0.023 | 0.000 | 0.000 | -100.00% |
| tileIntersections | 0.000 | 0.000 | 0.000 | 0 |
| overlaps | 0.000 | 0.000 | 0.000 | 0 |
| directionViolations | 0.000 | 0.000 | 0.000 | 0 |
| mixedDirections | 2.081 | 6.648 | 1.303 | -37.37% |
| siblingInversions | 0.097 | 0.266 | 0.000 | -100.00% |
| unaligned | 0.161 | 0.144 | 0.156 | -3.14% |
| displacement | 31.597 | 12.319 | 65.712 | +107.97% |
| maxDisplacement | 72.898 | 40.231 | 112.912 | +54.89% |
| movedFraction | 0.117 | 0.011 | 0.304 | +159.66% |
| anchorDisplacement | 0.035 | 0.000 | 16.127 | +45978.50% |
| overflow | 4.326 | 2839.060 | 2.177 | -49.67% |
| missingEdges | 0.000 | 0.000 | 0.000 | 0 |
| extraEdges | 0.000 | 0.000 | 0.000 | 0 |
| missingNodes | 0.000 | 0.000 | 0.000 | 0 |
| extraNodes | 0.000 | 0.000 | 0.000 | 0 |
| invalidGeometry | 0.000 | 0.000 | 0.000 | 0 |
| invalidPaths | 0.000 | 0.000 | 0.000 | 0 |
| terminalViolations | 0.000 | 0.000 | 0.000 | 0 |
| disconnectedEdges | 0.000 | 0.000 | 0.000 | 0 |

## Requested second-pass targets

| Target | Limit | This pass | Result |
|---|---:|---:|---|
| Mean height | 2372.651 | 2356.768 | PASS |
| Mean width | 603.002 | 514.910 | PASS |
| Mean length | 46535.064 | 37990.398 | PASS |
| Mean crossings | 364.360 | 324.312 | PASS |
| Mean mixedDirections | 2.289 | 1.303 | PASS |
| Mean siblingInversions | 0.107 | 0.000 | PASS |
| Mean overflow | 4.326 | 2.177 | PASS |
| Main-thread eligible maximum p95, ms | 5.000 | 4.568 | PASS |

| Source | Previous geometry fallback | This pass | Rate | Limit |
|---|---:|---:|---:|---:|
| Corpus | 276/6060 | 0/6060 | 0.0000% | 0.5% |
| Reveals | 127/3150 | 5/3150 | 0.1587% | 0.5% |
| Packing | 102/140 | 0/140 | 0.0000% | 0 |

Packing includes 20 static states and 120 interaction states; its previous 102 fallbacks were all interaction states. The final packing output has neither `safe-rows` nor `geometry-fallback`.

Remaining geometry fallbacks:

| Case | Pane | Step | Candidate | Overflow | Height |
|---|---:|---:|---|---:|---:|
| dense-f4-100-20502 | 900 | 5 | wide-channels | 0.000 | 3281.000 |
| dense-f4-100-20502 | 900 | 6 | wide-channels | 0.000 | 3242.000 |
| dense-f10-100-21101 | 900 | 5 | wide-channels | 0.000 | 4583.000 |
| dense-f10-100-21101 | 1400 | 5 | wide-channels | 0.000 | 4184.000 |
| dense-f10-100-21103 | 900 | 6 | wide-channels | 0.000 | 5348.000 |

All remaining fallback states pass the independent geometry gate and fit their panes. They are remaining candidate-construction defects, not claimed infeasible states.

Per-state width verification replays actual `25d7392` with the same lifecycle prefixes and visible items. Every state with positive final overflow is compared; states with zero overflow cannot regress a nonnegative allowance. The old and current metrics agree on each identical main drawing.

| Source | Final overflowing states audited | Worse than actual main | Equal | Improved |
|---|---:|---:|---:|---:|
| Corpus | 185/6,060 | 0 | 5 | 180 |
| Reveals | 20/3,150 | 0 | 0 | 20 |
| Packing | 31/140 | 0 | 31 | 0 |

Production inline timing used Bun 1.3.8; machine load metadata is retained in the final evidence. Full acceptance keeps historical any-thread and older-baseline timing failures visible.

## Remaining gaps and specific infeasible inputs

The tested corpus is not a universal feasibility proof. No acceptance threshold or prior geometry/history assertion was relaxed.

- The legacy evaluator still requires expansion click anchors to remain stationary. That is stronger than path-independent expansion with arrival-only history: click locations may move when the open state changes. Those FAIL rows, displacement rows, per-case height/crossing prices and timing comparisons remain visible in the table. Arrival retention and collapse/reopen identity are independently tested against the real folder engine.
- Two existing giant-input contracts contradict a literal pane bound. `safe-grid.test.ts` requests 44 tiles, each 100,000 px wide, in a 900 px pane: one tile already proves impossibility. `safe-chain.test.ts` requests 43 tiles of 100,000×100,000 px, pane 100,000 px, and requires the largest output dimension below 1,000,000 px. Their total area is 430,000,000,000 px², exceeding the permitted 100,000,000,000 px² rectangle even before spacing. Existing finite certified wide outputs are retained for these specific impossible contracts. Neither occurs in the acceptance corpus.
- The generic fallback throws when its bounded lane construction exhausts capacity. This is explicitly **not** an infeasibility proof or a universal hard-width guarantee. Arrival insertion retains its 256-item search limit and four internal-port repairs under a shared budget. Feasible arrangements outside that search can still be missed; `pin-search-exhausted` is not excused as an allowed hard-invariant exception. These inherited universal-contract gaps remain.
- Emergency serial layouts can be very tall: the inspected 200-node DAG and 100-parent fan examples at 360 px are 49,072 and 22,480 px tall. They are bounded alternatives, not normal candidates. Shared consumer ranges and priority queues avoid the demonstrated quadratic annotations/ready-set scans; a left-deep streaming junction still has quadratic complete `parents` metadata under the existing UI/history contract. No overall linear-complexity claim is made.
- Closed components without complete membership facts cannot establish contents-only revisions for unseen equal-count replacements. Forced synchronous resize and workerless hosts retain the prior limits for arbitrary large input. The measured ≤5 ms contract applies to production inline-dispatch-eligible requests.

The full-width retained-file barrier is **not** listed as infeasible: independent review supplied a legal pane-edge route, and production now constructs it.

## Verification and commits

The final production revision is `993763f`; the subsequent report commit changes documentation/evidence only. The merge-base remains `25d7392887d013e2c13b881c378deb8f74ed9f86`.

| Command | Result |
|---|---|
| `bun run check` | Exit 0; 252 files, 0 errors, 0 warnings. |
| `bun run test` | Exit 0; 126 files passed, 1,927 tests passed, 1 pre-existing test skipped. |
| `bun run layout:eval` | Exit 1; all requested second-pass measured targets pass, zero hard geometry violations/errors; seven historical acceptance rows still FAIL (shown above). |

Existing assertions were not weakened. Two presentation tests use narrower resize fixtures (360/454 instead of 640 px) because the compact candidates no longer reroute over the old 640→900 interval; their crossfade and retirement outcome assertions are unchanged.

Preserved contracts are tested directly, separately from the historical click-anchor metrics:

| Contract | Behavioral coverage |
|---|---|
| Same open state is path-independent; collapse/reopen is identity | `expansion-invariance.test.ts`: recorded Saffron/Ash case and seeded corpus click walks through the folder engine. |
| History changes on folder content changes only | `closed-arrival-history.test.ts`, `band-history.test.ts`, and `evaluator-history.test.ts`: no-op revisions, expansion, resize and real arrivals. |
| Zero retained movement on output arrival | `expansion-invariance.test.ts`, `folder-arrival-pinning.test.ts`, `folder-pinned-arrival.test.ts`: exact tile rectangles, later grid rows, internal port repair and 240 seeded arrival states. |
| No admitted hard geometry defects | Complete evaluator hard-violation count plus existing forged-source, remote stem, cubic/tile, arrow-base and malformed-history regressions. |
| Fallback rate and pane bound | `candidate-admission.test.ts`: corpus sample ≤0.5% and measured main width allowances; `gate-numerics.test.ts`: zero packed fallbacks; `safe-fallback-width.test.ts`: bounded emergency attachment. |

Independent adversarial review covered the numerical gate, original defect rejection, ordinary candidate routing, pane-edge counterexamples, retained arrivals, and fallback complexity. Final curve review approved the proof-only refinement with 33 focused tests, including 28 new regressions. All code changes below carry the requested co-author trailer. No push was performed.

| Commit | Logical fix |
|---|---|
| `8bbb654` | Reject degenerate fragments in shared-lane measurement. |
| `b42a3ad` | Try bounded retained arrival placement before widening. |
| `a1c46df` | Match the local junction meeting berth. |
| `b017632` | Wrap chain and fan fallback grids. |
| `b2f2c1c` | Keep ordinary channel turns on reserved tracks. |
| `9a4900c` | Route arrivals around physical grid tile footprints. |
| `deec999` | Remove endpoint projection roundoff from collinear overlap. |
| `84d5d98` | Evaluate production arrival-only history. |
| `cfb188c` | Separate world insertion bounds from child allocation. |
| `f2eb131` | Reserve junction fans and separate normal route tracks. |
| `f7258f0` | Repair blocked active ports without moving retained tiles. |
| `9e5b085` | Bound emergency layouts with early joins and reused source lanes. |
| `f9acf35` | Stream narrow fallback meetings in actual arrival order. |
| `7e533ae` | Admit pane-edge world routes and correct attached widths. |
| `ce38dd2` | Keep fallback attachment inside full-pane allocation. |
| `dc49086` | Reuse disjoint margin lanes and adapt allocation padding. |
| `4797731` | Fit narrow fan gutters and legal boundary lanes. |
| `993763f` | Prove uncertain cubic clearance before rejecting it. |
