import { expect, it } from "vitest";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { geometryGate } from "$lib/domain/trace-graph/geometry-gate";
import { corpus, requestFor } from "../../../layout-eval/corpus";
import { optimizedBand, type Optimized } from "../../../layout-eval/engine";

it.each([
  ["random-tree-100-8002", "n33"],
  ["random-tree-40-7402", "n13"],
  ["hidden-siblings", "p0"],
] as const)("retains familiar tiles when opening %s has a compact safe insertion", (id, focus) => {
  const fixture = corpus().find(c => c.id === id)!;
  const beforeRequest = requestFor(fixture, null, 454, 96);
  const before = layoutGraph(beforeRequest);
  const previous = attachSingleBand(before, beforeRequest);
  const request = requestFor(fixture, focus, 454, 96);
  const next = attachSingleBand(layoutGraph({ ...request, anchorKey: focus,
    hint: before.readingOrder,
    history: { signature: bandHistorySignature(beforeRequest), layout: before, placed: previous },
  }), request);

  expect(next.nodes.size).toBeGreaterThan(previous.nodes.size);
  expect(geometryGate(next, request.items, "root", 454)).toBeNull();
  expect(next.height).toBeLessThanOrEqual(attachSingleBand(layoutGraph(request), request).height * 1.1);
  for (const [key, node] of previous.nodes) {
    expect(next.nodes.get(key), key).toMatchObject({ x: node.x, y: node.y, width: node.width, height: node.height });
  }
});

it("avoids moving retained siblings several screens to save a short tail of height", () => {
  const fixture = { ...corpus().find(c => c.id === "random-bushy-200-9201")!, full: false };
  let previous: Optimized | undefined;
  let focus: string | null = null;
  const visited = new Set<string>();
  for (let step = 0; step <= 7; step++) {
    const request = requestFor(fixture, focus, 1400, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, "root", 1400)).toBeNull();
    if (step === 7) {
      expect(focus).toBe("n7");
      const distances = [...next.placed.nodes].flatMap(([key, node]) => {
        const old = key !== "root" && previous?.placed.nodes.get(key);
        return old ? [Math.hypot(node.x - old.x, node.y - old.y)] : [];
      });
      expect(distances.length).toBeGreaterThan(0);
      expect(distances.reduce((sum, value) => sum + value, 0) / distances.length).toBeLessThanOrEqual(request.tileWidth!);
    }
    previous = next;
    const selected = request.items.filter(n => !visited.has(n.key) && request.band!.items.some(child => child.parents.includes(n.key)))
      .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
    focus = selected?.key ?? null;
    if (focus) visited.add(focus);
  }
}, 15_000);
