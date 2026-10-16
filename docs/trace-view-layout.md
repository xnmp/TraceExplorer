# Trace view layout

How the Trace view arranges one connected component, which way it runs, which nodes it shows, and why it does not use ELK.

## Grid bands and pinned covers

The view uses one folder-order grid. `folderCells` collapses each lineage at
its cover’s position in the host listing. Stacks with no listed cover (unsaved) follow the
listing, oldest cover first (creation order of the cover key), so a stack gaining members never
moves another. No user action moves a cell: a stack that was unsaved **stays where it is after it is
saved** (`held`, kept by `StackGrid`) until the grid is laid out afresh, i.e. the folder or the column
count changes, when it takes its listed position. Its eventual file name cannot be known before it is saved.

This column rule covers **grid cells** (covers, ordinary files, folders). Inside an open band the
layout follows the visible-first optimisation rules below. Hidden descendants supply
caption/hint sizes and complete parentage, but never placement slots. The last committed
visible embedding supplies explicit, priced history. Selection styling with an unchanged
visible set reuses the committed geometry.
`gridFlow(items, open, columns, metrics)` takes the host-sorted list **already collapsed** to one
`{id, kind: "stack"}` at each cover's position, plus ordinary files/folders.
Use an entry path or cover key as `id`, rather than a component id (which can
change on merges). Cells keep their logical row, column and x on every band
change. Full-width bands begin at their stack row's bottom; groups sharing a row use ordered rectangle packing and routing-aware skyline compaction,
and the normal folder row gap follows the shared band. Measured heights
exclude the cover row. Coordinates start at (0, 0), without pane padding.
`mapGridItemRects(before, after)` joins by identity and returns both rectangles,
including null for arrivals/departures. The domain does not animate anything.

For a fully paged graph, `projectReferenceBadges(projectDag(nodes))` removes
foreign root images (scope `subfolder`/`external`, with a path and no accepted
parent in the supplied DAG; the index sends an outside image with no current-folder ancestor
without parents, so a chain A → B of outside inputs is all badges) from the drawable DAG. It preserves each reference's
path, scope, key and ordered direct consumers, indexed by consumer. Keep all
badges in domain data; display up to three and a `+n` overflow in the view.
Path-null placeholders and foreign images below a current image remain tiles. Compute
drawable components **after** this projection: sharing only a reference no
longer joins two edit chains. Projection requires complete parent relationships,
before visibility filtering; a partial graph cannot establish reference roots.
`lineageWithBadges` treats each badge as a virtual parent: focusing it highlights
all its consumers and descendants; focusing a consumer highlights its badge
ancestors without highlighting unrelated co-consumers.
`badgeHighlight` adds hover lineage to the selected lineage without changing
the selected neighborhood, keyboard focus, or layout request.

`planBandScene` accepts the projection, drawable members and a `PinnedCover`.
It seeds visibility from current-folder roots and retains the complete drawable lineage
for stable captions and history compatibility. `layoutBand` places **only `request.items`**.
The engine, objective, routing geometry and packing helpers are pure TypeScript in
`src/lib/domain/trace-graph/`; the view and worker are adapters.

Candidates include the downward junction router and top-aligned tree generation shelves.
A bounded dynamic program scans at most 32 columns at each partition state, alongside
fixed greedy partitions. Serial chains use the best shelf partition directly where it
fits. Shelves reserve only their visible entry/exit ports and independent wrap tracks.
The first generation starts at the cover header; short columns are never centred against
taller later generations. Width budgets use 32 px buckets, a one-tile minimum and a
100,000 px cap. Invalid widths use one tile; malformed nodes, cycles, duplicate identities
and invalid dimensions/metrics are rejected. The upstream DAG projection still cuts
malformed backend history deterministically before planning.

`layout-quality.ts` scores candidates after the same exact attachment used by the grid:

```
C = 16 H/t + 2 A/t² + .08 L/t + .12 B + .1 X
    + mixedDirections + 3 siblingInversions + .25 unaligned
    + 100 widthOverflow/t
    + 1.5 (meanDisplacement/t + .25 maxDisplacement/t + 2 clickedDisplacement/t)
```

Here H/A are the visible child/routing height and area, t is tile width, L is sampled
connector length, B is turning in quarter-turn equivalents, X is unrelated-source
crossings. Empty area is already priced through H/A; whitespace is reported separately.
Hard gates reject missing/extra nodes, wrong sizes, nonfinite/off-canvas geometry,
overlaps, connectors through tiles, incorrect directed parentage, invalid paths, broken
source-to-output connectivity, arrow approaches and shared lanes.

#### Shared lanes

Connectors from different sources never share a lane. `sharedLanePx` is the collinear
overlap of every pair of flattened route segments whose routes start at different
sources; that includes two inputs of one junction running along a final stretch, since
inputs may meet only at the dot. It also counts near lanes (`nearLaneLength`): axis-parallel
runs of different sources closer than `LANE_SEPARATION` (3 px, centre to centre) over more
than an arrowhead. A plain stroke is 1.35 px wide and a highlighted one 2.3 px, so closer
lines merge into one; a junction's inputs are exempt, as they converge on its dot. Routes
from one source may share (trunks). A candidate with `sharedLanePx > 0` fails the hard
gates, which `validateLayout` checks exactly. Every generator avoids lanes at the source:

- the downward router through its zone, track and fan-in rules ([Routes](#algorithm));
- shelves, whose channel lanes give a source arriving at the height another source leaves
  from a lane further out;
- the incremental embedding, which records placed segments with their source and rejects
  a route that runs along another source's segment, within `LANE_SEPARATION` of one, or
  alongside its curves at a shallow angle (`SHALLOW_RUN`) (its alternatives: gutters, travel
  rows, side columns, nested junction levels, the bounded grid), returning no candidate
  when nothing is lane-free.

The unchanged-visible shortcut is not taken when the committed layout shares a lane. Only
when no candidate is lane-free does the engine price the lanes (`4 Q/t`, Q the shared
length) and show the best candidate, flagged `lane-infeasible`. That holds for cold
requests too: when the gates keep every candidate out, each one that fails on lanes alone
is priced (built lazily, the downward layout included) and the cheapest is shown. Only a
request that defeats every candidate on other gates (malformed input, such as a cover with
a visible parent: `pinnedViolation`) shows the downward layout as is, flagged
`gate-infeasible`. `fallbackReason` gives the reason from the layout itself. Across the
evaluation corpus's static tours (6,060 layouts) 5 are `lane-infeasible`, all on near lanes
in dense random DAGs; 19 of the 3,200 North layouts are (18 before near lanes counted), and
15, 5 and 1 of the `combinations`, `mj` and `merge-k8` profiles' 2,800–3,640. Before near
lanes were gated, 10% of corpus layouts and up to 24% of a merge-heavy profile's showed one
unflagged.

#### Crossings

X counts proper crossings between connectors of unrelated sources. Its weight is an
exchange rate: one more crossing must save `CROSSING_HEIGHT_TILES` tile widths of band
height (`.1/16`, about 0.6 px at the default tile), and the evaluation uses the same rate
to decide whether a layout that crosses more than the baseline paid for it. The value
comes from a sweep over the corpus and the legal tours:

| Height per crossing (tiles) | Mean crossings | Regressions | Unpriced | Tour height / baseline | Tour displacement |
|---:|---:|---:|---:|---:|---:|
| .00625 | 335.2 | 383 | 105 | .857 | 21.7 px |
| .05 | 334.2 | 357 | 146 | .856 | 23.3 px |
| .25 | 333.6 | 293 | 151 | .867 | 33.2 px |
| .5 | 333.6 | 278 | 156 | .881 | 40.0 px |
| 1 | 333.5 | 265 | 169 | .887 | 52.8 px (fails ≤ 42.5) |

The sweep ran on the engine before the incremental embedding's compaction pass; the
trend, not the absolute numbers, is what it shows. A higher rate barely moves mean
crossings (the candidate family, not the weight, decides them) but makes tours taller and
less stable, so the lowest rate is kept. Most unpriced regressions save no height at all,
so no rate removes them: they come from the choice of family, not from pricing. The
baseline mean is 378.6. A matching sweep set the `mixedDirections` weight to 1 (from .5):
mixed placements 2.16 → 2.12 per layout with every other target unchanged; at 2 they fall
to 1.93, but one layout becomes more than 10% taller than the baseline without a stability
reason.

#### Crossing cap

Holding the clicked tile and its visible ancestors still must not buy stillness with a
crossings explosion. When the winner preserves the anchors, crosses more than 50 times,
and crosses more than the best unanchored candidate (the layout the engine would choose
with no anchors: same objective, same orientation rule, found exactly by the same branch
and bound) by more than `max(50, .25 X_free)`, the anchors yield: the unanchored candidate
is shown and the decision is flagged `anchor-yield`, which is distinct from
`anchor-infeasible` (no anchor-preserving candidate exists). `ANCHOR_CROSSING_SLACK` and
`ANCHOR_CROSSING_RATIO` in `band-layout.ts` hold the two terms. The bound comes from a
sweep over the corpus and the legal tours (yields are anchor-preserving winners that
yielded; "infeasible" counts tour clicks flagged `anchor-infeasible`):

| Cap (absolute / relative) | Unpriced crossing regressions | Corpus yields | Tour yields | Tour height / baseline | Tour displacement | Anchor-infeasible clicks |
|---|---:|---:|---:|---:|---:|---:|
| none | 88 | 0 | 0 | .785 | 21.3 px | 7 |
| 100 / 100% | 86 | 3 | 8 | .783 | 20.8 px | 7 |
| 75 / 50% | 76 | 16 | 29 | .779 | 24.4 px | 9 |
| 50 / 50% | 75 | 17 | 40 | .790 | 30.9 px | 9 |
| 50 / 35% | 69 | 33 | 64 | .788 | 32.1 px | 9 |
| **50 / 25%** | **67** | **38** | **74** | **.788** | **31.5 px** | **9** |
| 30 / 35% | 68 | 34 | 76 | .801 | 38.0 px | 9 |
| 25 / 50% | 75 | 18 | 58 | .806 | 39.3 px | 9 |
| 25 / 100% | 86 | 4 | 38 | .808 | 35.4 px | 7 |
| 10 / 25% | 61 | 52 | 156 | .840 | 57.3 px (fails ≤ 42.5) | 9 |

Every capped setting brings the worst case, random-dag-100-8101 at 360 px / preset 128
(step 2: 725 crossings against the baseline's 334), down to 321, and none adds a height
regression without a stability reason. 50 / 25% removes the most unpriced regressions
that the displacement target allows: tighter caps either stop removing regressions (the
remaining ones are not anchored history, below) or move anchors so often that tour
displacement climbs towards and past the target. The cap costs one exact evaluation of
the best unanchored candidate whenever an anchored winner crosses more than 50 times
(about 1.5 ms at p50 on random-dag-40-7503's 24-tile reveal: its gates alone take 1.7 ms).

#### Known readability limits

With the final engine, 417 of 6,060 corpus layouts cross more than the baseline; 67 of
them are not paid for by the exchange rate, and 52 of those save no height at all. They
come from three sources, none of which a weight can fix:

- **Shelf crossings in long chains** (50: random-chainy-100/200; 40 of them are the
  unchanged-visible steps that keep the same layout, which count again): shelf channels
  route each source's trunk through one lane per source, so long wrapped chains cross
  more than the baseline's layered sideways drawing (277 → 418 at 640 px, preset 64).
- **Anchored history within the cap** (11, all flagged `stability`). The clicked tile and
  its visible ancestors stay put whenever a lane-free embedding allows it and the crossing
  cap is not exceeded, so a DAG reveal can cross more than a fresh layout (worst:
  random-dag-100-8101 at 454 px / preset 128, 510 → 571).
- **Wrapped single columns and small downward layouts** (6: screenshot,
  random-tree-12-7121, hidden-siblings at 360 px, three DAG states): two sources passing
  one margin cross once or twice where the baseline drew one on each side. Choosing the
  emptier margin on ties was tried and rejected: across the corpus it raised mean
  crossings from 335 to 379.
Spatial indexes, parsed route plans and cached geometric joins keep repeated checks
bounded. Cubic diagnostics use the production twelve-step flattener; this is a geometry
approximation, not a proof about arbitrarily thick strokes.
An immutable candidate's envelope is captured once and translated with its attachment.
The search is branch and bound over the candidate family. Every candidate first gets an
admissible lower bound from its attached rectangles and allocation alone (`rectangleCost`:
height, area, overflow and node penalties, connector terms taken as zero); a second bound
adds exact connector length and turning (`optimisticCost`). Connectors are attached,
translated or evaluated only for candidates whose bound can still change the choice,
given the incumbent's score and the orientation hysteresis rule. The downward layered
layout and anchored translations are not even built while their bounds (a downward
height floor from the longest visible chain; translated rectangles) exclude them, except
where their exact height decides the cold height budget or a re-embedding. Pruning never
changes the chosen layout or its decision record. A sole cold embedding runs the same
hard gates without computing soft diagnostics that cannot affect a choice.

A reveal offers the retained subset, translated anchor embeddings and an incremental
embedding with retained tiles/routes as obstacles. New edits try deterministic free
positions in rank order, stopping at the first safe embedding with direct routes (across
the gap below the parent, or down the gap beside it from its right port). Beside a parent
of another height the ports do not line up: a new edit is shorter than its parent, which
now shows the expand hint, so the line between them must jog. At the default size the
column gap (16 px) is only the arrowhead's approach, which leaves the jog nothing but the
parent's side; so the positions also include the column that leaves room for it, a side
lane 4 px off the parent plus the approach (20 px). A position only
a detour reaches (round other tiles, through the header or the outer gutters) is kept while
up to 8 more positions adding no height are tried for a direct one: a detour's length and
turns could otherwise make the fresh layout cheaper than the one that holds still, and
opening a branch would move another open branch. Ancestor-relative checks
reject translations that cannot preserve the required anchors before routing them.
Other retained tiles are re-embedded around the anchors (`anchored-repack`) when there is
no fixed warm embedding (the incremental one failed) or it exceeds the compact height
budget; a compact warm embedding keeps its zero displacement. A click that shows nothing
new has the retained geometry itself as its warm embedding: it moves no tile unless the
band exceeds that budget. Re-embedding on every such click was most of the time spent on
slow clicks (folder-seam click p95: mj 15.3 → 4.7 ms, batch8 17.0 → 8.0 ms) and halves
click displacement in the static tours (combinations 16.2 → 9.0 px, mixed 16.2 → 7.2). Its
price is compactness: the budget is relative to the shelves, so a band drawn taller than a
re-embedding would make it stays so until something new arrives. Combinations' static tours
are 4.9% taller on average (10.5% of layouts taller, by 1.6 times at the median), mixed and
observed 1.2–1.3%, the other sources at most 0.7%.
Multi-input arrivals get explicit junctions.
Every route is lane-free: placed segments are indexed with their source, and a route
that would run along another source's segment takes one of a bounded set of alternative
lanes. It also keeps off other sources' ports, corners and curves, and off tiles it does
not leave ([Contacts](#contacts)); a new tile goes only where no line already drawn passes
within `TILE_GRAZE` of it. Blocked source ports use a bounded rectilinear
visibility grid (5,000 expanded points per search, up to 3 fallback slots). Only when nothing is found does a second
chance run: probes on lanes half a step apart, then the grid with columns beside every
foreign lane over up to 16 slots (50,000 points per search). An embedding that cannot be
made lane-free is not offered.
The work is bounded per layout request, not per search: one `IncrementalBudget` serves
every incremental embedding a request tries (the incremental tree and the anchored
repack), with 2,000 probe placements, 200,000 units of plain-fallback grid work and
200,000 of second-chance grid work (a unit is one expanded point, or eight built ones).
A spent pool stops its searches, and the embedding gives way to the full layout. The
budgets trade anchor stability against worst-case time on dense DAG reveals: smaller
pools moved more anchors (for example 50,000 / 50,000 with 250 probes: 23 legal-tour
clicks moved their anchor, against 7 at the chosen budgets, before the crossing cap). Retained geometry spanning
more than 65,536 index rows (about 4 million px) is not indexed: such history is not
used for an incremental embedding.
Only previous visible geometry is retained; no candidate reserves future descendants.
The clicked tile and its visible ancestors have a hard preference among geometry-safe
candidates. Other surviving tiles pay displacement. A direction change must improve
quality by at least 15%, preventing near-tie oscillation. Anchored history may exceed the
compact candidate's height; the decision records that stability exception.

`BandHistory` contains the last accepted raw layout, its exact attached geometry and
attachment context. History is incompatible after a pane width, pin or metrics change, or
a change to any shared image's inputs, order or size; it survives growth (see
[Growth](#growth)). Packing-only updates refresh the accepted geometry without
replanning. History from a superseded scene is never consumed. Normalisation removes
preceding packed-band offsets and reconciles host cover chrome before local scoring.
`decision.fallback` reports `anchor-infeasible` when the bounded candidate family has no
safe anchor-preserving embedding, `anchor-yield` when one exists but the crossing cap
let the anchors move (see [Crossing cap](#crossing-cap)), and `packing-infeasible` when
actual packing cannot keep its allocation. History that is malformed (non-finite
geometry, a route without a string path or endpoints, routes that are not an array) is
treated as no history. These diagnostics describe the constructive search; they do not
prove global infeasibility. Unresolved feasible failures must remain acceptance failures.

`packedGridFlow` keeps covers on their folder columns and creates one shared band per
folder row. It preserves ordered, balanced first-line positions; later groups try skyline
corners and choose the smallest resulting height, then lowest y, then cover displacement.
A candidate must leave an independent vertical cover lane **and** a clear horizontal
corridor into its header. Entire earlier routing rectangles are obstacles, so a shorter
neighbour’s space can be used only when tiles and stems both fit. The rectangles already
include their header and footer; wrapped lines add no extra vertical gap. Existing outer
margins supply bypass lanes first; a small gutter is reserved only when they cannot hold
all independent stems. Covers and ordinary cells retain their logical row/column and x;
only folder rows below an expanded band shift vertically. Active click allocations have
hard x/y reservations when the ordered rectangles and cover corridors can fit. Other
retained groups keep a preferred x; neighbors may move around an active reservation.
An unmeasured newly opened stack reserves its whole row until its first layout arrives.
Its estimated child height cannot certify a safe shared allocation; this prevents a
temporary sideways squeeze of an already committed band.

`STACK_STEM_ROOM` is 34 px: bend tracks and the straight arrow approach, independent
of tile size. Each cover gets a distinct 6 px bend track. Headers grow only when those
tracks need room. No geometry reserves `STACK_CARET_SIZE` or a caret row. `bandExtent`
measures the child/routing footprint without the fixed cover’s horizontal displacement.
`attachPackedBand` moves the subtree as a unit, keeps the cover on its original cell,
and replaces **only** the empty beginning of its outgoing stem. Exact M/L/C path slicing
preserves the engine’s wrapped bypasses, junctions and straight terminal arrow approach.
Header drops avoid other cover columns and assigned bypass gutters. Attachment motion
is keyed by actual drawn geometry, so unchanged routes continue when routing constraints
elsewhere in the row change.

The layout cache includes complete membership, visible items, the exact band width,
pin, metrics, anchor, both history embeddings and attachment context. Workers carry the
same request (including Maps) and run the same pure entry point as the main thread. Open state remains keyed
by cover identity while fresh component ids are resolved from the folder index.

The original spike (`19601c1`, 12 hard cases and 2,700 fuzz layouts) established
that the cover can hang from a fixed grid cell without tile/route collisions or
false parentage. External-parent covers could not be pinned; the badge projection
resolves that case. Centred bands produced long edge-column cover routes; aligning
their rows reduces those detours, but dense narrow graphs can still overflow and
deep chains remain tall (the 20-step fixture is 2,413 px). Lane sharing is an
existing routing limit; it must be measured rather than described as eliminated.

Re-measuring the same four-cell contexts (columns 0/2/3, widths 380/640/1,000,
uniform default tiles, full fixtures) gives **25/2,700** lane-sharing failures
with aligned pinned rows, versus **68/2,700** in the spike and **57/2,700** on
main (`aa22ed6`). Complete cover-to-child lengths include shared trunks,
junction tails and the 8 px arrowhead; cubics are sampled at 60 points. At
640 px with the cover in the last column:

| Hard case | Centred spike | Aligned rows |
|---|---:|---:|
| 24 styled photos | 1,432.6 px | 1,401.1 px |
| Every pair of eight roots | 1,504.3 px | 1,319.0 px |
| Six distant partners | 1,002.7 px | 783.7 px |
| Thirty children | 1,474.0 px | 1,437.2 px |
| 20-step chain (first cover route) | 257.8 px | 34.0 px |

Alignment shortens these cover routes, not necessarily total ink: the every-pair
case grows from 40,329.1 to 42,177.0 px of ink in that context. These measurements
isolate row alignment without badge conversion, so the styled-photo fixture
still contains its shared reference as a tile. Regression fixtures and diagnostics
live under `tests/domain/trace-graph/pinned-*`; the spike renderer is removed.

## Requirements

These requirements come from the [plan](trace-view-plan.md), section 4:

- **Pixel width budget.** Lay out within the measured pane width.
- **Siblings wrap onto several rows.** A display row is not a generation boundary.
- **Direction.** Parents always come before their children: above them or to their left within a shelf; shelf transitions have explicit directional
  arrows and may return to the left (see [Orientation](#orientation)).
- **Junctions.** Multi-parent inputs combine in readable junctions, with one terminal arrow per output.
- **Clean routes.** Routes never cross a tile and do not make long detours along the border.
- **Stable sizes.** Every tile has the same width and image size (`metrics.ts`), whatever the selection or focus; only rows a node always carries (its scope marker, its expansion hint) add height. Decoding, title changes and selection therefore never resize a tile; selection shows in styling only. Only the host's tile-size setting does (see [Tile size](#tile-size)).

## Tile size

Hosts with the SDK's `tileSize` capability report each pane's tile size (`FileViewPane.tileSize`: its preset and thumbnail edge `imagePx`, resolved as their Tiles view resolves it, per-folder override first). `tileMetrics(imagePx)` turns it into the Trace tile: as wide as the host's own tiles, the edge plus 44 px of chrome (92, 108, 140 and 172 px for the 48, 64, 96 and 128 px presets), with the image keeping its 80:51 aspect inside the usual 6 px chrome. The text rows (title, scope, hint) keep their heights. Ordinary cells pass the preset to `ui/file-tile`; its `tileGridMetrics` supplies the allocation and gaps. Hosts without `fileTile` use the original plugin fallback tile in the same grid.

Hosts without the capability (up to v1.11.4) report nothing: Trace draws the default 92 px tile, the same as the smallest preset, and the host's tiles keep their global setting.

The view passes the metrics to `planBandScene`, whose layout request carries the tile sizes and `tileWidth`, so the cache key changes with the setting and a layout of one size is never reused for another. Spacing scales with the tile width (`spacingFor`, never below the default): the gap between tiles, the side margins and the bend room grow in proportion, while the arrowhead, its approach, junction levels, clearances and lanes stay the same. Tiles resize in motion, from the size shown to the new one. Band candidates use the current metrics at every tile size. The layout sweeps run at all four presets.

## Visible nodes

An open stack's band shows what the user expanded, never what is selected (`bandVisibleKeys` in `visibility.ts`; the state lives in `expansion.ts`). The expansion is the user's expand and collapse choices *in order*, and each node follows the latest choice among its *deciders*: its parents in the stack and the reference badges it carries. A band shows:

- every in-folder root (a folder image without a parent in the folder);
- every node whose latest decider chose "expanded" while an expanded decider of it is shown (a parent, or a badge some shown node carries);
- every further parent a shown output needs, so each output keeps all of its inputs.

So for an edit of two images, the latest press of either parent's caret wins: collapsing one hides the edit even though the other was expanded earlier, and expanding either shows it. A parent hidden by an unrelated collapse never takes a child shown through another parent with it, since that other parent still supports it. The rule is monotone in what is shown, so its least fixpoint is well defined, found by one worklist pass, and independent of order. (Taking the latest choice among *shown* parents only, the obvious alternative, is not: showing the child shows all of its parents, which can change which choice is latest.)

Defaults: in-folder roots (the cover among them) are expanded until collapsed, older than any choice; every other node is collapsed until expanded. Opening a stack is a choice like any other: it expands the cover as the latest choice (`openStack`), so the cover's children show, and a later collapse of another parent of one of them (an edit of the cover and of its child) hides it; reopening the stack shows it again. The cover is pinned, so it is never the layout's anchor.

A reference badge's choice belongs to the stack it was pressed in (keyed by the stack's cover node key, `badgeChoiceKey`; never by a component id, which changes when components merge): one style image shared by several stacks opens its consumers only there. A merge that changes the stack's cover forgets it. Every node with children, in any scope (an output saved outside the folder can be edited further), carries the "n edits" hint row, so its size never depends on what is shown. Selection plays no part: the band plan (`planBandScene`) reads no selection, and an unchanged expansion plans the same tiles, so selecting a tile restyles it and moves nothing.

The expansion is pane state (one ordered map of explicit choices by node key, plus the latest 16 pending reveals), saved and restored with the pane's scene, so it survives a refresh. Node keys are stable across component merges, so a merge keeps it. Its order is part of it: the scene compares and signs it in order. Forgetting a choice never changes what is shown: choices of loaded nodes are always kept (the loaded data, which the folder cache bounds, bounds them), and only choices of nodes not loaded are capped. A choice is dropped as gone only when the index cannot place its node in a stack that is not loaded: the node is not a listed file, and every listed stack is loaded and fresh without it. A node that moved to a stack not loaded yet (a split) keeps its choice; choices of nodes not loaded are kept, at most the latest 256 (`pruneExpansion`). Every operation is linear in the component (a 20,000-step chain and a 5,000-child fan are covered in `expansion.test.ts`); a click on a 3,000-member stack (reading the drawn carets, toggling, planning the new ones) takes about 5-9 ms. `expansion-oracle.test.ts` checks these rules by brute force over about 2,000 random small stacks and random action sequences.

`visibleKeys` (focus-derived context: the focus's ancestry, children and up to `SIBLING_LIMIT` nearest siblings) is the legacy section view's rule, kept for `planScene` only.

## Interaction model

Showing and hiding children is always an explicit act, as in a file tree. The rules (`TraceView.svelte`: `activate`, `toggleExpansion`, `activateStack`; pure transitions in `expansion.ts`):

- **A first click on an unselected tile** selects it and opens its children (`expandNode`). It only ever *adds* that node's children: no other branch opens or closes, and nothing moves except to make room. Selecting a leaf, or a node whose children are already open, changes styling only: every tile and connector keeps its exact place on every frame. A leaf records the intent (it shows nothing and is never the layout's anchor), so children it gets later show: an AI edit of the selected image appears under it. Other open branches stay open whatever is selected.
- **A modified click** (Ctrl, Cmd, Shift) only changes the selection; it never expands.
- **A second click on the selected tile** (a plain single click on the node that is the whole selection) toggles its children, once no second click arrives within the double-click window (`DOUBLE_CLICK_MS` = 500 ms, the largest common platform default: Windows' is 500 ms, macOS's about the same, GTK's 400 ms; the webview does not expose the user's setting; `reclick.ts`), as Windows Explorer's slow click to rename does. A double click on the selected tile therefore opens the file and never moves anything. A double click on an *unselected* tile with hidden children opens them at once (its first click is a first click) and also opens the file; this is accepted. Any press within the window, a double click, or a change of pane, folder or selection cancels the pending toggle.
- **The caret** (`[data-node-caret]`, a real button next to the hint) toggles a node's children at once, without changing the selection. It is in the roving tab order like the stack's disclosure; arrow keys pressed on it move between tiles.
- **The caret reads what is shown, and a control never does nothing visible** (`bandCarets`). A caret reads expanded when all of the node's children are shown, whoever showed them; pressing it then collapses, making the node the latest decider of each child, so every child nothing else holds hides. Otherwise it reads collapsed, and pressing it expands, showing every child. A caret is offered on every shown node with children, except where neither changes anything: all children shown, and each held by something else (an in-folder root under a reference input, or an input a shown output needs), its hint reading "n children open". A second click that would change nothing does nothing. Collapsing hides child c when c's rule vertex dominates c in the graph whose reachability from the roots is `bandVisibleKeys` (Cooper, Harvey and Kennedy's dominance algorithm). When several children are held by rules that may hold each other (each an input of an edit the other decides), a search without them decides, within a budget of about two passes over the graph per band; past it (only in dense lattices of edits) such a caret is left out. An offered caret always changes something.
- **A stack's cover** follows the same rules: pressing a closed stack's cover selects it and opens the stack, pressing the selected cover again (after the double-click window) closes it, also while it is still opening, and pressing an open, unselected cover only selects it. The stack's disclosure caret opens or closes the stack without selecting.
- **Collapsing an ancestor of the selection** hides the selected tile; the selection stays (hidden), as a file tree keeps a selection inside a folder it collapses. Nothing else changes. *Decision:* the alternatives (moving the selection to the collapsed node, or refusing to collapse) would make the caret change the selection or not do what it shows.
- **Keyboard navigation** moves the selection between visible tiles only; it never expands or collapses.
- **A selection made outside the view** (the host's file list, Show image, Preview's input links) reveals its node: the ancestors on one path to it count as expanded (`revealNode`, `revealPath`; the path goes through parents and, where a node has none in the stack, through a badge it carries, and picks the oldest when there is a choice, so it never depends on listing order) until the next expansion choice in that stack turns them into explicit choices (`settleReveal`). A reveal expands nothing else and collapses nothing. Reveals whose stacks are not loaded stay pending.
- **A job started from the view** (AI Edit with the view's picks) reveals and expands each input once the host accepts its first job (`expandForOutputs`), opening its stack, so the job's placeholder and output show, also when an input sat in a collapsed branch. A refused job reveals nothing. It goes to the Trace view of the pane the dialog (or the image editor's AI edit tool) was opened from (none when that pane does not show Trace), looked up when the job is accepted, so a view remounted meanwhile still shows it. Reference badges among the inputs are never expanded: an output of badges alone is an in-folder root, shown anyway, and expanding a shared style badge would show its unrelated consumers.
- **Recalled hidden state.** A collapsed node keeps the expansion of its hidden descendants, so expanding it again restores what was open below it.

Motion: an explicit expansion animates. Opening, new tiles slide in from their parent's side and fade in, while the rows below make room; an opening interrupted by another toggle continues its tiles' fade on its own schedule (`continuingFade` in `presentation.ts`) rather than starting it over. Closing, departing tiles collapse with the rows rising into their space and fade in the second half (an accordion; see `docs/scene-transactions.md`, "Closing collapses like an accordion"). A collapse inside a band that holds still shows its children leaving in place, clipped above the rows rising below them. Selection alone is instant and changes no geometry.

Known limit: a generation started elsewhere (another pane, a retry from the host) under a collapsed parent stays hidden until the parent is expanded (its hint count grows).

## Orientation

Bands compare downward layering and width-bounded horizontal shelves as described above.
`planBandScene` bypasses the legacy `orientation.ts` profile rule: the new cost measures
actual candidates. The legacy `planScene` and orientation APIs remain unit-tested.
The cover always leaves downward from its fixed folder cell, regardless of the band’s
orientation. Arrowheads enter tile tops or left sides and keep the same size and approach.

## Spacing

`spacingFor` and `ARROW` in `metrics.ts`; the numbers below are for the default tile (`SPACING`; see [Tile size](#tile-size) for larger ones). Tiles in one generation are `column` = 16 px apart (28 px before; the old gap left graphs looking sparse). That gap is also the lane routes take past a row: 16 px less 6 px clearance either side leaves room for two lanes, and further sources move to the next gap or an outer margin. Running right, the same gap separates the tiles stacked in a column.

Generations are `bandChannel` = 34 px apart (46 px before), and wrapped rows of one generation `rowChannel` = 28 px (34 before). A channel holds only what its routes need, from the row above:

- **Bend room**: three bend tracks (`TRACK_HEIGHT`, 6 px each) between generations, two between wrapped rows. Up to that many crossing sources bend in slices of their own before the channel grows; it grows by a track per further one.
- **Approach** (`approach`, 16 px): a straight stem as long as the arrowhead, then the arrowhead (`ARROW`, 8 × 7 px). Nothing bends here, so every arrowhead lies on a straight segment perpendicular to the tile edge and points the way its line arrives.

The old channel reserved room the routes never used, and its arrowheads were sized in stroke widths (`markerUnits="strokeWidth"`): a highlighted line (2.3 px) drew a 70% larger head than a plain one, whose tip overshot the line's end onto the tile's border, while the curve still turned under it. Arrowheads are now sized in canvas pixels, one size for every line. A terminal route's path ends at its arrowhead's base, `ARROW.length` short of the tile, so its stroke stops where the head begins and the tip lands exactly on the edge. Expansion hints ("2 edits") are part of the tile (`TILE.hint`), so a route leaves below them. Running right, all of this holds along x: columns are 34 px apart.

## ELK spike

We ran `elkjs` 0.9 (layered, `DOWN`, orthogonal routing) with the tile sizes of the time:

- Large tiles (focus and direct neighbours, since removed) were 168×152.
- Small tiles were 92×104; every tile now has this width.
- Spacing matches the production constants.

We tried four layering strategies:

| Fixture (budget) | default | `MIN_WIDTH` | `COFFMAN_GRAHAM` bound 4 | `COFFMAN_GRAHAM` bound 3 |
|---|---|---|---|---|
| 18-child fan-out (700 px) | 3524 px | 3120 px | 2320 px | 2014 px |
| Shared/overlapping input subsets (700 px) | 579 px | 700 px | 632 px | 632 px |
| Random 200-node DAG (900 px) | 8396 px | 10114 px | 6945 px | 6225 px |

The fan-out and random-DAG fixtures overflow the budget under every strategy.

- **Bounds count nodes, not pixels.** ELK's width-bounded layering limits the number of nodes per layer, not the pixel width. Even a bound of 3 left the fan-out nearly three times wider than the pane.
- **Wrapping falsifies generations.** To wrap, ELK pushes siblings into deeper layers. Siblings then appear as later generations, and routes fill with dummy-node bends.
- **ELK has no notion of our junctions.** Combining shared input subsets (`(a,b)` feeding `e`, then joined with `c` to feed `d`) would have to be modelled as extra pseudo-nodes. ELK would then place and space those as if they were images.

**Decision:** keep ELK as a rejected candidate and use a purpose-built engine behind the same adapter boundary. Callers depend only on `layoutGraph(request: LayoutRequest): GraphLayout` (`src/lib/domain/trace-graph/layout.ts`). A different engine can replace it without touching the view: `layout-client.ts` schedules it, the worker runs it, and `TraceGraph.svelte` renders its output.

## Algorithm

The reusable layered algorithm is described top to bottom; a left-to-right shelf is its transpose (see [Orientation](#orientation)).

1. **Bands.** Each node gets a longest-path band (generation), computed iteratively so that deep edit chains cannot exhaust the stack. Bands run top to bottom.
2. **Junction plan.** `junctions.ts` combines inputs before each multi-parent child:
   - Identical input sets reuse one junction.
   - Strict shared subsets nest, e.g. `(a,b)` → `e`, and `(a,b)+c` → `d`.
   - Partially overlapping sets stay distinct.
   - A junction never implies an extra parent.
   - Each route carries the underlying parent→child pairs ("consumers"), used for highlighting and tests.
   - Junction IDs derive from their sorted parents, so they are stable across relayouts.
3. **Ordering.** Band 0 is sorted by the ordering hint (the previous reading order, so siblings stay put across focus changes), then by creation order. Each later band is sorted by the barycenter of its parents in reading order (row first, then x). Children therefore stay near their parents even when the parent row wrapped.
4. **Balanced wrapping.** `wrapRow` uses the smallest row bound that needs no more rows than a greedy fill at the budget, found by binary search. This keeps the last row from being a lone straggler. Each row is centered.
5. **Channels.** Rows are separated by tile-free channels: `rowChannel` within a band (wrapped rows), `bandChannel` between bands (see [Spacing](#spacing)). Each ends in the `approach`, where nothing bends. A channel that holds junctions is divided into **zones** by junction levels: zone *i* lies between levels *i* and *i+1*. Each level adds `junctionLevel` (its dot's berths and 14 px to the next level); the bend room either side of the levels is split evenly (16 px above the first level and 16 below the last, before the approach). A zone grows when more tracks (below) cross it than fit.
6. **Junction placement.** A junction sits in the channel below its deepest parent's band. Its minimum level follows its nesting; its x prefers a point between its parents and its consumers, and is found by an interval search (`nearestFree`), not a pixel scan. Placement runs in two passes:
   - **Before lanes**, a junction takes the nearest x, at the shallowest level with room, that keeps `junctionSpacing` from junctions on its level, stays off every other junction's column in its channel (a dot above another would put one's routes through the other), and avoids every vertical run other routes *may* take: tile centres and gaps of the rows above and below, and both outer margins. It may sit on a parent's exit only if that parent feeds nothing else, and on its consumers' entries.
   - **After lanes**, the junctions that found no such x (and those nesting one) are placed against the runs routes *actually* take: lane positions, tile exits that carry routes and arrow entries. Routes to and from them are re-anchored to their final spot. If even that leaves no column of its own, the junction asks for room in the nearer margin and the canvas widens on the next pass (up to two extra view widths); only past that may dots share a column, and same-level spacing always holds.
7. **Routes.**
   - A route leaves the bottom centre of its source and enters the top centre of its target, which carries the arrow: the path stops `ARROW.length` above the tile, after a straight vertical stem at least as long, and the arrowhead spans the rest.
   - **Lanes.** Intermediate rows are passed through a gap between tiles or an outer margin, chosen closest to the target. A lane slot is keyed by geometry (left margin, the gap between two x positions, right margin), so slots from different rows that line up are the same slot.
     - Routes from one source share a lane per slot; different sources get distinct lanes, ordered by source x, spread evenly and at least `MIN_LANE` apart inside the slot's clearance. A full gap sends further sources to the next-best gap.
     - Each outer margin is one slot for the whole graph, with unlimited capacity. A source keeps one x in it, just outside the rows it passes there, and stays at least `MIN_LANE` (preferably `lane`) from every other source whose rows, with the channel either side, overlap its own. Inner sources are placed first and nearest the tiles, which avoids most crossings. Lanes take the roomier `lane` spacing when all of a margin's lanes fit the canvas that way, and otherwise `MIN_LANE`. Two sources therefore never meet in a margin, whichever rows they pass, while sources at different heights reuse the same room.
     - When margin lanes or junctions need more room than a margin has, `layoutGraph` reruns the pass with that margin widened by the measured shortfall (at most twice). Lanes are placed relative to the tiles, so one retry fits them exactly; nothing is drawn off the canvas. The graph widens and scrolls horizontally instead of merging lanes.
     - How often this happens depends on how many independent lines must pass the same rows. Graphs whose parents sit close by rarely widen (3 of 900 random graphs, by at most 3%). Graphs that keep reusing a few inputs across many wrapped rows widen in narrow panes: one style applied to 24 photos at 384 px grows by about 20–30%, to 32 photos by about 60%, and the width can change with the selection. The alternative, merging lanes, would hide which input reaches which output.
   - **Shared courses (trie).** The rows a source's routes cross form a trie per source: routes heading to the same place share a prefix of crossings, and each crossing is claimed once per source (memoised). A stretch shared by several routes is emitted once as a **trunk** route (`to === from`, never terminal, its consumers the union of the routes it carries, id: its source and a hash of the consumers it carries). Each route then starts where it branches off; chains follow `continuation`. A fan-out of n children across r rows therefore draws O(n + r) path data instead of O(n·r).
   - **Zone choice.** Each channel crossing bends inside one zone and runs vertically outside it. The zone is chosen cheapest first, in strict priority:
     1. fewest vertical runs along another source's run on the same column (a shared lane; two inputs of one junction running down its column count too, since inputs may meet only at the dot);
     2. fewest runs that touch a junction the route does not belong to (within `JUNCTION_BERTH`);
     3. fewest runs near another source's run;
     4. most room.

     Evaluation stops at the first zone with no contact. A second pass re-evaluates every choice against the final set, so the result does not depend on processing order.
   - **Tracks.** Within a zone, bends from different sources get distinct heights by left-edge channel routing:
     - leftward bends are ordered by target x ascending, then rightward bends by target x descending, so parallel routes never cross;
     - a bend leaving a column precedes one arriving in it, so a route never turns into a lane another is still using;
     - two bends that swap columns form a unit. In slices one after the other, one would leave a column exactly where the other arrives, and each line would seem to continue as the other. Swaps up to `CROSSING_SWAP` (9 px) wide cross in one shared slice twice as tall, steeply enough to read as a crossing; wider ones take a dogleg (Deutsch 1976; Yoshimura and Kuh 1982): one bend first curves to a free column between the two in a slice of its own, runs down it across the other's curve, and curves on in a third. With no free column they keep consecutive tracks, the bend leaving a column exactly where the other arrives turning first;
     - constraints are sequenced topologically, then tracks are assigned by longest path. A cycle of constraints (three or more bends, each leaving a column beside where the next arrives) is broken by a dogleg too, as ELK's orthogonal router splits a segment of a critical cycle: one bend of the cycle first curves to a free column, before the bends arriving beside its own, and curves on later. Only a cycle whose every bend belongs to a swap or ends in a junction's fan-in is still broken in sort order. A zone used by a single source needs no tracks;
     - with neighbours, an S-curve keeps half of `LANE_SEPARATION` inside either edge of its slice, running vertically there: curves in neighbouring slices would otherwise converge where one ends and the next begins;
     - a channel whose first zone holds a bend passing under another source's port starts that zone's tracks `PORT_BERTH` below the row: crossing a stem right under its tile, the stem seems to branch off the passing line.
   - **Fan-in.** Inputs of one junction meet only at its dot. Each bending input ends its S-curve up to `FAN_IN` (3 px) to its own side of the junction's column, runs down to the top of the dot's berth, and reaches the dot along a short S-curve that ends vertically (routes stay orthogonal apart from their curves). On each side, nearer inputs keep closer to the column, so inputs from one side do not cross before the dot. The offsets stay inside the berth that other routes and junctions keep from the column, and within half of what the nearest other dot's column on that side leaves beyond `LANE_SEPARATION`, so two dots' inputs never fan into one line. Without this, two inputs bending onto the column would share its last stretch.
   - **Vertical pass.** Zone heights become `max(default, tracks × TRACK_HEIGHT)`; junction y is the previous zone's bottom plus `JUNCTION_BERTH`. Paths are emitted last: vertical run, S-curve inside the route's track slice of the zone, vertical run (through the approach, into a tile).
   - **Guarantees.** Fuzz tests in `tests/domain/trace-graph/layout.test.ts` (60 random graphs at 380, 640 and 1,000 px top to bottom and once left to right, 30 mixed-size graphs in both orientations, plus targeted cases) check that:
     - no route passes within 5 px of a foreign junction;
     - no two junctions overlap;
     - routes from different sources never share a vertical lane;
     - routes never cross a tile;
     - every child's drawn sources are exactly its parents (trunks included);
     - route ids are unique;
     - every tile, junction and route point lies on the canvas;
     - parents come before their children along the flow;
     - every route into a tile ends in a straight segment perpendicular to the tile's edge, at least `ARROW.length` long, stopping `ARROW.length` short of the edge's middle;
     - every channel is at least the approach plus one bend track, at most its default plus `junctionLevel` per level plus a track per crossing route in each zone, and exactly its default when it holds no junctions and no more crossing routes than its bend room has tracks;
     - the graph stays within 5% of the width it was given (top to bottom; the engine has no width budget running left to right, so `orientation.test.ts` checks the same 5% for the left-to-right layouts the rule picks).

     Targeted tests cover crowded channels: every pair of a dozen inputs combined, sixty sources combined with a few tiles each, one style applied to many photos, and many sources passing one gap.
   - **Route ids** are unique and stable. A route is named by its endpoints; a trunk by its source and a hash of the consumers it carries, not by where it runs, so it keeps its id when a relayout moves it. (Collisions get a deterministic suffix.)
   - **Known limits.**
     - Bend order inside a zone follows "leave a column before another route arrives in it". A cycle of those constraints takes a dogleg (above) unless every bend in it belongs to a swap or a fan-in; then one is broken and two routes briefly run within `LANE_SEPARATION`. Cycles occur in about 1% of fresh downward layouts of the merge-heavy profiles (1.6% of `mj`'s); doglegs resolve all but one session's (8 of 924 `mj` layouts), and lane sharing in the raw-engine fuzz fell from 6 of 2,700 to 0. Moving one bend of the cycle to a neighbouring zone was tried and rejected: it created a longer shared stretch elsewhere. The band engine treats such a layout as infeasible (see [shared lanes](#shared-lanes)), so another candidate is shown instead.
     - Past two extra view widths, junctions in an extremely crowded channel (over a hundred combinations in one generation, sooner in narrow panes) may share a column, and their routes can then meet. Even below that, in very crowded channels a tile's exit can line up with another tile's entry; the bend zones cannot always separate the routes using that column. Every pair of 20 inputs at 300 px still shows this.
     - Neither hides parentage: highlighting a node shows its exact lineage.
8. **Tie-breaks.** Ties use one total order: hinted keys keep their previous relative order, and new keys merge in by creation order. This keeps sorting transitive and independent of input order.
9. **Navigation.** `gridNeighbor` uses logical cell and committed band rectangles, including virtualized rows. The cross axis is weighted 3×; Home/End use visual order. A roving tab stop spans ordinary entries, covers and band tiles. Selection forwards the original modifiers to the host, including Shift ranges; unlisted picks keep the established Preview/AI-input rules.

## Performance

- **Stages.** Bands, ordering, wrapping and junction placement are near-linear in the shown tiles (consumers are indexed once; junction lookups are bucketed by x). Routing is proportional to the crossings drawn: per-row gap lists are cached, vertical runs are bucketed by x and source, and the trie claims each crossing once per source. It is not linear in general. A graph where many independent sources each reach many distant rows costs about sources × rows; the view's limited context (only what the user expanded) normally keeps such graphs from reaching layout. The hidden-descendant hints traverse only hidden nodes and stop at 999.
- **Measured** (one thread, `bun`, layout only, 900–1,100 px):

  | Graph | Size | Time |
  |---|---|---|
  | fan-out | 750 / 1,500 / 3,000 / 6,000 children | 55 / 107 / 340 / 1,382 ms |
  | one style applied to n photos | 100 / 200 / 400 / 800 | 88 / 136 / 441 / 1,449 ms |
  | edit chain where every step also takes the root | 1,000 / 2,000 | 369 ms / 1.5 s |
  | fan-out where every child also has a child taking the root | 500 / 1,000 / 2,000 | 0.6 / 2.5 / 10.7 s (worst case above) |

  A layout that widens runs the pass again (at most three passes in all). Placing margin lanes costs about S² log S for S sources sharing a margin, within the sources × rows bound above.

- **Benchmarks.** `tests/domain/trace-graph/scale.test.ts` covers a 20,000-step edit chain focused at its end, a 3,000-output fan-out, the same two laid out left to right (transposing adds a linear pass), and a 10,000-image folder made of 500 components. Choosing the orientation is linear in the component's size, apart from the junction estimate, which is computed only for components that pass the cheap checks and exactly only for up to 200 multi-input outputs (800 inputs). It is cached per component, so focus changes reuse it. A benchmark covers 200 outputs of 20 inputs each (the estimate is skipped) and a 96-image component whose estimate runs exactly. A 1,000-child fan-out test bounds the path data (under 250 KB; it was 10.7 MB before trunks).
- **Folder seam.** Growth and click tours of every workflow-shape source through the folder
  engine, as the view calls it (`engines.default`; five pane widths, four tile sizes, three
  cover columns; one thread, `bun`, machine load 3–4). Per request in ms, `main` (e0666c6) →
  this branch:

  | Source | Requests | p50 | p95 | p99 | max | over 16 ms |
  |---|---:|---:|---:|---:|---:|---:|
  | real | 3,192 | 0.14 → 0.15 | 0.69 → 0.77 | 1.3 → 1.7 | 7.5 → 13.4 | 0 → 0 |
  | observed | 14,250 | 0.17 → 0.22 | 0.51 → 0.61 | 0.8 → 1.2 | 13.3 → 13.0 | 0 → 0 |
  | variations | 27,645 | 0.46 → 0.64 | 1.59 → 2.08 | 2.8 → 3.8 | 13.7 → 16.9 | 0 → 1 |
  | chains | 37,848 | 0.25 → 0.29 | 0.77 → 0.87 | 1.7 → 1.9 | 34.6 → 15.8 | 2 → 0 |
  | combinations | 43,890 | 0.44 → 0.55 | 1.78 → 3.05 | 3.0 → 5.2 | 11.6 → 20.6 | 0 → 6 |
  | mixed | 34,941 | 0.37 → 0.48 | 1.37 → 1.68 | 2.3 → 3.1 | 17.3 → 12.7 | 1 → 0 |
  | mj | 29,184 | 0.74 → 0.91 | 3.44 → 4.99 | 6.7 → 12.7 | 54 → 84 | 44 → 187 |
  | merge-k8 | 56,829 | 0.73 → 0.93 | 3.16 → 5.46 | 5.1 → 10.6 | 21 → 77 | 2 → 193 |
  | batch8 | 23,142 | 0.86 → 1.16 | 5.98 → 7.03 | 16.5 → 17.1 | 87 → 344 | 240 → 254 |

  The tail grew on the merge- and batch-heavy profiles, which stretch the product's limits.
  The contact rules turn down more wirings, so a request wires more probes and checks more
  routes for each (mj clicks: 1.6 times the probes, 2.6 times the conflict checks), and more
  tiles reach the second chance. The incremental budget counts probes and grid work, not the
  checks, so it bounds the count but not the time. The slowest request (batch8, a click at
  1,400 px with 128 px images: 1,058 probes and 154,000 second-chance units, about half the
  time in the finer probes) takes 344 ms where `main` takes 11 ms, and finds a band 311 px
  shorter with 24 more crossings. Charging conflict checks to the budget would bound the
  time, at the cost of ending the heaviest embeddings sooner; it is not done.

  Planning each input once, dropping the whole-input memo and sending the previous layout
  to the worker by reference (`layout-protocol.ts`) leave every output unchanged. The table
  below covers the whole seam as the view runs it: dispatch, client and worker store,
  structured clones both ways. Runs were interleaved per source; ms per request, before →
  after.

  | Source | main-thread p50 | main-thread p95 | worker p50 | worker p95 |
  |---|---:|---:|---:|---:|
  | mixed | 1.05 → 0.48 | 2.57 → 1.45 | 4.40 → 2.51 | 7.06 → 4.40 |
  | merge-k8 | 0.95 → 0.49 | 2.43 → 1.81 | 4.38 → 2.95 | 10.07 → 8.29 |
  | batch8 | 0.60 → 0.35 | 2.14 → 1.60 | 4.97 → 3.37 | 14.32 → 12.69 |

  On mj, measured more than two hours apart on a shared machine, the main-thread p50 fell
  0.92 → 0.66 and the p95 rose 3.32 → 3.91.
- **Off-thread.** A synchronous request has a budget of 30 current plus committed-history tiles and 40 current input edges plus committed-history routes. Requests above either budget run in a blob worker when the host announces `blobWorkers` (its CSP permits `worker-src blob:`), and otherwise on the main thread after yielding a frame. Hidden lineage does not consume placement slots or this geometry budget. Results are cached by their exact request including both committed embeddings and attachment, except that a non-band left-to-right request ignores pane width. The worker gets one job at a time, so a request superseded while it waits is dropped rather than computed; one already running finishes and is cached.
- **Rendering.** Tiles outside the viewport (±800 px) are not mounted once a component shows more than 120 tiles; connectors and junctions are windowed the same way by their vertical extent. Grid rows and bands beyond a 1,200 px viewport margin are windowed; their logical geometry remains allocated. Closed stacks need only summaries. Open nearby bands load through the existing complete per-component paging and request scheduler. Focused bands stay mounted so keyboard and job reveals can finish even from offscreen.

## Motion

`motion.ts` captures the displayed geometry before a commit and animates for 160 ms from there. The captured geometry includes any transition still in progress, so interrupted selections continue smoothly. Tile sizes never depend on the selection, so a selection change only moves, adds and removes things. The transitions are:

- tile translate (tiles that did not move are not animated);
- junction positions;
- route `d` morphs; new routes are displaced to follow their endpoints and fade in to their own (possibly dimmed) opacity;
- departures: tiles, connectors and junctions that leave fade out where they were displayed;
- band reveal clips and vertical movement of whole later stacks/ordinary cells;
- cover fan rotation/opacity, and route-following tile emergence with reversed departure;
- tile styling (selection border, focus ring, lineage dimming) by short CSS transitions.

Rules:

- **Measure, then animate.** Playback measures the whole new layout before starting any animation. The canvas size animation re-centres the canvas, so measuring after it starts would offset every tile by half the width change.
- **Pure path sampling.** Connectors are resampled from their path strings (`path-sampling.ts`, using the animated computed `d` when interrupted), never with `getPointAtLength`. Above 300 connectors they snap instead of morphing.
- **Engine support.** Engines without CSS `d` animation (WebKit) snap existing connectors, fade in only connectors that are new, and do not move junction dots either, so a dot never slides while its connectors have snapped. A connector shown without a captured shape (the previous graph exceeded the morph limit) snaps rather than morphing from a guess.
- **Regrouped connectors.** A connector new in this commit takes over one that vanished from the same source (a trunk regrouped by a relayout, say), nearest shape first: it morphs from that shape (and from its opacity, should lineage dimming differ), or simply appears where shapes do not morph, instead of fading in. Only connectors beyond those that vanished fade in.
- **Departures.** A tile, connector or junction that leaves is copied (without its identifying attributes, so it is never mistaken for content) into a ghost layer that Svelte renders empty (`[data-motion-ghosts]`: a `div` under the tiles, an SVG `g` under the connectors), placed where it was displayed, faded out and removed. A connector that hands its shape to a successor morphs instead of leaving. An interruption carries a copy still fading over from its displayed opacity; if its original returns instead (a quick reselection), the copy is dropped and the original moves and fades in from the copy's displayed place and opacity, so nothing shows twice. Connector and junction copies need shape morphing (they would otherwise fade at a spot their successors have already left); past 200 departures at once they simply vanish.
- **Unchanged connectors** keep their exact curve: a connector whose shape did not change is not morphed (morphing runs on a sampled polyline, which would wobble it).
- **Superseded commits.** When two commits land before one render, only the later one plays.
- **Opacity.** Keyframes never set an existing element's opacity, so lineage dimming (a class) holds throughout. The exception is an element caught mid fade-in: its displayed opacity is captured and the fade continues from there, so an interruption never flashes it.
- **Scroll anchoring.** Modeled on [CSS Scroll Anchoring](https://drafts.csswg.org/css-scroll-anchoring/): capture an element and its viewport offset, then compensate its displacement.
  - *Hold* (pointer selection): capture synchronously before selection changes, including before a worker layout starts. Every graph commit and stack toggle compensates the clicked tile; one frame loop samples all finite view animations while they run. Idle motion keeps the anchor without a frame or settlement promise. A new selection replaces it; user scrolling, removal, unmount or a clamped adjustment releases it and tears down its listeners, observer and frame.
  - *Reveal* (keyboard and programmatic focus, including the Preview pane's inputs): once motion settles, the focused tile is scrolled into view by the smallest amount (`nearest`).
  - Other bands’ relayouts compensate the active hold too. Wheel, touch, scrolling keys, scrollbar presses and scroll changes other than the hold's own adjustments release it. Modifier keys and band content clicks preserve it. Band bodies never become vertically scrollable mid-motion, so a wheel always reaches the view.
- **Mounting** commits exactly once.
- **Reduced motion** skips animation; committed layout still compensates an active anchor.

Opening and closing share bounded route samples, indexed once per transition.
Closing trims travel at the displayed progress; reopening continues along the
remaining route and retains opacity. Grid snapshots include the viewport origin
so bottom-band scroll clamping does not jump the first frame. A reveal readiness
notification never replays a mounted band’s emergence.

## Compact-band regressions (#67, #70)

The browser fixtures use the same folder index projection as the normal harness. At
1150 px with large host tiles (seven columns), the column-six cover has two children,
two grandchildren and one great-grandchild. Its band measured 543 px before the change
and 312 px after. At 625 px with xlarge host tiles (three columns), two two-child stacks
in columns one and three measured 472 px before and 360 px after. Headless Chromium
checks tile and connector clearance, exact parent origins, arrow tips, cover-row stability,
and focus/width stability; screenshots are saved outside the repository.

Research informing the adapter: [pixel-width Coffman–Graham layering](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/gd2007-glee.pdf),
[non-layered tidy-tree contours](https://ir.cwi.nl/pub/21856/21856B.pdf), and
[disconnected rectangle packing](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-rectpacking.html).
Width-bounded layering alone cannot shorten a precedence chain; transposing and wrapping
columns can. Tidy-tree research motivates retaining local order and subtree coordinates; the existing
layered engine supplies ordering, while a separate packing stage fits independent stacks
into the row. Explicit ports and lane reservations keep
those compaction steps from falsifying parentage.

## Growth

An edit adds outputs; an image's inputs never change. So a component's history survives
images arriving or leaving (`band-history.ts`), the way North's DynaDAG (1995) inserts new
nodes into the previous drawing instead of recomputing it. Before, any membership change
expired the history and each arriving output relaid the band, moving the selected input in
24–68% of arrivals, by up to 1,000+ px.

- History stays compatible when the frame (pane width, tile size, pinned cover) and every
  shared image's order, inputs and size match. The one size change allowed is the expansion
  hint, by exactly its height (16 px): a tile's first output adds it, and its last output
  leaving (a failed or dismissed placeholder, a discard) takes it away. Any other change of
  height (a scope flip, say) lays the band out afresh. The tile is resized in place
  (`resizedLayout`), a cut-and-stretch step as in incremental orthogonal drawing (Papakostas
  and Tollis 1998): everything below a horizontal cut moves rigidly, and connectors crossing
  the cut stretch along their vertical runs.
  - Tiles one above the other keep their gap, less only room the layout leaves spare: room
    beside a taller neighbour in the tile's row (the channel under the row stays), and, running
    right, room beyond the stack gap between the tiles of one column of a shelf.
  - Growing, the cut is the first line under the tile that crosses no tile, and things below it
    move down by what the tile and the gaps under it need: nothing, when a taller neighbour
    already gives its row the room, or a shrink left room in its column. If that cut would leave
    a tile of the tile's column in place too close under it, or bring a connector within 2 px of
    the tile (closer than it was), the cut is right under the tile instead, and the neighbours
    it passes stay. A connector leaving a staying tile's lower edge on the cut keeps its start
    and bridges down to what moved.
  - Shrinking, things below the cut move back up as far as the freed space allows, and no
    further than any tile's gap to the tile above it in its column allows: running right, a
    column beside the tile does not rise because the tile shrank. Otherwise the space stays,
    and the next growth reuses it, so repeated failed edits never drift.
  - Running right, a connector arriving at the tile's left side follows its new centre; if
    that would run it along another source's line, it steps across one arrow length before
    the tile instead.
  - Every connector must meet its tiles where it did. When no cut manages that (a neighbour's
    side port below the cut, a step that would run along the edge of the tile it leaves),
    the band is laid out again, holding its tiles where the resize would have put them
    (`resizedTiles`): the committed geometry without its connectors is never kept as it is.
  - When only hints changed, the committed layout shares no lane, and the resized geometry
    passes every hard gate, it is kept as it is (decision `resized-visible`): an output
    arriving out of sight moves tiles only straight down (by the hint, at most, per tile that
    grew), and one leaving only straight up.
- When the component grew, anchors yield (`anchor-yield`) if holding them makes the band
  more than `anchorHeightRatio` (1.5) times taller than the best unanchored layout: a chain
  growing below a held column must still wrap. A click on an unchanged component never
  yields to height; there the band only shows more of what was already there.
- The selected input still moves in two cases: a flagged yield, or the growth push, where
  a merge's other input above it gains its first output and grows (16 px at the default
  size). `layout-properties.test.ts` admits exactly these.

The phase 3 policy (#79) stays registered as the `phase3` engine (`BAND_PHASE3`) for A/B.

## Workflow shapes

What the layout must handle, from the product's limits and public raw data. The user's one real
folder is a sanity check, not a prior: it holds 22 runs.

- **Product limits.** An edit takes one to eight equal, ordered inputs (`MAX_IMAGE_INPUTS`). A
  prompt makes one to eight outputs, each its own run in one batch. An input from outside the
  folder is a reference badge, not a route, and a shared reference does not join components.
  A retry resubmits the same inputs as a new run, adding siblings.
- **The real folder** (22 runs over 11 days): 21 single-input edits and one two-input edit
  (which failed), no batches, at most three runs per image, depth at most three. Merge rate
  1 of 22 (95% interval 0.1–23%); batches 0 of 22 (under 13%).
- **Midjourney** (vivym/midjourney-messages, three shards, 3.0 M bot messages, March–August
  2023, jobs linked by user and prompt). 13.6–16.2% of new jobs are image-conditioned, and
  16–23% of those combine several images (pooled 19%). Inputs per combination: 2 (69%),
  3 (17%), 4 (7%), 5 (5%), 6 (1%), 7 (0.7%), 8 or more (1.2%). Half of all image-prompt uses
  reuse a link the same user used before. Runs per varied image: one 60%, two 23%, three 9%,
  four 4%, five to eight 3%, more 0.5% (at most 38). Every job makes a batch of four; 51–62%
  of continued grids continue one image. 16–18% of lineages have a derived run; among them,
  depth 1 is 57–61%, 2 is 22%, 3 is 8–9%, 4–9 is 9–10%, and 10 or more about 1% (an upper
  bound: linking to the latest job turns siblings into chains).
- **DiffusionDB** (2M subset): sessions split at 30-minute gaps have a median of five
  commands (as in Xie et al. 2023), and same-prompt reruns, the retry analogue, are 15.8% of
  in-session commands. Batches are not recoverable: the subset keeps about one image per
  prompt.
- **Not available**: public lineage data for instruction-based editing. MagicBrush and
  similar sets are annotator-designed edit chains, not user sessions.

Midjourney is a different tool, so its frequencies are an analogue, not a measurement of
this product's users. The generative model (`layout-eval/provenance-model.ts`) therefore
spans the range instead of fitting one point: `mj` uses Midjourney's frequencies, `merge-k8`
and `batch8` push merges and batches to the product's limits, and `variations`, `chains`,
`combinations` and `mixed` stretch one dimension each. Results are reported per profile, and
defects are ranked by severity at the worst plausible frequency.

## Optimality gap

How far the engine is from optimal on the criteria that matter, measured against exact and
reference oracles. Scripts and raw results live outside the repository (the study's work
directory); the method is reproducible from this description.

**Sources, reported separately.** The user's one real folder (25 images, all trees, fan-out
≤ 3, depth ≤ 3; topology only, never committed) is a check on shape only. A seeded
generative model (`layout-eval/provenance-model.ts`) supplies the statistics: its `observed`
profile brackets the real folder on all eight shape measures over 300 seeds; `variations`,
`chains`, `combinations` and `mixed` deliberately stretch fan width, depth and merges. The
existing corpus and 160 North DAGs (10–99 nodes) complete the set.

**Oracles.**
- *Metric agreement.* An independent implementation (shapely) matches production crossings
  on 3,090 of 3,109 layouts (the rest differ by ≤ 0.24%, all on one 10⁴-crossing case) and
  height to a constant 14 px bottom margin.
- *Exact crossing optimum.* A Jünger–Mutzel ILP (CP-SAT) with the drawing's own display rows
  as layers: tiles stay in their rows, everything else is free; a second model also fixes
  our tile order, leaving only passing positions free. Trees need no solver: they are level
  planar, so their optimum is 0.
- *Reference engines.* Graphviz `dot` and ELK Layered (also with Coffman–Graham width-bounded
  layering) on the same graphs, tile sizes and gaps, scored by the same independent code.

**Results** (static click tours unless noted; ours is this engine).

| Source | Arrival: input moved (`main` → now) | X ours | X dot / ELK where they fit | Tree layouts crossing (optimum 0) |
|---|---|---:|---:|---:|
| real | 122 → 0 of 513 | 0.01 | 0 / 0 | 1.3% |
| observed | 1,977 → 51 of 3,021 | 0.01 | 0 / 0 | 1.1% |
| variations | 3,027 → 67 of 8,721 | 1.64 | 0.08 / 0.09 | 21% |
| chains | 5,714 → 28 of 12,483 | 0.15 | 0 / 0 | 1.5% |
| combinations | 4,745 → 338 of 16,074 | 9.5 | 0.26 / 0.30 | 2.5% |
| mixed | 3,541 → 174 of 12,198 | 1.65 | 0.03 / 0 | 8.3% |
| mj | 2,151 → 570 of 9,519 | 6.6 | – | 5.4% |
| merge-k8 | 8,533 → 243 of 23,997 | 53.0 | – | 0.5% |
| batch8 | 2,150 → 103 of 6,498 | 2.6 | – | 26% |
| corpus | 36,211 → 647 of 71,706 | 331 | 0.32 / 0.27 | 39% |
| North | (static only) | 177 | 4.8 / 4.5 | 65% |

Arrivals are the folder-seam growth tours ([Performance](#performance)); crossings and tree
shares the static click tours, where a tree layout is one whose visible tiles each have at
most one visible input. On the folder seam, clicks keep their anchor better than on `main`
everywhere (corpus: 23 → 3 of 9,747 clicks) and move other tiles less on every workflow
source (observed 10.7 → 7.8 px mean, mj 28.9 → 21.8), except the corpus's dense random DAGs:
there an anchored embedding that keeps every contact out fails more often, and the click is
laid out afresh around its anchor (corpus mean 36.7 → 46.1 px).

The references cannot wrap a generation, so on the DAG sources they overflow the pane in
45–80% of layouts; where they fit, ours is 30–60% shorter (chains: 560 vs 1,242 px) but
crosses more. Their latency is 7–22 ms at p50 (ours 1–3 ms).

On downward layouts of merge-heavy sources, standard layered crossings κ against the exact
optimum (both proven): combinations 7,692 vs 151 (625 with our tile order fixed), mixed
999 vs 0 (68), North 38,446 vs 1,601 (3,801). Better generation orders barely help (median
sweep −1 to −14%, with sibling inversions), and injecting the optimal tile orders does not
realise the optimum. The gap is in how routes pass the rows between their ends.

**Passing routes.** A route into a tile passing a row takes the open gap nearest the
straight line from its source to the centroid of the ends its source's routes still passing
that row head for (`Passing: "straight"`: the usual placement of a long edge's dummy nodes,
bundled so a fan keeps one trunk). Lanes in a gap are ordered by where those lines cross
it, and gaps whose every x meets another source's stem are skipped. Against the previous
rule (nearest the end at every row): crossings −15% (variations), −8% (mixed), −5%
(combinations), −0.4% (North), unchanged on real, chains and the corpus (+0.2%); shared
lanes in the raw-engine fuzz 57 → 6 of 2,700. Straight lines per route, unbundled, split
fans at their first row: corpus crossings +3.5%, mostly in wide wrapped trees.
Routes into junctions keep the old rule: on straight lines they cut North crossings by 10%
but, in crowded junction channels, routes passed within 5 px of a foreign dot in 11–13 of
800 stress layouts instead of 7, and a route that seems to join a dot misstates provenance.

#### Contacts

Lines of different sources that touch read as joined, which states a parentage the folder
does not have. That is worse than a crossing, so it ranks first among the defects. An
independent check (shapely, no production code) finds four kinds:
- a *join*: one line's corner or end within 3 px of another source's line, or a line passing
  within 3 px of a port (one seems to branch off the other);
- a *shallow* crossing (counted as a join): two lines within 3 px of each other for more than
  8 px beyond the crossing, below about 24°;
- a *crossing at a corner*: a crossing within 3 px of a turn or fork of either line. It reads
  as touching and parting, but both lines visibly go on, so it ranks below a join;
- a *border run*: a connector within 1 px of the outline of a tile it neither leaves nor
  enters, for more than 8 px. It reads as part of that tile.

Near lanes, the parallel case, are gated ([Shared lanes](#shared-lanes)). The rules
(`route-contacts.ts`) follow the spacing that orthogonal routers keep for the same reason
(ELK's `spacing.edgeEdge` and `spacing.edgeNode`; libavoid's shape buffer and nudging
distance), and the finding that small crossing angles cause misreading (Huang, Hong and
Eades 2008):
- other sources keep `PORT_BERTH` (6 px) off a route's ports and `CORNER_BERTH` (3 px) off its
  corners and free ends;
- no route runs within `LANE_SEPARATION` of another source's curve for more than `SHALLOW_RUN`
  (14 px);
- a route keeps `TILE_GRAZE` (2 px) from every tile except along the run leaving its own;
- the downward router keeps these through its tracks: port berths, insets, steep swaps and
  doglegs ([Algorithm](#algorithm)).

The incremental embedding keeps shallow runs and grazes out always: a route leaves its tile
only along a run heading away from it (never down the tile's own border), and a tile it
places keeps `TILE_GRAZE` from every line already drawn, as routes keep it from tiles placed
before them. Beside a taller parent, where the column gap would leave the jog between their
ports only the parent's side, the next column leaves room for it ([Algorithm](#algorithm)):
without it the new edit went to the row's far end and the next arrival re-laid the band
(observed growth: the image being edited moved on 229 of 3,021 arrivals, now 51; chains
522 → 28 of 12,483). Ports and corners it keeps out whenever some placement avoids them, at any
height; only then does it take a touching route. Routing round other lines the long way made the fresh layout cheaper than the
held one, so a direct route at the same height comes first (above).

Layouts with each defect, before (`r-base`: this engine before the contact rules) and after,
over the static tours:

| Source | Layouts | Joins | Crossing at a corner | Border runs | Height |
|---|---:|---:|---:|---:|---:|
| real | 1,720 | 0.6% → 0 | 0.9% → 0 | 1.5% → 0 | 197 → 197 |
| observed | 2,400 | 1.0% → 0.04% | 1.0% → 0.2% | 0.04% → 0 | 228 → 232 |
| variations | 3,100 | 22% → 1.5% | 25% → 11% | 13% → 0 | 689 → 732 |
| chains | 4,040 | 9.3% → 0.4% | 8.8% → 0 | 2.4% → 0 | 439 → 448 |
| combinations | 3,640 | 38% → 3.7% | 56% → 41% | 11% → 0 | 981 → 1,097 |
| mixed | 3,200 | 27% → 1.5% | 28% → 6.5% | 8.6% → 0 | 742 → 811 |
| mj | 3,080 | 23% → 0.9% | 38% → 28% | 8.2% → 0 | 1,496 → 1,509 |
| merge-k8 | 2,800 | 61% → 9.1% | 86% → 83% | 11% → 0 | 2,095 → 2,162 |
| batch8 | 3,080 | 12% → 0.6% | 21% → 12% | 7.2% → 0 | 1,776 → 1,741 |
| corpus | 6,060 | 32% → 2.8% | 42% → 33% | 13% → 0 | 2,341 → 2,373 |
| North | 3,200 | 45% → 0.3% | 88% → 81% | 7.9% → 0 | 3,181 → 3,203 |

Heights are mean px. The remaining joins are touching routes of the incremental embedding,
where no placement avoided every touch. The remaining crossings at corners are almost all
between two routes of the downward router in merge-heavy layouts (merge-k8: 82% of layouts),
where crowded zones put a crossing next to a bend. Spreading passing lanes in a gap up to
twice as far apart, where the gap allows, removed 2–9% of them in the merge-heavy profiles
(half in variations) on an earlier version of these rules, without measured cost in height,
width or crossings; it was not carried forward and remains a candidate.
The height cost is largest in the profiles that stretch fan width and merges (variations
+6.3%, combinations +11.8%, mixed +9.3%) and at most 1.5% on the real-shaped and Midjourney
sources. Of it, the contact rules account for variations +5.6%, combinations +6.6%, mixed
+8.0%; the rest is the band holding still on clicks that show nothing new
([Algorithm](#algorithm)). Allowing a touching route whenever the touch-free placement adds
height (no slack) cut the contact rules' share by about a third (mixed 769 px, combinations
1,030, on an earlier version) but doubled the joins in mixed and chains.

**Remaining gap.**
- On the real-shaped sources it is 0.01 crossings per layout, all in trees whose optimum
  is 0; stability on growth is within the flagged exceptions above.
- On merge-heavy profiles passing routes still cross about ten times the tile-order-fixed
  optimum. The next principled step is edge insertion: a shortest path per route over
  (row, gap) states priced by crossings with segments already fixed. It is worth doing only
  if real folders merge often.
  - It was built and measured on 2026-10-16 (branch `layout-passing-plan-wip`): courses
    that cross are re-planned one at a time with the rest held, for up to three rounds,
    together with growth shoving, narrower margins in narrow panes and a tree crossing price.
    On the static click tours it about halves κ above the optimum (combinations 41,401 →
    23,807, merge-k8 173,047 → 106,148, mj 84,433 → 43,753, chains 290 → 295). It cuts tree
    crossings by 20–70%, except on chains (62 → 74).
  - It is not adopted. On `layout:eval`'s click tours it doubles the mean legal displacement
    (17.3 → 39.0 px, above the reference's 31.2). With straight passing, the rest of the
    change gives 19.3 px, so the re-planning is the cause. It picks more anchored repacks on
    reveals (28 → 98 of 2,145 transitions); why is not yet isolated.
  - Its largest main-thread p95 is 6.9 ms against 2.7 ms. The re-planning budget restarts
    with every routing pass and does not count the plan's own work: the corpus's downward
    layouts of up to 200 nodes take 10.3 s against 0.70 s.
  - An independent review also found that undoing a growth can restore a stale band height.
    The branch's commit message lists these defects.
- Tree layouts that keep committed geometry cross more than fresh ones (variations 25% vs
  16%, mixed 15% vs 4%): the stability weight's price, a product trade-off.
- Crossings at corners in crowded downward zones ([Contacts](#contacts)), and touching
  incremental routes where nothing avoids them (merge-k8: 9.1% of layouts).
- Fresh layouts of merge-heavy DAGs can be far taller than a packing of the same tiles: in
  combinations session 8 at 1,400 px (128 px images) the downward layout is 1,790 px, and
  re-embedding its tiles around the clicked one gives 364. Since the band holds still on
  clicks that show nothing new ([Algorithm](#algorithm)), such a band stays tall until
  something new arrives. Offering the packed embedding as a fresh candidate would close it.
- The incremental budget bounds probes, not the conflict checks they make, so its worst case
  in time grew with the contact rules ([Performance](#performance)): 344 ms for one batch8
  click, 77 ms in merge-k8, against 87 and 21 ms on `main`.

## Reproducible optimisation acceptance

`bun run layout:eval` compares against a frozen copy of the graph, attachment and
packing engine at `34ed9a2de1d8ab3c4190b590e0054be3ac32c394`. It runs 65 hand/seeded cases
at five pane widths and all four tile presets, legal visible-tile click tours, static
multi-stack packing and real committed packing reveals. Dedicated timing runs follow
geometry evaluation, alternating engine order after warmup. Cold requests and prepared
committed reveals are both timed through `layoutGraph`. JSON, CSV, SVGs, a gallery
and an acceptance/timing table go to git-ignored `layout-eval/out/`. Any failed acceptance
target makes the command exit nonzero. See `layout-eval/README.md` for metric definitions
and the limits of the anchor feasibility checks.

#### Known limits

Five acceptance rows fail, as on `main` before the contact rules ([Contacts](#contacts)).
Each is a measured limit of this engine, not a loosened target. Figures are from the run
after the contact rules (1303bf1); `main` (e0666c6, before them) is given in parentheses.

- **Legal click anchors stationary: 32 of 2,595 tour steps move their anchor** (`main`: 4;
  baseline: 410), every one flagged `anchor-infeasible`; 44 more yield to the crossing cap
  (`main`: 65), so 76 anchors move in all against 69. All 32 are in random-dag-100-8101/
  8102/8103 and random-dag-200-9102/9103, with 35–83 visible tiles. The tiles that fail have
  three or four inputs, and the search stops with most of its probe budget left: in such
  scenes no route set keeps every lane, curve and tile clear, so the rules, not the budget,
  decide. Turning off the near-lane rule alone, in the router and the gate together, gives
  `main`'s counts back on the tours checked; the other contact rules do not. Lines closer
  than `LANE_SEPARATION` read as one, so that rule stays hard.
- **Dense tours: 100 of 480 clicks move their anchor** (`main`: 39; baseline: 426), all but
  one flagged `anchor-infeasible`: 19 at fan-in ≤ 4 and 81 at fan-in ≤ 10. 39 more yield to
  the crossing cap.
- **257 crossing regressions not paid for by height** (`main`: 74), while mean crossings fall
  from 338.2 (`main`) to 331.2. Routes that keep off other lines' ports and curves take
  longer ways round in dense random DAGs, where most of the regressions are, repeated over
  the steps of each tour. See also [Known readability limits](#known-readability-limits).
- **14 cases with worse p95 than the baseline** (`main`: 9). Twelve are main-thread requests
  with 3–12 visible tiles, at most 0.9 ms slower (baseline p95 0.1–0.9 ms): the engine builds
  and scores at least two candidates where the baseline ran one layered pass, and which
  sub-millisecond cases land on the list changes between runs. Two are worker reveals:
  random-dag-40-7503 (19 ms, baseline 11) and random-dag-100-8103 (70 ms, baseline 59).
- **Requests with ≤ 30 visible tiles above 5 ms at p95**: the committed reveals of
  random-dag-100-8101 (47 ms; `main` 9.6, baseline 53), random-dag-40-7503 (19 ms; `main`
  6.4, baseline 11) and random-dag-40-7502 (5.9 ms; `main` under 2.5). They have 16–28
  visible tiles plus history, so the dispatch rule runs them in the worker; main-thread
  requests stay at or under 2.8 ms at p95 (`main` 1.9). The incremental search keeps every
  touch out where some placement allows, and in these dense scenes it wires more probes and
  falls back to the routing grid more often before it does.
