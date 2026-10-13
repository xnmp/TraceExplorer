import { describe, expect, it } from "vitest";
import { compatibleFolderEligibility, folderEligibility } from "$lib/domain/folder-eligibility";

describe("folder eligibility contract", () => {
  it.each([
    ["/ordinary", undefined, false, "pending"],
    ["/candidate", undefined, true, true],
    ["/known", true, false, true],
    ["/known", false, true, false],
    ["/failed", false, false, false],
    ["", undefined, true, false],
    ["demo://folder", true, true, false],
    ["KEEP://folder", undefined, false, false],
    ["C:\\pictures", undefined, false, "pending"],
  ] as const)("resolves %s with known=%s and candidate=%s to %s", (directory, known, candidate, expected) => {
    expect(folderEligibility(directory, known, candidate)).toBe(expected);
  });

  it.each([true, false])("preserves resolved answers with pending support=%s", (supportsPending) => {
    expect(compatibleFolderEligibility(true, supportsPending)).toBe(true);
    expect(compatibleFolderEligibility(false, supportsPending)).toBe(false);
  });

  it("returns pending only to hosts that support it", () => {
    expect(compatibleFolderEligibility("pending", true)).toBe("pending");
    expect(compatibleFolderEligibility("pending", false)).toBe(false);
  });
});
