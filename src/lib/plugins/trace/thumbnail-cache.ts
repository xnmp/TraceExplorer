import { getThumbnailData } from "$lib/api/thumbnails";
import { createThumbnailCache } from "$lib/domain/thumbnail-cache";

/**
 * Decodes an image before it is published, and keeps it alive with its URL. An `<img>` for the
 * same URL in this document then draws on its first frame: the image is in the document's list of
 * available images, already decoded.
 */
function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  return typeof image.decode === "function" ? image.decode().then(() => image) : Promise.resolve(image);
}

export const traceThumbnails = createThumbnailCache(
  (path) => getThumbnailData(path, 256),
  (url) => URL.revokeObjectURL(url),
  64,
  typeof Image === "function" ? decodeImage : undefined,
);
