import { describe, expect, it } from "vitest";
import { downwardBandBound, layoutLayered, type LayoutItem, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { bandExtent, withBandBounds, withPaneBandBounds } from "$lib/domain/trace-graph/band-geometry";
import { routePlan } from "$lib/domain/trace-graph/layout-quality";
import { STACK_STEM_ROOM } from "$lib/domain/trace-graph/metrics";

const rng = (seed: number) => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const item = (key: string, parents: string[] = [], order = 0, width = 92, height = 97): LayoutItem => ({ key, parents, order, width, height });

/** The downward candidate exactly as the band engine builds it, measured the way it is scored. */
function actual(items: readonly LayoutItem[], maxWidth: number, channelStyle: "scaled" | "orthogonal" = "scaled") {
  const request: LayoutRequest = { items, maxWidth, tileWidth: 92, orientation: "down", pinned: { key: "root", x: Math.min(maxWidth, 400) / 2 } };
  const raw = layoutLayered(request, { channelStyle });
  const layout = channelStyle === "orthogonal" ? withPaneBandBounds(raw, "root", maxWidth) : withBandBounds(raw, "root");
  const extent = bandExtent(layout, "root");
  const length = layout.routes.filter(r => r.from.id !== "root").reduce((sum, r) => sum + routePlan(r).length, 0);
  return { request, height: extent.height, width: extent.width, length };
}

function randomGraph(seed: number, n: number, shape: "tree" | "dag", mixed: boolean): LayoutItem[] {
  const random = rng(seed), items = [item("root")];
  for (let i = 1; i < n; i++) {
    const parents = new Set([items[Math.floor(random() * i)].key]);
    if (shape === "dag" && random() < .4) parents.add(items[Math.floor(random() * i)].key);
    // Foreign and hinted tiles differ in height; mixed widths exercise the capacity bound.
    const height = mixed && random() < .4 ? 119 : 97, width = mixed && random() < .2 ? 140 : 92;
    items.push(item(`n${i}`, [...parents], i, width, height));
  }
  return items;
}

describe("downward band bound", () => {
  it.each(["scaled", "orthogonal"] as const)("never exceeds the %s layout's height, width or tree ink", channelStyle => {
    let checked = 0;
    for (const shape of ["tree", "dag"] as const) for (const mixed of [false, true]) for (let seed = 1; seed <= 12; seed++)
      for (const n of [2, 5, 13, 40]) for (const maxWidth of [128, 360, 454, 900, 1400]) {
        const items = randomGraph(seed * 7919 + n, n, shape, mixed), built = actual(items, maxWidth, channelStyle);
        const bound = downwardBandBound(built.request, "root", STACK_STEM_ROOM, { channelStyle });
        expect(bound, `${shape} ${seed} ${n} ${maxWidth}`).not.toBeNull();
        expect(bound!.height).toBeLessThanOrEqual(built.height);
        expect(bound!.width).toBeLessThanOrEqual(built.width);
        expect(bound!.length).toBeLessThanOrEqual(built.length);
        if (items.some(n => new Set(n.parents).size > 1)) expect(bound!.length).toBe(0);
        checked++;
      }
    expect(checked).toBe(960);
  });

  it("is tight where rows decide the height: a chain in a wide pane", () => {
    const chain = [item("root"), ...Array.from({ length: 6 }, (_, i) => item(`c${i}`, [i ? `c${i - 1}` : "root"], i + 1))];
    const built = actual(chain, 900);
    expect(downwardBandBound(built.request, "root", STACK_STEM_ROOM)!.height).toBeCloseTo(built.height, 4);
  });

  it("counts wrapped rows of a wide generation", () => {
    const fan = [item("root"), ...Array.from({ length: 30 }, (_, i) => item(`f${i}`, ["root"], i + 1))];
    const narrow = downwardBandBound(actual(fan, 360).request, "root", STACK_STEM_ROOM)!;
    const wide = downwardBandBound(actual(fan, 1400).request, "root", STACK_STEM_ROOM)!;
    expect(narrow.height).toBeGreaterThan(wide.height * 3);
    expect(narrow.width).toBeLessThanOrEqual(360);
  });

  it("declines when the cover's first child row is unknown or the input is malformed", () => {
    const request = (items: LayoutItem[]): LayoutRequest => ({ items, maxWidth: 454, tileWidth: 92 });
    // Cover alone, another root beside it, cover missing, cover not a root, a cycle, duplicate keys.
    expect(downwardBandBound(request([item("root")]), "root", STACK_STEM_ROOM)).toBeNull();
    expect(downwardBandBound(request([item("root"), item("other"), item("a", ["root"])]), "root", STACK_STEM_ROOM)).toBeNull();
    expect(downwardBandBound(request([item("a"), item("b", ["a"])]), "root", STACK_STEM_ROOM)).toBeNull();
    expect(downwardBandBound(request([item("a"), item("root", ["a"])]), "root", STACK_STEM_ROOM)).toBeNull();
    expect(downwardBandBound(request([item("root"), item("a", ["root", "b"]), item("b", ["a"])]), "root", STACK_STEM_ROOM)).toBeNull();
    expect(downwardBandBound(request([item("root"), item("a", ["root"]), item("a", ["root"])]), "root", STACK_STEM_ROOM)).toBeNull();
  });

  it("ignores unknown, duplicate and self parents like the layered engine", () => {
    const clean = downwardBandBound({ items: [item("root"), item("a", ["root"]), item("b", ["a"])], maxWidth: 454, tileWidth: 92 }, "root", STACK_STEM_ROOM);
    const noisy = downwardBandBound({ items: [item("root"), item("a", ["root", "root", "ghost"]), item("b", ["a", "b"])], maxWidth: 454, tileWidth: 92 }, "root", STACK_STEM_ROOM);
    expect(noisy).toEqual(clean);
  });
});
