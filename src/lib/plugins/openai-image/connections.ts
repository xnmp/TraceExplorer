/** Pure connection selection and advertised capability rules. No secrets or IO. */
import type { ImageDescription } from "../../../../integration/services/image-generation-v1";
import type { ImageServiceAvailability, OpenAIImageRequest } from "$lib/api/openai-image";
export type ImageConnection = ImageDescription["profiles"][number];

export function connectionFor(description: ImageDescription | undefined, selected: string | null = null): ImageConnection | null {
  const id = selected === null ? description?.defaultConnectionId : selected;
  return description?.profiles.find((profile) => profile.id === id) ?? null;
}
export function availabilityProblem(value: ImageServiceAvailability | null): string | null {
  if (!value) return "Loading image connections…";
  if (!value.available) return value.reason?.message ?? "Image Generation is unavailable. Install and enable its package in Plugins.";
  if (!value.description) return "The image provider returned no connection description. Reload connections.";
  if (!value.description.profiles.length) return "No image connections are configured. Configure connections to add one.";
  return null;
}
export function connectionFields(profile: ImageConnection, override = ""): Pick<OpenAIImageRequest, "connectionId" | "expectedConnectionRevision" | "model"> {
  return { connectionId: profile.id, expectedConnectionRevision: profile.recipeRevision,
    model: profile.transport === "codex-cli" ? null : override.trim() || profile.defaultModel };
}
/** Names/default choice do not reroute an existing draft; execution changes do require review. */
export function connectionNeedsReview(pinned: ImageConnection, latest: ImageConnection, pinnedProvider?: string, currentProvider?: string): boolean {
  return pinned.recipeRevision !== latest.recipeRevision || pinned.transport !== latest.transport
    || pinnedProvider !== currentProvider || JSON.stringify(pinned.capabilities) !== JSON.stringify(latest.capabilities);
}
export function capabilityProblem(profile: ImageConnection, request: Pick<OpenAIImageRequest, "model" | "size" | "quality" | "background">, inputCount: number): string | null {
  const caps = profile.capabilities;
  if (!(inputCount ? caps.edit : caps.generation)) return `This connection does not support ${inputCount ? "editing" : "generation"}. Choose another connection.`;
  if (inputCount > caps.maxInputs) return `This connection supports at most ${caps.maxInputs} input images.`;
  if (profile.transport === "openai-images" && (!request.model?.trim() || Array.from(request.model).length > 256 || /\p{Cc}/u.test(request.model))) return "Enter an image model ID of 1–256 characters.";
  if (!caps.quality.includes(request.quality) || !caps.background.includes(request.background)) return "These image options are unavailable on the selected connection.";
  const sizes: unknown = caps.sizes;
  if (Array.isArray(sizes)) {
    if (!sizes.includes(request.size)) return "This image size is unavailable on the selected connection.";
  } else if (sizes && typeof sizes === "object") {
    const range = sizes as { auto?: boolean; maxEdge?: number; multipleOf?: number; minPixels?: number; maxPixels?: number };
    const [w, h] = request.size.split("x").map(Number);
    if (request.size === "auto" ? !range.auto : !/^\d{1,4}x\d{1,4}$/.test(request.size) || ![w, h].every((n) => Number.isInteger(n) && n > 0 && n <= (range.maxEdge ?? 0) && n % (range.multipleOf ?? 0) === 0) || w * h < (range.minPixels ?? Infinity) || w * h > (range.maxPixels ?? 0) || w > h * 3 || h > w * 3) return "This image size is unavailable on the selected connection.";
  } else return "The connection has no supported image sizes. Reload connections.";
  return null;
}
