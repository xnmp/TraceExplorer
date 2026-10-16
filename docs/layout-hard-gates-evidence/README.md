# Gate diagnosis evidence

Frozen before-pass audit, captured before changing admission or routing:

- `corpus-before.json.gz`: all 276 corpus states that selected `geometry-fallback`.
- `reveals-before.json.gz`: all 127 reveal states that selected `geometry-fallback`.
- `packing-before.json.gz`: all 102 rejected folder drawings, including the exact route paths and numerical shared-lane witnesses.

The first two files list each attempted better candidate, its rejecting check, numerical witness (coordinates, distance, threshold/error bound or overlap), and real/false-positive classification. Candidate attempts repeat across states; the report distinguishes attempts from states. `pass` entries are certified alternatives that the old selection path did not choose. Distances from adaptive curve chords include the recorded approximation error; they are not exact curve distances.

`refined-audit-witnesses.json.gz` refines 50 borderline point/path witnesses on original cubic primitives. `refined-parallel-witnesses.json.gz` covers all 63 originally real parallel witnesses; 49 have local endpoint proofs. `refined-pair-witnesses.json.gz` contains the 14 complete local-pair separation proofs. `refined-probe-local-witnesses.json.gz` then checks the exact local primitives of all 31 borderline probes. Together these correct 27 conservative numerical false witnesses (13 probe, 14 parallel); the per-candidate records above include the corrected labels. A different nearby part of a path cannot establish that the logged local pair violates clearance. These classifications describe the recorded rejecting witness, not unexamined checks later in the candidate. Five newly corrected local witnesses also retain `otherContact` bounds proving the same probe contacts another primitive of the same route. One is a selected-normal witness, so selected witness counts are 380 real/125 false while 381 selected candidates have a proven real defect; the remaining 124 have false first witnesses and no additional defect established by this audit. The local-pair and local-probe refinements supersede whole-path classifications in the initial audit file.

Decode with Python's standard `gzip` and `json` modules. Gzip timestamps are zero for reproducibility. Route identities and complete path strings make the witnesses independently inspectable without trusting candidate construction.

The SVGs were generated using `layout-eval/render.ts`, rasterized with `rsvg-convert`, and visually inspected without a browser:

| SVG | What it demonstrates |
|---|---|
| `packing-numeric-before.svg` | Different packed bands are correctly in world coordinates; tiny degenerate cubic fragments falsely count as a shared lane. |
| `junction-berth-before.svg` | Legitimate local fan convergence inside the 6 px axis-aligned junction berth was rejected by a circular berth. |
| `junction-fan-before.svg` | Real crowded approaches merge outside that local berth. |
| `foreign-contact-before.svg` | Real unrelated connector corners approach or touch. |
| `shared-lane-before.svg` | Real unrelated source lanes overlap. |
| `curve-clearance-witness-before.svg` | Magnified original `random-dag-40-7501`, 360 px, `wide-2` route pair. The blue circle is the 3 px clearance around the logged probe; independent cubic bounds give 3.0140826858–3.0140826868 px. This checks the rejecting witness, not the complete candidate. |

`full-cell-barrier.json` records a retained-arrival witness that was initially suspected to be infeasible. Independent review disproved that claim: the exact geometry contract allows routing along the pane boundary. Its full-width ordinary-file obstacle is the conservative footprint of a host that supplies no physical content bounds. The normal built-in grid exposes its actual narrower tile footprint and avoids the obstruction directly. `full-cell-boundary-counterexample.json.gz` preserves the independently constructed passing layout. Production now admits those pane-edge lanes too.

The after SVGs `safe-dag200-after.svg` and `safe-fanin100-after.svg` show the new emergency construction at a 360 px pane. Both explicitly allocate the full 360 px pane and pass the independent gate with zero overflow. Their large heights (49,072 and 22,480 px) remain a fallback readability cost.

`width-audit-before-wrap.json.gz` is a later audit of the 251 overflowing corpus states after the initial routing fixes. It replays 54 groups against actual `25d7392` main: 32 states were worse than main (12 newly overflowing), 35 equal, 184 improved. Main's original overflow measurement and the current measurement on those identical main drawings agree in every state. This prevented treating the improved mean as proof of the per-state width requirement.

Final verification on `993763f`:

- `final-verification.json`: exact means, acceptance rows, runtime/load metadata, and SHA-256 hashes of all five final evaluator JSON outputs.
- `final-acceptance.json.gz` and `final-perf.json.gz`: complete acceptance details, failed case lists, and timing samples' aggregates. The evaluator exits 1; seven legacy rows remain failures.
- `final-main-{corpus,reveals,packing}-overflow-comparison.json.gz`: every final overflowing state replayed against actual `25d7392`, with lifecycle prefixes, identical visible items, and both metric implementations. Corpus 185, reveals 20 and packing 31 states: zero worse/new overflow, zero replay errors, zero metric discrepancies.
- `final-check.txt` and `final-tests.txt`: successful final typecheck and unit-test logs.

The immutable final output hashes are in `final-verification.json`; the report and evidence commit changes no production code after that verified revision.
