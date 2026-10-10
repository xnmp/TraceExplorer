import { describe, it, expect } from "vitest";
import { imageAvailability } from "../fixtures/image-connections";
import { availabilityProblem, capabilityProblem, connectionFields, connectionFor, connectionNeedsReview } from "$lib/plugins/openai-image/connections";
import { describeImageService, validImageAvailability } from "$lib/api/openai-image";
import { configureBackend } from "$lib/api/common";

describe("shared image connection policy", () => {
  it("reports unsupported hosts without invoking any paid fallback", async () => {
    const called: string[] = [];
    configureBackend({ async invoke(method) { called.push(method); throw new Error("Unknown method image_service_describe"); } });
    expect(await describeImageService()).toMatchObject({ ok: false, error: expect.stringContaining("updated host") });
    expect(called).toEqual(["image_service_describe"]);
  });
  it("uses an explicit profile or declared default, never inventing a choice", () => {
    const description = imageAvailability().description!;
    expect(connectionFor(description)?.id).toBe("saved-login");
    expect(connectionFor(description, "custom-http")?.id).toBe("custom-http");
    expect(connectionFor(description, "removed")).toBeNull();
    expect(connectionFor({ ...description, defaultConnectionId: null })).toBeNull();
  });
  it("pins the current revision, uses arbitrary HTTP IDs and represents the CLI model as null", () => {
    const [cli, http] = imageAvailability().description!.profiles;
    expect(connectionFields(cli, "never-use-this")).toEqual({ connectionId: "saved-login", expectedConnectionRevision: "cli-revision", model: null });
    expect(connectionFields(http, "vendor/custom-model-42").model).toBe("vendor/custom-model-42");
    expect(connectionFields(http).model).toBe("vendor-image-v9");
  });
  it("keeps renames usable but requires review for execution/capability/provider changes", () => {
    const profile = imageAvailability().description!.profiles[1];
    expect(connectionNeedsReview(profile, { ...profile, name: "Renamed only" }, "provider", "provider")).toBe(false);
    expect(connectionNeedsReview(profile, { ...profile, recipeRevision: "new-recipe" }, "provider", "provider")).toBe(true);
    expect(connectionNeedsReview(profile, profile, "old-provider", "new-provider")).toBe(true);
    expect(connectionNeedsReview(profile, { ...profile, capabilities: { ...profile.capabilities, maxInputs: 1 } })).toBe(true);
  });
  it("refuses unsupported advertised operations, options and sizes before paid submission", () => {
    const [cli, http] = imageAvailability().description!.profiles;
    const request = { model: "custom-image", size: "1024x1024", quality: "high", background: "transparent" } as const;
    expect(capabilityProblem(http, request, 8)).toBeNull();
    expect(capabilityProblem(cli, request, 1)).toContain("options");
    expect(capabilityProblem(http, request, 9)).toContain("8");
    expect(capabilityProblem(http, { ...request, size: "99999x16" }, 0)).toContain("size");
    expect(capabilityProblem(http, { ...request, size: "1024x1024x1" }, 0)).toContain("size");
    expect(capabilityProblem(http, { ...request, model: "custom\u0085model" }, 0)).toContain("model");
    expect(capabilityProblem(http, { ...request, model: "x".repeat(257) }, 0)).toContain("model");
    expect(capabilityProblem({ ...http, capabilities: { ...http.capabilities, edit: false } }, request, 1)).toContain("editing");
  });
  it("preserves actionable package/host reasons and distinguishes unconfigured profiles", () => {
    expect(availabilityProblem({ version: 1, available: false, reason: { code: "disabled", message: "Enable the Image Generation package in Plugins." } })).toContain("package");
    expect(availabilityProblem({ ...imageAvailability(), description: { ...imageAvailability().description!, profiles: [], defaultConnectionId: null } })).toContain("No image connections");
  });
  it("rejects malformed descriptions before they enable generation", () => {
    expect(validImageAvailability(imageAvailability())).toBe(true);
    for (const mutate of [
      (d: any) => { d.description.profiles = {}; },
      (d: any) => { d.description.profiles[0].capabilities.quality = ["made-up"]; },
      (d: any) => { d.description.profiles[0].capabilities.sizes.multipleOf = 0; },
      (d: any) => { d.description.profiles[1].id = d.description.profiles[0].id; },
      (d: any) => { d.description.configurationRevision = -1; },
      (d: any) => { d.available = false; d.description.profiles = {}; },
      (d: any) => { d.description.profiles[0].capabilities.maxOutputBytes = Infinity; },
    ]) {
      const value = imageAvailability(); mutate(value);
      expect(validImageAvailability(value)).toBe(false);
    }
  });
});
