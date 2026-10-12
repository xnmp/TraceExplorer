import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalFixtureImagePath, fixtureImageEntries } from "../../e2e/harness/image-input-files";

describe("image inspection mock filesystem", () => {
  it("rejects missing and regular-file components before parent traversal, including symlink targets", () => {
    const entries = new Map<string, "file" | "directory">([
      ["/pictures", "directory"], ["/pictures/warm.png", "file"],
    ]);
    const links = new Map([["/pictures/missing-link", "/pictures/nonexistent"], ["/pictures/file-link", "/pictures/warm.png"]]);
    for (const component of ["nonexistent", "missing-link"]) {
      expect(() => canonicalFixtureImagePath(`/pictures/${component}/../warm.png`, links, entries))
        .toThrow("Path not found: No such file or directory (os error 2)");
    }
    for (const component of ["warm.png", "file-link"]) {
      expect(() => canonicalFixtureImagePath(`/pictures/${component}/../warm.png`, links, entries))
        .toThrow("IO error: Not a directory (os error 20)");
    }
  });
  it("resolves parent traversal after links instead of collapsing it lexically", () => {
    const links = new Map([["/photos/link", "/other/subdir"], ["/photos/relative-link", "../other/subdir"]]);
    const entries = fixtureImageEntries([["/photos/source.png", "file"], ["/other/source.png", "file"], ["/other/subdir", "directory"]]);
    expect(canonicalFixtureImagePath("/photos/source.png", links, entries)).toBe("/photos/source.png");
    expect(canonicalFixtureImagePath("/photos/link/../source.png", links, entries)).toBe("/other/source.png");
    expect(canonicalFixtureImagePath("/photos/relative-link/../source.png", links, entries)).toBe("/other/source.png");
    expect(canonicalFixtureImagePath("/other//./subdir/../source.png", links, entries)).toBe("/other/source.png");
  });
  // The mock models Linux canonicalization (the harness backend's semantics). macOS realpath resolves
  // "file/.." without ENOTDIR and Windows has no POSIX symlinks, so the native oracle is Linux-only.
  it.skipIf(process.platform !== "linux")("matches real Linux filesystem symlink/parent traversal for distinct files and aliases", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tdrop-inputs-")));
    try {
      mkdirSync(`${root}/photos`);
      mkdirSync(`${root}/other/subdir`, { recursive: true });
      writeFileSync(`${root}/photos/source.png`, "photos");
      writeFileSync(`${root}/other/source.png`, "other");
      symlinkSync(`${root}/other/subdir`, `${root}/photos/link`);
      symlinkSync("../other/subdir", `${root}/photos/relative-link`);
      symlinkSync(`${root}/photos/source.png`, `${root}/photos/file-link`);
      symlinkSync(`${root}/photos/nonexistent`, `${root}/photos/missing-link`);
      const links = new Map([[`${root}/photos/link`, `${root}/other/subdir`], [`${root}/photos/relative-link`, "../other/subdir"],
        [`${root}/photos/file-link`, `${root}/photos/source.png`], [`${root}/photos/missing-link`, `${root}/photos/nonexistent`]]);
      const entries = fixtureImageEntries([[`${root}/photos/source.png`, "file"], [`${root}/other/source.png`, "file"], [`${root}/other/subdir`, "directory"]]);
      for (const path of [`${root}/photos/source.png`, `${root}/photos/link/../source.png`,
        `${root}/photos/relative-link/../source.png`, `${root}//other/./subdir/../source.png`]) {
        expect(canonicalFixtureImagePath(path, links, entries)).toBe(realpathSync.native(path));
      }
      for (const component of ["nonexistent", "source.png", "file-link", "missing-link"]) {
        const path = `${root}/photos/${component}/../source.png`;
        let nativeError: NodeJS.ErrnoException | undefined;
        try { realpathSync.native(path); } catch (cause) { nativeError = cause as NodeJS.ErrnoException; }
        expect(nativeError?.code).toBe(component === "nonexistent" || component === "missing-link" ? "ENOENT" : "ENOTDIR");
        const message = nativeError!.code === "ENOENT"
          ? "Path not found: No such file or directory (os error 2)" : "IO error: Not a directory (os error 20)";
        expect(() => canonicalFixtureImagePath(path, links, entries)).toThrow(message);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails inspection for symlink cycles instead of hanging", () => {
    expect(() => canonicalFixtureImagePath("/photos/link/source.png", new Map([["/photos/link", "/photos/link"]]),
      fixtureImageEntries([["/photos", "directory"]]))).toThrow("IO error: Too many levels of symbolic links (os error 40)");
  });
});
