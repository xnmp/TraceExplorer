/** Pure connection selection and advertised capability rules. No secrets or IO. */
import type { ImageDescription } from "../../../../integration/services/image-generation-v1";
import type { ImageServiceAvailability, OpenAIImageRequest } from "$lib/api/openai-image";
export type ImageConnection = ImageDescription["profiles"][number];
export type CodexConnection = Extract<ImageConnection, { transport: "codex-cli" }>;
export type ApiConnection = Exclude<ImageConnection, CodexConnection>;
/** Narrowing guards: `transport` is a plain string for API backends, so `===` alone cannot narrow. */
export function isCodexConnection(profile: ImageConnection): profile is CodexConnection { return profile.transport === "codex-cli"; }
export function isApiConnection(profile: ImageConnection): profile is ApiConnection { return profile.transport !== "codex-cli"; }
/** Known backends get a friendly name; any other transport is shown as its id. */
export function transportLabel(transport: string): string {
  return transport === "codex-cli" ? "Codex" : transport === "openai-images" ? "Images API" : transport;
}

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
    model: isCodexConnection(profile) ? null : override.trim() || profile.defaultModel };
}
/** Names/default choice do not reroute an existing draft; execution changes do require review. */
export function connectionNeedsReview(pinned: ImageConnection, latest: ImageConnection, pinnedProvider?: string, currentProvider?: string): boolean {
  return pinned.recipeRevision !== latest.recipeRevision || pinned.transport !== latest.transport
    || pinnedProvider !== currentProvider || JSON.stringify(pinned.capabilities) !== JSON.stringify(latest.capabilities);
}
/** Keeps `current` if offered, else `preferred` if offered, else the first offered value. No list means anything goes. */
export function fallbackOption<T extends string>(current: T, preferred: T, offered: readonly T[] | undefined): T {
  if (!offered || offered.includes(current)) return current;
  return offered.includes(preferred) ? preferred : offered[0] ?? preferred;
}
/** Which image controls a connection offers. Pixel sizes are chosen through Resolution and Aspect ratio. */
export function offeredOptions(profile: ImageConnection | null | undefined): { resolution: boolean; aspectRatio: boolean; quality: boolean; background: boolean } {
  const caps = profile?.capabilities;
  if (!caps) return { resolution: true, aspectRatio: true, quality: true, background: true };
  return { resolution: !!caps.sizes || !!caps.resolution?.length, aspectRatio: !!caps.sizes || !!caps.aspectRatio?.length,
    quality: caps.quality.length > 0, background: caps.background.length > 0 };
}
export function capabilityProblem(profile: ImageConnection, request: Pick<OpenAIImageRequest, "model" | "size" | "quality" | "background"> & Partial<Pick<OpenAIImageRequest, "resolution" | "aspectRatio">>, inputCount: number): string | null {
  const caps = profile.capabilities;
  if (!(inputCount ? caps.edit : caps.generation)) return `This connection does not support ${inputCount ? "editing" : "generation"}. Choose another connection.`;
  if (inputCount > caps.maxInputs) return `This connection supports at most ${caps.maxInputs} input images.`;
  if (isApiConnection(profile) && (!request.model?.trim() || Array.from(request.model).length > 256 || /\p{Cc}/u.test(request.model))) return "Enter an image model ID of 1–256 characters.";
  if (!caps.quality.includes(request.quality) || !caps.background.includes(request.background)) return "These image options are unavailable on the selected connection.";
  if (request.resolution !== undefined && caps.resolution && !caps.resolution.includes(request.resolution)) return "This resolution is unavailable on the selected connection.";
  if (request.aspectRatio !== undefined && caps.aspectRatio && !caps.aspectRatio.includes(request.aspectRatio)) return "This aspect ratio is unavailable on the selected connection.";
  const sizes: unknown = caps.sizes;
  if (sizes === undefined) {
    if (request.size !== "auto") return "This connection chooses its own image size.";
  } else if (Array.isArray(sizes)) {
    if (!sizes.includes(request.size)) return "This image size is unavailable on the selected connection.";
  } else if (sizes && typeof sizes === "object") {
    const range = sizes as { auto?: boolean; maxEdge?: number; multipleOf?: number; minPixels?: number; maxPixels?: number };
    const [w, h] = request.size.split("x").map(Number);
    if (request.size === "auto" ? !range.auto : !/^\d{1,4}x\d{1,4}$/.test(request.size) || ![w, h].every((n) => Number.isInteger(n) && n > 0 && n <= (range.maxEdge ?? 0) && n % (range.multipleOf ?? 0) === 0) || w * h < (range.minPixels ?? Infinity) || w * h > (range.maxPixels ?? 0) || w > h * 3 || h > w * 3) return "This image size is unavailable on the selected connection.";
  } else return "The connection has no supported image sizes. Reload connections.";
  return null;
}
