# Trace view: motion policy, scene transactions and layout optimisation

Status: plan, 2026-10-13. Supersedes the per-transition fixes of #66/#71/#73.

## Why

Three rounds of flash fixes each patched one transition. The evidence from the
round that followed shows the remaining artefacts come from structure, not from
one bug:

- **Native clock regression (measured).** Clicking between two children of an
  open stack makes the newly revealed tile reach ~0.99 opacity, then dip to
  ~0.89 while the exiting ghosts brighten again, in 1–2 of 5 clicks per run.
  Every motion pass sets `animation.startTime = document.timeline.currentTime`
  captured inside the task (`motion.ts` `playGraph`, `playGrid`). In
  WebKitGTK that value is stale and later re-resolved, so all effects jump back
  together. Removing the assignment removed every sampled dip (A/B, 3 runs
  each); a smaller one-frame dip remains in the video at the end of the
  entrance, i.e. in the compositor's hand-off.
- **Motion policy (measured, Chromium and WebKit).** A selection-driven reveal
  fades the tile in at once but holds its connector at 0 until progress .95,
  so for ~70 ms a tile floats with no provenance; exiting tiles linger as
  160 ms ghost copies after their connectors are gone.
- **Ownership.** Each graph pass cancels every finite animation in the graph
  subtree, including the CSS transitions on retained cards (selection
  styling), so they snap.
- **No scene transaction.** Folder data, grid packing, graph layout, styling,
  windowing and the displayed animation state each publish separately.
  Cold expansion, asynchronous resize and backend refresh can present a mixed
  scene, and an action whose dependencies resolve over several turns starts
  motion more than once. Motion infers enter/update/exit from DOM membership
  and element references (`GraphSnapshot`).
- **Layout economy.** Bands waste space: the layered engine centres each
  generation and transposes, so short sideways columns leave empty space
  above, and placement considers more than the visible nodes.
- **Startup.** A window opened straight into a Trace folder can paint the
  built-in listing before Trace eligibility is known (the SDK has no
  first-paint barrier).

Industry practice that the target follows: build the next scene completely
while the previous one stays on screen, commit it once, and run one
enter/update/exit diff on one clock (yFiles `LayoutExecutor`, D3 keyed joins
with interruptible transitions, Motion `layout`/`AnimatePresence`, React
transitions). Selection inside a hierarchy swaps content instantly (Finder
column view, VS Code call hierarchy); motion is kept for spatial changes the
user initiated (open/close a stack).

## Phases

Each phase is a separate PR, shippable on its own, with its regression tests.

### 1. Motion policy (fixes the reported blink)

1. **Scene-change classifier** — pure, in `src/lib/domain/trace-graph/`:
   given the previous and next committed plan/layout for a graph, classify the
   change as `reveal` (same data, width, pin and metrics; only focus or the
   visible set differ), `restyle` (same geometry), or `reflow` (anything
   else). Unit-tested, including malformed and empty inputs.
2. **Reveal swaps instantly.** A `reveal` commit snaps: no entrance fade, no
   exit ghosts, connectors drawn with their tiles in the same frame, and any
   motion this graph still owns jumps to its end. Grid rows displaced by the
   band's new extent snap too.
3. **One clock without back-dating.** Remove the manual `startTime`
   assignments; effects created in one task already share their start time
   (Web Animations: pending animations started in the same frame resolve to
   the same ready time). Carried animations keep their own timing.
4. **Owned cancellation.** Motion cancels only the animations it created
   (tracked), never CSS transitions on retained cards.
5. **Entering and exiting together.** For motions that remain (expand,
   collapse, reflow), an entering tile and its incident connectors fade in on
   the same keyframes; an exiting tile and its connectors fade out together.

Guards: `e2e/selection-blink.spec.ts` (Chromium + WebKit) asserts, on the
first presented frame after each click, revealed tiles and connectors fully
opaque, no ghosts, retained tiles unmoved, and no opacity decrease in any
later frame; unit tests for the classifier; the native harness reruns the
alternating-click scenario and must show no dips.

### 2. Layout as an optimisation problem

Research (benchmark of 6,060 paired layouts, five widths, four tile presets)
found the wasted space is policy, not a counting bug: sideways candidates are
computed on the **complete lineage** and then filtered, keeping the full
layout's origin and envelope (`band-layout.ts` arrangement and filtering,
`scene.ts` passing the lineage); short generation columns are centred against
the tallest (`layout.ts`); generations are indivisible shelf columns. In the
reported band, Cerulean's hidden edit alone puts 60 px above Cerulean
(448 → 328 px when only that node is removed). A visible-first prototype cut
that band to 347 px and mean whitespace from 59% to 50% with zero overlaps,
but moved tiles more per click (73 px vs 42 px) and was not faster.

1. **Objective** (`src/lib/domain/trace-graph/layout-quality.ts`): height and
   area for the width, connector length, bends, crossings, shared lanes,
   direction, sibling order, alignment and displacement of tiles visible
   before and after. Hard gates: every visible node once at its size, no
   overlaps, no connector through a tile, exact parentage, arrow approaches.
2. **Benchmark** (`layout-eval/`, `bun run layout:eval`): hand cases (the
   reported band, fans, chains, merges, hidden descendants), legal click
   tours, seeded random trees and DAGs, widths 360–1400, multi-stack packing
   through the real grid pipeline; prints baseline vs candidate and writes
   SVGs to a git-ignored `layout-eval/out/`.
3. **Engine**: visible-only placement (hidden nodes contribute captions, never
   slots); top-aligned shelves; bounded shelf-partition search scored by the
   objective after the real attachment; history candidates from the last
   committed layout; the clicked tile and its visible ancestors are anchored.
   History is part of the layout request, cache signature and worker payload.
4. **Acceptance** (measured by the benchmark, enforced by tests):
   - the reported band ≤ 350 px at 454 px, 34 px from cover to first child;
   - clicked tile displacement 0 on every legal click step where feasible;
     mean displacement over legal tours no worse than today;
   - mean band height over legal tours ≥ 15% lower than today; no case more
     than 10% taller than today unless the stability rule chose it;
   - zero hard-gate violations across the corpus;
   - p95 layout time per case no worse than today; ≤ 5 ms for ≤ 30 visible.
5. Tests: behavioural contracts (no hidden-topology influence on geometry,
   no empty rows above the first child, anchoring, determinism, immutability)
   and edge cases (empty, single, 200-child fan, 2,000-node chain, cycles,
   unknown or duplicate parents, huge dimensions).

### 3. Scene transactions

1. **Pure folder scene.** Extract grid packing and band attachment from
   `StackGrid`/`TraceGraph` into a pure `composeFolderScene` (nodes, edges,
   tiles, cells, bands, bounds) in `scene.ts`; the renderer reads it through
   an adapter.
2. **Scene controller.** A pane-owned controller takes inputs (data version,
   listing, focus, open stacks, metrics, width), prepares the affected rows'
   layouts (cache, inline or worker), keeps the previous scene displayed while
   preparing, and commits one complete scene. Leaf layout effects, the
   `ongeometry → covers` publication and estimated-footprint animation go.
   A newer action supersedes a preparing one; only the latest commits.
3. **Presentation model.** One diff of committed scenes drives motion
   (enter/update/exit by identity, not DOM membership), with explicit
   retiring records rendered by Svelte instead of DOM clones; interruption
   samples the one clock and retargets.
4. **Viewport and lifecycle.** Windowing selects from the logical scene, so
   mounting never reads as entering; folder and tab switches reset
   presentation; reveal waits use controller status instead of rAF polling.

Guards: frame-level e2e invariants (one geometry commit and at most one
motion start per action; no mixed scene while a node RPC or worker reply is
held; continuous pose under interruption; no cross-folder ghosts; windowing
never animates), plus unit tests for scene composition and diffing.

### 4. Startup barrier

Host capability for a view provider to report eligibility as pending, so the
pane holds its first paint (bounded) until Trace says yes or no; the plugin
uses it when present and keeps the current optimistic preload otherwise.
Host PR first, SDK typings in `integration/plugin-sdk/index.d.ts`, then the
plugin. Guard: cold window opened straight into a Trace folder never paints
the built-in listing.

## Delivery

Phases 1 and 2 touch different files and run in parallel; 3 builds on 1;
4 is independent. Each PR runs the full suite (`check`, vitest, cargo, browser
in Chromium and WebKit, packaging) and the native harness for its scenario,
gets an independent review (selection, folder index and publication changes
require one), and merges when Linux CI is green. A release follows phase 3.
