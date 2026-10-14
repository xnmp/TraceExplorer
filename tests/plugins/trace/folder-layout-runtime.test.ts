import { describe, expect, it } from "vitest";
import { createFolderLayoutRuntime } from "$lib/plugins/trace/view/folder-layout-runtime";
import { engines } from "$lib/domain/trace-graph/folder-layout";
import { folderInput, handCase, makeFolder } from "../../domain/trace-graph/folder-layout-fixtures";

const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("fan-80")], files: 2 });

describe("folder layout runtime", () => {
  it("runs small work inline and sends a band above the workload budget elsewhere", () => {
    const runtime = createFolderLayoutRuntime();
    expect(runtime.inline(folderInput(folder, { open: ["s0:root"] }))).toBe(true);
    expect(runtime.inline(folderInput(folder, { open: ["s0:root", "s1:root"] }))).toBe(false);
  });

  it("counts only bands it would compute: remembered bands make the same run inline", () => {
    const runtime = createFolderLayoutRuntime();
    const input = folderInput(folder, { open: ["s0:root", "s1:root"] });
    runtime.remember(engines.default(input));
    expect(runtime.inline(input)).toBe(true);
    // The engine answers from those bands with the same geometry as a fresh run.
    expect(runtime.engine(input).graphs.get("s1:root")!.attached).toEqual(engines.default(input).graphs.get("s1:root")!.attached);
  });

  it("treats a kept committed band as free when another band's focus changes", () => {
    const runtime = createFolderLayoutRuntime();
    const previous = engines.default(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Saffron" }));
    expect(runtime.inline(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Ash", previous }))).toBe(true);
  });
});
