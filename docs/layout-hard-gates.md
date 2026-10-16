# Layout hard gates: verification record

Base: `9a7b64c0f88df582b026230efd04ae83237b20a4`, verified with
`git merge-base HEAD origin/main` before edits. The original `bun run layout:eval`
exited 1 on pre-existing FAIL rows; its report is preserved as
`layout-eval/out/acceptance-main.md` (generated, ignored).

## Review claims independently reproduced

| Claim / experiment | Observed on the requested base | Permanent coverage |
|---|---|---|
| Fourth sibling arrival, width 640 / preset 96 | Retained tile moves 359.026 px; an explicitly pinned solution exists | `expansion-invariance.test.ts`, `folder-arrival-pinning.test.ts` |
| Recorded Saffron/Ash collapse/reopen | Real folder transitions fail exact geometry identity | `expansion-invariance.test.ts` |
| Cumulative arrivals contact at (274,230) | Independent contact probe finds unrelated corners touching, old gate passes | `global-safety.test.ts`, `review-contact-cases.test.ts` |
| Dense random DAG 100 / 8103 | 28 px shared lane returned with `lane-infeasible` | `global-safety.test.ts` |
| Overlapping history / null rows | Unsafe reuse / TypeError | `history-boundary.test.ts`, bounded `malformed-history.test.ts` |
| Huge finite retained coordinates | **Claim not reproduced on this base:** child returned within 1200 ms; base already contains an index fix | `malformed-history.test.ts`, `history-boundary.test.ts` |
| Pairwise junction factoring | Sparse chain Set.has work grows as (V−2)² | `identity-boundary.test.ts` |
| Downstream consumers duplicated | 5,243 / 20,493 / 80,993 annotations for 100 / 200 / 400 nodes | `identity-boundary.test.ts`, `incremental-consumers.test.ts` |
| Delimiter route identity collision | Four logical edges collapse into three routes; layered result disconnects an edge | `identity-boundary.test.ts` |
| NUL-prefixed median IDs | Real node disappears; layout throws | `identity-boundary.test.ts` |
| Determinism / interleaving | No mutation or nondeterminism in the original 102 requests | `layout-interleaving.test.ts` |
| Full contact scan | Base reproduces contact at seed 13; repaired 400-seed scan completes | independent `contact-probe.ts` and fixed fixtures |
| Graphviz reference / summary / minimizer | Ran separately; reference has different pin/history constraints and is not proof of a feasible retained improvement | Fixed minimal contact fixture and this record |

The review's runnable files, input JSON, complexity counts and timings were executed before
implementation. Original measured sparse-chain band p50 values were 9.03 / 27.58 / 84.96 ms
at 100 / 200 / 400 nodes. Removing the two demonstrated quadratic mechanisms does not prove
the entire remaining layout/validation pipeline has linear complexity.

Additional independent review produced regressions for false existing-junction source
claims, cubic penetration between fixed samples, arrow-base contacts, exact curve clearance,
attachment reconstruction, consecutive multi-parent arrivals, and feasible giant fan-out.
Hang-prone malformed/large cases run in bounded child processes. Worker parity uses actual
Bun workers, including the previous-reply protocol, rather than a browser or a frozen engine.

## Scope and limits

The band and completed-folder admission boundaries reject unsafe candidates before publication.
They preserve the complete previous scene until a complete replacement is ready. Selection
never enters the engine's geometric request. Routing consolidation (recommendation 4) was
not started.

The implementation still permits proper transverse interior crossings, without bridges.
Literal zero contact of unrelated continuous connectors cannot represent arbitrary nonplanar
DAGs. Existing malformed-request errors and coordinate-capacity failures are not converted
into a typed scene rejection; this means the absolute no-throw requirement is not guaranteed.
The final fallback is certified, but bounded search exhaustion is not an infeasibility proof.
Folder decisions use `pin-search-exhausted` honestly if that case remains.

Closed components have no complete membership facts until loaded. An observation epoch
prevents a reopen from replacing geometric history, but cannot establish a membership-only
revision for unseen equal-count replacements. The workerless host fallback still computes
synchronously after yielding; it cannot guarantee a few milliseconds for arbitrary input.

## Verification scope

Independent final review reran the forged junction/lane, missing endpoint, cubic/tile,
arrow-base, invalid attachment, and giant fan witnesses. All now reject or construct a
certified replacement as appropriate. It also checked 240 multi-parent arrival states and
240 collapse/reopen states independently of the permanent tests, with no new concrete
regression. This review approves the tested scope, not a universal feasibility claim.

Remaining pinning limits are explicit: insertion has a 256-item limit; port repair handles
at most four blocking direct terminal connectors using the existing shared budget. It does
not reroute arbitrary retained junction networks. Consequently, a feasible pinned placement
can still be missed and `pin-search-exhausted` is **not an allowed hard-invariant exception**.
The implementation does not satisfy that universal part of the requested contract.

The 3 px corner/lane and 6 px port checks use independent path geometry. An adaptive chord's
error bound alone can reject a valid exactly-3-px curve clearance; control-point hull bounds
now prove those separations before rejection. Directed carrier reachability prevents forged
junction source IDs from disguising two unrelated wires as one source.

Inline dispatch now sums uncached band workloads and limits them to 20 current+history
tiles, 20 edges/routes, and 16 KiB of retained path text. The old per-band-only 30/40 rule
could dispatch many individually small bands together. The performance acceptance label
was updated to state the actual rule. This does not bound forced synchronous resize or
workerless execution for arbitrary large folders.

The packing evaluator was corrected to add each band's folder origin before measuring it.
Without that correction it superimposed cover-relative drawings from different grid rows,
reporting 306 artificial hard violations. Production folder certification already used the
correct world coordinates. No acceptance threshold was relaxed.

A relative timing assertion in the parallel unit suite was replaced with exact retained
geometry assertions; latency remains measured by the dedicated isolated `layout:eval`
performance stage. Malformed subprocesses retain forced timeouts, with five seconds allowed
for startup under concurrent tests.

## Final comparison against origin/main

“Before” is the **New** column saved from the requested `9a7b64c` run, not the evaluator’s older frozen Baseline column.

| Acceptance row | Before | After | Final status |
|---|---:|---:|---|
| Reported band ≤350 px | 347.000 | 347.000 | PASS |
| Cover → first child =34 px | 34.000 | 34.000 | PASS |
| All legal click anchors stationary (including real packing) | 32.000 | 18.000 | FAIL |
| Legal click anchors stationary, dense tours (fan-in ≤4 and ≤10) | 101.000 | 7.000 | FAIL |
| Mean legal displacement ≤baseline px | 17.529 | 9.761 | PASS |
| Mean legal height ≥15% lower px | 1507.322 | 1041.648 | PASS |
| >10% height regressions without stability reason | 0.000 | 83.000 | FAIL |
| Hard gate violations/errors (corpus + tours incl. dense + packing) | 0.000 | 0.000 | PASS |
| Shared lanes between sources, not a listed fallback (corpus + tours incl. dense) | 0.000 | 0.000 | PASS |
| Mean crossings ≤ baseline | 331.236 | 348.684 | PASS |
| Crossing regressions not paid for by 0.00625 tile widths of height per extra crossing | 257.000 | 553.000 | FAIL |
| Cases with worse p95 than baseline | 14.000 | 43.000 | FAIL |
| Maximum p95 for main-thread requests (dispatch rule: ≤20 current+history tiles, ≤20 edges) ≤5ms | 3.705 | 4.406 | PASS |
| Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms | 130.334 | 48.726 | FAIL |

Every changed summary metric (mean per layout):

| Metric | Before | After | Change |
|---|---:|---:|---:|
| height | 2372.651 | 2035.714 | -14.20% |
| width | 548.184 | 3483.902 | +535.54% |
| area | 1288189.671 | 4439559.991 | +244.64% |
| tileArea | 557459.630 | 592248.594 | +6.24% |
| whitespace | 0.504 | 0.644 | +27.78% |
| paneWhitespace | 0.636 | 0.711 | +11.79% |
| length | 42304.604 | 104945.070 | +148.07% |
| bends | 142.912 | 78.935 | -44.77% |
| crossings | 331.236 | 348.684 | +5.27% |
| sharedLanePx | 0.023 | 0.000 | -100.00% |
| mixedDirections | 2.081 | 6.648 | +219.46% |
| siblingInversions | 0.097 | 0.266 | +174.23% |
| unaligned | 0.161 | 0.144 | -10.56% |
| displacement | 31.597 | 12.319 | -61.01% |
| maxDisplacement | 72.898 | 40.231 | -44.81% |
| movedFraction | 0.117 | 0.011 | -90.60% |
| anchorDisplacement | 0.035 | 0.000 | -100.00% |
| overflow | 4.326 | 2839.060 | +65527.83% |

Unchanged summary metrics: tileIntersections, overlaps, directionViolations, missingEdges, extraEdges, missingNodes, extraNodes, invalidGeometry, invalidPaths, terminalViolations, disconnectedEdges.

Mean height changes by −14.20%; mean crossings by +5.27%, inside the requested 10%
regression threshold. The earlier fallback implementation exceeded that crossing limit;
sharing each source's fallback channel once reduced the final mean from 554.573 to 348.684.
The maximum eligible main-thread p95 is 4.406 ms, below 5 ms after aggregate dispatch budgeting.
Width and area are substantially worse: the safe wide construction buys separation and
retained placement with horizontal space. That remains a material readability cost.

`layout:eval` still exits 1, with six FAIL rows. Its legacy click-anchor requirements are
stronger than the amended soft expansion objective; they are reported unchanged rather than
relabelled PASS. The unpriced height/crossing rows and slower-case counts are also retained.
The real folder-engine click and arrival properties are separate from those old tours.

## Local commit sequence

- `8a92d1b` — bounded junction factoring, shared consumer ranges, collision-safe identities, NUL IDs.
- `b09a9f3` — retained-history boundary, independent geometry admission, certified fallback ladder.
- `6f4ab8d` — expansion invariance, arrival-only history, folder pinning, adversarial repairs and worker tests.
- Final verification commit — this report, corrected packing measurement, dispatch label and test timeouts.

Every commit carries the requested co-author line. Nothing was pushed. All 22 files under
`tests/zz-algo/` were removed with individual `rm` invocations after porting their cases.

## Final gates and continuation handover

Final production revision: `6f4ab8d`; subsequent changes are reporting and test timeouts.
`bun run check`: **248 files, 0 errors, 0 warnings**.
`bun run test`: **114 files passed; 1,849 tests passed, 1 skipped, 1,850 total** (22.67 s).
`bun run layout:eval`: exit **1**, six FAIL rows listed above; zero reported hard geometry
violations across corpus, reveal tours, dense tours, and packing. Final timing ran separately
from tests. Earlier concurrent full-suite runs hit two 5-second test timeouts; the final
isolated run passed with explicit 30-second bounds for those corpus-heavy tests.

For continuation, resolve the remaining product contracts before calling this fully complete:

1. Decide how arbitrary nonplanar provenance should display crossings (bridges/gaps or a
   changed connector representation). Continuous crossing-free routes cannot express every DAG.
2. Define a typed failed-layout outcome that holds the committed scene for invalid/capacity
   failures; the current API throws. Update inline and worker error publication together.
3. Replace bounded pin-search exhaustion with a constructive pinned placement beyond 256
   nodes and retained junction networks, or an actual infeasibility proof. Keep tile pins
   separate from route retention; the current bounded wire repair is only one construction.
4. A contents-only revision for unloaded components needs complete membership information;
   the existing backend token includes status updates and must not be treated as that revision.
5. The remaining layout/validation pipeline has super-linear work beyond the two removed
   quadratic mechanisms. Workerless and forced-before-paint resize paths also need a bounded
   execution strategy for the absolute latency contract.

Routing consolidation remains a separate task. Reuse `geometryGate`, `validHistory`,
`preservesFolderRectangles`, and the real-worker/property suites as its acceptance seams.
Generated reports and detailed logs remain in `layout-eval/out/` and `/tmp/layout-final-*.log`.
No browser, Playwright, push, recursive removal, or `/home/chong/Repos/*` access was used.
