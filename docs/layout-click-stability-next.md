# Continuation: click stability remains unsolved

Start with the current section of `docs/layout-hard-gates.md`, the requested acceptance targets in `tests/domain/trace-graph/click-stability.test.ts`, and `docs/click-stability-evidence/orders.json`.

Production retains only two independently reviewed insertion improvements: bounded witness-directed routing around foreign berths, and reservation of future source ports. There is no canonical replay in the production layout entry point. Arrival-only history and the previous safety/quality construction remain intact.

The rejected constructions live in `layout-eval/canonical-construction.ts`; `probe-canonical.ts` reproduces historical replacement tours, and `probe-cumulative.ts` uses actual `expandNode`. Both default to 454/900 panes and 96px images, so their counts must not be presented as full acceptance totals. Full-folder newest-first frontier beats depth on cumulative clicks, but both fail requested stability. Fixed projection has zero movement but fails quality. Internal skeleton projection also fails compactness and switches between incompatible layouts when leaf insertion fails.

Do not erase the historical tour comparison: its focus replacement hides old branches and is unlike first-click expansion, but the user's 32/101/17.5 targets refer to that comparison. Add real cumulative interaction evidence alongside it. Do not use click-time history or mark a height regression as stability without actually preserving geometry.

The permanent Saffron/Ash regression is the first test in `tests/domain/trace-graph/expansion-invariance.test.ts`. The same file checks different paths reaching equal visible states and exact retained arrival rectangles. The new canonical-order tests establish the experiment's state-only order and cold/warm cache parity, not acceptance of its geometry or cost.

Remaining root problems: varying prefix membership changes where a retained anchor was originally inserted; a failed intermediate insertion can reset a whole prefix; reserving hidden internal coordinates costs too much height. The five unexplained height rows all repeat random-chainy-200-9303/454/48. Existing safe orderings, passing strategies, and shelves did not meet its 9531.5 px limit; production is 10307 px. See the committed height-candidate evidence.

Follow AGENTS.md. Use bun only; do not push, launch a browser/Playwright, use recursive removal, or access `/home/chong/Repos/*`. Commits require `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Merge base remains origin/main 6a3ac0466c61fc6549b40b93c0b18b1dcd88313e. Git metadata writes need the environment's escalation path. Run final timing without another CPU-heavy evaluation/test job.

The report contains final gate results; the click-stability tests currently fail their strict assertions, not skipped/expected failures. They must turn green through a real construction before this task can be called complete.
