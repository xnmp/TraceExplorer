import { expect, it } from "vitest";
import { pathTailAtY } from "$lib/domain/trace-graph/path-geometry";
import { samplePathString } from "$lib/plugins/trace/view/path-sampling";
it("cuts a straight stem without changing its tail or terminal approach", () => {
  expect(pathTailAtY("M10 0 L10 20 L30 20 L30 40", 10)).toEqual({ point: { x: 10, y: 10 }, tail: "L10 20 L 30 20 L 30 40" });
});
it("preserves the exact cubic tail and its arrow approach", () => {
  const path = "M10 0 C10 20 40 20 40 40 L40 48";
  const { point, tail } = pathTailAtY(path, 20);
  expect(point.x).toBeCloseTo(25, 8); expect(point.y).toBeCloseTo(20, 8);
  const samples = samplePathString(`M${point.x} ${point.y} ${tail}`, 100)!;
  expect(samples[0]).toEqual(point); expect(samples.at(-1)).toEqual({ x: 40, y: 48 });
  expect(tail).toMatch(/L 40 48$/);
});
