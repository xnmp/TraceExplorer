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
