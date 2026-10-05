# Provenance-aware media workspace — staged plan

## Direction

Build an opt-in media workspace within `tauri-explorer`. Reuse its file browsing, previews, context menus, commands, and jobs. Extend the plugin system with a small number of shared capabilities where needed; make the workspace a first-class app mode if its navigation cannot fit cleanly in a plugin. Keep provenance and asset-identity rules in a separate domain module so a standalone shell remains possible later.

The central object is an **artifact**: an image, video, audio clip, or other output with a durable identity and a record of how it was produced. The user creates the graph organically by working on artifacts. They do not have to design a workflow graph before generating anything.

The durable graph should have a small, media-independent core. A future code module could be another generated artifact whose inputs include versioned specifications, evaluations, context boundaries, and decisions. The first UI remains media-focused; the underlying identity, revision, link, run, and evidence concepts should not assume that every node is a media file.

## Context and motivation

Generative media work starts with files but quickly becomes a branching history: an image is edited, upscaled, extended, or animated; several models and settings are tried; one result becomes a reference for later work. A normal folder shows where files were saved, but not which result came from which input, what was changed, or which version a later result used. After enough experiments, filenames and manually organized folders are a poor way to answer those questions.

Node-based tools expose the computation behind generation, but ask users to think in workflows before or while they are exploring. The intended experience starts from the media instead: select an image, choose an action, inspect the result, and fork again. Each action adds to a provenance graph automatically. The graph remains available for inspection and precise edits, but it is a record of creative decisions before it is an editing surface.

The explorer metaphor makes this tangible. A picture can be viewed as media and expanded to reveal its descendants, much like a folder. A separate pane can explain how it was made. When a user changes an earlier prompt or setting, the app can show which later results depend on that choice and offer to regenerate only those results. This matters especially when some steps use paid hosted models or take a long time to run.

Longer projects also need a stable identity for things that recur. “Griswold” is a character, not a particular PNG. An approved portrait or voice can change while the project still records exactly which versions were used in each completed shot. That is the motivation for logical assets in stage 6.

`tauri-explorer` already supplies the general file-management interactions and has built-in model actions. Starting there lets us test the artifact-first experience without rebuilding an explorer. The media workspace should own its provenance model; existing plugin and app seams can grow where the user experience requires it. Whether it remains a plugin or becomes a first-class mode is an implementation decision to make after lineage navigation is working.

## Stages

### 1. Recorded image edits and a read-only Trace pane

The first plugin release is specified in [Stage 1: recorded image edits and a read-only DAG](STAGE_1_TRACE_PLUGIN.md). It uses the existing image-edit action, records its actual input and result, and shows a read-only Trace pane for the selected image. Project creation, manual tracking, and artifact-as-folder navigation can follow after this core loop works.

- Use the existing local file explorer as the starting point: browse folders, preview media, select files, and open project locations.
- Record a durable, observed provenance chain for one existing edit action; show its ancestry and branches in a selection-aware pane.
- Treat previously existing images as roots with unknown earlier origin. Keep ordinary files accessible through normal filesystem views.

**Outcome:** After editing an image, a user can select the result and see how it was made, including after restarting the app.

### 2. More transformations and provider integrations

- Configure local and hosted image/video model providers and their credentials. Keep provider-specific request handling behind adapters.
- Extend the recorded operation contract from the first image edit to **Upscale, Generative Upscale, Animate, Variations, Extend**, and additional edit providers.
- Show input, model, and parameters before submission; show job progress, failure, and generated outputs afterward.
- Apply the stage 1 provenance contract to each additional operation: source artifact IDs and roles, operation and settings, model/provider identity, run attempt, output IDs and paths, timestamps, and available cost/version information. Do not record secrets.
- Keep outputs as usable media files, and preserve the source rather than overwriting it.

**Outcome:** Closing and reopening the app still lets the user answer “what produced this output?”

### 3. Lineage navigation

- Let an artifact expand like a folder to show its descendants while still opening as media.
- Support branching and multiple inputs. A tree may choose one display parent, but the stored lineage is a directed acyclic graph and links to every parent remain available.
- Make selection, breadcrumbs, keyboard navigation, previews, and context actions work in lineage views.

**Outcome:** A user can move from a source image to its edits, upscales, and videos without searching for filenames.

### 4. Provenance pane and graph

- Expand the initial read-only Trace pane into a richer inspector for the selected artifact: inputs, generating operation, settings, model/provider, run history, errors, output files, and descendants.
- Offer deeper graph navigation, comparison, and a route to lower-level workflow details when available.
- Make the graph a view of durable records created by actions, not an empty canvas users must wire first.

**Outcome:** A user can inspect a branch and compare how two results were made.

### 5. Edit recipes and selectively regenerate

- Separate immutable historical artifacts and runs from editable **desired operation revisions**. Editing a prompt or setting creates a new revision; it never changes the recorded history of an old output.
- Let users edit prompts and settings on operation nodes directly in the provenance graph or inspector; the graph grows from actions rather than requiring advance workflow design.
- Define input bindings: **follow** an upstream operation's current output, or **pin** a particular artifact version. Changes propagate only through following bindings.
- Compute which desired results are current, stale, missing, running, or failed. Show an impact plan before regeneration, including affected descendants, likely cache reuse, and estimated hosted-model cost where available.
- Rebuild only the affected subgraph. Preserve previous outputs as inspectable versions. Allow a new take even when the inputs and settings match a prior run.
- Treat cache reuse as a separate decision from staleness: hosted or nondeterministic models may not reproduce an identical result, and an unavailable model revision must be reported honestly.

**Outcome:** Changing an animation prompt leaves its source image current, marks the animation and its following descendants stale, and offers a reviewable rebuild plan.

### 6. Logical asset identity

- Introduce named assets such as **Griswold**, distinct from any one generated file.
- Let an asset have typed slots, such as canonical portrait, full-body reference, or voice, each pointing to an approved artifact version.
- Let operations reference either a named slot that follows its current approved version or a pinned artifact. Every completed run records the exact resolved version it used.
- On changing a canonical slot, show which following operations would become stale. Historical and pinned outputs remain intact.

**Outcome:** A user can change Griswold's approved portrait, see the affected work, and decide what to regenerate.

## Shared foundation to introduce early

- **Provenance store:** durable, versioned records for artifacts, file locations, operations and their revisions, typed input edges, run attempts, outputs, and later logical assets/slots. Allow non-file knowledge records and typed relationships without forcing every record into a lineage tree. Stage 1 uses app-local SQLite without project setup; later project-local storage and export can be added behind the same repository interface. Media stays in ordinary files.
- **File reconciliation:** identify files by artifact ID and content hash, not path alone. Define how rename, move, external edit, deletion, and missing files appear without fabricating provenance.
- **Operation contract:** typed inputs, validated parameters, provider/model identity, output types, execution status, and cancellation/retry behavior. Provider adapters may call ComfyUI, local tools, or hosted APIs.
- **App seams:** extend entry activation/expansion, preview resolution, inspector contribution, and durable job reporting only as real stages require them. Keep general explorer behavior independent of media-domain rules.
- **Tests:** verify durable provenance after restart, branching and multiple inputs, file reconciliation, stale-set calculation, pin/follow behavior, retry versus cache reuse, and user-visible generated outputs.

## Integration while `tauri-explorer` evolves

Implement Trace Explorer as an opt-in, build-time-bundled plugin in `tauri-explorer`, with its provenance rules in a separate domain module and durable store. Keep this repository as the product/specification home initially; keep one source of truth for executable plugin code in the host repository. Develop in short, vertical feature branches from the current `dev` tip and merge each finished seam or capability promptly. Do not maintain a long-lived fork of the explorer. The plugin stays disabled by default until its first complete workflow is ready.

Use the existing plugin API for commands, context actions, settings, dialogs, and simple virtual listings. Extend host-owned seams only when a working slice needs them: entry activation and media resolution for artifact-as-folder navigation; a provenance pane contribution; and a durable job/run bridge. Keep provider adapters and graph logic behind Trace-owned interfaces, so host layout changes do not enter the domain model. The current virtual listing API only lists directories, file entries are path-based, and current plugin jobs are session presentation rather than durable provenance; those limits should be resolved explicitly rather than hidden in UI code.

For each new seam, add a small host/plugin contract test and run the affected app checks against the current host tip. Give the project database explicit schema versions and migrations; a plugin or host update must not erase provenance. If independent plugin releases become valuable later, extract the stable domain and adapter contracts into versioned packages while retaining a small compiled-in host adapter. The current static plugin registry does not support dropping a separately built plugin into an installed app.

## Path to a Phoenix-style software workspace

The media stages can establish the same causal substrate needed for regenerative software. Keep two kinds of relationship distinct: an acyclic record of which *versions* an operation consumed and produced, and richer semantic links such as “decision motivated by incident” or “evaluation protects requirement.” The latter need not form a tree or even a DAG.

Give contracts stable identities and immutable revisions. A domain model can define several sibling contracts, while each contract can also depend on other contracts through explicit, typed links. Shared parentage alone does not make a sibling stale: a changed contract triggers impact analysis along its actual dependency links. Show directly affected contracts, their dependents, and generated implementations separately; use compatibility evaluations to decide which candidates still satisfy the new revisions. If contract dependencies form a cycle, inspect and assess the connected group together rather than attempting a naive topological rebuild.

Start capturing evaluation definitions and results as first-class records: media may use format checks and human approval; software may use behavior contracts, invariants, and operational limits. Record why an output was accepted, not only that a job succeeded. A claim extracted from a document or observation is evidence; making it an authoritative requirement is a separate action.

With those foundations, later software support can add specifications, ADR decisions, context boundaries, code modules, agent-generation runs, test evidence, and production observations as typed records. A code module's accepted version then traces to the exact knowledge revisions, generator context, and evaluations that justified it. The defining acceptance test would be to remove one bounded module, regenerate it from the surviving records, and verify a replacement against its stable boundary. This is a later capability layer, not a requirement to build a general software IDE during the media MVP.

## Decisions to settle during implementation

1. Project-managed copies versus references to files left in place, including behavior after external edits.
2. The default binding policy for descendants and for logical-asset references.
3. Which provider/model version details can actually be captured or pinned, and how to label unknown revisions.
4. When a lineage tree should choose a primary parent for a multi-input artifact.
5. Whether stages 3–4 fit as plugin contributions or call for a first-class media workspace mode.

## Scope boundary

The six stages above define the initial product. A full image-editing canvas, natural-language agent, model bakeoffs, parametric sweeps, and team collaboration can be specified after the artifact model and regeneration behavior work end to end.
