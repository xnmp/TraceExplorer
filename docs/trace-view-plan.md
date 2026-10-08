# Trace view implementation plan

Replace the separate Trace pane with a plugin-contributed Explorer view. Use the accepted [interactive mockup](../../mockups/trace-view.html) as the interaction reference, with one correction: siblings must be able to occupy multiple rows instead of sharing a fixed generation row.

## Agreed behavior

- Trace replaces the main file listing. Choose it through existing settings and commands; add no view selector, search box, or inspector toolbar.
- Reuse the existing Preview pane. Add prompt, generation parameters, input references, and collapsible Raw metadata to Preview info.
- Render a regular DAG with one image node per artifact. Group connected components into explicitly separated, collapsible sections. Keep files and folders without provenance accessible in an ordinary section.
- All nodes have the same (small) size, whatever the focus; the selection and focus are shown by tile styling, not size. (Revised: an earlier version enlarged the focus and its direct neighbours, which made selection changes jarring.) Ancestors and descendants retain color; unrelated nodes are slightly greyed out and remain interactive. Multiple selection has one primary focus. Without a focus, show small nodes without lineage dimming.
- Show only limited context: roots and their immediate children, the selected node's ancestry and direct children, and any additional parents needed to explain visible outputs. Previous selections must not accumulate expanded branches.
- Distinguish inputs in the current folder, nested subfolders, and outside the folder tree. Use relative paths/folder markers for subfolders and outward arrows/location markers for external inputs. Retain these markers in every selection state.
- Temporary/reference clicks update selection and Preview without navigating Explorer into their storage folder. Preserve Unsaved indicators, hover save/delete controls, default collision-safe saves, and optional Save as.

## 1. Add the host interfaces

The current SDK supports inspectors but not file views. Add a lifecycle-owned file-view registry and render contributed views through the existing `FileList.svelte`/Explorer pane flow. Pass pane-scoped directory, entries, selection, focus, and normal file-action callbacks to the view.

Add a Preview-info contribution point and a pane-scoped preview target for temporary images, references, and recorded revisions. These targets must not masquerade as ordinary Explorer files or become draggable filesystem paths. Keep standard file actions on real files; expose explicit actions for temporary and reference targets.

Integrate Trace with settings, pane restoration, and the existing configurable **Alt+M, then P** command. Toggle back to the previous built-in view. In folders without provenance or active/unsaved workflows, resolve to that built-in view while retaining the Trace preference. Plugin disable/removal must dispose views, Preview targets, subscriptions, and workers cleanly.

Version the new SDK capabilities explicitly and retain compatibility with existing SDK-v1 plugins.

## 2. Provide folder-scoped graph data

Extend the plugin backend beyond `trace_for_image`/`trace_for_job` with an indexed folder/component query. Return component summaries first and load relevant graph neighborhoods on demand. Reuse artifact IDs, locators, run inputs, and folder/job context already stored in SQLite.

Use artifact identity rather than filenames for nodes. Saving, moving, or renaming must preserve identity and focus. Model running outputs with stable placeholder identities so completion replaces the same visual item. Preserve revision, missing-file, discarded-ancestor, and recovery semantics.

Scope references to the displayed graph; do not recursively import unrelated external folders. Deduplicate shared inputs and derive components from actual displayed relationships. Use native path handling for scope classification and aliases.

Avoid folder-wide hashing, one graph request per file, and silent truncation at the current whole-graph limits. Keep generation, title, save/discard, and progress infrastructure intact.

## 3. Implement pure graph rules

Port the mockup's selection and junction rules into typed, independently testable domain modules. Separate graph projection, visibility, focus/lineage classification, input grouping, layout, and rendering.

For multi-parent outputs, combine incoming connections before the child, leaving one final arrow. Reuse identical input sets and shared subsets: `(a,b)` can feed `e`, then combine with `c` to feed `d`. Keep partially overlapping sets distinct and never imply an extra parent. Junctions are routing geometry, not selectable operation nodes. Give them stable identities and retain the underlying parent relationships for highlighting and tests.

## 4. Build width-aware layout and rendering

Measure the actual space left after Preview and app chrome. Allow siblings to occupy several rows; display rows must not be treated as generation boundaries. Preserve parent-to-child direction, readable junctions, and clear routes around tiles. Prefer vertical growth over a single extremely wide row or long border-hugging detours.

Start with a small layout-engine spike using the problematic fan-out example, shared subsets, and mixed-generation inputs. ELK is a candidate, not a predetermined solution: its width-bounded layering counts nodes rather than enforcing a pixel budget, so verify the resulting bounds with real tile sizes. Keep the engine behind an adapter. References: [ELK layering](https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html), [ELK routing and ports](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html).

Run expensive layout away from the UI thread. Verify packaged worker loading against the host's current CSP rather than assuming plugin workers are permitted. Cache component layouts, preserve ordering where possible, and discard stale results after directory, selection, or graph changes.

Use keyed thumbnail components and fixed image/caption bounds. Title completion and image decoding must not rearrange the graph. Virtualize offscreen components and tiles; collapsed components should need summaries, not full rendering. Reuse existing thumbnail caches and app styling.

## 5. Add coordinated motion

Once settled geometry is correct, add approximately **180 ms** transitions for tile bounds, connectors, junctions, and section height. Preserve the selected node's screen position where scrolling allows. Animate from the currently displayed geometry when another selection interrupts a transition.

New connectors must move with their endpoints while fading in. Retain noninteractive snapshots while components collapse. Respect reduced motion and avoid unnecessary whole-component relayouts on ordinary metadata updates.

## 6. Integrate and validate

Replace `TraceInspector` with the main Trace view and Preview-info contribution. Reuse existing generation, titles, actions, invalidation, and cached data; move view/focus state from global inspector state to pane-owned sessions.

Verify these outcomes:

- Selection sizes exactly one neighborhood; lineage dimming is correct; old branches disappear.
- Shared subsets, identical sets, partial overlaps, and mixed generations preserve exact parentage and one terminal arrow per output.
- Wide fan-outs wrap across rows at different Preview widths without card collisions or unreadable routes.
- Preview, multi-select/Ctrl+E, temporary saves/deletes, reference clicks, generation completion, and folder navigation behave correctly.
- Rapid clicks, interrupted animation, reduced motion, plugin disable/re-enable, restart, and multiple panes/windows leave no stale selection or background work.
- Large-folder benchmarks demonstrate bounded query/render work and responsive interaction. Measure performance targets on representative fixtures rather than assuming the mockup's small dataset proves scalability.

Carry the mockup's contract cases into production tests, add browser outcomes and real packaged-host smoke tests, and obtain independent review of routing and motion. Deliver coordinated host and plugin PRs/releases; publish the compatible host first, then the plugin. Remove the old pane only when the integrated view passes these checks.

Defer depth controls, free-form node dragging, and additional graph customization until this behavior is working well.
