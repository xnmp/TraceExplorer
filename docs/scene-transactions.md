# Scene transactions — Phase 3 design

> **Amendment (2026-10-13):** section 3 is superseded where it splits planning, per-graph layout and composition across the controller. All geometry comes from one pure, swappable `FolderLayoutEngine = (input: FolderLayoutInput) => FolderLayout` (see `docs/trace-scene-plan.md`, phase 3 step 1). `planFolderScene`/`composeFolderScene` and per-graph `PreparedLayouts` become internals of the default engine; the controller runs the engine (inline or worker) on a complete, prepared `FolderLayoutInput` and commits its output. Per-band caching is the engine's concern (`memoizeEngine`). Everything else here stands.


Status: implementation design. Based on `scene-motion-policy`, commit `3573e20643e4953c98d3c402955a3acb4812be46`. Read-only investigation; no files changed.

Throughout this document, `D/` means `src/lib/domain/trace-graph/`, and `V/` means `src/lib/plugins/trace/view/`. Line references describe the inspected commit.

## 1. Contract and ownership

A pane displays one immutable `FolderScene`. Preparing another scene never changes its nodes, routes, packing, bounds, or geometry. A successful transaction publishes the complete replacement once; one presentation diff controls its motion.

This follows the separation between layout calculation and transition execution described by [yFiles LayoutExecutor](https://docs.yworks.com/yfiles-html/api/LayoutExecutor/). Identity-based diffing and explicit interruption also follow the lifecycle principles described by [D3 transitions](https://d3js.org/d3-transition/control-flow). The specific controller, packing, and connector policies below are TraceExplorer decisions.

Keep Phase 1’s policy:

- `reveal`: snap tiles, connectors, and geometry displaced solely by that reveal; finish owned motion and remove retirees synchronously.
- `restyle`: preserve existing motion and retained cards’ CSS transitions.
- `reflow`: animate spatial changes for 160 ms, subject to reduced motion and rendering limits.
- Initial folder display and restored tab display snap.

The controller owns geometry publication. `StackGrid` and `TraceGraph` become renderers. The session owns fetching and persistent expansion identities. The presentation driver owns native effects.

## 2. Types

### Pure domain

Move `ComponentData`, `Member`, and `FolderIndex` from `V/folder-session.svelte.ts:19–32` into new `D/folder-data.ts`; re-export them from the session during migration.

Add provenance when a complete component finishes loading at `V/folder-session.svelte.ts:203–208` and during artifact resolution at `:318`.

```ts
export interface ComponentData {
  readonly directory: string;
  readonly token: string;
  readonly version: number; // increases on each accepted complete replacement
  readonly nodes: readonly TraceNode[];
  readonly dag: TraceDag;
  readonly members: readonly NodeKey[];
}
export interface Member {
  readonly componentId: string;
  readonly key: NodeKey;
}
export interface FolderIndex {
  readonly directory: string;
  readonly token: string;
  readonly components: readonly ComponentSummary[];
  readonly members: ReadonlyMap<string, Member>;
}
```

Define these types in new `D/folder-scene.ts`. Imported types retain their existing definitions: `FileEntry`, `TraceNode`, `SceneTile`, `BandScenePlan`, `RouteStyle`, `GraphLayout`, `PlacedNode`, `PlacedRoute`, `PlacedJunction`, `ReferenceBadge`, `GridRect`, `GridCell`, `GridBand`, and `TileMetrics`.

```ts
export type GraphId = string;  // stable cover revision key
export type EntityId = string;
export type TransactionId = number;

export interface SceneScope {
  readonly paneId: string;
  readonly directory: string;
  readonly generation: number; // lifetime, not backend revision
}
export interface SceneCause {
  readonly kind:
    | "startup" | "restore" | "selection" | "expand" | "collapse"
    | "resize" | "metrics" | "listing" | "refresh" | "reveal" | "retry";
  readonly target: string | null; // stable node key, cover key, or entry path
  readonly anchor: "hold" | "reveal" | "none";
}
export interface HostGridMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly gap: number;
  readonly gridPadding: number;
}
export interface SceneInputs {
  readonly scope: SceneScope;
  readonly cause: SceneCause;
  readonly index: FolderIndex;
  readonly listing: readonly FileEntry[]; // copied, in host order
  readonly listingVersion: number;       // ordered content changes only
  readonly claimedPaths: ReadonlySet<string>;
  readonly components: ReadonlyMap<string, ComponentData>; // current component ids
  readonly focus: ComponentFocus | null;
  readonly selectedKeys: ReadonlySet<NodeKey>;
  readonly selectedPaths: ReadonlySet<string>;
  readonly requestedOpen: ReadonlySet<GraphId>;
  readonly heldCovers: ReadonlySet<GraphId>;
  readonly heldColumns: number | null;
  readonly width: number; // existing 16px quantized pane width
  readonly tile: TileMetrics;
  readonly hostGrid: HostGridMetrics | null;
  readonly badgeHover: NodeKey | null;
  readonly history: ReadonlyMap<GraphId, GraphLayout>; // committed RAW layouts
}
export interface PreparedGraph {
  readonly plan: BandScenePlan;
  readonly layout: GraphLayout; // raw layout-client result
  readonly requestKey: string;  // exact layoutSignature, including Phase 2 history
}
export type PreparedLayouts = ReadonlyMap<GraphId, PreparedGraph>;

export interface CoverDecoration {
  readonly name: string;
  readonly count: number;
  readonly unsaved: boolean;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly imagePx: number | null;
  readonly small: boolean;
}
interface RecordBase {
  readonly id: EntityId;
  readonly graphId: GraphId | null;
  readonly rect: GridRect; // folder coordinates, without pane padding
}
export type SceneRecord = RecordBase & (
  | {
      readonly kind: "tile";
      readonly tile: SceneTile;
      readonly placed: PlacedNode;
      readonly badges: readonly ReferenceBadge[];
      readonly selected: boolean;
      readonly cover: CoverDecoration | null;
    }
  | {
      readonly kind: "entry";
      readonly entry: FileEntry;
      readonly selected: boolean;
    }
  | {
      readonly kind: "route";
      readonly route: PlacedRoute; // path in folder coordinates
      readonly style: RouteStyle;
    }
  | {
      readonly kind: "junction";
      readonly junction: PlacedJunction;
      readonly highlighted: boolean;
    }
  | { readonly kind: "band"; readonly band: GridBand }
  | { readonly kind: "row"; readonly band: GridBand }
);
export interface SceneEdge {
  readonly id: EntityId;
  readonly graphId: GraphId;
  readonly parent: NodeKey;
  readonly child: NodeKey;
  readonly badge: boolean;
}
export interface FolderGraph extends CommittedGraph {
  // inherited layout is RAW, for classifier/history/cache use
  readonly graphId: GraphId;
  readonly plan: BandScenePlan;
  readonly attached: GraphLayout; // section-local, completely attached
  readonly origin: { readonly x: number; readonly y: number };
  readonly row: number;
  readonly requestKey: string;
}
export interface FolderScene {
  readonly inputs: SceneInputs;
  readonly columns: number;
  readonly padding: number;
  readonly heldCovers: ReadonlySet<GraphId>;
  readonly cellOrder: readonly string[];
  readonly cells: ReadonlyMap<string, FolderCell & { readonly rect: GridCell }>;
  readonly bands: readonly GridBand[];
  readonly rowBands: readonly GridBand[];
  readonly bounds: GridRect;
  readonly graphs: ReadonlyMap<GraphId, FolderGraph>;
  readonly nodes: ReadonlyMap<GraphId, ReadonlyMap<NodeKey, TraceNode>>;
  readonly edges: ReadonlyMap<EntityId, SceneEdge>;
  readonly tiles: ReadonlyMap<EntityId, Extract<SceneRecord, { kind: "tile" }>>;
  readonly routes: ReadonlyMap<EntityId, Extract<SceneRecord, { kind: "route" }>>;
  readonly records: ReadonlyMap<EntityId, SceneRecord>;
  readonly navigation: ReadonlyMap<string, GridRect>;
}
```

`SceneInputs` is a **prepared** snapshot: every component needed by an open graph must match `index.directory` and `index.token`. Closed covers can use index summaries without node data. Partial pages and stale component objects cannot enter this type.

Entity ids use `JSON.stringify([kind, graphId, localId])`; ordinary entries use their path, and row backgrounds use their logical row. Component ids never form render identities. Scope is checked separately, allowing cached scenes to be rebound to a new pane lifetime.

`FolderGraph.data` is the complete component’s `dag`, preserving Phase 1’s reference-identity test at `D/scene-change.ts:49`. Its `revision` is `ComponentData.version`.

### View adapter and transactions

New `V/scene-controller.svelte.ts` owns transaction state and action leases:

```ts
export type TransactionStatus =
  | "collecting" | "preparing-data" | "preparing-layout"
  | "ready" | "committed" | "superseded" | "failed";

export interface SceneTransaction {
  readonly id: TransactionId;
  readonly scope: SceneScope;
  readonly inputs: SceneInputs | null; // null until complete data is captured
  readonly cause: SceneCause;
  readonly status: TransactionStatus;
  readonly pending: ReadonlySet<GraphId>;
  readonly error: string | null;
}
export interface ActionLease {
  readonly id: TransactionId;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  derive<T>(write: () => T): T;
}
export interface PreparationNotice {
  readonly transactionId: TransactionId;
  readonly coverKey: GraphId;
  readonly phase: "loading" | "arranging" | "failed";
  readonly message: string | null;
}
```

The adapter’s incomplete intent is private controller input, not a drawable scene. It contains current host/session sources, desired expansion, and unresolved action continuations.

### Presentation

New `V/presentation.ts` owns these immutable model types and pure sampling/retargeting functions. Native handles stay in `V/scene-motion.ts`.

```ts
export type RenderId = string;
export type Ease = "linear" | readonly [number, number, number, number];
export interface Pose {
  readonly rect: GridRect;
  readonly opacity: number; // motion multiplier; settled = 1
  readonly clip: GridRect | null; // absolute folder-coordinate clip
}
export interface PoseFrame {
  readonly at: number; // milliseconds within the common epoch
  readonly pose: Pose;
  readonly easing: Ease; // interpolation to the next frame
}
export interface Track {
  readonly frames: readonly PoseFrame[];
}
export interface PresentedRecord {
  readonly renderId: RenderId;
  readonly record: SceneRecord;
  readonly initial: Pose;
  readonly track: Track | null;
}
export interface RetiringRecord extends PresentedRecord {
  readonly sourceTransaction: TransactionId;
  readonly group: RenderId | null;
  readonly reason: "exit" | "old-route";
}
export interface Presentation {
  readonly epoch: number;
  readonly duration: number;
  readonly live: ReadonlyMap<RenderId, PresentedRecord>;
  readonly retiring: ReadonlyMap<RenderId, RetiringRecord>;
  readonly pinned: ReadonlySet<RenderId>;
}
export interface Publication {
  readonly transactionId: TransactionId;
  readonly geometryVersion: number;
  readonly scene: FolderScene;
  readonly presentation: Presentation;
}
```

Live tile keys stay stable across publications. Retiring keys include source transaction and variant. Routes requiring crossfade have separate old/new render variants. Records contain data, never elements.

The controller’s sole drawable state is:

```ts
let published = $state.raw<Publication | null>(null);
```

Transaction status and cover notices are separate state because they cannot affect scene geometry.

## 3. Pure planning, composition, and diff

Keep `D/scene.ts:49` and `:99` as graph-planning primitives. Re-export the folder APIs from `scene.ts`; implement them in `folder-scene.ts` to avoid growing one module indefinitely.

```ts
planFolderScene(inputs: SceneInputs): ReadonlyMap<GraphId, BandScenePlan>;
composeFolderScene(inputs: SceneInputs, layouts: PreparedLayouts): FolderScene;
diffScenes(previous: FolderScene | null, next: FolderScene): SceneDiff;
```

Planning computes grid columns, cells, and pins **without band extents**, then constructs requests for every logical open graph. Pins depend on cover columns, not downstream band height (`V/stack-grid.ts:296`), so this has no layout/packing feedback loop.

Composition proceeds in this order:

1. Resolve host/fallback metrics using the rules at `StackGrid.svelte:60–64`.
2. Reset held-cover history when folder or column count changes; otherwise union committed held covers with newly unlisted covers. Preserve `folderCells`’ saving behavior.
3. Validate all required prepared graphs and positive finite dimensions; reject missing results, duplicate identities, token mismatch, or overflowing geometry.
4. Measure raw child/routing footprints with `bandExtent`.
5. Run `packedGridFlow` and `bandPlacements` once using exact extents.
6. Attach every open graph with `attachPackedBand`.
7. Flatten tiles, routes, junctions, cell rectangles, bands, and navigation into folder coordinates. Emit the pinned cover exactly once.
8. Compute route bounds from absolute M/L/C control-point bounds plus the existing 12px marker/stroke padding. This conservative bound replaces SVG `getBBox`.
9. Build styles and semantic edges from the same captured DAG/projection and plan.

Move pure rules into domain modules:

| Existing seam | Destination |
|---|---|
| `V/stack-grid.ts:21–156`, `:238–251`, `:296–302` | `D/folder-grid.ts`: footprint, packing, placements, attachment, pins |
| `V/stack-grid.ts:159–219`, `:229–233` | `D/folder-grid.ts`: cell collapse, creation order, synthetic cover |
| `V/stack-packing.ts:25–103` | `D/stack-packing.ts`, unchanged algorithm |
| `StackGrid.svelte:65–90` | explicit held history and pure composition |
| `StackGrid.svelte:178–184` | scene’s committed `navigation` rectangles |
| `TraceGraph.svelte:198–208`, `:228–248` | attachment and route bounds in composition |

Keep view-only roving focus helpers and listing-read coordination in `V/stack-grid.ts`, with temporary re-exports for existing tests/imports.

Do not alter visibility (`D/visibility.ts:32`) or the Phase 2 layout algorithm. Supply Phase 2’s optional request history from `published.scene.graphs.get(coverKey)?.layout`: the **raw committed** layout, never attached geometry, presentation poses, or a superseded result. Use its reading order for `hint`.

If Phase 2 defines a compact history representation, use its encoder at this boundary; the source remains the committed raw layout.

The exact diff contract is:

```ts
export type RecordPolicy = "snap" | "animate" | "carry";
export interface SceneDiff {
  readonly enter: ReadonlyMap<EntityId, SceneRecord>;
  readonly update: ReadonlyMap<EntityId, {
    readonly before: SceneRecord;
    readonly after: SceneRecord;
  }>;
  readonly exit: ReadonlyMap<EntityId, SceneRecord>;
  readonly policy: {
    readonly reset: boolean;
    readonly graphs: ReadonlyMap<GraphId, SceneChange>;
    readonly records: ReadonlyMap<EntityId, RecordPolicy>;
  };
}
```

Diff by logical identity across the complete scenes, including records outside the viewport. Compare geometry and payload independently; styling updates can occur without motion.

For each retained graph, call `classifySceneChange` at `D/scene-change.ts:45` with raw plan/layout pairs. Added or removed bands are reflows. Separately compare attached geometry: raw `restyle` does not imply an unchanged packed destination.

For displaced rows, cells, and neighboring attachments, compute a counterfactual packing using next inputs but previous extents for graphs classified `reveal`. A record snaps when its actual change disappears in that counterfactual; otherwise its spatial change animates. This preserves reveal-only snapping while allowing an independently coalesced expansion/reflow to move rows.

A reveal graph always snaps its own content and drops its retirees. Geometry-identical records carry. Scope changes and first folder publication reset presentation.

## 4. Controller and transaction boundaries

Create the controller once in `TraceView.svelte:36`, alongside the pane’s session. New `V/scene-inputs.ts` adapts host capabilities and session state into immutable domain inputs.

Subscribe to:

- Directory and pane lifetime; active/unmount lifecycle.
- Ordered listing contents and claimed-path baseline (`TraceView.svelte:57–67`).
- Host selection contents, primary focused path, Preview target, and resolved Trace focus.
- Writable picks and their reconciliation (`TraceView.svelte:195–262`).
- Requested open-cover identities from the session.
- Complete component versions, index token, refresh completion, and load errors.
- Quantized width, tile metrics, and host grid metrics.
- Badge hover for style-only updates.

Viewport changes select/prioritize work; they do not invalidate scene geometry.

### One action, including its asynchronous consequences

Expose `action(cause, operation)` where `operation(lease)` may return a promise. Begin the lease at the actual interaction boundary, before any host write or await. Nested operations reuse that lease.

Unify the stack activation callback currently split between `StackGrid.svelte:47–53` and `TraceView.svelte:498–501`: listed selection, cold activation, and expansion belong to one action. Preserve their existing host-call order.

Wrap selection, navigation, background deselection, each marquee selection frame, expansion/collapse, and programmatic reveal. Relevant seams are `TraceView.svelte:265`, `:401`, `:492`, `:536`, `:545`, `:695`, and `:758`.

Derived writes—`followSelection`, Preview rebinding, save selection, and completed activation—use `lease.derive`. They dirty the same transaction; they do not allocate another id.

Use one source-intake effect calling `controller.offer(...)`. After the action operation finishes:

1. Await `tick()`.
2. Normalize selection-following and target reconciliation.
3. Await `tick()` again if normalization wrote state.
4. Capture sources once their intake revision is unchanged and all action continuations have finished.

This is a stabilization barrier, not a timed debounce. `tick()` applies pending Svelte state; it does not wait for arbitrary RPCs, which remain explicit transaction dependencies. See [Svelte’s tick contract](https://svelte.dev/docs/svelte/svelte#tick).

External host changes, resize, listing changes, and invalidations allocate root action ids through intake. Compare contents, not object replacement. A newer unowned host choice supersedes an asynchronous activation immediately.

### Data preparation

A refresh currently publishes a new index before replacing components (`folder-session.svelte.ts:231–239`). Renderers must therefore stop reading live session data.

Add `session.acquireComponents(ids, token, signal)` returning a cancellable interest lease and fresh complete results. Share in-flight reads with pick/reveal interests; abort a queued read only after its last interest disappears. Replace the single `wanted` ownership at `:78`, `:249–271`, and `:392–398` with interest ownership.

Preparation must verify token and freshness after reads. Existing `ensure()` swallows errors, so its fulfilled promise cannot establish readiness.

For refresh transactions, collect every required open graph against one index token. On stale paging, restart the same transaction against the replacement index, bounded by the existing three retries.

For a hot selection/collapse during refresh, use the last committed coherent data snapshot when it contains the required identities. This permits interaction while revalidation is pending. A target absent from that snapshot waits for current data. Never combine an old graph with a new-token index.

All requested open bands require complete logical geometry, including offscreen bands. Nearness changes loading priority, not whether their geometry exists. Existing complete committed graphs are reused. Newly requested cold opens remain dependencies until completed or explicitly closed.

### Layout preparation and economy

Plan all open graphs cheaply, but request layouts only where geometry inputs changed:

- Component DAG/version or effective in-graph focus/visibility.
- Width, pin, tile metrics, or Phase 2 geometry request fields.
- Newly opened graph.

Badge hover, selected border changes, and out-of-component dimming reuse raw layout.

Compare the geometry basis before constructing fresh history/hint requests. Otherwise a newly committed history value would itself cause another layout request. Once the basis changes, use the complete exact signature, including history, for cache lookup.

For affected graphs use `cachedLayout`, then `layoutNow` for requests within the existing 60-item limit, otherwise `computeLayout(request, signal)` (`layout-client.ts:109`, `:147`, `:153`). Preserve Phase 2’s chosen workload-count rule.

A changed graph repacks its entire folder row and can translate later rows. Those consequences require composition/attachment, not new layouts for unaffected graphs.

### Supersession and commit

Newer actions abort preparation, release transaction interests, and supersede reveal waiters. Already-running worker computations may finish and populate the bounded cache; they cannot publish.

Immediately before commit, check lifetime, transaction id, captured source revision, and data token. If normalization changed sources, reprepare under the same id.

The commit sequence is:

```ts
const previous = published;
const diff = diffScenes(previous?.scene ?? null, nextScene);
const displayed = motion.samplePresentation(previous?.presentation ?? null);
const presentation = retargetPresentation(displayed, nextScene, diff, participants);

published = { transactionId, geometryVersion, scene: nextScene, presentation };

void tick().then(() => {
  if (!sameLifetime() || published?.transactionId !== transactionId) return;
  motion.start(published.presentation); // one invocation, before paint
  compensateAnchor();
  notifyPresented(transactionId);
});
```

Sample before cancellation. Render the first poses and retirees in the same publication. The `tick()` continuation installs native effects in that commit’s microtask checkpoint; no rAF separates publication from motion startup.

Guard by **published id**, not merely newest preparing action: the committed scene remains valid while another action prepares. If another publication replaces it before the flush, the older callback starts nothing.

Restyle commits update payloads without restarting tracks. Presentation settlement/retiree cleanup replaces presentation while retaining the same scene and geometry version; it is not another geometry commit.

### Delete the old publication paths

| Delete | Current seam |
|---|---|
| `covers` state and `geometry()` publication | `StackGrid.svelte:39`, `:162–167` |
| `ongeometry` props/calls/wiring | `TraceGraph.svelte:37`, `:106`, `:132`; `StackGrid.svelte:22`, `:138`, `:237`; `TraceView.svelte:803` |
| Estimated extent and reservation branch | `V/stack-grid.ts:11–18`; `StackGrid.svelte:81–84` |
| Grid `pendingMotion`, capture/start effect, owned local running list | `StackGrid.svelte:54–56`, `:123–141`, `:161` |
| Leaf planning/layout/commit effects and readiness callbacks | `TraceGraph.svelte:84–174` |
| Attachment serials and layout stamps used to infer motion | `TraceGraph.svelte:89`, `:198–208`, `:271` |
| `pendingLayouts` and graph callback wiring | `TraceView.svelte:73–74`, `:804` |
| rAF readiness polling and committed graph WeakMap | `TraceView.svelte:94`, `:304–354`, `:415–422` |
| Multi-graph anchor microtask workaround | `TraceView.svelte:77–84`; replace with one post-start notification |
| Band loading/arranging placeholders | `StackGrid.svelte:241`; `TraceGraph.svelte:312` |

Notify marquee hit-testing once after a folder publication’s motion setup, replacing the multiple geometry callbacks.

### Step 4 as implemented: deviations

Recorded where step 4 departs from the text above, with the reason.

- **Whole-folder worker message.** `layout.worker.ts` accepts `{ id, folder: FolderLayoutInput }` and replies `{ id, folder: FolderLayout }`, running the memoised default engine; `computeFolderLayout` in `layout-client.ts` sends it (abort rejects at once, a late reply is dropped, no worker means a main-thread fallback). The controller lays out a complete folder per transaction, so sending band requests one by one would split the engine across threads. The per-request path (`computeLayout`) stays for other callers.
- **Inline rule.** `folder-layout-runtime.ts` shares one band cache across panes and runs a folder inline when Phase 2's `canLayoutInline` holds for every band request the run would actually compute (`uncachedBandRequests`). Bands computed in the worker are seeded into that cache (`rememberBands`), so the next inline run reuses them.
- **Band basis reuse in the engine.** `planBands` keeps a band's committed raw layout when its request differs from the committed one only in history and hint. This is the "compare the geometry basis before history" rule, applied per band inside the default engine, so committing one band's new geometry does not send an unchanged band through a fresh layout. The parity test models the rule. `layout:eval` geometry rows are unchanged. The controller also skips the engine entirely when nothing the engine reads has changed (`layoutBasis`).
- **Transaction state.** `SceneTransaction.intent` carries the captured `SceneIntent`, not a prepared `SceneInputs`. Prepared engine input stays internal to the controller (`prepareLayoutInput`).
- **Legacy grid motion.** Until step 5, the controller calls `playGrid` through `attachMotion({ sample, start, snap })`, once per geometry commit. Its carry/snap decisions read per-band `data-layout-stamp` (raw layout) and `data-attachment` (attached geometry) stamps, which are now hashed from the published scene instead of serials kept by each graph.
- **Hot causes.** Selection, collapse, resize and metrics may commit on the committed snapshot while current data is loading. A continuation transaction (`refresh` or `expand`) then completes the current data.
- **Restyles.** A publication whose styling contents changed is published even when no record changed, because reference badge selection is read from styling.
- **Deadline.** Each cover gets 5,000 ms from the moment it becomes pending (requested, not committed, not blocked), covering both data and layout. It is not a deadline per transaction. When it expires, the cover fails, the transaction is woken and commits without that cover, and the running worker job's reply is dropped.
- **Failed cover disclosure.** Clicking the disclosure of a failed cover dismisses the failure (its label is "Dismiss stack error"); the next click is the explicit reopen. Retry in the cover reopens directly, resolving the stable key against the current index.
- **First scene.** "Loading Trace…" is inserted only after 400 ms without a first scene, so a view remounted over cached data never shows a loading frame.
- **Reveal waits.** `whenPresented` accepts reference badge keys as well as tiles.
- **Not implemented.** There is no watchdog for a running worker computation beyond the cover deadline. Notices carry one phase (`loading` or `arranging`) for every pending cover of the transaction.
- `folder-layout/types.ts` is unchanged.

## 5. Cold expansion and failure

The committed cover stays in place. Its thumbnail receives an absolutely positioned loading spinner; the cover has `aria-busy="true"` and an accessible “Loading stack” status. No child band, background band, estimated footprint, or following-row displacement appears.

Show visual progress after 400 ms, preserving the current fast-load restraint. Accessibility busy state is immediate. Loading and arranging use the same overlay position and never resize the cover.

The disclosure’s `aria-expanded` reports the committed scene. While pending, clicking it cancels the requested open; its accessible label becomes “Cancel opening stack”.

Give preparation a 5,000 ms deadline, covering data and layout. On success, publish the completed band and displacement together. On error or timeout:

- Abort the transaction; retain the last scene.
- Replace the spinner with an in-cover error indicator and Retry control.
- Reject its reveal waiter with the actual error/timeout.
- Block that failed opening attempt until Retry, explicit reopening, or a new targeted reveal.
- Ignore late results for publication. Background completion cannot silently reopen it.

Retry resolves the stable cover/node key against the current index, since component ids may have merged. Closing clears notices immediately without awaiting a worker.

Use a view-level overlay for refresh/index failures. Replace the flow-affecting notice at `TraceView.svelte:806`; error/progress UI must not change scene or scroll geometry.

## 6. Presentation and native motion

Replace DOM snapshot inference at `motion.ts:89–106`, `:164–214`, and `:936–979`. Remove cloning/appending at `:514–554`, `:576–666`, and `:1088–1159`.

Svelte renders keyed live records, retiring records, and HTML route layers. Retirees are inert, `aria-hidden`, absent from selection/navigation selectors, and contain passive visuals. Extract tile visual content from `TraceTile.svelte:65–105`; do not instantiate its tooltip/action ownership (`:49–58`) or disclosure controls for retirees.

Retain test compatibility attributes such as `data-motion-ghost` and `data-motion-route-layer`, but they describe model-owned records.

### One clock

Each spatial publication has one presentation epoch. Compile all tracks into native effects created synchronously in `motion.start`. Every effect has the epoch’s common duration; shorter tracks hold their final values. Select one created native animation as the epoch clock and read its `currentTime` once per sample.

Do not assign `startTime` or use task-captured timeline time as a start time. Pending effects sample their inline first pose. The browser resolves readiness; this respects the [Web Animations pending-play model](https://www.w3.org/TR/web-animations-1/#playing-an-animation-section).

Retarget changed destinations from sampled displayed poses over 160 ms. For unchanged active destinations, slice the old track at the sampled time and preserve its remaining trajectory:

- Insert the sampled pose at time zero.
- Subtract the sample time from later frame times.
- Slice the current easing segment; do not restart its original easing.

For normalized segment position `u`, the remaining easing is  
`g(v) = (E(u + (1-u)v) - E(u)) / (1-E(u))`. Obtain an equivalent cubic using Bézier subdivision and normalized remaining control points. Handle finished/constant segments directly.

Restyle publications leave the epoch running. Reveal removes only the relevant owned tracks/retirees and snaps affected records. Reduced motion clears owned presentation effects and displays target poses.

Preserve property ownership tokens from `motion.ts:43–76`. Old `ready`/`finished` callbacks cannot clear replacement inversions. Restore dimensions from scene records, replacing the SVG-attribute recovery at `:62–64`.

### Connectors and interruption

Retain the native HTML edge-layer policy at `motion.ts:351–405`, with Svelte-authored SVG contents:

- Exact rigid translations travel with endpoints.
- Rerouted connectors crossfade between exact old/new paths; never interpolate band `d`.
- Tile entrances and incident connectors share the current arrival-opacity interval.
- Exiting tile/connector groups share departure opacity and clip.
- Closing clips start from sampled displayed extent, including partial opening.
- Reopening takes over the retiring identity’s sampled pose and removes its duplicate.

Compute compatibility from stored exact paths and modeled endpoint displacements. Use `routeFadeWindow` (`motion.ts:82`) and `departureVisibility` (`band-motion.ts:81`) as pure helpers.

Above 200 paintable retiring records, snap departures for that publication, matching the existing bounded-departure intent at `motion.ts:506`.

### Remaining DOM reads

DOM reads are restricted to:

- Pane/scroller/grid origin, zoom, and actual scroll offsets for viewport conversion and browser scroll clamping.
- Actual anchor screen offset and focus/`scrollIntoView` targets.
- Registered render handles used to apply native effects.
- A single modeled moving HTML participant as a compositor-progress calibration probe at interruption, where WebKit’s displayed native transform differs from the clock sample after a stall. Infer one epoch progress and resample all records from the model; never capture individual record geometry.

No DOM read establishes membership, layout, route shape, retirement identity, or readiness. Native tests must exercise pending readiness and main-thread stalls to validate that calibration.

## 7. Viewport, anchoring, and lifecycle

Windowing selects records from `published.scene`, retaining the existing 1,200px grid and 800px large-graph margins (`StackGrid.svelte:98–121`; `TraceGraph.svelte:176–195`).

At commit, choose motion participants from records intersecting the viewport margin, focused/selected records, and already active participants. Pin those participants through settlement. Other records receive target poses and no tracks.

A later viewport mount displays the target pose and creates no effects. It cannot appear in `diff.enter`, change the transaction, or restart a clock. Navigation uses `scene.navigation`, including unmounted logical tiles.

Keep pointer hold capture before host selection (`TraceView.svelte:406–409`). Update it once after motion startup, then during active presentation. Replace `viewMoving()` scanning at `motion.ts:731` and anchor-loop scheduling at `:842` with controller presentation activity.

Preserve user-scroll release, zoom conversion, and clamped adjustment behavior in `holdAnchor` (`motion.ts:753–840`). Account for old/new viewport-origin displacement after a shrinking grid clamps scroll, as the current grid does at `:982–983`. Camera compensation belongs to the presentation adapter and must also affect interruption samples.

Reveal waits become `controller.whenPresented(id, key, signal)` followed by `whenSettled(id, signal)`. These resolve from commit/start and owned-effect completion events. Force the focused record mounted, then perform nearest scrolling and focus. Abort/failure/supersession reject immediately; card CSS transitions and spinners do not delay reveal.

On directory change or unmount, increment lifetime generation, abort preparation/waiters, cancel owned effects, clear retirees/notices, and release anchors. Reset synchronously before the new folder can paint (`TraceView.svelte:147`, `:773`; session lifetime at `folder-session.svelte.ts:369–403`).

Persist a bounded, immutable **committed scene** per pane/folder, alongside existing folder snapshots (`folder-session.svelte.ts:40–59`, `:129–141`). Strip incoming request-history references from the saved copy. Restore matching-width/metrics scenes with empty presentation and a new lifetime, then revalidate. A differing width recomposes/recomputes from the cached coherent data and snaps.

Preserve the existing `<300 ms` same-tab restoration contract at `e2e/tab-switch.spec.ts:24–35`. Never restore another folder’s scene, even when component ids match.

## 8. Migration and tests

Each step is a green intermediate commit. Add new assertions when their corresponding path becomes active.

| Step | Change | Guards |
|---|---|---|
| 1 | Extract domain grid/packing and shared data types; keep compatibility exports and legacy behavior. | Existing `stack-grid`, `stack-packing`, `band-layout`, and geometry unit tests; existing compact-layout e2e. |
| 2 | Add component provenance and interest leases; preserve existing `ensure` facade. Add scene snapshot storage and budgeting. | `folder-session.test.ts`: complete paging, token changes, failure propagation, independent interests, cancellation; `folder-snapshots.test.ts`: eviction/lifetime. |
| 3 | Add pure folder planning/composition/diff, initially unused by rendering. | New `tests/domain/trace-graph/folder-scene.test.ts` and `folder-scene-diff.test.ts`: exact parentage, single cover, packing/attachment parity, held saving, mixed reveal/reflow, invalid dimensions, missing layouts, empty scene, duplicates, immutability. |
| 4 | Activate controller and scene-driven render props; remove leaf publication/packing. Temporarily call legacy grid motion once from the controller. Move cold progress to covers. | New `e2e/scene-transactions.spec.ts`: atomicity, coalescing, held data/worker replies, supersession, close, timeout/retry. Replace obsolete reservation/progress assertions. |
| 5 | Replace snapshot motion with presentation tracks and keyed passive retirees. | New presentation sampling/retarget unit tests; new `e2e/scene-interruption.spec.ts`; existing band motion, selection blink, CSS ownership, scrollbar and stall tests. |
| 6 | Switch windowing, reveal readiness, lifecycle, and restoration to controller contracts; remove legacy callbacks/driver. | New `e2e/scene-windowing.spec.ts`; extend `tab-switch.spec.ts` and `job-reveal-cost.spec.ts`; full graph/selection/marquee suites. |

New `tests/plugins/trace/scene-controller.test.ts` uses controllable data/layout promises and the existing Svelte test host. Assert observable publications and outcomes: zero partial publications, one accepted result, no obsolete result, correct errors, committed-only history, and no unnecessary layout requests.

### Harness gates and frame instrumentation

Extend existing backend gates at `e2e/harness/view-fixture.ts:213–215`, `:281–285`, and `:596–599`:

- Keep `holdFolderReads()` / `releaseFolderReads()` and `holdNodeReads()` / `releaseNodeReads()`.
- Add selective predicates for directory, component, and page offset.
- Expose held-request metadata; add `releaseNextNodeRead()` and controlled rejection.
- Capture reply data at request time, preserving current protocol behavior.

Add a **worker-response** gate, replacing ad hoc send interception at `e2e/stack-grid.spec.ts:1017`:

- Extract worker construction from `V/layout-client.ts:90` into `V/layout-worker-factory.ts`.
- Alias that factory in `e2e/harness/vite.config.ts:6` to a harness wrapper.
- The wrapper runs the real worker, but holds delivery of its `message` response.
- Expose `holdLayoutReplies(predicate)`, `heldLayoutReplies()`, `releaseNextLayoutReply()`, and `releaseLayoutReplies()` through `view-main.ts:19`.
- Preserve reply ids/errors and restore/reset gates between tests.

Expose a harness-only event sink for action begin, geometry publication, motion start, failure, and settlement. Include transaction id, scope, geometry version, and graph request keys. Do not infer motion starts by counting individual `Element.animate` calls.

Frame sampling follows `selection-blink.spec.ts:17–46`: sample after frame callbacks and force actual presentation opportunities. For each geometry-changing action assert exactly one geometry publication and at most one motion-start invocation; no-op/restyle actions permit zero geometry publications.

Required scenarios:

- Hold a node page after a new index arrives; old tiles, routes, cells, and bounds remain one scene.
- Release data but hold worker response; geometry remains unchanged until the complete commit.
- Expand/select in one action; derived expansion and node completion do not create additional commits.
- Supersede A with B, deliver A last; only B publishes and only committed history feeds B.
- Interrupt expansion/collapse/reopening before readiness and at intermediate progress; first replacement pose differs by ≤0.5 CSS px and opacity by ≤0.01, with attached visible ports.
- Timeout, then release held replies; no automatic late opening. Retry after a component merge succeeds by stable identity.
- Switch folder/tab during motion and pending work; no old-scope retirees or effects appear.
- Scroll through windowed content during active motion; newly mounted records have target pose, with no new geometry publication or motion start.

Update `e2e/stack-grid.spec.ts:1011–1101`, which currently requires a reserved cold band, and `e2e/progress-delay.spec.ts:16–35`, which requires progress inside that band. Preserve their latency/no-replay coverage with the new cover-only contract.

Keep `selection-blink.spec.ts`, `band-motion.spec.ts`, `motion-scrollbars.spec.ts`, `graph.spec.ts`, `marquee-selection.spec.ts`, `ai-edit-inputs.spec.ts`, and `job-reveal-cost.spec.ts` green.

Run the repository’s full check/unit/Rust/browser/package suite, Chromium and WebKit browser coverage, and the native alternating-selection/interruption harness. Use a temporary alternate-port Playwright configuration. An independent adversarial review is required before merge because publication and selection integration change.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scroll anchoring or bottom-scroll clamp jumps | Capture before host writes; compensate after the single motion setup; model camera displacement; retain existing user-scroll/clamp contracts and native frame tests. |
| Selection/picks regressions | Preserve host-first calls and fresh writable-derived picks at `TraceView.svelte:204`, `:258`; action leases coordinate rendering without becoming selection authority. Keep Shift, modifier, save, Preview, and marquee outcome tests. |
| Cold/all-open preparation latency | Reuse committed layouts, cache results, inline small work, prioritize targeted rows, show bounded cover progress, and permit immediate close. Hot actions during refresh use a coherent committed snapshot. |
| Superseded worker blocks current work | Drop aborted queued jobs immediately (`layout-client.ts:135–142`). Reject an aborted caller independently of its running computation. Add a 5s running-worker watchdog: terminate the wedged worker, create a replacement, and requeue still-live jobs; one retry per job, then fail. Guard callbacks by worker generation. |
| Worker fallback blocks a frame | Replace the synchronous batch fallback at `layout-client.ts:80–83` with the existing yielded fallback path, one job per yield, checking cancellation before each computation. |
| History/cache memory growth | Retain at most 48 layout entries and add a 16 MiB estimated-byte budget including signature strings; oversized results are returned uncached. Store no scene back-pointers. Scene snapshots use an independent 8-entry/16 MiB LRU; presentation holds only active/pinned records and ≤200 retirees. |
| Native clock/model divergence | Common epoch, exact residual easing, inline pending poses, one compositor calibration sample, owned cleanup tokens, and Chromium/WebKit/native stall tests. |
| Late results resurrect failed or old-folder content | Token provenance, action/lifetime guards, blocked failed opening attempts, cancellable interests, and explicit late-reply harness tests. |