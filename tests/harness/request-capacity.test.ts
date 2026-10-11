import { describe, expect, it } from "vitest";
import { withNativeRequestCapacity } from "../../e2e/harness/request-capacity";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("native mock request admission", () => {
  it("rejects the 33rd ordinary request while reserving eight job control slots", async () => {
    const held = gate();
    const backend = withNativeRequestCapacity({ invoke: <T>() => held.promise as Promise<T> });
    const ordinary = Array.from({ length: 32 }, () => backend.invoke("trace_component_nodes"));
    await expect(backend.invoke("trace_folder_components")).rejects.toMatchObject({ code: "capacity_reached" });
    const controls = Array.from({ length: 8 }, () => backend.invoke("jobs.status"));
    await expect(backend.invoke("jobs.cancelOperation")).rejects.toMatchObject({ code: "capacity_reached" });
    held.release();
    await Promise.all([...ordinary, ...controls]);
    await expect(backend.invoke("trace_component_nodes")).resolves.toBeUndefined();
  });

  it("releases admission after backend rejection", async () => {
    let fail = true;
    const backend = withNativeRequestCapacity({ invoke: async <T>() => {
      if (fail) throw new Error("read failed");
      return "recovered" as T;
    } });
    await Promise.all(Array.from({ length: 32 }, () => expect(backend.invoke("trace_component_nodes")).rejects.toThrow("read failed")));
    fail = false;
    await expect(backend.invoke("trace_component_nodes")).resolves.toBe("recovered");
  });
});
