import { expect, it } from "vitest";
import { revealArtifactId } from "../../../src/lib/plugins/trace/view/reveal-target";
it("resolves stable artifact targets and rejects malformed identities", () => {
  expect(revealArtifactId("artifact:7")).toBe(7);
  for (const value of ["", "artifact:0", "artifact:-1", "artifact:1.1", "artifact:01", "artifact:9007199254740992", "a:7"]) {
    expect(() => revealArtifactId(value)).toThrow("Invalid Trace reveal target");
  }
});
