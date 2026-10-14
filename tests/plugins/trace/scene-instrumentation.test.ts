import { describe, it, expect, afterEach } from "vitest";
import { sceneInstrumentation, installSceneInstrumentation, type SceneEvent } from "$lib/plugins/trace/view/scene-instrumentation";

const event: SceneEvent = { transaction: 1, scope: "/a", geometryVersion: 2, requestKeys: ["k"] };
let restore = () => {};
afterEach(() => restore());

describe("scene instrumentation", () => {
  it("does nothing by default", () => {
    expect(() => { sceneInstrumentation.actionBegin(event); sceneInstrumentation.failure({ ...event, message: "x" }); sceneInstrumentation.settled(event); }).not.toThrow();
  });
  it("routes events to installed hooks, silences members left out, and restores", () => {
    const seen: string[] = [];
    restore = installSceneInstrumentation({ motionStart: (e) => seen.push(`motion:${e.transaction}`) });
    sceneInstrumentation.motionStart(event);
    sceneInstrumentation.geometryPublication(event);
    expect(seen).toEqual(["motion:1"]);
    restore();
    sceneInstrumentation.motionStart(event);
    expect(seen).toEqual(["motion:1"]);
  });
});
