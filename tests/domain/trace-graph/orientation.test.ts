import { describe, expect, it } from "vitest";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { planScene } from "$lib/domain/trace-graph/scene";
import { layoutGraph, type GraphLayout } from "$lib/domain/trace-graph/layout";
import { chooseOrientation, generationProfile } from "$lib/domain/trace-graph/orientation";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { mockupNodes, node, random } from "./fixtures";

/** Lays out one component as the view would, focused on `focus`. */
function render(nodes: TraceNode[], focus: string | null, width: number): GraphLayout {
  const dag = projectDag(nodes);
  const members = connectedComponents(dag).find((component) => focus === null || component.includes(focus)) ?? dag.order;
  return layoutGraph(planScene(dag, members, focus, width).request);
}

/** Whether every child is drawn entirely right of (or below) each of its shown parents. */
function flow(layout: GraphLayout, nodes: TraceNode[]): "right" | "down" | "mixed" {
  let right = true, down = true;
  for (const entry of nodes) for (const parent of entry.parents) {
    const child = layout.nodes.get(entry.key), source = layout.nodes.get(parent);
    if (!child || !source) continue;
    right &&= child.x >= source.x + source.width;
    down &&= child.y >= source.y + source.height;
  }
  return right && !down ? "right" : down && !right ? "down" : "mixed";
}

const chain = (length: number) => Array.from({ length }, (_, index) => node(`s${index}`, index ? [`s${index - 1}`] : []));

describe("orientation", () => {
  it("lays a 3-generation chain out left to right in a wide pane", () => {
    const nodes = chain(3);
    const layout = render(nodes, "s1", 900);
    expect(layout.nodes.size).toBe(3);
    expect(flow(layout, nodes)).toBe("right");
    expect(layout.width).toBeLessThanOrEqual(900);
    // One row: the chain is no taller than one tile plus its margins.
    expect(layout.height).toBeLessThan(2 * layout.nodes.get("s0")!.height);
  });

  it("lays the user's example (a root, two edits, and two edits of one of them) out left to right", () => {
    const nodes = [node("root"), node("cerulean", ["root"]), node("saffron", ["root"]), node("replace-1", ["saffron"]), node("replace-2", ["saffron"])];
    for (const focus of [null, "saffron", "replace-1"]) expect(flow(render(nodes, focus, 700), nodes), `focus ${focus}`).toBe("right");
  });

  it("runs top to bottom when the generations do not fit side by side", () => {
    const nodes = chain(3);
    expect(flow(render(nodes, "s1", 300), nodes)).toBe("down");
    const long = chain(12);
    expect(flow(render(long, "s11", 900), long)).toBe("down");
  });

  it("keeps a wide fan-out top to bottom, wrapping its generation onto rows", () => {
    const nodes = [node("p"), ...Array.from({ length: 6 }, (_, index) => node(`c${index}`, ["p"]))];
    const layout = render(nodes, "p", 1600);
    expect(flow(layout, nodes)).toBe("down");
  });

  it("never changes a component's orientation when the selection changes", () => {
    const check = (nodes: TraceNode[], width: number, label: string) => {
      const dag = projectDag(nodes);
      for (const members of connectedComponents(dag)) {
        const seen = new Set(([null, ...members] as (string | null)[]).map((focus) => layoutGraph(planScene(dag, members, focus, width).request).orientation));
        expect(seen.size, `${label}: component of ${members[0]}`).toBe(1);
      }
    };
    for (const width of [380, 640, 1200]) check(mockupNodes(), width, `mockup at ${width}px`);
    for (let seed = 1; seed <= 20; seed++) {
      const next = random(seed);
      const nodes = Array.from({ length: 14 }, (_, index) => node(`n${index}`, index && next() < 0.85 ? [`n${Math.floor(next() * index)}`] : []));
      check(nodes, 400 + Math.floor(next() * 800), `seed ${seed}`);
    }
  });

  it("counts generations and the widest generation of the whole component", () => {
    const dag = projectDag([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"]), node("lone")]);
    const [members] = connectedComponents(dag);
    expect(generationProfile(dag, members)).toEqual({ depth: 3, breadth: 2 });
    expect(generationProfile(dag, [])).toEqual({ depth: 0, breadth: 0 });
    // A deep chain is counted without recursion.
    const deep = projectDag(chain(20000));
    expect(generationProfile(deep, deep.order)).toEqual({ depth: 20000, breadth: 1 });
  });

  it("falls back to top to bottom for single images and invalid widths", () => {
    expect(chooseOrientation({ depth: 1, breadth: 1 }, 900)).toBe("down");
    expect(chooseOrientation({ depth: 0, breadth: 0 }, 900)).toBe("down");
    for (const width of [Number.NaN, 0, -100, -Infinity]) expect(chooseOrientation({ depth: 3, breadth: 1 }, width), String(width)).toBe("down");
    expect(chooseOrientation({ depth: 3, breadth: 1 }, Infinity)).toBe("right");
    // As many generations as the widest has images: square, so sideways.
    expect(chooseOrientation({ depth: 2, breadth: 2 }, 900)).toBe("right");
    expect(chooseOrientation({ depth: 2, breadth: 3 }, 900)).toBe("down");
  });
});
