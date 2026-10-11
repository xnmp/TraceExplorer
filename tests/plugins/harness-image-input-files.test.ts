import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalFixtureImagePath } from "../../e2e/harness/image-input-files";

describe("image inspection mock filesystem", () => {
  it("resolves parent traversal after links instead of collapsing it lexically", () => {
    const links = new Map([["/photos/link", "/other/subdir"], ["/photos/relative-link", "../other/subdir"]]);
    expect(canonicalFixtureImagePath("/photos/source.png", links)).toBe("/photos/source.png");
    expect(canonicalFixtureImagePath("/photos/link/../source.png", links)).toBe("/other/source.png");
    expect(canonicalFixtureImagePath("/photos/relative-link/../source.png", links)).toBe("/other/source.png");
    expect(canonicalFixtureImagePath("/other//./subdir/../source.png", links)).toBe("/other/source.png");
  });
  it.skipIf(process.platform === "win32")("matches real POSIX filesystem symlink/parent traversal for distinct files and aliases", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tdrop-inputs-")));
    try {
      mkdirSync(`${root}/photos`);
      mkdirSync(`${root}/other/subdir`, { recursive: true });
      writeFileSync(`${root}/photos/source.png`, "photos");
      writeFileSync(`${root}/other/source.png`, "other");
      symlinkSync(`${root}/other/subdir`, `${root}/photos/link`);
      symlinkSync("../other/subdir", `${root}/photos/relative-link`);
      const links = new Map([[`${root}/photos/link`, `${root}/other/subdir`], [`${root}/photos/relative-link`, "../other/subdir"]]);
      for (const path of [`${root}/photos/source.png`, `${root}/photos/link/../source.png`,
        `${root}/photos/relative-link/../source.png`, `${root}//other/./subdir/../source.png`]) {
        expect(canonicalFixtureImagePath(path, links)).toBe(realpathSync.native(path));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails inspection for symlink cycles instead of hanging", () => {
    expect(canonicalFixtureImagePath("/photos/link/source.png", new Map([["/photos/link", "/photos/link"]]))).toBeNull();
  });
});
