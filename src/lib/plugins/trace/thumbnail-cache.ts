import { getThumbnailData } from "$lib/api/thumbnails";
import { createThumbnailCache } from "$lib/domain/thumbnail-cache";
import { boundedDecode } from "./image-decode";

/**
 * Decodes an image before it is published, and keeps it alive with its URL. An `<img>` for the
 * same URL in this document then draws on its first frame: the image is in the document's list of
 * available images, already decoded. A decode that does not settle is bounded (`image-decode.ts`).
 */
function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  return typeof image.decode === "function" ? boundedDecode(image) : Promise.resolve(image);
}

export const traceThumbnails = createThumbnailCache(
  (path) => getThumbnailData(path, 256),
  (url) => URL.revokeObjectURL(url),
  64,
  typeof Image === "function" ? decodeImage : undefined,
);
