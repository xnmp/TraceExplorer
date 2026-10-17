/** Opt-in synchronous work accounting. No clock reads or retained layouts when disabled. */
export interface StageWork { calls: number; ms: number; selfMs: number }
export interface LayoutProfile { stages: Record<string, StageWork>; counters: Record<string, number> }
let active: LayoutProfile | undefined;
let parent: { childMs: number } | undefined;
export function countLayoutWork(name: string, amount = 1): void {
  if (active) active.counters[name] = (active.counters[name] ?? 0) + amount;
}
export function layoutStage(name: string): () => void {
  if (!active) return noop;
  const profile = active, outer = parent, frame = { childMs: 0 }, start = performance.now();
  parent = frame;
  return () => {
    const ms = performance.now() - start;
    const stage = profile.stages[name] ??= { calls: 0, ms: 0, selfMs: 0 };
    stage.calls++; stage.ms += ms; stage.selfMs += ms - frame.childMs;
    if (outer) outer.childMs += ms;
    parent = outer;
  };
}
const noop = () => {};
export function profileLayout<T>(run: () => T): { result: T; profile: LayoutProfile } {
  const saved = active, savedParent = parent;
  const profile: LayoutProfile = { stages: {}, counters: {} };
  active = profile; parent = undefined;
  try { return { result: run(), profile }; }
  finally { active = saved; parent = savedParent; }
}
