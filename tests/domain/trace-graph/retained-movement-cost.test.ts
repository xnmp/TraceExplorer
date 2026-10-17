import { expect, it } from "vitest";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { geometryGate } from "$lib/domain/trace-graph/geometry-gate";
import { corpus, requestFor } from "../../../layout-eval/corpus";

it.each([
  ["random-tree-100-8002", "n33"],
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
