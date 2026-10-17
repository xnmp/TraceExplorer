# Pinned construction diagnosis — pass 6

**Overall acceptance remains unmet.** Broad and dense click counts and movement-fraction/anchor-displacement quality still exceed main-relative limits. Hard safety, restoration, arrival, held-screen, legal displacement, sibling ordering and the requested performance limits pass.

The construction gap is primarily a routing-safety difference, not lost click history. Main retries insertion with contact checks disabled; this branch retains those checks and independently certifies published drawings. Repairs now preserve pinned rectangles and reroute connector ink. Acceptance is reported below without weakening the requested movement targets.

## First diverging predicate on identical inputs

| First predicate main bypasses | Original added rows |
|---|---:|
| `LaneIndex.nearBerth` | 89 |
| `LaneIndex.touched` | 7 |
| History validation / missing anchor / partition key | 0 |
| Total original category (e) | 96 |

[Complete replay evidence](layout-hard-gates-evidence/pass6-divergence.json) records all 96 rows. Replaying the identical branch request/history makes main construct 89 candidates; every one fails the independent contact gate. In the other seven rows both engines fail on branch history, so the first divergence was traced on the successful main-history request: all seven reach `nearBerth`. The terminal branch failure is exhausted insertion (`!best`), not a rejected history shape. A first rejected probe is a control-flow witness, not proof that changing only that probe determines the final drawing. Counterfactual repair counts overlap.

The original 29 category (a) rows contain 30 rejected held candidates: 22 corner/curve contacts and eight arrow-tip contacts. These are real defects. [Candidate evidence](layout-hard-gates-evidence/pass6-rejected-candidates.json) records frozen-input repair results; current tour counts below use complete replays with the resulting histories.

All [17 original category (d) rows](layout-hard-gates-evidence/pass6-original-restores.json) have identical saved state keys and exactly restored geometry. They are excluded only from click-anchor and dense-tour move counts. Held-screen displacement and corpus quality still include restoration movement.

## Changes

- Constructor berth geometry now follows sharp corners and the actual painted arrow shaft. The arrow base has the corner berth; the actual tip retains its port clearance.
- Future sources reserve a usable departure rather than treating both possible ports as occupied. Newly active ports can be freed by rerouting retained connectors. The seed-12 arrival exposed a nominally clear bottom port trapped behind other ink; the usable right exit required shifting a straight tail in a mixed cubic/straight route. The helper now supports that exact edit without changing the cubic commands or endpoints.
- Incremental and anchored-repack attempts have independent bounded construction budgets. An exhausted fully pinned search no longer prevents repacking from constructing a candidate.
- Pinned connector repair changes internal straight runs or adds local orthogonal bypasses, preserving rectangle positions, curve commands, target endpoints and logical identities. A blocked source may also depart through its other real port on the same pinned tile. Every accepted repair passes the independent full gate.
- After ordinary holding candidates fail, bounded retries use a more constrained insertion order or construct a contact-bearing draft for repair. Unrepaired drafts cannot be published.
- The seeded revisit property now distinguishes effective expanded/caret state as well as visible membership. The former assertion conflated two different `merges-3` states; independent replay confirmed their production keys differ. Every fixture must still exercise genuine exact revisits. Production display memory is unchanged.

Each construction root cause has a failing regression fixture. The existing multi-parent arrival property also caught a departure-repair regression during final validation; its resolution and final gate results are recorded below. No presentation implementation for #91 was changed. Performance commits `c1dc133` and `68de7b9` remain; this pass adds no speed optimization.

## Measurement provenance

Main was re-executed from an untouched `git archive origin/main` checkout under `/tmp`, at `75e46b08cfd5ae94399aecfdebefb3937c6e3a73`. Its native inputs supply the acceptance reference: 32/101 clicks, 80/114 held-screen moves, mean legal displacement 17.5285997292. [Main input comparison](layout-hard-gates-evidence/pass6-main-inputs.json), [main acceptance](layout-hard-gates-evidence/pass6-main-acceptance.json.gz), and [main timing](layout-hard-gates-evidence/pass6-main-perf.json.gz) are committed.

Paired divergence audits deliberately give both implementations identical branch-planned requests. These reserve hint space on leaves to prevent arrival resizing, unlike native main; that paired main reports 31 broad moves. This diagnostic difference does not change the requested 32/101/114/17.53 acceptance limits. The older frozen baseline is retained only as a diagnostic; it does not decide current acceptance.

## Before / after classification

Added movements relative to paired main, using each engine’s own actual tour history:

| Classification | Original pass 5 | Pass 6 |
|---|---:|---:|
| (e) No held candidate constructed | 96 | 44 |
| (a) Held candidate rejected by independent gate | 29 | 5 |
| (c) Certified alternative / ranking | 1 | 0 |
| (d) Exact saved-state restore (excluded) | 17 | 16 |

[Original classification](layout-hard-gates-evidence/pass5-anchor-before.json), [final classification with restore proofs](layout-hard-gates-evidence/pass6-anchor-after.json). These are **added rows**, not total tour moves. Total broad-plus-packing moves excluding exact restores fall **87 → 41**; dense moves fall **155 → 109**. Final raw counts are 44 broad, 119 dense, and three packing moves; three, ten, and three respectively are proved restores.

The [remaining contact evidence](layout-hard-gates-evidence/pass6-residual-contacts.json) identifies five real rejected candidates after one source-port repair. They require more capable routing around crowded tile/port corridors; per-attempt repair limits were not raised and the independent gate was not bypassed. The 44 construction failures remain bounded-search failures, not proofs of geometric impossibility.

## Final acceptance against re-measured main

Measured production revision: `6861894`. The dedicated evaluator ran alone after all test and audit jobs completed. Restores are excluded only where explicitly permitted.

| Current target | Main 75e46b0 | This pass | Limit | Result |
|---|---:|---:|---:|---|
| Click anchor moves, including packing | 32.000 | 41.000 | 32.000 | FAIL |
| Dense-tour anchor moves | 101.000 | 109.000 | 101.000 | FAIL |
| Mean legal displacement, px | 17.529 | 17.358 | 17.530 | PASS |
| Unexplained height regressions | 0.000 | 0.000 | 0.000 | PASS |
| Held-screen moves at 480 px (broad) | 80.000 | 43.000 | 80.000 | PASS |
| Held-screen moves at 480 px (dense) | 114.000 | 100.000 | 114.000 | PASS |
| Hard violations/errors | 0.000 | 0.000 | 0.000 | PASS |
| Independent geometry gate failures | 0.000 | 0.000 | 0.000 | PASS |
| Unexplained shared connector lanes | 0.000 | 0.000 | 0.000 | PASS |
| Main-thread maximum p95, ms | 3.113 | 1.672 | 10.000 | PASS |
| ≤30 visible tiles maximum p95, ms | 51.064 | 6.218 | 206.571 | PASS |
| Full folder engine maximum inline p95, ms (no saved main measurement) | — | 1.742 | 5.000 | PASS |
| Mean height | 2372.651 | 2247.285 | 2372.651 | PASS |
| Mean width | 548.184 | 543.658 | 603.002 | PASS |
| Mean area | 1288189.671 | 1185867.142 | 1417008.638 | PASS |
| Mean tileArea | 557459.630 | 592248.594 | 613205.593 | PASS |
| Mean whitespace | 0.504 | 0.461 | 0.554 | PASS |
| Mean paneWhitespace | 0.636 | 0.604 | 0.699 | PASS |
| Mean length | 42304.604 | 37405.096 | 46535.064 | PASS |
| Mean bends | 142.912 | 150.927 | 157.203 | PASS |
| Mean crossings | 331.236 | 318.505 | 364.360 | PASS |
| Mean sharedLanePx | 0.023 | 0.000 | 0.025 | PASS |
| Mean tileIntersections | 0.000 | 0.000 | 0.000 | PASS |
| Mean overlaps | 0.000 | 0.000 | 0.000 | PASS |
| Mean directionViolations | 0.000 | 0.000 | 0.000 | PASS |
| Mean mixedDirections | 2.081 | 1.433 | 2.289 | PASS |
| Mean siblingInversions | 0.097 | 0.090 | 0.107 | PASS |
| Mean unaligned | 0.161 | 0.160 | 0.177 | PASS |
| Mean displacement | 31.597 | 33.205 | 34.757 | PASS |
| Mean maxDisplacement | 72.898 | 75.936 | 80.188 | PASS |
| Mean movedFraction | 0.117 | 0.159 | 0.128 | FAIL |
| Mean anchorDisplacement | 0.035 | 1.034 | 0.039 | FAIL |
| Mean overflow | 4.326 | 2.689 | 4.326 | PASS |
| Mean missingEdges | 0.000 | 0.000 | 0.000 | PASS |
| Mean extraEdges | 0.000 | 0.000 | 0.000 | PASS |
| Mean missingNodes | 0.000 | 0.000 | 0.000 | PASS |
| Mean extraNodes | 0.000 | 0.000 | 0.000 | PASS |
| Mean invalidGeometry | 0.000 | 0.000 | 0.000 | PASS |
| Mean invalidPaths | 0.000 | 0.000 | 0.000 | PASS |
| Mean terminalViolations | 0.000 | 0.000 | 0.000 | PASS |
| Mean disconnectedEdges | 0.000 | 0.000 | 0.000 | PASS |
| corpus geometry fallback rate, % | 0.000 | 0.000 | 0.500 | PASS |
| corpus geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |
| tours geometry fallback rate, % | 0.000 | 0.032 | 0.500 | PASS |
| tours geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |
| packing geometry fallback rate, % | 0.000 | 0.000 | 0.000 | PASS |
| packing geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |

## Remaining summary metrics

The table above includes every corpus mean. These additional quality summaries also retain restore movement; repeated population counts are shown for comparability. Corpus-loop timing is diagnostic; the two requested performance limits use the dedicated warmed sample.

| Summary | Main | This pass | Main +10% | Result |
|---|---:|---:|---:|---|
| Corpus stability: transitions | 3020.000000 | 3020.000000 | 3322.000000 | same population |
| Corpus stability: mean | 63.403957 | 66.630468 | 69.744352 | PASS |
| Corpus stability: p95Max | 899.129023 | 892.002242 | 989.041925 | PASS |
| Corpus stability: movedFraction | 0.234009 | 0.318179 | 0.257410 | FAIL |
| Broad tour: layouts | 2610.000000 | 2610.000000 | 2871.000000 | same population |
| Broad tour: transitions | 2145.000000 | 2145.000000 | 2359.500000 | same population |
| Broad tour: height | 1507.321839 | 1497.852874 | 1658.054023 | PASS |
| Broad tour: area | 747326.969444 | 732150.353831 | 822059.666389 | PASS |
| Broad tour: displacement | 17.528600 | 17.358266 | 19.281460 | PASS |
| Broad tour: movedFraction | 0.071665 | 0.104415 | 0.078831 | FAIL |
| Broad tour: tileIntersections | 0.000000 | 0.000000 | 0.000000 | PASS |
| Broad tour: overlaps | 0.000000 | 0.000000 | 0.000000 | PASS |
| Broad tour: disconnectedEdges | 0.000000 | 0.000000 | 0.000000 | PASS |
| Dense tour: layouts | 540.000000 | 540.000000 | 594.000000 | same population |
| Dense tour: transitions | 460.000000 | 460.000000 | 506.000000 | same population |
| Dense tour: height | 4057.770370 | 3807.159259 | 4463.547407 | PASS |
| Dense tour: area | 2533239.456944 | 2290603.010185 | 2786563.402639 | PASS |
| Dense tour: displacement | 83.945612 | 78.260218 | 92.340173 | PASS |
| Dense tour: movedFraction | 0.312968 | 0.277566 | 0.344264 | PASS |
| Dense tour: tileIntersections | 0.000000 | 0.000000 | 0.000000 | PASS |
| Dense tour: overlaps | 0.000000 | 0.000000 | 0.000000 | PASS |
| Dense tour: disconnectedEdges | 0.000000 | 0.000000 | 0.000000 | PASS |

Corpus-loop timing (median / p95 / max, ms): main **0.774 / 18.523 / 190.152**, pass 6 **1.687 / 44.544 / 362.701**. Dedicated warmed timing is **1.672 ms** maximum main-thread p95 and **6.218 ms** maximum ≤30-visible-tile p95; both satisfy the current performance constraint. The unchanged dispatch eligibility differs from main, as documented in the previous report. Full-folder inline p95 is **1.742 ms** (diagnostic). The timing sample ran with no other agent jobs; recorded system load on 24 CPUs was 5.20/5.57/5.65 before and 8.25/7.15/6.27 after.

## Remaining gaps and gate results

- Broad click moves **41 > 32** and dense moves **109 > 101**: nine and eight above target. The independent gate still rejects five added held candidates with real contacts; 44 added rows lack a certified held construction.
- Corpus mean moved fraction **0.158565 > 0.128280**, with the same deficit in the changed-transition summary (**0.318179 > 0.257410**). Broad-tour moved fraction also fails: **0.104415 > 0.078831**. Dense-tour moved fraction passes.
- Corpus mean anchor displacement **1.034397 > 0.038687 px**. Exact restores contribute 5664.485 of 6268.444 cumulative pixels (90.36%); this remains a reported quality failure, not another restore exclusion. New-state movement also remains.
- Geometry/error counters and the independent gate are zero across 6,060 corpus states, 3,150 tour states and 140 packing states. There is one geometry fallback in the tours (**0.03175%**), inside the pane; corpus and packing have none.
- `bun run check`: **PASS**, 0 errors and 0 warnings.
- `bun run test`: **FAIL**, 1,996 passed, one failed, one skipped. Only the click-acceptance test fails (41/32 and 109/101); its mean displacement and held-screen assertions pass. Exact revisits, worker/main parity, resize/arrival invalidation, zero retained arrival movement, and presentation tests pass.
- `bun run layout:eval` run alone: **FAIL**, four primary acceptance rows fail (click counts, corpus moved fraction, corpus anchor displacement). The additional summary table above also explicitly shows broad-tour moved fraction and the duplicate changed-transition moved fraction deficit. All requested performance limits pass.

[Gate command results](layout-hard-gates-evidence/pass6-gates.json), [full acceptance](layout-hard-gates-evidence/pass6-acceptance.json.gz), [corpus rows](layout-hard-gates-evidence/pass6-results.json.gz), [tour rows](layout-hard-gates-evidence/pass6-reveals.json.gz), [packing rows](layout-hard-gates-evidence/pass6-packing.json.gz), [isolated timing](layout-hard-gates-evidence/pass6-perf.json.gz). Referenced JSON evidence is committed; unreferenced diagnostic SVGs were omitted.

## Fix locations and commits

| Change | Source | Commit |
|---|---|---|
| Exact sharp corners, arrow base and painted shaft | `route-contacts.ts:165,212,243` | `7ba3f42` |
| Alternative future departures | `band-incremental.ts:378` | `d981c8b` |
| Independent pinned connector repair | `band-layout.ts:413`, `repair-route-contacts.ts:46` | `4049e5e` |
| Fresh anchored-repack budget | `band-layout.ts:451` | `4c7ad62` |
| Local orthogonal and mixed-curve bypasses | `repair-route-contacts.ts:91` | `6d585dd` |
| Late constrained insertion | `band-layout.ts:619`, `band-incremental.ts:1424` | `0a2ff24` |
| Contact-bearing drafts, repaired then independently certified | `band-incremental.ts:1415`, `band-layout.ts:623` | `40ae00e` |
| Verified restore exclusions, independent audit, fresh main reference | `layout-eval/anchor-audit.ts`, `layout-eval/run.ts` | `2f1bb78` |
| Complete effective-state revisit property | `expansion-invariance.test.ts:65` | `7ed8498` |
| Arrival port repair in straight tails of curved connectors | `band-incremental.ts:1285` | `24c2060` |
| Other real source port on pinned tile | `repair-route-contacts.ts:131` | `6861894` |

All logical changes carry the requested co-author trailer. Nontrivial routing changes and the revisit property correction received independent adversarial review. Performance commits `c1dc133` and `68de7b9` are retained. No push or browser test was performed.

---

# Previous pass report (historical)

# Revisits restore — 2026-10-17

**The revisit contract is implemented; the overall acceptance target remains unmet.** Click anchor moves, including packing: 93.000 > 32.000; Dense-tour anchor moves: 166.000 > 101.000; Mean legal displacement, px: 19.577 > 17.500; Held-screen moves at 480 px (dense): 145.000 > 114.000; Main-thread maximum p95, ms: 9.939 > 5.000; Mean siblingInversions: 0.110 > 0.107. The executable targets remain failing.

Branch `layout-hard-gates` is rebased on `origin/main` `75e46b08cfd5ae94399aecfdebefb3937c6e3a73`. The conflict at original `dd0b899` was resolved with main's presentation tests, followed by replacing strict expansion construction with committed display history. #91's paint planes, `presentation.ts`, `StackGrid.svelte`, and motion implementation are retained. A 4px attachment-header clearance prevents neighboring cover bridges touching packed band tails; fixture expectations and mock DOM handles now cover that geometry.

## Current contract and implementation

- Never-seen states use the currently displayed band's validated history, reading order and click anchor. Strict canonical/prefix experiments and their path-independence tests were deleted. The two earlier insertion routing fixes and passes 1–2's safety/fallback/complexity work remain.
- A folder output carries a 64-entry LRU of serialized displayed layouts. Its key includes ordered folder items, effective expansion/caret state, all non-history request inputs, pane width, tile/grid metrics, and policy. Folder identity and content fingerprints fence the ledger. Contents changes clear it before saving only the new current layout; retained arrival rectangles still use the hard pinning path.
- Saved snapshots contain no recursive display ledger, arrival ledger, or incoming request history. A reference-table codec preserves shared consumer tables in linear space, handles negative zero, and decodes fresh Maps/objects. No mutable geometry aliases the memory. The 200/400-output fan regression bounds serialized growth.
- Restores validate width/tile/grid provenance, ordered folder cells, per-band request signatures, and complete folder geometry before rebinding current plans. Malformed payloads rebuild through normal certification. Restored drawings never seed the band cache under a different click request. Resize restoration keeps the newest ledger instead of rolling it back to an older scene snapshot.
- Memory is committed only by publishing a scene and passing its output as the next input. The layout function has no ambient display cache and no selection input. Main and worker receive the same history and use the same engine. The worker test performs 768 worker/main layout comparisons across 16 fixtures (752 expansion transitions), requires at least 100 revisits, and compares worker/main outputs plus exact saved geometry on every return. The permanent Saffron/Ash round trip remains.

Independent review found and verified fixes for cache poisoning, malformed memory, stale geometry/cell provenance, resize-ledger rollback, and quadratic snapshot expansion. It also reviewed the free junction-end berth fix and compact layered candidate. The compact candidate fixes the five unexplained chainy height rows without weakening certification. A final reviewed correction assigns interchangeable new sibling leaves to existing slots in creation order, preserving all retained identities, coordinates and route paths; its two regression witnesses failed first.

## Current acceptance against re-measured main

Main was executed from a local `git archive origin/main` checkout; no fetch was performed. The committed reference is [main-reference.json](../layout-eval/main-reference.json). Re-measured 480px held-screen counts are **80/114**, stricter than the supplied 82/116. The evaluator uses 80/114; the original executable click assertions retain the supplied limits. The historical tours retain their band adapter for comparison; the 140 packing states and randomized real expansion transitions independently exercise the production folder engine. Historical layout-space counts exclude explicit `anchor-yield` decisions, matching main; held-screen counts include every movement.

| Current acceptance target | Main 75e46b0 | This pass | Limit | Result |
|---|---|---|---|---|
| Click anchor moves, including packing | 32.000 | 93.000 | 32.000 | FAIL |
| Dense-tour anchor moves | 101.000 | 166.000 | 101.000 | FAIL |
| Mean legal displacement, px | 17.529 | 19.577 | 17.500 | FAIL |
| Unexplained height regressions | 0.000 | 0.000 | 0.000 | PASS |
| Held-screen moves at 480 px (broad) | 80.000 | 78.000 | 80.000 | PASS |
| Held-screen moves at 480 px (dense) | 114.000 | 145.000 | 114.000 | FAIL |
| Hard violations/errors | 0.000 | 0.000 | 0.000 | PASS |
| Main-thread maximum p95, ms | 3.376 | 9.939 | 5.000 | FAIL |
| Full folder engine maximum inline p95, ms (no saved main measurement) | — | 4.674 | 5.000 | PASS |
| Mean height | 2372.651 | 2266.178 | 2372.651 | PASS |
| Mean width | 548.184 | 542.578 | 603.002 | PASS |
| Mean area | 1288189.671 | 1195209.857 | 1417008.638 | PASS |
| Mean tileArea | 557459.630 | 592248.594 | 613205.593 | PASS |
| Mean whitespace | 0.504 | 0.465 | 0.554 | PASS |
| Mean paneWhitespace | 0.636 | 0.609 | 0.699 | PASS |
| Mean length | 42304.604 | 37441.586 | 46535.064 | PASS |
| Mean bends | 142.912 | 151.847 | 157.203 | PASS |
| Mean crossings | 331.236 | 318.070 | 364.360 | PASS |
| Mean mixedDirections | 2.081 | 1.381 | 2.289 | PASS |
| Mean siblingInversions | 0.097 | 0.110 | 0.107 | FAIL |
| Mean unaligned | 0.161 | 0.170 | 0.177 | PASS |
| Mean overflow | 4.326 | 2.689 | 4.326 | PASS |
| corpus geometry fallback rate, % | 0.000 | 0.000 | 0.500 | PASS |
| corpus geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |
| tours geometry fallback rate, % | 0.000 | 0.063 | 0.500 | PASS |
| tours geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |
| packing geometry fallback rate, % | 0.000 | 0.000 | 0.000 | PASS |
| packing geometry fallbacks outside pane | 0.000 | 0.000 | 0.000 | PASS |

Main used its then-current ≤30 current+history tile dispatch rule; this pass uses ≤20 current+history tiles and ≤20 current edges plus history routes. Each maximum follows its own dispatch eligibility, and both must meet the absolute 5ms limit. The additional full-engine measurement includes validation, packing, serialization and restore in 82 inline-eligible folder workloads, 100 measured samples after 12 warmups. These are single-stack fixtures of at most 40 nodes, width 454px and image preset 96px, with only 0–2 remembered states; they do not measure full 64-entry ledgers or large multi-stack folders. There is no saved main counterpart. Pane narrowing can still force a synchronous layout under #91's pre-paint rule; this is outside the ordinary dispatch timing sample.

## Every historical acceptance row

These retain the older frozen-baseline thresholds in `layout:eval` as diagnostics; main itself fails several of them. They are not substituted for the current main-relative gates above.

| Historical acceptance row | Main 75e46b0 | This pass |
|---|---|---|
| Reported band ≤350 px | 347.000 | 326.000 |
| Cover → first child =34 px | 34.000 | 34.000 |
| All legal click anchors stationary (including real packing) | 32.000 | 93.000 |
| Legal click anchors stationary, dense tours (fan-in ≤4 and ≤10) | 101.000 | 166.000 |
| Mean legal displacement ≤baseline px | 17.529 | 19.577 |
| Mean legal height ≥15% lower px | 1507.322 | 1494.274 |
| >10% height regressions without stability reason | 0.000 | 0.000 |
| Hard gate violations/errors (corpus + tours incl. dense + packing) | 0.000 | 0.000 |
| Shared lanes between sources, not a listed fallback (corpus + tours incl. dense) | 0.000 | 0.000 |
| Mean crossings ≤ baseline | 331.236 | 318.070 |
| Crossing regressions not paid for by 0.00625 tile widths of height per extra crossing | 257.000 | 28.000 |
| Cases with worse p95 than baseline | 14.000 | 50.000 |
| Maximum p95 for main-thread requests (dispatch rule: ≤20 current+history tiles, ≤20 edges) ≤5ms | 3.376 | 9.939 |
| Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms | 52.897 | 206.571 |

## Every corpus summary metric

| Corpus metric (mean/layout) | Main 75e46b0 | This pass | Change |
|---|---|---|---|
| height | 2372.651 | 2266.178 | -4.49% |
| width | 548.184 | 542.578 | -1.02% |
| area | 1288189.671 | 1195209.857 | -7.22% |
| tileArea | 557459.630 | 592248.594 | 6.24% |
| whitespace | 0.504 | 0.465 | -7.71% |
| paneWhitespace | 0.636 | 0.609 | -4.24% |
| length | 42304.604 | 37441.586 | -11.50% |
| bends | 142.912 | 151.847 | 6.25% |
| crossings | 331.236 | 318.070 | -3.97% |
| sharedLanePx | 0.023 | 0.000 | -100.00% |
| tileIntersections | 0.000 | 0.000 | 0 |
| overlaps | 0.000 | 0.000 | 0 |
| directionViolations | 0.000 | 0.000 | 0 |
| mixedDirections | 2.081 | 1.381 | -33.64% |
| siblingInversions | 0.097 | 0.110 | 13.07% |
| unaligned | 0.161 | 0.170 | 5.86% |
| displacement | 31.597 | 38.352 | 21.38% |
| maxDisplacement | 72.898 | 83.682 | 14.79% |
| movedFraction | 0.117 | 0.196 | 67.81% |
| anchorDisplacement | 0.035 | 1.915 | 5345.12% |
| overflow | 4.326 | 2.689 | -37.84% |
| missingEdges | 0.000 | 0.000 | 0 |
| extraEdges | 0.000 | 0.000 | 0 |
| missingNodes | 0.000 | 0.000 | 0 |
| extraNodes | 0.000 | 0.000 | 0 |
| invalidGeometry | 0.000 | 0.000 | 0 |
| invalidPaths | 0.000 | 0.000 | 0 |
| terminalViolations | 0.000 | 0.000 | 0 |
| disconnectedEdges | 0.000 | 0.000 | 0 |

| Corpus summary | Main | This pass |
|---|---|---|
| layouts | 6060.000 | 6060.000 |
| errors | 0.000 | 0.000 |
| invalid | 0.000 | 0.000 |
| stability.transitions | 3020.000 | 3020.000 |
| stability.mean | 63.404 | 76.958 |
| stability.p95Max | 899.129 | 926.002 |
| stability.movedFraction | 0.234 | 0.393 |
| timing.median | 0.969 | 3.249 |
| timing.p95 | 20.093 | 76.411 |
| timing.max | 204.823 | 513.227 |

Corpus-loop timings use one warmed execution per state and this run overlapped the full test suite; they are diagnostic, not the isolated timing gate. Corpus stability includes arbitrary preset transitions; the legal click and held-screen gates are reported separately.

## Tour summaries and held screen space

| Tour summary | Main | This pass |
|---|---|---|
| Broad layouts | 2610 | 2610 |
| Broad changed states | 2145 | 2145 |
| Broad height | 1507.322 | 1494.274 |
| Broad area | 747326.969 | 722498.638 |
| Broad displacement | 17.529 | 19.577 |
| Broad movedFraction | 0.072 | 0.124 |
| Broad tileIntersections | 0.000 | 0.000 |
| Broad overlaps | 0.000 | 0.000 |
| Broad disconnectedEdges | 0.000 | 0.000 |
| Dense layouts | 540 | 540 |
| Dense changed states | 460 | 460 |
| Dense height | 4057.770 | 3746.524 |
| Dense area | 2533239.457 | 2211845.369 |
| Dense displacement | 83.946 | 88.219 |
| Dense movedFraction | 0.313 | 0.383 |
| Dense tileIntersections | 0.000 | 0.000 |
| Dense overlaps | 0.000 | 0.000 |
| Dense disconnectedEdges | 0.000 | 0.000 |
| Broad held-screen moves, 480px | 80 | 78 |
| Dense held-screen moves, 480px | 114 | 145 |
| Broad held-screen moves, 800px | 124 | 128 |
| Dense held-screen moves, 800px | 132 | 165 |

## Fallback rates

Geometry/emergency fallback only; click `anchor-infeasible` is a movement diagnostic, not an emergency layout.

| Source | Main | This pass | Rate | Outside pane |
|---|---|---|---|---|
| corpus | 0/6060 | 0/6060 | 0.0000% | 0 |
| tours | 0/3150 | 2/3150 | 0.0635% | 0 |
| packing | 0/140 | 0/140 | 0.0000% | 0 |

## Gates and remaining work

Saved evidence: [acceptance JSON](layout-hard-gates-evidence/revisits-acceptance.json.gz), [timing JSON](layout-hard-gates-evidence/revisits-perf.json.gz), [full test log](layout-hard-gates-evidence/revisits-tests.txt), [worker rerun](layout-hard-gates-evidence/revisits-worker-rerun.txt), and [check log](layout-hard-gates-evidence/revisits-check.txt).

- `bun run check`: 0 errors, 0 warnings.
- `bun run test`: Test Files  2 failed | 133 passed (135); Tests  2 failed | 1977 passed | 1 skipped (1980); Duration  190.39s (tests 90%, transform 7%, import 4%). Failures: the click-stability acceptance test and a 20s worker-child timeout in the clicks transport case. The complete worker parity file then passed independently (5/5 in 6.09s), including revisit comparisons. The earlier expansion timing failure did not recur. The click acceptance test remains failing, not skipped or marked expected.
- `bun run layout:eval`: exit 1. 6/28 current gates and 6/14 historical rows fail. Hard violations: 0.
- Timing: Bun 1.3.8, 24 CPUs; load before 19.600/18.780/15.650, after 12.380/14.100/15.200. The timing phase ran after the full test and geometry jobs; one 0.27-second diagnostic overlapped its start. No diagnostic ran during the full-folder timing probe.

The slow inline band case is random-bushy-12-7321 / reveal (8 visible tiles): p50 6.579ms, p95 9.939ms. A second inline case, random-bushy-40-7601 / reveal, reaches 5.073ms p95. Full-folder timing passes on its separate workload sample; it does not cancel these band failures.

New-state click routing remains the principal gap. The focused investigation rejected global click-only anchoring (worse movement) and larger insertion search budgets (the witness still failed with 16× budget). Reserving corner clearance at detached junction trunk ends fixed several real failures. Normal quality ranking is restored for clicks; only arrivals take the early all-retained pin preference. Re-enabling main's soft crossing cap was measured and reverted because it worsened held-screen movement and displacement. None of these findings establishes infeasibility for the remaining cases. The old universal arrival-search/very-large-input limitations documented below are not waived.

## Commits in this continuation

| Commit | Change |
|---|---|
| f0ea0d7 | Assign interchangeable new sibling leaves in reading order |
| 8b6eda4 | Test click stability outcomes and complete motion mock handles |
| 0fe68d5 | Keep feasible click anchors ahead of the soft crossing cap |
| 5e46a5a | Restore main crossing-cap choices for new click states |
| c3bb50d | Measure committed click history against rebased main and remove strict experiments |
| 0e3da1c | Distinguish rejected drawings from absent malformed history |
| 76a8d31 | Rank new click states normally and certify compact layered candidates |
| f50c190 | Align packing and motion fixtures with certified attachment geometry |
| da2a3c0 | Reserve corner clearance at detached junction trunk ends |
| 2d1c45f | Validate restored geometry and preserve the current display ledger |
| c7dda4b | Keep packed attachment tails clear of neighboring cover lanes |
| 604bf15 | Restore displayed folder states from bounded committed history |
| 02a8f06 | test: require displayed history and click anchors for new states |

No push, fetch, browser/Playwright, recursive removal, or access to `/home/chong/Repos/*` was used. All new commits carry the requested co-author trailer.

---

# Historical investigation — 2026-10-17

**Historical policy:** strict path independence and arrival-only history below are superseded. The experimental scripts mentioned below have been removed.

**The requested click-stability outcome is not achieved.** No experimental construction was enabled in production: each missed click targets, quality, or practical cost. The two independently reviewed routing fixes are retained. The new acceptance tests remain failing rather than weakening the targets.

Branch `layout-hard-gates`; `git merge-base HEAD origin/main` is `6a3ac0466c61fc6549b40b93c0b18b1dcd88313e`. No push, browser, Playwright, recursive removal, or access to `/home/chong/Repos/*` was used. The tables below use the supplied `acceptance-main.md`, the saved previous-pass report, and this pass's final production evaluation. Earlier reports follow unchanged.

## Diagnosis before changes

The classification covers all moved anchors in the historical tours; packing contributes a separate 27 moves. Twelve before/after SVGs were generated and representative pairs inspected as raster renders, before changing routing.

| Cause | Broad tours | Dense tours |
|---|---:|---:|
| Same candidate, different shelves/rows or routing allocation | 569 | 421 |
| Rigid band translation during attachment | 175 | 0 |
| Candidate changed | 154 | 8 |
| Total | 898 | 429 |

[Machine-readable cases](click-stability-evidence/diagnosis.json). Representative SVG pairs: [reflow before](click-stability-evidence/same-candidate-reflow-0-before.svg) / [after](click-stability-evidence/same-candidate-reflow-0-after.svg), [translation before](click-stability-evidence/rigid-band-translation-0-before.svg) / [after](click-stability-evidence/rigid-band-translation-0-after.svg), [candidate switch before](click-stability-evidence/candidate-switch-0-before.svg) / [after](click-stability-evidence/candidate-switch-0-after.svg).

Two insertion defects were reproduced and fixed:

1. The visibility-grid router avoided tiles and parallel lanes, but could repeatedly propose a shortest path through a foreign port/corner berth. Final clearance rejected it without searching around that witness. The router now adds the specific rejecting berth as an obstacle and retries, at most 16 times, debiting the same shared effort budget. Loading every berth upfront was rejected because the Cartesian grid became too large.
2. A newly inserted co-parent could lose both future exit ports to a subsequently inserted wire. Port repair inspected the original snapshot, which did not contain that new node. Future source ports are now reserved using complete folder membership, including hidden children. A weak membership index avoids rescanning hidden edges for every prefix. Reservations are preventive, not proof that pre-existing ink or a tile's own incoming route leaves all ports clear.

Both fixes keep final geometry certification and existing effort limits. Their focused regressions failed before the corresponding fixes. Independent review covered geometry, budget charging, immutable cache keys, and retained arrival placement. The zero-budget test was strengthened to exercise an actual exhausted grid search rather than exiting before routing.

## Constructions measured, and why none was selected

The pure prefix construction derives its branch order from complete folder membership and visible keys. It starts with roots and visible root children, closes insertions over visible co-parents, then inserts each branch while pinning prior rectangles. Every stage gets a deterministic effort budget. A bounded prefix cache includes complete construction identity and the entire prefix sequence; cache warmth supplies no click history. A failed insertion causes a deterministic cold reset in the experiment. Therefore returning to the same state returns the same geometry, but an earlier reset can move anchors even when the final stage reports a successful insertion.

Depth, pre-order, creation order, reverse order, and two frontier orders were measured. Full-folder frontier order chooses the newest available branch by stable creation order/key, then follows its newly available children. It performed best on cumulative clicks. No order eliminated enough resets and prefix changes to satisfy the targets.

Two-width probes use 454/900 px panes, 96 px images, and the same nine-step limit. These are exploratory counts, **not** the five-width acceptance totals. [All measured variants and stages](click-stability-evidence/orders.json).

| Construction | Broad anchors moved | Dense anchors moved | Broad legal displacement | All-state mean height |
|---|---:|---:|---:|---:|
| Depth, before routing fixes | 133 | 161 | 33.086 px | 1646.609 px |
| Pre-order, before routing fixes | 134 | 163 | 33.054 px | 1649.440 px |
| Creation, before routing fixes | 138 | 161 | 33.242 px | 1648.664 px |
| Reverse creation, before routing fixes | 304 | 165 | 76.994 px | 1693.755 px |
| Depth, both routing fixes | 111 | 126 | 24.937 px | 1675.821 px |
| Full frontier, both routing fixes | 104 | 122 | 27.370 px | 1677.616 px |
| Fixed full projection | 0 | 0 | 0 px | 2910.237 px |
| DAG projection + tree prefixes, initial trial | 12 | 0 | 6.865 px | 2500.321 px |
| Internal skeleton, normalized attachment, both fixes | 29 | 33 | 120.903 px | 2982.116 px |

Fixed projection is exactly stable because every state filters one fixed full embedding. It pays for hidden nodes and routes. The hybrid's complete 6,060-state quality run had height 2718.217 versus main 2372.651 (+14.6%), area 1616934 versus 1288190 (+25.5%), and length 48229 versus 42305 (+14.0%). Using the cold layout for fully expanded trees reduced those costs, but still produced height 2702.159 (+13.9%), area 1503383 (+16.7%), and overflow 6.149 versus 4.326 (+42.1%). Neither meets the preserved quality constraints. Summary evidence: [hybrid](click-stability-evidence/quality-hybrid.json), [cold-full hybrid](click-stability-evidence/quality-hybrid-cold.json).

The skeleton fixes internal-node coordinates and inserts visible leaves. Normalizing raw and attached coordinate frames removed 66 broad and 11 dense spurious moves, but 173 of 944 leaf-insertion states returned null and 64 failed geometry certification. Switching to full projection then moved internal anchors. Hidden internal branches also forced visible leaves far down the drawing. This was rejected.

The unrestricted full-frontier production experiment passed the permanent Saffron/Ash round trip, but did not pass the full compatibility suite: malformed-history cold-reset parity changed; pane-admission and resize contracts failed; large expanded cases became very slow. That experiment was reverted. Its full quality run was interrupted rather than reporting incomplete data as a completed benchmark.

## Historical tours versus actual cumulative clicks

`focusExpansion()` reconstructs the open state from each focus. Its historical “legal tour” can hide branches on a first click, contrary to the current product rule. This is a measurement mismatch, not permission to discard the requested comparison. Both measurements are retained.

Using actual `expandNode`, both cumulative probes had 1,226 states, 772 broad transitions, 128 dense transitions, and **zero retained nodes hidden by a click**:

| Cumulative construction | Broad anchors moved | Dense anchors moved | Broad displacement | Broad mean height |
|---|---:|---:|---:|---:|
| Depth | 75 | 72 | 72.994 px | 1786.637 px |
| Full frontier | 40 | 54 | 32.333 px | 1850.050 px |

Even the actual interaction model misses the requested targets. Reproduce with `bun layout-eval/probe-canonical.ts full-frontier` and `bun layout-eval/probe-cumulative.ts full-frontier`; alternatives are in `canonical-construction.ts`. These are evaluation candidates only. Production still uses arrival-only history; no click history was reintroduced.

## Screen space

Screen movement is measured after the actual `holdAnchor` compensation equations, with zoom 1, 480/800 px viewport heights, initial click scrolled toward the viewport centre, and real scroll-range clamping on both axes. Five tests invoke the production hold implementation against clamped scroll surfaces and verify the evaluator's result. This is settled screen-space modelling, **not browser observation or animation measurement**; browser testing was prohibited.

Horizontal movement cannot be compensated in a pane with no horizontal scroll range. Collapse can clamp the vertical scroll range and move a previously stationary anchor. Thus main's screen-space counts are not its 32/101 layout-space counts. Screen counts include movements labelled `anchor-yield`, since those are still visible. The historical layout-space rows retain their original exception rule. Screen figures below exclude packing and use click transitions only. The displacement column averages retained tiles after the same hold.

| Viewport / tours | Main moves / displacement | Previous pass | This pass |
|---|---:|---:|---:|
| 480 px / broad | 82 / 27.800 px | 767 / 92.253 px | 767 / 92.253 px |
| 480 px / dense | 116 / 154.987 px | 329 / 212.916 px | 329 / 212.916 px |
| 800 px / broad | 127 / 29.756 px | 809 / 92.674 px | 809 / 92.674 px |
| 800 px / dense | 134 / 157.777 px | 338 / 215.488 px | 338 / 215.488 px |

## Complete three-way acceptance comparison

These are all rows from the generated acceptance report. Its historical all-anchors target is zero; the new unit contract instead uses the requested 32/101/17.5 limits. Both fail. Main’s inline timing row used ≤30 current+history tiles; the current rule uses ≤20 current+history tiles and ≤20 edges.

| Acceptance row | Main | Previous pass | This pass |
|---|---:|---:|---:|
| Reported band ≤350 px | 347.000 | 326.000 | 326.000 |
| Cover → first child =34 px | 34.000 | 34.000 | 34.000 |
| All legal click anchors stationary (including real packing) | 32.000 | 925.000 | 925.000 |
| Legal click anchors stationary, dense tours (fan-in ≤4 and ≤10) | 101.000 | 429.000 | 429.000 |
| Mean legal displacement ≤baseline px | 17.529 | 77.830 | 77.830 |
| Mean legal height ≥15% lower px | 1507.322 | 1476.451 | 1476.451 |
| >10% height regressions without stability reason | 0.000 | 5.000 | 5.000 |
| Hard gate violations/errors (corpus + tours incl. dense + packing) | 0.000 | 0.000 | 0.000 |
| Shared lanes between sources, not a listed fallback (corpus + tours incl. dense) | 0.000 | 0.000 | 0.000 |
| Mean crossings ≤ baseline | 331.236 | 324.312 | 324.312 |
| Crossing regressions not paid for by 0.00625 tile widths of height per extra crossing | 257.000 | 29.000 | 29.000 |
| Cases with worse p95 than baseline | 14.000 | 31.000 | 31.000 |
| Maximum p95 for main-thread requests (dispatch rule: ≤20 current+history tiles, ≤20 edges) ≤5ms | 3.705 | 4.568 | 0.820 |
| Maximum p95 for requests with ≤30 visible tiles (any thread) ≤5ms | 130.334 | 10.174 | 4.769 |

| Summary metric, mean per layout | Main | Previous pass | This pass |
|---|---:|---:|---:|
| height | 2372.651 | 2356.768 | 2356.768 |
| width | 548.184 | 514.910 | 514.910 |
| area | 1288189.671 | 1186010.636 | 1186010.636 |
| tileArea | 557459.630 | 592248.594 | 592248.594 |
| whitespace | 0.504 | 0.461 | 0.461 |
| paneWhitespace | 0.636 | 0.625 | 0.625 |
| length | 42304.604 | 37990.398 | 37990.398 |
| bends | 142.912 | 154.228 | 154.228 |
| crossings | 331.236 | 324.312 | 324.312 |
| sharedLanePx | 0.023 | 0.000 | 0.000 |
| tileIntersections | 0.000 | 0.000 | 0.000 |
| overlaps | 0.000 | 0.000 | 0.000 |
| directionViolations | 0.000 | 0.000 | 0.000 |
| mixedDirections | 2.081 | 1.303 | 1.303 |
| siblingInversions | 0.097 | 0.000 | 0.000 |
| unaligned | 0.161 | 0.156 | 0.156 |
| displacement | 31.597 | 65.712 | 65.712 |
| maxDisplacement | 72.898 | 112.912 | 112.912 |
| movedFraction | 0.117 | 0.304 | 0.304 |
| anchorDisplacement | 0.035 | 16.127 | 16.127 |
| overflow | 4.326 | 2.177 | 2.177 |
| missingEdges | 0.000 | 0.000 | 0.000 |
| extraEdges | 0.000 | 0.000 | 0.000 |
| missingNodes | 0.000 | 0.000 | 0.000 |
| extraNodes | 0.000 | 0.000 | 0.000 |
| invalidGeometry | 0.000 | 0.000 | 0.000 |
| invalidPaths | 0.000 | 0.000 | 0.000 |
| terminalViolations | 0.000 | 0.000 | 0.000 |
| disconnectedEdges | 0.000 | 0.000 | 0.000 |

## Preserved contracts and unresolved gaps

Production geometry metrics are unchanged from the previous pass. The static quality metrics remain within the supplied main limits; the movement metrics do not. Corpus fallback is 0/6060, historical tours 5/3150 (0.1587%), and packing 0/140. The previous per-state pane allowances remain unchanged; this does not turn the inherited giant-input exceptions into a universal pane-bound proof.

Path-independent expansion, folder-change-only persisted history, exact retained arrival rectangles, and the permanent Saffron/Ash restoration test retain their existing coverage. No click-time history was introduced. The new prefix-order tests also check a different state path and a fresh-cache reconstruction, but their success does not certify the rejected construction's quality.

All click targets remain open: 925 versus 32 broad+packing moves, 429 versus 101 dense moves, 77.830 versus 17.5 px legal displacement, and 5 unexplained height rows. The height rows all repeat random-chainy-200-9303/454/48: production 10307 px, required ≤9531.5 px. The best existing downward candidate found was 10301 px; the best shelf was 10087 px and added 76 mixed-direction edges. No false stability label was added. [Candidate evidence](click-stability-evidence/height-candidates.jsonl).

The prefix experiment needs a construction that prevents earlier insertion resets and does not make an anchor's birth placement depend on branches a later state removes. Projection needs a way to avoid reserving extensive hidden geometry without sacrificing stable internal coordinates. Cold hidden-membership indexing remains O(edges); warm indexing is cached. The large-input timing failure of unrestricted canonical replay is a separate blocker to enabling it.

## Final gates

| Command | Result |
|---|---|
| `bun run check` | PASS: 0 errors, 0 warnings. |
| `bun run test` | FAIL, exit 1: 1942 passed, 2 failed, 1 skipped; 129 files passed, 1 failed. The two failures are the new click-stability and unexplained-height contracts. |
| `bun run layout:eval` | FAIL, exit 1: 6 of 14 historical acceptance rows remain red. Main-thread maximum p95 0.820 ms; maximum p95 with ≤30 visible tiles 4.769 ms. Hard violations 0. |

The six failing evaluator rows are broad anchors, dense anchors, legal displacement, unexplained height, unpriced per-case crossing regressions (29), and per-case p95 regressions against the frozen older baseline (31). The evaluator's complete geometry summaries and screen measurements are in the tables above. The initial concurrent test run timed out one resize test; its isolated 7-test suite passed. The final non-overlapping full run did not reproduce the timeout; its only failures are the two new acceptance contracts. All existing invariant, arrival, safety, pane-admission, and quality tests passed.

Timing used Bun 1.3.8 on 24 CPUs, load averages 6.11/7.35/7.99 before and 3.08/4.54/6.49 after. Treat the timing comparison as a gate check, not an attributed speedup. The maximum inline p95 case was random-tree-100-8003 / reveal.

## Commits in this pass

| Commit | Change |
|---|---|
| `3c0ad11` | Fail-first corpus click test and SVG diagnosis. |
| `26bc584` | Bounded berth-witness routing retry. |
| `3e3e671` | Screen compensation measurement, packing and height contracts. |
| `8a88532` | Future-source port reservations and weak membership index. |
| `95348c2` | Rejected construction experiments, order tests, measured evidence. |

All commits use the requested co-author trailer. The final documentation commit records this report and [continuation notes](layout-click-stability-next.md). No push was performed.

---

## Historical report — layout hard gates: fallback diagnosis and second-pass verification

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
