import type { FileEntry } from "./file";
export const isImageFile = (entry: FileEntry) => entry.kind === "file" && /\.(jpe?g|png|gif|bmp|webp|avif|ico|icns)$/i.test(entry.name);
export const isSvgFile = (entry: FileEntry) => entry.kind === "file" && /\.svg$/i.test(entry.name);
