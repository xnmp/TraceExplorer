import { describe, expect, it } from "vitest";
import { imageOutputFilename } from "$lib/domain/image-output-filename";
describe("automatic image output names", () => {
  it("preserves the parent name in human-readable PNG output names", () => {
    expect(imageOutputFilename("photo.jpg")).toBe("photo_edit.png");
    expect(imageOutputFilename("photo_edit.png")).toBe("photo_edit_edit.png");
    expect(imageOutputFilename(".image.png")).toBe(".image_edit.png");
    expect(imageOutputFilename(".png")).toBe(".png_edit.png");
    expect(imageOutputFilename(null)).toBe("generated.png");
  });
  it("bounds Unicode names without accepting a path as a filename", () => {
    const name = imageOutputFilename("猫".repeat(300) + ".png");
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(".png")).toBe(true);
    expect(() => imageOutputFilename("../photo.png")).toThrow();
    expect(() => imageOutputFilename("folder\\photo.png")).toThrow();
    expect(() => imageOutputFilename("photo\0.png")).toThrow();
  });
});
