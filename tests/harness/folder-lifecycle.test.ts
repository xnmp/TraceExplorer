import { describe, expect, it } from "vitest";
import { folderComponents, isDirectFolderSeed, type FolderNode } from "../../e2e/harness/folder-snapshot";
import { locateTarget } from "$lib/plugins/trace/view/target-location";

const source: FolderNode = {
  key: "a:1", artifactId: 1, runId: null, parents: [], path: "/pictures/lonely.png",
  scope: "current", location: "./lonely.png", state: "present", temporary: false,
  discarded: false, earlierRevision: false, order: 1, prompt: "",
};
const job: FolderNode = {
  ...source, key: "o:10:0", artifactId: null, runId: 10, parents: [source.key], path: null,
  state: "running", temporary: true, contextDirectory: "/pictures", order: 1_000_000_000_010,
};
const completed: FolderNode = {
  ...job, artifactId: 20, path: "/managed/generated.png", state: "present", order: 20,
};

describe("native section lifecycle and summary contracts", () => {
  it("promotes a newly running or completed edit above older stacks", () => {
    const older = { ...completed, key: "o:9:0", runId: 9, artifactId: 19, parents: [], order: 19 };
    for (const output of [job, completed]) {
      expect(folderComponents([older, source, output]).map((group) => group.id)).toEqual(["c:a:1", "c:o:9:0"]);
    }
  });

  it("dismissing the only interrupted edit returns a lone image to ordinary files", () => {
    const interrupted = { ...job, state: "uncertain" as const, dismissable: true };
    expect(folderComponents([source, interrupted])[0].members).toEqual([source.key, job.key]);
    expect(folderComponents([source, interrupted], new Set([10]))).toEqual([]);
    expect(isDirectFolderSeed(source)).toBe(true);
  });

  it("recovery displays a running placeholder even when the run was dismissed", () => {
    const dismissed = new Set([10]);
    expect(folderComponents([source, { ...job, state: "uncertain" }], dismissed)).toEqual([]);
    expect(folderComponents([source, job], dismissed)[0].members).toEqual([source.key, job.key]);
  });

  it("an unrelated edit reorders summaries without changing the selected stack's nodes", () => {
    const other = { ...source, key: "a:2", artifactId: 2, path: "/pictures/other.png", order: 2 };
    const otherOutput = { ...completed, key: "o:11:0", artifactId: 3, runId: 11, parents: [other.key], order: 3 };
    const before = folderComponents([source, completed, other, otherOutput]);
    const after = folderComponents([source, completed, other, otherOutput, { ...job, key: "o:12:0", runId: 12, parents: [other.key] }]);
    expect(before[0].id).toBe("c:a:1");
    expect(after[0].id).toBe("c:a:2");
    expect(after.find((group) => group.id === "c:a:1")?.nodes).toEqual(before[0].nodes);
  });

  it("an image without a visible edit stays ordinary until an edit draws its section", () => {
    expect(folderComponents([source])).toEqual([]);
    expect(folderComponents([source, job])[0].summary).toMatchObject({ imageCount: 1, nodeCount: 2, active: true });
    // Failed runs have no output or placeholder in the native snapshot.
    expect(folderComponents([source])).toEqual([]);
  });

  it("a failed lone-image generation has no surviving Preview target", () => {
    const groups = folderComponents([source]);
    expect(locateTarget(job.key, "c:a:1", {
      listed: new Set(groups.map((group) => group.id)), components: new Map(), isStale: () => false,
    })).toBe("gone");
  });

  it("a no-input generated root uses its output identity and filename title before and after Save", () => {
    const root = { ...completed, parents: [] };
    for (const output of [root, { ...root, temporary: false, path: "/pictures/generated.png" }]) {
      const [group] = folderComponents([output]);
      expect(group.summary).toMatchObject({ id: "c:o:10:0", title: "generated", imageCount: 1, nodeCount: 1 });
      expect(group.nodes[0].parents).toEqual([]);
    }
  });

  it("saving a generated root elsewhere keeps it as badges on its current-folder edits", () => {
    const root = { ...completed, temporary: false, scope: "external" as const, parents: [], path: "/elsewhere/lantern.png" };
    const child = { ...completed, key: "o:11:0", runId: 11, artifactId: 21, parents: [root.key], path: "/managed/lantern_edit.png", order: 21 };
    const [group] = folderComponents([root, child]);
    expect(group.summary).toMatchObject({ id: "c:o:11:0", title: "lantern_edit", imageCount: 1 });
    expect(group.nodes[0].referenceBadge).toMatchObject({ key: root.key, scope: "external", consumers: [child.key] });
  });
});
