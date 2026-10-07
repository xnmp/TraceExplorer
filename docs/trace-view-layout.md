# Trace view layout

How the Trace view arranges one connected component, and why it does not use ELK.

## Requirements

These requirements come from the [plan](trace-view-plan.md), section 4:

- **Pixel width budget.** Lay out within the measured pane width.
- **Siblings wrap onto several rows.** A display row is not a generation boundary.
- **Direction.** Parents always sit above their children.
- **Junctions.** Multi-parent inputs combine in readable junctions, with one terminal arrow per output.
- **Clean routes.** Routes never cross a tile and do not make long detours along the border.
- **Stable sizes.** Tile sizes are fixed by role (large/small, foreign scope, hint), so decoding and title changes never move tiles.

## ELK spike

We ran `elkjs` 0.9 (layered, `DOWN`, orthogonal routing) with the real tile sizes:

- Large tiles are 168×152.
- Small tiles are 92×104.
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
5. **Channels.** Rows are separated by tile-free channels: `rowChannel` within a band (wrapped rows), `bandChannel` between bands. A channel that holds junctions is divided into **zones** by junction levels: zone *i* lies between levels *i* and *i+1*. Default zone heights reproduce the original spacing (30 px above the first level, 14 between levels, 30 below the last); a zone grows when more tracks (below) cross it than fit.
6. **Junction placement.** A junction sits in the channel below its deepest parent's band. Its minimum level follows its nesting; its x prefers a point between its parents and its consumers, and is found by an interval search (`nearestFree`), not a pixel scan. Placement runs in two passes:
   - **Before lanes**, a junction takes the nearest x, at the shallowest level with room, that keeps `junctionSpacing` from junctions on its level, stays off every other junction's column in its channel (a dot above another would put one's routes through the other), and avoids every vertical run other routes *may* take: tile centres and gaps of the rows above and below, and both outer margins. It may sit on a parent's exit only if that parent feeds nothing else, and on its consumers' entries.
   - **After lanes**, the junctions that found no such x (and those nesting one) are placed against the runs routes *actually* take: lane positions, tile exits that carry routes and arrow entries. Routes to and from them are re-anchored to their final spot. If even that leaves no column of its own, the junction asks for room in the nearer margin and the canvas widens on the next pass (up to two extra view widths); only past that may dots share a column, and same-level spacing always holds.
7. **Routes.**
   - A route leaves the bottom centre of its source and enters the top centre of its target, which carries the arrow.
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
   - **Vertical pass.** Zone heights become `max(default, tracks × TRACK_HEIGHT)`; junction y is the previous zone's bottom plus `JUNCTION_BERTH`. Paths are emitted last: vertical run, S-curve inside the route's track slice of the zone, vertical run.
   - **Guarantees.** Fuzz tests in `tests/domain/trace-graph/layout.test.ts` (60 random graphs at 380, 640 and 1,000 px, plus targeted cases) check that:
     - no route passes within 5 px of a foreign junction;
     - no two junctions overlap;
     - routes from different sources never share a vertical lane;
     - routes never cross a tile;
     - every child's drawn sources are exactly its parents (trunks included);
     - route ids are unique;
     - the graph stays within 5% of the width it was given.

     Targeted tests cover crowded channels: every pair of a dozen inputs combined, sixty sources combined with a few tiles each, one style applied to many photos, and many sources passing one gap.
   - **Route ids** are unique and stable. A route is named by its endpoints; a trunk by its source and a hash of the consumers it carries, not by where it runs, so it keeps its id when a relayout moves it. (Collisions get a deterministic suffix.)
   - **Known limits.**
     - Bend order inside a zone follows "leave a column before another route arrives in it". When those constraints form a cycle (lanes of several sources in consecutive rows interleaving), one is broken and two routes briefly share a column. A dogleg router (splitting one bend in two through a free column), the standard fix, is not implemented. Over 600 dense test graphs (8 inputs, outputs of 2–5 inputs, a second generation) this affects 2.
     - Past two extra view widths, junctions in an extremely crowded channel (over a hundred combinations in one generation, sooner in narrow panes) may share a column, and their routes can then meet. Even below that, in very crowded channels a tile's exit can line up with another tile's entry; the bend zones cannot always separate the routes using that column. Every pair of 20 inputs at 300 px still shows this.
     - Neither hides parentage: highlighting a node shows its exact lineage.
8. **Tie-breaks.** Ties use one total order: hinted keys keep their previous relative order, and new keys merge in by creation order. This keeps sorting transitive and independent of input order.
9. **Navigation.** `nearestInDirection` picks arrow-key targets spatially. The cross axis is weighted 3×, so ←/→ stay on a row and ↑/↓ follow lineage.

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

- **Benchmarks.** `tests/domain/trace-graph/scale.test.ts` covers a 20,000-step edit chain focused at its end, a 3,000-output fan-out, and a 10,000-image folder made of 500 components. A 1,000-child fan-out test bounds the path data (under 250 KB; it was 10.7 MB before trunks).
- **Off-thread.** Layouts above 60 tiles run in a blob worker when the host announces `blobWorkers` (its CSP permits `worker-src blob:`), and otherwise on the main thread after yielding a frame. Results are cached by their exact request. The worker gets one job at a time, so a request superseded while it waits is dropped rather than computed; one already running finishes and is cached.
- **Rendering.** Tiles outside the viewport (±800 px) are not mounted once a component shows more than 120 tiles; connectors and junctions are windowed the same way by their vertical extent. Sections far outside the viewport keep only a sized placeholder, and collapsed sections need only their summaries.

## Motion

`motion.ts` captures the displayed geometry before a commit and animates for about 180 ms from there. The captured geometry includes any transition still in progress, so interrupted selections continue smoothly. The transitions are:

- tile translate, width and image height;
- junction positions;
- route `d` morphs; new routes are displaced to follow their endpoints and fade in to their own (possibly dimmed) opacity;
- section height.

Rules:

- **Measure, then animate.** Playback measures the whole new layout before starting any animation. The canvas size animation re-centres the canvas, so measuring after it starts would offset every tile by half the width change.
- **Pure path sampling.** Connectors are resampled from their path strings (`path-sampling.ts`, using the animated computed `d` when interrupted), never with `getPointAtLength`. Above 300 connectors they snap instead of morphing.
- **Engine support.** Engines without CSS `d` animation (WebKit) snap existing connectors, fade in only connectors that are new, and do not move junction dots either, so a dot never slides while its connectors have snapped. A connector shown without a captured shape (the previous graph exceeded the morph limit) snaps rather than morphing from a guess.
- **Regrouped connectors.** A connector new in this commit takes over one that vanished from the same source (a trunk regrouped by a relayout, say), nearest shape first: it morphs from that shape (and from its opacity, should lineage dimming differ), or simply appears where shapes do not morph, instead of fading in. Only connectors beyond those that vanished fade in.
- **Unchanged connectors** keep their exact curve: a connector whose shape did not change is not morphed (morphing runs on a sampled polyline, which would wobble it).
- **Superseded commits.** When two commits land before one render, only the later one plays.
- **Opacity.** Keyframes never set an existing element's opacity, so lineage dimming (a class) holds throughout. The exception is an element caught mid fade-in: its displayed opacity is captured and the fade continues from there, so an interruption never flashes it.
- **Scroll anchoring.** A commit adjusts scrolling only for the graph containing the anchored tile, and only once.
  - *Hold* (pointer selection): the clicked tile stays at its screen position while the layout settles, as far as scrolling allows.
  - *Reveal* (keyboard and programmatic focus, including the Preview pane's inputs): once motion settles, the focused tile is scrolled into view by the smallest amount (`nearest`).
  - Other sections relaying out never move the scroll position. Any scrolling input from the user (wheel, touch, pointer, keys other than a held modifier, which auto-repeats during a Ctrl- or Shift-click) cancels a pending or active anchor. Section bodies never become vertically scrollable mid-motion, so a wheel always reaches the view.
- **Mounting** commits exactly once.
- **Reduced motion** skips all of it.
