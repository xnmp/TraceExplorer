import { host } from "../../sdk";
export const getThumbnailData = (path: string, size?: number) => host().thumbnailData(path, size);
