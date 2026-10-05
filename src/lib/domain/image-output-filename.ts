/** Names are human-readable; per-generation native folders isolate jobs. */
export function imageOutputFilename(sourceName: string | null): string {
  if(!sourceName)return "generated.png";
  if(sourceName.includes("/")||sourceName.includes("\\")||sourceName.includes("\0"))throw new Error("Invalid source filename");
  const dot=sourceName.lastIndexOf(".");
  const stem = dot>0 ? sourceName.slice(0,dot) : sourceName;
  // Leave room for the suffix within common filesystems' 255-byte name limit.
  const encoder = new TextEncoder();
  let prefix="";
  for(const character of stem){if(encoder.encode(prefix+character).length>180)break;prefix+=character;}
  return `${prefix || "image"}_edit.png`;
}
