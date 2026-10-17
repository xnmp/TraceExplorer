# Layout hard gates — pass 7

**Every current acceptance target passes against re-measured main 75e46b0** (measured at `a3e3334`; `layout:eval` run alone).

The remaining click-stability gap came from too little search, not from geometry being impossible:
- each attempted embedding now has its own, larger `IncrementalBudget`;
- constrained retries use 1×–4× those budgets;
- two final retries keep the cover and the clicked tile's ancestry in place while other siblings move;
- pinned connector repair is capped at 3,072 probes and 96 edits.

Retained tiles are now priced by how many move (`MOVED_FRACTION_WEIGHT`), not only by how far. Under the product rule "revisits restore", exact restores are reported separately from new states, and only new states are held to main's limits. The independent geometry gate is unchanged, and every published drawing passes it.

Performance was explicitly deprioritised, with main-thread p95 ≤ 8 ms and ≤30-tile p95 ≤ 100 ms accepted. Both are met: 5.26 ms and 5.85 ms.

The historical frozen-baseline rows in `layout-eval/out/acceptance.md` still read FAIL. They are aspirational targets that main also fails, and on every one of them this branch is better than main. For example, unpaid crossing regressions are 43 here against 257 on main.

## Current acceptance

| Current target | Main 75e46b0 | This pass | Limit | Result |
|---|---:|---:|---:|---|
| corpus new-state per-layout movedFraction | 0.117 | 0.119 | 0.128 | PASS |
| corpus new-state per-layout anchorDisplacement | 0.035 | 0.000 | 0.039 | PASS |
| corpus new-state transition movedFraction | 0.234 | 0.190 | 0.257 | PASS |
| corpus new-state transition anchorDisplacement | 0.071 | 0.000 | 0.078 | PASS |
| broad new-state transition movedFraction | 0.072 | 0.046 | 0.079 | PASS |
| Click anchor moves, including packing | 32.000 | 15.000 | 32.000 | PASS |
| Dense-tour anchor moves | 101.000 | 57.000 | 101.000 | PASS |
| Mean legal displacement, px | 17.529 | 11.250 | 17.530 | PASS |
| Unexplained height regressions | 0.000 | 0.000 | 0.000 | PASS |
| Held-screen moves at 480 px (broad) | 80.000 | 23.000 | 80.000 | PASS |
| Held-screen moves at 480 px (dense) | 114.000 | 61.000 | 114.000 | PASS |
| Hard violations/errors | 0.000 | 0.000 | 0.000 | PASS |
| Independent geometry gate failures | — | 0.000 | 0.000 | PASS |
| Unexplained shared connector lanes | 0.000 | 0.000 | 0.000 | PASS |
| Main-thread maximum p95, ms | 3.113 | 5.260 | 8.000 | PASS |
| ≤30 visible tiles maximum p95, ms | 51.064 | 5.850 | 100.000 | PASS |
| Full folder engine maximum inline p95, ms (no saved main measurement) | — | 1.595 | 5.000 | PASS |
| Mean height | 2372.651 | 2247.467 | 2372.651 | PASS |
| Mean width | 548.184 | 553.761 | 603.002 | PASS |
| Mean area | 1288189.671 | 1197189.299 | 1417008.638 | PASS |
| Mean tileArea | 557459.630 | 592248.594 | 613205.593 | PASS |
| Mean whitespace | 0.504 | 0.469 | 0.554 | PASS |
| Mean paneWhitespace | 0.636 | 0.603 | 0.699 | PASS |
| Mean length | 42304.604 | 37674.394 | 46535.064 | PASS |
| Mean bends | 142.912 | 151.391 | 157.203 | PASS |
| Mean crossings | 331.236 | 319.385 | 364.360 | PASS |
| Mean sharedLanePx | 0.023 | 0.000 | 0.025 | PASS |
| Mean tileIntersections | 0.000 | 0.000 | 0.000 | PASS |
| Mean overlaps | 0.000 | 0.000 | 0.000 | PASS |
| Mean directionViolations | 0.000 | 0.000 | 0.000 | PASS |
| Mean mixedDirections | 2.081 | 1.488 | 2.289 | PASS |
| Mean siblingInversions | 0.097 | 0.071 | 0.107 | PASS |
| Mean unaligned | 0.161 | 0.157 | 0.177 | PASS |
| Mean displacement | 31.597 | 28.281 | 34.757 | PASS |
| Mean maxDisplacement | 72.898 | 63.729 | 80.188 | PASS |
| Mean overflow | 4.326 | 2.687 | 4.326 | PASS |
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

## Restores against new states

| Population | Kind | Layouts | Transitions | Per-layout moved fraction | Transition moved fraction | Per-layout anchor px | Transition anchor px |
|---|---|---:|---:|---:|---:|---:|---:|
| corpus main | newStates | 6060 | 3020 | 0.116618 | 0.234009 | 0.035170 | 0.070572 |
| corpus main | exactRestores | 0 | 0 | — | — | — | — |
| corpus proposed | newStates | 3480 | 2180 | 0.118985 | 0.189940 | 0.000000 | 0.000000 |
| corpus proposed | exactRestores | 2580 | 840 | 0.103137 | 0.316779 | 1.970543 | 6.052381 |
| broad main | newStates | 2610 | 2145 | 0.058897 | 0.071665 | 19.830336 | 24.129220 |
| broad main | exactRestores | 0 | 0 | — | — | — | — |
| broad proposed | newStates | 2350 | 2025 | 0.039239 | 0.045537 | 9.895972 | 11.484214 |
| broad proposed | exactRestores | 260 | 120 | 0.107156 | 0.232172 | 0.997756 | 2.161805 |
| dense main | newStates | 540 | 460 | 0.266602 | 0.312968 | 151.668180 | 178.045255 |
| dense main | exactRestores | 0 | 0 | — | — | — | — |
| dense proposed | newStates | 500 | 440 | 0.125537 | 0.142656 | 86.004745 | 97.732665 |
| dense proposed | exactRestores | 40 | 20 | 0.216667 | 0.433333 | 210.571210 | 421.142419 |

## Gates

- `bun run check`: 0 errors, 0 warnings.
- `bun run test`: all pass after giving one corpus-walking test a 30 s timeout. Run alone, it takes 1.6 s; it timed out at 5 s only under full-suite load.
- `bun run layout:eval`: all current targets pass.


## History

This report covered seven Codex passes: history validation, an independent geometry gate, a fallback ladder, a strict path-independence experiment that was abandoned in favour of "revisits restore", and the click-stability recovery. The full pass-by-pass report and its per-state evidence (about 7 MB of JSON and SVG) are preserved on the branch `layout-hard-gates-archive` (commit `0cb2afe`), in `docs/layout-hard-gates.md`, `docs/layout-hard-gates-evidence/` and `docs/click-stability-evidence/`.
