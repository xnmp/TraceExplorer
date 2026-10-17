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

  it("budgets certification even when all raw bands are remembered", () => {
    const runtime = createFolderLayoutRuntime();
    const input = folderInput(folder, { open: ["s0:root", "s1:root"] });
    runtime.remember(engines.default(input));
    expect(runtime.inline(input)).toBe(false);
    // The engine answers from those bands with the same geometry as a fresh run.
    expect(runtime.engine(input).graphs.get("s1:root")!.attached).toEqual(engines.default(input).graphs.get("s1:root")!.attached);
  });

  it("budgets a kept committed band when another band's focus changes", () => {
    const runtime = createFolderLayoutRuntime();
    const previous = engines.default(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Saffron" }));
    expect(runtime.inline(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Ash", previous }))).toBe(false);
  });
});

it('budgets the sum of independent small band computations', () => {
  const many = makeFolder({stacks:Array.from({length:12},()=>handCase('screenshot'))});
  const runtime=createFolderLayoutRuntime();
  expect(runtime.inline(folderInput(many,{open:many.stacks.keys()}))).toBe(false);
});
