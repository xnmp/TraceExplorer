import { describe, expect, it, vi } from "vitest";
import { describeInputSnapshot, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";
import { prepareImageInputSubmission } from "$lib/plugins/openai-image/image-input-submission";

describe("image input submission", () => {
  for (const keepsSize of [false, true]) {
    for (const pending of [false, true]) {
      it(`blocks a failed inspection even with known size and digest: keepsSize=${keepsSize}, pending=${pending}`, async () => {
        const startJob = vi.fn();
        const inspect = async () => "Could not read the input images: Permission denied";
        const submission = prepareImageInputSubmission({
          getInputs: () => [{ path: "/source.png", size: { width: 80, height: 60 }, ...(pending ? { digest: "pinned" } : {}) }],
          pendingInspection: pending ? inspect() : null, inspect, keepsSize,
        }).then(startJob);
        await expect(submission).rejects.toThrow("Could not read the input images: Permission denied");
        expect(startJob).not.toHaveBeenCalled();
      });
    }
    for (const missing of ["source", "reference"]) {
      it(`blocks a successful but incomplete inspection: keepsSize=${keepsSize}, missing=${missing}`, async () => {
        const startJob = vi.fn();
        const submission = prepareImageInputSubmission({
          getInputs: () => [
            { path: "/source.png", size: { width: 80, height: 60 }, ...(missing === "source" ? {} : { digest: "source" }) },
            { path: "/reference.png", ...(missing === "reference" ? {} : { digest: "reference" }) },
          ], pendingInspection: null, inspect: async () => null, keepsSize,
        }).then(startJob);
        await expect(submission).rejects.toThrow(`Cannot read ${missing}.png: inspection unavailable`);
        expect(startJob).not.toHaveBeenCalled();
      });
    }
    it(`shows an input's inspection error even with a pinned digest: keepsSize=${keepsSize}`, async () => {
      await expect(prepareImageInputSubmission({ getInputs: () => [{ path: "/reference.png", digest: "pinned", error: "Path not found" }],
        pendingInspection: null, inspect: async () => null, keepsSize })).rejects.toThrow("Remove reference.png: Path not found");
    });
  }
  it("waits for a pending inspection and rejects its result even after live size and digest are known", async () => {
    const captured = [{ path: "/missing.png", id: Symbol(), digest: "pinned" }];
    let inputs: readonly ImageInput[] = withLiveInputs(captured, [{ path: "/missing.png", size: { width: 80, height: 60 } }]);
    let resolve!: (value: string | null) => void;
    const pendingInspection = new Promise<string | null>((done) => { resolve = done; }).then((problem) => {
      inputs = describeInputSnapshot(inputs, captured, [{ path: "/missing.png", error: "Path not found" }]);
      return problem;
    });
    const startJob = vi.fn();
    const inspect = vi.fn(() => pendingInspection);
    const submission = prepareImageInputSubmission({ getInputs: () => inputs, pendingInspection, inspect, keepsSize: true })
      .then(() => { startJob(); return null; }, (cause: unknown) => cause);
    await Promise.resolve();
    await Promise.resolve();
    const startsBeforeInspection = startJob.mock.calls.length;
    resolve(null);
    const error = await submission;
    expect(startsBeforeInspection).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Remove missing.png: Path not found");
    expect(startJob).not.toHaveBeenCalled();
  });
  it("starts after a pending successful inspection without issuing another read", async () => {
    const inputs = [{ path: "/source.png", digest: "pinned", size: { width: 80, height: 60 } }];
    let resolve!: (value: string | null) => void;
    const pendingInspection = new Promise<string | null>((done) => { resolve = done; });
    const inspect = vi.fn(async () => null);
    const startJob = vi.fn();
    const submission = prepareImageInputSubmission({ getInputs: () => inputs, pendingInspection, inspect, keepsSize: false }).then(startJob);
    await Promise.resolve();
    await Promise.resolve();
    const startsBeforeInspection = startJob.mock.calls.length;
    resolve(null);
    await submission;
    expect(startsBeforeInspection).toBe(0);
    expect(startJob).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("blocks a failed dimension inspection for a connection that keeps pixel size", async () => {
    await expect(prepareImageInputSubmission({ getInputs: () => [{ path: "/source.png", digest: "pinned" }],
      pendingInspection: null, inspect: async () => "Inspection unavailable", keepsSize: true }))
      .rejects.toThrow("Inspection unavailable");
  });
  it("requires dimensions after successful inspection when keeping pixel size", async () => {
    await expect(prepareImageInputSubmission({ getInputs: () => [{ path: "/source.png", digest: "pinned" }],
      pendingInspection: null, inspect: async () => null, keepsSize: true }))
      .rejects.toThrow("Wait for Image 1 to load, or choose an aspect ratio");
  });
  it("permits generation with no inputs without inspection", async () => {
    const inspect = vi.fn(async () => "Inspection unavailable");
    await prepareImageInputSubmission({ getInputs: () => [], pendingInspection: null, inspect, keepsSize: false });
    expect(inspect).not.toHaveBeenCalled();
  });
  it("does not inspect a known usable input when no read is pending", async () => {
    const inspect = vi.fn(async () => null);
    await prepareImageInputSubmission({ getInputs: () => [{ path: "/source.png", digest: "pinned" }],
      pendingInspection: null, inspect, keepsSize: false });
    expect(inspect).not.toHaveBeenCalled();
  });
});
