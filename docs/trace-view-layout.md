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
inputs may meet only at the dot. Routes from one source may share (trunks). A candidate
with `sharedLanePx > 0` fails the hard gates, which `validateLayout` checks exactly. Every
generator avoids lanes at the source:

- the downward router through its zone, track and fan-in rules ([Routes](#algorithm));
- shelves, whose channel lanes give a source arriving at the height another source leaves
  from a lane further out;
- the incremental embedding, which records placed segments with their source and rejects
  a route that runs along another source's segment (its alternatives: gutters, travel
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
evaluation corpus (6,060 layouts) and the legal tours (2,595 steps, plus 540 dense-tour
steps) the only shared lane shown is 6 px, in random-dag-40-7502 at 1,400 px / preset 48
(`lane-infeasible`; no candidate of that cold request is lane-free).

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
positions in rank order, stopping at the first safe embedding. Ancestor-relative checks
reject translations that cannot preserve the required anchors before routing them.
Other retained tiles are re-embedded when the fixed warm embedding exceeds the compact
height budget; a compact warm embedding keeps its zero displacement.
Multi-input arrivals get explicit junctions.
Every route is lane-free: placed segments are indexed with their source, and a route
that would run along another source's segment takes one of a bounded set of alternative
lanes. Blocked source ports use a bounded rectilinear visibility grid (5,000 expanded
points per search, up to 3 fallback slots). Only when nothing is found does a second
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
attachment context. History is incompatible after membership/relationships, pane width,
pin or metrics change. Packing-only updates refresh the accepted geometry without
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

An open stack's band shows what the user expanded, never what is selected (`bandVisibleKeys` in `visibility.ts`; the state lives in `expansion.ts`). A node's children are visible exactly when the node is expanded and visible itself:

- every in-folder root (a folder image without a parent in the folder);
- the children of every visible expanded node, and the consumers (in this stack) of every expanded reference badge that a visible node carries;
- every further parent a visible output needs, so each output keeps all of its inputs.

Defaults: the stack's cover is expanded while the stack is open (its expansion *is* the open state), other in-folder roots are expanded until collapsed, and every other node is collapsed until expanded. A collapsed node with hidden children shows its "n edits" hint and a caret. Selection plays no part: the band plan (`planBandScene`) reads no selection, and an unchanged expansion plans the same tiles, so selecting a tile restyles it and moves nothing.

The expansion is pane state (one map of explicit choices by node key, plus at most one pending reveal), saved and restored with the pane's scene, so it survives a refresh. Node keys are stable across component merges, so a merge keeps it. Choices of nodes gone from the index are dropped; choices of nodes not loaded are kept, at most the latest 256 (`pruneExpansion`). Every operation is linear in the component (a 20,000-step chain and a 5,000-child fan are covered in `expansion.test.ts`).

`visibleKeys` (focus-derived context: the focus's ancestry, children and up to `SIBLING_LIMIT` nearest siblings) is the legacy section view's rule, kept for `planScene` only.

## Interaction model

Showing and hiding children is always an explicit act, as in a file tree. The rules (`TraceView.svelte`: `activate`, `toggleExpansion`, `activateStack`; pure transitions in `expansion.ts`):

- **A first click on an unselected tile** selects it and opens its children (`expandNode`). It only ever *adds* that node's children: no other branch opens or closes, and nothing moves except to make room. Selecting a leaf, or a node whose children are already open, changes styling only: every tile and connector keeps its exact place on every frame. Other open branches stay open whatever is selected.
- **A second click on the selected tile** (a plain single click on the node that is the whole selection) toggles its children. The second click of a double click does not: a double click opens the file, as before.
- **The caret** (`[data-node-caret]`, a real button next to the hint) toggles a node's children without changing the selection. It is in the roving tab order like the stack's disclosure; arrow keys pressed on it move between tiles.
- **A stack's cover** follows the same rules: pressing a closed stack's cover selects it and opens the stack, pressing the selected cover again closes it, and pressing an open, unselected cover only selects it. The stack's disclosure caret opens or closes the stack without selecting.
- **Collapsing an ancestor of the selection** hides the selected tile; the selection stays (hidden), as a file tree keeps a selection inside a folder it collapses. Nothing else changes. *Decision:* the alternatives (moving the selection to the collapsed node, or refusing to collapse) would make the caret change the selection or not do what it shows.
- **Keyboard navigation** moves the selection between visible tiles only; it never expands or collapses.
- **A selection made outside the view** (the host's file list, Show image, Preview's input links) reveals its node: the ancestors on one path to it count as expanded (`revealNode`, `revealPath`) until the next expansion choice in that stack turns them into explicit choices (`settleReveal`). A reveal expands nothing else and collapses nothing.
- **Recalled hidden state.** A collapsed node keeps the expansion of its hidden descendants, so expanding it again restores what was open below it.

Motion: an explicit expansion animates. Opening, new tiles slide in from their parent's side and fade in, while the rows below make room. Closing, departing tiles collapse with the rows rising into their space and fade in the second half (an accordion; see `docs/scene-transactions.md`, "Closing collapses like an accordion"). A collapse inside a band that holds still shows its children leaving in place, clipped above the rows rising below them. Selection alone is instant and changes no geometry.

Known follow-up: a new generation's output under a collapsed parent stays hidden until the parent is expanded (its hint count grows).

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
     - two bends that swap columns form a unit and take consecutive tracks, keeping their unavoidable crossing steep. Inside a unit, a bend leaving a column exactly where another arrives turns first; the other way round, both would run on that column between their tracks;
     - constraints are sequenced topologically (cycles broken by the sort order), then tracks are assigned by longest path. A zone used by a single source needs no tracks.
   - **Fan-in.** Inputs of one junction meet only at its dot. Each bending input ends its S-curve up to `FAN_IN` (3 px) to its own side of the junction's column, runs down to the top of the dot's berth, and reaches the dot along a short S-curve that ends vertically (routes stay orthogonal apart from their curves). On each side, nearer inputs keep closer to the column, so inputs from one side do not cross before the dot. The offsets stay inside the berth that other routes and junctions keep from the column. Without this, two inputs bending onto the column would share its last stretch.
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
     - Bend order inside a zone follows "leave a column before another route arrives in it". When those constraints form a cycle (lanes of several sources in consecutive rows interleaving), one is broken and two routes briefly share a column. A dogleg router (splitting one bend in two through a free column), the standard fix, is not implemented. Over 600 dense test graphs (8 inputs, outputs of 2–5 inputs, a second generation) this affects 2. In the evaluation corpus it affects 3 of 3,360 distinct downward layouts, each by 6 px. Moving one bend of the cycle to a neighbouring zone was tried and rejected: it created a longer shared stretch elsewhere. The band engine treats such a layout as infeasible (see [shared lanes](#shared-lanes)), so another candidate is shown instead.
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

Five acceptance rows fail. Each is a measured limit of this engine, not a loosened target:

- **Legal click anchors stationary: 9 of 2,595 tour steps move their anchor** (baseline:
  509), every one flagged `anchor-infeasible`: random-dag-100-8103 (454 px step 7, 640 px
  step 6), random-dag-200-9102 (360 px step 4; 454 px steps 4–6) and random-dag-200-9103
  (360/640/900 px step 1), 42–94 visible tiles. No lane-free anchor-preserving embedding
  was found within the per-request budget. Without the crossing cap 7 steps fall back;
  the cap's 74 yields change later history in some tours.
- **Dense tours: 83 of 480 clicks move their anchor** (baseline: 476), all flagged
  `anchor-infeasible`: 6 at fan-in ≤ 4 and 77 at fan-in ≤ 10. 86 more yield to the
  crossing cap. Where many sources merge into most tiles, the lane-free incremental
  embedding often finds no route set within its budget.
- **67 crossing regressions not paid for by height** (of 417 that cross more than the
  baseline): see [Known readability limits](#known-readability-limits).
- **8 cases with worse p95 than the baseline**, all with 3–12 visible tiles and a baseline
  p95 of 0.19–1.10 ms; the largest gap is 0.16 ms. The new engine builds and scores at
  least two candidates where the baseline ran one layered pass; which sub-millisecond cases
  land on the list changes between runs.
- **One request with ≤ 30 visible tiles above 5 ms at p95**: random-dag-40-7503's
  committed reveal, 7.4 ms (p50 5.6 ms; baseline 12.4 ms). It has 24 visible tiles plus
  history, so the dispatch rule runs it in the worker. The crossing cap adds about 1.5 ms
  (its winner crosses 190 times, so the best unanchored layout is evaluated); before the
  cap it measured 5.2 ms.
