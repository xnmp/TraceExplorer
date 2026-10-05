/** A unique job identity avoids collisions with outputs still being generated. */
export function imageOutputFilename(sourceName: string | null, jobIdentity: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobIdentity)) {
    throw new Error("Invalid image job identity");
  }
  const stem = sourceName ? sourceName.replace(/\.[^.]+$/, "") : "image";
  // Leave room for the suffix within common filesystems' 255-byte name limit.
  const encoder = new TextEncoder();
  const prefix = [...stem].reduce((name, character) =>
    encoder.encode(name + character).length <= 180 ? name + character : name, "");
  return `${prefix || "image"}_${sourceName ? "edit" : "generated"}_${jobIdentity}.png`;
}
