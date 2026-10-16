import { describe, expect, it } from "vitest";
import { layoutGraph, type BandHistory, type GraphLayout, type LayoutRequest, type PlacedRoute } from "$lib/domain/trace-graph/layout";
import { attachSingleBand, roundedStem } from "$lib/domain/trace-graph/band-geometry";
import { bandHistorySignature, fallbackReason } from "$lib/domain/trace-graph/band-layout";
import { buildShelves, columnsFor, partitions } from "$lib/domain/trace-graph/band-shelves";
import { cost, measure, sharedLaneLength } from "$lib/domain/trace-graph/layout-quality";
import { spacingFor } from "$lib/domain/trace-graph/metrics";
import { corpus, node, requestFor, screenshot } from "../../../layout-eval/corpus";
import { optimizedBand, type Optimized } from "../../../layout-eval/engine";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";
import narrowPane from "./narrow-pane-request.json";

describe("downward bound at a pane width that is not a multiple of 32", () => {
  it("bounds the downward layout at the band's own width budget, so it is not pruned", () => {
    // 276 px panes lay the downward candidate out at 256 px; a bound at 276 px assumed wider
    // rows and pruned it, although it scores best.
    const request = { ...narrowPane, band: { ...narrowPane.band, items: narrowPane.band.items } } as unknown as LayoutRequest;
    const layout = layoutGraph(request);
    expect(layout.decision?.candidate).toBe("visible-down");
    expect(layout.orientation).toBe("down");
  });
});

describe("rounded cover stems", () => {
  it("never writes NaN for a stem that doubles back on itself", () => {
    for (const points of [
      [{ x: 382, y: 128 }, { x: 382, y: 146 }, { x: 382, y: 140 }, { x: 382, y: 146 }, { x: 300, y: 146 }, { x: 300, y: 200 }],
      [{ x: 10, y: 0 }, { x: 10, y: 20 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }],
    ]) {
      const d = roundedStem(points);
      expect(d, JSON.stringify(points)).not.toContain("NaN");
      expect(pathNumbers(d).every(Number.isFinite)).toBe(true);
      // It still starts and ends where it was asked to.
      const numbers = pathNumbers(d);
      expect(numbers.slice(0, 2)).toEqual([points[0].x, points[0].y]);
      expect(numbers.slice(-2)).toEqual([points.at(-1)!.x, points.at(-1)!.y]);
    }
  });
  it("keeps ordinary stems unchanged: rounded corners on an L-shaped run", () => {
    expect(roundedStem([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }])).toMatch(/^M0 0 L0 14 C/);
  });
});

describe("lane-infeasible requests without history", () => {
  // Every candidate for this small DAG shares a lane between two sources: the engine must show
  // the best of them with its lanes priced, flagged lane-infeasible, not the raw downward
  // layout flagged as malformed input.
  // (Found by a seeded search; the earlier 7-node fixture gained a lane-free layout once routes
  // passed rows along their straight lines, the 10-node one after it once a cycle of turn
  // orders took a dogleg, and the 6-node one after that once routes passed rows in the slots
  // crossing fewest. Of 40,000 seeded DAGs of 6 to 12 tiles, two are still lane-infeasible.)
  const nodes = [node("root"), node("n1", ["root"], 1), node("n2", ["n1"], 2), node("n3", ["n2"], 3), node("n4", ["n2"], 4), node("n5", ["root"], 5),
    node("n6", ["root", "n5", "n4"], 6), node("n7", ["n3", "n5", "n6", "root"], 7), node("n8", ["n2"], 8), node("n9", ["n8"], 9), node("n10", ["n5", "n4", "n3"], 10)];
  const request = requestFor({ id: "lane-infeasible", nodes, focuses: [null] }, null, 900, 96);

  it("shows the best priced candidate, flagged lane-infeasible", () => {
    const layout = layoutGraph(request);
    expect(layout.decision?.fallback).toBe("lane-infeasible");
    const metrics = measure(attachSingleBand(layout, request), request.band!.key, 900, request.items);
    expect(metrics.sharedLanePx).toBeGreaterThan(0);
    const priced = (l: GraphLayout) => cost(measure(attachSingleBand(l, request), request.band!.key, 900, request.items), request.tileWidth!, { stability: 1.5, sharedLanes: "priced" });
    expect(Number.isFinite(priced(layout))).toBe(true);
    // No shelf candidate prices lower.
    const columns = columnsFor(request.items, request.band!.key, spacingFor(request.tileWidth).column);
    for (const ends of columns && columns.length >= 2 ? partitions(columns, request) : []) {
      const shelves = buildShelves(request, columns!, ends);
      if (shelves) expect(priced(layout)).toBeLessThanOrEqual(priced(shelves) + 1e-6);
    }
  });

  it("gives its reason from the layout: malformed only when the input is", () => {
    const layout = layoutGraph(request);
    expect(fallbackReason(layout)).toMatch(/^lane-infeasible/);
    const gated = { ...layout, decision: { ...layout.decision!, fallback: "gate-infeasible" as const } };
    expect(fallbackReason(gated)).not.toMatch(/malformed/);
    expect(fallbackReason({ ...gated, pinnedViolation: "cover has a visible parent" } as GraphLayout)).toMatch(/malformed/);
    expect(fallbackReason({ ...layout, decision: { ...layout.decision!, fallback: undefined } })).toBeNull();
  });
});

describe("crossing cap on anchored layouts", () => {
  // A bench reveal (random-dag-40-7502, 640 px, 128 px images): holding n26 still at step 2 costs a
  // crossings explosion. (The case was random-dag-100-8101 at 360 px until explicit expansion
  // changed the tours' visible sets, then this one at 454 px until routes passed rows in the
  // slots crossing fewest; this is the corpus step that yields now.)
  it("lets the anchors yield, flagged, when holding them still costs a crossings explosion", () => {
    const c = corpus().find(c => c.id === "random-dag-40-7502")!;
    let previous: Optimized | undefined, fresh = 0, layout: GraphLayout | undefined;
    const crossings = (l: GraphLayout, r: LayoutRequest) => measure(attachSingleBand(l, r), r.band!.key, 640, r.items).crossings;
    for (const focus of c.focuses.slice(0, 3)) {
      const request = requestFor(c, focus, 640, 128);
      previous = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
      layout = previous.layout;
      fresh = crossings(layoutGraph({ ...request, hint: layout.readingOrder }), request);
      if (focus === "n26") {
        expect(layout.decision?.fallback).toBe("anchor-yield");
        expect(layout.decision?.stability).toBe(false);
        expect(crossings(layout, request)).toBeLessThanOrEqual(fresh + Math.max(50, fresh * .25));
      }
    }
    expect(layout?.decision?.fallback).toBe("anchor-yield");
  });

  it("keeps anchors that cost few crossings", () => {
    const first = requestFor(screenshot, null, 454, 96), next = requestFor(screenshot, "Saffron", 454, 96);
    const previous = optimizedBand(first), layout = optimizedBand(next, { previous, anchorKey: "Saffron" }).layout;
    expect(layout.decision?.fallback).toBeUndefined();
  });
});

describe("malformed and oversized history", () => {
  const first = requestFor(screenshot, null, 600, 96), next = requestFor(screenshot, "Saffron", 600, 96);
  const base = layoutGraph(first), placed = attachSingleBand(base, first);
  const withFirstRoute = (f: (r: PlacedRoute) => unknown) => ({ signature: bandHistorySignature(first),
    layout: { ...base, routes: base.routes.map((r, i) => i ? r : f(r)) }, placed: { ...placed, routes: placed.routes.map((r, i) => i ? r : f(r)) } }) as unknown as BandHistory;

  it("treats a malformed route as no history, rather than throwing", () => {
    const plain = layoutGraph({ ...next, anchorKey: "Saffron" });
    for (const history of [withFirstRoute(r => ({ ...r, path: 42 })), withFirstRoute(r => ({ ...r, from: undefined })), withFirstRoute(r => ({ ...r, to: { id: "x" } })),
      { signature: bandHistorySignature(first), layout: { ...base, routes: null }, placed: { ...placed, routes: null } } as unknown as BandHistory])
      expect(layoutGraph({ ...next, anchorKey: "Saffron", history })).toEqual(plain);
  });

  it("lays out promptly when retained geometry spans a billion pixels", () => {
    const history = withFirstRoute(r => ({ ...r, path: "M 300 0 L 300 1000000000" }));
    const start = performance.now();
    const layout = layoutGraph({ ...next, anchorKey: "Saffron", history });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(layout.nodes.size).toBe(next.items.length);
  });
});

describe("unchanged requests", () => {
  it("measure the committed layout's shared lanes once, not on every request", () => {
    const c = corpus().find(c => c.id === "random-dag-200-9102")!, request = requestFor({ ...c, full: true }, null, 640, 48);
    const layout = layoutGraph(request), history = { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
    expect(layoutGraph({ ...request, history }).decision?.candidate).toBe("unchanged-visible");
    const fastest = (f: () => unknown) => { let best = Infinity; for (let i = 0; i < 5; i++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); } return best; };
    // Measuring a fresh copy's lanes is the work an unchanged request must not repeat.
    const measureOnce = fastest(() => sharedLaneLength({ ...layout }));
    const unchanged = fastest(() => layoutGraph({ ...request, history }));
    expect(unchanged).toBeLessThan(measureOnce * .5);
  });
});
