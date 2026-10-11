import { describe, expect, it, vi } from "vitest";
import { describeInputSnapshot, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";
import { prepareImageInputSubmission } from "$lib/plugins/openai-image/image-input-submission";

describe("image input submission", () => {
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
  it("requires usable dimensions for a connection that keeps pixel size", async () => {
    await expect(prepareImageInputSubmission({ getInputs: () => [{ path: "/source.png", digest: "pinned" }],
      pendingInspection: null, inspect: async () => "Inspection unavailable", keepsSize: true }))
      .rejects.toThrow("Inspection unavailable. Try again, or choose an aspect ratio");
  });
  it("does not inspect a known usable input when no read is pending", async () => {
    const inspect = vi.fn(async () => null);
    await prepareImageInputSubmission({ getInputs: () => [{ path: "/source.png", digest: "pinned" }],
      pendingInspection: null, inspect, keepsSize: false });
    expect(inspect).not.toHaveBeenCalled();
  });
});
