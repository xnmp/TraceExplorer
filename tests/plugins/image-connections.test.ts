import { describe, it, expect } from "vitest";
import { imageAvailability } from "../fixtures/image-connections";
import { availabilityProblem, capabilityProblem, connectionFields, connectionFor, connectionNeedsReview, fallbackOption, offeredOptions, transportLabel } from "$lib/plugins/openai-image/connections";
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
  it("accepts any API transport with the shared API shape, and labels unknown ones by id", () => {
    const value = imageAvailability();
    value.description!.profiles = [...value.description!.profiles, { ...value.description!.profiles[1], id: "future", transport: "future-images" }];
    expect(validImageAvailability(value)).toBe(true);
    const future = value.description!.profiles[2];
    expect(connectionFields(future, "").model).toBe("vendor-image-v9");
    expect(capabilityProblem(future, { model: "", size: "1024x1024", quality: "auto", background: "auto" }, 0)).toContain("model ID");
    expect(transportLabel("future-images")).toBe("future-images");
    expect(transportLabel("openai-images")).toBe("Images API");
    for (const transport of ["Bad_Name", "", "9x", "a".repeat(65)]) {
      const bad = imageAvailability(); bad.description!.profiles[1] = { ...bad.description!.profiles[1], transport } as any;
      expect(validImageAvailability(bad), transport).toBe(false);
    }
    const noShape = imageAvailability(); delete (noShape.description!.profiles[1] as any).baseUrl;
    expect(validImageAvailability(noShape)).toBe(false);
    const wrongSelection = imageAvailability(); wrongSelection.description!.profiles.push({ ...wrongSelection.description!.profiles[1], id: "f2", transport: "future-images", capabilities: { ...wrongSelection.description!.profiles[1].capabilities, modelSelection: false } });
    expect(validImageAvailability(wrongSelection)).toBe(false);
  });
  describe("fallbackOption", () => {
    it("keeps an offered current value, else the preferred one, else the first offered", () => {
      expect(fallbackOption("2k", "1k", ["1k", "2k"])).toBe("2k");
      expect(fallbackOption("4k", "1k", ["1k", "2k"])).toBe("1k");
      expect(fallbackOption("keep", "1:1", ["16:9", "4:3"])).toBe("16:9");
      expect(fallbackOption("keep", "1:1", undefined)).toBe("keep");
      expect(fallbackOption("a", "b", [])).toBe("b");
    });
  });
  describe("a connection without pixel sizes", () => {
    const ratioOnly = () => {
      const value = imageAvailability();
      const { sizes: _sizes, ...caps } = value.description!.profiles[1].capabilities;
      const profile = { ...value.description!.profiles[1], id: "ratio", transport: "future-images", capabilities: { ...caps, resolution: ["1k", "2k"], aspectRatio: ["1:1", "16:9"] } };
      value.description!.profiles.push(profile as any);
      return { value, profile: profile as any };
    };
    it("is valid when it advertises resolution or aspect ratio, and not when it offers neither", () => {
      expect(validImageAvailability(ratioOnly().value)).toBe(true);
      const neither = ratioOnly(); delete neither.profile.capabilities.resolution; delete neither.profile.capabilities.aspectRatio;
      expect(validImageAvailability(neither.value)).toBe(false);
    });
    it("validates resolution and aspect-ratio lists whenever present", () => {
      for (const mutate of [(c: any) => { c.resolution = ["8k"]; }, (c: any) => { c.resolution = []; }, (c: any) => { c.aspectRatio = ["7:5"]; }, (c: any) => { c.aspectRatio = "1:1"; }, (c: any) => { c.sizes = 3; }]) {
        const bad = ratioOnly(); mutate(bad.profile.capabilities);
        expect(validImageAvailability(bad.value)).toBe(false);
      }
      const withSizes = imageAvailability(); (withSizes.description!.profiles[1].capabilities as any).resolution = ["2k"];
      expect(validImageAvailability(withSizes)).toBe(true);
    });
    it("offers only the controls its capabilities name", () => {
      expect(offeredOptions(ratioOnly().profile)).toMatchObject({ resolution: true, aspectRatio: true });
      const { profile } = ratioOnly(); delete profile.capabilities.aspectRatio;
      expect(offeredOptions(profile)).toMatchObject({ resolution: true, aspectRatio: false });
      expect(offeredOptions(imageAvailability().description!.profiles[0])).toMatchObject({ resolution: true, aspectRatio: true });
    });
    it("takes size auto and refuses values outside its lists", () => {
      const { profile } = ratioOnly();
      const base = { model: "m", size: "auto", quality: "auto" as const, background: "auto" as const };
      expect(capabilityProblem(profile, { ...base, resolution: "1k", aspectRatio: "16:9" }, 0)).toBeNull();
      expect(capabilityProblem(profile, { ...base, resolution: "4k" }, 0)).toContain("resolution");
      expect(capabilityProblem(profile, { ...base, aspectRatio: "3:2" }, 0)).toContain("aspect ratio");
      expect(capabilityProblem(profile, { ...base, size: "1024x1024" }, 0)).toContain("own image size");
    });
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
