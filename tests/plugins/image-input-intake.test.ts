import { describe, expect, it, vi } from "vitest";
import { createImageInputIntake, imageInputIntakeStatus, type ImageInputIntakeIssue } from "$lib/plugins/openai-image/image-input-intake";
import { moveInput, removeInput, type ImageInput } from "$lib/domain/image-inputs";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const described = (paths: readonly string[]): ImageInput[] => paths.map((path) => ({ path, digest: `digest:${path}` }));
function fixture(initial: readonly ImageInput[] = []) {
  let inputs = initial, blocked: string | null = null;
  const reads: Array<{ paths: readonly string[]; result: ReturnType<typeof deferred<readonly ImageInput[]>> }> = [];
  const feedback: Array<{ added: readonly string[]; issues: readonly ImageInputIntakeIssue[] }> = [];
  const pending: boolean[] = [];
  const commit = vi.fn((result) => { inputs = result.inputs; });
  const intake = createImageInputIntake({
    getInputs: () => inputs,
    inspect: (paths) => { const result = deferred<readonly ImageInput[]>(); reads.push({ paths, result }); return result.promise; },
    commit, blockedReason: () => blocked,
    onPendingChange: (value) => pending.push(value),
    onFeedback: (added, issues) => feedback.push({ added, issues }),
  });
  return { intake, reads, feedback, pending, commit, inputs: () => inputs,
    arrange: (next: readonly ImageInput[]) => { inputs = next; }, block: (message: string | null) => { blocked = message; } };
}

describe("per-form image input intake", () => {
  it("combines queued completions into one feedback update without losing any drop result", async () => {
    const f = fixture();
    const completions = [f.intake.enqueue(["/a.png"]), f.intake.enqueue(["/one.gif"]), f.intake.enqueue(["/two.gif"])];
    expect(f.feedback).toEqual([]);
    f.reads[0].result.resolve(described(["/a.png"]));
    await Promise.all(completions);
    expect(f.feedback).toHaveLength(1);
    expect(f.feedback[0].added).toEqual(["/a.png"]);
    expect(f.feedback[0].issues.map((issue) => issue.path)).toEqual(["/one.gif", "/two.gif"]);
    expect(imageInputIntakeStatus(f.feedback[0].added.length, f.inputs().length, f.feedback[0].issues.length))
      .toBe("1 input added · 1 of 8. 2 files skipped");
  });
  it("announces the resulting input count after consecutive equal-size successful drops", async () => {
    const f = fixture();
    const messages: string[] = [];
    for (const path of ["/a.png", "/b.png"]) {
      const completion = f.intake.enqueue([path]);
      f.reads.at(-1)!.result.resolve(described([path]));
      await completion;
      const feedback = f.feedback.at(-1)!;
      messages.push(imageInputIntakeStatus(feedback.added.length, f.inputs().length, feedback.issues.length));
    }
    expect(messages).toEqual(["1 input added · 1 of 8", "1 input added · 2 of 8"]);
    expect(imageInputIntakeStatus(2, 4, 1)).toBe("2 inputs added · 4 of 8. 1 file skipped");
    expect(imageInputIntakeStatus(0, 4, 2)).toBe("2 files skipped");
    expect(imageInputIntakeStatus(0, 0, 0)).toBe("");
  });
  it("gates submission synchronously and processes separate batches FIFO", async () => {
    const f = fixture();
    const first = f.intake.enqueue(["/b.jpg", "/a.png"]);
    expect(f.intake.pending).toBe(true);
    const second = f.intake.enqueue(["/c.webp"]);
    expect(f.reads.map((read) => read.paths)).toEqual([["/b.jpg", "/a.png"]]);
    expect(f.commit).not.toHaveBeenCalled();
    f.reads[0].result.resolve(described(["/a.png", "/b.jpg"])); // RPC order need not match delivered order.
    await first;
    expect(f.intake.pending).toBe(true);
    expect(f.inputs().map((input) => input.path)).toEqual(["/b.jpg", "/a.png"]);
    expect(f.reads[1].paths).toEqual(["/c.webp"]);
    f.reads[1].result.resolve(described(["/c.webp"]));
    await second;
    expect(f.inputs().map((input) => input.path)).toEqual(["/b.jpg", "/a.png", "/c.webp"]);
    expect(f.pending).toEqual([true, false]);
    expect(f.intake.pending).toBe(false);
  });
  it("preflights invalid paths/formats/duplicates without inspecting or leaving submission gated", async () => {
    const f = fixture([{ path: "/a.png", digest: "pinned" }]);
    await f.intake.enqueue([null, "/a.png", "/no.gif", "relative.jpg"]);
    expect(f.reads).toEqual([]);
    expect(f.intake.pending).toBe(false);
    expect(f.feedback[0].issues.map((issue) => issue.code)).toEqual(["invalid-path", "duplicate", "unsupported-format", "invalid-path"]);
  });
  it("inspects at most eight at a time and continues past unreadable candidates", async () => {
    const f = fixture();
    const paths = Array.from({ length: 18 }, (_, i) => `/${i}.png`);
    const completion = f.intake.enqueue(paths);
    expect(f.reads[0].paths).toEqual(paths.slice(0, 8));
    f.reads[0].result.resolve(paths.slice(0, 8).map((path) => ({ path, error: "Corrupt image" })));
    await Promise.resolve();
    expect(f.inputs()).toEqual([]);
    expect(f.reads[1].paths).toEqual(paths.slice(8, 16));
    f.reads[1].result.resolve(described(paths.slice(8, 16)));
    await completion;
    expect(f.reads).toHaveLength(2); // Full: the last chunk is explained without IO.
    expect(f.inputs().map((input) => input.path)).toEqual(paths.slice(8, 16));
    expect(f.feedback[0].issues.filter((issue) => issue.code === "unreadable")).toHaveLength(8);
    expect(f.feedback[0].issues.filter((issue) => issue.code === "limit")).toHaveLength(2);
  });
  it("merges after the await against concurrent removal/reordering and preserves metadata", async () => {
    const original = described(["/a.png", "/b.png", "/c.png"]);
    const f = fixture(original);
    const completion = f.intake.enqueue(["/d.png"]);
    f.arrange(removeInput(moveInput(original, 2, 0), 1));
    f.reads[0].result.resolve(described(["/d.png"]));
    await completion;
    expect(f.inputs()).toEqual([original[2], original[1], ...described(["/d.png"])]);
  });
  it("rechecks duplicates and capacity introduced while inspection was pending", async () => {
    const f = fixture(described(Array.from({ length: 6 }, (_, i) => `/old-${i}.png`)));
    const completion = f.intake.enqueue(["/same.png", "/fits.png", "/overflow.png"]);
    f.arrange([...f.inputs(), { path: "/same.png", digest: "other-pinned" }]);
    f.reads[0].result.resolve(described(["/same.png", "/fits.png", "/overflow.png"]));
    await completion;
    expect(f.inputs().at(-2)).toEqual({ path: "/same.png", digest: "other-pinned" });
    expect(f.inputs().at(-1)?.path).toBe("/fits.png");
    expect(f.feedback[0].issues.map((issue) => issue.code)).toEqual(["duplicate", "limit"]);
  });
  it("rechecks queued duplicates and never inspects the same queued input twice", async () => {
    const f = fixture();
    const first = f.intake.enqueue(["/a.png"]), second = f.intake.enqueue(["/a.png"]);
    f.reads[0].result.resolve(described(["/a.png"]));
    await Promise.all([first, second]);
    expect(f.reads).toHaveLength(1);
    expect(f.inputs()).toHaveLength(1);
    expect(f.feedback[0].issues[0].message).toBe("Already an input");
  });
  it("keeps rejection-only batch feedback FIFO while an earlier inspection is pending", async () => {
    const f = fixture();
    const first = f.intake.enqueue(["/a.png"]), second = f.intake.enqueue(["/no.gif", null]);
    expect(f.feedback).toEqual([]);
    f.reads[0].result.resolve(described(["/a.png"]));
    await Promise.all([first, second]);
    expect(f.feedback[0].added).toEqual(["/a.png"]);
    expect(f.feedback).toHaveLength(1);
    expect(f.feedback[0].issues.map((issue) => issue.code)).toEqual(["unsupported-format", "invalid-path"]);
    expect(f.pending).toEqual([true, false]);
  });
  it("keeps independent forms' queues and disposal isolated", async () => {
    const a = fixture(), b = fixture();
    const first = a.intake.enqueue(["/a.png"]), second = b.intake.enqueue(["/b.png"]);
    a.intake.dispose();
    b.reads[0].result.resolve(described(["/b.png"]));
    await Promise.all([first, second]);
    expect(b.inputs()).toEqual(described(["/b.png"]));
    expect(a.inputs()).toEqual([]);
    a.reads[0].result.resolve(described(["/a.png"]));
    await Promise.resolve();
    expect(a.commit).not.toHaveBeenCalled();
  });
  it("explains very large blocked batches without a spread-argument overflow", async () => {
    const f = fixture();
    const paths = Array.from({ length: 150_000 }, (_, i) => `/large-${i}.png`);
    const completion = f.intake.enqueue(paths);
    f.block("The form is closed");
    f.reads[0].result.resolve(described(f.reads[0].paths));
    await completion;
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.feedback[0].issues).toHaveLength(paths.length);
    expect(f.feedback[0].issues.at(-1)?.path).toBe(paths.at(-1));
    expect(f.intake.pending).toBe(false);
  });
  it("rejects failed/missing inspections before committing and recovers for the next drop", async () => {
    const f = fixture();
    const failed = f.intake.enqueue(["/bad.png", "/missing.png"]);
    f.reads[0].result.reject(new Error("Permission denied"));
    await failed;
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.feedback[0].issues.map((issue) => issue.message)).toEqual(["Cannot read image: Permission denied", "Cannot read image: Permission denied"]);
    const next = f.intake.enqueue(["/empty.png", "/good.png"]);
    f.reads[1].result.resolve(described(["/good.png"]));
    await next;
    expect(f.inputs()).toEqual(described(["/good.png"]));
    expect(f.feedback[1].issues[0].code).toBe("unreadable");
  });
  it("rejects drops during submission/settings without calling inspect or commit", async () => {
    for (const message of ["Wait for submission to finish", "Close connection settings before adding inputs"]) {
      const f = fixture(); f.block(message);
      await f.intake.enqueue(["/a.png", "/b.png"]);
      expect(f.reads).toEqual([]);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.feedback[0].issues.map((issue) => issue.message)).toEqual([message, message]);
      expect(f.intake.pending).toBe(false);
    }
  });
  it("rejects delivery if the form becomes blocked during inspection", async () => {
    const f = fixture();
    const completion = f.intake.enqueue(["/a.png"]);
    f.block("The form is closed");
    f.reads[0].result.resolve(described(["/a.png"]));
    await completion;
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.feedback[0].issues[0]).toMatchObject({ code: "busy", message: "The form is closed" });
  });
  it("disposes queued work immediately and ignores late fulfillment or rejection", async () => {
    for (const rejects of [false, true]) {
      const f = fixture();
      const first = f.intake.enqueue(["/a.png"]), second = f.intake.enqueue(["/b.png"]);
      f.intake.dispose(); f.intake.dispose();
      await Promise.all([first, second]);
      expect(f.intake.pending).toBe(false);
      if (rejects) f.reads[0].result.reject(new Error("Late error"));
      else f.reads[0].result.resolve(described(["/a.png"]));
      await Promise.resolve();
      await f.intake.enqueue(["/c.png"]);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.feedback).toEqual([]);
      expect(f.reads).toHaveLength(1);
      expect(f.pending).toEqual([true, false]);
    }
  });
});
