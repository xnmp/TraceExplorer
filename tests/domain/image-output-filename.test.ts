import { describe, expect, it } from "vitest";
import { imageOutputFilename } from "$lib/domain/image-output-filename";
const identity = "01234567-89ab-4cde-8f01-23456789abcd";
describe("automatic image output names", () => {
  it("preserves the source name and makes concurrent jobs distinct", () => {
    const first = imageOutputFilename("photo.jpg", identity);
    expect(first).toBe(`photo_edit_${identity}.png`);
    expect(imageOutputFilename("photo.jpg", "11234567-89ab-4cde-8f01-23456789abcd")).not.toBe(first);
    expect(imageOutputFilename(null, identity)).toBe(`image_generated_${identity}.png`);
  });
  it("bounds long Unicode names and rejects invalid job identities", () => {
    const name = imageOutputFilename("猫".repeat(300) + ".png", identity);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(".png")).toBe(true);
    expect(() => imageOutputFilename("photo.png", "../escape")).toThrow();
  });
});
