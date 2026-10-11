import type { PluginBackend } from "../../integration/plugin-sdk";

/** Mirror main.rs admission, including the separate pool for job controls. */
export function withNativeRequestCapacity(backend: PluginBackend): PluginBackend {
  const controls = new Set(["jobs.status", "jobs.cancelOperation", "jobs.resumeOperation", "lifecycle.quiesce", "lifecycle.activate"]);
  let ordinary = 0, control = 0;
  return {
    async invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      const reserved = controls.has(method);
      if (reserved ? control >= 8 : ordinary >= 32) {
        throw Object.assign(new Error("Plugin request capacity reached"), { code: "capacity_reached" });
      }
      if (reserved) control += 1; else ordinary += 1;
      try { return await backend.invoke<T>(method, params); }
      finally { if (reserved) control -= 1; else ordinary -= 1; }
    },
  };
}
