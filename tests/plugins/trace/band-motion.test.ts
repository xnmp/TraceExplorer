import { expect, it } from "vitest";
import { bandTravel, planBandTravel, remainingTravel, travelFrames } from "$lib/plugins/trace/view/band-motion";
it("follows a routed bend and reverses the same displayed travel on closing", () => {
  const cover = { x: 0, y: 0, width: 20, height: 20 }, tile = { x: 100, y: 100, width: 20, height: 20 };
  const points = bandTravel([{ from: "node:cover", to: "node:child", path: "M10 20 L10 60 L110 60 L110 100" }], "cover", "child", cover, tile);
  expect(points[0]).toEqual({ x: 0, y: 0 }); expect(points.at(-1)).toEqual({ x: 100, y: 100 });
  expect(points.some(({ x, y }) => x === 0 && y > 20)).toBe(true);
  const opening = travelFrames(points, tile), closing = travelFrames(points, tile, true);
  expect(opening[0].transform).toBe("translate(-100px, -100px)"); expect(opening.at(-1)!.transform).toBe("translate(0px, 0px)");
  expect(closing.map((frame) => frame.transform)).toEqual(opening.map((frame) => frame.transform).reverse());
  expect(closing.at(-1)!.opacity).toBe(0);
});
it("uses a bounded direct path for a root without connectors and tolerates malformed paths", () => {
  const cover = { x: 0, y: 0, width: 20, height: 20 }, tile = { ...cover, x: 50, y: 100 };
  expect(bandTravel([{ from: "node:a", to: "node:b", path: "broken" }], "cover", "b", cover, tile)).toEqual([{ x: 0, y: 0 }, { x: 50, y: 100 }]);
  expect(travelFrames([{ x: 0, y: 0 }, { x: 0, y: 0 }], { x: 0, y: 0 }).map((frame) => frame.offset)).toEqual([0, 1]);
});
it("closing midway retraces only the displayed route prefix without travelling farther outward", () => {
  const cover = { x: 0, y: 0, width: 20, height: 20 }, tile = { ...cover, x: 100, y: 100 };
  const points = bandTravel([{ from: "node:cover", to: "node:child", path: "M10 20 L10 60 L110 60 L110 100" }], "cover", "child", cover, tile, { x: 40, y: 50 });
  expect(points.at(-1)).toEqual({ x: 40, y: 50 });
  expect(points.every(({ x, y }) => x <= 40 && y <= 50)).toBe(true);
  const closing = travelFrames(points, tile, true);
  expect(closing[0].transform).toBe("translate(-60px, -50px)");
  expect(closing.at(-1)!.transform).toBe("translate(-100px, -100px)");
});
it("bounds motion work for a 6,000-link chain, and tolerates a cycle", () => {
  const routes = Array.from({ length: 6_000 }, (_, index) => ({ from: `node:${index}`, to: `node:${index + 1}`, path: `M10 ${index * 40 + 20} L10 ${(index + 1) * 40}` }));
  const start = performance.now();
  const travel = planBandTravel([...routes, { from: "node:6000", to: "node:0", path: "M10 240000 L10 0" }], "0");
  const cover = { x: 0, y: 0, width: 20, height: 20 };
  for (let index = 1; index <= 6_000; index++) {
    const points = travel(`${index}`, cover, { ...cover, y: index * 40 });
    expect(points.length).toBeLessThanOrEqual(51);
    expect(points.at(-1)).toEqual({ x: 0, y: index * 40 });
  }
  // A generous ceiling catches accidental quadratic traversal, rather than frame timing noise.
  expect(performance.now() - start).toBeLessThan(2_000);
});
it("continues emergence from displayed progress along the remaining routed bends", () => {
  const remaining = remainingTravel([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }], { x: 40, y: 50 });
  expect(remaining[0]).toEqual({ x: 40, y: 50 });
  expect(remaining.every(({ x, y }) => x >= 40 && y >= 50)).toBe(true);
  expect(remaining).toContainEqual({ x: 100, y: 50 });
  expect(remaining.at(-1)).toEqual({ x: 100, y: 100 });
});
