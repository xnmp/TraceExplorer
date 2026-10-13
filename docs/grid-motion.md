# Grid motion

Each committed graph change has a pure motion classification. Identical graph
geometry is a `restyle`: existing motion continues. A `reveal` keeps the complete
component DAG identity/revision, width, pin (including obstacles), tile metrics
and orientation, changing only focus or visible membership. It swaps instantly:
its tiles and connectors appear at committed geometry in the same frame, its
owned effects are cancelled and its ghosts are removed synchronously. Grid rows
displaced solely by the reveal's band footprint snap too. First layouts,
expansion/collapse, data changes and other geometry changes are `reflow` and
retain spatial motion. The classification travels through `TraceGraph.commit`
and `onbeforecommit` to `StackGrid.prepareMotion`; the grid owns pinned bands.

Cancellation follows ownership: grid motion tracks the effects it creates and
carries unchanged destinations without restarting them. A graph tracks its own
effects for snap cleanup. Neither owner cancels retained cards' CSS selection
transitions. Reduced motion uses the same owned cancellation and snaps.

Native effects created in one commit task resolve their pending start times
together. We never assign or back-date `Animation.startTime`: WebKitGTK can
re-resolve a stale timeline value and rewind every effect in a pass. Carried
animations retain their current clocks and readiness.

The grid captures displayed geometry before a commit, including pending inline
inversion and interrupted native effects. `StackGrid` starts `playGrid` in the
commit's `tick()` microtask checkpoint, before the browser can present the new
DOM. Every moving row, section and tile receives its starting inline transform
before WAAPI creation. The native effect overrides that style; `ready` clears
it, and cancellation clears it synchronously before measuring new targets.
Cleanup is owned per property so old promises cannot clear a replacement.
Committed SVG viewport dimensions protect graph sizes across interruptions.

Band connectors never animate `d`, either through CSS or rAF. Exact geometry
and endpoint movement both determine whether a route is a pure translation.
Compatible routes travel on native HTML transform layers with the tiles' 160 ms
clock, easing and start time. SVG transforms themselves can lag accelerated
HTML transforms in WebKit during a main-thread stall, so the motion layer is an
HTML element containing an inert SVG copy. Its bounds include marker padding;
a viewBox retains the original path coordinates without allocating a full
canvas-sized layer per edge. Junctions use the same mechanism.

Rerouted edges crossfade between exact old and new geometry. The old edge fades
within the first half-pixel of endpoint travel; the new edge fades within the
last half-pixel. They stay hidden in between, avoiding detached endpoints and
intermediate routes through tiles. These intervals are eased-progress keyframe
offsets, not separate timers. New band tiles retain their entrance from the
parent's side, but share their incident connectors' arrival-opacity keyframes: both stay
hidden until the routes are attached, then fade in together. Departing tiles and
connectors share a departure fade window and the group's common clip. A closing
group applies one parent fade to both tile copies and native edge layers. That
shared fade ends before the shrinking clip truncates any visible tile port or
marker-padded connector bound; edges have no additional independent fade. Copies are removed with the retiring
scene. Retained groups remain unclipped.

Snapshots bake a moving copy's displayed transform into its geometry before
restarting. Exits retain the displayed graph height while its committed footprint
is shrinking, so closing a moving group starts from its visible extent. Returning
groups resume the captured visible clip with absolute polygon coordinates on the
native clock; they do not replay a fresh entrance. Exit reconstruction discards
temporary layers, and transfer removes an old layer even when a newer animation
owns its ghost. Standalone, unpinned graphs retain their existing path morphing; its WebKit rAF fallback is still used there.
The obsolete band topology-stretch morph has been removed.

## Sources and adaptation

- [yFiles LayoutExecutor](https://docs.yworks.com/yfiles-html/api/LayoutExecutor/)
  coordinates a graph's transition after calculating layout and exposes one
  graph layout animation. We follow this separation and common motion lifetime.
- [Cytoscape layout animation](https://blog.js.cytoscape.org/2020/05/11/layouts/)
  describes animating directly between start and end layouts to avoid unattractive
  intermediate layout iterations. We retain exact start/end edge geometry.
- [Sprotty with ELK](https://sprotty.org/docs/sprotty-elk/introduction/) transfers
  calculated layout back into its diagram model. Its [animated commands](https://github.com/eclipse-sprotty/sprotty/wiki/Architectural-Overview#animated-commands)
  report interpolated updates to the viewer on each rendering pass. This
  reinforces that rendering and animation have a coordinated owner.
- [ELK](https://eclipse.dev/elk/) computes diagram positions and dimensions rather
  than rendering them. The viewer therefore owns animation policy.
- [FLIP](https://aerotwist.com/blog/flip-your-animations/) describes applying the
  inverse transform before playing the transition to the final layout.

The native HTML edge layers and visibility intervals are our adaptation to
TraceExplorer's SVG renderer and WebKit compositor constraints; these sources
are not claims that those graph libraries use this specific crossfade policy.

## Regression coverage

`e2e/selection-blink.spec.ts` alternates Cerulean/Saffron four times in the
seven-image sideways band at a 454 px pane width. From the click's first
presented frame it requires fully opaque revealed tiles and connectors, no
ghosts, unchanged retained positions and no subsequent opacity decreases. It
also verifies effective child-card opacity and that the newly selected retained
card still has a running CSS transition. Initial and interrupted reflow tests
seek native clocks to check tile/connector opacity parity and common pending
start times. Carry tests use data changes to exercise real spatial motion.
The classifier's domain tests cover focus/visibility, unchanged
geometry, changed inputs, first/empty scenes and malformed inputs.

`e2e/animation-control.ts` can suppress native keyframe application while keeping
animation metadata and readiness pending. First-frame tests force several render
opportunities with screenshots, then submit and seek the effects. B's children
and every following row must stay at their initial position until application,
then travel monotonically, including interrupted commits.

Clock tests seek active effects and deliberately busy-wait with native animation
running at normal playback rate with extended test durations so long stalls
stay inside active motion and the engine retains native compositor playback. They resume an
already presented early state without rewinding native clocks, then seek the
arrival boundary separately. They test opacity greater than 0.2, endpoints within two screen pixels,
no tile intersections, and cleanup. Each route's opacity, screen matrix and
endpoint rectangles are read together before expensive SVG probing: WebKit
advances accelerated geometry even between reads in one synchronous task.

Interruption tests close and reopen travelling groups before native readiness,
and resume a partially closed scene. They assert the displayed tile bottom as
well as its top, attached visible ports, and complete layer cleanup.
