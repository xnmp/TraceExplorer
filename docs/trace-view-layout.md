# Trace view layout

How the Trace view arranges one connected component, which way it runs, which nodes it shows, and why it does not use ELK.

## Grid bands and pinned covers

The view uses one folder-order grid. `folderCells` collapses each lineage at
its cover’s position in the host listing. Stacks with no listed cover (unsaved) follow the
listing, oldest cover first (creation order of the cover key), so a stack gaining members never
moves another. No user action moves a cell: a stack that was unsaved **stays where it is after it is
saved** (`held`, kept by `StackGrid`) until the grid is laid out afresh, i.e. the folder or the column
count changes, when it takes its listed position. Its eventual file name cannot be known before it is saved.
`gridFlow(items, open, columns, metrics)` takes the host-sorted list **already collapsed** to one
`{id, kind: "stack"}` at each cover's position, plus ordinary files/folders.
Use an entry path or cover key as `id`, rather than a component id (which can
change on merges). Cells keep their logical row, column and x on every band
change. Full-width bands begin at their stack row's bottom; bands sharing a
row touch in item order, and the normal row gap follows them. Measured heights
exclude the cover row. Coordinates start at (0, 0), without pane padding.
`mapGridItemRects(before, after)` joins by identity and returns both rectangles,
including null for arrivals/departures. The domain does not animate anything.

For a fully paged graph, `projectReferenceBadges(projectDag(nodes))` removes
foreign root images (scope `subfolder`/`external`, with a path and no accepted
parent in the supplied DAG) from the drawable DAG. It preserves each reference's
path, scope, key and ordered direct consumers, indexed by consumer. Keep all
badges in domain data; display up to three and a `+n` overflow in the view.
Path-null placeholders and foreign images with parents remain tiles. Compute
drawable components **after** this projection: sharing only a reference no
longer joins two edit chains. Projection requires complete parent relationships,
before visibility filtering; a partial graph cannot establish reference roots.
`lineageWithBadges` treats each badge as a virtual parent: focusing it highlights
all its consumers and descendants; focusing a consumer highlights its badge
ancestors without highlighting unrelated co-consumers.
`badgeHighlight` adds hover lineage to the selected lineage without changing
the selected neighborhood, keyboard focus, or layout request.

`planBandScene` accepts that projection, drawable members and a `PinnedCover`.
It seeds visibility from current-folder roots and always requests top-to-bottom
layout, bypassing `orientation.ts`. The legacy reference-only root fallback and
automatic orientation remain in `planScene`. `layoutGraph` puts the pinned root
alone in generation 0's first display row, at its absolute x centre, even when
routing widens the canvas. Other roots wrap below it; neighbouring grid tiles'
horizontal spans are obstacles in that first row. The remaining rows centre
toward the cover, clamped inside routing margins. A non-root pin returns the
ordinary layout with `pinnedViolation: "not-a-root"`, preserving its real parents.
Pinning is ignored for legacy left-to-right requests. Unavailable, nonfinite
or off-pane pins fall back to ordinary layout; pinning requires a finite
measured pane width of at most 100,000 px. Invalid neighbour spans are ignored.
Routing retries spend unused band width on wider margins before extending the
canvas, so aligning a narrow row toward an edge does not discard that spare room.

The layout cache includes the complete pin (key, centre x and neighbor spans).
`attachBand` maps the engine’s cover origin to the grid cell and inserts earlier
same-row bands beneath its stem. Later stems use the empty left routing gutter
to bypass earlier bands’ tiles. Several stacks can remain open; their open state
is keyed by cover identity, while current component ids are resolved from each
fresh folder index. Clicking a closed stack selects its cover and opens it;
the cover’s chevron closes it, and double-click opens its file. External host
selection or Preview focus opens the owning stack, including after a merge.

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
- **Direction.** Parents always come before their children: above them inside every band (see [Orientation](#orientation)).
- **Junctions.** Multi-parent inputs combine in readable junctions, with one terminal arrow per output.
- **Clean routes.** Routes never cross a tile and do not make long detours along the border.
- **Stable sizes.** Every tile has the same width and image size (`metrics.ts`), whatever the selection or focus; only rows a node always carries (its scope marker, its expansion hint) add height. Decoding, title changes and selection therefore never resize a tile; selection shows in styling only. Only the host's tile-size setting does (see [Tile size](#tile-size)).

## Tile size

Hosts with the SDK's `tileSize` capability report each pane's tile size (`FileViewPane.tileSize`: its preset and thumbnail edge `imagePx`, resolved as their Tiles view resolves it, per-folder override first). `tileMetrics(imagePx)` turns it into the Trace tile: as wide as the host's own tiles, the edge plus 44 px of chrome (92, 108, 140 and 172 px for the 48, 64, 96 and 128 px presets), with the image keeping its 80:51 aspect inside the usual 6 px chrome. The text rows (title, scope, hint) keep their heights. Ordinary cells pass the preset to `ui/file-tile`; its `tileGridMetrics` supplies the allocation and gaps. Hosts without `fileTile` use the original plugin fallback tile in the same grid.

Hosts without the capability (up to v1.11.4) report nothing: Trace draws the default 92 px tile, the same as the smallest preset, and the host's tiles keep their global setting.

The view passes the metrics to `planBandScene`, whose layout request carries the tile sizes and `tileWidth`, so the cache key changes with the setting and a layout of one size is never reused for another. Spacing scales with the tile width (`spacingFor`, never below the default): the gap between tiles, the side margins and the bend room grow in proportion, while the arrowhead, its approach, junction levels, clearances and lanes stay the same. Tiles resize in motion, from the size shown to the new one. Bands keep their downward orientation at every tile size. The layout sweeps run at all four presets.

## Visible nodes

`visibility.ts` keeps the context limited, and a pure function of the current focus (earlier selections never accumulate expanded branches):

- every root (a folder image without a parent in the folder) and its children;
- the focused node's ancestry, its children, and its nearest **siblings**: the other children of its folder parents;
- every further parent a visible output needs, so each output keeps all of its inputs.

Siblings are context, not lineage: they keep the `unrelated` tone (lightly dimmed), and routes into them are not highlighted. Only the focus's own siblings are added, not its parents' siblings or its siblings' children. Two bounds keep a selection from flooding the graph:

- **Only folder parents.** A reference input (subfolder or external), such as one style image applied to hundreds of variations, contributes no siblings: its other outputs are not variations of the focus. (Before this rule, selecting one of 300 styled variations pulled in all 300 others: 602 tiles, a canvas almost five times the pane width, half a second of layout.)
- **At most `SIBLING_LIMIT` (12).** The siblings nearest the focus in their parent's child order (creation order), half on either side where there are enough. A parent with children left out shows its usual "n further edits" hint (with the chevron); selecting it shows them all. The limit only matters below a parent that is not a root: a root's children are always shown.

## Orientation

Bands always run top to bottom. `planBandScene` bypasses `orientation.ts` and its
per-size hysteresis. The legacy `planScene` and orientation functions remain
unit-tested domain APIs, but the grid view does not invoke their automatic
left-to-right rule. Long chains can therefore make tall bands; snaking or
selective horizontal flow remains a follow-up to issue #36.

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

The algorithm is described top to bottom; a left-to-right layout is its transpose (see [Orientation](#orientation)).

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
   - **Zone choice.** Each channel crossing bends inside one zone and runs vertically outside it. The zone is chosen cheapest first: fewest vertical runs that touch a junction the route does not belong to (within `JUNCTION_BERTH`), then most room. Evaluation stops at the first zone with no contact. A second pass re-evaluates every choice against the final set, so the result does not depend on processing order.
   - **Tracks.** Within a zone, bends from different sources get distinct heights by left-edge channel routing:
     - leftward bends are ordered by target x ascending, then rightward bends by target x descending, so parallel routes never cross;
     - a bend leaving a column precedes one arriving in it, so a route never turns into a lane another is still using;
     - two bends that swap columns form a unit and take consecutive tracks, keeping their unavoidable crossing steep;
     - constraints are sequenced topologically (cycles broken by the sort order), then tracks are assigned by longest path. A zone used by a single source needs no tracks.
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
     - Bend order inside a zone follows "leave a column before another route arrives in it". When those constraints form a cycle (lanes of several sources in consecutive rows interleaving), one is broken and two routes briefly share a column. A dogleg router (splitting one bend in two through a free column), the standard fix, is not implemented. Over 600 dense test graphs (8 inputs, outputs of 2–5 inputs, a second generation) this affects 2.
     - Past two extra view widths, junctions in an extremely crowded channel (over a hundred combinations in one generation, sooner in narrow panes) may share a column, and their routes can then meet. Even below that, in very crowded channels a tile's exit can line up with another tile's entry; the bend zones cannot always separate the routes using that column. Every pair of 20 inputs at 300 px still shows this.
     - Neither hides parentage: highlighting a node shows its exact lineage.
8. **Tie-breaks.** Ties use one total order: hinted keys keep their previous relative order, and new keys merge in by creation order. This keeps sorting transitive and independent of input order.
9. **Navigation.** `gridNeighbor` uses logical cell and committed band rectangles, including virtualized rows. The cross axis is weighted 3×; Home/End use visual order. A roving tab stop spans ordinary entries, covers and band tiles. Selection forwards the original modifiers to the host, including Shift ranges; unlisted picks keep the established Preview/AI-input rules.

## Performance

- **Stages.** Bands, ordering, wrapping and junction placement are near-linear in the shown tiles (consumers are indexed once; junction lookups are bucketed by x). Routing is proportional to the crossings drawn: per-row gap lists are cached, vertical runs are bucketed by x and source, and the trie claims each crossing once per source. It is not linear in general. A graph where many independent sources each reach many distant rows costs about sources × rows; the view's limited context (focus lineage plus nearby generations) normally keeps such graphs from reaching layout. The hidden-descendant hints traverse only hidden nodes and stop at 999.
- **Measured** (one thread, `bun`, layout only, 900–1,100 px):

  | Graph | Size | Time |
  |---|---|---|
  | fan-out | 750 / 1,500 / 3,000 / 6,000 children | 55 / 107 / 340 / 1,382 ms |
  | one style applied to n photos | 100 / 200 / 400 / 800 | 88 / 136 / 441 / 1,449 ms |
  | edit chain where every step also takes the root | 1,000 / 2,000 | 369 ms / 1.5 s |
  | fan-out where every child also has a child taking the root | 500 / 1,000 / 2,000 | 0.6 / 2.5 / 10.7 s (worst case above) |

  A layout that widens runs the pass again (at most three passes in all). Placing margin lanes costs about S² log S for S sources sharing a margin, within the sources × rows bound above.

- **Benchmarks.** `tests/domain/trace-graph/scale.test.ts` covers a 20,000-step edit chain focused at its end, a 3,000-output fan-out, the same two laid out left to right (transposing adds a linear pass), and a 10,000-image folder made of 500 components. Choosing the orientation is linear in the component's size, apart from the junction estimate, which is computed only for components that pass the cheap checks and exactly only for up to 200 multi-input outputs (800 inputs). It is cached per component, so focus changes reuse it. A benchmark covers 200 outputs of 20 inputs each (the estimate is skipped) and a 96-image component whose estimate runs exactly. A 1,000-child fan-out test bounds the path data (under 250 KB; it was 10.7 MB before trunks).
- **Off-thread.** Layouts above 60 tiles run in a blob worker when the host announces `blobWorkers` (its CSP permits `worker-src blob:`), and otherwise on the main thread after yielding a frame. Results are cached by their exact request, except that a left-to-right request ignores the pane width (the engine does not use it running right), so resizing reuses its layout. The worker gets one job at a time, so a request superseded while it waits is dropped rather than computed; one already running finishes and is cached.
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
