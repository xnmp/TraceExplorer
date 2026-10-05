import { describe, expect, it } from "vitest";
import { imageGenerationSize, type ImageAspectRatio, type ImageResolution } from "$lib/domain/image-generation-settings";

describe("image generation dimensions", () => {
  it("keeps the source proportions at the default 2K resolution", () => {
    expect(imageGenerationSize("2k", "keep", { width: 512, height: 384 })).toBe("2048x1536");
    expect(imageGenerationSize("2k", "keep", { width: 384, height: 512 })).toBe("1536x2048");
    expect(imageGenerationSize("2k", "keep")).toBe("2048x2048");
  });
  it("honors explicit proportions and bounds every preset to the provider's contract", () => {
    for (const resolution of ["1k", "2k", "4k"] as ImageResolution[]) {
      for (const aspect of ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as ImageAspectRatio[]) {
        const [w, h] = imageGenerationSize(resolution, aspect).split("x").map(Number);
        expect(w % 16).toBe(0); expect(h % 16).toBe(0);
        expect(w * h).toBeGreaterThanOrEqual(655_360);
        expect(w * h).toBeLessThanOrEqual(8_294_400);
        expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
        const [a, b] = aspect.split(":").map(Number);
        expect(Math.abs(w / h - a / b)).toBeLessThan(0.025);
      }
    }
  });
  it("rejects malformed source sizes and ratios the provider cannot preserve", () => {
    for (const source of [{ width: 0, height: 2 }, { width: NaN, height: 1 }, { width: Infinity, height: 1 }, { width: 10000, height: 1 }]) {
      expect(() => imageGenerationSize("2k", "keep", source)).toThrow();
    }
    const [w, h] = imageGenerationSize("1k", "keep", { width: 3, height: 1 }).split("x").map(Number);
    expect(w / h).toBeLessThanOrEqual(3);
    expect(w * h).toBeGreaterThanOrEqual(655_360);
  });
});
