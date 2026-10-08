import { describe, expect, it } from "vitest";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { planScene } from "$lib/domain/trace-graph/scene";
import { layoutGraph, type GraphLayout, type Orientation } from "$lib/domain/trace-graph/layout";
import { chooseOrientation, generationProfile, sidewaysWidth, type GenerationProfile } from "$lib/domain/trace-graph/orientation";
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

const shape = (depth: number, breadth: number, extra = 0): GenerationProfile => ({ depth, breadth, span: depth, channelExtra: () => extra });

const running = (key: string, parents: string[]) => node(key, parents, "current", { state: "running", temporary: true, artifactId: null, path: null });
const unsaved = (key: string, parents: string[]) => node(key, parents, "current", { temporary: true });
const discarded = (key: string, parents: string[]) => node(key, parents, "current", { temporary: true, discarded: true });

/** Lays out the component holding `focus` with `previous` as the orientation it is shown with. */
function shown(nodes: TraceNode[], focus: string, width: number, previous?: Orientation): GraphLayout {
  const dag = projectDag(nodes);
  const members = connectedComponents(dag).find((component) => component.includes(focus))!;
  return layoutGraph(planScene(dag, members, focus, width, { previous }).request);
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

  it("keeps a left-to-right component's canvas and columns fixed while selection reveals deeper generations", () => {
    const nodes = [node("forest"), node("mist", ["forest"]), node("autumn", ["forest"]), node("dawn", ["mist"]), node("dusk", ["dawn"])];
    const layouts = [null, "mist", "dawn", "dusk", "autumn"].map((focus) => render(nodes, focus, 900));
    expect(new Set(layouts.map((layout) => layout.nodes.size)).size).toBeGreaterThan(1);
    for (const layout of layouts) expect(flow(layout, nodes)).toBe("right");
    // One canvas width, so a centred canvas never shifts; and every tile keeps its column.
    expect(new Set(layouts.map((layout) => layout.width)).size).toBe(1);
    for (const entry of nodes) expect(new Set(layouts.map((layout) => layout.nodes.get(entry.key)?.x).filter((x) => x !== undefined)).size, entry.key).toBe(1);
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
    expect(generationProfile(dag, members)).toMatchObject({ depth: 3, breadth: 2 });
    expect(generationProfile(dag, [])).toMatchObject({ depth: 0, breadth: 0 });
    // A deep chain is counted without recursion.
    const deep = projectDag(chain(20000));
    expect(generationProfile(deep, deep.order)).toMatchObject({ depth: 20000, breadth: 1 });
  });

  it("falls back to top to bottom for single images and invalid widths", () => {
    expect(chooseOrientation(shape(1, 1), 900)).toBe("down");
    expect(chooseOrientation(shape(0, 0), 900)).toBe("down");
    for (const width of [Number.NaN, 0, -100, -Infinity]) {
      for (const previous of [undefined, "right", "down"] as const) expect(chooseOrientation(shape(3, 1), width, previous), `${width} after ${previous}`).toBe("down");
    }
    expect(chooseOrientation(shape(3, 1), Infinity)).toBe("right");
    // As many generations as the widest has images: square, so sideways.
    expect(chooseOrientation(shape(2, 2), 900)).toBe("right");
    expect(chooseOrientation(shape(2, 3), 900)).toBe("down");
  });

  it("takes the shape from settled images only, but the drawn span from everything", () => {
    const dag = projectDag([node("root"), node("a", ["root"]), node("b", ["root"]),
      ...["g1", "g2", "g3"].map((key) => running(key, ["root"])), unsaved("u", ["a"]), node("kept", ["u"]), discarded("d", ["kept"])]);
    // kept hangs off the settled images only through the unsaved u: not part of the shape.
    expect(generationProfile(dag, dag.order)).toMatchObject({ depth: 2, breadth: 2, span: 5 });
  });

  it("ignores the reference inputs a pending output pulls into the component", () => {
    // Older external references, combined with a by a running output: settled, but connected only through it.
    const refs = ["s1", "s2", "s3"].map((key) => node(key, [], "external"));
    const base = [node("root"), node("a", ["root"]), node("b", ["root"])];
    const dag = projectDag([...refs, ...base, running("r", ["a", "s1", "s2", "s3"])]);
    const [members] = connectedComponents(dag);
    expect(members).toContain("s1");
    expect(generationProfile(dag, members)).toMatchObject({ depth: 2, breadth: 2, span: 3 });
    for (const previous of [undefined, "right"] as const) expect(shown([...refs, ...base, running("r", ["a", "s1", "s2", "s3"])], "a", 700, previous).orientation, String(previous)).toBe("right");
  });

  it("makes room for a pending output in a new deepest generation, or turns rather than overflow", () => {
    const base = [node("root"), node("a", ["root"]), node("b", ["a"])];
    const fit = sidewaysWidth(generationProfile(projectDag(base), projectDag(base).order));
    const generating = [...base, running("c", ["b"])];
    const roomy = sidewaysWidth(generationProfile(projectDag(generating), projectDag(generating).order));
    expect(roomy).toBeGreaterThan(fit);
    // Just wide enough for the settled images: generating a column more turns it, even shown sideways.
    expect(shown(base, "a", fit, "right").orientation).toBe("right");
    for (const focus of ["root", "a", "b", "c"]) {
      const tight = shown(generating, focus, fit, "right");
      expect(tight.orientation, focus).toBe("down");
      expect(tight.width, focus).toBeLessThanOrEqual(fit);
      // With room for the new column it stays sideways, its canvas holding every column within the pane.
      const wide = shown(generating, focus, roomy, "right");
      expect(wide.orientation, focus).toBe("right");
      expect(wide.width, focus).toBe(roomy);
      expect(wide.nodes.get("c")?.x ?? 0, focus).toBeLessThan(roomy);
    }
  });

  it("estimates the width junctions add between generations, so a sideways canvas stays within the pane", () => {
    // Every step combines the previous image with one shared reference: a junction in every channel.
    const nodes = [node("x0"), node("style", [], "external"), ...Array.from({ length: 4 }, (_, index) => node(`x${index + 1}`, [`x${index}`, "style"]))];
    const dag = projectDag(nodes);
    const plain = sidewaysWidth({ ...generationProfile(dag, dag.order), channelExtra: () => 0 });
    expect(sidewaysWidth(generationProfile(dag, dag.order))).toBeGreaterThan(plain);
    let sideways = 0;
    for (let width = plain - 40; width <= plain + 200; width += 4) {
      for (const focus of [null, ...dag.order]) {
        const layout = render(nodes, focus, width);
        if (layout.orientation !== "right") continue;
        sideways++;
        expect(layout.width, `${width}px, focus ${focus}`).toBeLessThanOrEqual(width);
      }
    }
    expect(sideways).toBeGreaterThan(0);
  });

  it("keeps left-to-right canvases within 5% of the width they are given on random graphs, pending outputs included", () => {
    let sideways = 0, withPending = 0;
    for (let seed = 1; seed <= 150; seed++) for (const pendingShare of [0, 0.2]) {
      const next = random(seed * 104729);
      const count = 4 + Math.floor(next() * 22), fanIn = 1 + Math.floor(next() * 3), locality = 1 + Math.floor(next() * 6);
      const nodes = Array.from({ length: count }, (_, index) => {
        const root = index === 0 || next() < 0.12;
        const parents = root ? [] : [...new Set(Array.from({ length: 1 + Math.floor(next() * fanIn) }, () => `n${Math.max(0, index - 1 - Math.floor(next() * Math.min(index, locality)))}`))];
        const pending = !root && next() < pendingShare;
        return node(`n${index}`, parents, root && next() < 0.15 ? "external" : "current", pending ? { temporary: true } : {});
      });
      const dag = projectDag(nodes);
      for (const members of connectedComponents(dag)) for (const width of [400, 560, 720, 900, 1200]) for (const focus of [null, ...members]) {
        for (const previous of [undefined, "right"] as const) {
          const plan = planScene(dag, members, focus, width, { previous });
          if (plan.request.orientation !== "right") continue;
          sideways++;
          if (members.some((key) => dag.nodes.get(key)!.temporary)) withPending++;
          expect(layoutGraph(plan.request).width, `seed ${seed} (${pendingShare} pending) at ${width}px, focus ${focus}, after ${previous}`).toBeLessThanOrEqual(width * 1.05);
        }
      }
    }
    // The sweep exercises the sideways case thoroughly, not vacuously.
    expect(sideways).toBeGreaterThan(2000);
    expect(withPending).toBeGreaterThan(500);
  }, 60_000);

  it("keeps a remembered orientation until the rule fails by a clear margin", () => {
    // Slightly broader than deep: top to bottom when fresh, but a sideways component stays sideways.
    expect(chooseOrientation(shape(3, 4), 900)).toBe("down");
    expect(chooseOrientation(shape(3, 4), 900, "right")).toBe("right");
    expect(chooseOrientation(shape(3, 4), 900, "down")).toBe("down");
    // Clearly broader: even a sideways component turns.
    expect(chooseOrientation(shape(3, 6), 900, "right")).toBe("down");
    // Just square: sideways when fresh, but a top-to-bottom component stays so until clearly deeper.
    expect(chooseOrientation(shape(3, 3), 900)).toBe("right");
    expect(chooseOrientation(shape(3, 3), 900, "down")).toBe("down");
    expect(chooseOrientation(shape(4, 3), 900, "down")).toBe("right");
  });

  it("never lets a remembered orientation overflow the pane, and needs clear room to turn sideways", () => {
    const profile = shape(3, 1);
    const fit = sidewaysWidth(profile);
    expect(chooseOrientation(profile, fit)).toBe("right");
    expect(chooseOrientation(profile, fit - 1)).toBe("down");
    // Shown sideways, it stays so while it fits and turns as soon as it would overflow.
    expect(chooseOrientation(profile, fit, "right")).toBe("right");
    expect(chooseOrientation(profile, fit - 1, "right")).toBe("down");
    // Shown top to bottom, a pane only just wide enough does not turn it.
    expect(chooseOrientation(profile, fit, "down")).toBe("down");
    expect(chooseOrientation(profile, Math.ceil(fit / 0.9), "down")).toBe("right");
  });

  describe("while images are generated into a component", () => {
    // The user's example: a root, two edits, and two edits of one of them; sideways at 700 px.
    const base = () => [node("root"), node("cerulean", ["root"]), node("saffron", ["root"]), node("replace-1", ["saffron"]), node("replace-2", ["saffron"])];
    const batch = (state: "running" | "unsaved" | "discarded" | "saved") => ["v1", "v2", "v3", "v4"].map((key) =>
      state === "running" ? running(key, ["root"]) : state === "unsaved" ? unsaved(key, ["root"]) : state === "discarded" ? discarded(key, ["root"]) : node(key, ["root"]));
    const columns = (layout: GraphLayout) => Object.fromEntries(["root", "cerulean", "saffron", "replace-1"].map((key) => [key, layout.nodes.get(key)!.x]));

    it("stays left to right, with no tile changing column, through a batch generation, its completion and its discard", () => {
      const before = shown(base(), "replace-1", 700);
      expect(flow(before, base())).toBe("right");
      for (const state of ["running", "unsaved", "discarded"] as const) {
        const nodes = [...base(), ...batch(state)];
        // Whether or not the orientation it is shown with is known.
        for (const previous of [undefined, "right"] as const) {
          const layout = shown(nodes, "replace-1", 700, previous);
          expect(flow(layout, nodes), `${state} after ${previous}`).toBe("right");
          expect(layout.nodes.has("v1"), state).toBe(true);
          expect(columns(layout), state).toEqual(columns(before));
        }
      }
    });

    it("stays left to right when the batch is saved, unless the component becomes clearly broader than deep", () => {
      // Two saved variations: four edits of root across three generations.
      const saved = [...base(), ...batch("saved").slice(0, 2)];
      expect(flow(shown(saved, "replace-1", 700, "right"), saved)).toBe("right");
      // Seen afresh it runs top to bottom: the hysteresis keeps it sideways.
      expect(flow(shown(saved, "replace-1", 700), saved)).toBe("down");
      const broad = [...base(), ...batch("saved"), node("v5", ["root"]), node("v6", ["root"])];
      expect(flow(shown(broad, "replace-1", 700, "right"), broad)).toBe("down");
    });
  });
});
