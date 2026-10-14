/** Records the scene instrumentation events of the view under test. */
import { installSceneInstrumentation, sceneInstrumentation, type SceneEvent, type SceneInstrumentation } from "$lib/plugins/trace/view/scene-instrumentation";

export type SceneEventKind = "action-begin" | "geometry-publication" | "motion-start" | "failure" | "settled";
export interface RecordedSceneEvent extends SceneEvent { kind: SceneEventKind; message?: string; time: number }

const recorded: RecordedSceneEvent[] = [];
const record = (kind: SceneEventKind) => (event: SceneEvent & { message?: string }) => {
  recorded.push({ kind, time: performance.now(), transaction: event.transaction, scope: event.scope, geometryVersion: event.geometryVersion, requestKeys: [...event.requestKeys], ...(event.message !== undefined ? { message: event.message } : {}) });
};

installSceneInstrumentation({
  actionBegin: record("action-begin"), geometryPublication: record("geometry-publication"), motionStart: record("motion-start"),
  failure: record("failure"), settled: record("settled"),
} satisfies SceneInstrumentation);

export const sceneSink = {
  /** The production hooks, so tests can drive the sink exactly as the controller will. */
  hooks: sceneInstrumentation,
  events: (): RecordedSceneEvent[] => recorded.map((event) => ({ ...event, requestKeys: [...event.requestKeys] })),
  clear() { recorded.length = 0; },
};
