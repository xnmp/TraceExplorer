# Routing consolidation

Original design against `536a667b29db585e5e16f0fe2e5623b80c485b6c` (2026-10-18).
The design commit `6768262` changed no production code; slice 1 implementation
and measurements are recorded below. The current contracts are the opening section
of [trace-view-layout.md](trace-view-layout.md) and [layout-hard-gates.md](layout-hard-gates.md);
their historical lane-pricing, contact relaxation and anchor-yield descriptions are
not permission to publish uncertified geometry.

## Decision in five lines

1. Use an ordered orthogonal embedding: tile rectangles, explicit ports, provenance junctions, and routes through a channel complex.
2. Choose display rows, corridor sequences, port sides and segment orders discretely; preserve retained and long-edge orders.
3. Solve rectangle, junction, channel-boundary and segment coordinates with equalities, bounds and directed separation inequalities.
4. Eliminate retained coordinates as exact constants; cold sweeps and incremental insertion change the free variables of this same problem.
5. Emit strokes, arrows, dots and bounded fillets inside allocated corridors; the unchanged independent gates alone admit the completed drawing.

This is a mixed discrete/continuous constraint model, **not** a claim that arbitrary
routing reduces to one convex solve. Once topology and orders are chosen, the metric
subproblem is separation-constrained placement. A conflicting order needs another
corridor or a split segment, not a weakened inequality. Adopt this model behind the
existing pure engine API; do not replace the engine with ELK or libavoid.

## Inventory and replacement mapping

Paths below are relative to `src/lib/domain/trace-graph/`; line numbers name the
unmodified base. “Gate → ladder” means band admission at `band-layout.ts:305`, then
folder admission at `folder-layout/default-engine.ts:398`. The ladders certify
replacement candidates before returning; they do not repair every rejected draft.
The last column maps **every** inventoried stage to a target responsibility and slice.

| ID / stage / file:line | Invariant attempted; inputs read | Failure and later compensation | Target counterpart / slice |
|---|---|---|---|
| T1 Input junction plan: `junctions.ts:107`; `bounded-junctions.ts:4`; `streaming-junctions.ts:8` | Exact parent→child consumers; identical/subset input sets can share; bound fan-in. Reads normalized relationships, subset budget, optional fallback arrival rank. | Bad relationships throw. Optional subset factoring stops at its work bound. Wide meetings split; streaming binary meetings reduce serial-fallback lane demand. | Keep semantic plan and consumer ranges; make geometric meeting ports explicit (3). |
| T2 Display-row construction: `layout.ts:521`, `layout.ts:697`; `layer-order.ts:153` | Topological generations, deterministic tile order, balanced pixel-width wraps and fixed cover x. Reads sizes, DAG, hint order, pane, pin and extra margins. | More rows/wider allocation; malformed band inputs rejected upstream. Geometry still needs gate → ladder. | Ordered rectangle and long-edge dummy-node constraints; cold embedding candidates (5). |
| T3 Initial junctions: `layout.ts:774` | Nesting levels, same-level spacing, foreign-column/fan berths. Reads tile centres, potential gaps/margins, semantic plan and consumers. | Store provisional preferred x; defer the junction and its dependents. | Joint junction/corridor occupancy, no provisional coordinate masquerading as a pin (3). |
| T4 Gap/lane allocation: `layout.ts:870`, `layout.ts:1094`, `layout.ts:1159` | Different sources get separate x lanes; compatible lifetime intervals reuse margins; preserve bundle passing order. Reads row spans, stems, straight bundle targets, source lifetimes and slot capacity. | Choose another/least-loaded gap; compress margin spacing to 3; inner blocked-offset search can keep centred lanes. Widening, zones/tracks, then gate → ladder compensate. | Ordered vertical segments with channel bounds and separations (1, then corridor selection in 3). |
| T5 Margin compression/widening: `layout.ts:1150`, `layout.ts:386` | Fit actual lane/junction shortfall without merging ink. Reads preferred/minimum spacing, available pane slack, accumulated shortfalls. | Retry up to 2 extra passes, 4 for pinned layouts; last pass constructs despite shortfall. No certificate here: gate → ladder. | Solve free channel boundaries; exhausted capacity changes topology/allocation, never pins or minimum clearance (3, 5). |
| T6 Deferred junctions: `layout.ts:1182` | Place dots against actual lanes, update incident course endpoints. Reads final lane x, real tile ports, nesting and earlier dots. | Try stacked-column placement, then remove column keepouts; request margin widening. | Deleted, subsumed by simultaneous junction and segment constraints (3). |
| T7 Stacked dots / dropped keepouts: `layout.ts:1210` | Retain nesting and at least same-level spacing after exclusive columns fail. Reads remaining column intervals and widening allowance (two pane widths). | Can create foreign-dot contacts/shared lanes; gate rejects; certified band/folder fallback compensates. | Deleted; dot berths remain hard. Split a meeting or choose another corridor (3). |
| T8 Passing courses/trunks: `layout.ts:992`, `layout.ts:1733` | One same-source prefix per row/lane, exact consumer union and stable route identity. Reads route plan, source/target rows, slots and trie usage. | No repair/failure result; a bad course can still fail admission. Zones/tracks and gate → ladder follow. | Keep compact shared-net representation; ordered corridor chain with stable segment identities (2, 3). |
| T9 Fan-in approach offsets: `layout.ts:1263`, `layout.ts:1704` | Inputs meet only at their dot, not along its column beforehand. Reads input x/order, source identities and dot berth. | Dedicated curved fan may still contact foreign ink; gate → ladder. | Explicit ordered junction ports and convergence region (3). |
| T10 Zone choice/reconsideration: `layout.ts:1291` | Prefer no shared vertical run, foreign-dot contact or nearby run; only then prefer room. Reads all legs, legal nesting zones, dot levels and run occupancy; revisits choices once. | Picks cheapest even if every zone has conflicts. Tracks may help; gate → ladder is authoritative. | Deleted, subsumed by corridor alternatives plus hard occupancy constraints (3). |
| T11 Track assignment: `layout.ts:1457` | Overlapping incompatible bends separate; leave a column before another route arrives; same-source compatible trunks share. Reads expanded span conflicts, direction/end order, fan compatibility. | Cyclic forced order invokes swaps/doglegs, then may break in sort order. Gate → ladder. | Deterministic order graph + metric separation solve, retained tracks fixed (1). |
| T12 Swaps: `layout.ts:1426`, `layout.ts:1568` | Trading columns must not read as a false connection. Reads occupied columns, swap width and fan endpoints. | Narrow pair: shared double-height crossing slice. Otherwise dogleg; if no column, consecutive slices can touch. Gate → ladder. | Explicit crossing cell or split-segment topology; ordering constraints remain satisfiable (3). |
| T13 Longer track cycles: `layout.ts:1523`, `layout.ts:1552` | Break leave/arrive cycles by splitting one non-fan bend into a free column. Reads critical dependency graph, occupied columns, prior tracks/pieces. | If no eligible split exists, break in sort order; gate → ladder. | Deleted sort-order escape; bounded topology search reports conflict/exhaustion (3). |
| T14 Port berth: `layout.ts:1602` | Foreign crossing bends stay below the source port's 6 px berth. Reads root ports, bend spans, doglegs and curved swaps. | Adds track offset/zone height; remaining contact goes to gate → ladder. | Explicit port departure/arrival stubs and exclusion regions (1, 2). |
| T15 Vertical placement/track spreading: `layout.ts:1622`, `layout.ts:1671` | Enough zone height for tracks, junction berths, and the straight arrow approach. Reads row heights, track counts, port offsets, default zones. | Grow zone and all later rows; distribute track centres over available room. No history constraints in this pass. Gate → ladder. | Solve channel boundaries and row offsets with pins; free height grows only where permitted (1, 5). |
| T16 Channel fillets: `layout.ts:1716`; `channel-corners.ts:94`, `channel-corners.ts:141` | Largest local cubic quarter turn ≤6 px within track, adjacent half-runs and foreign-ink clearance. Reads sharp drawing, native cubics and track-centre caps. | Shrink radius, ultimately sharp; independent curve admission still required. | Keep emitter, consume solved corridor/turn bounds; eventually delete separate sharp-ink rediscovery (2, 6). |
| T17 Shelf router: `band-shelves.ts:59`, `band-shelves.ts:87`, `band-shelves.ts:139`, `band-shelves.ts:202` | Tree-only columns; interval lanes, leave-before-arrive order, bounded partitions and independent shelf-wrap tracks. Reads visible tree, widths/heights, pane, pin and partition. | Returns null for merges/nonfit; band optimizer considers downward/history candidates. Gate → ladder. | Another discrete embedding of the same segment/channel model (5). |
| T18 Hint cut/resize: `band-history.ts:90`, `band-history.ts:108`; `band-layout.ts:46` | Reconnect ports, retain x; grow with zero or one 16 px column descent; shrink leaves positions. Reads fitted membership/sizes and exact old M/L/C geometry. | Failed wire cut tries fixed-rectangle rerouting; last tile-only seed is never directly publishable. Insertion and independent admission must rebuild wires. | Derive allowed retained rectangles first; solve ports/wires under those exact equalities (4). |
| T19 Retain/normalize/anchor candidates: `band-layout.ts:113`, `band-layout.ts:204`, `band-layout.ts:281`, `band-layout.ts:372` | Prune consumers, retain visible subsets, replay exact attachment frame; translate candidates onto clicked ancestry. Reads raw/placed history, membership, anchor and attachment. | Bad/incompatible history discarded; no safe held candidate triggers repack/retries, then nonholding candidates. Final gate → ladder can change placement. | Hard pin set in a declared frame, explicit embedding alternatives; no finite penalty substitutes for a pin (4, 5). |
| T20 Primary insertion probes/routes: `band-incremental.ts:835`, `band-incremental.ts:955`, `band-incremental.ts:1071`, `band-incremental.ts:1563` | Keep retained rectangles; place new nodes topologically; test real bottom/right departures and top/left arrivals, routes/dots/lanes/grazes. Reads tile/lane indexes, new item, parents, future source berths and shared budget. | Try same-height direct alternatives after a detour, then fallback grid and finer second chance; return null on exhaustion/limits. Band candidates/retries compensate. | New rectangle/corridor candidates evaluated by the same solve (4). |
| T21 Plain grid fallback: `band-incremental.ts:1128`; `orthogonal-route.ts:161` | Route around tile boxes, foreign lanes and berths in bounded slots. Reads obstacle/visibility grid, headings, legal pane bounds and budget. | Null on no route, grid-size limit or spent search. Second chance, port repair, then band candidate search. | Visibility/corridor search produces topology, separation solver places it (3, 4). |
| T22 Finer second chance: `band-incremental.ts:1185`, `band-incremental.ts:1219`, `band-incremental.ts:1703` | Half-step lane probes; all-lane grid; iteratively add foreign berth blockers; alternate parent routing order. Reads same scene, extra lane columns, 128 slots and shared second-chance budget. | Null; port-lane repair, constrained/repairable retries, repack/cold candidates follow. | Deleted separate geometry family; increase bounded corridor-search effort in the same model (4). |
| T23 Free blocked ports: `band-incremental.ts:1342` | Free at least one newly active source departure by rerouting a blocking terminal connector, tiles fixed. Reads both ports, retained routes and new parents. | At most four attempts; keep old routes on failure. Insertion then internal-run repair/retry. | Port exclusions included before segment placement; local corridor reinsertion (4). |
| T24 Free internal port lanes: `band-incremental.ts:1390` | Shift a blocking internal run with neighboring native fillets; preserve endpoints, direction and clearance. Reads authored commands, new ports, tile/lane indexes and probe budget. | At most four edits; unchanged/partially repaired draft may still fail insertion or admission. Other band candidates follow. | Deleted local offset search; re-solve affected free segments/turn bounds (4). |
| T25 Constrained/repairable retries: `band-layout.ts:662`; `band-incremental.ts:1511`, `band-incremental.ts:1586` | Prioritize hard multi-parent insertions; repairable policy defers port/corner contacts. Reads previous or ancestry-only seed; 1–4× budgets. | A returned draft is not certified. `repairPinned` then gates; if all fail, current engine can choose nonholding layouts. Shallow lanes/tile grazes are not generally relaxed. | Deleted relaxed-contact geometry policy; bounded embedding alternatives, all constraints hard at solve/admission (4). |
| T26 New-sibling leaf ordering: `new-sibling-order.ts:7` | New interchangeable leaves follow creation order without moving retained identities. Reads equal-size single-parent new leaf slots, incoming consumers, future source needs. | Inapplicable groups unchanged; later gate checks semantics. | Assign identities/orders before free-coordinate solve (4). |
| T27 Hint rerouting / suffix reconnect: `hint-resize.ts:12`, `hint-resize.ts:99`; `band-incremental.ts:1284` | Preserve permitted resized rectangles; translate rigid wires, stretch junction tails or reconnect to an exact retained suffix. Reads height deltas, old ports/commands, shift policy, future source ports. | Clear obsolete routes, reverse routing order, try minimal/full column descent; contact repair or null. Band/folder pin search compensates. | Pin derived rectangles and retained suffix; route changed ports through shared corridor model (4). |
| T28 Pinned contact repair: `repair-route-contacts.ts:55` | Preserve tile/dot locations and consumers; fix route-contact/shared-lane witnesses by run offsets, local bypass or alternate real source port. Reads independent failure, flattened witnesses and exact commands. | Only handles those two failure kinds; caps 3,072 probes/96 edits, null on no progress. `repairPinned`, hint/folder search reject failed candidates; gate → ladder. | Deleted, subsumed by segment separations, port exclusions and explicit corridor reinsertion (4). |
| T29 Allocation/painted padding: `band-geometry.ts:118`, `band-geometry.ts:126`; `pinned-band-extent.ts:15`; `folder-layout/route-bounds.ts:12` | Allocate stroke, arrow and dot extents, without applying arrow width to every gutter. Reads exact paths/control hulls, terminal direction, max stroke and pane. | Tight primitive envelope or null. Candidate discarded; fallback/expanded world canvas may compensate. | Primitive envelope constraints distinct from cosmetic allocation padding (2). |
| T30 Ordered packing/skyline/gutters: `stack-packing.ts:30`, `stack-packing.ts:99`, `stack-packing.ts:138`; `band-geometry.ts:184` | Ordered disjoint band rectangles, feasible click reservations, clear cover bypass and header corridor. Reads measured extents, cell columns, anchors, earlier allocations and pending footprints. | Try outer gutter/repack; place group below earlier groups; missing routing lane throws. Final folder gate/isolated rows compensate. | Ordered band rectangles plus shared cover-channel variables in folder coordinates (1, 5). |
| T31 Shared attachment reservation: `band-geometry.ts:159`, `band-geometry.ts:213` | Count-derived tracks/header room keep possibly interacting groups separate. Reads open-group count, gap/arrow constants. | Blanket reservation moves unchanged children; later gates check safety, **not stationarity**. No later stage restores this click-only move. | Deleted count rule; conflict-specific track inequalities and retained attachment equalities (1). |
| T32 Lone-lane reduction: `band-geometry.ts:214` | Reclaim header room when every group is on the first line and complete lane envelopes are apart. Reads packed positions, cover centres and lane envelopes. | Any wrap/deferred group disables it; retain shared header. | Deleted global all-groups predicate; independent conflict components may reuse tracks (1). |
| T33 First-line alignment: `band-geometry.ts:220` | Align first-line children at deepest header if it preserves first-line membership. Reads reserved headers and a trial repack. | Keep old reservations if trial wraps a group; no history guarantee. | Alignment only for free child tops; pinned tops cannot gain a shared-row maximum (1). |
| T34 Attachment port/drop/gutter choice: `band-geometry.ts:254`, `band-geometry.ts:373` | Cover stays on cell; stem uses header track/bypass, avoids other cover and bypass columns; preserves exact sliced tail. Reads placement, M/L/C tail, bandTop, columns and gutters. | `nearestFree` may fall back to original cut x; no lane throws; complete folder gate rejects unsafe attachment. | Explicit cover and tail ports, bridge segments and corridor bounds (1, 2). |
| T35 Attachment transform/rounding: `band-geometry.ts:345`, `band-geometry.ts:393`; legacy `band-geometry.ts:425` | Translate children as a unit, keep cover fixed; replace provisional outgoing stem only, round ≤6 px. Reads raw bounds, first row, host cover height, track/stemRoom and placement. | May mark `packing-infeasible`; unsafe full drawing reaches folder gate/isolated rows. Legacy `attachBand` is a translation adapter, not folder routing. | Explicit affine frame equations and shared emitter; retain exact unchanged attachment geometry (1, 2). |
| T36 Band fallback ladder: `band-layout.ts:296`; `safe-chain.ts:9`, `safe-grid.ts:8`, `safe-columns.ts:5`, `safe-layout.ts:12`, `fallback-order.ts:33` | Admit completed attached geometry. Tries 1.5/2/3× channels, chain, fan, then serial columns/rows (columns is now an alias). Reads request, independent failures, fallback order/lane lifetimes. | Serial fallback can switch to streaming meetings; bounded capacity/remaining gate failure throws. Earlier lane-pricing drafts do not bypass this boundary. Pins can be lost today. | Same solver, alternative compact/serial discrete embeddings, identical pin set and constraints (5, 6). |
| T37 Folder-world pinning: `folder-layout/pinned-placement.ts:91`, `folder-layout/pinned-placement.ts:200`; `folder-layout/default-engine.ts:399` | Arrivals preserve all surviving world rectangles, including other bands/ordinary cells; only legal hint descent. Reads arrival snapshot, current plans, world routes and footprints. | Resize/reroute histories, normal/wider insertion, contact repair; retry with hint descent. Null becomes `pin-search-exhausted`; current engine may return moved candidate. | Folder-level problem includes every obstacle and pin from the start; same incremental solve (4, 5). |
| T38 Folder isolation: `folder-layout/default-engine.ts:405` | Complete folder geometry is safe after normal packing fails. Reads all plans, serial one-column grid and safe band layouts. | Build and certify everything; throw if still unsafe. Can change grid columns/history placement today. | Serial embedding in same model, never discard required pins (5, 6). |
| T39 History/restore boundary: `history-boundary.ts:181`; `folder-layout/display-memory.ts:86`; `folder-layout/default-engine.ts:361` | Revisit restores exact displayed bytes for effective expansion/contents/metrics/policy; first foreign-worker restore independently certified. Reads committed ledger, raw↔attached transform, identities and shape bounds. | Invalid history discarded, rebuilt and flagged; incompatible state does not restore. | Keep boundary/LRU; store stable track/corridor identities with history (1, 4). Exact restore bypasses optimization. |
| T40 Contact predicates / independent admission: `route-contacts.ts:81`, `route-contacts.ts:235`, `route-contacts.ts:260`; `geometry-gate.ts:354`; `folder-layout/geometry-gate.ts:7` | Queries tile grazes, painted arrow shafts, port/corner berths, shallow runs; gates independently parse paths, connectivity, claimed sources, native curves and complete folder geometry. | Predicates reject constructor choices; gates reject candidates. **They never move geometry.** | Constructor builds equivalent constraints independently; keep both gates unchanged in every slice. |

Other `folder-layout/*` files (`types`, bounded cache, stable key, memoize,
cell footprints, display serialization, route-bound union) carry identity, frames,
obstacles or envelopes; they introduce no additional route search/repair policy.
`layout-cost-bound`, `layout-quality` and orientation scoring select/prune candidates;
they do not certify the missing geometric constraint.

## Measured use, not inferred prevalence

One targeted workload in `/tmp/routing-measure`, instrumented from the base, using Bun
1.3.8; **no full `layout:eval`, Playwright or browser run**. All 65 `corpus()` cases:
up to nine legal visible-node clicks at width 400/image 48, using the selection
rule in `layout-eval/reveals.ts`; one full-lineage cold band at width 360/image 48;
one raw layered layout of that same request. Additionally, cases with 2–40 nodes
are paired with a three-node chain through closed/open-both/close/reopen folder
histories; cases with 4–40 nodes grow their first 2…min(n,8) nodes with a second
two-node stack open. Folder width 400, default tile and fallback grid metrics.
The folder helpers are `makeFolder`/`folderInput` from the domain test fixtures.
An instrumentation replay added the T8/T9/T19 hooks; every earlier counter and
the output digest matched. This was not a second full evaluation.

| Population | Requests | Published gate failures |
|---|---:|---:|
| Legal corpus tour steps | 522 | 0 |
| Full-lineage cold bands | 65 | 0 |
| Raw layered diagnostics (not band-admitted) | 65 | Not an admission population |
| Folder packing/open/close/growth states | 398 | 0 |

Hooks compare incoming/outgoing node coordinates and sizes by identity, dot
coordinates, route paths and allocation bounds. Local hooks compare lane x,
zone/track assignments, margin widths, header reservations or accepted inserted
coordinates before/after that operation. Constructor rows mean geometry was
created; repair rows mean existing geometry/allocation changed. Counts include
discarded candidates and nested calls, **not distinct published layouts**, and
cannot be summed. A successful draft is not necessarily certified. Fillet changes
count added cubic commands, excluding whitespace/straight-waypoint normalization.
Topology-only plans/predicates have no coordinate mutation to count.

| Stage → geometry/allocation changes | Changes | Calls / opportunities | Unit |
|---|---:|---:|---|
| T2 Row placement | 890 | 890 | Routing pass |
| T3 Initial/provisional junction positions | 306 | 890 | Pass with any dots |
| T4 Lane allocation | 623 | 890 | Pass with any passing lanes |
| T5 Margin spacing compressed | 581 | 843 | Occupied margin |
| T5 Margin widening | 220 | 220 | Retry |
| T6 Deferred junction position changed | 5 | 890 | Pass |
| T7 Stacked-column relaxation | 0 | 8 | Deferred dot |
| T7 Dropped column keepouts | 0 | 8 | Deferred dot |
| T8 Shared-trunk geometry emitted | 383 | 670 | Completed routing pass |
| T9 Fan-in approach x offset | 144 | 670 | Completed routing pass |
| T10 Zone reassignment | 83 | 670 | Completed routing pass |
| T11 Track/span/dogleg assignment | 4,187 | 8,365 | Bend zone |
| T12 Swap dogleg | 4 | 4 | Selected pair |
| T12 Shared crossing slice; T13 cycle dogleg/sort escape | 0 | 0 | Unexercised branches |
| T14 Nonzero explicit port berth | 213 | 670 | Completed pass |
| T15 Vertical coordinates constructed | 670 | 670 | Completed pass |
| T15 Zone grew beyond its default | 3,695 | 9,673 | Zone |
| T16 Fillet insertion | 35,013 | 38,030 | Bent-leg emission |
| T17 Built shelf geometry | 893 | 893 | Candidate |
| T18 `resizedLayout` | 99 | 298 | History resize |
| T18 Tile-only resize seed | 0 | 0 | Unexercised branch |
| T19 Retained-member geometry pruned | 191 | 191 | Subset construction |
| T19 Subset projection returned geometry | 191 | 650 | Projection (459 null) |
| T19 History frame normalized | 18 | 83 | History normalization |
| T19 Anchored translation returned geometry | 0 | 9 | Translation (9 null) |
| T20 Primary placement probes found geometry | 4,723 | 6,072 | New tile attempt |
| T20 Route-family wiring found geometry | 4,940 | 43,017 | Wiring attempt |
| T20 Entire insertion returned changed geometry | 668 | 876 | Embedding attempt |
| T21 Plain fallback placement | 584 | 829 | New tile attempt |
| T21 `gridWire` found geometry | 1,139 | 2,899 | Wiring attempt |
| T22 Finer-probe/grid second chance | 565 | 765 | New tile attempt |
| T22 `gridWireAll` found geometry | 555 | 1,364 | Wiring attempt |
| T23 Free blocked terminal ports | 0 | 812 | Pre-insertion repair |
| T24 Free internal port lanes | 64 | 165 | Repair |
| T25 Constrained retry returned geometry | 7 | 58 | Embedding retry |
| T25 Repairable retry returned draft geometry | 14 | 51 | Embedding retry |
| T26 New-sibling coordinates changed by identity | 33 | 668 | Completed insertion |
| T27 Hint reroute | 7 | 9 | Resize search |
| T27 Individual retained route rerouted | 5 | 5 | Route search |
| T28 Contact repair changed certified geometry | 10 | 32 | Repair call (15 null, 7 unchanged) |
| T29 Pane band bounds captured | 605 | 605 | Candidate allocation |
| T29 Pinned painted-envelope padding | 566 | 606 | Allocation (40 rejected) |
| T30 Extra outer gutter | 0 | 508 | Packing attempt |
| T30 Composed folder geometry | 363 | 363 | Composition; other states restore |
| T31 Shared header differs from lone header | 261 | 363 | Packed folder row |
| T32 Lone-header reduction accepted | 102 | 102 | Applicable reduction |
| T33 First-line header alignment accepted | 43 | 43 | Applicable alignment |
| T34 Drop/gutter/stem construction | Included in T35 | 4,430 | Aggregate attachment attribution |
| T35 Attachment changes coordinates/path/allocation | 4,425 | 4,430 | Attachment, including scoring/history |
| T36 Band admission replaced candidate | 0 | 864 | Band result |
| T36 Chain/fan/serial fallback constructors | 0 | 0 | Unexercised branches |
| T37 Folder-world pinning changed normal candidate | 133 | 135 | Pin search (2 null) |
| T38 Isolated-folder replacement | 0 | 363 | Normal folder compositions |
| T1/T39 Semantic plan/exact restore | 0 coordinate edits | — | Construct topology/reuse geometry; no repair-frequency inference |
| T40 Contact predicates/admission | 0 | — | Read-only by contract; no mutating hook |

The identical uninstrumented control workload produced the same serialized output
SHA-256, `a53d53af9796a799c3a496ddb1421ef6e926d5ecd3dae977999228cfed9d30d0`.
Temporary harness/hooks, counts and logs are `/tmp/routing-instrument.ts`,
`/tmp/routing-measure/run.ts`, `/tmp/routing-counts.json`, and
`/tmp/routing-measure.log`; the control is `/tmp/routing-control.ts`.
These are local audit artifacts, not committed dependencies. Zero use in this
sample is not evidence that a stage can safely be removed. It omits other tile
sizes, North/workflow profiles and timings; it cannot establish the 50 acceptance targets.

## Field methods: opened primary sources

The following is source evidence; the proposed synthesis and stronger pin policy
below are our design, not guarantees supplied by those libraries.

| Opened source | Relevant method / limit |
|---|---|
| Wybrow, Marriott, Stuckey, **Orthogonal Connector Routing**, GD 2009 proceedings published 2010, §§3–5 ([publisher PDF](https://link.springer.com/content/pdf/10.1007/978-3-642-11805-0_22.pdf)); publication date checked on [Monash record](https://research.monash.edu/en/publications/orthogonal-connector-routing/) | Build orthogonal visibility from obstacle corners and ports; A* state includes entry direction so length and bends can be priced. Order shared subroutes consistently before nudging maximal segments in separate x/y passes with separation constraints and VPSC projection. Single-connector optimality does not imply global multi-route optimality. The paper assumes distinct connection points; Trace's shared trunks and semantic joins need explicit adaptation. |
| libavoid [overview](https://www.adaptagrams.org/documentation/libavoid.html), [routing options/parameters](https://www.adaptagrams.org/documentation/namespaceAvoid.html), [connection pins](https://raw.githubusercontent.com/mjwybrow/adaptagrams/master/cola/libavoid/connectionpin.h), [orthogonal nudger](https://raw.githubusercontent.com/mjwybrow/adaptagrams/master/cola/libavoid/orthogonal.cpp), [VPSC implementation](https://raw.githubusercontent.com/mjwybrow/adaptagrams/master/cola/libavoid/vpsc.cpp) | Pins specify shape-relative locations and visibility directions; channels constrain shiftable segment coordinates. Nudging orders overlaps and solves separation constraints with `IncSolver`. Important non-transferable details: fixed/boundary solver variables use large weights, fixed output segments are skipped/clamped, unsatisfied channel groups can reduce spacing, and VPSC marks cyclic constraints unsatisfiable. Trace must substitute exact pin constants and reject violations instead of copying these escape policies. |
| ELK Layered [OrthogonalRoutingGenerator](https://raw.githubusercontent.com/eclipse-elk/elk/master/plugins/org.eclipse.elk.alg.layered/src/org/eclipse/elk/alg/layered/p5edges/orthogonal/OrthogonalRoutingGenerator.java), [OrthogonalEdgeRouter](https://raw.githubusercontent.com/eclipse-elk/elk/master/plugins/org.eclipse.elk.alg.layered/src/org/eclipse/elk/alg/layered/p5edges/OrthogonalEdgeRouter.java) | Assumes assigned node/port positions and proper layering. Hyperedge segments get critical conflict dependencies and weighted crossing preferences. Critical cycles split segments; noncritical dependencies may reverse/remove. Topological numbering assigns routing slots; slot count and edge-edge/edge-node spacing determine inter-layer width. Transfer the segment-order graph, not the generation-as-display-row assumption or soft dependency reversal for hard orders. |
| Gansner, Koutsofios, North, Vo, **A Technique for Drawing Directed Graphs**, §§4–5 ([Graphviz PDF](https://graphviz.org/documentation/TSE93.pdf)) | Fix within-rank order, impose neighbor separations, then minimize weighted absolute horizontal edge lengths using an auxiliary graph and network simplex; port offsets enter that graph explicitly. Long-edge virtual nodes guide connected free-space boxes for spline fitting, with endpoint tangents and shape clipping. Transfer constrained positioning and corridor-before-curve construction, not Graphviz's independent generation layers or its historical sampled spline-fit test. |
| North, Woodhull, **On-line Hierarchical Graph Drawing** ([Graphviz PDF](https://graphviz.org/documentation/NW01.pdf)), §§3.1–3.5; Ellson et al., **Graphviz and Dynagraph**, §3.5 ([PDF](https://graphviz.org/documentation/EGKNW03.pdf)); [author project index](https://www.dynagraph.org/documents/) | DynaDAG maintains a model/configuration across insert/modify/delete requests, updates long-edge chains, restricts crossing work to affected neighborhoods, and reroutes affected edges inside constraint polygons. Stability is explicit in ranking/positioning but largely a weighted trade-off; it is not exact restoration. Transfer incremental model maintenance; keep Trace's stronger exact pins and displayed-state ledger. |

Access limits: the Monash author PDF and its `csse`/`ialab` mirrors timed out;
the Springer PDF above opened successfully. The DOI landing page failed. The
Dynagraph-hosted `dynagraph-gd01.pdf` was a cache miss; Graphviz's `NW01.pdf`
opened successfully. The raw `vpsc.h` URL failed; `vpsc.cpp` opened. North's original
1995 *Incremental Layout in DynaDAG* was not obtained; the opened 2001 author paper
and 2003 overview supply the dynamic method. No claims rely on unopened search snippets.

## Concrete constraint model

### Variables, topology and coordinate frames

An immutable `RoutingProblem` contains rectangles, ports, junctions, semantic nets,
channels, maximal segments, orders and pins. Construction has no Svelte, worker or
IO state. Worker/inline engines serialize the same value; caches remain content keyed.
Keep public `GraphLayout`, consumer ranges and ordinary M/L/C output during migration.

| Kind | Explicit quantities |
|---|---|
| Metric variables | Tile top-left `x_v,y_v`; band translation `b_x,b_y`; folder-row origin `o_r`; junction `j_x,j_y`; port coordinates `p_x,p_y`; vertical segment x `t_s`, horizontal segment y `t_s`; channel boundaries `L_c,R_c,T_c,B_c`; allocation bounds. Fillet radius `r_k` is solved locally after sharp coordinates. |
| Fixed request facts | Tile width/height including actual hints; semantic DAG/consumer sets; host cover column; pane/metrics; mandatory port side/direction when already retained. |
| Discrete embedding choices | Display-row assignment/order, shelf/downward orientation, corridor sequence, port-side choice for new wiring, junction factoring/levels, compatible shared prefix, bend/split topology and relative track order. Existing constructors initially supply these choices. |
| History constants | Committed arrival rectangles; clicked tile and visible ancestry in their declared frame; unchanged band's row-relative child/track positions; retained route segments/ports chosen for reuse; complete exact revisit drawing. Store frame and stable endpoint/net/segment identity, not open-group ordinal or component ID. |

Equations relate frames, e.g. `y_world(v) = o_row + b_y + y_local(v)`.
Rows below a user-expanded earlier band may move together as the contract permits;
fixing a row-relative coordinate is not accidentally pinning every folder row to
world y. Arrival capture fixes world rectangles, including ordinary cells. A click
anchor expressed in world coordinates includes its frame transform in the equality.
Selection supplies no layout input. Exact revisits use the certified saved drawing;
they do not run another “close enough” optimization.

For valid arrival history, derive allowed hint rectangles before routing:
`x'_v=x_v`; `y'_v=y_v+16*d_v`, `d_v∈{0,1}` only below a source in the same
overlapping column gaining its first hint. Others have `d_v=0`; shrink never raises
retained tiles. Simultaneous growth cannot accumulate descents. Prefer `d_v=0`,
then test the permitted alternative; **each metric solve fixes that choice exactly**.
Other retained coordinates named by the request are equality constraints, never
large weights. Unpinned new placements can still use desired positions/soft costs.

### Constraints and solving

1. **Ordered rectangles and channels.** In each chosen display row,
   `x_next ≥ x_prev + width_prev + gap`; ordered disjoint packing uses the same
   inequalities after choosing above/beside relations. A downward child follows
   its parent row; a rightward shelf child follows its parent column. Long edges
   have a virtual crossing/port at each crossed display boundary, preserving their
   chosen order through successive gaps. A wrap is not a new generation.
2. **Metric segment separations.** For parallel incompatible segments `a≺b`
   sharing channel `c` over overlapping longitudinal intervals, add
   `t_b - t_a ≥ δ_ab`. At minimum `δ_ab=LANE_SEPARATION=3` centre-to-centre;
   port/corner, arrow, dot or turn-envelope interactions require the larger
   geometry-specific exclusion, not a global spacing inferred from route count.
   Reused same-source trunk is one segment variable. Nonoverlapping intervals may
   reuse a coordinate; do not chain every segment in a channel unnecessarily.
   Bound each segment within its certified free interval, e.g.
   `L_c+clearance_s ≤ t_s ≤ R_c-clearance_s` for a vertical lane.
3. **Port equations and order.** Bottom output:
   `p=(x_v+w_v/2,y_v+h_v)`, tangent down. Right output:
   `p=(x_v+w_v,y_v+h_v/2)`, tangent right. Top/left inputs use analogous
   equations; arrow path ends 8 px before the port, with an additional straight
   8 px shaft. Keep other ink outside the 6 px port berth. Current tile ports
   are shared exact points, not invented per-edge offsets. Order outgoing
   branches at the first split and junction inputs by geometric approach plus
   stable semantic tie-break; retain prior branch order. Along multi-port
   boundaries, preserve port order as explicit inequalities.
4. **Junction semantics.** A fan-out trunk carries exactly the union of its
   child consumers; branching adds no multi-input dot. “N children” is the
   direct-child hint from complete membership, not a routing-slot count or an
   excuse to reserve hidden descendant placements. A multi-parent output gets
   ordered independent input segments meeting only inside its own convergence
   region at its explicit dot, then one terminal arrow to that output. Nested
   subset joins union exactly their represented parent sets; partially overlapping
   sets stay separate. Keep foreign ink outside dot berths, all dot envelopes
   disjoint, and preserve consumer connectivity through shared trunks/spines.
5. **Corridors, crossings and paint.** Route topology names a connected sequence
   of tile-free corridor cells with explicit entry/exit ports and turn regions.
   Minkowski-style obstacle expansion reserves the actual max stroke, arrows,
   dots and turn envelope; cosmetic allocation padding is separate. An unrelated
   proper transverse crossing uses an explicit crossing region away from every
   corner/port/dot; it is not a junction. Do not require a planar embedding of
   arbitrary DAGs. Rounding stays inside the solved turn region,
   `0≤r_k≤min(6, incoming/2, outgoing/2, available track/lane clearance)`;
   certify against foreign native cubics as today. Zero clearance means sharp.

For a fixed topology/order, substitute fixed coordinates and port/frame equalities,
then check the remaining difference constraints (including bounds and pins) for
feasibility. DAG orders permit forward/backward bound propagation; general
dependency cycles require a proper difference-constraint feasibility check.
Optimize only free coordinates toward desired positions with a deterministic
VPSC-style active-set projection; a simple longest-path assignment is sufficient
only where there are no conflicting upper/interior pin bounds. Preserve the
existing candidate objective/hysteresis as the ranking of **feasible** embeddings;
its nonconvex moved-fraction/crossing terms need not become part of the projection.
Plain isotonic/PAV suffices for chain constraints, not every channel conflict DAG.

Every chosen port, separation and pinned-coordinate residual is checked after
numeric solve and before emission; rounding coordinates cannot consume clearance.
An equality pin is emitted from its original value. A conflict must return its
constraint/embedding witness; bounded topology search returns `search-exhausted`,
not global infeasibility. A single model permits several algorithms and local
re-solves without permitting different safety contracts.

### The fallback boundary

Today cold, shelf, incremental, relaxed-contact, serial and folder-isolated
constructors do not have identical constraints. The outer gates unify geometric
admission but do not enforce history stationarity. Replacing a stage means its
adopted path must preserve the same pin set all the way through fallback. No
conversion to `lane-infeasible`, no threshold reduction, no anchor-yield and no
rebuilding a cold candidate with history removed can count as a solved pinned state.

During migration, retain legacy constructors for the not-yet-adopted embeddings;
adopt new candidates only after exact pin checks **and** both unchanged gates.
Do not route a failed new pinned problem through an unpinned legacy fallback.
If all bounded constructions fail, report exhaustion/unsupported embedding and do
not publish it as the new state; the last committed scene remains committed until
a complete certified result exists. This is not an acceptance exemption: current
corpus errors/gate failures must stay zero, so any newly exhausted existing case
blocks expansion of the rollout scope. A conflicting fixed topology is not proof
that the requested graph/pins cannot be embedded another way.

## Ordered shipping slices

Estimates are changed production/test lines and focused engineer-days, excluding
review and the full evaluation run. All slices require `bun run check`, `bun run test`
and **all 50 current `layout:eval` targets** at their existing thresholds before
shipping. Keep `geometry-gate.ts`, `folder-layout/geometry-gate.ts`, their tolerances
and evaluation populations unchanged. Sample counts above do not replace that run.
Keep the old/new engines side by side until each slice's outcome is admitted;
measure fallback use and solve work as well as output quality. No new worker or
async pattern: use existing pure request/result and publication transaction.

| Slice | Replaces / independently shippable boundary | Required outcome beyond common checks | Size | Risk |
|---|---|---|---|---|
| **1. Channel and track assignment as a constraint solve (complete)** | T4/T11/T14/T15 metric assignment for existing ordered, representable channels; T31–T33 shared-row header rules, plus T34/T35 attachment offsets. Keep current row/corridor generators. Add common immutable segment/order/bounds/pin types and a deterministic separation solver first, within this slice. | Test below becomes ordinary `it`; retained tracks and child tops remain exact through packed attachment. Compatible disconnected spans reuse tracks. New groups can get deeper tracks/header/corridors without raising existing child tops. Differential tests for channel bound conflicts, pinned interior tracks, lifetime reuse and ordered insertions; no new fallback/errors. | 700–1,100 lines; 4–6 days | Medium-high: correct coordinate frame, cyclic orders, header corners and row packing are coupled. Scope adapters to represented channels and preserve other drawings. |
| **2. Explicit ports and painted corridors (complete)** | T8/T14/T16/T29/T34/T35 duplicated endpoint/envelope reconstruction. Import existing topology into explicit ports, arrow stubs and certified turn/corridor bounds; retain current emitter initially. | Same semantic consumers/endpoints and exact reused route geometry; native cubics, near-pane arrows and host cover chrome pass existing tests/gates. Retained unaffected stem paths remain byte-identical, supporting interrupted motion. Reject malformed imported plans. | 600–1,000 lines; 3–5 days | Medium: source vs branch endpoints, raw/attached transforms, stroke versus allocation extents. |
| **3. Junctions and corridor topology (complete)** | T3/T5–T10/T12/T13; reuse T1 semantics. Replace provisional/deferred/stacked placement, zone reconsideration and dropped ordering with explicit junction ports and channel search. | Critical cycle gets a certified split/crossing topology, never a discarded hard dependency. Exact parentage for reused subsets, 2–8 inputs, distant fan-outs and long edges; crossing/height/pane/fallback limits all hold. Try new corridor assignments before growing only free boundaries. | 1,200–1,800 lines; 6–9 days | High: combinatorial corridor capacity and fan-in/crossing semantics. Bounds on **total** search/constraint work, not per retry. |
| **4. Constrained incremental insertion and hint changes (open; lossless import boundary complete)** | T18–T28 plus T37's separate routing. Import committed drawing into same model, freeze declared tracks/rectangles/suffixes, add new ports/segments and re-solve affected conflict components. | Arrival world-oracles, merges/departures, single 16 px descent and shrink-space reuse; clicked ancestry equality; exact revisits and worker parity. Delete repairable-contact policy and port/bypass offset repair only when all old successes are covered. Preserve other retained tiles where the request pins them; optimize only free ones. | 1,200–1,900 lines; 6–10 days | High: pruning/identity, future departures, hint port changes, dense search tails. |
| **5. Cold sweeps and folder packing in that model** | T2/T17/T19/T30/T36–T38 placement alternatives. Shelves, downward and serial layouts become embedding generators feeding one solve; packing contributes constraints before final routing. | All cold widths/presets and legal tours retain display/long-edge order, quality and timing targets. New-state sweeps may choose freer embeddings; pinned states never lose pins when a compact/serial candidate is considered. Folder ordinary cells and other bands are first-class obstacles. | 1,000–1,600 lines; 5–8 days | High: compactness, candidate pruning and 10 ms inline budget; avoids a simultaneous scoring rewrite. |
| **6. Remove superseded routers/repairs** | Delete remaining legacy T21–T25/T28/T36/T38 implementations once every embedding uses common constraints; T5–T7/T10/T13 are deleted in slice 3. Retain T1 consumer semantics, T16 emitter if still useful, T39 history and T40 independent gates. | No legacy escapes reached across full acceptance and targeted rare-branch fixtures; safe chain/fan/serial are certified embedding choices under identical pins. New diagnostics distinguish topology conflict, metric conflict, unsupported input and budget exhaustion. | 300–700 new/changed lines, larger net deletion; 2–4 days | Medium after coverage; zero sample use alone never justifies deletion. |

Slices 3–5 are intentionally separate: metric solving first establishes enforceable
contracts; topology search then supplies better feasible choices; insertion and
cold/packing reuse them. Shipping only telemetry/imported constraints without
fixing the shared-row case does **not** complete slice 1.

### Slice 1 acceptance at design time

[`shared-row-track-stability.test.ts`](../tests/domain/trace-graph/shared-row-track-stability.test.ts)
was one `it.fails` at `6768262`, with the known reason in its title. It uses the real default
folder engine, a reduced version of the harness's village/forest/fan graphs,
`deeper=1`, and 18+2 fan children. It represents the 420 px fallback pane with
400 px engine width and fallback metrics; actual client width also depends on
platform scrollbar allocation.
It opens village, opens forest, closes
village (the e2e's motion destination), then opens fan while forest is unchanged.
Both results pass the unchanged folder gate; the fan is visible and wraps below
forest **in the same logical cover row**, and all covers/grid cells stay fixed.
The contract asserts every forest child's world rectangle is exactly unchanged.
Setup, independent-gate and wrapping checks run in `beforeAll`, outside `it.fails`,
so unrelated failures cannot satisfy the expected-failure marker.

| Observable | Before | Observed defect | Required |
|---|---:|---:|---:|
| forest-mist x / y / width / height | 49 / 131 / 92 / 97 | 49 / 137 / 92 / 97 | Exact before rectangle |
| autumn x / y / width / height | 157 / 131 / 92 / 81 | 157 / 137 / 92 / 81 | Exact before rectangle |
| Forest attachment track / header (diagnosis only) | 6 / 34 | 10 / 40 | Retain old track and child top |

Running an ordinary-`it` transform of this test under a temporary Vitest config
fails **at the final rectangle equality**, not a setup check: expected y=131,
received y=137 for both children. The committed `it.fails` passes as an expected
failure. The engine-level assertion isolates the changed destination; animation
continuation remains the existing browser spec's responsibility in a later
implementation pass.

Feasibility witness under `/tmp/routing-witness.ts`: keep forest's complete
previous attached drawing, place the fan as in the new engine result (track 20),
and retain the current allocation's spare space. `folderGeometryGate` returns
null. Thus slice 1 does not need a stronger oracle or a wider pane. Pin forest's
track at 6 and its child top at 131; add constraints only for the fan segments
whose swept intervals conflict, and give the later band's own header its required
depth. Do not apply `max(all headers)` to already retained children. This witness
establishes this fixture's feasibility, not a general solver or motion proof.

## Risks and open questions

- **Discrete completeness:** ordered segment placement cannot repair an impossible
  corridor/order choice. Keep conflict witnesses and bounded alternative search;
  a larger budget is not a feasibility proof. Preserve permitted proper crossings.
- **Identity/frame lifetime:** segment identity must survive cloning, subset
  factoring, merges and attachment; component IDs/open-group indexes cannot be
  pin keys. Specify correspondence at split/merge before migrating route history.
- **Hard pin rollout:** current accepted tours include moved click anchors and
  bounded pin-search failures. A new engine cannot call those successful pinned
  solves. It must find a better embedding, or its rollout remains limited; do not
  relax acceptance or silently unpin to finish migration. Product behavior for
  an actually contradictory pin request needs an explicit error outcome.
- **History invalidation:** metric/pane/content changes keep their current
  compatibility rules. Corridor persistence is an optional history witness, never
  an authority bypassing history validation or either geometry gate.
- **Numeric/paint bounds:** projection tolerances, 0.01 px formatting, giant tiles,
  native curves and near-boundary arrows can consume slack. Fix retained output
  values exactly; conservatively reserve free-coordinate rounding clearance.
- **Performance:** use overlap sweeps and conflict components instead of all-pairs
  constraints everywhere; charge graph build, constraint checks and topology
  retries to one request budget. Full timing must run quiet, separately from
  instrumentation. Do not infer production speed from these instrumented counts.
- **Port/fan ordering:** geometric approach order and original ordered-input
  metadata are different. Preserve input order in consumers/metadata; avoid
  inventing a visual reorder prohibition that forces unnecessary crossings.
- **Open choice:** implement the small TypeScript separation solver in-house or
  adapt a solver? Decide after slice 1's bounded fixed-pin conflict cases, bundle
  cost and numerical residual checks. VPSC is a method reference, not an automatic
  dependency/licensing decision. No global optimality promise is required.

## Verification of this design pass

- Production source and both geometry gates unchanged; only this document and
  the one expected-failure reproduction are committed.
- `bun run check`: 0 errors, 0 warnings.
- Targeted reproduction: one expected failure; temporary ordinary-`it` run proves
  the intended 6 px assertion failure.
- Targeted corpus/control: identical output digest, zero admitted gate failures.
- Full `bun run test`: 2,071 passed, one expected failure, one skipped, one existing
  5-second timeout (`review-fixes.test.ts:75`, 5,394 ms) during instrumentation.
  That file passed all 10 tests on a focused rerun (2.64 s total); no assertion
  failure remained. Full run duration: 1,189.37 s.
- Independent adversarial review: no remaining material findings after adding
  missing measurement attribution and moving expected-failure setup checks outside
  the expected-failure body.
- Full `layout:eval` intentionally not run; current 50-target success is the base
  contract, not a new measurement.

## Slice 1 implementation and acceptance (complete)

The fixed-order metric solve is in `separation.ts`: immutable coordinate bounds,
pins, swept segments and order constraints; forward lower/backward upper
propagation on a DAG; deterministic preferred-coordinate clamping; exact original
pin emission and forward residual checks. Conflicts carry an ordered constraint
witness. This is difference-constraint feasibility, not VPSC or a claim of an
optimal projection. The method follows the constraint-graph formulation in
[MIT 6.006 lecture 17](https://courses.csail.mit.edu/6.006/spring11/lectures/lec17.pdf).
Reverse floating subtraction is checked in the forward direction; an unsafe free
bound steps to the adjacent smaller representable number, without a geometric
tolerance or any change to a pin.

The adapters retain the existing discrete generators:

- T4: ordered interior-gap lanes with representable minimum spacing. Outer margins
  still choose free intervals and orders dynamically, so their legacy lifetime
  allocator is outside this fixed-order rollout and remains byte-identical.
- T11: acyclic singleton turn units become a conflict DAG; disjoint swept spans
  reuse tracks. Swap cells, cycle splits and their metric paths remain legacy.
- T14/T15: plain zones solve departure/track/trailing bounds and a free end
  boundary; equal-endpoint plain channels solve their spread centers. Native
  crossing/fan windows keep their existing emitter and coordinates.
- T31–T35: cold header alignment is a feasible preference in the common solve.
  Retained attachment adoption covers one retained net followed by one wrapped
  new net in the same packing frame, with the new source port clear of retained
  turn columns. Its track and child top are exact equalities. Foreign port
  exclusions and multiple bypasses need painted corridors and remain outside
  this adapter. Validate history replay before importing those equalities.
  Child transforms substitute the solved top directly instead of inheriting a
  neighbor's header. Unsupported drawings retain their original bytes.

The unchanged shared-row test is now ordinary `it`, with both the reduced design
fixture and the full village graph from `view-fixture.ts` (`deeper=1`, 18+2 fan
children). Both retain forest's child rectangles and route strings exactly, pass
the unchanged folder gate and introduce no fallback. The browser motion test's
`fixme` is removed with its assertions unchanged; browser execution is left to the
user as requested.

Differential checks: 195 layered corpus/width drawings and 63 cold packing states
match unmodified `6768262` byte-for-byte. Three unsupported port/multiple-bypass
counterexamples match complete baseline folder bytes. A separate 896-transition
baseline/current audit changes 128 attachment assignments with zero changed
fallback outcomes/errors. Solver tests include exhaustive bounded feasibility,
interior pins, ordered insertions, disjoint lifetimes, malformed inputs, decimal
pin arithmetic and 10,000 tracks. Independent adversarial review found and drove
regressions for malformed provenance, incomplete port-scope adoption and negative
decimal reverse bounds. Blocking re-review accepted the adopted scope with no
remaining material findings; it independently checked 300 bounded decimal
problems and 96 additional folder transitions.

Final type checking passed with 0 errors and 0 warnings. Full unit testing passed:
168 files, 2,111 passed, one existing skip, no expected failures or timeouts
(1,455.02 s). Final bench has 12,120 rows with unchanged proposed means and zero
engine errors; reveal summaries/movement across 3,150 rows are unchanged; all 280
packing rows are byte-identical. Both the unmodified baseline and final `bun run layout:eval` passed **all 50
current targets**, with thresholds and populations unchanged. The absent initial
`layout-eval/out/acceptance.md` was replaced by an unmodified snapshot evaluation;
its report was saved to `/tmp/routing-s1-acceptance-before.md`/`.json` for comparison.

Only these current acceptance rows changed; the other 47 rows are identical:

| Current target, maximum p95 ms | Before (`6768262`) | Slice 1 | Existing limit |
|---|---:|---:|---:|
| Main-thread | 2.734 | 3.102 | 8.000 |
| ≤30 visible tiles | 49.111 | 42.259 | 100.000 |
| Full folder engine inline | 4.018 | 3.085 | 5.000 |

These are separate timing measurements, not evidence that every workload got
faster. Final perf load on 24 CPUs was 8.76 / 11.40 / 14.64 before,
3.89 / 4.65 / 8.73 after (1 / 5 / 15 minutes). No timing target failed and no
perf rerun was needed. The original control was measured under higher load.

Geometry fallback counts are unchanged: corpus 0/6,060, tours 1/3,150 (0.032%),
packing 0/140; every fallback stays inside the pane. Hard violations/errors,
independent geometry gate failures and unexplained shared lanes are all zero.
Worker/main parity, exact revisits and arrival pinning pass in the full suite.

The regression's shipped forest child rectangles are unchanged at y=131
(previous defect: y=137), with track 6 and header 34 retained exactly. The new
fan can retain its deeper track/header (20/50) independently. The unchanged
folder gate admits both results. This completes slice 1 for the declared
represented channels, not the later port/corridor or incremental-routing slices.

Compared with `6768262`, the adopted production paths delete 36 old lines:
27 in `band-geometry.ts`, 6 in `layout.ts`, 3 in `folder-layout/default-engine.ts`.
Legacy paths remain where their topology/order/paint is outside this model.
Slice 2 still needs explicit painted ports/corridors and shared endpoint
reconstruction before expanding retained adoption to foreign port interactions
and multiple bypasses. Dynamic margin orders and crossing/cycle topology remain
for the subsequent topology slice.

## Slice 2 implementation and acceptance (complete)

`routing-plan.ts` imports the existing generators into explicit tile/junction
ports (owner, side, offset and point), arrow bases/tips/straight shafts, native
M/L/C primitives, and painted corridor/turn bounds. A `RoutingPath` binds its
ports, primitives, allocated paint and certified turns; completed shared nets
retain the original route object, consumer ranges and path bytes. Row-local
departures, completed nets and attachment/channel polylines use this same import
boundary. Allocation uses its shared paint projection: even a candidate with
inadmissible endpoint semantics must have all its ink measured, rather than
silently omitted. Cosmetic padding remains a separate projection of the hull.

T8/T14 consume imported departure ports; T16 and T35 keep the existing path-data
emitter while supplying imported turn certificates; T29 reads the shared native
stroke/arrow/dot envelopes; T34 imports the cover/cut-tail ports and bridge/drop
polyline. The attachment lane is an exact pin within the slice 1 solver's bounds.
Stroke and dot dimensions come from `connector-ink.ts`, arrow dimensions from
`metrics.ts`; the existing 6 px fillet maximum is now one shared paint constant.
No topology choice, repair policy, emitter formatting or gate tolerance changes.

Validation rejects off-edge ports, mismatched stubs/tangents, missing or narrow
paint allocations, detached source branches, missing/unrelated turns, malformed
path grammar, nonfinite geometry, duplicate identities and altered native command
structure. Actual native straight ink must witness the terminal arrow shaft.
The existing decimal serialization allowance is kept distinct from exact metric
pins. These are local containment certificates, not a replacement for independent
whole-drawing admission or foreign-curve clearance certification.

A frozen `bun build` of the unmodified `11d46d8` engine served as the oracle for a
one-off differential. It is not kept in the suite, because later slices change
drawings on purpose. The differential passed **6,318 attached drawings**:
65 corpus graphs, every existing width (360/454/640/900/1400) and preset
(48/64/96/128), all their 6,060 focus/history states, plus 258 sampled legal tour
states including dense merges. It compares complete serialized drawings, one at
a time, including semantic endpoints, consumers and untouched retained path
strings. The final full suite also passed it after validation refinements. A separate
260-drawing raw-topology census verifies import without rewriting route metadata.

That differential compared engine drawings, not their publication consumers.
The slice 2 merge regression returned the same certified drawing as slice 1,
then threw while presentation captured an attachment descriptor: a world-placed
merged envelope includes the absorbed cover beside the surviving cover, so its
top is above the packed child-band frame. `bandRouteStem` now declines that
inapplicable transform; the native route remains authoritative and routing-plan
validation stays strict. The browser-free two-chains regression carries the
previous layout through the real view input adapter, inline runtime and worker
reply protocol, then builds the scene and snapped presentation. Existing
component-merge tests checked geometry, pinning and revisits without this final
consumer; within-graph convergence cases did not exercise component publication.

Independent blocking adversarial review accepted the implementation after
regressions for native primitive/shaft/turn bindings, branch connectivity and
paint allocation. Its final focused run passed 166 tests across 10 files.
Final type checking passed: 264 files, 0 errors and 0 warnings. Full testing
passed: 170 files, 2,135 tests passed and one existing skip (1,220.39 s), including
23 validation/import contracts (the differential ran in the same suite before it was removed). Both geometry gates,
their tolerances, evaluation populations, `presentation.ts`, `scene-motion.ts`
and `StackGrid.svelte` remain unchanged.

The archived unmodified `11d46d8` evaluation passed all 50 current targets. Its
acceptance was saved to `/tmp/routing-s2-acceptance-before.md` and `.json` before
starting the final evaluation. Final bench has 12,120 rows identical after
excluding timing/work fields, with identical proposed quality means and zero
errors. All 3,150 reveal rows, their broad/dense summaries and movement are
identical; all 280 packing rows are byte-identical. Final `bun run layout:eval`
passed **all 50 current targets**, exit 0, with no perf rerun. All 47 non-timing
acceptance rows are identical; only these three timing rows changed:

| Current target, maximum p95 ms | Before (`11d46d8`) | Slice 2 | Existing limit |
|---|---:|---:|---:|
| Main-thread | 3.089 | 2.748 | 8.000 |
| ≤30 visible tiles | 40.507 | 15.416 | 100.000 |
| Full folder engine inline | 3.143 | 3.448 | 5.000 |

These are separate timing measurements, not an optimization claim. Baseline
load on 24 CPUs was 16.25 / 12.96 / 11.39 before and 3.49 / 4.94 / 7.48 after;
final load was 3.62 / 4.11 / 5.37 before and 3.41 / 3.88 / 4.61 after
(1 / 5 / 15 minutes). No timing target failed in either run.

Fallbacks are unchanged: corpus 0/6,060, tours 1/3,150 (0.032%), packing 0/140;
all remain inside the pane. Hard violations/errors, independent gate failures
and unexplained shared lanes remain zero. Exact revisits, worker/main parity,
arrival pinning and retained stem-path contracts pass in the full suite.
Comparison artifacts are `/tmp/routing-s2-acceptance-diff.json`,
`/tmp/routing-s2-bench-diff.json` and `/tmp/routing-s2-quality-diff.json`.

Across the existing six stage implementations, the net reduction is **76
lines**, excluding the new shared representation: 54 in `band-geometry.ts`,
8 in `channel-corners.ts`, 16 in `pinned-band-extent.ts`, 6 in
`folder-layout/route-bounds.ts`, offset by 8 added lines in `layout.ts`.

Slice 3 still owns junction factoring/ports and convergence regions, corridor
alternatives, crossings/cycle splits, and removal of provisional/deferred/stacked
placement. This slice does not broaden slice 1's retained attachment adoption or
delete the foreign native-curve clearance algorithm.

## Slice 3 implementation and acceptance (complete)

The pure deterministic search is [corridor-search.ts:25](../src/lib/domain/trace-graph/corridor-search.ts#L25), adopted by `layout.ts:360`. One **64,000,000-unit total ledger** covers candidate reconstruction, discrete alternatives, boundary growth, metric solves, native import and quality evaluation. It is never reset on retry. Candidate coordinates use `solveSeparation`; completed competing candidates use the existing `measure`/`cost` objective. The production policy returns its first fully scored feasible incumbent; band embedding ranking and hysteresis remain unchanged. A genuine singleton on the first reconstruction needs no ranking; the last remaining assignment after rejection is still scored. An unaffordable first score returns a conflict. This is bounded feasible search, not global optimization or exhaustive width minimization.

Junction domains reserve exact T1 inputs, levels and convergence regions before corridor occupancy. `junctionInputPorts` in `routing-plan.ts:46` supplies source-bound approach ports; complete plans include meetings and independently validate exact parent sets, nested subsets, native-path bindings and separate approaches. Same-source branch connectivity and junction input lookup charge traversal to the same ledger. Removing the speed-only lookup indexes preserves the complete drawing digest and every stage count; the restored traversal charges explain the final ledger maximum. Discrete/metric conflicts and exhausted searches return an explicit conflict through `RoutingConflictError`; cold bands enter the existing certified fallback ladder. Retained-history conflicts rethrow, keeping the last committed scene rather than discarding its pins.

Channel critical dependencies are explicit departure/arrival pieces in [channel-topology.ts:37](../src/lib/domain/trace-graph/channel-topology.ts#L37). A cycle chooses a split member and a free column, then rebuilds and metric-solves the complete dependency graph. Every original leave-before-arrive edge binds its actual piece; no hard edge is deleted. Swaps use this same split topology. The unchanged whole-drawing gates still decide publication.

Small unordered gaps use exact subset capacity pruning for up to eight occupants (larger groups retain the final hard metric solve). New corridor alternatives are tried before increasing free boundaries, using the same ledger. Left-boundary growth includes alignment delay only for lower bounds whose downstream separation path reaches that boundary, via `freeBoundaryGrowth` in `channel-domains.ts:27`. This avoids charging unrelated narrow rows: both existing compactness fixtures retain their pane fit and height limits.

### Deleted stages

All locations in this table name **unmodified `b38b374`**, since the removed lines have no current location. No inventoried replacement stage remains as a legacy escape.

| Stage | Deleted old `layout.ts` lines | Current responsibility |
|---|---|---|
| T3 Provisional junctions | 777–872 | Immutable junction domains, current 750 onward |
| T5 Compression / widening | 389–407; 1163–1166 | Fixed-domain margin solve and free-boundary alternatives, current 1060 onward |
| T6 Deferred placement / T7 stacked dots and dropped keepouts | 1205–1254 | Initial hard junction/corridor constraints; no later relocation or keepout removal |
| T9 Approach-offset pass | 1287–1303 | Source-bound junction input ports, current 1240 onward |
| T10 Zone reconsideration | 1314–1424 | Hard zone choices in the joint search, current 1270 onward |
| T12 Swap cells / T13 cycle and sort escape | 1443–1471; 1480–1645 | Explicit split pieces and dependency solve in `channel-topology.ts` |

T1 semantic factoring/consumers, T2 rows, T4 corridor generation/lifetime preferences, T8 compact trunks and T14–T16 metric bounds/emission remain. Their responsibilities were not deleted; T4's blocked-inner-offset escape and T11's legacy track/swap/cycle assignment were replaced. Shelves, insertion/repair and folder packing remain outside this slice.

### Repeated inventory

The original design workload and local hook semantics were replayed on `b38b374` and slice 3: **522 legal tour steps, 65 cold bands, 65 raw layered diagnostics, 398 folder states**. Both runs have zero published gate failures. Each instrumented drawing digest matches its own uninstrumented control: before `d89206be60cbbf56c880544636eca259104ad5b1667985e461501bc9cd8315f2`; after `47e279306a18a12ce71fae8d30359f2d6ef5121b4bef64969d4d8ad803e82210`. These digests differ because topology may change. The T11 hook covers both slice 1's early acyclic exit and the legacy final exit on the base; its measured 4,187 / 8,365 agrees with the original inventory.

Counts include reconstructed and rejected drafts, not distinct published layouts. The final first-incumbent policy reaches 670 completed lane/track/emission passes for 670 successful searches, with 981 row-construction attempts including early capacity rejections. Local-stage hooks count reaching their original observation point; earlier rejections still consume the same search work ledger. A missing legacy hook means its implementation was deleted, not an inferred lack of use. T1/T39 do semantic construction/exact replay; T40 is read-only; none introduces coordinate repairs to count. T18's tile-only seed, T36's terminal safe constructors and T38 isolation remain unexercised in this workload. As in the original design table, T38's denominator is the 363 normal folder-composition opportunities; the isolation constructor itself has zero calls.

| Stage | Before: changes / calls | Slice 3: changes / calls |
|---|---:|---:|
| T2 Row placement | 890 / 890 | 981 / 981 |
| T3 Provisional junctions | 306 / 890 | 0 / 0 |
| T4 Lane allocation | 623 / 890 | 403 / 670 |
| T5 Margin compression | 581 / 843 | 0 / 0 |
| T5 Legacy widening retries | 220 / 220 | 0 / 0 |
| T6 Deferred junctions | 5 / 890 | 0 / 0 |
| T7 Stacked dots | 0 / 8 | 0 / 0 |
| T7 Dropped keepouts | 0 / 8 | 0 / 0 |
| T8 Shared trunks | 383 / 670 | 383 / 670 |
| T9 Post-placement fan offsets | 144 / 670 | 0 / 0 |
| T10 Zone reconsideration | 83 / 670 | 0 / 0 |
| T11 Track assignment | 4,187 / 8,365 | 4,198 / 8,363 |
| T12 Swap dogleg | 4 / 4 | 0 / 0 |
| T12 Shared crossing slice | 0 / 0 | 0 / 0 |
| T13 Cycle dogleg | 0 / 0 | 0 / 0 |
| T13 Sort escape | 0 / 0 | 0 / 0 |
| T14 Port berth | 213 / 670 | 213 / 670 |
| T15 Vertical placement | 670 / 670 | 670 / 670 |
| T15 Zone growth | 3,695 / 9,673 | 3,709 / 9,672 |
| T16 Fillets | 35,013 / 38,030 | 36,366 / 38,622 |
| T17 Shelf constructor | 893 / 893 | 893 / 893 |
| T18 Resize | 99 / 298 | 99 / 298 |
| T19 Retain members | 191 / 191 | 189 / 189 |
| T19 Subset projection | 191 / 650 | 189 / 648 |
| T19 Normalize frame | 18 / 83 | 18 / 83 |
| T19 Anchor translation | 0 / 9 | 0 / 9 |
| T20 Primary probes | 4,723 / 6,072 | 4,581 / 5,785 |
| T20 Wiring | 4,940 / 43,017 | 4,782 / 38,823 |
| T20 Insertion | 668 / 876 | 660 / 888 |
| T21 Plain placement | 584 / 829 | 591 / 848 |
| T21 Grid wiring | 1,139 / 2,899 | 967 / 2,655 |
| T22 Second placement | 565 / 765 | 393 / 613 |
| T22 All-lane wiring | 555 / 1,364 | 376 / 1,100 |
| T23 Free terminal ports | 0 / 812 | 0 / 808 |
| T24 Free internal lanes | 64 / 165 | 80 / 169 |
| T25 Constrained retry | 7 / 58 | 5 / 57 |
| T25 Repairable retry | 14 / 51 | 12 / 52 |
| T26 Leaf ordering | 33 / 668 | 33 / 660 |
| T27 Hint reroute | 7 / 9 | 7 / 9 |
| T27 Retained route | 5 / 5 | 5 / 5 |
| T28 Contact repair | 10 / 32 | 11 / 27 |
| T29 Pane allocation | 605 / 605 | 605 / 605 |
| T29 Painted envelope | 566 / 606 | 558 / 598 |
| T30 Packing | 1,656 / 1,656 | 1,656 / 1,656 |
| T30 Outer gutter | 0 / 828 | 0 / 828 |
| T30 Folder composition | 363 / 363 | 363 / 363 |
| T31 Shared header | 261 / 363 | 261 / 363 |
| T32 Lone reduction | 102 / 102 | 102 / 102 |
| T33 First-line alignment | 45 / 363 | 45 / 363 |
| T34/T35 Attachment | 4,475 / 4,480 | 4,462 / 4,467 |
| T36 Band fallback | 0 / 864 | 0 / 864 |
| T37 Folder pins | 133 / 135 | 133 / 135 |
| T38 Isolation | 0 / 363 | 0 / 363 |
| New: junction placement | 0 / 0 | 386 / 981 |
| New: junction input ports | 0 / 0 | 144 / 670 |
| New: free-boundary growth | 0 / 0 | 155 / 155 |
| New: whole corridor search | 0 / 0 | 670 / 670 |

The 670 joint searches all succeeded; maximum work **5,454,889**, maximum reconstructed candidates **7**, and no conflict/exhaustion occurred in this measurement population. New free-boundary growth fired 155 times instead of the old 220 widening retries; old compression, provisional/deferred relocation, keepout relaxation, zone reconsideration and swap/cycle escapes have no implementation. The constructed cycle/swap and exhaustion tests cover branches the original corpus did not exercise. Remaining T18–T28/T37 counts identify the retained insertion paths reserved for slice 4.

Audit artifacts: `/tmp/routing-s3-prepare-instrument.ts`, `/tmp/routing-s3-instrument-before.ts`, `/tmp/routing-s3-counts-before.json`, `/tmp/routing-s3-control-counts-before.json`; after generator `/tmp/routing-s3-prepare-after.ts`, and the final counts/control under `.routing-s3-tmp/counts-after.json` and `control-counts-after.json`. These are temporary local audit artifacts, not production dependencies.

### Tests, review and publication

Fail-first search contracts cover 2–8 exact junction inputs, reused subsets, distant fan-out, multi-row long edges, a constructed critical cycle, a swap, and total-budget exhaustion. Additional contracts cover deterministic immutable inputs, alternate metric feasibility with exact pins, capacity pruning, boundary bottlenecks, incumbent retention, malformed meeting metadata, duplicate parent declarations and coincident approaches. Polyline work exhaustion was reproduced before the callback fix. The existing 20,000-node chains, 3,000-output fans, sparse annotation scaling and both compactness fixtures pass focused verification without changed bounds.

The publication fixture runs ten component-merge/close/revisit/arrival/close/revisit steps through the real view input adapter, inline runtime, real worker replies, scene construction and snapped presentation. Exact revisits compare complete drawings; arrivals retain existing world rectangles. It exposed a base history-validation defect: pending-output logical order near 10¹² was treated as a bounded pixel coordinate, discarding valid history. `history-boundary.ts` now requires finite logical order while retaining coordinate bounds for sizes. The baseline failed this regression before the fix; the valid committed scene and worker/main parity are preserved afterward.

Fresh blocking adversarial review was accepted after independent dependency, parentage, boundary-feasibility, large-fallback, scale and publication probes. Review-driven regressions include missing/false meetings, duplicate parents, optional incumbent loss, unmetered construction and the dense 12-root/66-output case. The historical slice 1 layered differential keeps all 195 input cases, replacing its obsolete coordinate hash with exact visible-node, parentage and consumer coverage plus native port validation after structured transfer. The raw topology census and complete acceptance populations also remain. Every distinct serialized column now takes an orthogonal bend, including subpixel offsets; a fail-first quarter-pixel departure regression and the affected five-step corpus replay verify native source tangents without relaxing validation. A formerly lane-infeasible fixture now routes without fallback and retains independent safety/shared-lane assertions.

Final type checking passes: **267 files, zero errors and warnings**. The complete final-source unit gate passes with four workers: **170 files, 2,185 tests passed and one existing skip** (1,426.13 s), including all 195 historical inputs and the new publication regressions. A fresh final blocking correctness review accepted this intended source and independently passed 109 tests across six files; no source changes followed it.

Final `bun run layout:eval` passes **all 50 current targets**, exit 0, on the first completed run at the authorized 10 ms inline limit. It produced 12,120 corpus comparison rows (6,060 proposed layouts), 3,150 tour steps and 280 packing rows (140 proposed states). Hard violations/errors, independent gate failures and unexplained connector lanes are **zero**. Geometry fallbacks are now **0/6,060 corpus, 0/3,150 tours and 0/140 packing**, all inside the pane; the saved baseline had one tour fallback (0.031746%). Main-thread maximum p95 is 4.328417 ms against 8, ≤30 visible tiles maximum p95 is 47.617739 ms against 100, and full-folder inline maximum p95 is 5.986872 ms against 10. No perf-only retry was needed. Observed perf-stage load ranged from 7.10 to 14.88; final load was 13.29 / 14.35 / 13.27 (1 / 5 / 15 minutes). These are separate timing measurements, not an optimization claim.

Neither geometry gate, its tolerances, evaluation populations, `presentation.ts`, `scene-motion.ts` nor `StackGrid.svelte` has changed. Selection remains outside layout inputs. Slice 4 still owns retained corridor/track/suffix adoption, insertion, hint changes and removal of T18–T28/T37 repair policies; cold row/shelf/folder embedding consolidation remains slice 5.

The product decision on 2026-10-18 stops performance work and raises only the full-folder inline p95 limit from **5 to 10 ms**, already committed in `db85304`. All other thresholds and populations remain unchanged. The saved unmodified `b38b374` acceptance is compared as measured: its inline timing failed under contention (43.683 ms; load 9.27 / 10.25 / 11.35 before, 7.62 / 7.29 / 9.31 after, with transient load above 14). The baseline is not rerun.

Speed-only branch/junction lookup caches, reference-identity short circuits and the duplicate point-wise paint containment path were removed from the intended source. Already tested simplifications remain: local emission consumes normalized points and certified turns through `importTurnPlan`; complete candidates still receive full native validation. Direct port construction avoids building and replacing temporary identities; native equality checks consume primitives directly. The first quality-feasible incumbent policy remains, followed by unchanged band ranking. No profiling or timing optimization is part of final acceptance.

### Every changed current acceptance row

All **50** current rows were compared by exact target identity and numeric value with the saved unmodified `b38b374` acceptance: **26 changed, 24 unchanged, zero failures**. The inline limit change from 5 to 10 ms is the only threshold difference; every other threshold and population is identical. Values below are rounded to six decimals; the archived JSON retains full precision.

| Current target | Before (`b38b374`) | Slice 3 | Current limit |
|---|---:|---:|---:|
| corpus new-state per-layout movedFraction | 0.123791 | 0.122412 | 0.128280 |
| corpus new-state transition movedFraction | 0.197611 | 0.195411 | 0.257410 |
| broad new-state transition movedFraction | 0.049549 | 0.050285 | 0.078831 |
| Click anchor moves, including packing | 25 | 26 | 32 |
| Dense-tour anchor moves | 82 | 73 | 101 |
| Mean legal displacement, px | 13.016643 | 12.271997 | 17.530000 |
| Held-screen moves at 480 px (broad) | 25 | 31 | 80 |
| Held-screen moves at 480 px (dense) | 77 | 70 | 114 |
| Main-thread maximum p95, ms | 2.583575 | 4.328417 | 8 |
| ≤30 visible tiles maximum p95, ms | 27.250072 | 47.617739 | 100 |
| Full folder engine maximum inline p95, ms (no saved main measurement) | 43.682763 | 5.986872 | 10 |
| Mean height | 2117.381848 | 2119.691254 | 2372.651320 |
| Mean width | 555.920533 | 556.575731 | 603.002483 |
| Mean area | 1160917.662807 | 1168364.099498 | 1417008.637735 |
| Mean whitespace | 0.482170 | 0.482588 | 0.554242 |
| Mean paneWhitespace | 0.610242 | 0.610495 | 0.699334 |
| Mean length | 37030.996694 | 37614.444695 | 46535.064381 |
| Mean bends | 152.752515 | 154.108557 | 157.203003 |
| Mean crossings | 318.024092 | 333.099340 | 364.359571 |
| Mean mixedDirections | 1.534818 | 1.532508 | 2.288581 |
| Mean siblingInversions | 0.104290 | 0.102310 | 0.106914 |
| Mean unaligned | 0.162046 | 0.164026 | 0.176617 |
| Mean displacement | 28.961140 | 28.934352 | 34.757087 |
| Mean maxDisplacement | 66.208057 | 65.964872 | 80.188254 |
| Mean overflow | 2.674010 | 3.090759 | 4.326320 |
| tours geometry fallback rate, % | 0.031746 | 0 | 0.500000 |

The baseline acceptance, current complete report, exact comparison, repeated inventory and controls, source hashes, fail-first evidence and correctness reviews are archived in ignored `layout-eval/out/routing-s3-audit.tar.gz`. The final handover and portable commit bundle are beside that archive. No browser/Playwright run or push was performed.

## Slice 3 save/publication regression (PR #95)

The throttled save trace exposed an older folder-frame error. Entry 17 is not a
corridor-search conflict or a band fallback: all three bands are committed
`folder-pinned-extension` drawings, and the previous complete folder passes the
unchanged geometry gate. `priorOf` deliberately has no attachment transform for
`worldPlaced` history, but the old `planBands` kept that world drawing as raw
geometry. `composeFolderLayout` attached it again. In the forest band, the
reconstructed right departure starts at x=197.5 inside the cover rectangle
x=113.5…205.5. The `route-through-tile` rejection is real; recomposition created it.
Member facts did not change, so `folderPlacementHistory` did not run the world
pinning path. The folder's isolated-row ladder then forced one column and
864×4746 instead of the already certified eight-column 864×852 drawing.

The inline and worker engines agree for identical inputs, with warm or empty band
caches. The 4× trace's entries 18–28 keep the eight-column world history and all
three bands: zero construction work, with drawing work 43 tiles / 40 routes /
13,134 path bytes. The 1× worker request instead has the committed one-column
fallback as history; its two missing bands require 52 tiles / 72 edges, above the
20/20 inline construction budget. A cold inline engine also returns eight columns
for that worker input. Dispatch itself did not regress. Replaying main with its own
outputs keeps eight columns; applying only slice 3's finite-logical-order fix in
`history-boundary.ts` reproduces entry 17's collapse. That fix correctly retains
pending-output history and must remain.

The engine now distinguishes unchanged geometry from reusable raw band geometry.
A metadata refresh rebinds current plans onto the complete committed folder frame,
refreshes cell footprints and recertifies it before reuse. Mixed changes compose
validated canonical raw bands and pin retained world drawings in the folder frame;
cell reorder and changed pane metrics still cause placement to change. Transported
packing metadata and canonical node coverage are checked before reuse. Worker band
remembering skips world drawings without valid canonical provenance and ignores
unhashable history/hints; it never relabels a world drawing as raw. Warm/cold complete
output parity and malformed-provenance regressions cover this boundary. No view,
motion, geometry gate, tolerance, dispatch limit or evaluation population changes.

The engine regression reduces the captured input to the seven-node forest band,
six cells and its committed geometry, removing unrelated graphs, metadata and
history ledgers. Both this fixture and the real inline scene-controller test fail
on unmodified `cb87cbf`. The publication test checks a nonzero cover position,
complete drawing identity across four separate saves, the visible saved state,
discard removal, pane fit and every presented scene. Additional cases cover mixed
close, resize, host reorder and malformed history. A seven-step real-worker replay
checks complete inline/worker equality with transported history and band caching.

Final correctness verification: `bun run check` reports **267 files, zero errors and
warnings**. `bun run test --maxWorkers=4` passes **172 files, 2,208 tests and one
existing skip** on the final source (1,339.94 s). The focused engine, runtime,
publication and complete worker-parity run passes **35/35** (17.46 s), including the
four malformed/missing canonical-provenance cases. Independent adversarial review
accepted final production SHA-256
`09dc865dd1511e9653549e7cc0ddd1c47398f721bd83eab0657c46cae528d01a`.
The control comparison has no metric/decision changes across **6,060 proposed
corpus layouts, 3,150 tour steps and 280 packing rows**.

The complete fix evaluation passes **50/50**, exit 0, without a perf-only retry.
Compared with the `cb87cbf` acceptance recorded above, **47 rows are unchanged**;
only the three timing measurements differ. All thresholds and populations are
unchanged. These are separate measurements, not performance improvement claims.

| Current target | `cb87cbf` | Save/frame fix | Limit |
|---|---:|---:|---:|
| Main-thread maximum p95, ms | 4.328417 | 3.751365 | 8 |
| ≤30 visible tiles maximum p95, ms | 47.617739 | 41.800999 | 100 |
| Full folder engine maximum inline p95, ms | 5.986872 | 6.446482 | 10 |

Geometry fallbacks remain **0/6,060 corpus, 0/3,150 tours and 0/140 proposed
packing states**, with zero outside the pane. The report, exact comparison,
fail-first logs and control replays are in ignored `layout-eval/out/s3fix/`.
No Playwright/browser run or push was performed.

## Slice 4 initial investigation (620313b; not adopted)

At this initial checkpoint, slice 4 was **not complete** and production routing
remained at `cb87cbf`; no T18–T28 or T37 implementation had been removed.
The following evidence records that investigation, not acceptance of a partial
replacement. The later representation step is documented below.

An isolated contact-search probe reused slice 3's corridor ledger and
separation domains instead of enumerating perpendicular offsets. It does not
yet import the complete committed routing model, implement all declared track
and suffix equalities, or replace insertion, hint reconnection and folder-world
routing. Its initial replay covered **19 of 20** changed old contact-repair
successes in the first 153 captured changed-success tour records, with tile/dot
retention checks.
That is a limited diagnostic, not the required complete old-success coverage.
The missed case is `random-dag-100-8101`, width 360/image 96, anchor `n33`,
32 visible tiles of 100. The old certified result uses several local bypasses
and an internal run shift; the probe reports a topology conflict. A subsequent
projection experiment was not accepted or integrated. Neither failure proves
that another embedding or a complete constrained model is infeasible.

Two committed-history import requirements were independently reproduced:

- Current gate-certified `merges-3` and `random-dag-40-7503` incremental drawings
  can fail `importRoutingPlan`'s independent-approach-port validation.
- Both the retained `future-port-scene.json` fixture and its current successful
  click result pass the geometry gate but fail imported junction parentage.
  Consumer pruning can leave a one-input residual meeting declaring two parents.

These cases need explicit semantic projection/convergence representation while
preserving declared painted pins; removing the import checks is not a solution.
An independent review also reproduced a saved-ledger equality conflict through
the evaluation adapter: `random-tree-12-7122`, width 454/image 96, focuses
`[null,n1,n3,n1,n4,n3,n4]`. At the final click, committed `n4.y=321`, while the
exact saved revisit requires `n4.y=312`. All drawings pass the unchanged gate.
This particular conflict was **not** reproduced in the production first-column
folder flow. It needs explicit conflict handling for imported legacy ledgers;
it is not evidence against a fresh policy that avoids inconsistent snapshots.

The original inventory workload was remeasured: 522 legal tour steps, 65 cold
bands, 65 raw layered diagnostics and 398 folder states. All T18–T28/T37 counters
match the slice 3 table above, and there are zero published gate failures.
The complete drawing digest is again
`47e279306a18a12ce71fae8d30359f2d6ef5121b4bef64969d4d8ad803e82210`,
matching slice 3's instrumented and uninstrumented controls. There is no new
implementation to measure as an “after” population: the adopted stage counts
remain unchanged.

The full census also completed: **6,060 proposed corpus states, 3,150 tour steps and 140 proposed packing states**. Every non-timing field in all 12,120 corpus comparison rows matches the uninstrumented control; complete tour and packing results match too. Cells below count **geometry changes or non-null constructor/probe/retry returns / calls**, including rejected/reconstructed candidates, warmups and readability reconstructions in the corpus command. They are not distinct published layouts. T25 counts returned retry drafts, not certified repairs. No stage was deleted; there is no replacement after-run.

| Stage | Original workload | Full corpus | Full tours | Packing |
|---|---:|---:|---:|---:|
| T18 Resize | 99 / 298 | 0 / 0 | 0 / 0 | 0 / 0 |
| T18 Tile-only seed | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| T19 Retain members | 189 / 189 | 114 / 114 | 1179 / 1182 | 2 / 2 |
| T19 Subset projection | 189 / 648 | 114 / 2267 | 1179 / 3577 | 2 / 56 |
| T19 Normalize frame | 18 / 83 | 0 / 0 | 0 / 0 | 27 / 54 |
| T19 Anchor translation | 0 / 9 | 20 / 20 | 102 / 121 | 20 / 20 |
| T20 Primary probes | 4581 / 5785 | 23934 / 26075 | 24233 / 34008 | 78 / 78 |
| T20 Wiring | 4782 / 38823 | 24222 / 106032 | 25336 / 322415 | 78 / 122 |
| T20 Insertion | 660 / 888 | 2080 / 2323 | 2906 / 5393 | 56 / 56 |
| T21 Plain placement | 591 / 848 | 1204 / 1544 | 2802 / 5635 | 0 / 0 |
| T21 Grid wiring | 967 / 2655 | 1905 / 4741 | 7234 / 26319 | 0 / 0 |
| T22 Second placement | 393 / 613 | 734 / 937 | 4556 / 6973 | 0 / 0 |
| T22 All-lane wiring | 376 / 1100 | 701 / 2247 | 4432 / 14896 | 0 / 0 |
| T23 Free terminal ports | 0 / 808 | 0 / 2275 | 0 / 4715 | 0 / 56 |
| T24 Free internal lanes | 80 / 169 | 48 / 229 | 678 / 1866 | 0 / 0 |
| T25 Constrained retry | 5 / 57 | 6 / 6 | 74 / 707 | 0 / 0 |
| T25 Repairable retry draft | 12 / 52 | 4 / 4 | 84 / 633 | 0 / 0 |
| T26 Leaf ordering | 33 / 660 | 60 / 2080 | 95 / 2906 | 0 / 56 |
| T27 Hint reroute | 7 / 9 | 0 / 0 | 0 / 0 | 0 / 0 |
| T27 Retained route | 5 / 5 | 0 / 0 | 0 / 0 | 0 / 0 |
| T28 Contact repair | 11 / 27 | 5 / 23 | 58 / 121 | 0 / 0 |
| T37 Folder pins | 133 / 135 | 0 / 0 | 0 / 0 | 0 / 0 |

The corpus/tours contain **48/678 internal-run repair changes**, **4/84 returned repairable retry drafts**, and **5/58 changed certified contact repairs**, respectively. The 19/20 diagnostic is only a subset of the required contact coverage; it does not cover those complete populations or the other repair classes. Hint and folder-arrival coverage remains represented by the separate original inventory workload.

The unmodified `cb87cbf` baseline completed **50/50** current targets and is
copied under `layout-eval/out/routing-s4-baseline`. No perf retry was needed.
The source check passes with 267 files, zero errors and zero warnings. The full
unchanged-source unit run finished with **2,184 passed, one failed, one existing
skip**: the malformed-history `M100 NaN L200 NaN` case hit its unchanged
five-second child-process timeout. Its focused file rerun passed **31/31** at
the same limit; this does not turn the full unit command green.

There was no adopted after-run or changed current acceptance row at that
checkpoint. New slice 4 fail-first publication contracts and replacement acceptance had
**not** been established. The independent blocking review rejects the incomplete
replacement; production remains unchanged. The handover, census, portable
reproductions and baseline receipts are under `layout-eval/out` and in the
slice 4 audit archive. No required slice 4 work is deferred under the name of
slice 5; cold embedding and folder packing consolidation remain slice 5's
unchanged scope.

## Slice 4: lossless import boundary

The incremental re-solve and stage deletion remain open. This step extends the
import representation so that published incremental geometry can become a
committed routing problem without rewriting its native paint.

A junction now has two explicit semantic layers. Its painted dot retains its
original parent declaration, coordinate and identity. Its current meeting
projects the exact consumers carried by the incoming paths, including nested
joins and a unary residual after pruning. Validation checks that every projected
consumer reaches its terminal through the incoming source; a historical parent
name cannot invent a current connection.

Convergence inputs reference the last entry of each native path into the existing
6 px square dot berth. A binding includes the native primitive, split parameter,
directed face and complete native suffix. Cubics use polynomial interval roots
and De Casteljau metadata; original path bytes and controls are never re-emitted.
Opposite faces are distinct directed inputs. Inputs sharing a face still require
the existing strict 3 px separation, including its unchanged exact-centipixel
comparison. The original painted ports, dot and route bindings remain exact.

A local numerical chart handles independent lanes whose attachment arithmetic
crosses a binary64 precision boundary. It explicitly encodes only the already
validated convergence cut, suffix controls and dot through at most two common
bounded numerical operations. Every encoded point must round-trip at each
operation to the exact preceding coordinate;
primitive, parameter and face still reference the raw full-path cut. The same
strict independence predicate runs in that chart. Deterministic candidate
operations include a small exact recentering and origins placing the dot near
binary binade boundaries (including adjacent representable origins) within the
existing coordinate reach. Two real sequential attachments can preserve fine
low-coordinate residues while accumulating rounding at a larger binade; a single
reversible origin is insufficient for that certified case. This is numerical
representation metadata, not claimed historical attachment provenance or a
solver displacement. The independent geometry gates still admit the native
paint. A 2.99 px gap and coincident inputs remain rejected.

There is no new persisted `GraphLayout` field, history policy or cache state.
Malformed ranges, sparse certificate arrays and nonfinite native geometry are
rejected, and projection/chart work is charged to the caller's existing ledger.
The previous complete-output differential hash remains unchanged.

The import census uses the unchanged 6,060 corpus states, 3,150 legal tour steps
and 140 packing states (309 separate packed drawings). Before this change,
**843 of 9,519 drawings** failed import. After, **0 of 9,519** fail:

| Published population | Before failures | After failures |
|---|---:|---:|
| Corpus | 177 / 6,060 | 0 / 6,060 |
| Legal tours | 666 / 3,150 | 0 / 3,150 |
| Packing (140 states) | 0 / 309 | 0 / 309 |

The census
also asserts exact retained route bytes/identities/consumer ranges and painted
dots/declarations, and hashes the drawings independently of import metadata.
Both complete runs have native drawing SHA256
`2a7c4ccaaea4c3489ad6889fdf99ef265ffd73803c7d24f914289657cc7f23c1`.
The independent population audit verifies the exact ordered producer states,
actual published world drawings and full request membership without exclusions.

The 24 new behavior contracts cover the pruned future-port fixture, its published
clicked result, directed arrivals, malformed projections/certificates and exact
reattachments. Six reduced certified sequential-attachment cases fail the frozen
single-chart attempt and pass the two-operation representation. Independent
adversarial review accepts the current design: 89 focused tests and 1,179/1,179
gate-certified sequential-attachment drawings import successfully; coincident,
2.99 px and counterfeit inputs still reject. No persisted frame/history policy
was adopted. The unchanged full unit suite passes with 2,209 tests and one
existing skip; source check reports 270 files, zero errors and zero warnings.
The final unchanged evaluation targets pass **50/50**. All 12,120 corpus rows
match baseline after omitting only top-level elapsed `ms`; entire tour and packing
artifacts match. Metrics, decisions and work are unchanged. The only changed
current acceptance rows are measured timings, all passing their original limits:

| Current timing target (p95, ms) | Before | After | Limit |
|---|---:|---:|---:|
| Main-thread maximum | 4.302 | 5.662 | 8 |
| At most 30 visible tiles maximum | 46.277 | 50.126 | 100 |
| Full folder engine maximum inline | 7.093 | 4.276 | 10 |

Perf-stage load samples range from 5.62 to 26.71. No profiling, optimization,
threshold change or timing retry was needed. Receipts are in
`layout-eval/out/import-census-chain.json`, `s4b-acceptance-diff.json`,
`s4b-gate-exits.json` and `routing-s4-handover.md`.

This step does not replace T24/T25/T28, port/bypass repairs, hint reconnection or
folder pinning. New re-solve coverage remains unestablished over the full old
success populations: corpus/tours T24=48/678, T25=4/84, T28=5/58, plus the separate
internal-port, hint and folder-arrival classes. Import coverage is a prerequisite,
not solver replacement coverage. The next step is the complete committed hard
pin/equality model and affected conflict-component solve, before any deletion.

## Slice 4: rebased retained-constant and component prerequisite

This continuation starts at `0905388`, rebased onto the fixed slice 3 `f376163`.
Slice 4 remains open. The new APIs are **not called by production routing**;
complete committed-to-free-topology construction and publication are not adopted.

`routing-problem.ts` captures caller-declared scenes without mutable aliases,
imports their native topology and makes retained rectangle, port, native-control,
suffix, corridor, allocation and convergence-chart numbers exact scalar constants.
Declared frame recipes retain each arithmetic operation and intermediate result;
this does not derive the production piecewise attachment/hint/world recipes.
Native route bytes and painted declarations remain separate immutable bindings.
A retained-geometry check rejects changed coordinates, missing identities, lost
consumers and reserialized native paths. Projection policy must run before capture.

`routing-components.ts` substitutes fixed constants before closing free dependency
components. A common fixed port cannot join unrelated free subproblems; its
incident obstacle constraints still bound each solve. Only affected or conflicting
free components are solved, and every hard residual is checked. Two different
pins on one variable return an explicit equality witness. Pins preserve their
binary64 values, including signed zero. Snapshot, shape, shared-table, dependency,
whole-array component scans and local solve work charge the caller's ledger;
ledger exceptions retain their original control flow.

The previously missed `random-dag-100-8101` 360/96 click `n33` now has an independently
generated, gate-certified **selected-topology diagnostic**. It retains all 75
surviving committed route strings, 28 tile rectangles, 18 dots and all 9,539
imported attached-scene scalar pins. Hidden `n85`/`n93` and their two routes are
outside current request membership; consumer projection precedes import.
No retained hint resize or coordinate descent is required in this case.

Only two new routes change. `n25→n98` takes the existing bottom departure/shared
source prefix and a fresh visibility-grid corridor. Its old right port `(328,3274)`
is only 2 px from retained `n18`'s vertical `x330` track, inside the unchanged 6 px
port berth; editing later runs cannot fix that start. `n8→n17`'s new internal run
is free. With the chosen topology, the metric kernel solves one three-track
component: `174→174`, `175→175`, `169→178`; retained rectangles bound the corridor.
The pre-solve topology fails `shared-lane`, the solved drawing passes the full
unchanged gate, and restoring the old new-departure choice fails `route-contact`.
The generator never reads the old repaired output: poisoning that output produces
an identical regenerated drawing. This is one diagnostic, not adopted replacement
coverage or a claim that every frame equality has been constructed.

The actual `random-tree-12-7122` replay `[null,n1,n3,n1,n4,n3,n4]` still exposes the
legacy committed `n4.y=321` versus saved revisit `312`. The metric API now returns
both named equality constraints without mutating either drawing. Production
snapshot policy and explicit fallback integration remain open.

Independent adversarial review accepts only these prerequisite APIs and selected
contracts: **85/85** focused tests, a 10,000-case ordered-DAG feasibility
differential with zero mismatches, exact attached-scene n33 pins, independent
missing-move failure checks and a poisoned-output differential. Review receipts
and source/test hashes are in `layout-eval/out/s4c-review.md` and
`s4c-review-acceptance.json`. The four new test files contain 33 contracts.

Every archived distinct old-success output was audited, beyond the initial153
sample: all **527** present-member gate-certified drawings import into the new
constant representation. This includes corpus/tour T24 drafts **21/379**, T28
**5/58**, and the separate original workload **46 T24, 11 T28, 4 hint and 3 retained
route** outputs. Intermediate T24 drafts are certified only for present members;
this is not complete-request publication or replacement coverage. T25 draft
bodies were absent from the old archive. An isolated instrumented `0905388`
snapshot now recaptures every positive raw T25 return with call maps: corpus
**6 constrained / 4 repairable**, tours **74 constrained / 84 repairable**.
All **168** drafts contain their complete requested membership and import into
the constant model; **81** already pass the raw drawing gate. These are draft
receipts, not adopted solver or publication successes.

The repeated original workload has 522 legal tour steps, 65 cold bands, 65 raw
layered diagnostics and 398 folder states, with no published gate failures.
Every T18–T28/T37 counter matches the earlier inventory on this fixed base. Its
complete-output SHA256 is now
`67926c171020087ee52af1acb4e43cbc863fde41099f4571dc9d714f69e33833`,
identical in instrumented and uninstrumented controls; the previous digest is
not reused. All 12,120 full corpus rows match the uninstrumented control after
omitting only top-level elapsed `ms`; entire tour and packing artifacts match.
The repeated table and call maps are in `s4c-inventory.json`/`.md` and
`s4c-recapture-summary.json`. No production stage has an adopted replacement
after-run at this checkpoint.

Adopted replacement coverage remains **0/48 and 0/678 T24**, **0/4 and 0/84 T25**,
**0/5 and 0/58 T28** for corpus/tours, plus the still-unadopted internal-port,
hint and folder classes. No stage is deleted. Complete frame/geometry adapters,
all-success coverage, consistent production ledger policy and fail-first tests
through adapter/inline/worker/publication remain required in slice 4.

The additional original-workload capture contains **352** complete success
bodies and **485** native drawing imports, including all **133** full folder
gates and their **266** attached graphs. Independent evidence review checks every
body, call mapping and attached request membership; it does not certify an
automatic production frame adapter or replacement solver.

The fresh native import census on this rebased base has **zero failures across
9,519 drawings**: 6,060 corpus, 3,150 tour and 309 packing drawings from 140 states.
Its exact native digest is
`2a7c4ccaaea4c3489ad6889fdf99ef265ffd73803c7d24f914289657cc7f23c1`.
Final gates pass: check has zero errors/warnings across 272 files; unit tests have
2,265 passes and one existing skip across 177 files; layout evaluation is **50/50**
at unchanged thresholds. Only three acceptance rows change, all timing values:
main-thread maximum p95 **5.662279→6.460068 ms** (limit 8), ≤30 visible tiles
maximum p95 **50.125955→40.375985 ms** (limit 100), and full-folder inline maximum
p95 **4.276499→6.232340 ms** (limit 10). No performance work was undertaken.
Receipts are `s4c-gates.json`, `s4c-acceptance-diff.json` and the corresponding
logs under `layout-eval/out`; a verified bundle and guarded importer deliver this
partial prerequisite checkpoint without writing this clone's read-only `.git`.

### Slice 4d — metered constructor prerequisite checkpoint

This checkpoint adds the pure `captureIncrementalRouting`,
`routeCommittedIncremental` and `solveIncrementalTopology` APIs, ordered native
frame restoration, explicit revisit equality conflicts, and prepaid native and
independent admission. Production callers, the default folder engine and the
legacy repair itinerary remain at `d9aa452`. These prerequisites are independently
accepted; the broader production adapter in the working tree is not included.
The exact 22-file source manifest is `s4d-final-constructor/checkpoint-source.json`.

The automatic n33 constructor now produces all 32 requested members while keeping
28 retained rectangles, 75 native path strings and 9,539 scalar pins exact through
actual single-band attachment. It uses 56,186,394 of the finite 64,000,000 work
allowance. The native contact and T25 contracts also pass without changing either
geometry gate. Capture precedes construction; a failed candidate cannot redefine
the retained constants. Explicit outcomes distinguish topology, metric,
unsupported-input and budget conflicts. A bounded miss is not a proof of geometric
infeasibility.

Every captured old success was replayed from its committed input through this
pure automatic API, without supplying the old repaired output:

| Population | T24 | T25 constrained | T25 repairable | T28 | All captured classes |
|---|---:|---:|---:|---:|---:|
| Corpus | 40/48 | 6/6 | 4/4 | 5/5 | 55/63 |
| Tours | 93/678 | 6/74 | 3/84 | 32/58 | 134/894 |
| Original workload | 24/80 | 0/5 | 1/12 | 5/11 | 30/352 |

The original workload also includes 133 folder, 99 resize, seven hint and five
retained-route successes. None is covered by this strict whole-route API yet.
Failed API replays total eight budget outcomes for the corpus; 758 budget and two
topology outcomes for tours; and 78 budget, four topology and 240 unsupported
outcomes for the original workload. They are diagnostic outcomes, not production
fallback counts or proven genuine conflicts. Production replacement coverage
remains zero, its fallback counters remain unchanged, and no stage is deleted.

The full original workload again matches all stage counters and the complete
digest `67926c171020087ee52af1acb4e43cbc863fde41099f4571dc9d714f69e33833`,
with 522 tour steps, 65 cold bands, 65 layered diagnostics and 398 folder states,
and no published gate failures. The 12,120 corpus rows (omitting only top-level
elapsed `ms`), 3,150 tour rows and 280 packing rows retain every geometry and
decision field of the fixed-base control.

The eval passes 50/50 at unchanged thresholds. Exactly three acceptance rows
change from the newly measured fixed-base control:

| Acceptance row | Before, ms | After, ms | Existing limit, ms |
|---|---:|---:|---:|
| Main-thread maximum p95 | 13.089809 | 4.202846 | 8 |
| At most 30 visible tiles maximum p95 | 66.774539 | 34.706012 | 100 |
| Full folder engine maximum inline p95 | 10.489301 | 7.638370 | 10 |

The first and third rows change from failing to passing; the second stays passing.
No performance tuning was done. The lead separately authorizes finite larger
search allowances and permits the unchanged 8/10 ms rows to exceed their limits
provided both actual p95 values stay below approximately 16 ms. Budget exhaustion
alone does not justify keeping a legacy stage; missing construction moves and
frame adapters must still be addressed across all three populations under the
same policy. That larger-policy proposal is separate from this 64-million-work
checkpoint.

Unit tests pass: 2,297 passes and one existing skip across 182 files. Check has
zero errors or warnings across 277 files. Review and gate receipts, exact acceptance changes, a verified bundle and
the guarded importer live under `layout-eval/out`. Still required for slice 4:
complete construction and hint/world frame coverage, production publication and
ledger contracts, independent production adoption review, measured finite-policy
coverage and latency, and deletion only after each stage is fully covered.


### Slice 4d — source-bound fragment and hint API checkpoint

This second prerequisite checkpoint includes the first constructor checkpoint and
adds selective native-fragment retention, a source-bound frame factory, bounded
hint growth/shrink recipes, and a withholding-only final-publication callback.
Native source identity serialization and the unchanged independent geometry
gate's expanded JSON key are prepaid before execution. The optional callback
shares the constructor's finite ledger and cannot replace its captured source.
Production callers, folder routing and legacy repair stages remain at the base;
this checkpoint does not adopt the broader production work in the working tree.
Its exact selected-source manifest has 33 files.

All 63 corpus, 894 tour and 352 original old-success captures were replayed from
their committed inputs with old repaired outputs blocked from access. The strict
64-million-work constructor still covers 55/63, 134/894 and 30/352 respectively,
with the same reason counts as the first prerequisite checkpoint. The additional
source-bound hint API covers all 111 retained resize/hint/route stages: 99 retained
membership-only resize occurrences and 12 complete-request invocations. The
complete invocations include six insertion occurrences in two distinct requests;
12 invocations are not 12 distinct user requests. The maximum hint work is
7,896,990 of the same finite 64-million allowance. The input population and
denominators are unchanged. These API proofs do not count as production adoption
or genuine-conflict proofs for the remaining bounded misses.

The original workload again matches 522 tour steps, 65 cold layouts, 65 layered
layouts and 398 folder states, every stage counter and the complete digest
`67926c171020087ee52af1acb4e43cbc863fde41099f4571dc9d714f69e33833`.
No published gate fails. Production replacement coverage remains zero and no
legacy stage is deleted in this checkpoint.

Independent reviews accept the pure V4 API and the exact two-file V5 native
accounting delta. They explicitly exclude production adapters, folder-wide
accounting, broader search coverage and production adoption. Later terminal-ink,
world-adapter and ledger proposals are separately reviewed work and are excluded
from this immutable checkpoint.

The immutable checkpoint passes `bun run check` with 284 files, zero errors and
zero warnings; the complete unit gate passes 2,329 tests across 185 files, with
one existing skip; and the eval passes all 50 unchanged acceptance targets.
Every geometry and decision field in the 12,120 corpus, 3,150 tour and 280 packing
rows matches the fixed-base control (only top-level corpus elapsed `ms` is
excluded). Exactly three acceptance rows change:

| Acceptance row | Before, ms | After, ms | Existing limit, ms | Before / after |
|---|---:|---:|---:|---|
| Main-thread maximum p95 | 13.089809 | 2.648017 | 8 | fail / pass |
| At most 30 visible tiles maximum p95 | 66.774539 | 36.571020 | 100 | pass / pass |
| Full folder engine maximum inline p95 | 10.489301 | 6.417995 | 10 | fail / pass |

Both required inline p95 measurements remain below 16 ms; this checkpoint needs
no timing exception. These measurements cover this prerequisite checkpoint,
whose production callers remain at the base, rather than the broader ROOT
production proposal. No performance tuning was done.

The verified `routing-s4-fragments.bundle` and guarded
`s4d-import-fragment-checkpoint.py` live under `layout-eval/out`, with source,
review, gate and importer-rehearsal receipts. This bundle includes and supersedes
the first constructor checkpoint, with the same parent `d9aa452`; import it into
that base on `routing-s4`. It is not a fast-forward from the separate first
checkpoint commit. Clean-base import is supported; `--preserve-wip` accepts only
the exact WIP bytes recorded when this bundle was built. The importer never
adopts the broader production WIP as part of the checkpoint.


### Slice 4d — bounded constructor and world API checkpoint

This third prerequisite checkpoint extends the reviewed APIs with finite fair
constructor families, selective native-fragment masks, deferred free route cores,
source departure prefixes and carrier cuts, and terminal-boundary bindings. It
also includes six unwired folder-world modules. Production entry points retain
the second checkpoint's legacy behavior. The immutable runtime has 721 source
files and a 49-file selected-source manifest; the broader production adapter in
the working tree is excluded. Production adoption and stage deletions are zero.

All captured old successes were replayed from their actual committed inputs.
Old repaired outputs and legacy folder candidates were inaccessible. Every
success passes final attachment/folder geometry, complete per-ID membership,
retained native/source constants and input/source immutability checks. The same
finite policy applies to all three populations: 1,024,000,000 total work, with
6,400,000 fallback work, 6,400,000 second-pass work and 64,000 probes inside that
allowance. Search exhaustion is a bounded decline, not a genuine-conflict proof.

The comparison below uses the earlier strict 64-million whole-route replay as
its baseline. The second checkpoint's separate hint API already covered all
111 retained hint/resize stages; that separate proof remains valid and is not
added to the baseline constructor totals.

| Population / input scope | Earlier strict API | Current unified API | Remaining budget outcomes |
|---|---:|---:|---:|
| Corpus, complete-request inputs | 55/63 | 62/63 | 1 |
| Tours, complete-request inputs | 134/894 | 535/894 | 359 |
| Original, complete-request occurrences | 30/253 | 204/253 | 49 |
| Original, present-membership resize stages | 0/99 | 99/99 | 0 |

The 99 retained-member resize stages are not complete user requests. All 409
remaining outcomes are budget exhaustion; topology conflict, metric conflict,
unsupported input and unexpected failures are zero. A serious separate
8,192-million-work attempt on the sole corpus miss also exhausted its bound;
it does not prove that case infeasible or justify retaining a legacy stage.

| Old-success stage | Corpus before / after | Tours before / after | Original before / after |
|---|---|---|---|
| T24 free port lanes | 40/48 → 47/48 | 93/678 → 360/678 | 24/80 → 34/80 |
| T25 repairable contacts | 4/4 → 4/4 | 3/84 → 64/84 | 1/12 → 11/12 |
| T28 route contacts | 5/5 → 5/5 | 32/58 → 47/58 | 5/11 → 11/11 |
| Additional constrained route | 6/6 → 6/6 | 6/74 → 64/74 | 0/5 → 3/5 |
| Folder world placement | — | — | 0/133 → 133/133 |
| Complete resized-history route | — | — | 0/7 → 7/7 |
| Retained route | — | — | 0/5 → 5/5 |

The automatic n33 fresh-departure/corridor contract remains covered from committed
input alone. Captured successes use an immutable common runtime. The full tour
ran the original V1 driver; corpus and original ran V3, whose additional branch
recovers an explicit raw resize source for two absent-history roles. That branch
is unexecuted on every tour input, and every V3 corpus result is byte-identical
to V1. Actual per-population manifests, driver identities, numeric exit provenance
and the full 63/894/352 input captures are bound in the evidence bundle.

The unchanged production workload again completes 522 tour steps, 65 cold bands,
65 layered diagnostics and 398 folder states, with no geometry failures and the
exact baseline digest
`67926c171020087ee52af1acb4e43cbc863fde41099f4571dc9d714f69e33833`.
Its counters are legacy-only: 79,321,366 corridor work, 981 corridor candidates,
2,036 candidates, 808 pinned searches and 26 pinned-cache hits. New production
attempts, successes and fallbacks by every reason are zero. API replay coverage
must not be reported as production replacement coverage.

The immutable checkpoint passes `bun run check`: 293 files, zero errors and
warnings. The full unit gate passes 2,371 tests across 189 files, with one
existing host-theme skip; no test timeout changes are included. The complete
eval passes all 50 original targets without an exception. Every geometry and
decision field in the 12,120 corpus, 3,150 tour and 280 packing rows matches the
fixed-base control (only top-level corpus elapsed `ms` is excluded).
Exactly three acceptance rows change:

| Acceptance row | Before, ms | After, ms | Existing limit, ms | Before / after |
|---|---:|---:|---:|---|
| Main-thread maximum p95 | 13.089809 | 2.528210 | 8 | fail / pass |
| At most 30 visible tiles maximum p95 | 66.774539 | 36.105350 | 100 | pass / pass |
| Full folder engine maximum inline p95 | 10.489301 | 4.625977 | 10 | fail / pass |

Both required p95 measurements are below 16 ms and their unchanged original
limits. Source inventories and hashes were verified before and after every
gate. Independent review accepts this exact API source; publication adoption
of the broader production work remains unaccepted.

The larger raw replay allowance establishes bounded API feasibility only. Eval
timings measure this checkpoint's unchanged legacy production callers; they do
not establish inline latency suitability for an unwired automatic adapter. No
performance optimization or geometry/eval-population change is included.

Slice 4 remains open. Broader production work has real arrival/publication,
saved-ledger and joint attachment-frame failures. A separate narrow hint
investigation produces five certified direct worlds, but the next shrink/reuse
click moves the clicked tile from Y216 to Y228 while both geometry gates, exact
saved revisits and real-worker/main parity still pass. The required move must
preserve actual committed cover/body/native frames jointly during attachment;
relabeling a world result as canonical raw geometry is insufficient. The frozen
fail-first/design packet and all broader ROOT WIP are separate unaccepted
recovery material. No production adapter or legacy deletion is approved by this
API checkpoint.

The verified `routing-s4-api.bundle` and guarded `s4d-import-api-checkpoint.py`
are delivered under `layout-eval/out` with source, review, gate and actual-import
receipts. This checkpoint includes and supersedes both earlier API bundles,
with parent `d9aa452`; import into that base on `routing-s4`. It is not a
fast-forward from either separate earlier checkpoint commit. Clean-base import
is supported. `--preserve-wip` requires the exact bytes and executable modes
recorded when this bundle was built, and preserves all those worktree files.

### Slice 4d — production adoption with legacy fallback

Production runs the constrained incremental construction first at one site, band
insertion. Legacy runs only when that attempt declines, inside the same engine
request, so no intermediate frame exists. Each attempt is bounded by click
latency, measured end to end, rather than by coverage.

- **Band insertion** (`band-layout.ts`, `constrainedInsertion`). This calls
  `constrainedBandInsertion` under `bandInsertionAllowance`.
  - It runs the strict capture first, with retained connectors byte-identical.
  - Only if that search exhausts its budget does the remainder of the same
    allowance run the frameless fragment capture.
  - The result must keep every retained rectangle exactly. It then competes as the
    `incremental-tree` candidate under the unchanged ranking, anchors and gates.
    A success replaces the legacy `incrementalTree` call; a decline runs it.
- **Interactive allowance** (`incremental-adoption.ts`). The allowance is 375K work
  per band item, up to 6M (250K and 4M at 6f00895; see "Slice 4 completion pass"
  below). A work unit is not a fixed time: measured attempts run at about 20 ns
  per unit at p50 and up to about 100 ns. The latency bound is therefore
  measured, not guaranteed by construction. The constructor's pools scale with
  it: 6/32 of the legacy pools at 6M.
  - Small doomed requests stop early instead of spending the full ceiling.
  - A band of more than 47 items declines as `budget` before spending any work.
    Larger bands can certify (a 61-item fan does at 6M), but admitting them
    added up to 190 ms per declined click on the eval tours.
- **Folder world placement is not adopted.**
  - At 256M it published 132 arrivals, but every one was a request legacy also
    served.
  - On the requests legacy declines it never succeeded.
  - A success cost 15–100 ms against a few ms for legacy `pinnedFolderPlacement`,
    and a budget decline cost over 1 s.
  - Within an inline-sized allowance it bought nothing measurable, so
    `default-engine.ts` keeps 5bbcb77's folder path plus `worldBandFrame` only.
- **World-placed graphs** declare their band frame (`worldBandFrame` in
  `priorOf`), so the next click's attachment frame matches. In the hint case the
  clicked `s0:p` stays at y216; before this it moved to y228. This is independent
  of adoption.
- **Dispatch is 5bbcb77's.** `canLayoutFolderInline` and `canRetainFolderInline`
  are unchanged.
  - Every request that was inline at 5bbcb77 is still inline, including exact
    revisits.
  - No request moved to the worker.
  - No test timeout was raised.
- **Counters.** Every attempt is counted as `adoption:band-insertion:attempt`,
  then `success` or `fallback:<topology|metric|unsupported|budget|contract>`, plus
  `work` and `cache-hit`.
  - `published` counts only drawings that ranking actually returned.
  - Identical attempts are memoised and return clones, so the worker and the main
    thread agree.

#### Click latency

The table below measures wall-clock time from request to published layout for
every request:
- the 522 eval tour steps, each an `optimizedBand` click on the main thread;
- the 398 folder states, run through `createFolderLayoutRuntime`, either inline or
  as a round trip to a real `layout.worker.ts`.

Each request is classified by its own counters. Requests are matched one-to-one
with the same run at 5bbcb77 on the same machine. "Added" is the per-request
difference. Times are in ms.

| Population / outcome | n | 5bbcb77 p50 / p95 / max | Now p50 / p95 / max | Added p95 / max | Moved to worker |
|---|---:|---|---|---|---:|
| Folder, all | 398 | 1.3 / 7.7 / 60.8 | 1.3 / 11.2 / 57.9 | 3.5 / 9.7 | 0 |
| Folder, adopted | 37 | 3.2 / 7.8 / 8.9 | 5.5 / 9.4 / 16.0 | 4.6 / 8.1 | 0 |
| Folder, declined | 25 | 5.3 / 10.7 / 15.4 | 10.1 / 19.0 / 19.8 | 9.2 / 9.7 | 0 |
| Folder, legacy only | 336 | 1.1 / 5.6 / 60.8 | 1.2 / 5.5 / 57.9 | 0.6 / 5.1 | 0 |
| Tour, all | 522 | 4.7 / 282.3 / 9817.7 | 10.8 / 295.3 / 10094.4 | 26.5 / 276.7 | 0 |
| Tour, adopted | 145 | 3.9 / 18.1 / 45.0 | 10.6 / 39.0 / 95.4 | 22.7 / 58.1 | 0 |
| Tour, declined | 106 | 89.1 / 4283.9 / 9817.7 | 102.5 / 4295.8 / 10094.4 | 61.1 / 276.7 | 0 |
| Tour, outranked | 146 | 4.5 / 13.6 / 32.6 | 10.8 / 30.4 / 41.7 | 16.1 / 20.8 | 0 |
| Tour, legacy only | 125 | 0.8 / 39.8 / 386.2 | 0.8 / 42.2 / 384.9 | 2.1 / 10.7 | 0 |

**What the table shows:**
- Folder states, all: p95 is 1.45× the baseline, and folder arrivals alone are
  1.51× (11.0 against 7.3 ms).
- Tour steps, all: p95 is 1.05×.
- The constrained attempt itself, timed separately:
  - tours: p95 24.5 ms when adopted and 46.2 ms when declined, with a max of 104 ms;
  - folder states: under 11 ms.

**Requests that run an attempt cost more than their own legacy baseline.** The
aggregate p95 stays near the baseline because most clicks are cheap or
legacy-only. But the subgroups that attempt are each 1.5–2.5× their legacy p95:
- tours: adopted 2.2×, outranked 2.2×;
- folder states: declined 1.8×.

A success replaces legacy's cheap `incrementalTree`, but capture costs a few ms
even on small bands, so an adopted click is still slower than legacy alone. In
absolute terms the added time is 10–25 ms at the subgroup p95.

An independent review measured workloads outside these populations:
- dense synthetic folder arrivals of up to 12 tiles: inline p95 1.34–1.50× overall,
  and up to about 17 ms added on the main thread for a 2.5M decline;
- one-tile band arrivals up to 47 items: declines on 40-item bands add 100–190 ms;
- the slowest attempt seen: 139 ms, a 4M decline.

The inline dispatch limits in `layout-workload.ts` were calibrated before any
attempt existed and are unchanged.

**The tour "added max" of 277 ms is noise, not attempt cost.** It occurs on a
10 s legacy request, where run-to-run variation is that large. Legacy-only rows
show the same noise.

**For comparison, the unbounded design at ab0411c** used 128M for bands and 256M
for folders, with searches on the worker:
- folder p95 was 55.8 ms, with a max of 1,167 ms;
- 193 folder requests had moved to the worker;
- tour p95 was 671 ms;
- tour budget fallbacks took seconds.

**The cost of the bound is coverage.** Requests the bounded attempt cannot
certify stay with legacy and are counted as budget fallbacks.

#### Production inventory

The production inventory is unchanged: 1,050 requests (522 tour steps, 65 cold,
65 layered, 398 folder states), with no geometry failures.

| Site | Attempts | Successes | Published | Fallbacks by reason | Work |
|---|---:|---:|---:|---|---:|
| Band insertion | 459 (19 memo hits) | 328 | 182 | budget 131 (49 by size, before any work) | 393,924,505 |

There were no topology, metric, unsupported or contract fallbacks.

Retained-tile movements between consecutive inventory outputs went from 44 at
5bbcb77 to 39:
- tour indices 444 and 446 (random-bushy-40-7603, clicks 1 and 3) now keep every
  retained tile, where legacy moved 2 and 3;
- no output moved more tiles than at 5bbcb77.

#### Coverage outside production

Old-success replay at the API allowance (1,024M, 4x pools) is unaffected by the
production bound. It calls `constrainedBandInsertion` for plain band inputs:

| Population | Previous checkpoint | Now | Gains / losses |
|---|---:|---:|---|
| Corpus, complete requests | 62/63 | 62/63 | 0 / 0 |
| Tours, complete requests | 535/894 | 601/894 | 66 / 0 |
| Original, complete requests | 204/253 | 213/253 | 9 / 0 |
| Original, resize stages | 99/99 | 99/99 | — |

| Old-success stage | Corpus | Tours | Original |
|---|---|---|---|
| T24 free port lanes | 47/48 | 360 → 411/678 | 34 → 41/80 |
| T25 repairable contacts | 4/4 | 64 → 68/84 | 11 → 12/12 |
| T28 route contacts | 5/5 | 47 → 53/58 | 11/11 |
| Additional constrained route | 6/6 | 64 → 69/74 | 3 → 4/5 |

**The missing move behind the tour gains was the capture order.** On those
inputs the fragment capture spends its whole allowance in metric conflicts,
while the strict capture certifies within about 25M.

**All 293 remaining tour misses are budget exhaustion.** Tour input 41, for
example, needs the repairable-contact policy: every strict family's insertion
search fails, and a contact-deferring order did not certify either.

**Production's interactive allowance covers less than this replay.** In
production, the replay's extra coverage stays with legacy as budget fallbacks.

**No legacy stage is deleted.** None of T24, T25 or T28 is replayed for all its
old successes in every population, and production does not reach them within
the latency bound either.

#### Tests

Tests marked "failed first" were run against a2a3174 or 5bbcb77, or against the
change with the guarded line disabled.

- `routing-hint-next-click`: failed first, with y228 before.
- `incremental-adoption.test.ts`:
  - retained band tiles through clicks;
  - shrink-space reuse and a single 16 px descent, each published by the
    constrained path and then clicked, with the ancestry kept;
  - hint growth and shrink under the same contracts. These publish legacy worlds,
    since folder world placement is not adopted;
  - exact revisits;
  - arrivals keyed by tile identity, with constrained publication;
  - merges keyed by tile identity. This case declines as budget, and no generated
    merge variant reached constrained publication, so it guards legacy only;
  - small arrivals, clicks and exact revisits staying inline. This is a
    regression guard for 5bbcb77's dispatch and passes there;
  - the allowance as a pure function: boundary sizes; the malformed sizes 0,
    negative, NaN and infinite; and every allowance's pools fitting one embedding
    family;
  - an oversized insertion declining as budget with zero work. Failed first:
    without the size decline it spent 3,999,998 work and still declined.
- `routing-ledger-conflict`: the committed n4 now matches its saved revisit,
  where legacy committed y321 against 312. Its conflict half now uses a synthetic
  contradicting pin, so it only exercises the solver.
- An `adoption` worker/main parity mode.

#### Gates and changed acceptance rows

All three gates pass:
- `bun run check`: 294 files, 0 errors.
- `bun run test`: 191 files, 2,386 tests passed and 1 skipped.
- `layout:eval`: all 50 task targets pass.

The table lists the acceptance rows that changed against 5bbcb77. Every other row
is unchanged, including both click-anchor rows (26 and 73).

| Row | 5bbcb77 | Now | Limit |
|---|---:|---:|---:|
| Corpus per-layout movedFraction | 0.1224 | 0.1214 | 0.1283 |
| Corpus transition movedFraction | 0.1954 | 0.1938 | 0.2574 |
| Broad transition movedFraction | 0.0503 | 0.0491 | 0.0788 |
| Mean legal displacement, px | 12.27 | 12.26 | 17.53 |
| Main-thread max p95, ms | 2.528 | 2.665 | 8 |
| ≤30 visible tiles max p95, ms | 36.105 | 37.959 | 100 |
| Full folder inline max p95, ms | 4.626 | 4.333 | 10 |
| Mean height / width | 2119.7 / 556.6 | 2118.9 / 556.8 | 2372.7 / 603.0 |
| Mean length / bends / crossings | 37614 / 154.11 / 333.10 | 37608 / 154.11 / 333.10 | 46535 / 157.20 / 364.36 |
| Mean displacement / maxDisplacement | 28.93 / 65.96 | 28.67 / 65.75 | 34.76 / 80.19 |
| Mean siblingInversions / mixedDirections | 0.102 / 1.533 | 0.093 / 1.530 | 0.107 / 2.289 |
| Mean unaligned | 0.1640 | 0.1653 | 0.1766 |

Area, whitespace and paneWhitespace changed by less than 0.1%.

#### What remained at 6f00895

See "Slice 4 completion pass" below for the current state.

### Slice 4 completion pass

This pass made capture cheaper and converted the saving into production coverage.
It found no move that covers the API-allowance misses, and it deleted no legacy
stage.

#### Where attempt time goes

Measured over the 391 distinct production attempts (wall clock, after this pass):

| Phase | Share |
|---|---:|
| Strict capture: import of the retained drawing | 18% |
| Construction (legacy constructor under the strict families) | 37% |
| Retained-constant check: import of the solved drawing | 10% |
| Metric solve | 6% |
| Native clearance, admission prepay and the independent gate | 17% |
| Fragment capture | 2% |

Before this pass, 17% of attempt time was a metric solve that
`importCommittedRouting` ran over its own bound constants. That metric holds only
unique, finite, unbounded pins, with no separations or equalities, so the solve
could only reproduce the pins. It is removed, and binding remains the import's
consistency check.

- Production attempts: total time 4.07 s → 3.37 s; p95 28.4 → 23.5 ms;
  decline p95 80 → 37 ms; max 90 → 59 ms.
- Successes 312 → 313 at the old allowance. Every prior success is
  byte-identical, and there are no losses.
- A 47-item fan arrival now certifies within 4M, where it exhausted the budget
  before.

Foreign route parsing is also cached per incremental solve (eb62c59). That made
production attempts 19% faster with identical outputs, and added 18 tour
replays at the API allowance.

#### Allowance

The saving buys a 6M allowance (375K per item), where it was 4M. The 47-item size
limit is kept and is now explicit. The table compares candidate allowances on
the same 391 attempts:

| Allowance | Successes | Total | p95 | Decline p95 | Max |
|---|---:|---:|---:|---:|---:|
| 4M at 6f00895 | 312 | 4.07 s | 28.4 ms | 80 ms | 90 ms |
| 4M now | 313 | 3.37 s | 23.5 ms | 37 ms | 59 ms |
| **6M now (adopted)** | **319** | **3.80 s** | **31.3 ms** | **38 ms** | **92 ms** |
| 8M now | 326 | 4.34 s | 37.4 ms | 57 ms | 165 ms |
| 6M, pools 1/48M of work (2/3 of the adopted pools) | 340 | 6.22 s | 63.5 ms | 138 ms | 162 ms |
| 5M, pools 1/40M | 330 | 4.77 s | 42.5 ms | 68 ms | 128 ms |

Smaller pools certify more, because the reservation leaves more of the allowance
for capture, construction and the solve. They have the same cost as metering,
though: a decline then spends most of its allowance in real work. Success is not
monotone in pool size. On the random-bushy-100-8201 tour, for example, click 1
certifies at 6M with 1/48M pools but declines with 1/32M pools, because the
first family's larger pools exhaust the ledger.

Two other approaches were rejected:
- **8M.** It raised folder p95 to 10.8 ms, worse than 6f00895.
- **Metered pools.** These charge the constructor's pools as they are spent,
  rather than reserving them up front. They reached 330 successes, but every
  decline then spends its whole allowance in real work. Folder p95 rose to
  15.8 ms, 1.56× 6f00895.

#### Click latency

Latency is measured as before: 522 tour steps and 398 folder states through a
real worker. Each column is the per-request minimum of two runs on the same
machine. Rows are classified by this pass's own counters. Times are in ms.

| Population / outcome | n | 5bbcb77 p50 / p95 / max | 6f00895 p50 / p95 / max | Now p50 / p95 / max | p95 vs 5bbcb77 | p95 vs 6f00895 |
|---|---:|---|---|---|---:|---:|
| Folder, all | 398 | 1.2 / 7.2 / 58.2 | 1.2 / 10.1 / 54.2 | 1.3 / 9.9 / 63.2 | 1.36× | 0.97× |
| Folder, adopted | 37 | 3.3 / 6.7 / 8.7 | 5.2 / 10.2 / 15.4 | 4.4 / 9.4 / 13.2 | 1.39× | 0.92× |
| Folder, declined | 25 | 5.3 / 10.9 / 15.8 | 8.7 / 16.7 / 19.5 | 8.9 / 19.4 / 21.9 | 1.79× | 1.16× |
| Folder, legacy only | 336 | 1.1 / 4.4 / 58.2 | 1.1 / 4.5 / 54.2 | 1.1 / 4.5 / 63.2 | 1.03× | 1.00× |
| Tour, all | 522 | 4.6 / 273.3 / 9838.5 | 10.6 / 273.0 / 9997.5 | 8.5 / 282.7 / 10099.4 | 1.03× | 1.04× |
| Tour, adopted | 151 | 3.9 / 24.5 / 92.2 | 10.5 / 47.9 / 120.4 | 8.5 / 45.8 / 149.6 | 1.87× | 0.96× |
| Tour, declined | 100 | 84.0 / 4231.3 / 9838.5 | 109.9 / 4208.4 / 9997.5 | 107.0 / 4290.6 / 10099.4 | 1.01× | 1.02× |
| Tour, outranked | 146 | 4.4 / 13.1 / 33.1 | 10.6 / 31.4 / 44.3 | 8.4 / 26.6 / 37.5 | 2.03× | 0.85× |
| Tour, legacy only | 125 | 0.7 / 39.6 / 360.2 | 0.7 / 36.8 / 356.0 | 0.7 / 35.9 / 368.4 | 0.91× | 0.97× |

Notes on the table:
- **Run-to-run noise.** Legacy-only groups vary by 1.0–1.18× between runs with
  no code change.
- **At 4M with the cheaper capture,** folder p95 was 9.1 ms (0.90×) and tour p95
  285.9 ms. The 6M allowance gives back part of the folder saving for coverage.
- **The newly adopted tour clicks cost 20–30 ms more than before.** A success
  replaces only legacy's `incrementalTree`; legacy's other candidates still run.
- **The attempt itself** takes at most 92 ms in the replay.
- **Dispatch is unchanged:** nothing moved to the worker, and exact revisits
  stay inline.

#### Production inventory

The inventory covers 1,050 requests with no geometry failures.

| Count | 6f00895 | Now |
|---|---:|---:|
| Attempts (memo hits) | 459 (19) | 459 (19) |
| Successes | 328 | 334 |
| Published | 182 | 188 |
| Budget fallbacks (by size) | 131 (49) | 125 (49) |
| Work | 393.9M | 485.3M |

Seven tour outputs differ from 6f00895. None of them moves a retained tile, and
retained-tile moves across the inventory stay at 39 (44 at 5bbcb77).

**Production reach of legacy stages is unchanged:** T24 7, T25 17 (constrained
5, repairable 12) and T28 band 11, over 24 requests. By reason:

| Reason | Requests | Stages reached |
|---|---:|---|
| Band over 47 items, so no attempt is made | 11 | T24 3, T25 constrained 5, T25 repairable 4, T28 2 |
| Attempt declines at 6M | 8 | T24 3, T25 repairable 8, T28 3 |
| Attempt adopted, but another legacy candidate still runs its own repair (anchored repack, T25 ladder) | 5 | T24 1, T28 4 |

The eight declines need, with pools scaled with the allowance:
- **8M–16M** for three (random-dag-40-7501 click 6, random-bushy-100-8201 and
  -8202 click 3). These spend under 5M; what they lack is pool size.
- **64M–256M** for three.
- **More than 1,024M** for two.

#### Coverage outside production

At the API allowance (1,024M), no population lost a success:

| Population | 6f00895 | Now |
|---|---:|---:|
| Corpus, complete requests | 62/63 | 62/63 |
| Tours, complete requests | 601/894 | 619/894 |
| Original, per-stage rows | 68/108 | 68/108 |

| Old-success stage | Corpus | Tours | Original |
|---|---|---|---|
| T24 free port lanes | 47/48 | 411 → 427/678 | 41/80 |
| T25 repairable contacts | 4/4 | 68/84 | 12/12 |
| T28 route contacts | 5/5 | 53/58 | 11/11 |
| Additional constrained route | 6/6 | 69 → 71/74 | 4/5 |

**All 42 unique misses are budget exhaustion.** By the charge the allowance ran
out on:
- inside strict construction, where the legacy constructor found no embedding
  in any family: 21;
- in snapshot or import charges: 18;
- in native checks: 3.

The legacy successes on these inputs come from T24, which shifts a retained port
lane, and from T25, which defers contact admission to repair. The constrained
path forbids both, because they move or reroute retained ink.

**Moves tried for the largest class, none adopted:**
- **A "port blockers" occupancy.** It defers only the retained routes whose ink
  covers a needed parent port, as T24 does. Construction then succeeds on tour
  inputs 220 and 237. But the metric solve fails: the deferred routes' tracks
  are pinned (`foreign-track`) and their order constraints form cycles.
- **Consistent side choices for a contact.** A berth and a parallel run at the
  same coordinate previously each defaulted to "before", which forms a two-edge
  cycle. Taking an order already imposed between the pair first removes that
  cycle. Combined with the port-blockers occupancy, it certified 1 of the 6
  inputs tested (49). Alone it changed no production attempt and no output.

The missing move is a repair that may move a retained free track off a port, as
T24 does, inside the metric. That means unpinning a deferred route's own tracks
while its source prefix and native bytes stay fixed. Until then, every legacy
stage stays as the fallback.

#### Tests

- `routing-problem.test.ts`: an imported problem is unique finite pins that a
  solve reproduces. It covers frames and a joined drawing, and guards the
  removed solve.
- `incremental-adoption.test.ts`:
  - **Click beyond 4M:** a random-bushy-100-8201 click that needs more than 4M
    is published with every retained tile kept. Failed first at 4M.
  - **Largest admitted fan:** the 47-item fan arrival certifies. Failed first
    before the import change, exhausting 4M.
  - **Allowance boundaries:** now use `maximumItems`.
- `legacy-reach.test.ts` (eb62c59): T24 is counted once, including on a memo
  hit.

#### Gates and changed acceptance rows

All three gates pass on 5d5dd96:
- `bun run check`: 0 errors.
- `bun run test`: 192 files, 2,393 tests passed and 1 skipped.
- `layout:eval`: all 50 targets pass.

The table lists the rows that changed against 6f00895's recorded values. All
other rows are unchanged, including both click-anchor rows (26 and 73).

| Row | 6f00895 | Now | Limit |
|---|---:|---:|---:|
| Corpus per-layout movedFraction | 0.1214 | 0.1199 | 0.1283 |
| Corpus transition movedFraction | 0.1938 | 0.1914 | 0.2574 |
| Broad transition movedFraction | 0.0491 | 0.0487 | 0.0788 |
| Mean legal displacement, px | 12.26 | 11.97 | 17.53 |
| Mean displacement / maxDisplacement | 28.67 / 65.75 | 28.30 / 65.06 | 34.76 / 80.19 |
| Mean siblingInversions / mixedDirections | 0.093 / 1.530 | 0.092 / 1.537 | 0.107 / 2.289 |
| Main-thread max p95, ms | 2.665 | 2.997 | 8 |
| ≤30 visible tiles max p95, ms | 37.959 | 41.395 | 100 |
| Full folder inline max p95, ms | 4.333 | 8.705 | 10 |

The timing rows were taken under load: the load average rose from 2.6 before the
perf stage to 15.4 after it. The slowest folder case was `random-dag-12-7223 /
open`, a first layout that runs no insertion attempt. At 81b5562, under normal
load, the same rows were 2.562, 34.455 and 5.022.

#### Review

An independent adversarial review of eb62c59..5d5dd96 found no correctness or
product-contract defects. It verified the following:
- **The solve removal.** Import output is unchanged except for the work charged.
- **Coordinate ids.** These are identical across 40 corpus drawings and
  adversarial keys: sparse arrays, getters, `\u2028`, lone surrogates, and scene
  ids like `x","tile`.
- **Prefix matching.** It is equivalent to the old parse.
- **Caches.** They are rebuilt on every backtrack.
- **Allowance boundaries,** and parity between the worker and the main thread.

It confirmed the following, and each is addressed in the commit after
fbdfd83:
- **T24 and T23 could be counted for a repair that changed nothing.** A stage
  may return a fresh, unchanged object. They are now counted only when a route
  path changed.
- **T28 is counted when the repair succeeds, even if the caller then discards
  the drawing.** The counter now documents that it counts reach, not
  publication. Its call-site argument is now required, rather than defaulting
  to `band`.
- **The negative counter test could not reach any repair.** It now places a real
  arrival that needs none.
- **The 6M adoption test's title misstated why 4M declined.** It is retitled:
  the up-front pool reservation plus capture does not fit 4M, even though the
  attempt's net work is about 2.5M.
- **The pool premise in the allowance comment was wrong.** Pool ratios are now
  measured, as in the table above.
- **Two commit messages overstate their results.** 5d5dd96 says latency is "at
  or below 6f00895", but tour p95 is 1.04× and folder declined p95 is 1.16×;
  read it as "within run-to-run noise". eb62c59 calls foreign-route work
  linear, but the per-pair scan is still tracks × routes. The parse is the only
  part done once.

#### What remains of slice 4

- **Retained-track port repair in the metric.** Done; see "Retained-track port
  repair" below. It covers every API-allowance miss of at most 47 items where
  legacy's own insertion certifies without contact repair. It changes no
  production outcome, so it unlocks no deletion by itself.
- **Pool sizing.** This is now the main production blocker for T24. Eight of
  the eleven declined attempts that reach T24 certify at 6M through the strict
  capture, with no repair at all, once pools are 1/48M of the allowance rather
  than 1/32M. Granting pools without reserving them makes every decline spend
  its allowance, so this needs a way to predict a decline early.
- **The anchored-repack and T25 ladder call sites** never get a constrained
  attempt. Adopted requests still reach T24 or T28 through them.
- **Contact deferral (T25, T28).** The remaining API misses that legacy
  certifies need a deferred contact repaired afterwards. They are not port
  cases.
- **Deletion.** No stage meets the deletion rule.

### Retained-track port repair

This pass adds the T24 counterpart inside the constrained metric. It covers
three more tour inputs at the API allowance, loses none, and leaves every
production output and latency group unchanged. No stage is deleted.

#### The move

A newly active source port is the bottom or right port of a retained parent of
a new item; the band cover departs only through its bottom. Before
construction, in the fragment (framed) capture only:

1. `blockedSourcePorts` lists the newly active ports that a route of another
   source passes within `PORT_BERTH`.
2. `clearIncrementalPorts` runs the same affected solve as the final metric
   (`solveAffectedTracks`), over the retained drawing, with one extra family of
   hard separations. Each free retained core within a blocked port's berth must
   sit at least `PORT_BERTH` from the port centre. Which side it takes is a
   corridor choice, current side first.
3. The solve moves those cores and whatever their separations push, in the
   drawn order. Parallel tracks keep their order, unlike legacy T24, which can
   carry a run past a parallel neighbour.
4. If a port's separation conflicts with constants, the metric witness names
   that port's centre pin. That port stays blocked and the others are cleared
   without it. A witness that names no port pin, such as an order cycle,
   drops the last port instead, so every retry tries fewer ports.
5. The repair spends at most a quarter of the remaining ledger
   (`PORT_REPAIR_SHARE`). If it exhausts that share, the drawn pose is kept and
   construction proceeds with the rest, so a repair can never starve the
   attempt.

The cleared pose is what construction sees. It is a preference, not a
certificate: the final solve, the retained-constant binding, native clearance
and the unchanged independent gate still admit the completed drawing.

**Why this is principled rather than T24 transplanted:**
- It changes only variables the framed capture already frees (straight cores
  between native spans).
- It adds a hard separation of the same kind as `port-corner`, with its side a
  discrete corridor choice, all on the same ledger.
- Native spans, source prefixes, terminal suffixes, ports, tiles and dots stay
  constants.
- There is no offset probe list, no fillet rewriting and no four-edit cap.

The strict capture is unchanged, since its retained connectors are byte-identical
by contract.

**Scope.** Only source ports of retained parents are repaired. Arrival ports
of retained children that gain a new parent are not. A route counts as a
blocker unless it departs from the port's owner. A junction-sourced route
therefore counts, where legacy T24 skipped it. That route is still only
separated by `PORT_BERTH` from the port, so it is not rerouted.

Two parts of the abandoned prototype were dropped:
- **Reordering parallel tracks.** Letting a cleared core pass a parallel
  retained track (a "track-order" choice) certified nothing extra on the gained
  inputs, and it would break "preserve retained orders".
- **Port-blocker occupancy.** That earlier prototype is replaced. Cores are
  cleared before construction instead of being deferred during it.

#### Coverage outside production

These are replays at the API allowance (1,024M, 4× pools). T24 rows replay the
committed history the request carried, which reproduces the completion pass's
numbers exactly at c00dea4. The table compares main (c00dea4) with this pass:

| Population | Completion pass | c00dea4 | Now | Gains / losses |
|---|---:|---:|---:|---|
| Corpus, complete requests | 62/63 | 62/63 | 62/63 | 0 / 0 |
| Tours, complete requests | 619/894 | 619/894 | **633/894** | 14 / 0 |
| Original, per-stage rows | 68/108 | 68/108 | 68/108 | 0 / 0 |
| Original, complete requests | 213/253 | 212/253 | 212/253 | 0 / 0 |

| Old-success stage, tours | c00dea4 | Now |
|---|---:|---:|
| T24 free port lanes | 427/678 | **438/678** |
| T25 repairable contacts | 68/84 | **71/84** |
| T28 route contacts | 53/58 | 53/58 |
| Additional constrained route | 71/74 | 71/74 |

For the original population, the complete-request figure combines three
replays: the per-stage band rows above, the 133 folder placements (133/133),
and the 12 hint reroutes (11/12). The rebuilt replay counts one fewer success
than the lost tool did. The s4d unified replay, which runs only the framed
capture, gives 203/253 both before and after.

The 14 rows are three unique inputs: tour inputs 41 and 62 (26 items) and
699–710 (30 items). They certify at 156M–537M of work. Tour input 41, the
canonical case, now certifies at 364M. On input 62, two retained cores at
x=166 and x=169 pass n21's right port at x=164. The repair moves them to 170
and 173, and pushes the parallel core at 172 to 176. Legacy T24 instead moved
them to 176 and 179, past that core.

**The 33 remaining unique tour misses are all budget exhaustion.** On each
captured input, the legacy insertion was rerun at 1× and 4× pools under the
stable, constrained and repairable policies:
- **25 inputs: no legacy drawing at all.** The T24 stage ran, but the request
  was served by another candidate. Four of these are within 47 items.
- **5 inputs: legacy certifies without contact repair.** All have 50–65 items,
  above the production limit.
- **3 inputs: legacy needs contact repair** (49, 54 and 32 items). These are
  T25/T28 cases, not port cases.

So within the production size limit, no remaining miss is a port-repair case
that legacy certifies.

The replay that uses the drawing T24 itself received (`args[1]`) gives the same
picture: tours 578 → 589/894 with no losses, and original 67/108 both before and
after. On 95 of those rows, that drawing is an anchored-repack subset or one
already changed by T23.

#### Production inventory and reach

The previous inventory and latency tools were lost, so this pass rebuilt them.
They measure 3,405 requests:
- 3,150 legal click-tour steps: corpus and dense corpus, five widths, image
  96, up to nine steps, as in `import-census.ts`;
- 255 folder open and click states: corpus fixtures of 2–40 nodes at 454 px,
  run through `createFolderLayoutRuntime`'s engine on the main thread.

This population is about three times the completion pass's 1,050 requests.
Its counts are not comparable with that pass's.

| Count | c00dea4 | Now |
|---|---:|---:|
| Attempts | 2,585 | 2,585 |
| Successes | 1,692 | 1,692 |
| Published | 1,013 | 1,013 |
| Budget fallbacks | 893 | 893 |
| Work | 3,974.5M | 3,976.4M |
| Outputs that differ | — | 0 |
| Geometry gate failures | 0 | 0 |

Legacy reach is unchanged: T24 21, T25 constrained 74, T25 repairable 56 and
T28 band 58 requests, out of 174 requests that reach any of them.

The 21 requests that reach T24 break down as follows:

| Reason | Requests | What it would take |
|---|---:|---|
| Attempt declines at 6M | 11 | 8 certify at 6M by the strict capture with 1/48M pools. One needs 16M; two need 64M and more than 1,024M. The repair changes none of these: the allowance each needs is identical with and without it. |
| Band over 47 items, so no attempt | 8 | the size limit |
| Attempt adopted, but the anchored repack or T25 ladder runs legacy | 2 | constrained attempts at those call sites |

The port repair itself never decides these production cases. They are limited
by pool reservation, the size limit and the call sites.

#### Click latency

Each figure is the per-request minimum of two runs, on the same population and
the same machine, against c00dea4 plus a profiling stage around the attempt
(0b284b5). Times are in ms.

| Group | n | c00dea4 p50 / p95 / max | Now p50 / p95 / max | p95 ratio |
|---|---:|---|---|---:|
| Folder, all | 255 | 6.7 / 69.7 / 308.5 | 6.6 / 69.1 / 303.3 | 0.99 |
| Folder, adopted | 160 | 7.9 / 40.3 / 111.8 | 7.4 / 37.6 / 111.6 | 0.93 |
| Folder, declined | 16 | 76.4 / 308.5 / 308.5 | 69.1 / 303.3 / 303.3 | 0.98 |
| Folder, outranked | 14 | 7.6 / 23.9 / 23.9 | 7.3 / 24.0 / 24.0 | 1.00 |
| Folder, legacy only | 65 | 1.5 / 15.2 / 38.7 | 1.5 / 14.0 / 37.4 | 0.92 |
| Tour, all | 3,150 | 12.5 / 1,477 / 34,662 | 12.5 / 1,516 / 34,620 | 1.03 |
| Tour, adopted | 853 | 7.9 / 73.7 / 241.2 | 8.4 / 71.8 / 248.2 | 0.97 |
| Tour, declined | 877 | 220.3 / 5,222 / 34,662 | 215.1 / 5,246 / 34,620 | 1.00 |
| Tour, outranked | 665 | 10.8 / 33.8 / 95.5 | 10.5 / 35.8 / 85.3 | 1.06 |
| Tour, legacy only | 755 | 1.3 / 231.5 / 800.4 | 1.3 / 229.3 / 798.1 | 0.99 |

- **The attempt itself** takes at most 186.6 ms, against 179.0 ms at c00dea4,
  with p99 87 ms. No attempt exceeds 250 ms.
- **The allowance is unchanged:** 6M, 375K per item, at most 47 items.
- **Nothing moved to the worker.**

#### Tests

`retained-port-repair.test.ts`:
- **Blocked ports.** The owner's own routes, an exact berth, requests with no
  new item, and the cover's missing right port.
- **The clearance moves only the occluding core, to the berth.** Tiles and the
  other route stay byte-identical, the fragment constants still bind, and a
  repeat on cloned inputs gives the same result.
- **A parallel core is pushed in its drawn order, never passed.**
- **Whole-route captures decline** (no fragment authority).
- **Tour input 62 certifies through `constrainedBandInsertion`.** The test
  checks retained rectangles and fragment constants exact, the blocked port
  clear, and the gate passing. It failed first with the call disabled: budget
  exhaustion in strict construction.

No production-allowance case changes outcome, so no publication-level test
can fail first. The inventory shows zero changed outputs.

#### Gates and changed acceptance rows

All three gates pass:
- `bun run check`: 294 files, 0 errors.
- `bun run test`: 193 files, 2,400 tests passed and 1 skipped.
- `layout:eval`: all 50 targets pass.

Every production output is byte-identical to c00dea4, so only timing rows
moved. Against the completion pass's recorded values:

| Row | Completion pass | Now | Limit |
|---|---:|---:|---:|
| Main-thread max p95, ms | 2.997 | 2.980 | 8 |
| ≤30 visible tiles max p95, ms | 41.395 | 35.172 | 100 |
| Full folder inline max p95, ms | 8.705 | 5.550 | 10 |

All other current rows match, including both click-anchor rows (26 and 73).

#### Review

An independent adversarial review found no contract violation. It confirmed
the refactor is a line-for-line move, that only free cores move, that the
ledger is never exceeded, and parity. It found five defects, all addressed:
- The repair could spend the whole remainder, so exhausting it failed the
  attempt instead of skipping the repair. It now runs within a quarter of the
  remainder.
- A witness that named no port pin abandoned every port. It now drops one port
  and retries.
- The witness bookkeeping undercharged string comparisons.
- The parallel-core test asserted only the order, between two routes that
  share a source and so were never separated. It now uses another source and
  checks the exact pushed coordinate, 149.
- The doc section was unfinished.

Recomputing the repair on every outer backtrack costs work but changes nothing
(one call on the gained inputs), so it is left as is. After the fixes, tours
are still 633/894 and the production inventory is still unchanged.

### Slice 4 finish pass

This pass worked through the four blockers named above, then applied the
deletion rule. Production reaches T24 in 13 requests (21 before), and T25
and T28 as before. No stage meets the rule, so **slice 4 remains open**; the
exact blockers are at the end. Every number is measured on the rebuilt
inventory (3,405 requests) against a baseline captured at origin/main
(d069394) before any change.

#### 1. Pool sizing with early decline prediction

Measured over the 2,210 production attempts of at most 47 items, replayed in
isolation:
- **Successes almost never spend their pools.** Nine in ten spend nothing
  from them, the most any spends is 47%. The 1/32M reservation instead crowded
  out construction's other charges (native checks, about 2.5M in a decline):
  the eight T24 declines spend 3–5M in all and fail only because the
  reservation left too little for those charges.
- **What predicts a decline is capture cost.** Declines are the large
  drawings: capture p50 0.23M against 0.02M for successes. 145 of the 146
  attempts whose capture costs more than a twentieth of the allowance decline
  anyway. Pool spend, path length and new-item count separate the rest no
  better; the best two-feature rule found saved another 5 s of the 23 s of
  remaining decline time.

So pools are now 1/48M of the allowance, and a capture above a twentieth of
it stops the attempt before construction (`PREDICTED_DECLINE`, counted as
`adoption:band-insertion:predicted-decline` and as a budget fallback;
`incremental-routing.ts` `routeCommittedIncremental`, `incremental-adoption.ts`
`PRODUCTION_ROUTING_WORK`).

| Attempts ≤ 47 items | Successes | Total | Decline p50 / p95 / max |
|---|---:|---:|---|
| 1/32M pools (main) | 1,685 | 33.1 s | 24.5 / 96.9 / 197 ms |
| 1/48M pools | 1,786 | 51.8 s | 61.5 / 143.2 / 194 ms |
| 1/48M + prediction | 1,785 | 45.3 s | 49.3 / 133.7 / 219 ms |
| 1/48M + prediction + local native checks (below) | 1,799 | 41.2 s | 35.9 / 130.4 / 234 ms |
| 4M, 1/48M · 5M, 1/48M | 1,702 · 1,750 | 41.7 · 48.8 s | 41 · 54 ms p50 |

All eight T24 declines that certify with 1/48M pools are now published. The
smaller allowances cover only two to five of them.

#### 2. The anchored-repack and T25-ladder call sites

Both sites re-embed every unanchored tile around the click's ancestry, so
their base is the same projected subset. The constrained insertion now runs
first at both (`band-layout.ts`, `insertion` and the ladder prelude) and the
legacy `incrementalTree` only on a decline. Its cost is the catch:
- **Unrestricted,** it added 1,126 attempts to the inventory, took adopted
  tour clicks to 1.59× and outranked ones to 1.52× their main p95, changed one
  output, and lowered T28 reach by 3. It removed no T24 or T25 reach.
- **The two adopted requests whose losing repack candidate reaches T24**
  (random-dag-40-7501 at 640 px, clicks 6 and 7) re-place 16 tiles. They
  certify at 21M and 13M, taking 342 and 223 ms on their own.
- Attempts with at most four new tiles certify 205 times in 210; with more,
  fewer than half certify and their declines cost a further 14 s.

The site therefore runs only for at most four new tiles
(`maximumRepackItems`); a skipped repack is counted as
`adoption:band-insertion:repack-skipped`, not as an attempt. With that limit the inventory's outputs and legacy
reach are unchanged, and latency is within noise.

#### 3. Bands over 47 items

There are 375 such production attempts, all on clicks whose legacy insertion
takes seconds. Replayed with 1/48M pools:

| Allowance | Certify | Decline p50 / p95 / max |
|---|---:|---|
| 6M | 7 (9 with local native checks) | 36 / 87 / 182 ms |
| 9M | 21 | 54 / 188 / 267 ms |
| 12M | 34 | 62 / 263 / 330 ms |
| 64M, pools as at 6M | 141 | 977 / 1,348 / 2,012 ms |

A certifying large band spends median 15.8M. On a profile of 20 of them
(about 200 ms each), construction was a third and the affected solve plus
admission most of the rest; the unchanged independent gate alone is 22 ms.

- **The move that paid: local native checks in construction.**
  `nativeCompatible` ran the full pairwise native clearance of each probe
  against every retained route. A pair whose painted envelopes (control hulls
  and arrowheads) are at least the largest clearance radius apart cannot fail
  that check (`NATIVE_REACH`, `outOfNativeReach` in
  `native-route-clearance.ts`), so it is skipped and charged as a parse.
  Construction time on large bands fell by about a third. Successes are
  unchanged wherever they already fit; 14 more small and 2 more large
  attempts now fit. The old-success replays below are identical.
- **Admission is the remaining cost.** The affected solve still scans tracks
  against every foreign route, and the retained-constant check re-imports the
  whole drawing. Halving those would still leave a large band's typical
  success near the 250 ms bound, with its declines above it.

So bands of any size are now attempted under the same 6M ceiling (the
47-item limit is removed): their declines cost at most about 170 ms on
clicks that already take seconds, and 9 certify. **A larger allowance for
them is not possible within the click bound:** 12M certifies 34 but declines
take up to 330 ms, and none of the 8 large-band requests that reach T24
certifies below 12M (6 do at 64M). They stay with legacy as budget
fallbacks.

#### 4. Contact deferral for T25 and T28

- **What exists.** The framed `deferred` and `route-only` occupancies already
  defer contacts with retained free cores: native checks and the lane index
  see only the retained hard fragments, and the affected solve separates
  parallel free tracks with side choices.
- **The experiment.** A `repairable` insertion order was added to the framed
  families, so contacts between new routes also wait for the metric. On the
  only contact case of at most 47 items (tour input 84, 32 items) it does not
  certify at 1,024M: in every family the constructor cannot place the last new
  tile, n98, with 31 tiles placed. The failure is a placement, not a contact.
  Legacy's success there uses the repairable draft plus T28, which moves a
  *retained* free core of n21→n30 from x=330 to x=342 together with a new
  core, which the framed metric could express but construction never reaches.
  The experiment was not kept.
- **Production.** 116 of the 119 requests that reach T25 have no constrained
  certification even at 64M (74 are bands over 47 items, 42 smaller). Of the
  57 requests that reach T28, 20 certify only at 7–61M, 29 not at 64M, 5 reach
  it through another legacy candidate after an adopted attempt, and 3 have
  no band attempt.

#### 5. Deletion

No stage is deleted. For each:

| Stage | Production reach | Old-success coverage at the API allowance | Blocker |
|---|---:|---|---|
| T24 free port lanes | 13 requests | tours 438/678, corpus 47/48, original 41/80 | 8 large bands need 12M–64M or more; 1 predicted decline needs 6.8M; 2 repack candidates need 13M–21M; 2 need 15M and over 64M |
| T25 repairable / constrained retry | 56 / 74 requests (119 in all) | tours 71/84, corpus 4/4, original 12/12 | 116 of 119 have no constrained certification at 64M; the remaining contact cases fail in placement (above) |
| T28 band contact repair | 57 requests | tours 53/58, corpus 5/5, original 11/11 | 20 need 7M–61M, 29 have none at 64M, 5 come through other legacy candidates |

Coverage is unchanged by this pass at every population (tours 633/894,
corpus 62/63, original per-stage 68/108): every gain is inside the
interactive allowance, and the API-allowance misses lie far beyond it.

#### Production inventory and click latency

| Count | origin/main | Now |
|---|---:|---:|
| Attempts (by size, before any work) | 2,585 (375) | 2,745 (0) |
| Repack attempts skipped for more than four new tiles | — | 964 |
| Successes | 1,692 | 1,974 |
| Published | 1,013 | 1,106 |
| Budget fallbacks (predicted) | 893 | 771 (237) |
| Work | 3,974.5M | 4,822.1M |
| Outputs that differ | — | 160 |
| Geometry gate failures | 0 | 0 |

The 160 extra attempts are repack-site attempts; the 375 large-band
attempts now run instead of declining before any work. Outputs differ only
where an attempt now certifies; consecutive-output tile moves fell from 352
outputs (8,052 tile coordinates) to 338 (7,965).

Latency is the per-request minimum of two runs, on the same machine,
against the origin/main baseline. Groups are this pass's own counters. Times
are in ms.

| Group | n | main p50 / p95 / max | Now p50 / p95 / max | p95 ratio |
|---|---:|---|---|---:|
| Folder, all | 255 | 6.5 / 68.1 / 305.8 | 6.5 / 67.7 / 360.0 | 0.99 |
| Folder, adopted | 165 | 7.8 / 55.2 / 242.8 | 7.4 / 60.0 / 270.9 | 1.09 |
| Folder, declined | 13 | 68.5 / 305.8 / 305.8 | 72.1 / 360.0 / 360.0 | 1.18 |
| Folder, outranked | 15 | 6.2 / 23.2 / 23.2 | 7.4 / 22.9 / 22.9 | 0.99 |
| Folder, legacy only | 62 | 1.4 / 11.3 / 18.7 | 1.4 / 12.1 / 18.3 | 1.07 |
| Tour, all | 3,150 | 11.4 / 1,497 / 33,812 | 11.3 / 1,529 / 34,232 | 1.02 |
| Tour, adopted | 941 | 9.0 / 78.9 / 220.1 | 8.5 / 80.0 / 255.7 | 1.01 |
| Tour, declined | 793 | 276.6 / 5,258 / 33,812 | 299.9 / 5,266 / 34,232 | 1.00 |
| Tour, outranked | 697 | 10.2 / 46.7 / 80.1 | 10.6 / 54.6 / 100.2 | 1.17 |
| Tour, legacy only | 719 | 1.2 / 84.5 / 797.8 | 1.1 / 84.0 / 786.8 | 0.99 |

- **The attempt itself** takes at most 220 ms (per-request minimum of two
  runs; p99 127 ms). Single runs under load reached 398 ms.
- **Nothing moved to the worker,** and no new worker or async pattern exists.
- **A request can now run two attempts** (insertion and repack), each within
  its own 6M allowance.
- **`click-stability.test.ts`** took 1,260 s against 1,237 s at origin/main,
  run side by side on the same machine.

#### Review

An independent adversarial review of 2981b66..cb9e756 found no product-contract
violation: retained rectangles, clicked ancestry and cold/warm parity held on
728 replayed tour requests, and the reach bound is exact for every path the
strict reader accepts. It confirmed three defects, all fixed:
- Skipped repacks were counted as attempts and budget fallbacks, which
  inflated the inventory counts. They now have their own counter, and the
  table above is regenerated (outputs identical).
- `outOfNativeReach` could skip a path the strict reader rejects (lowercase
  commands, `Z`, subpaths, closed curves), where the clearance check would
  have failed it. It now requires the strict reader to accept both paths.
- The exhaustive reach test never exercised the tile-port and junction radii
  that set `NATIVE_REACH`, so a reach reduced to the lane separation still
  passed. It now covers both and fails under that mutation.

It also tightened two tests: the prediction test now checks that the
fragment search is skipped, and the repack test checks the clicked ancestry.
A memo hit on a predicted decline counts the budget fallback but not
`predicted-decline`, so that counter is a lower bound.
