# Continuation: revisits restore

Read the current section of [layout-hard-gates.md](layout-hard-gates.md) first. The branch is rebased onto `origin/main` `75e46b0`; do not fetch or replay the strict design.

The product rule is exact restoration of a retained displayed state, with click-time history/anchoring for a never-seen state. A bounded 64-state per-folder ledger is committed as part of the displayed output; contents changes reset it, width/tile/grid inputs fence it, and arrivals retain zero-motion pinning. Selection is not an input. Main and worker use the identical pure folder engine.

Implemented and reviewed: immutable shared-reference snapshot codec, geometry and folder-cell provenance checks, full independent certification on restore, no cache seeding from historical restores, and preservation of the newest ledger on resize. The permanent Saffron/Ash case, 768 worker/main layout comparisons across 752 expansion transitions, bounded memory/alias tests, and arrival/removal/resize tests remain.

The task is **not accepted yet**: Click anchor moves, including packing: 93.000 > 32.000; Dense-tour anchor moves: 166.000 > 101.000; Mean legal displacement, px: 19.577 > 17.500; Held-screen moves at 480 px (dense): 145.000 > 114.000; Main-thread maximum p95, ms: 9.939 > 5.000; Mean siblingInversions: 0.110 > 0.107. Do not weaken or skip the click-stability test. The complete main/this-pass tables, fallback counts and final gate results are in the report.

Current new-state policy uses normal candidate ranking and click anchors; only arrivals get the early all-retained pin preference. Two earlier routing fixes remain, plus a detached junction-end berth correction. New equivalent sibling leaves are assigned to their existing slots in creation order without changing geometry or retained identities. A compact layered candidate resolves the previously unexplained chainy height case. The full folder timing probe includes memory work.

Remaining work includes the inline band timing failures (random-bushy-12-7321 / reveal: p50 6.579ms, p95 9.939ms; random-bushy-40-7601 / reveal: p95 5.073ms), sibling-order quality, and certified routing around retained anchors. Focused probes showed most movement occurs in new states; larger search budgets did not solve the primary witness, and global click-only anchors made counts worse. The focused click witness is dag407501/454: inserting n17 from retained n2 fails even with 16× search budgets. Both ports sit 6px from foreign ink, outside the current port-intrusion repair trigger; no certified retained-tile solution or impossibility proof has been established. The next routing avenue is rerouting obstructing retained connectors while keeping tile rectangles. Main's soft crossing cap was tried and reverted after 100/168 held-screen moves and 23.59px displacement. Do not label movement as an allowed yield merely to reduce counts.

Sibling-order quality remains above the 10% limit. Most remaining cases involve internal or retained siblings. A narrow optional port-profile grouping probe reduced tree2009002/900/48 from four inversions to three without changing geometry, but removing the future-source distinction wholesale loses a usable exit in another case. No production extension was made.

Strict canonical/prefix experiments and their tests were removed. Their historical evidence remains in the report and `docs/click-stability-evidence/`. Those historical sections describe superseded policies, not current instructions.

Follow AGENTS.md. Bun only; no push, browser/Playwright, recursive removal, or access to `/home/chong/Repos/*`. Commits require `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run timing after all heavy jobs; preserve #91 presentation behavior.
