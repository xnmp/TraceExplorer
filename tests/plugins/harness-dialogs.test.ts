import { describe, expect, it } from "vitest";
import { openHarnessDialog } from "../../e2e/harness/dialogs";

describe("host dialog harness contract", () => {
  it("retains the mounted window dialog identity and scope when reopening updates its props", () => {
    const first = openHarnessDialog([], "edit", { outputDir: "/first" }, undefined, 1);
    const other = openHarnessDialog(first, "history", {}, undefined, 2);
    const reopened = openHarnessDialog(other, "edit", { outputDir: "/second" },
      { scope: "pane", pane: { paneId: "pane-1" } }, 3);
    expect(reopened.find((dialog) => dialog.id === "edit")).toEqual({
      id: "edit", instanceId: 1, props: { outputDir: "/second" }, options: undefined,
    });
    expect(reopened.find((dialog) => dialog.id === "history")).toEqual(other[1]);
  });
  it("keeps a pane dialog's draft props and owner when it is reopened", () => {
    const options = { scope: "pane", pane: { paneId: "pane-1" } } as const;
    const first = openHarnessDialog([], "edit", { outputDir: "/first" }, options, 1);
    expect(openHarnessDialog(first, "edit", { outputDir: "/second" }, undefined, 2)).toEqual(first);
  });
  it("creates a fresh instance after closing the earlier dialog", () => {
    expect(openHarnessDialog([], "edit", {}, undefined, 2)[0].instanceId).toBe(2);
  });
});
