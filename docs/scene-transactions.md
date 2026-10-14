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

**One unreadable stack never blocks the folder.** Every component read a transaction waits for is a dependency of one cover, whether that cover is opening or already drawn open and being read again for a new index. If the read fails, or misses the 5,000 ms deadline (§5), that cover fails and the transaction commits everything else:

- The failed stack is drawn **closed** with its in-cover error and Retry. Its committed graph is never kept beside the new index: that would combine an old graph with a new-token index.
- It stays requested open, so Retry reopens it. A failed *re-read* of an open stack is also read again by the next index, so a later refresh reopens it. A failed cold open waits for Retry (§5).
- It is not a view failure: no overlay, and later transactions do not depend on it.

Reading an open stack again is silent: its cover shows no progress while the committed band stays drawn.

### Layout preparation and economy

Plan all open graphs cheaply, but request layouts only where geometry inputs changed:

- Component DAG/version or effective in-graph focus/visibility.
- Width, pin, tile metrics, or Phase 2 geometry request fields.
- Newly opened graph.

Badge hover, selected border changes, and out-of-component dimming reuse raw layout.

Compare the geometry basis before constructing fresh history/hint requests. Otherwise a newly committed history value would itself cause another layout request. Once the basis changes, use the complete exact signature, including history, for cache lookup.

For affected graphs, reuse the band cache, then lay out inline when every band request the run would compute is within Phase 2’s workload rule (`canLayoutInline`), otherwise run the whole folder in the worker (`computeFolderLayout`); see “Step 4 as implemented”.

A changed graph repacks its entire folder row and can translate later rows. Those consequences require composition/attachment, not new layouts for unaffected graphs.

### Supersession and commit

Newer actions abort preparation, release transaction interests, and supersede reveal waiters. A worker layout is aborted as soon as it can no longer be the one that commits: on supersession, when a cover deadline or new data changes what is laid out, and when its transaction ends. A computation already running in the worker cannot be stopped; it is bounded by the worker watchdog (§9) and can never publish.

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

- **Whole-folder worker message.** `layout.worker.ts` accepts `{ id, folder: FolderLayoutInput }` and replies `{ id, folder: FolderLayout }`, running the memoised default engine; `computeFolderLayout` in `layout-client.ts` sends it (abort rejects at once, a late reply is dropped, no worker means a main-thread fallback, one job per frame). The controller lays out a complete folder per transaction, so sending band requests one by one would split the engine across threads. The per-request path (`computeLayout`, `layoutNow`, `cachedLayout` and the worker's band message) had no callers left and is removed.
- **Inline rule.** `folder-layout-runtime.ts` shares one band cache across panes and runs a folder inline when Phase 2's `canLayoutInline` holds for every band request the run would actually compute (`uncachedBandRequests`). Bands computed in the worker are seeded into that cache (`rememberBands`), so the next inline run reuses them.
- **Band basis reuse in the engine.** `planBands` keeps a band's committed raw layout when its request differs from the committed one only in history and hint. This is the "compare the geometry basis before history" rule, applied per band inside the default engine, so committing one band's new geometry does not send an unchanged band through a fresh layout. The parity suite's reference pipeline does not model the rule: it checks the engine where the rule cannot apply (fresh displays, and history tours in which every band's request changes), and the rule is tested by itself against the engine's output. `layout:eval` geometry rows are unchanged. The controller also skips the engine entirely when nothing the engine reads has changed (`layoutBasis`).
- **Transaction state.** `SceneTransaction.intent` carries the captured `SceneIntent`, not a prepared `SceneInputs`. Prepared engine input stays internal to the controller (`prepareLayoutInput`).
- **Legacy grid motion.** Until step 5, the controller calls `playGrid` through `attachMotion({ sample, start, snap })`, once per geometry commit. Its carry/snap decisions read per-band `data-layout-stamp` (raw layout) and `data-attachment` (attached geometry) stamps, which are now hashed from the published scene instead of serials kept by each graph.
- **Hot causes.** Selection, collapse, resize and metrics may commit on the committed snapshot while current data is loading. A continuation transaction (`refresh` or `expand`) then completes the current data.
- **Restyles.** A publication whose styling contents changed is published even when no record changed, because reference badge selection is read from styling.
- **Deadline.** Each cover gets 5,000 ms from the moment it becomes pending, covering both data and layout. Pending means requested, not blocked, and not drawn open from current data, so it covers cold opens and re-reads of open stacks for a new index alike: every data dependency of a transaction has a deadline. It is not a deadline per transaction. When it expires, or the read fails, the cover fails as described in §4 ("One unreadable stack never blocks the folder"): the transaction is woken and commits without that cover, drawn closed with its error, and a worker job laid out with it is aborted.
- **Failed cover disclosure.** Clicking the disclosure of a failed cover dismisses the failure (its label is "Dismiss stack error"); the next click is the explicit reopen. Retry in the cover reopens directly, resolving the stable key against the current index.
- **Cover press.** Only the disclosure closes a requested stack or cancels a pending open. Pressing the cover of a stack that is not drawn open selects it, and opens it if it is not requested; pressing it again while it is still opening (a double-click on a slow folder) selects and keeps it opening.
- **View failures.** Only what is not one cover's fault fails the transaction and shows the view overlay: an exhausted stale-index restart, a layout that fails or is retried out by the watchdog. The overlay clears when a scene of current data commits (not one on the older committed snapshot), or on its Retry.
- **Action operations.** An operation that throws synchronously fails its transaction with that error (instrumented, rethrown to the caller) and never leaves it current; whatever it wrote first is committed by a transaction of its own. An asynchronous operation is awaited for at most the 5,000 ms preparation deadline, through the controller's injected timer. After that the transaction prepares and commits the current intent, and the operation's later writes are changes of their own. External listing, resize, metrics and data changes arriving while an operation runs are therefore never lost: they are read when the transaction captures the intent.
- **First scene.** "Loading Trace…" is inserted only after 400 ms without a first scene, so a view remounted over cached data never shows a loading frame.
- **Reveal waits.** `whenPresented` accepts reference badge keys as well as tiles.
- **Worker watchdog.** Implemented as §9 describes: a worker still computing one job after 5,000 ms (`WORKER_WATCHDOG_MS`), whether its caller aborted or not, is terminated and replaced; the queue continues on the replacement, a still-live job is retried there once and then fails, and callbacks of a retired worker are ignored (guarded by worker identity).
- **Not implemented.** Notices carry one phase (`loading` or `arranging`) for every pending cover of the transaction.
- `folder-layout/types.ts` is unchanged.

### Step 5 as implemented: deviations

Recorded where step 5 (§6, presentation and native motion) departs from the text, with the reason.

- **Modules.** Pure model and retargeting: `V/presentation.ts`. What renderers draw, memoised per presentation (`presentationView`: layered live connectors per graph, in-band retirees, exit groups): `V/presentation-view.ts`. Keyed element registry (`createRenderHandles`, Svelte `{@attach handles.attach(key)}`; keys are record ids, retiree render ids, `section:<graph>`, `layer:<record>`, `grid`): `V/render-handles.ts`. Native driver (`createSceneMotion`) plus the pure compilers it uses (`compileTrack`, `keyframesOf`, `cssEasing`): `V/scene-motion.ts`. `motion.ts` keeps only viewport and anchor helpers (`prefersReducedMotion`, `zoomOf`, `viewMoving`, `isAnchorScroll`, `holdAnchor`, `scrollsByUser`).
- **Controller seam.** `SceneMotion` is `{ sample(p): DisplayedPresentation; reduced(); start(p): { started, settled }; snap() }`. A geometry publication is `retargetPresentation(motion.sample(previous), …)`. A reset, a first scene, or no attached driver publishes `staticPresentation`. A restyle publishes `restylePresentation`, which keeps the running epoch. Each epoch starts once, after its first publication rendered. `motion-start` is emitted only when native effects were created. A publication that leaves nothing to move (for example, interrupted before anything was displayed moving, back to where it began) starts nothing and emits `settled` at once. When an epoch's effects finish, the controller replaces `published` with `settledPresentation` (retirees dropped, every record at its target) and emits `settled`.
- **Every geometry publication recompiles every effect.** Unchanged running tracks are sliced at the sampled time (the remaining easing is sliced, not restarted) and get new native effects on the new clock, so they continue on exactly the same trajectory. Their original native animations are not kept, so tests check the displayed trajectory, not the identity of the animation.
- **Participants.** Step 5 treats every record as a participant. Restricting this to a viewport (§7) is left to step 6.
- **Compilation.** A record that moves inside its stack's section is compiled relative to the section's motion (`compileTrack(track, base, frame)`). The result is exact when both share an easing or one side is still. Otherwise it is refined into linear segments, within 0.1 px and 0.002 opacity. Shorter tracks hold their final values to the common duration. Clips are absolute `polygon()` in the element's own box. Rows animate `translateY` with `scaleY` from their top.
- **Sections and covers.** A section's effect is the cover's vertical motion only; the cover's cell takes its sideways motion within the section. Covers and entries translate, and their size snaps. A graph's canvas and the grid change size at once (no width or height animation), and band records that ride exactly with their section get no effect of their own.
- **Exit groups.** A closed band's retirees render in `RetiringBand`, a grid-level `[data-grid-exit]` container of height 0 with `contain: layout`. Exits therefore never hold scroll extent: scrolling clamps at commit, and a camera effect on the grid eases from the sampled origin to the new one. The container does not move. Its group track carries the shared fade and clip, and its bottom follows its members' displacement relative to the cover (`bandShift`), so a band sharing a row still clips to zero.
- **In-band retirees** (departed tiles and old routes in a band that stays open) render in that band's graph and keep their own tracks. They are not carried with later band motion.
- **Live records** are rendered from scene records at their targets. The driver writes each effect's first frame inline (with ownership tokens) before creating it, so a pending effect shows its first pose. Live connectors that move differently from their section are drawn in `[data-motion-route-layer]` HTML layers, and their SVG source is hidden at opacity 0 while the layer lasts.
- **Arrivals.** A connector to or from an arriving tile takes that tile's opacity track (`withOpacityOf`), which is checked before continuation.
- **`RetiringRecord.branch`.** Added: whether the graph had focus when the record retired, which decides the connector tone a retiring route keeps.
- **Reveal** snaps the revealed graphs whole: their records take their targets and their retirees are dropped. Everything else is retargeted from sliced tracks as usual.
- **Calibration probe.** One section, or a single-segment entry track, is bisected against its displayed offset when the clock and the compositor disagree by more than 0.5 px.
- **Retiree visuals.** A retiring tile draws `TileVisual` only (card, contents and hint). Reference badges and output actions are not drawn.
- **Left in place.** The travel helpers in `band-motion.ts` and some path-sampling helpers are no longer used by the app.

### Step 6 as implemented: deviations

Recorded where step 6 (§7, viewport, anchoring and lifecycle) departs from the text, with the reason. No legacy publication callback or motion driver remains: the controller publishes, `createSceneMotion` drives, and every other module reads the controller.

- **Participants** (`V/participants.ts`, `motionParticipants`). One margin, `PARTICIPANT_MARGIN` = 1,200 px (the grid's window margin, which covers the 800 px large-graph window), around the viewport `SceneMotion.viewport()` reports in folder coordinates. A record takes part when its target *or its displayed pose* is in that area, when it is selected or the focused tile, or when its track has not ended at the sampled time; a departing record by its displayed pose. No viewport (unmeasured, or not a finite rectangle) means every record takes part. `SceneMotion` gained the optional `viewport()` for this.
- **Riders.** A non-participant band record of a section that moves is not snapped: snapping it would tear it from its cover, which may be on screen. It gets a "rider" track, its section's vertical motion only (`ridesWithSection`), so it draws no effect of its own and is not pinned. Only moving participants and retirees are in `presentation.pinned`; a restyle keeps the epoch's pins.
- **Windowing.** `StackGrid` mounts cells near the viewport, the keyboard stop, the focus, and pinned cells (`pinnedCell`, `presentationView(...).pinnedGraphs`). `TraceGraph` keeps its own 800 px window and additionally keeps pinned tiles, routes, junctions and the tiles a badge focus names. A cell or tile mounted later renders its record's target (or the sampled pose of a rider), creates no effect and is not in any diff. Keyboard navigation reads `scene.navigation`, so it reaches unmounted tiles, which then mount at their targets.
- **Presentation activity.** The controller exposes `moving` (an epoch is running) and `whenIdle()`; `afterPresentation` and `anchorLayoutChanged` are removed. `viewMoving()` is removed. `motion.ts` keeps a registry instead (`presentationActivity(activity)` attachment on the grid, `activityOf(element)`), through which the tooltip and the marquee ask whether the presentation moves, without scanning `getAnimations()`.
- **Anchors.** `holdAnchor(scroller, element, { moving, onRelease })` no longer observes DOM mutations or resizes: layout changes only by publication, so `TraceView` calls `update()` once after each publication's motion started (`onPresented`), and one frame loop follows while `moving()`. Capture before host selection, user-scroll release, zoom conversion and clamped adjustment are kept.
- **Camera.** Modelled at sampling: an epoch stores the camera shift its grid-origin effect applies (`cameraAt(shift, at, duration)`), and `sample()` corrects the sampled grid origin from the clock's value to the calibrated displayed camera, so an interruption after a clamped scroll continues from where things are drawn.
- **Reveal** awaits `whenPresented(id, key, signal)` then `whenSettled(id, signal)`; it never polls frames. Abort, failure and supersession reject on the next task while motion is still held; CSS animations and transitions (including endless ones) do not delay it.
- **Lifecycle.** `controller.enter(directory)` starts a new lifetime synchronously; `TraceView` calls it from `$effect.pre`, before the new folder renders. `resetScope` also clears the intent and data and makes the lifetime restorable.
- **Controller state is plain.** Svelte gives an effect's teardown the values the effect last saw. `StackGrid`'s motion detach, run as the old folder unmounts, read the old publication through `$state` and republished it settled, so the new folder briefly drew the old folder's scene (with the old focus and selection styling). The controller's `published`, `transaction`, `notices` and `failure` are now plain variables; reactive copies, written by `expose()` after each change, are only what the getters return.
- **Restoration** (`V/scene-snapshots.ts`). Option `scenes` (the shared `sceneSnapshots`, an independent LRU of 8 entries and 16 MiB, cleared with the folder snapshots). Every commit saves `{ paneId, scene, intent, data, history, basis }`, with request history stripped (`stripHistory`) and guarded by the store's epoch. `restoration(saved, paneId, intent)` returns "present" when pane, folder (scene, intent, index and history all agree) and geometry (`sameGeometry`: width, tile and grid metrics, cover chrome) match, "recompose" when only geometry differs, and null otherwise or before the pane has a width. "Present" commits the saved scene rebound to the new lifetime (`rebind`) with a static presentation; "recompose" lays out the saved data. Both then run a `restore` transaction to revalidate. `restore` is a hot cause, and may lay out the saved data before the index is read again. The byte estimate counts the component data a saved scene keeps alive, so an evicted folder snapshot cannot leave it unbounded.
- **Removed.** The travel helpers in `band-motion.ts` (`departureVisibility` stays), `displace` and `interpolatePath` from the domain `path-sampling.ts`, and the view's `path-sampling.ts` re-export. `resample` and `samplePathString` stay (geometry tests use them); `layout-eval/baseline/path-sampling.ts` is a frozen baseline.
- **Changed tests.** `motion.test.ts` anchor tests assert explicit `update()` compensation instead of observer-driven idle compensation, and presentation activity instead of the infinite-spinner case. Band-motion and path-sampling tests of the deleted helpers are removed. An existing tab-switch test now also asserts that the mirror folder draws no tiles before its own reads return.

### Review fixes (099e72f)

Fixes for the independent review of 099e72f, with where they depart from the text above.

- **Restoration uses the pane's current intent** (supersedes "Restoration" in Step 6). `restoration`'s "present"/"recompose" and `rebind` are replaced by `restoredInput(saved, paneId, intent, current)` (`V/scene-snapshots.ts`). It lays out the pane's *current* intent (selection, focus, badge hover, open stacks, listing, width, metrics) on the saved coherent data, with any component the session holds fresher under the same index standing in for the saved one. The saved layout is reused only when the prepared layout basis equals the saved one. Otherwise the controller lays the input out inline before the first frame, or, when it is too large to run inline, publishes nothing until the `restore` transaction's worker layout replies (the view stays blank, without a loading frame, under 400 ms). So the first painted frame shows the pane's own selection, focus and hover; nothing stale is presented and then corrected.
  - The saved scene is not used when the session already knows a newer index, or when the listing changed while the index is unknown. The folder is then prepared as a first scene.
  - A requested stack whose data is in neither the saved scene nor the session is laid out closed, as a cold open is (it was drawn so when it was saved). It opens when its read completes.
  - Every commit by a `restore` transaction snaps (static presentation), including revalidation that changes the scene before anything else happened.
  - Not covered: a newer index discovered only after the return (no session snapshot of the index, or a re-read that finds changes) commits as a `refresh`, with the usual reflow motion. The scene shown until then was the last known one, not one known to be stale.
- **Saved scenes are written only when what a restore reuses changes**: the layout, the data (index and component objects), the listing or the held history. A restyle (selection, badge hover) no longer runs `stripHistory` or the byte estimate. Styling is never read from a saved scene.
- **Presentation bookkeeping.** A commit's motion setup accepts its publication by transaction id, so a presentation-only replacement (`settledPresentation` swapped in before its tick) still starts or skips the epoch correctly, and always clears its `presenting` mark. `whenPresented` and `whenSettled` no longer hang after such a replacement.
- **Windowing is a function of the displayed scene** (supersedes "Windowing" in Step 6). New `V/scene-window.ts` is pure: given the published presentation, the epoch time it is displayed at, and the displayed viewport in folder coordinates (grid origin, so the running camera is included), it returns the grid's window and each band's canvas window. A band is placed at its cover's top, moved by its section's sampled vertical motion.
  - `StackGrid` measures the viewport (`SceneMotion.viewport`) and the displayed time (`SceneMotionDriver.displayedAt`, the driver's calibrated clock). It measures on scroll (synchronously), on resize (next frame), after every publication (including restyles and settled replacements), after every motion start (`onPresented`), and on every frame while `controller.moving`. It passes each band's window to `TraceGraph` as primitives.
  - `TraceGraph` measures nothing. Neither component has an effect that reads its own window state, so no ResizeObserver feedback loop is involved.
  - A measurement taken for an older epoch reads as time 0 of a newer, unstarted one: a new publication's first render uses its first poses, and is measured again before paint.
- **Retiree limit.** When `RETIREE_LIMIT` drops a publication's departures, the arrivals that would have followed them are shown at once instead (a rider track: the section's motion only, opacity 1). These are a rerouted connector whose old path was dropped, a tile whose node departed from another band, and the connectors arriving with such a tile. Nothing shown goes invisible and comes back.
- **In-band retirees of a band that closes** keep their own tracks. While no open band draws their graph, `presentationView(...).orphans` lists them. `StackGrid` draws them in folder coordinates (`RetiringRecords.svelte`, which holds no scroll extent, like `RetiringBand`). The driver compiles them relative to no section. When the band reopens, it draws them again.
  - They are not joined to the closing band's exit group. A reopening would then leave the old connector paths in that group without their tiles.
- **Returning records.** `motionParticipants` includes a record whose identity has a retiree still shown. The record takes over the retiree's pose wherever the viewport is, so a returning record always takes part and no tile is ever drawn twice (a non-participant return, which would leave both copies, is unreachable).

### Native findings fixes

Frame-by-frame verification in the native WebKitGTK host (on 099e72f) found motion and frames nobody asked for: a return replaying an expansion (B), folder arrivals animating (S6), width changes reflowing with motion (S6/S8), and a fullscreen Preview's exit drawing a wider layout cut into the pane, then animating (S7). Product rule: no blink of any kind; motion only for spatial changes the user initiates.

**Motion policy** (`geometryMotion` in `D/scene-change.ts`, applied by the controller at commit; superseded by the input policy in "Review fixes (dc33274)": the table below is what each cause typically changes, no longer how motion is decided, and Retry now animates). A restyle (no geometry change) keeps whatever motion runs. A geometry publication:

| Cause | Motion |
|---|---|
| `expand`, `collapse` (the user opens or closes a stack, including a cold open completing) | animate |
| `selection` (selection-driven reflow, host selection included) | animate |
| `reveal` (Show image: opens the image's stack and selects the image) | animate |
| arrival: the first scene of a lifetime, a scope reset, `startup`, `restore` and its revalidation | snap |
| `resize` (pane width, a scrollbar), `metrics` (tile size, grid metrics) | snap |
| `listing`, `refresh` (backend index or data), `retry` | snap |
| an unknown cause | snap |

A snap publishes a static presentation: running motion ends and retirees are dropped at once (the driver's `start` cancels what it owns). A restore's continuation (requested stacks the saved data could not open) commits as a `refresh`, so it snaps; other continuations are `expand` (a cold open the user asked for) or `refresh` (a newer index), as before. `reveal` animates: the user asked to see the image, and opening its stack is the spatial change they asked for.

**Width changes paint their own layout on the first frame.**

- The Trace scroller always reserves its vertical scrollbar (`overflow-y: scroll`). `scrollbar-gutter: stable` alone is not enough: WebKit (WebKitGTK 2.54, Safari 26) reserves no gutter for a styled `::-webkit-scrollbar`, which the host uses, so a scrollbar appearing narrowed the view 858 → 850 px. Overlay scrollbars take no space either way; Chromium already honoured the gutter.
- The width is measured by `bind:clientWidth` (a ResizeObserver). Its callback runs before paint, and everything from the intake to the commit is microtasks when the layout runs inline, so the first frame at a new width shows its layout. `StackGrid` measures its window in its own ResizeObserver callback too (no longer on the next frame).
- `recentLayouts`: the controller keeps the last 4 layouts it committed this lifetime, by layout basis, and reuses one only when every open stack's component, revision and data object match. A round trip (a fullscreen Preview widening the pane, then narrowing it; a resize dragged back) commits the earlier layout at once, without the engine or the worker.
- `mustLayoutBeforePaint` (`D/layout-workload.ts`): when the layout would go to the worker but the pane narrowed past the scene on screen (the new width is less than the one the scene was laid out for, and its grid reaches beyond it), it is laid out inline anyway, so a layout for another width is never drawn overflowing the pane. A scene that still fits (the pane widened), or one already wider than its own pane whose width did not shrink (it scrolls sideways as before; a click inside it must still go to the worker), stays on screen, whole and unchanged, until the worker's layout commits, then snaps.

**Fullscreen Preview (S7), host side.** The pane under a fullscreen Preview is resized because `.preview-pane.fullscreen` becomes `position: fixed; inset: 0` (`PreviewPane.svelte`), which takes it out of the flex flow. Its `.preview-island` (`+page.svelte`) is content-sized (`flex-shrink: 0`, no width of its own), so the island collapses and the workspace panes take its width (870 → 1158 px; with a bottom or top dock, the height). A host fix keeps the island at the docked pane's size while fullscreen, for example a width (or height) captured when fullscreen starts, or a CSS variable the pane sets for its docked size; or renders the fullscreen surface in a separate layer while a same-sized placeholder stays docked. With the plugin fixes above, the exit already paints the narrow layout on its first frame without motion; the host fix would also avoid the hidden relayout.

**Tests.** `e2e/scene-snap.spec.ts` (Chromium and WebKit): a return after a settled expand, folder switches 0–120 ms after a toggle, a first arrival, resizes laid out inline and in the worker, a fullscreen-like widen and narrow (inline and worker), and a held worker reply while widening. `e2e/motion-scrollbars.spec.ts` adds the host-scrollbar cases (a scrollbar appearing, a tab switch, and B with host scrollbars, which reproduced only in WebKit). Frames are sampled just before they paint (`samplePaintedFrames`: a ResizeObserver callback, after the page's own observers and their microtasks), so a state between two tasks that no frame paints is never mistaken for a frame. Each asserts zero motion starts and that the first frame drawn is the settled scene.

### Review fixes (8d257bf)

- **A return is never blank** (supersedes "Restoration uses the pane's current intent" where it refused saved scenes, and its "not covered" note). `restoredInput` lays the current intent on the saved data even when the session knows a newer index or the listing changed; the newer data commits after it as a `refresh`, which snaps. When only the worker could lay the current intent out, the saved scene is shown as it was laid out, styled as the pane is now (a stale focus for a few frames), until the `restore` transaction commits the current scene, which snaps; a saved scene that would not fit the pane is laid out inline instead (`mustLayoutBeforePaint`).
- **A restore that throws** (the engine or `buildFolderScene` rejecting the data) fails its transaction, reports the failure, and the folder is prepared as a first scene; later offers are never swallowed.
- **Saved-scene recency.** An unchanged saved scene is touched (`recall`) on every commit, so a pane that only restyles is not evicted by other panes' saves; an evicted one is saved again.
- **One measuring frame loop.** Outside measurements (scroll, publication, motion start) join `StackGrid`'s pending frame loop instead of starting another.
- **Retiring tiles keep their band's orientation.** Tile records carry `orientation`; orphaned and exit-group retirees pass it on, so a sideways tile's chevron does not flip while it fades.
- **Tests.** The returning-selection test fails on blank frames after the return and records every DOM selection state with a MutationObserver. The band carried-into-view test seeks its held motion to nine times. The returning-record test asserts that a record returning while its retiree is shown always takes part (no tile drawn twice).

### Review fixes (dc33274)

- **Lay out before paint compares inner widths** (H1). `mustLayoutBeforePaint` compared the scene's extent and the new inner width with the pane width the scene was committed at (`SceneIntent.width`, grid padding included). With the host's padding, every scene wider than its inner width was laid out inline on every geometry transaction (187 ms for a click in `?fanChildren=200&wideRoots=70&fileTile=1` at 385 px). The displayed width is now the published (or saved) scene's `inputs.layoutInput.width`, measured like the next width.
- **Motion follows what changed, not which transaction commits** (M1; supersedes the cause table in "Native findings fixes"). `geometryMotion(previous, next)` compares the `GeometryInputs` of the scene on screen with the committing scene's (`geometryInputsOf` in `V/scene-inputs.ts`; the controller keeps the last commit's as `shownInputs`, updated on every commit including one that changes nothing drawn):
  - **snap** on arriving (nothing on screen, a new scope), or when the scene on screen is a saved scene shown as it was laid out (`current` false), whose replacement completes the return;
  - **snap** when any input the user does not drive changed: inner width, grid padding, tile or grid metrics, the grid items (kind and id, in order: the listing, claimed paths and held history), the index token, or the data (component, revision or data object) of a stack open in both; also a stack opening that the arrival requested (`arriving`: a return whose saved data lacked it), opening without being requested, or closing while still requested (it failed in its cover). Old positions are no longer comparable, so a user change committing with any of these snaps too;
  - **animate** when only user inputs changed: a stack opened or closed by the user's request (expand, collapse, a cold open completing, also after a selection committed meanwhile, Retry, Show image), or the focus (a selection);
  - **snap** when geometry changed although no input did.

  Simple by design: snap if any non-user input changed, otherwise animate if a user input changed. The same changes give the same answer whichever transaction commits them (a click landing while a resize waits for the worker, a return's resize, an expand superseded by a resize). `SceneCause.kind` no longer decides motion; it is kept for instrumentation, anchoring and continuations.
  - **Retry animates** like an expand: the failed stack is still requested, is not arriving, and opens.
  - **Changed expectation (R7).** The reviewer's R7 expected an expand to animate when a resize (900 → 950) landed while its layout was in the worker. The resize changes the inner width, so under this policy the expand and the reflow commit together and snap. R7 now asserts the snap; a companion test asserts that the same expand animates when the resize committed before it.
  - Also snapping now, where the cause used to animate: a user action that commits together with a newer index or data (an expand whose layout picked up a refresh the pane had not committed yet, including Show image just after a save).
- **Recent layouts only for size round trips** (M2). `recentLayout` reuses a layout only when the scene on screen was laid out for another width, tile or grid. At the same size (a selection A → B → A), the engine lays out again with the scene on screen as history, as for any selection; the cached first layout skipped the band history made since (866 of 1872 round trips differed).
- **Tests** (T1, T2). `expectSnapped` fails on any undrawn frame after the first drawn one; `expectHeldThenSnapped` covers a change laid out in the worker (the previous scene, then the new one, never blank, never moving). The width specs' worker variants use `?fanChildren=40` (the old `?anchorWorker` never reached the worker) and assert the worker laid out a widening while narrowing never waits for it; every width spec has a `?fileTile=1` (grid padding 8) variant. A headless WebKit project runs `motion-scrollbars`, `scene-snap`, `tab-switch`, `selection-blink`, `band-motion`, `scene-transactions` and `scene-windowing` (a parallel CI job). `scene-interruption` stays Chromium-only: its frame-count assertion depends on frame rate. New regression tests: the reviewer's R1 (with and without padding, unit and e2e), R4c, R6, R6b (unit and e2e), R7, a host selection opening a cold stack, Retry, a return completing a stack, and R5 (a return after a save never shows the new image as a loose file).

## 5. Cold expansion and failure

The committed cover stays in place. Its thumbnail receives an absolutely positioned loading spinner; the cover has `aria-busy="true"` and an accessible “Loading stack” status. No child band, background band, estimated footprint, or following-row displacement appears.

Show visual progress after 400 ms, preserving the current fast-load restraint. Accessibility busy state is immediate. Loading and arranging use the same overlay position and never resize the cover.

The disclosure’s `aria-expanded` reports the committed scene. While pending, clicking it cancels the requested open; its accessible label becomes “Cancel opening stack”.

Give preparation a 5,000 ms deadline, covering data and layout. On success, publish the completed band and displacement together. On error or timeout (of a cold open; a re-read of an open stack fails the same way, see §4):

- Abort the transaction; retain the last scene.
- Replace the spinner with an in-cover error indicator and Retry control.
- Reject its reveal waiter with the actual error/timeout.
- Block that failed opening attempt until Retry, explicit reopening, or a new targeted reveal.
- Ignore late results for publication. Background completion cannot silently reopen it.

Retry resolves the stable cover/node key against the current index, since component ids may have merged. Closing clears notices immediately without awaiting a worker.

Use a view-level overlay for refresh/index failures that are not one cover's: a stack that cannot be read fails in its cover, never in the overlay. Replace the flow-affecting notice at `TraceView.svelte:806`; error/progress UI must not change scene or scroll geometry. A later commit of current data clears the overlay.

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
| Superseded worker blocks current work | Drop aborted queued jobs immediately. Reject an aborted caller independently of its running computation. A 5s running-worker watchdog terminates the wedged worker, creates a replacement, and requeues still-live jobs; one retry per job, then fail. Callbacks are guarded by worker identity. (Implemented in `layout-client.ts`.) |
| Worker fallback blocks a frame | The fallback after a worker load failure uses the yielded main-thread path, one job per frame, checking cancellation before each computation. (Implemented.) |
| History/cache memory growth | Retain at most 48 layout entries and add a 16 MiB estimated-byte budget including signature strings; oversized results are returned uncached. Store no scene back-pointers. Scene snapshots use an independent 8-entry/16 MiB LRU; presentation holds only active/pinned records and ≤200 retirees. |
| Native clock/model divergence | Common epoch, exact residual easing, inline pending poses, one compositor calibration sample, owned cleanup tokens, and Chromium/WebKit/native stall tests. |
| Late results resurrect failed or old-folder content | Token provenance, action/lifetime guards, blocked failed opening attempts, cancellable interests, and explicit late-reply harness tests. |