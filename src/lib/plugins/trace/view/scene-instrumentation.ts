/**
 * Scene instrumentation hooks. Production code reports scene lifecycle events
 * through `sceneInstrumentation`, whose methods do nothing; the browser harness
 * installs recorders (`installSceneInstrumentation`) to assert on them. Hooks
 * carry plain data only and must never influence behaviour.
 */
export interface SceneEvent {
  /** The scene transaction (action) the event belongs to. */
  transaction: number;
  /** The folder (or other scope) the transaction acts in, so events of a closed scope are recognisable. */
  scope: string;
  /** Version of the published geometry the event refers to. */
  geometryVersion: number;
  /** Keys of the graph requests (components and pages) the transaction needed. */
  requestKeys: readonly string[];
}

export interface SceneInstrumentation {
  actionBegin(event: SceneEvent): void;
  geometryPublication(event: SceneEvent): void;
  /** One call per started motion, however many elements it animates. */
  motionStart(event: SceneEvent): void;
  failure(event: SceneEvent & { message: string }): void;
  settled(event: SceneEvent): void;
}

const noop = (): void => {};
const silent = (): SceneInstrumentation => ({ actionBegin: noop, geometryPublication: noop, motionStart: noop, failure: noop, settled: noop });

/** The hooks production code calls. Stable object; replaced member-wise so importers keep one reference. */
export const sceneInstrumentation: SceneInstrumentation = silent();

/** Harness only: route events to `hooks` (members left out stay silent). Returns the restore function. */
export function installSceneInstrumentation(hooks: Partial<SceneInstrumentation>): () => void {
  Object.assign(sceneInstrumentation, silent(), hooks);
  return () => { Object.assign(sceneInstrumentation, silent()); };
}
