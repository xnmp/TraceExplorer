/**
 * Deterministic, opt-in benchmark in the same Node runtime as the perf tests:
 * LAYOUT_TREE=/path/to/tree LAYOUT_RUNS=7 bun x vitest run --config tests/domain/trace-graph/layout-benchmark.config.ts
 * Fixtures are constructed before timing; fan-out includes projection/scene
 * planning, exactly as scale.test.ts does. One warm-up precedes measured runs.
 * origin/main ignores pinned; its pin-labelled numbers are legacy baselines.
 * Set LAYOUT_COMPARE_TREE to interleave a second tree in each measured round.
 * Spike samples each time nine layouts (three widths × three columns).
 * LAYOUT_DIAGNOSTICS=1 records the hard-case contracts and 2,700-layout fuzz
 * counts after timing, using the same diagnostics as layout.test.ts.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { layoutGraph, type GraphLayout } from "$lib/domain/trace-graph/layout";
import { tileSize } from "$lib/domain/trace-graph/metrics";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { planScene } from "$lib/domain/trace-graph/scene";
import { layoutGraph as compareLayout } from "$compare-lib/domain/trace-graph/layout";
import { connectedComponents as compareComponents, projectDag as compareDag } from "$compare-lib/domain/trace-graph/projection";
import { planScene as compareScene } from "$compare-lib/domain/trace-graph/scene";
import { node } from "./fixtures";
import { fixtures, grid, itemsOf, widths, columns, randomDag, coverOf } from "./pinned-fixtures";
import { invariants } from "./pinned-diagnostics";

const digest = (layout: GraphLayout) => createHash("sha256").update(JSON.stringify({
  ...layout, routes: layout.routes.map(({ consumers: _consumers, ...route }) => route),
}, (_key, value) => value instanceof Map ? [...value] : value)).digest("hex").slice(0, 16);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
type Engine = { tree: string; layoutGraph: typeof layoutGraph; projectDag: typeof projectDag;
  connectedComponents: typeof connectedComponents; planScene: typeof planScene };

it("reports layout medians and geometry fingerprints", () => {
  const small = tileSize({ foreign: false, hint: false });
  const items = Array.from({ length: 600 }, (_, index) => ({
    key: `n${index}`, parents: index ? [`n${Math.floor(index / 4)}`] : [],
    ...(index % 7 ? small : { width: 168, height: 152 }), order: index,
  }));
  const nodes = [node("source"), ...Array.from({ length: 3000 }, (_, index) => node(`out${index}`, ["source"]))];
  const cases: { name: string; run: (engine: Engine) => GraphLayout[] }[] = [
    { name: "visible-600", run: (engine) => [engine.layoutGraph({ items, maxWidth: 1000 })] },
    { name: "fan-out-3000", run: (engine) => {
      const dag = engine.projectDag(nodes);
      const members = engine.connectedComponents(dag).find((component) => component.includes("source")) ?? dag.order;
      return [engine.layoutGraph(engine.planScene(dag, members, "source", 1100).request)];
    } },
    ...fixtures().flatMap((fixture) => {
      const items = itemsOf(fixture.nodes);
      return [false, true].map((pin) => ({
        name: `spike-${fixture.id}-${pin ? "pinned" : "ordinary"}`,
        run: (engine: Engine) => widths.flatMap((width) => columns.map((column) => engine.layoutGraph({
          items, maxWidth: width, ...(pin ? { pinned: grid(width, column, fixture.cover) } : {}),
        }))),
      }));
    }),
  ].filter(({ name }) => !process.env.LAYOUT_CASE || new RegExp(process.env.LAYOUT_CASE).test(name));
  if (!cases.length) throw new Error("LAYOUT_CASE matched no fixtures");
  const runs = Number(process.env.LAYOUT_RUNS ?? 7);
  if (!Number.isInteger(runs) || runs < 3 || runs % 2 !== 1) throw new Error("LAYOUT_RUNS must be an odd integer >= 3");
  const engines: Engine[] = [{ tree: process.env.LAYOUT_TREE ?? ".", layoutGraph, projectDag, connectedComponents, planScene },
    ...(process.env.LAYOUT_COMPARE_TREE ? [{ tree: process.env.LAYOUT_COMPARE_TREE, layoutGraph: compareLayout,
      projectDag: compareDag, connectedComponents: compareComponents, planScene: compareScene }] : [])];
  const samples = new Map(engines.flatMap((_, index) => cases.map(({ name }) => [`${index}:${name}`, [] as number[]])));
  const fingerprints = new Map<string, string[]>();
  // Alternate fixture order across rounds to spread load/JIT bias.
  for (let round = -1; round < runs; round++) {
    for (const entry of round % 2 === 0 ? [...cases].reverse() : cases) {
      for (const engine of round % 2 === 0 ? [...engines].reverse() : engines) {
        const key = `${engines.indexOf(engine)}:${entry.name}`;
        const start = performance.now();
        const layouts = entry.run(engine);
        const ms = performance.now() - start;
        if (process.env.LAYOUT_PROGRESS) console.info(`round ${round} ${engine.tree} ${entry.name}: ${ms.toFixed(2)} ms`);
        if (round >= 0) samples.get(key)!.push(ms);
        if (round === runs - 1) fingerprints.set(key, layouts.map(digest));
      }
    }
  }
  const reports = engines.map((engine, index) => ({ tree: engine.tree, runs,
    cases: cases.map(({ name }) => {
      const key = `${index}:${name}`;
      return { name, medianMs: Number(median(samples.get(key)!).toFixed(2)),
        samplesMs: samples.get(key)!.map((ms) => Number(ms.toFixed(2))), fingerprints: fingerprints.get(key) };
    }),
  }));
  const diagnostics = () => {
    const hardCases: Record<string, Record<string, number>> = {};
    for (const fixture of fixtures()) {
      const items = itemsOf(fixture.nodes), counts: Record<string, number> = {};
      for (const width of widths) for (const column of columns) {
        const pinned = grid(width, column, fixture.cover);
        const problems = invariants(items, engines[0].layoutGraph({ items, maxWidth: width, pinned }), width, pinned);
        for (const [contract, details] of Object.entries(problems)) counts[contract] = (counts[contract] ?? 0) + Number(details.length > 0);
      }
      hardCases[fixture.id] = counts;
    }
    const fuzz = { layouts: 2700, laneSharing: 0, ordinaryLaneSharing: 0, failures: {} as Record<string, number> };
    for (let seed = 1; seed <= 300; seed++) {
      const nodes = randomDag(seed), items = itemsOf(nodes), cover = coverOf(nodes);
      for (const width of widths) {
        const ordinaryPin = grid(width, columns[0], cover);
        const ordinary = invariants(items, engines[0].layoutGraph({ items, maxWidth: width }), width, ordinaryPin);
        if (ordinary["shared-lane"].length) fuzz.ordinaryLaneSharing += columns.length;
        for (const column of columns) {
          const pinned = grid(width, column, cover);
          const problems = invariants(items, engines[0].layoutGraph({ items, maxWidth: width, pinned }), width, pinned);
          if (problems["shared-lane"].length) fuzz.laneSharing++;
          for (const [contract, details] of Object.entries(problems)) fuzz.failures[contract] = (fuzz.failures[contract] ?? 0) + Number(details.length > 0);
        }
      }
    }
    return { hardCases, fuzz };
  };
  const report = { ...reports[0], ...(reports[1] ? { comparison: reports[1] } : {}),
    ...(process.env.LAYOUT_DIAGNOSTICS ? { diagnostics: diagnostics() } : {}) };
  if (process.env.LAYOUT_OUTPUT) writeFileSync(process.env.LAYOUT_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`LAYOUT_BENCH ${JSON.stringify(report)}`);
});
