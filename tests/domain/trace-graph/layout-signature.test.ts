/**
 * The band request contracts the folder engine's band cache and inline rule rely on: the exact
 * request signature (`layoutSignature`) and Phase 2's inline workload rule (`canLayoutInline`).
 */
import { describe, expect, it } from "vitest";
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { layoutSignature } from "$lib/domain/trace-graph/layout-signature";
import { canLayoutInline } from "$lib/domain/trace-graph/layout-workload";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";

const request = (n = 0, width = 800): LayoutRequest => ({
  maxWidth: width,
  items: [
    { key: `a${n}`, width: 100, height: 60, order: 0, parents: [] },
    { key: `b${n}`, width: 100, height: 60, order: 1, parents: [`a${n}`] },
  ],
});

describe("layout request signature", () => {
  it("treats widths the engine rounds alike as one request, and others as distinct", () => {
    expect(layoutSignature(request(0, 811.2))).toBe(layoutSignature(request(0, 811.9)));
    expect(layoutSignature(request(0, 811.6))).not.toBe(layoutSignature(request(0, 812.4)));
  });

  it("distinguishes pinned positions, obstacles and tile sizes", () => {
    const at = (x: number, obstacles: readonly { x: number; width: number }[] = []): LayoutRequest => ({ ...request(), pinned: { key: "a0", x, obstacles } });
    expect(layoutSignature(at(100))).not.toBe(layoutSignature(at(650)));
    expect(layoutSignature(at(100))).not.toBe(layoutSignature(at(100, [{ x: 200, width: 100 }])));
    expect(layoutSignature({ ...request(), tileWidth: 92 })).not.toBe(layoutSignature({ ...request(), tileWidth: 172 }));
  });

  it("keys exact band widths and both committed embeddings", () => {
    const base = { ...request(), maxWidth: 454.1, pinned: { key: "a0", x: 300 }, band: { key: "a0", items: request().items } };
    const layout = layoutGraph(base), placed = attachSingleBand(layout, base);
    const next = { ...base, anchorKey: "b0", history: { signature: bandHistorySignature(base), layout, placed } };
    expect(layoutSignature(next)).not.toBe(layoutSignature({ ...next, maxWidth: 454.9 }));
    expect(layoutSignature({ ...next, maxWidth: 100001 })).not.toBe(layoutSignature({ ...next, maxWidth: 100002 }));
    expect(layoutSignature({ ...next, maxWidth: 0 })).not.toBe(layoutSignature({ ...next, maxWidth: -1 }));
    const translated = { ...placed, nodes: new Map([...placed.nodes].map(([id, n]) => [id, { ...n, x: n.x + 1 }])) };
    expect(layoutSignature(next)).not.toBe(layoutSignature({ ...next, history: { ...next.history, placed: translated } }));
  });
});

describe("inline workload rule", () => {
  const base = { ...request(), maxWidth: 454.1, pinned: { key: "a0", x: 300 }, band: { key: "a0", items: request().items } };
  it("counts visible items, inputs and committed history, not hidden band members", () => {
    const layout = layoutGraph(base), placed = attachSingleBand(layout, base);
    const next = { ...base, anchorKey: "b0", history: { signature: bandHistorySignature(base), layout, placed } };
    expect(canLayoutInline(base)).toBe(true);
    expect(canLayoutInline({ ...base, band: { key: "a0", items: Array.from({ length: 200 }, (_, i) => ({ ...base.items[0], key: `hidden${i}` })) } })).toBe(true);
    expect(canLayoutInline({ ...base, items: Array.from({ length: 31 }, (_, i) => ({ ...base.items[0], key: `visible${i}` })) })).toBe(false);
    expect(canLayoutInline({ ...base, items: base.items.map((n) => ({ ...n, parents: Array(30).fill("a0") })) })).toBe(false);
    const largeHistory = { ...layout, nodes: new Map(Array.from({ length: 29 }, (_, i) => [`old${i}`, { ...layout.nodes.get("a0")!, key: `old${i}` }])) };
    expect(canLayoutInline({ ...next, history: { ...next.history, layout: largeHistory } })).toBe(false);
    const denseHistory = { ...layout, routes: Array(40).fill(layout.routes[0]) };
    expect(canLayoutInline({ ...next, history: { ...next.history, layout: denseHistory } })).toBe(false);
  });
});
