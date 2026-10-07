/**
 * Large-folder benchmarks: projection, scene planning and layout stay
 * proportional to what is shown, on fixtures far larger than the mockup.
 * Budgets are generous (CI variance) but would catch quadratic regressions.
 */
import { describe, expect, it } from "vitest";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { planScene } from "$lib/domain/trace-graph/scene";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { node, random, tileOverlaps } from "./fixtures";

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

function render(nodes: TraceNode[], focus: string | null, width = 900) {
  return timed(() => {
    const dag = projectDag(nodes);
    const members = connectedComponents(dag).find((component) => focus === null || component.includes(focus)) ?? dag.order;
    const plan = planScene(dag, members, focus, width);
    return { plan, layout: layoutGraph(plan.request) };
  });
}

const HEAVY = 30_000;

describe("large folders", () => {
  it("lays out a 20,000-step edit chain focused at its end", () => {
    const nodes = Array.from({ length: 20000 }, (_, index) => node(`n${index}`, index ? [`n${index - 1}`] : []));
    const { value, ms } = render(nodes, "n19999");
    expect(value.layout.nodes.size).toBe(value.plan.tiles.size);
    expect(value.plan.tiles.get("n19999")?.tone).toBe("focus");
    // Linear (about 300 ms locally, 700 ms at 80,000 steps); slow CI runners
    // take ~8x, while a quadratic regression would take minutes.
    expect(ms).toBeLessThan(5000);
  }, HEAVY);

  it("wraps a 3,000-output fan-out within the width budget", () => {
    const nodes = [node("source"), ...Array.from({ length: 3000 }, (_, index) => node(`out${index}`, ["source"]))];
    const { value, ms } = render(nodes, "source", 1100);
    expect(value.layout.nodes.size).toBe(3001);
    expect(value.layout.width).toBeLessThanOrEqual(1100);
    expect(ms).toBeLessThan(4000);
  }, 20000);

  it("projects a 10,000-image folder of many components and lays out a focused one", () => {
    const next = random(42);
    const nodes: TraceNode[] = [];
    for (let component = 0; component < 500; component++) {
      const keys: string[] = [];
      for (let index = 0; index < 20; index++) {
        const key = `c${component}-${index}`;
        const parents = keys.length ? [...new Set(Array.from({ length: 1 + Math.floor(next() * 3) }, () => keys[Math.floor(next() * keys.length)]))] : [];
        nodes.push(node(key, index && next() < 0.9 ? parents : []));
        keys.push(key);
      }
    }
    const projected = timed(() => connectedComponents(projectDag(nodes)));
    expect(projected.value.length).toBeGreaterThanOrEqual(500);
    // Projection is linear (about 20 ms here); a per-component rebuild once made it quadratic (700 ms).
    expect(projected.ms).toBeLessThan(300);
    const { value, ms } = render(nodes, "c250-19");
    expect(tileOverlaps(value.layout)).toEqual([]);
    expect(ms).toBeLessThan(1500);
  }, 20000);
});
