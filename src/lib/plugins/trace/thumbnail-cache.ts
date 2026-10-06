import { getThumbnailData } from "$lib/api/thumbnails";
import { createThumbnailCache } from "$lib/domain/thumbnail-cache";

export const traceThumbnails = createThumbnailCache(
  (path) => getThumbnailData(path, 256),
  (url) => URL.revokeObjectURL(url),
);
