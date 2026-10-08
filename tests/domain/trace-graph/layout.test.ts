import { describe, expect, it } from "vitest";
import { layoutGraph, nearestFree, nearestInDirection, wrapRow, type LayoutItem, type Orientation } from "$lib/domain/trace-graph/layout";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { planScene } from "$lib/domain/trace-graph/scene";
import { SPACING, tileSize } from "$lib/domain/trace-graph/metrics";
import { foreignJunctionContacts, mockupNodes, node, random, routeCollisions, sharedLanes, sourcesReaching, tileOverlaps } from "./fixtures";

/** Correctness sweeps over many graphs: slower CI runners need more than the default 5 s. */
const HEAVY = 30_000;
const small = tileSize({ foreign: false, hint: false });
const tall = tileSize({ foreign: true, hint: true });
/**
 * The engine lays out items of any size. The view gives every tile one width
 * (metrics.ts), but the sweeps also mix in wider items so the engine's
 * guarantees never silently depend on uniform widths.
 */
const wide = { width: 168, height: 152 };
const item = (key: string, parents: string[] = [], size = small, order = 0): LayoutItem => ({ key, parents, width: size.width, height: size.height, order });

function fanOut(children: number): LayoutItem[] {
  return [item("p", [], wide), ...Array.from({ length: children }, (_, index) => item(`c${index}`, ["p"], wide, index + 1)),
    item("g0", ["c0"]), item("g1", ["c5"]), item("g2", ["c17"])];
}

const ORIENTATIONS: readonly Orientation[] = ["down", "right"];

function checkLayout(items: readonly LayoutItem[], maxWidth: number, orientation: Orientation = "down") {
  const layout = layoutGraph({ items, maxWidth, orientation });
  expect(layout.orientation).toBe(orientation);
  expect(tileOverlaps(layout)).toEqual([]);
  expect(routeCollisions(layout)).toEqual([]);
  expect(junctionOverlaps(layout)).toEqual([]);
  // Everything drawn lies on the canvas (widening covers what the margins need).
  const onCanvas = (x: number, y: number, what: string) => {
    expect(x, what).toBeGreaterThanOrEqual(0);
    expect(x, what).toBeLessThanOrEqual(layout.width);
    expect(y, what).toBeGreaterThanOrEqual(0);
    expect(y, what).toBeLessThanOrEqual(layout.height);
  };
  for (const route of layout.routes) for (const [, x, y] of route.path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) onCanvas(Number(x), Number(y), route.id);
  for (const tile of layout.nodes.values()) { onCanvas(tile.x, tile.y, tile.key); onCanvas(tile.x + tile.width, tile.y + tile.height, tile.key); }
  for (const junction of layout.junctions.values()) onCanvas(junction.x, junction.y, junction.id);
  const ids = layout.routes.map((route) => route.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index), "duplicate route ids").toEqual([]);
  // Parents come first along the flow: above their children, or to their left.
  for (const entry of items) for (const parent of entry.parents) {
    const child = layout.nodes.get(entry.key)!, source = layout.nodes.get(parent)!;
    if (orientation === "down") expect(child.y, `${parent} above ${entry.key}`).toBeGreaterThan(source.y + source.height);
    else expect(child.x, `${parent} left of ${entry.key}`).toBeGreaterThan(source.x + source.width);
  }
  return layout;
}

/** Pairs of junction dots closer than a dot's diameter. */
function junctionOverlaps(layout: ReturnType<typeof layoutGraph>): string[] {
  const placed = [...layout.junctions.values()];
  const overlaps: string[] = [];
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    if (Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) < 6) overlaps.push(`${placed[i].id} ${placed[j].id}`);
  }
  return overlaps;
}

describe("row wrapping", () => {
  it("uses the fewest rows and balances them", () => {
    expect(wrapRow([100, 100, 100, 100, 100], 340, 20)).toEqual([[0, 1, 2], [3, 4]]);
    expect(wrapRow([100, 100, 100, 100, 100, 100, 100], 560, 20)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
    expect(wrapRow([], 100, 10)).toEqual([]);
    expect(wrapRow([500], 100, 10)).toEqual([[0]]);
  });
});

describe("width-aware layout", () => {
  it("wraps a wide fan-out across several rows within the budget at different preview widths", () => {
    let previousRows = Infinity;
    for (const width of [420, 700, 1100, 1600]) {
      const layout = checkLayout(fanOut(18), width);
      expect(layout.width).toBeLessThanOrEqual(width);
      const childRows = new Set([...layout.nodes.values()].filter((tile) => tile.key.startsWith("c")).map((tile) => tile.row));
      expect(childRows.size).toBeLessThanOrEqual(previousRows);
      previousRows = childRows.size;
    }
    expect(previousRows).toBeLessThan(18);
  });

  it("does not treat display rows as generation boundaries", () => {
    const layout = checkLayout(fanOut(18), 700);
    const children = [...layout.nodes.values()].filter((tile) => tile.key.startsWith("c"));
    expect(new Set(children.map((tile) => tile.band))).toEqual(new Set([1]));
    expect(new Set(children.map((tile) => tile.row)).size).toBeGreaterThan(1);
  });

  it("routes shared subsets, identical sets and mixed generations without crossing tiles", () => {
    const dag = projectDag(mockupNodes());
    for (const members of connectedComponents(dag)) {
      for (const focus of [null, ...members]) {
        for (const width of [380, 640, 1200]) for (const orientation of ORIENTATIONS) {
          const scene = planScene(dag, members, focus, width);
          const layout = checkLayout(scene.request.items, width, orientation);
          for (const entry of scene.request.items) {
            expect(sorted(sourcesReaching(layout, entry.key))).toEqual(sorted(entry.parents));
            expect(layout.routes.filter((route) => route.terminal && route.to.id === entry.key)).toHaveLength(entry.parents.length ? 1 : 0);
          }
        }
      }
    }
  }, HEAVY);

  it("stays collision free on random graphs with mixed tile sizes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const next = random(seed);
      const items = Array.from({ length: 30 }, (_, index) => {
        const count = index === 0 ? 0 : Math.floor(next() * 3);
        const parents = [...new Set(Array.from({ length: count }, () => `n${Math.floor(next() * index)}`))];
        return item(`n${index}`, index && !parents.length ? [`n${Math.floor(next() * index)}`] : parents, next() < 0.3 ? wide : small, index);
      });
      const width = 300 + Math.floor(next() * 900);
      for (const orientation of ORIENTATIONS) checkLayout(items, width, orientation);
    }
  }, HEAVY);

  it("never routes through a junction that does not combine that route's input", () => {
    // n4's inputs are n1 and n2 only; n1's route must not touch the (n0, n1) junction on its way down.
    const items = [item("n0", [], small, 0), item("n1", [], small, 1), item("n2", ["n1", "n0"], small, 2), item("n3", ["n2"], small, 3), item("n4", ["n1", "n2"], small, 4)];
    for (const width of [380, 640]) for (const orientation of ORIENTATIONS) expect(foreignJunctionContacts(checkLayout(items, width, orientation), 5)).toEqual([]);
  });

  it("keeps routes clear of foreign junctions and in separate lanes on random graphs", () => {
    const sizes = [wide, small, small, tall];
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed * 7919);
      const count = 8 + Math.floor(next() * 40), fanIn = 1 + Math.floor(next() * 4), locality = 2 + Math.floor(next() * 10);
      const items = Array.from({ length: count }, (_, index) => {
        const root = next() < 0.15 || index < 2;
        const parents = root ? [] : [...new Set(Array.from({ length: 1 + Math.floor(next() * fanIn) }, () => `n${Math.max(0, index - 1 - Math.floor(next() * Math.min(index, locality)))}`))];
        return item(`n${index}`, parents, sizes[Math.floor(next() * sizes.length)], index);
      });
      // Running right, generations never wrap, so the width budget does not change the layout.
      const cases = [...[380, 640, 1000].map((width) => ({ width, orientation: "down" as const })), { width: 640, orientation: "right" as const }];
      for (const { width, orientation } of cases) {
        const label = `seed ${seed} ${orientation} at ${width}px`;
        const layout = checkLayout(items, width, orientation);
        expect(foreignJunctionContacts(layout, 5), label).toEqual([]);
        expect(sharedLanes(layout), label).toEqual([]);
        for (const entry of items) expect(sorted(sourcesReaching(layout, entry.key)), `${label}: ${entry.key}`).toEqual(sorted(entry.parents));
        // Ordinary graphs fit the width they are given; only overflow widens it.
        if (orientation === "down") expect(layout.width, label).toBeLessThanOrEqual(width * 1.05);
      }
    }
  }, HEAVY);

  it("gives many sources passing one gap distinct lanes", () => {
    // Eight roots all feed the bottom row past a full-width middle row with one narrow gap layout.
    const roots = Array.from({ length: 8 }, (_, index) => item(`r${index}`, [], small, index));
    const middle = [item("m0", ["r0"], wide, 10), item("m1", ["r7"], wide, 11)];
    const sinks = roots.map((root, index) => item(`s${index}`, [root.key, middle[index % 2].key], small, 20 + index));
    const layout = checkLayout([...roots, ...middle, ...sinks], 420);
    expect(sharedLanes(layout)).toEqual([]);
    expect(foreignJunctionContacts(layout, 5)).toEqual([]);
  });

  it("opens deeper junction levels instead of overlapping junctions when a level is full", () => {
    // One style applied to many photos: every output combines the style with its own photo.
    for (const photos of [10, 16, 24]) for (const width of [380, 640]) {
      const items = [item("style", [], small, 0), ...Array.from({ length: photos }, (_, index) => item(`p${index}`, [], small, index + 1)),
        ...Array.from({ length: photos }, (_, index) => item(`o${index}`, ["style", `p${index}`], small, 100 + index))];
      const layout = checkLayout(items, width);
      expect(foreignJunctionContacts(layout, 5)).toEqual([]);
      expect(sharedLanes(layout)).toEqual([]);
    }
  });

  it("widens its margins instead of merging lanes or stacking dots when a channel overflows", () => {
    // Sixty independent sources each combine with one of a few tiles in a
    // narrow wall of rows. (Widening for junctions stops at two more view
    // widths, so more walls than this would stack dots; a documented limit.)
    for (const walls of [2, 3, 4]) {
      const sources = Array.from({ length: 60 }, (_, index) => item(`s${index}`, [], small, index));
      const wall = Array.from({ length: walls }, (_, index) => item(`w${index}`, [`s${index}`], wide, 100 + index));
      const outputs = sources.map((source, index) => item(`o${index}`, [source.key, wall[index % walls].key], small, 200 + index));
      const layout = checkLayout([...sources, ...wall, ...outputs], 380);
      expect(sharedLanes(layout), `${walls} walls`).toEqual([]);
      expect(foreignJunctionContacts(layout, 5), `${walls} walls`).toEqual([]);
    }
  }, HEAVY);

  it("keeps crowded junction channels unambiguous", () => {
    // Every pair of a dozen inputs combined: 66 junctions in one channel.
    for (const width of [380, 640]) {
      const roots = Array.from({ length: 12 }, (_, index) => item(`r${index}`, [], small, index));
      const pairs = roots.flatMap((a, i) => roots.slice(i + 1).map((b) => item(`${a.key}+${b.key}`, [a.key, b.key], small, 100 + i)));
      const layout = checkLayout([...roots, ...pairs], width);
      expect(foreignJunctionContacts(layout, 5), `${width}px`).toEqual([]);
      expect(sharedLanes(layout), `${width}px`).toEqual([]);
    }
    // Outputs of 2 to 5 inputs each, then a generation combining outputs with
    // inputs again. Routes never touch a foreign junction. Lanes may still
    // meet where bend-order constraints form a cycle (no dogleg routing yet, a
    // documented limit): at most one such graph here.
    const merged: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const roots = Array.from({ length: 8 }, (_, index) => item(`r${index}`, [], next() < 0.3 ? wide : small, index));
      const outputs = Array.from({ length: 6 + Math.floor(next() * 10) }, (_, index) => {
        const inputs = new Set<string>();
        for (const size = 2 + Math.floor(next() * 4); inputs.size < size;) inputs.add(`r${Math.floor(next() * 8)}`);
        return item(`o${index}`, [...inputs], small, 100 + index);
      });
      const second = Array.from({ length: 4 }, (_, index) => item(`q${index}`, [`o${index}`, `r${(index * 3) % 8}`, `o${(index + 1) % outputs.length}`], small, 200 + index));
      for (const width of [380, 640]) {
        const layout = checkLayout([...roots, ...outputs, ...second], width);
        expect(foreignJunctionContacts(layout, 5), `seed ${seed} at ${width}px`).toEqual([]);
        if (sharedLanes(layout).length) merged.push(`seed ${seed} at ${width}px`);
      }
    }
    expect(merged.length, merged.join(", ")).toBeLessThanOrEqual(1);
  }, HEAVY);

  it("gives trunks that reach one lane by different courses distinct ids", () => {
    // Found by review: two shared courses from n0 met in one gap and collided.
    const shape: Array<[string, string[]]> = [["n0", []], ["n1", ["n0"]], ["n2", ["n0"]], ["n3", ["n0"]], ["n4", ["n0"]], ["n5", []], ["n6", ["n3"]], ["n7", []], ["n8", ["n0"]], ["n9", ["n1", "n7"]], ["n10", ["n8", "n5"]], ["n11", ["n9", "n8"]], ["n12", ["n0"]]];
    const dag = projectDag(shape.map(([name, parents], index) => node(name, parents, "current", { order: index })));
    for (const members of connectedComponents(dag)) for (const focus of [null, ...members]) for (const width of [384, 520, 640]) {
      checkLayout(planScene(dag, members, focus, width).request.items, width);
    }
  });

  it("names a trunk by the consumers it carries, so it keeps its id when relayout moves it", () => {
    const items = [item("p", [], wide), ...Array.from({ length: 12 }, (_, index) => item(`c${index}`, ["p"], small, index + 1))];
    const trunks = (width: number) => new Map(layoutGraph({ items, maxWidth: width }).routes.filter((route) => route.to === route.from)
      .map((route) => [route.consumers.map((entry) => entry.child).sort().join(","), route] as const));
    const narrow = trunks(380), wider = trunks(392);
    let moved = 0;
    for (const [carried, route] of narrow) {
      const other = wider.get(carried);
      if (!other) continue;
      expect(other.id).toBe(route.id);
      if (other.path !== route.path) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("draws a shared trunk once, so a large fan-out's path data stays proportional to its rows", () => {
    const items = [item("p", [], wide), ...Array.from({ length: 1000 }, (_, index) => item(`c${index}`, ["p"], small, index + 1))];
    const layout = checkLayout(items, 380);
    const bytes = layout.routes.reduce((sum, route) => sum + route.path.length, 0);
    expect(layout.rows.length).toBeGreaterThan(100);
    expect(bytes).toBeLessThan(250_000);
    for (const entry of items.slice(1, 50)) expect([...sourcesReaching(layout, entry.key)]).toEqual(["p"]);
    // Trunks carry every consumer they stand for and never draw an arrow.
    const trunks = layout.routes.filter((route) => route.to === route.from);
    expect(trunks.length).toBeGreaterThan(0);
    for (const trunk of trunks) expect(trunk.terminal).toBe(false);
    expect(new Set(trunks.flatMap((trunk) => trunk.consumers.map((consumer) => consumer.child))).size).toBeGreaterThan(900);
  }, HEAVY);

  it("orders ties consistently when only some keys have a previous position", () => {
    // x and z keep their hinted order; y is new and merges in by creation order.
    const items = [item("x", [], small, 3), item("y", [], small, 2), item("z", [], small, 1)];
    const hint = new Map([["x", 0], ["z", 1]]);
    const orders = [items, [...items].reverse(), [items[1], items[2], items[0]]]
      .map((permutation) => [...layoutGraph({ items: permutation, maxWidth: 900, hint }).readingOrder.keys()]);
    expect(orders[0]).toEqual(["y", "x", "z"]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  it("is deterministic and keeps junction identities across relayouts", () => {
    const items = [item("a"), item("b"), item("c"), item("d", ["a", "b", "c"]), item("e", ["a", "b"])];
    const first = layoutGraph({ items, maxWidth: 600 });
    const second = layoutGraph({ items, maxWidth: 600 });
    expect(second.routes.map((route) => route.path)).toEqual(first.routes.map((route) => route.path));
    const narrower = layoutGraph({ items, maxWidth: 380 });
    expect([...narrower.junctions.keys()].sort()).toEqual([...first.junctions.keys()].sort());
  });

  it("preserves previous ordering through the hint", () => {
    const items = [item("x", [], small, 2), item("y", [], small, 1)];
    expect([...layoutGraph({ items, maxWidth: 800 }).readingOrder.keys()]).toEqual(["y", "x"]);
    expect([...layoutGraph({ items, maxWidth: 800, hint: new Map([["x", 0], ["y", 1]]) }).readingOrder.keys()]).toEqual(["x", "y"]);
  });

  it("handles empty, unknown-parent, oversized and invalid-width input", () => {
    expect(layoutGraph({ items: [], maxWidth: 500 }).height).toBe(0);
    const unknown = layoutGraph({ items: [item("x", ["ghost", "x"])], maxWidth: 500 });
    expect(unknown.routes).toEqual([]);
    const huge = layoutGraph({ items: [{ key: "w", parents: [], width: 4000, height: 100, order: 0 }], maxWidth: 500 });
    expect(huge.width).toBeGreaterThanOrEqual(4000);
    for (const width of [Number.NaN, 0, -5, Infinity]) expect(Number.isFinite(layoutGraph({ items: fanOut(4), maxWidth: width }).width)).toBe(true);
    // Malformed tile sizes never turn into NaN or infinite geometry.
    const malformed = [Number.NaN, Infinity, -Infinity, -20].map((bad, index) => ({ key: `m${index}`, parents: index ? ["m0"] : [], width: bad, height: bad, order: index }));
    const broken = layoutGraph({ items: [...fanOut(3), ...malformed], maxWidth: 500 });
    expect(Number.isFinite(broken.width) && Number.isFinite(broken.height)).toBe(true);
    for (const route of broken.routes) expect(route.path, route.id).not.toMatch(/NaN|Infinity/);
    // Absurdly large sizes are clamped (they would otherwise stall the routing loops or overflow).
    const giant = layoutGraph({ items: [item("a"), { key: "b", parents: ["a"], width: 1e17, height: 1e308, order: 1 }, item("c", ["b"])], maxWidth: 500 });
    expect(Number.isFinite(giant.width) && Number.isFinite(giant.height)).toBe(true);
    for (const route of giant.routes) expect(route.path, route.id).not.toMatch(/NaN|Infinity|e\+/);
    // An order that is not a number still sorts deterministically, whatever the input order.
    const unordered = Array.from({ length: 8 }, (_, index) => ({ ...item(`u${index}`, index ? ["u0"] : []), order: index % 2 ? Number.NaN : index }));
    const reading = (items: LayoutItem[]) => [...layoutGraph({ items, maxWidth: 500 }).readingOrder.keys()].join(",");
    expect(reading([...unordered].reverse())).toBe(reading(unordered));
  });

  it("lays out a large visible neighbourhood quickly", () => {
    const items = Array.from({ length: 600 }, (_, index) => item(`n${index}`, index ? [`n${Math.floor(index / 4)}`] : [], index % 7 ? small : wide, index));
    const start = performance.now();
    const layout = layoutGraph({ items, maxWidth: 1000 });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(tileOverlaps(layout)).toEqual([]);
  });
});

describe("left-to-right layout", () => {
  const ends = (path: string) => {
    const points = [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
    return { first: points[0], last: points.at(-1)! };
  };

  it("places each generation in its own column, parents left of their children, with arrows entering from the left", () => {
    const items = [item("a", [], tall), item("b", ["a"]), item("c", ["b"]), item("d", ["b"], tall), item("e", ["c", "d"])];
    const layout = checkLayout(items, 900, "right");
    const columns = (key: string) => layout.nodes.get(key)!.x;
    expect(columns("c")).toBe(columns("d"));
    expect(new Set(["a", "b", "c", "e"].map(columns)).size).toBe(4);
    // Every tile keeps its own size; only its position changes.
    for (const entry of items) expect([layout.nodes.get(entry.key)!.width, layout.nodes.get(entry.key)!.height]).toEqual([entry.width, entry.height]);
    for (const route of layout.routes.filter((candidate) => candidate.terminal)) {
      const target = layout.nodes.get(route.to.id)!;
      const { last } = ends(route.path);
      expect(last.x, route.id).toBeCloseTo(target.x - SPACING.arrow, 1);
      expect(last.y, route.id).toBeCloseTo(target.y + target.height / 2, 1);
    }
    for (const route of layout.routes.filter((candidate) => candidate.from.kind === "node" && candidate.to !== candidate.from)) {
      const source = layout.nodes.get(route.from.id)!;
      const { first } = ends(route.path);
      if (first.y !== source.y + source.height / 2) continue; // a branch leaving a shared trunk
      expect(first.x, route.id).toBeCloseTo(source.x + source.width, 1);
    }
  });

  it("never wraps a generation, whatever the width budget", () => {
    const items = [item("p"), ...Array.from({ length: 12 }, (_, index) => item(`c${index}`, ["p"], small, index + 1))];
    const layout = checkLayout(items, 380, "right");
    expect(new Set([...layout.nodes.values()].filter((tile) => tile.key !== "p").map((tile) => tile.x)).size).toBe(1);
  });

  it("keeps crowded junctions and shared inputs readable sideways", () => {
    const photos = 12;
    const styled = [item("style", [], small, 0), ...Array.from({ length: photos }, (_, index) => item(`p${index}`, [], small, index + 1)),
      ...Array.from({ length: photos }, (_, index) => item(`o${index}`, ["style", `p${index}`], small, 100 + index))];
    const roots = Array.from({ length: 8 }, (_, index) => item(`r${index}`, [], small, index));
    const pairs = roots.flatMap((a, i) => roots.slice(i + 1).map((b) => item(`${a.key}+${b.key}`, [a.key, b.key], small, 100 + i)));
    for (const items of [styled, [...roots, ...pairs]]) {
      const layout = checkLayout(items, 640, "right");
      expect(foreignJunctionContacts(layout, 5)).toEqual([]);
      expect(sharedLanes(layout)).toEqual([]);
    }
  });

  it("navigates along generations with left and right, and between siblings with up and down", () => {
    const layout = layoutGraph({ items: [item("p"), item("a", ["p"]), item("b", ["p"])], maxWidth: 600, orientation: "right" });
    expect(nearestInDirection(layout, "p", "right")).toMatch(/^[ab]$/);
    expect(nearestInDirection(layout, "a", "left")).toBe("p");
    expect(nearestInDirection(layout, "a", "down")).toBe("b");
    expect(nearestInDirection(layout, "p", "left")).toBeNull();
  });
});

describe("spacing", () => {
  it("packs siblings closely: six fit one row of a 700 px pane, with room for a route between neighbours", () => {
    const items = [item("p"), ...Array.from({ length: 6 }, (_, index) => item(`c${index}`, ["p"], small, index + 1))];
    const layout = checkLayout(items, 700);
    const children = [...layout.nodes.values()].filter((tile) => tile.key !== "p").sort((a, b) => a.x - b.x);
    expect(new Set(children.map((tile) => tile.row)).size).toBe(1);
    const gaps = children.slice(1).map((tile, index) => tile.x - (children[index].x + children[index].width));
    for (const gap of gaps) {
      expect(gap).toBeLessThanOrEqual(16);
      // A passing route keeps its clearance from both neighbours.
      expect(gap).toBeGreaterThan(2 * SPACING.clearance);
    }
  });

  it("stacks a sideways generation just as closely", () => {
    const items = [item("p"), ...Array.from({ length: 3 }, (_, index) => item(`c${index}`, ["p"], small, index + 1))];
    const children = [...layoutGraph({ items, maxWidth: 900, orientation: "right" }).nodes.values()].filter((tile) => tile.key !== "p").sort((a, b) => a.y - b.y);
    for (let index = 1; index < children.length; index++) expect(children[index].y - (children[index - 1].y + children[index - 1].height)).toBeLessThanOrEqual(16);
  });
});

describe("free positions", () => {
  it("finds the nearest point outside every interval, within bounds", () => {
    expect(nearestFree(50, [], 0, 100)).toBe(50);
    expect(nearestFree(50, [[40, 55]], 0, 100)).toBe(55.5);
    expect(nearestFree(50, [[40, 55]], 0, 52)).toBe(39.5);
    expect(nearestFree(50, [[45, 70]], 0, 100)).toBe(44.5);
    // Intervals closer than one step merge: no point squeezes between them.
    expect(nearestFree(50, [[40, 55], [55.2, 80]], 0, 100)).toBe(39.5);
    expect(nearestFree(30, [[0, 20], [20.2, 49], [51, 90]], 0, 100)).toBe(49.5);
    expect(nearestFree(5, [[0, 20]], 0, 100)).toBe(20.5);
    expect(nearestFree(50, [[-10, 110]], 0, 100)).toBeNull();
  });
});

describe("spatial navigation", () => {
  it("moves to the nearest tile in the pressed direction", () => {
    const layout = layoutGraph({ items: [item("p"), item("a", ["p"]), item("b", ["p"])], maxWidth: 600 });
    expect(nearestInDirection(layout, "p", "down")).toMatch(/^[ab]$/);
    expect(nearestInDirection(layout, "a", "right")).toBe("b");
    expect(nearestInDirection(layout, "a", "up")).toBe("p");
    expect(nearestInDirection(layout, "p", "up")).toBeNull();
    expect(nearestInDirection(layout, "missing", "up")).toBeNull();
  });
});

function sorted(values: Iterable<string>) { return [...values].sort(); }
