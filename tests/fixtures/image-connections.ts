import type { ImageServiceAvailability } from "$lib/api/openai-image";
export const imageAvailability = (): ImageServiceAvailability => ({ version: 1, available: true, providerDigest: "d".repeat(64), description: {
  version: 1, configurationRevision: 1, defaultConnectionId: "saved-login", profiles: [
    { id: "saved-login", name: "Saved Codex login", recipeRevision: "cli-revision", transport: "codex-cli", executablePath: "", modelSelection: false, credential: { kind: "cli_saved_login" }, capabilities: capabilities(true) },
    { id: "custom-http", name: "Custom images", recipeRevision: "http-revision", transport: "openai-images", baseUrl: "https://fixture.test/images", defaultModel: "vendor-image-v9", allowInsecureHttp: false, credential: { kind: "none" }, capabilities: capabilities(false) },
  ],
} });
function capabilities(cli: boolean) { return {
  generation: true, edit: true, maxInputs: 8, maxInputBytes: 20 * 1024 * 1024, maxTotalInputBytes: 64 * 1024 * 1024, maxOutputBytes: 50 * 1024 * 1024,
  inputFormats: ["image/png", "image/jpeg", "image/webp"], outputFormats: ["image/png"], modelSelection: !cli,
  sizes: { auto: true, maxEdge: 3840, multipleOf: 16, minPixels: 655360, maxPixels: 8294400 },
  quality: cli ? ["auto"] : ["auto", "low", "medium", "high"], background: cli ? ["auto"] : ["auto", "opaque", "transparent"],
}; }
