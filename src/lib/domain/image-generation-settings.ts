export type ImageResolution = "1k" | "2k" | "4k";
export type ImageAspectRatio = "keep" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16";

/** Provider dimensions are multiples of 16, with an aspect ratio at most 3:1. */
export function imageGenerationSize(
  resolution: ImageResolution,
  aspectRatio: ImageAspectRatio,
  source?: { readonly width: number; readonly height: number },
): string {
  const [width, height] = aspectRatio === "keep"
    ? [source?.width ?? 1, source?.height ?? 1]
    : aspectRatio.split(":").map(Number);
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Cannot determine the source image's aspect ratio");
  }
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) {
    throw new Error("Choose an aspect ratio between 1:3 and 3:1");
  }
  const edge = { "1k": 1024, "2k": 2048, "4k": 3840 }[resolution];
  let w = ratio >= 1 ? edge : edge * ratio;
  let h = ratio >= 1 ? edge / ratio : edge;
  const scale = Math.min(1, Math.sqrt(8_294_400 / (w * h)));
  w = Math.floor(w * scale / 16) * 16;
  h = Math.floor(h * scale / 16) * 16;
  if (w > h * 3) h = Math.ceil(w / 3 / 16) * 16;
  if (h > w * 3) w = Math.ceil(h / 3 / 16) * 16;
  // Narrow 1K ratios otherwise fall below the provider's minimum pixel count.
  while (w * h < 655_360) {
    if (ratio >= 1) { w += 16; h = Math.round(w / ratio / 16) * 16; }
    else { h += 16; w = Math.round(h * ratio / 16) * 16; }
  }
  return `${w}x${h}`;
}
